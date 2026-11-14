// Ported from the fifth external review (read-only original), kept as a permanent test.
// Critic-5 rig: mixer + room + phone chain driving the real StreamAnalyzer + Session with main.ts timing.
import { BQ, SR, db2a, gauss, guitar, makeRoom, makeRoomISM, pinkGen, refTone, reverb, rng, stringFor, voice, VOICE_LEAD, type GOpts, type Room, type VOpts } from './synth5.ts';
import * as E from '../../src/core/engine.ts';
import * as S from '../../src/core/session.ts';
import * as SET from '../../src/core/settings.ts';
import * as SONGS from '../../src/core/songs.ts';
export const SONG = SONGS.STAR_SPANGLED_BANNER;
export const { FRAME_SIZE, StreamAnalyzer } = E;

export interface Env {
  seed?: number; floorDb?: number; room?: { drr: number; rt: number } | { ism: number; alpha?: number } | null;
  hpHz?: number; lpHz?: number; ns?: boolean;
  agc?: { downDbS: number; upDbS: number; target: number; max: number };
  comp?: { thDb: number; ratio: number; attMs: number };
  fanDb?: number; refLeakDb?: number | null; zeroUntil?: number; zeroFrameAt?: number; settings?: Record<string, unknown>;
}
interface Ev { buf: Float32Array; start: number; gain: number; stop: number | null; fade: number; tag: 'g' | 'v' | 'x' | 'ref'; midi: number; string: number; onset: number }
export interface Adv { t: number; index: number; phase: string; pos: number; target: number; legit: boolean; why: string; lat?: number }

export class Rig {
  s: any; sa: any; n = 0; evs: Ev[] = []; log: Adv[] = []; env: Env; r: () => number; room: Room | null;
  private pink: () => number; private pinkG: number; private stage: 'none' | 'delay' | 'playing' = 'none'; private left = 0;
  private hp: BQ | null; private lp: BQ[] | null; private agcG = 0; private agcE = 0; private cE = 0;
  private nsB: { f: BQ[]; e: number; nf: number; g: number }[] = []; private fan = [0, 0];
  stepT = 0; lastAdvT = 0; plucks: { t: number; midi: number }[] = []; voices: { t0: number; t1: number | null; midi: number; ev: Ev }[] = [];
  hints: Record<string, number> = {}; onFrame: ((phase: string, hint: string | null, v: any) => void) | null = null;
  cache = new Map<string, Float32Array>();

  constructor(env: Env = {}) {
    this.env = env; this.r = rng(env.seed ?? 11); this.pink = pinkGen((env.seed ?? 11) + 5);
    let e = 0; const p = pinkGen(99); for (let i = 0; i < 48000; i++) { const x = p(); e += x * x; } this.pinkG = 1 / Math.sqrt(e / 48000);
    this.room = env.room ? ('ism' in env.room ? makeRoomISM(env.room.ism, undefined, env.room.alpha ?? 0.3, (env.seed ?? 11) + 3) : makeRoom(env.room.drr, env.room.rt, (env.seed ?? 11) + 3)) : null;
    this.sa = new StreamAnalyzer(SR);
    this.s = new S.Session(SONG, 48, { ...SET.DEFAULT_SETTINGS, playKeyAtStart: false, ...(env.settings ?? {}) });
    this.hp = env.hpHz ? new BQ('hp', env.hpHz, 0.707) : null;
    this.lp = env.lpHz ? [new BQ('lp', env.lpHz, 0.54), new BQ('lp', env.lpHz, 1.3)] : null;
    if (env.ns) for (const [a, b] of [[0, 300], [300, 1000], [1000, 3000], [3000, 0]]) this.nsB.push({ f: [...(a ? [new BQ('hp', a, 0.707)] : []), ...(b ? [new BQ('lp', b, 0.707)] : [])], e: 0, nf: 1e-9, g: 1 });
  }
  get t() { return this.n / SR; }
  begin(from = 0) { this.s.start(from); this.stage = 'delay'; this.left = 0.4; }

