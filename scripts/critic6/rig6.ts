// Ported from the sixth external review (read-only original), kept as a permanent test.
// Critic-6 rig: streaming mixer (3 buses: guitar, voice, phone speaker) -> early reflections + FDN room -> phone input chain
// -> the app's real StreamAnalyzer + Session, with main.ts/audio.ts timing (mute while the reference plays + 0.3 s tail).
import { BQ, SR, db2a, gauss, guitar, refTone, rng, stringFor, voice, VOICE_LEAD, thump, squeak, OPEN, type GOpts, type VOpts } from './syn6.ts';
import * as E from '../../src/core/engine.ts';
import * as S from '../../src/core/session.ts';
import * as SET from '../../src/core/settings.ts';
import * as SONGS from '../../src/core/songs.ts';
export const SONG = SONGS.STAR_SPANGLED_BANNER;
export const HOP = Math.round(0.02 * SR);

export interface Env {
  seed?: number; floorDb?: number;
  /** rt = RT60 s; drr dB for guitar/voice at their distance; taps = early reflections [ms, gain] (table/floor/wall) */
  room?: { rt: number; drrG: number; drrV?: number; taps?: [number, number][]; tapsV?: [number, number][] } | null;
  /** phone's own speaker heard by its own mic: level (dBFS peak of the tone at the mic), false = headphones */
  spk?: { db: number; hp?: number } | null;
  hpHz?: number; lpHz?: number;
  ns?: { creepDbS: number; floorDb: number; beta: number } | null;
  agc?: { upDbS: number; downDbS: number; target: number; max: number } | null;
  aec?: boolean;
  humDb?: number; settings?: Record<string, unknown>;
}
type Tag = 'g' | 'sym' | 'v' | 'x' | 'ref';
interface Ev { buf: Float32Array; start: number; gain: number; stop: number | null; fade: number; tag: Tag; bus: 0 | 1 | 2; midi: number; string: number; onset: number }
export interface Adv { t: number; index: number; phase: string; pos: number; target: number; legit: boolean; why: string; lat?: number }

export class FDN {
  // DENSE=1: 16 lines, 23-151 ms (modal overlap >= 3 at RT 0.5 s, like a real room above its Schroeder frequency); default 8 lines
  d: Float32Array[] = []; p: number[] = []; len: number[] = []; g: number[] = []; lp: number[] = []; a: number[] = []; n: number; o: Float64Array;
  constructor(rt: number, seed: number) {
    const r = rng(seed); const ms = process.env.DENSE ? [23.1, 29.3, 37.1, 41.9, 47.3, 53.9, 61.7, 71.3, 79.9, 88.3, 97.1, 106.7, 115.9, 127.3, 139.1, 151.7] : [23.1, 29.3, 37.1, 41.9, 47.3, 53.9, 61.7, 71.3];
    this.n = ms.length; this.o = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) { const L = Math.round(ms[i] * (0.9 + 0.2 * r()) * SR / 1000) | 1; this.len.push(L); this.d.push(new Float32Array(L)); this.p.push(0); this.g.push(Math.pow(10, -3 * (L / SR) / rt)); this.lp.push(0); this.a.push(1 - Math.pow(10, -3 * (L / SR) / (rt * 0.45)) / Math.pow(10, -3 * (L / SR) / rt)); }
  }
  s(x: number): number {
    let sum = 0; const o = this.o; let out = 0; const n = this.n;
    for (let i = 0; i < n; i++) { const v = this.d[i][this.p[i]]; o[i] = v; sum += v; out += (i & 1 ? -1 : 1) * v; }
    sum *= 2 / n;
    for (let i = 0; i < n; i++) { let v = (o[i] - sum) * this.g[i]; this.lp[i] += (1 - this.a[i]) * (v - this.lp[i]); v = this.lp[i]; this.d[i][this.p[i]] = v + x; this.p[i] = (this.p[i] + 1) % this.len[i]; }
    return out;
  }
}
const NFFT = 512, NHOP = 256;
function fftc(re: Float64Array, im: Float64Array, inv: boolean) { const n = re.length; for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } } for (let len = 2; len <= n; len <<= 1) { const ang = (inv ? 2 : -2) * Math.PI / len; const wr = Math.cos(ang), wi = Math.sin(ang); const h = len >> 1; for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < h; k++) { const a = i + k, b = a + h; const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr; re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } } if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; } }
/** STFT spectral-subtraction noise suppressor with a creeping per-bin noise estimate (eats decays and held tones) */
class NS {
  inb = new Float32Array(NFFT); outb = new Float32Array(NFFT + NHOP); fill = 0; win = new Float32Array(NFFT); P = new Float64Array(NFFT / 2 + 1); Nz = new Float64Array(NFFT / 2 + 1).fill(1e-12); G = new Float64Array(NFFT / 2 + 1).fill(1); q: number[] = []; first = true;
  o: { creepDbS: number; floorDb: number; beta: number };
  constructor(o: { creepDbS: number; floorDb: number; beta: number }) { this.o = o; for (let i = 0; i < NFFT; i++) this.win[i] = Math.sin(Math.PI * (i + 0.5) / NFFT); }
  s(x: number): number {
    this.inb[NFFT - NHOP + this.fill] = x; const y = this.outb[this.fill]; this.fill++;
    if (this.fill === NHOP) {
      const re = new Float64Array(NFFT), im = new Float64Array(NFFT); for (let i = 0; i < NFFT; i++) re[i] = this.inb[i] * this.win[i]; fftc(re, im, false);
      const up = Math.pow(10, this.o.creepDbS * (NHOP / SR) / 10), fl = db2a(this.o.floorDb);
      for (let k = 0; k <= NFFT / 2; k++) { const p = re[k] * re[k] + im[k] * im[k]; this.P[k] = 0.6 * this.P[k] + 0.4 * p; if (this.first || this.P[k] < this.Nz[k]) this.Nz[k] = Math.max(this.P[k], 1e-14); else this.Nz[k] *= up; let g = Math.max(fl, 1 - this.o.beta * this.Nz[k] / (this.P[k] + 1e-20)); g = g > this.G[k] ? g : 0.7 * this.G[k] + 0.3 * g; this.G[k] = g; re[k] *= g; im[k] *= g; if (k > 0 && k < NFFT / 2) { re[NFFT - k] = re[k]; im[NFFT - k] = -im[k]; } }
      this.first = false; fftc(re, im, true);
      this.outb.copyWithin(0, NHOP); this.outb.fill(0, NFFT, NFFT + NHOP); for (let i = 0; i < NFFT; i++) this.outb[i] += re[i] * this.win[i];
      this.inb.copyWithin(0, NHOP); this.fill = 0;
    }
    return y;
  }
}

