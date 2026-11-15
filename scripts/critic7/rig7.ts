// Seventh review's rig (ported from the review, unchanged except: it runs this repository's own
// engine and session, and caches its synthesis in the system's temp directory). Critic-7 rig: dry sources -> per-bus partitioned convolution with a modal room IR (so a note stopped dry keeps its true
// reverberant tail) -> phone chain (mic high-pass, noise, optional compressor/AGC) -> the app's real StreamAnalyzer + Session
// with main.ts/audio.ts timing (frames dropped while the reference plays + 0.3 s tail, 700 ms pause after an accept).
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { BQ, SR, db2a, gauss, guitar, refTone, rng, stringFor, voice, VOICE_LEAD, fft, roomIR, OPEN, type GOpts, type VOpts, type RoomP } from './syn7.ts';
export const HERE = import.meta.dirname;
export const HOP = Math.round(0.02 * SR);
import * as E0 from '../../src/core/engine.ts';
import * as S0 from '../../src/core/session.ts';
import * as SET0 from '../../src/core/settings.ts';
import * as SONGS0 from '../../src/core/songs.ts';
/** this repository's engine and session (the review loaded a build directory by name) */
export async function load(build = 'here') {
  return { E: E0, S: S0, SET: SET0, SONG: SONGS0.STAR_SPANGLED_BANNER, build };
}
export type Mods = Awaited<ReturnType<typeof load>>;
// ---- cached synthesis
const CACHE = join(tmpdir(), 'song-pitcher-critic7-cache'); mkdirSync(CACHE, { recursive: true });
function cached(key: string, make: () => Float32Array[]): Float32Array[] {
  const h = createHash('sha1').update(key).digest('hex').slice(0, 20); const p = join(CACHE, h);
  if (existsSync(p + '.0')) { const out: Float32Array[] = []; for (let i = 0; existsSync(`${p}.${i}`); i++) { const b = readFileSync(`${p}.${i}`); out.push(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice()); } return out; }
  const out = make(); out.forEach((x, i) => writeFileSync(`${p}.${i}`, Buffer.from(x.buffer, x.byteOffset, x.byteLength))); return out;
}
const mem = new Map<string, Float32Array[]>();
function memo(key: string, make: () => Float32Array[]) { let v = mem.get(key); if (!v) { v = cached(key, make); if (mem.size > 600) mem.clear(); mem.set(key, v); } return v; }
export const G = (o: GOpts) => { const g = memo('g3' + JSON.stringify(o), () => { const x = guitar(o); return [x.main, x.sym]; }); return { main: g[0], sym: g[1] }; };
export const V = (o: VOpts) => memo('v6' + JSON.stringify({ ...o, contour: o.contour ? String(o.contour) : undefined }), () => [voice(o)])[0];
export const IR = (p: RoomP) => memo('ir3' + JSON.stringify(p), () => [roomIR(p)])[0];
export const REF = (m: number, d: number, hp: number) => memo(`ref${m}_${d}_${hp}`, () => [refTone(m, d, hp)])[0];