  add(buf: Float32Array, gainDb: number, tag: Ev['tag'], midi: number, string = -1, offset = 0, onsetLead = 0): Ev {
    const start = this.n + offset;
    if (string >= 0) for (const e of this.evs) if (e.string === string && e.stop === null) { e.stop = start; e.fade = Math.floor(0.008 * SR); }
    const ev: Ev = { buf, start, gain: db2a(gainDb), stop: null, fade: 0, tag, midi, string, onset: (start + onsetLead * SR) / SR };
    this.evs.push(ev); return ev;
  }
  /** pluck a guitar note (cached synthesis incl. room) */
  pluck(o: GOpts, levelDb = -14, offset = 0, string?: number): Ev {
    const key = JSON.stringify({ ...o, semis: o.semis ? [0, 0.02, 0.04, 0.07, 0.09, 0.12, 0.2, 0.3, 0.45, 1].map(o.semis) : 0 });
    let b = this.cache.get(key); if (!b) { b = reverb(guitar(o), this.room); this.cache.set(key, b); }
    const ev = this.add(b, levelDb, 'g', o.midi, string ?? stringFor(o.midi).s, offset, 0.003);
    this.plucks.push({ t: ev.onset, midi: o.midi + (o.semis ? Math.round(o.semis(1)) : 0) }); return ev;
  }
  sing(o: VOpts, levelDb = -28, offset = 0): Ev {
    const ev = this.add(reverb(voice(o), this.room), levelDb, 'v', o.midi, -1, offset, VOICE_LEAD);
    this.voices.push({ t0: ev.onset, t1: ev.onset + o.dur, midi: o.midi, ev }); return ev;
  }
  stop(ev: Ev, fadeMs = 60) { if (ev.stop === null) { ev.stop = this.n; ev.fade = Math.floor((fadeMs / 1000) * SR); } for (const v of this.voices) if (v.ev === ev && (v.t1 === null || v.t1 > this.t)) v.t1 = this.t; }
  damp() { for (const e of this.evs) if (e.tag === 'g' && e.stop === null) { e.stop = this.n; e.fade = Math.floor(0.05 * SR); } }
  voiceOnAt(t: number): { midi: number } | null { for (const v of this.voices) if (t >= v.t0 && (v.t1 === null || t <= v.t1 + 0.3)) return v; return null; }
  ringing(): number[] { return this.evs.filter((e) => e.tag === 'g' && this.n < e.start + e.buf.length && (e.stop === null || this.n < e.stop)).map((e) => e.midi); }

  private render(len: number): Float32Array {
    const x = new Float32Array(len); const env = this.env;
    this.evs = this.evs.filter((e) => this.n < e.start + e.buf.length && (e.stop === null || this.n < e.stop + e.fade));
    for (const e of this.evs) {
      for (let i = Math.max(0, e.start - this.n); i < len; i++) {
        const off = this.n + i - e.start; if (off >= e.buf.length) break;
        let g = e.gain; if (e.stop !== null) { const past = this.n + i - e.stop; if (past > 0) g *= Math.max(0, 1 - past / Math.max(1, e.fade)); }
        x[i] += g * e.buf[off];
      }
    }
    const fl = db2a(env.floorDb ?? -62) * this.pinkG;
    for (let i = 0; i < len; i++) x[i] += fl * this.pink();
    if (env.fanDb !== undefined) { const a = db2a(env.fanDb); for (let i = 0; i < len; i++) { const tt = (this.n + i) / SR; this.fan[0] += 0.02 * (gauss(this.r) - this.fan[0]); this.fan[1] += 0.02 * (this.fan[0] - this.fan[1]); x[i] += a * (14 * this.fan[1] + 0.6 * Math.sin(2 * Math.PI * 97 * tt) + 0.3 * Math.sin(2 * Math.PI * 194 * tt + 1)); } }
    if (this.hp) for (let i = 0; i < len; i++) x[i] = this.hp.s(x[i]);
    if (this.lp) for (let i = 0; i < len; i++) x[i] = this.lp[1].s(this.lp[0].s(x[i]));
    if (this.nsB.length) {
      const ka = Math.exp(-1 / (0.002 * SR)), kr = Math.exp(-1 / (0.05 * SR)), go = 1 - Math.exp(-1 / (0.004 * SR)), gc = 1 - Math.exp(-1 / (0.08 * SR));
      for (let i = 0; i < len; i++) {
        let y = 0;
        for (const b of this.nsB) {
          let v = x[i]; for (const f of b.f) v = f.s(v);
          const p = v * v; b.e = p > b.e ? ka * b.e + (1 - ka) * p : kr * b.e + (1 - kr) * p;
          b.nf = b.e < b.nf ? b.e : b.nf * (1 + 0.7 / SR); // floor follows minima, creeps up ~3 dB/s
          const snr = b.e / (b.nf * 6); const tg = Math.max(0.18, Math.min(1, snr));
          b.g += (tg > b.g ? go : gc) * (tg - b.g);
          y += b.g * v;
        }
        x[i] = y;
      }
    }
    if (env.comp) {
      const ka = Math.exp(-1 / ((env.comp.attMs / 1000) * SR)), kr = Math.exp(-1 / (0.15 * SR));
      for (let i = 0; i < len; i++) { const p = x[i] * x[i]; this.cE = p > this.cE ? ka * this.cE + (1 - ka) * p : kr * this.cE + (1 - kr) * p; const over = 10 * Math.log10(this.cE + 1e-14) - env.comp.thDb; if (over > 0) x[i] *= db2a(-over * (1 - 1 / env.comp.ratio)); }
    }
    if (env.agc) {
      const k = Math.exp(-1 / (0.01 * SR)); const a = env.agc;
      for (let i = 0; i < len; i++) {
        this.agcE = k * this.agcE + (1 - k) * x[i] * x[i];
        const lvl = 10 * Math.log10(this.agcE + 1e-14) + this.agcG;
        if (lvl > a.target) this.agcG -= a.downDbS / SR; else if (lvl > a.target - 40) this.agcG += a.upDbS / SR;
        this.agcG = Math.max(-20, Math.min(a.max, this.agcG));
        x[i] = Math.tanh(x[i] * db2a(this.agcG) / 0.9) * 0.9;
      }
    }
    if (env.zeroUntil && this.n < env.zeroUntil * SR) x.fill(0);
    if (env.zeroFrameAt !== undefined && Math.abs(this.n - env.zeroFrameAt * SR) < 480) x.fill(0);
    return x;
  }