export class Rig {
  s: any; sa: any; n = 0; evs: Ev[] = []; log: Adv[] = []; env: Env; r: () => number;
  fdn: FDN | null = null; send = [0, 0, 0]; taps: { d: number; g: number }[][] = [[], [], []]; ring = [new Float32Array(8192), new Float32Array(8192), new Float32Array(8192)];
  hp: BQ[] = []; lp: BQ[] = []; ns: NS | null = null; agcG = 0; agcE = 1e-9; duck = 1; spkOnUntil = -1;
  stage: 'none' | 'delay' | 'playing' = 'none'; left = 0; wasMuted = true; fed = 0;
  stepT = 0; lastAdvT = 0; plucks: { t: number; midi: number; ok: boolean }[] = []; voices: { t0: number; t1: number; midi: number; ev: Ev }[] = [];
  hints: Record<string, number> = {}; cache = new Map<string, { main: Float32Array; sym: Float32Array }>(); pinkS = [0, 0, 0]; keyDone = false;
  constructor(env: Env = {}) {
    this.env = env; this.r = rng(env.seed ?? 11);
    if (env.room) {
      this.fdn = new FDN(env.room.rt, (env.seed ?? 11) + 3);
      const probe = new FDN(env.room.rt, (env.seed ?? 11) + 3); let ew = 0; for (let i = 0; i < SR * 2; i++) { const v = probe.s(i === 0 ? 1 : 0); ew += v * v; }
      const mk = (drr: number) => Math.sqrt(Math.pow(10, -drr / 10) / ew);
      this.send = [mk(env.room.drrG), mk(env.room.drrV ?? env.room.drrG), mk((env.room.drrG) + 14)];
      const t = (a?: [number, number][]) => (a ?? []).map(([ms, g]) => ({ d: Math.round(ms * SR / 1000), g }));
      this.taps = [t(env.room.taps), t(env.room.tapsV ?? env.room.taps), t(env.room.taps?.slice(0, 1))];
    }
    if (env.hpHz) this.hp = [new BQ('hp', env.hpHz, 0.707)];
    if (env.lpHz) this.lp = [new BQ('lp', env.lpHz, 0.54), new BQ('lp', env.lpHz, 1.3)];
    if (env.ns) this.ns = new NS(env.ns);
    this.sa = new E.StreamAnalyzer(SR);
    this.s = new S.Session(SONG, 48, { ...SET.DEFAULT_SETTINGS, playKeyAtStart: false, ...(env.settings ?? {}) });
  }
  get t() { return this.n / SR; }
  // (the app's mic-check screen runs the guitar detector for seconds before a session: do the same, 1.5 s of room)
  begin(from = 0) { for (let i = 0; i < 75; i++) { const x = (this as any).render(HOP); this.sa.push(x); this.n += HOP; this.fed += HOP; if (this.fed >= E.FRAME_SIZE) { this.sa.frame('guitar', this.t); this.sa.frame('voice', this.t); } } this.s.start(from); this.stage = 'delay'; this.left = 0.4; this.wasMuted = false; }
  add(buf: Float32Array, gainDb: number, tag: Tag, midi: number, string = -1, offset = 0, lead = 0): Ev {
    const start = this.n + offset;
    if (string >= 0 && tag === 'g') for (const e of this.evs) if (e.tag === 'g' && e.string === string && e.stop === null) { e.stop = start; e.fade = Math.floor(0.006 * SR); }
    const ev: Ev = { buf, start, gain: db2a(gainDb), stop: null, fade: 0, tag, bus: tag === 'ref' ? 2 : tag === 'v' ? 1 : 0, midi, string, onset: (start + lead * SR) / SR };
    this.evs.push(ev); return ev;
  }
  /** pluck; ok=false marks a deliberately wrong/unintended note (never legit) */
  pluck(o: GOpts, levelDb = -14, offset = 0, ok = true, symOn = true): Ev {
    const key = JSON.stringify(o); let b = this.cache.get(key); if (!b) { b = guitar(o); if (this.cache.size > 400) this.cache.clear(); this.cache.set(key, b); }
    const st = o.string ?? stringFor(o.midi).s; const ev = this.add(b.main, levelDb, 'g', o.midi, st, offset, 0.012);
    if (symOn) this.add(b.sym, levelDb, 'sym', o.midi, st, offset, 0.012);
    this.plucks.push({ t: ev.onset, midi: o.midi + Math.round((o.cents ?? 0) / 100), ok }); return ev;
  }
  sing(o: VOpts, levelDb = -28, offset = 0): Ev { const ev = this.add(voice(o), levelDb, 'v', o.midi, -1, offset, VOICE_LEAD); this.voices.push({ t0: ev.onset, t1: ev.onset + o.dur + 0.1, midi: o.midi, ev }); return ev; }
  noise(buf: Float32Array, levelDb: number, bus: 0 | 1 = 0, offset = 0) { const ev = this.add(buf, levelDb, 'x', -1, -1, offset); ev.bus = bus; return ev; }
  stop(ev: Ev, fadeMs = 60) { if (ev.stop === null) { ev.stop = this.n; ev.fade = Math.floor((fadeMs / 1000) * SR); } for (const v of this.voices) if (v.ev === ev && v.t1 > this.t) v.t1 = this.t; }
  /** student mutes the strings (played and sympathetic) */
  damp(all = true) { for (const e of this.evs) if ((e.tag === 'g' || (all && e.tag === 'sym')) && e.stop === null) { e.stop = this.n; e.fade = Math.floor(0.05 * SR); } }
  ringing(): number[] { return this.evs.filter((e) => e.tag === 'g' && this.n < e.start + e.buf.length && (e.stop === null || this.n < e.stop)).map((e) => e.midi); }