/** uniformly partitioned overlap-save convolver, block 1024 */
const B = 1024;
class PConv {
  hr: Float64Array[] = []; hi: Float64Array[] = []; xr: Float64Array[] = []; xi: Float64Array[] = []; inb = new Float64Array(2 * B); p = 0; K: number;
  constructor(ir: Float32Array) { this.K = Math.ceil(ir.length / B); for (let k = 0; k < this.K; k++) { const re = new Float64Array(2 * B), im = new Float64Array(2 * B); for (let i = 0; i < B && k * B + i < ir.length; i++) re[i] = ir[k * B + i]; fft(re, im); this.hr.push(re); this.hi.push(im); this.xr.push(new Float64Array(2 * B)); this.xi.push(new Float64Array(2 * B)); } }
  run(x: Float32Array, out: Float32Array) { // x, out: B samples; out is ADDED to
    this.inb.copyWithin(0, B); for (let i = 0; i < B; i++) this.inb[B + i] = x[i];
    this.p = (this.p + this.K - 1) % this.K; const re = this.xr[this.p], im = this.xi[this.p]; re.set(this.inb); im.fill(0); fft(re, im);
    const yr = new Float64Array(2 * B), yi = new Float64Array(2 * B);
    for (let k = 0; k < this.K; k++) { const a = this.xr[(this.p + k) % this.K], b = this.xi[(this.p + k) % this.K], c = this.hr[k], d = this.hi[k]; for (let i = 0; i <= B; i++) { yr[i] += a[i] * c[i] - b[i] * d[i]; yi[i] += a[i] * d[i] + b[i] * c[i]; } }
    for (let i = 1; i < B; i++) { yr[2 * B - i] = yr[i]; yi[2 * B - i] = -yi[i]; } fft(yr, yi, true);
    for (let i = 0; i < B; i++) out[i] += yr[B + i];
  }
}
export interface Env {
  seed?: number; floorDb?: number; roomG?: RoomP | null; roomV?: RoomP | null;
  spk?: number | null; /** reference tone level at the mic, dBFS peak; null = headphones */
  hpHz?: number; comp?: { thr: number; ratio: number; attMs: number; relMs: number; makeup: number } | null;
  fanDb?: number; settings?: Record<string, unknown>;
}
type Tag = 'g' | 'sym' | 'v' | 'x' | 'ref';
export interface Ev { buf: Float32Array; start: number; gain: number; stop: number | null; fade: number; tag: Tag; bus: 0 | 1 | 2; midi: number; string: number; onset: number }
export interface Adv { t: number; index: number; phase: string; pos: number; target: number; legit: boolean; why: string; lat?: number }
export class Rig {
  s: any; sa: any; n = 0; rendered = 0; fifo = new Float32Array(0); evs: Ev[] = []; log: Adv[] = []; env: Env; r: () => number; m: Mods;
  conv: (PConv | null)[] = [null, null]; hp: BQ[] = []; pink = [0, 0]; fan: BQ[] = []; cEnv = 0;
  stage: 'none' | 'delay' | 'playing' = 'none'; left = 0; wasMuted = true; fed = 0; keyDone = false;
  stepT = 0; lastAdvT = 0; plucks: { t: number; midi: number; ok: boolean }[] = []; voices: { t0: number; t1: number; midi: number; ev: Ev }[] = [];
  hints: Record<string, number> = {}; lastHint: string | null = null;
  constructor(m: Mods, env: Env = {}) {
    this.m = m; this.env = env; this.r = rng(env.seed ?? 11);
    if (env.roomG) this.conv[0] = new PConv(IR(env.roomG)); if (env.roomV ?? env.roomG) this.conv[1] = new PConv(IR((env.roomV ?? env.roomG)!));
    this.hp = [new BQ('hp', env.hpHz ?? 90, 0.707)]; this.fan = [new BQ('bp', 180, 0.6), new BQ('lp', 900, 0.7)];
    this.sa = new m.E.StreamAnalyzer(SR);
    this.s = new m.S.Session(m.SONG, 48, { ...m.SET.DEFAULT_SETTINGS, playKeyAtStart: false, ...(env.settings ?? {}) });
  }
  get t() { return this.n / SR; }
  begin(from = 0) { for (let i = 0; i < 75; i++) { const x = this.pull(); this.sa.push(x); this.n += HOP; this.fed += HOP; if (this.fed >= this.m.E.FRAME_SIZE) { this.sa.frame('guitar', this.t); this.sa.frame('voice', this.t); } } this.s.start(from); this.stage = 'delay'; this.left = 0.4; this.wasMuted = false; }
  add(buf: Float32Array, gainDb: number, tag: Tag, midi: number, string = -1, delay = 0, lead = 0): Ev {
    const start = Math.max(this.rendered, this.n + Math.round(delay * SR));
    if (string >= 0 && tag === 'g') for (const e of this.evs) if (e.tag === 'g' && e.string === string && e.stop === null) { e.stop = start; e.fade = Math.floor(0.008 * SR); }
    const ev: Ev = { buf, start, gain: db2a(gainDb), stop: null, fade: 0, tag, bus: tag === 'ref' ? 2 : tag === 'v' ? 1 : 0, midi, string, onset: start / SR + lead };
    this.evs.push(ev); return ev;
  }
  pluck(o: GOpts, levelDb = -14, delay = 0, ok = true): Ev {
    const b = G(o); const st = o.string ?? stringFor(o.midi).s; const lead = 0.004 + ({ pick: 0.009, softpick: 0.017, nail: 0.018, finger: 0.045, thumb: 0.06 } as any)[o.pluck ?? 'pick'];
    const ev = this.add(b.main, levelDb, 'g', o.midi, st, delay, lead); if (!o.noSym) this.add(b.sym, levelDb, 'sym', o.midi, -1, delay, lead);
    this.plucks.push({ t: ev.onset, midi: o.midi, ok }); return ev;
  }
  sing(o: VOpts, levelDb = -24, delay = 0, track = true): Ev { const ev = this.add(V(o), levelDb, 'v', o.midi, -1, delay, VOICE_LEAD + 0.05); if (track) this.voices.push({ t0: ev.onset, t1: ev.onset + o.dur + 0.1, midi: o.midi, ev }); return ev; }
  /** stop a sound (dry): its reverberant tail still plays out in the room */
  stop(ev: Ev, fadeMs = 70) { if (!ev) return; const at = Math.max(this.rendered, this.n); if (ev.stop === null || ev.stop > at) { ev.stop = at; ev.fade = Math.floor(fadeMs / 1000 * SR); } for (const v of this.voices) if (v.ev === ev && v.t1 > at / SR) v.t1 = at / SR; }
  damp() { for (const e of this.evs) if ((e.tag === 'g' || e.tag === 'sym') && e.stop === null) { e.stop = Math.max(this.rendered, this.n); e.fade = Math.floor(0.05 * SR); } }
  ringing(): number[] { return this.evs.filter((e) => e.tag === 'g' && this.n < e.start + e.buf.length && (e.stop === null || this.n < e.stop)).map((e) => e.midi); }
  private renderBlock() {
    const bus = [new Float32Array(B), new Float32Array(B), new Float32Array(B)]; const n0 = this.rendered;
    this.evs = this.evs.filter((e) => n0 < e.start + e.buf.length && (e.stop === null || n0 < e.stop + e.fade));
    for (const e of this.evs) { const b = bus[e.bus]; for (let i = Math.max(0, e.start - n0); i < B; i++) { const off = n0 + i - e.start; if (off >= e.buf.length) break; let g = e.gain; if (e.stop !== null) { const past = n0 + i - e.stop; if (past > 0) { if (past >= e.fade) break; g *= 0.5 + 0.5 * Math.cos(Math.PI * past / e.fade); } } b[i] += g * e.buf[off]; } }
    const y = new Float32Array(B); const env = this.env;
    for (let k = 0; k < 2; k++) { if (this.conv[k]) this.conv[k]!.run(bus[k], y); else for (let i = 0; i < B; i++) y[i] += bus[k][i]; }
    // the phone's own loudspeaker sits next to its microphone: direct, plus a little of the room
    if (this.conv[0]) { const tmp = new Float32Array(B); for (let i = 0; i < B; i++) tmp[i] = bus[2][i] * 0.06; /* -24 dB into the room */ void tmp; }
    const fl = db2a(env.floorDb ?? -60); const fan = env.fanDb !== undefined ? db2a(env.fanDb) : 0; const c = env.comp;
    for (let i = 0; i < B; i++) {
      let v = y[i] + bus[2][i]; const w = gauss(this.r); this.pink[0] += 0.03 * (w - this.pink[0]); this.pink[1] += 0.25 * (w - this.pink[1]); v += fl * (2.6 * this.pink[0] + 0.9 * this.pink[1] + 0.3 * w);
      if (fan) { const tt = (n0 + i) / SR; v += fan * (2.2 * this.fan[1].s(this.fan[0].s(gauss(this.r))) + 0.35 * Math.sin(2 * Math.PI * 118.3 * tt) + 0.2 * Math.sin(2 * Math.PI * 236.6 * tt + 1)); }
      for (const f of this.hp) v = f.s(v);
      if (c) { const a = Math.abs(v); this.cEnv += (a > this.cEnv ? 1 - Math.exp(-1 / (c.attMs / 1000 * SR)) : 1 - Math.exp(-1 / (c.relMs / 1000 * SR))) * (a - this.cEnv); const lv = 20 * Math.log10(this.cEnv + 1e-9); const gr = lv > c.thr ? (c.thr - lv) * (1 - 1 / c.ratio) : 0; v *= db2a(gr + c.makeup); v = Math.max(-1, Math.min(1, v)); }
      y[i] = v;
    }
    const f2 = new Float32Array(this.fifo.length + B); f2.set(this.fifo); f2.set(y, this.fifo.length); this.fifo = f2; this.rendered += B;
  }
  private pull(): Float32Array { while (this.fifo.length < HOP) this.renderBlock(); const x = this.fifo.slice(0, HOP); this.fifo = this.fifo.slice(HOP); return x; }
  onFrame: ((fr: any, phase: string, hint: string | null) => void) | null = null;
  step(): any {
    const x = this.pull(); this.sa.push(x); this.n += HOP; this.fed += HOP; const tNow = this.t; const E = this.m.E;
    let v = this.s.view(); if (v.phase === 'done' || this.fed < E.FRAME_SIZE) return v;
    if (v.phase === 'listen') {
      this.left -= HOP / SR;
      if (this.stage === 'delay') {
        if (!this.wasMuted) { const fr = this.sa.frame('guitar', tNow); this.s.pitch(fr); }
        if (this.left <= 0) {
          let notes: { midi: number | number[]; sec: number }[] = v.listenKind === 'phrase' ? v.listenNotes.map((q: any) => ({ midi: q.midi, sec: Math.max(0.12, (q.beats * 60) / this.m.SONG.bpm) })) : [{ midi: v.targetMidi, sec: 0.9 }];
          if (this.env.settings?.playKeyAtStart && !this.keyDone) { this.keyDone = true; const t = 48; notes = [{ midi: t, sec: 0.32 }, { midi: t + 4, sec: 0.32 }, { midi: t + 7, sec: 0.32 }, { midi: t + 12, sec: 0.4 }, { midi: [t, t + 4, t + 7, t + 12], sec: 1.0 }, { midi: -1, sec: 0.95 }, ...notes]; }
          let tt = 0.06;
          for (const q of notes) { if (this.env.spk != null && q.midi !== -1) for (const mm of Array.isArray(q.midi) ? q.midi : [q.midi]) this.add(REF(mm, Math.max(0.2, q.sec), 450), this.env.spk + (Array.isArray(q.midi) ? -4.4 : 0), 'ref', mm, -1, tt); tt += q.sec; }
          this.stage = 'playing'; this.left = tt + 0.35 + 0.3 + 0.02; this.wasMuted = true;
        }
      } else if (this.left <= 0) { this.stage = 'none'; this.s.listenDone(tNow); this.stepT = this.t; v = this.s.view(); }
      return v;
    }
    if (this.wasMuted) { this.sa.attacks?.clear?.(); this.wasMuted = false; }
    const before = v; const fr = this.sa.frame(this.s.listeningPath(), tNow); const adv = this.s.pitch(fr);
    const h = this.s.view().match?.hint ?? null; this.onFrame?.(fr, before.phase, h);
    if (!adv && h) { const k = `${before.phase}:${h}`; this.hints[k] = (this.hints[k] ?? 0) + 1; }
    this.lastHint = h;
    if (adv) {
      const t = this.t; let legit = false; let why = ''; let lat: number | undefined;
      if (before.phase === 'sing') {
        const pc = (a: number, b: number) => Math.abs(((((a - b) % 12) + 18) % 12) - 6);
        const vi = this.voices.filter((q) => q.t1 >= this.stepT - 0.05 && q.t0 < t && t <= q.t1 + 1.2 && pc(q.midi, before.targetMidi) < 0.6).pop();
        legit = !!vi; if (vi) lat = (t - Math.max(vi.t0, this.stepT)) * 1000; else why = `sing passed with no right sung note (ringing ${this.ringing().join(',') || '-'})`;
      } else {
        const since = before.phase === 'play' ? this.stepT : this.lastAdvT;
        const lp = this.plucks.filter((q) => q.t >= since - 0.03 && q.t <= t).pop();
        legit = !!lp && lp.ok && lp.midi === before.targetMidi;
        if (legit) lat = (t - lp!.t) * 1000;
        else { const vo = this.voices.filter((q) => q.t0 <= t && q.t1 >= since - 0.3).pop(); why = lp ? `WRONG NOTE (${lp.midi - before.targetMidi} st${lp.ok ? '' : ', unintended'}) accepted ${((t - lp.t) * 1000).toFixed(0)} ms after it` : `NO PLUCK in step (voice ${vo ? vo.midi + ', ended ' + ((t - vo.t1) * 1000).toFixed(0) + ' ms ago' : '-'}; ringing ${this.ringing().join(',') || '-'})`; }
      }
      this.log.push({ t, index: before.index, phase: before.phase, pos: before.review?.pos ?? -1, target: before.targetMidi, legit, why, lat });
      this.lastAdvT = t; this.stepT = t; v = this.s.view();
      if (v.phase === 'listen') { this.stage = 'delay'; this.left = 0.7; }
    }
    return v;
  }
  run(sec: number, until?: (v: any) => boolean): any { let v = this.s.view(); const end = this.n + sec * SR; while (this.n < end) { v = this.step(); if (v.phase === 'done' || (until && until(v))) break; } return v; }
  skip() { this.s.skip(this.t); if (this.s.view().phase === 'listen') { this.stage = 'delay'; this.left = 0.3; } }
}
// ---- rooms (source: guitar on the lap; voice: mouth 35 cm above it; phone on a stand/table)
export const ROOMS: Record<string, { g: RoomP; v: RoomP } | null> = {
  dry: null,
  bedroom: { g: { L: [3.6, 3.1, 2.45], rt: 0.32, rtLow: 1.5, src: [1.5, 1.3, 0.85], mic: [1.95, 1.45, 0.7], seed: 5 }, v: { L: [3.6, 3.1, 2.45], rt: 0.32, rtLow: 1.5, src: [1.42, 1.28, 1.2], mic: [1.95, 1.45, 0.7], seed: 5 } },
  living: { g: { L: [5.1, 3.9, 2.5], rt: 0.55, rtLow: 1.4, src: [2.1, 1.4, 0.85], mic: [2.6, 1.6, 0.72], seed: 6 }, v: { L: [5.1, 3.9, 2.5], rt: 0.55, rtLow: 1.4, src: [2.02, 1.36, 1.2], mic: [2.6, 1.6, 0.72], seed: 6 } },
  live: { g: { L: [4.4, 3.3, 2.7], rt: 0.9, rtLow: 1.3, src: [1.7, 1.2, 0.85], mic: [2.4, 1.55, 0.75], seed: 7 }, v: { L: [4.4, 3.3, 2.7], rt: 0.9, rtLow: 1.3, src: [1.6, 1.15, 1.2], mic: [2.4, 1.55, 0.75], seed: 7 } },
  // bare small room, phone on a shelf 1.3 m away
  bare: { g: { L: [3.0, 2.6, 2.4], rt: 1.2, rtLow: 1.2, src: [1.0, 0.9, 0.85], mic: [2.2, 1.6, 1.1], seed: 8 }, v: { L: [3.0, 2.6, 2.4], rt: 1.2, rtLow: 1.2, src: [0.95, 0.85, 1.2], mic: [2.2, 1.6, 1.1], seed: 8 } },
};
export function envFor(room: string, extra: Env = {}): Env { const r = ROOMS[room]; return { roomG: r?.g ?? null, roomV: r?.v ?? null, spk: -22, ...extra }; }
export function sungMidi(target: number, female?: boolean): number { if (female) return target < 55 ? target + 12 : target; return target > 62 ? target - 12 : target; }
export const med = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
export const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
export { OPEN, stringFor, rng, SR, gauss };