  step(): any {
    const dt = 960; const x = this.render(dt); this.sa.push(x); this.n += dt; const tNow = this.t;
    let v = this.s.view();
    if (v.phase === 'done' || this.n < FRAME_SIZE) return v;
    if (v.phase === 'listen') {
      this.left -= dt / SR;
      if (this.stage === 'delay') {
        this.sa.frame('guitar', tNow);
        if (this.left <= 0) {
          const notes = v.listenKind === 'phrase' ? v.listenNotes.map((q: any) => ({ midi: q.midi, sec: Math.max(0.12, (q.beats * 60) / SONG.bpm) })) : [{ midi: v.targetMidi, sec: 0.9 }];
          let tt = 0.06; for (const q of notes) { if (this.env.refLeakDb !== null) this.add(reverb(refTone(q.midi, Math.max(0.2, q.sec)), this.room), this.env.refLeakDb ?? -14, 'ref', q.midi, -1, Math.round(tt * SR)); tt += q.sec; }
          this.stage = 'playing'; this.left = tt + 0.35 + 0.3 + 0.02;
        }
      } else if (this.left <= 0) { this.stage = 'none'; this.sa.attacks?.clear?.(); this.s.listenDone(tNow); this.stepT = this.t; v = this.s.view(); }
      return v;
    }
    const before = v;
    const fr = this.sa.frame(this.s.listeningPath(), tNow);
    const adv = this.s.pitch(fr);
    const h = this.s.view().match?.hint ?? null;
    if (!adv) {
      if (h) {
        const k = `${before.phase}:${h}`; this.hints[k] = (this.hints[k] ?? 0) + 1;
        const t = this.t; const vOn = this.voices.find((q) => t >= q.t0 + 0.3 && (q.t1 === null || t <= q.t1)); const vRecent = this.voices.some((q) => t >= q.t0 && (q.t1 === null || t <= q.t1 + 0.6));
        const lp = this.plucks.filter((q) => q.t >= this.stepT - 0.03 && q.t <= t).pop();
        let f = '';
        if (before.phase === 'sing' && h === 'carryOver' && vOn) f = 'FALSE sing:"guitar still ringing" over a real singer';
        if (before.phase === 'sing' && (h === 'tooShort' || h === 'unclear') && this.voices.find((q) => t >= q.t0 + 0.8 && (q.t1 === null || t <= q.t1))) f = `FALSE sing:${h} while a note is held`;
        if (before.phase === 'play' && (h === 'singing' || h === 'voiceLike') && !vRecent && lp) f = `FALSE play:${h} after a real pluck, no voice`;
        if (before.phase === 'play' && (h === 'octaveHigh' || h === 'octaveLow') && lp && lp.midi === before.targetMidi) f = `FALSE play:${h} on the right note`;
        if (before.phase === 'play' && h === 'ringing' && !this.ringing().length) f = 'FALSE play:ringing with no string sounding';
        if (f) this.hints[f] = (this.hints[f] ?? 0) + 1;
      }
      this.onFrame?.(before.phase, h, this.s.view());
    }
    if (adv) {
      const t = this.t; let legit = false; let why = ''; let lat: number | undefined;
      if (before.phase === 'sing') {
        const pc = (a: number, b: number) => Math.abs(((((a - b) % 12) + 18) % 12) - 6);
        const vi = this.voices.filter((q) => q.t0 >= this.stepT - 0.05 && q.t0 < t && (q.t1 === null || t <= q.t1 + 0.35) && pc(q.midi, before.targetMidi) < 0.6).pop();
        legit = !!vi; if (vi) lat = (t - vi.t0) * 1000; else why = `sing step passed without a right sung note this step (ringing ${this.ringing().join(',') || '-'}; voice ${this.voiceOnAt(t)?.midi ?? '-'})`;
      } else {
        const since = before.phase === 'play' ? this.stepT : this.lastAdvT;
        const lp = this.plucks.filter((q) => q.t >= since - 0.03 && q.t <= t).pop();
        legit = !!lp && lp.midi === before.targetMidi;
        if (legit) lat = (t - lp!.t) * 1000;
        else why = lp ? `WRONG NOTE ${lp.midi - before.targetMidi} st accepted ${((t - lp.t) * 1000).toFixed(0)} ms after it` : `no pluck in this step (ringing ${this.ringing().join(',') || '-'}; voice ${this.voiceOnAt(t)?.midi ?? '-'})`;
      }
      this.log.push({ t, index: before.index, phase: before.phase, pos: before.review?.pos ?? -1, target: before.targetMidi, legit, why, lat });
      this.lastAdvT = t; this.stepT = t;
      v = this.s.view();
      if (v.phase === 'listen') { this.stage = 'delay'; this.left = 0.7; }
    }
    return v;
  }
  run(sec: number, until?: (v: any) => boolean): any { let v = this.s.view(); const end = this.n + sec * SR; while (this.n < end) { v = this.step(); if (v.phase === 'done' || (until && until(v))) break; } return v; }
  skip() { this.s.skip(); if (this.s.view().phase === 'listen') { this.stage = 'delay'; this.left = 0.3; } }
}