  private render(len: number): Float32Array {
    const x = new Float32Array(len); const env = this.env; const bus = [new Float32Array(len), new Float32Array(len), new Float32Array(len)];
    this.evs = this.evs.filter((e) => this.n < e.start + e.buf.length && (e.stop === null || this.n < e.stop + e.fade));
    let spk = false;
    for (const e of this.evs) {
      if (e.tag === 'ref' && this.n >= e.start) spk = true;
      const b = bus[e.bus];
      for (let i = Math.max(0, e.start - this.n); i < len; i++) { const off = this.n + i - e.start; if (off >= e.buf.length) break; let g = e.gain; if (e.stop !== null) { const past = this.n + i - e.stop; if (past > 0) g *= Math.max(0, 1 - past / Math.max(1, e.fade)); } b[i] += g * e.buf[off]; }
    }
    if (spk) this.spkOnUntil = this.t + 0.25;
    const fl = db2a(env.floorDb ?? -62);
    for (let i = 0; i < len; i++) {
      let y = 0; let fin = 0; const w = (this.n + i) & 8191;
      for (let b = 0; b < 3; b++) { const v = bus[b][i]; this.ring[b][w] = v; y += v; for (const tp of this.taps[b]) y += tp.g * this.ring[b][(w - tp.d) & 8191]; fin += this.send[b] * v; }
      if (this.fdn) y += this.fdn.s(fin);
      // room noise: pink-ish (3 one-poles) + optional mains hum
      const wn = gauss(this.r); this.pinkS[0] += 0.02 * (wn - this.pinkS[0]); this.pinkS[1] += 0.2 * (wn - this.pinkS[1]); y += fl * (3.5 * this.pinkS[0] + 1.2 * this.pinkS[1] + 0.35 * wn);
      if (env.humDb !== undefined) { const tt = (this.n + i) / SR; y += db2a(env.humDb) * (Math.sin(2 * Math.PI * 60 * tt) + 0.5 * Math.sin(2 * Math.PI * 120 * tt + 1) + 0.3 * Math.sin(2 * Math.PI * 180 * tt + 2)); }
      for (const f of this.hp) y = f.s(y); for (const f of this.lp) y = f.s(y);
      if (env.aec) { const tgt = (this.n + i) / SR < this.spkOnUntil ? 0.03 : 1; this.duck += (tgt < this.duck ? 0.02 : 0.0003) * (tgt - this.duck); y *= this.duck; }
      if (this.ns) y = this.ns.s(y);
      if (env.agc) { const a = env.agc; this.agcE += (1 - Math.exp(-1 / (0.03 * SR))) * (y * y - this.agcE); const lvl = 10 * Math.log10(this.agcE + 1e-14) + this.agcG; if (lvl > a.target) this.agcG -= a.downDbS / SR; else if (lvl > a.target - 35) this.agcG += a.upDbS / SR; this.agcG = Math.max(-24, Math.min(a.max, this.agcG)); y = Math.tanh(y * db2a(this.agcG) / 0.95) * 0.95; }
      x[i] = y;
    }
    return x;
  }
  /** one 20 ms hop, as audio.ts onAudio/deliver + main.ts onFrame/runListen */
  step(): any {
    const x = this.render(HOP); this.sa.push(x); this.n += HOP; this.fed += HOP; const tNow = this.t;
    let v = this.s.view(); if (v.phase === 'done' || this.fed < E.FRAME_SIZE) return v;
    if (v.phase === 'listen') {
      this.left -= HOP / SR;
      if (this.stage === 'delay') {
        if (!this.wasMuted) { const fr = this.sa.frame('guitar', tNow); this.s.pitch(fr); }
        if (this.left <= 0) {
          let notes: { midi: number | number[]; sec: number }[] = v.listenKind === 'phrase' ? v.listenNotes.map((q: any) => ({ midi: q.midi, sec: Math.max(0.12, (q.beats * 60) / SONG.bpm) })) : [{ midi: v.targetMidi, sec: 0.9 }];
          if (this.env.settings?.playKeyAtStart && !this.keyDone) { this.keyDone = true; const t = 48; notes = [{ midi: t, sec: 0.32 }, { midi: t + 4, sec: 0.32 }, { midi: t + 7, sec: 0.32 }, { midi: t + 12, sec: 0.4 }, { midi: [t, t + 4, t + 7, t + 12], sec: 1.0 }, { midi: -1, sec: 0.35 + 0.3 + 0.3 }, ...notes]; }
          let tt = 0.06;
          for (const q of notes) { if (this.env.spk && q.midi !== -1) for (const m of Array.isArray(q.midi) ? q.midi : [q.midi]) this.add(refTone(m, Math.max(0.2, q.sec), this.env.spk.hp ?? 450), this.env.spk.db + (Array.isArray(q.midi) ? -4.4 : 0), 'ref', m, -1, Math.round(tt * SR)); tt += q.sec; }
          this.stage = 'playing'; this.left = tt + 0.35 + 0.3 + 0.02; this.wasMuted = true;
        }
      } else if (this.left <= 0) { this.stage = 'none'; this.s.listenDone(tNow); this.stepT = this.t; v = this.s.view(); }
      return v;
    }
    if (this.wasMuted) { this.sa.attacks?.clear?.(); this.wasMuted = false; }
    const before = v; const fr = this.sa.frame(this.s.listeningPath(), tNow); const adv = this.s.pitch(fr);
    const h = this.s.view().match?.hint ?? null;
    if (process.env.DBG && (process.env.DBG === before.phase)) { const m = this.s.view().match; const cd = (this.s as any).matcher?.cand; console.log(`${before.phase} #${before.index + 1} t=${(tNow - this.stepT).toFixed(2)} f=${fr.freq?.toFixed(1)} cl=${fr.clarity?.toFixed(2)} db=${(20 * Math.log10(fr.rms + 1e-9)).toFixed(1)} clean=${(20 * Math.log10((fr.cleanRms ?? fr.rms) + 1e-9)).toFixed(1)} src=${cd?.source ?? '-'} pk=${cd ? (cd.peakT - this.stepT).toFixed(2) + '/' + cd.peakDb.toFixed(1) : '-'} det=${m?.detectedMidi?.toFixed(2)} c=${m?.cents?.toFixed(0)} ${h ?? ''} ${adv ? 'ADV' : ''}`); }
    if (!adv && h) { const k = `${before.phase}:${h}`; this.hints[k] = (this.hints[k] ?? 0) + 1; this.onHint?.(before.phase, h); }
    if (adv) {
      const t = this.t; let legit = false; let why = ''; let lat: number | undefined;
      if (before.phase === 'sing') {
        const pc = (a: number, b: number) => Math.abs(((((a - b) % 12) + 18) % 12) - 6);
        const vi = this.voices.filter((q) => q.t1 >= this.stepT - 0.05 && q.t0 < t && t <= q.t1 + 0.4 && pc(q.midi, before.targetMidi) < 0.6).pop();
        legit = !!vi; if (vi) lat = (t - Math.max(vi.t0, this.stepT)) * 1000; else why = `sing passed with no right sung note (ringing ${this.ringing().join(',') || '-'}; last voice ${this.voices.filter((q) => q.t0 < t).pop()?.midi ?? '-'})`;
      } else {
        const since = before.phase === 'play' ? this.stepT : this.lastAdvT;
        const lp = this.plucks.filter((q) => q.t >= since - 0.03 && q.t <= t).pop();
        legit = !!lp && lp.ok && lp.midi === before.targetMidi;
        if (legit) lat = (t - lp!.t) * 1000;
        else { const vo = this.voices.filter((q) => q.t0 <= t && q.t1 >= since - 0.3).pop(); why = lp ? `WRONG NOTE (${lp.midi - before.targetMidi} st${lp.ok ? '' : ', unintended'}) accepted ${((t - lp.t) * 1000).toFixed(0)} ms after it` : `NO PLUCK in step (voice ${vo ? vo.midi + ' on ' + ((t - vo.t0) * 1000).toFixed(0) + ' ms ago, ended ' + ((t - vo.t1) * 1000).toFixed(0) + ' ms ago' : '-'}; ringing ${this.ringing().join(',') || '-'}; last act ${this.lastNoise ?? '-'} now ${t.toFixed(2)})`; }
      }
      this.log.push({ t, index: before.index, phase: before.phase, pos: before.review?.pos ?? -1, target: before.targetMidi, legit, why, lat });
      this.lastAdvT = t; this.stepT = t; v = this.s.view();
      if (v.phase === 'listen') { this.stage = 'delay'; this.left = 0.7; }
    }
    return v;
  }
  onHint: ((phase: string, h: string) => void) | null = null; lastNoise: string | null = null;
  run(sec: number, until?: (v: any) => boolean): any { let v = this.s.view(); const end = this.n + sec * SR; while (this.n < end) { v = this.step(); if (v.phase === 'done' || (until && until(v))) break; } return v; }
  skip() { this.s.skip(this.t); if (this.s.view().phase === 'listen') { this.stage = 'delay'; this.left = 0.3; } }
}

// ------------------------------------------------------------------ student
export interface Style {
  name: string; env?: Env; female?: boolean; maxNotes?: number; from?: number;
  g?: (midi: number, r: () => number) => Partial<GOpts>; gLevel?: [number, number];
  v?: (midi: number, r: () => number) => Partial<VOpts>; vLevel?: [number, number];
  cents?: (midi: number, r: () => number) => number;
  think?: [number, number]; hold?: [number, number]; pause?: [number, number]; ring?: boolean; noteDur?: number; reviewIOI?: [number, number];
  /** behaviours, each a probability per guitar step unless noted */
  singAlong?: number;            // starts singing while the reference still plays
  huntHum?: number; hum?: (midi: number, r: () => number) => Partial<VOpts>; humLevel?: [number, number]; humGap?: [number, number];
  wrongFirst?: number;           // plays a wrong note (neighbour fret / string) first, then the right one
  doublePluck?: number;          // hesitant: soft half-pluck then the real one 0.15-0.4 s later
  slideIn?: number; buzz?: number;
  thump?: number; squeak?: number; talk?: number; openNeighbour?: number;
  /** review: probability of the same noises between notes */
  reviewNoise?: number;
}
export interface Res { name: string; notes: number; playSteps: number; firstPluck: number; replucks: number; playStuck: number; singSteps: number; singFirst: number; singStuck: number; revNotes: number; revFirst: number; revStuck: number; bad: Adv[]; lat: number[]; singLat: number[]; revLat: number[]; hints: Record<string, number>; simSec: number; stuckAt: string[]; humSteps: number; wrongSteps: number; noiseSteps: number; noPluck: number }
const u = (r: () => number, [a, b]: [number, number]) => a + (b - a) * r();
export function sungMidi(target: number, female?: boolean): number { if (female) return target < 55 ? target + 12 : target; return target > 62 ? target - 12 : target; }
export function speak(rig: Rig, r: () => number, female = false, level = -30) {
  // "o-kay" / "um" / "one two": 1-3 syllables with falling speech contour, vowels morphing
  const n = 1 + Math.floor(r() * 3); let off = 0; const base = (female ? 57 : 45) + 4 * r();
  for (let i = 0; i < n; i++) { const d = 0.12 + 0.2 * r(); const vs = ['a', 'e', 'o', 'u', 'i']; const fall = 2 + 5 * r();
    rig.sing({ midi: base - 1.5 * i, dur: d, vowel: vs[Math.floor(r() * 5)], vowel2: vs[Math.floor(r() * 5)], onset: (['d', 't', 'b', 'h', 'normal', 'm'] as const)[Math.floor(r() * 6)], contour: (t) => -fall * t / d, female, seed: Math.floor(r() * 1e6), jitter: 0.012, breath: 0.04 }, level + 4 * r(), Math.round(off * SR));
    rig.voices.pop(); off += d + 0.05 + 0.15 * r(); }
  rig.lastNoise = 'speech@' + rig.t.toFixed(2); return off;
}
export function honest(st: Style): Res {
  const rig = new Rig(st.env ?? {}); const r = rng((st.env?.seed ?? 11) * 7 + 1);
  const res: Res = { name: st.name, notes: 0, playSteps: 0, firstPluck: 0, replucks: 0, playStuck: 0, singSteps: 0, singFirst: 0, singStuck: 0, revNotes: 0, revFirst: 0, revStuck: 0, bad: [], lat: [], singLat: [], revLat: [], hints: {}, simSec: 0, stuckAt: [], humSteps: 0, wrongSteps: 0, noiseSteps: 0, noPluck: 0 };
  const gopts = (midi: number): GOpts => { const k = Math.floor(r() * 3); const rr = rng(midi * 31 + k); return { midi, seed: midi * 31 + k, dur: st.noteDur ?? 3.2, cents: st.cents ? Math.round(st.cents(midi, rr)) : Math.round(5 * gauss(rr)), ...(st.g ? st.g(midi, rr) : {}) }; };
  const doPluck = (midi: number, extra: Partial<GOpts> = {}) => rig.pluck({ ...gopts(midi), ...extra }, u(r, st.gLevel ?? [-18, -10]), Math.floor(r() * HOP));
  rig.begin(st.from ?? 0);
  let voiceEv: any = null; let voiceStopAt = Infinity;
  const tick = (sec: number, until?: (v: any) => boolean) => { const end = rig.t + sec; let v = rig.s.view(); while (rig.t < end) { if (voiceEv && rig.t >= voiceStopAt) { rig.stop(voiceEv, 60); voiceEv = null; voiceStopAt = Infinity; } v = rig.step(); if (v.phase === 'done' || (until && until(v))) break; } return v; };
  const noises = (phaseOk: (q: any) => boolean) => {
    let did = false;
    if (r() < (st.thump ?? 0)) { rig.noise(thump(Math.floor(r() * 1e6), 70 + 60 * r()), -12 - 8 * r()); rig.lastNoise = 'thump@' + rig.t.toFixed(2); did = true; tick(0.25 + 0.5 * r(), (q) => !phaseOk(q)); }
    if (r() < (st.squeak ?? 0)) { rig.noise(squeak(Math.floor(r() * 1e6)), -30 - 8 * r()); rig.lastNoise = 'squeak@' + rig.t.toFixed(2); did = true; tick(0.2 + 0.3 * r(), (q) => !phaseOk(q)); }
    if (r() < (st.talk ?? 0)) { const d = speak(rig, r, st.female, st.vLevel ? st.vLevel[1] : -26); did = true; tick(d + 0.2 + 0.5 * r(), (q) => !phaseOk(q)); }
    return did;
  };
  for (;;) {
    // during the reference: maybe start singing along (voice already sounding when the sing step opens)
    let v = rig.s.view(); let along = false;
    if (v.phase === 'listen' && r() < (st.singAlong ?? 0)) {
      v = tick(60, (q) => q.phase !== 'listen' || rig.stage === 'playing'); v = tick(0.35 + 0.4 * r(), (q) => q.phase !== 'listen');
      if (v.phase === 'listen') { const sm = sungMidi(v.targetMidi, st.female); voiceEv = rig.sing({ midi: sm, dur: 5.6, female: st.female, seed: v.index * 17, scoop: 30 * r(), ...(st.v ? st.v(sm, r) : {}) }, u(r, st.vLevel ?? [-30, -24]), 0); voiceStopAt = Infinity; along = true; }
    }
    v = tick(60, (q) => q.phase !== 'listen');
    if (v.phase === 'done') break;
    const idx = v.index; const target = v.targetMidi;
    if (st.maxNotes && idx - (st.from ?? 0) >= st.maxNotes) break;
    if (v.phase === 'sing') {
      res.singSteps++;
      let ok = false;
      if (along) { v = tick(4, (q) => q.phase !== 'sing'); ok = v.phase !== 'sing'; if (ok) res.singFirst++; else { rig.stop(voiceEv, 60); voiceEv = null; tick(0.6); } }
      else { v = tick(u(r, st.think ?? [0.4, 1.0]), (q) => q.phase !== 'sing'); ok = v.phase !== 'sing'; }
      for (let a = 0; a < 3 && !ok; a++) {
        const sm = sungMidi(target, st.female);
        const vo: VOpts = { midi: sm, dur: 5.6, female: st.female, seed: idx * 13 + a, scoop: 40 * r(), ...(st.v ? st.v(sm, r) : {}) };
        voiceEv = rig.sing(vo, u(r, st.vLevel ?? [-30, -24]), Math.floor(r() * HOP)); voiceStopAt = Infinity;
        v = tick(Math.min(5, vo.dur + 0.3), (q) => q.phase !== 'sing');
        if (v.phase !== 'sing') { ok = true; if (a === 0 && !along) res.singFirst++; break; }
        rig.stop(voiceEv, 60); voiceEv = null; v = tick(0.8, (q) => q.phase !== 'sing'); if (v.phase !== 'sing') ok = true;
      }
      if (!ok) { res.singStuck++; res.stuckAt.push(`sing#${idx + 1}`); rig.skip(); continue; }
      if (voiceEv) voiceStopAt = rig.t + u(r, st.hold ?? [0.05, 0.4]);
    }
    v = rig.s.view();
    if (v.phase === 'play' && v.index === idx) {
      res.playSteps++; const inPlay = (q: any) => q.phase === 'play';
      v = tick(Math.max(0.02, (voiceStopAt === Infinity ? 0 : voiceStopAt - rig.t) + u(r, st.pause ?? [0.4, 1.2])), (q) => !inPlay(q));
      if (inPlay(v) && noises(inPlay)) res.noiseSteps++;
      v = rig.s.view();
      if (inPlay(v) && r() < (st.huntHum ?? 0)) { // quietly re-sing the note while hunting for it
        rig.lastNoise = 'HUM@' + rig.t.toFixed(2); res.humSteps++; const sm = sungMidi(target, st.female); const ho: VOpts = { midi: sm, dur: 0.5, vowel: 'm', onset: 'soft', fadeDbS: 12, female: st.female, seed: idx * 29, ...(st.hum ? st.hum(sm, r) : {}) };
        rig.sing(ho, u(r, st.humLevel ?? [-36, -28]), 0); v = tick(ho.dur + u(r, st.humGap ?? [0.3, 1.2]), (q) => !inPlay(q));
      }
      if (inPlay(v) && r() < (st.wrongFirst ?? 0)) {
        res.wrongSteps++; const k = r(); const wm = k < 0.3 ? target - 1 : k < 0.6 ? target + 1 : k < 0.75 ? target + 2 : k < 0.9 ? target - 2 : OPEN[Math.max(0, Math.min(5, stringFor(target).s + (r() < 0.5 ? -1 : 1)))];
        if (wm !== target && wm >= 40) { rig.pluck({ ...gopts(wm) }, u(r, st.gLevel ?? [-18, -10]), 0, false); v = tick(0.7 + 0.9 * r(), (q) => !inPlay(q)); }
      }
      let ok = !inPlay(v); let k = 0;
      for (; k < 5 && !ok; k++) {
        const extra: Partial<GOpts> = {};
        if (r() < (st.slideIn ?? 0)) { extra.slide = r() < 0.7 ? -1 - Math.floor(2 * r()) : 1; extra.slideMs = 80 + 120 * r(); }
        if (r() < (st.buzz ?? 0)) extra.buzz = 0.3 + 0.6 * r();
        if (r() < (st.openNeighbour ?? 0)) { const ns = Math.max(0, Math.min(5, stringFor(target).s + (r() < 0.5 ? -1 : 1))); if (OPEN[ns] !== target) { rig.pluck({ midi: OPEN[ns], seed: 5, dur: 3.2, pluck: 'finger' }, u(r, st.gLevel ?? [-18, -10]) - 8 - 8 * r(), 0, false, false); rig.plucks.pop(); tick(0.03 + 0.08 * r(), (q) => !inPlay(q)); } }
        if (k === 0 && r() < (st.doublePluck ?? 0)) { rig.pluck({ ...gopts(target), mute: true }, u(r, st.gLevel ?? [-18, -10]) - 8, 0); v = tick(0.15 + 0.25 * r(), (q) => !inPlay(q)); if (!inPlay(v)) { ok = true; k = 1; break; } }
        doPluck(target, extra); v = tick(2.5, (q) => !inPlay(q)); if (!inPlay(v)) ok = true;
      }
      if (ok && k === 1) res.firstPluck++;
      if (ok && k === 0) res.noPluck++;
      if (ok && k > 1) res.replucks += k - 1;
      if (!ok) { res.playStuck++; res.stuckAt.push(`play#${idx + 1}(${target})`); rig.skip(); continue; }
    }
    v = rig.s.view();
    if (v.phase === 'listen' && v.listenKind === 'phrase') { if (!st.ring) rig.damp(); v = tick(60, (q) => q.phase !== 'listen'); }
    if (v.phase === 'review' && v.index === idx) {
      const inRev = (q: any) => q.phase === 'review' && q.index === idx;
      v = tick(u(r, [0.5, 1.0]), (q) => !inRev(q));
      if (inRev(v) && r() < (st.reviewNoise ?? 0)) { const pos0 = v.review.pos; noises((q) => inRev(q) && q.review.pos === pos0); v = rig.s.view(); }
      let stuck = false;
      while (inRev(v) && !stuck) {
        const pos = v.review.pos; const tgt = v.targetMidi; res.revNotes++; const same = (q: any) => inRev(q) && q.review.pos === pos;
        let k = 0; let ok = false;
        for (; k < 5 && !ok; k++) { doPluck(tgt); v = tick(2.5, (q) => !same(q)); ok = !same(v); }
        if (ok && k === 1) res.revFirst++;
        if (!ok) { res.revStuck++; res.stuckAt.push(`review#${idx + 1}pos${pos}(${tgt})`); rig.skip(); stuck = true; break; }
        if (inRev(v)) { const p2 = v.review.pos; v = tick(u(r, st.reviewIOI ?? [0.35, 0.6]) - 0.02, (q) => !(inRev(q) && q.review.pos === p2)); }
      }
    }
    if (!st.ring) rig.damp();
    res.notes++;
  }
  for (const a of rig.log) { if (!a.legit) res.bad.push(a); else if (a.lat !== undefined) (a.phase === 'play' ? res.lat : a.phase === 'sing' ? res.singLat : res.revLat).push(a.lat); }
  res.hints = rig.hints; res.simSec = rig.t; return res;
}
export const med = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
export const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
export function line(r: Res): string {
  return `${r.name.padEnd(40)} play ${r.firstPluck}/${r.playSteps - r.noPluck} first (${r.noPluck} adv before any pluck), +${r.replucks} repl, ${r.playStuck} stuck | sing ${r.singFirst}/${r.singSteps}, ${r.singStuck} stuck | review ${r.revFirst}/${r.revNotes}, ${r.revStuck} stuck | BAD ${r.bad.length} (sing ${r.bad.filter((b) => b.phase === 'sing').length} play ${r.bad.filter((b) => b.phase === 'play').length} rev ${r.bad.filter((b) => b.phase === 'review').length}) | lat med ${med(r.lat).toFixed(0)} p90 ${pct(r.lat, 0.9).toFixed(0)} rev ${med(r.revLat).toFixed(0)} sing ${med(r.singLat).toFixed(0)} | hum ${r.humSteps} wrong ${r.wrongSteps} noise ${r.noiseSteps} | ${(r.simSec / 60).toFixed(1)} min`;
}
export function report(r: Res, t0: number) { console.log(line(r)); for (const b of r.bad.slice(0, process.env.ALLBAD ? 999 : 10)) console.log(`   BAD note ${b.index + 1} ${b.phase}${b.pos >= 0 ? ' pos ' + b.pos : ''} target ${b.target}: ${b.why}`); console.log('   stuck:', r.stuckAt.join(' ') || '-', '| hints', JSON.stringify(r.hints), `| wall ${((Date.now() - t0) / 1000).toFixed(0)} s`); }