// ------------------------------------------------------------------ honest student
export interface Style {
  name: string; env?: Env; female?: boolean;
  g?: (midi: number, r: () => number) => Partial<GOpts>; gLevel?: [number, number];
  v?: (midi: number, r: () => number) => Partial<VOpts>; vLevel?: [number, number];
  cents?: (midi: number, r: () => number) => number; variants?: number;
  think?: [number, number]; react?: [number, number]; hold?: [number, number]; pause?: [number, number];
  ring?: boolean; reviewIOI?: [number, number]; maxNotes?: number; from?: number; noteDur?: number;
}
export interface Res { name: string; notes: number; playSteps: number; firstPluck: number; replucks: number; playStuck: number; singSteps: number; singFirst: number; singStuck: number; revNotes: number; revFirst: number; revStuck: number; bad: Adv[]; lat: number[]; singLat: number[]; revLat: number[]; hints: Record<string, number>; simSec: number; stuckAt: string[] }
const u = (r: () => number, [a, b]: [number, number]) => a + (b - a) * r();
export function sungMidi(target: number, female?: boolean): number { if (female) return target < 55 ? target + 12 : target; return target > 64 ? target - 12 : target; }

export function honest(st: Style): Res {
  const rig = new Rig(st.env ?? {}); const r = rng((st.env?.seed ?? 11) * 7 + 1);
  const res: Res = { name: st.name, notes: 0, playSteps: 0, firstPluck: 0, replucks: 0, playStuck: 0, singSteps: 0, singFirst: 0, singStuck: 0, revNotes: 0, revFirst: 0, revStuck: 0, bad: [], lat: [], singLat: [], revLat: [], hints: {}, simSec: 0, stuckAt: [] };
  const gopts = (midi: number): GOpts => { const k = Math.floor(r() * (st.variants ?? 3)); const rr = rng(midi * 31 + k); return { midi, seed: midi * 31 + k, dur: st.noteDur ?? 3.2, cents: st.cents ? Math.round(st.cents(midi, rr)) : Math.round(5 * gauss(rr)), ...(st.g ? st.g(midi, rr) : {}) }; };
  const doPluck = (midi: number) => rig.pluck(gopts(midi), u(r, st.gLevel ?? [-18, -10]), Math.floor(r() * 960));
  rig.begin(st.from ?? 0);
  let voiceEv: any = null; let voiceStopAt = Infinity;
  const tick = (sec: number, until?: (v: any) => boolean) => { // run, honouring a scheduled voice stop
    const end = rig.t + sec; let v = rig.s.view();
    while (rig.t < end) { if (voiceEv && rig.t >= voiceStopAt) { rig.stop(voiceEv, 60); voiceEv = null; voiceStopAt = Infinity; } v = rig.step(); if (v.phase === 'done' || (until && until(v))) break; }
    return v;
  };
  for (;;) {
    let v = tick(60, (q) => q.phase !== 'listen');
    if (v.phase === 'done') break;
    const idx = v.index; const target = v.targetMidi;
    if (st.maxNotes && idx - (st.from ?? 0) >= st.maxNotes) break;
    if (v.phase === 'sing') {
      res.singSteps++;
      v = tick(u(r, st.think ?? st.react ?? [0.4, 1.0]), (q) => q.phase !== 'sing');
      let ok = v.phase !== 'sing';
      for (let a = 0; a < 3 && !ok; a++) {
        const sm = sungMidi(target, st.female);
        const vo: VOpts = { midi: sm, dur: 5.6, female: st.female, seed: idx * 13 + a, vibCents: 0, scoop: 40 * r(), ...(st.v ? st.v(sm, r) : {}) };
        voiceEv = rig.sing(vo, u(r, st.vLevel ?? [-30, -24]), Math.floor(r() * 960)); voiceStopAt = Infinity;
        v = tick(5, (q) => q.phase !== 'sing');
        if (v.phase !== 'sing') { ok = true; if (a === 0) res.singFirst++; break; }
        rig.stop(voiceEv, 60); voiceEv = null; v = tick(0.8, (q) => q.phase !== 'sing'); if (v.phase !== 'sing') ok = true;
      }
      if (!ok) { res.singStuck++; res.stuckAt.push(`sing#${idx + 1}`); rig.skip(); continue; }
      if (voiceEv) voiceStopAt = rig.t + u(r, st.hold ?? [0.05, 0.4]);
    }
    v = rig.s.view();
    if (v.phase === 'play' && v.index === idx) {
      res.playSteps++;
      const pause = u(r, st.pause ?? [0.4, 1.2]);
      v = tick(Math.max(0.02, (voiceStopAt === Infinity ? 0 : voiceStopAt - rig.t) + pause), (q) => q.phase !== 'play');
      let ok = v.phase !== 'play'; let k = 0;
      for (; k < 5 && !ok; k++) { doPluck(target); v = tick(2.5, (q) => q.phase !== 'play'); if (v.phase !== 'play') ok = true; }
      if (ok && k === 1) res.firstPluck++;
      if (ok && k > 1) res.replucks += k - 1;
      if (!ok) { res.playStuck++; res.stuckAt.push(`play#${idx + 1}(${target})`); rig.skip(); continue; }
    }
    v = rig.s.view();
    if (v.phase === 'review' && v.index === idx) {
      v = tick(u(r, [0.5, 1.0]), (q) => q.phase !== 'review');
      let stuck = false;
      while (v.phase === 'review' && v.index === idx && !stuck) {
        const pos = v.review.pos; const tgt = v.targetMidi; res.revNotes++;
        let k = 0; let ok = false;
        for (; k < 5 && !ok; k++) { doPluck(tgt); v = tick(2.5, (q) => q.phase !== 'review' || q.index !== idx || q.review.pos !== pos); ok = v.phase !== 'review' || v.index !== idx || v.review.pos !== pos; }
        if (ok && k === 1) res.revFirst++;
        if (!ok) { res.revStuck++; res.stuckAt.push(`review#${idx + 1}pos${pos}(${tgt})`); rig.skip(); stuck = true; break; }
        if (v.phase === 'review' && v.index === idx) v = tick(u(r, st.reviewIOI ?? [0.35, 0.6]) - 0.02, (q) => q.phase !== 'review' || q.index !== idx || q.review.pos !== v.review.pos);
      }
    }
    if (!st.ring) rig.damp();
    res.notes++;
  }
  for (const a of rig.log) { if (!a.legit) res.bad.push(a); else if (a.lat !== undefined) (a.phase === 'play' ? res.lat : a.phase === 'sing' ? res.singLat : res.revLat).push(a.lat); }
  res.hints = rig.hints; res.simSec = rig.t;
  return res;
}
export const med = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
export const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
export function line(r: Res): string {
  return `${r.name.padEnd(34)} play ${r.firstPluck}/${r.playSteps} first, +${r.replucks} repl, ${r.playStuck} stuck | sing ${r.singFirst}/${r.singSteps} first, ${r.singStuck} stuck | review ${r.revFirst}/${r.revNotes} first, ${r.revStuck} stuck | BAD ${r.bad.length} | lat med ${med(r.lat).toFixed(0)} p90 ${pct(r.lat, 0.9).toFixed(0)} rev ${med(r.revLat).toFixed(0)} sing ${med(r.singLat).toFixed(0)} | ${(r.simSec / 60).toFixed(1)} min`;
}
