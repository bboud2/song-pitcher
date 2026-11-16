// Ninth review's rig, ported unchanged except for where it finds the build.
// @ts-nocheck (ported review tooling, kept as written)
// Critic-9 rig: dry events -> per-event room convolution -> streaming phone chain -> the build's StreamAnalyzer + Session,
// timed as main.ts/audio.ts time them (700 ms after an accept before the reference; reference + 0.35 s release + 0.3 s tail muted,
// no analysis while muted, attacks cleared at un-mute, listenDone 20 ms later).
import { BQ, SR, db2a, gauss, rng, guitar, GLEAD, voice, VLEAD, speech, smallSpeaker, musicBed, refTone, noiseEvent, roomIR, convolve, stringFor, mtof, type GOpts, type VOpts } from './syn9.ts';
export { SR, rng, stringFor, mtof, db2a };
// (ported: BUILD_DIR still selects another checkout; by default this repository)
const BUILD = process.env.BUILD_DIR ?? new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
export const E = await import(`${BUILD}/src/core/engine.ts`);
export const S = await import(`${BUILD}/src/core/session.ts`);
export const SET = await import(`${BUILD}/src/core/settings.ts`);
export const M = await import(`${BUILD}/src/core/matcher.ts`);
export const SONG = (await import(`${BUILD}/src/core/songs.ts`)).STAR_SPANGLED_BANNER;
export const HOP = Math.round(0.02 * SR);
const mem = new Map<string, Float32Array>();
const memo = (k: string, mk: () => Float32Array) => { let v = mem.get(k); if (!v) { if (mem.size > 700) mem.clear(); v = mk(); mem.set(k, v); } return v; };
export interface Phone { hp: number; hpQ?: number; hp2?: boolean; peaks?: [number, number, number][]; lp?: number; floorDb: number; humDb?: number; humHz?: number; agc?: boolean; gate?: boolean; clipDb?: number; }
export const PHONES: Record<string, Phone> = {
  flagship: { hp: 70, floorDb: -66 },
  midrange: { hp: 120, peaks: [[5200, 2, 4]], floorDb: -56 },
  cheap: { hp: 220, hpQ: 1.0, hp2: true, peaks: [[2800, 1.5, 8], [700, 2, -3]], floorDb: -49, clipDb: -3 },
  webrtc: { hp: 150, hp2: true, floorDb: -58, agc: true, gate: true },      // browser ignored the constraints: AGC + noise gate on
  bt: { hp: 180, hp2: true, lp: 3400, peaks: [[1500, 1.5, 4]], floorDb: -53, agc: true }, // narrow-band headset mic
  hum50: { hp: 80, floorDb: -58, humDb: -42, humHz: 50 },
  oldtab: { hp: 140, peaks: [[900, 2, -6], [3800, 3, 6]], lp: 9000, floorDb: -52 },
};
export interface Env { room: string; phone: string; seed?: number; spk?: number | null; settings?: Record<string, unknown>; bg?: { kind: 'tv' | 'tvmusic' | 'talk'; db: number; female?: boolean }; }
type Tag = 'g' | 'v' | 'x' | 'ref';
export interface Ev { buf: Float32Array; start: number; gain: number; stop: number | null; fade: number; tag: Tag; midi: number; string: number; onset: number }
export interface Adv { t: number; index: number; phase: string; pos: number; target: number; legit: boolean; why: string; lat?: number; det?: number | null; reason?: string | null; pluckMidi?: number; db?: number }
export class Rig {
  s: any; sa: any; n = 0; evs: Ev[] = []; log: Adv[] = []; env: Env; r: () => number; ph: Phone;
  hpf: BQ[]; pk: BQ[] = []; lpf: BQ[] = []; p1 = 0; p2 = 0; p3 = 0;
  agcEnv = 0; agcG = 1; gateG = 1; gateEnv = 0;
  stage: 'none' | 'delay' | 'playing' = 'none'; left = 0; wasMuted = true; fed = 0; stepT = 0; lastAdvT = 0;
  plucks: { t: number; midi: number; ok: boolean; db: number }[] = []; voices: { t0: number; t1: number; midi: number; ev: Ev }[] = []; hints: Record<string, number> = {};
  bgBuf: Float32Array | null = null; capture: Float32Array[] | null = null; onFrame: ((f: any, v: any, adv: boolean) => void) | null = null;
  constructor(env: Env) {
    this.env = env; this.r = rng((env.seed ?? 3) + 4242); this.ph = PHONES[env.phone];
    const p = this.ph; this.hpf = [new BQ('hp', p.hp, p.hpQ ?? 0.707)]; if (p.hp2) this.hpf.push(new BQ('hp', p.hp * 0.8, 0.6));
    for (const [f, q, g] of p.peaks ?? []) this.pk.push(new BQ('pk', f, q, g)); if (p.lp) this.lpf = [new BQ('lp', p.lp, 0.6), new BQ('lp', p.lp, 1.1)];
    if (env.bg) { const k = `bg:${env.bg.kind}:${env.bg.female}:${env.seed ?? 3}:${env.room}`; this.bgBuf = memo(k, () => { let b = speech(45, (env.seed ?? 3) + 50, { female: env.bg!.female }); if (env.bg!.kind === 'tvmusic') { const mb = musicBed(45, (env.seed ?? 3) + 9); for (let i = 0; i < b.length; i++) b[i] = 0.7 * b[i] + 0.9 * mb[i]; } if (env.bg!.kind !== 'talk') b = smallSpeaker(b); const ir = roomIR(env.room, 2); return ir ? convolve(b, ir) : b; }); }
    this.sa = new E.StreamAnalyzer(SR);
    this.s = new S.Session(SONG, 48, { ...SET.DEFAULT_SETTINGS, playKeyAtStart: false, ...(env.settings ?? {}) });
  }
  get t() { return this.n / SR; }
  wet(key: string, mk: () => Float32Array, variant: number): Float32Array { const ir = roomIR(this.env.room, variant); return memo(`${key}|${this.env.room}|${variant}`, () => (ir ? convolve(mk(), ir) : mk())); }
  render(): Float32Array {
    const y = new Float32Array(HOP); const n0 = this.n;
    this.evs = this.evs.filter((e) => n0 < e.start + e.buf.length && (e.stop === null || n0 < e.stop + e.fade));
    for (const e of this.evs) { for (let i = Math.max(0, e.start - n0); i < HOP; i++) { const off = n0 + i - e.start; if (off >= e.buf.length) break; let g = e.gain; if (e.stop !== null) { const past = n0 + i - e.stop; if (past > 0) { if (past >= e.fade) break; g *= 0.5 + 0.5 * Math.cos(Math.PI * past / e.fade); } } y[i] += g * e.buf[off]; } }
    if (this.bgBuf) { const g = db2a(this.env.bg!.db); const L = this.bgBuf.length; for (let i = 0; i < HOP; i++) y[i] += g * this.bgBuf[(n0 + i) % L]; }
    const p = this.ph; const fl = db2a(p.floorDb); const hum = p.humDb !== undefined ? db2a(p.humDb) : 0;
    for (let i = 0; i < HOP; i++) {
      let v = y[i];
      // room + mic self-noise: pinkish (three one-poles)
      const w = gauss(this.r); this.p1 += 0.004 * (w - this.p1); this.p2 += 0.05 * (w - this.p2); this.p3 += 0.4 * (w - this.p3); v += fl * (9 * this.p1 + 2.2 * this.p2 + 0.7 * this.p3 + 0.25 * w);
      if (hum) { const tt = (n0 + i) / SR, f = p.humHz ?? 50; v += hum * (Math.sin(6.2832 * f * tt) + 0.5 * Math.sin(6.2832 * 2 * f * tt + 0.4) + 0.7 * Math.sin(6.2832 * 3 * f * tt + 1.1) + 0.25 * Math.sin(6.2832 * 5 * f * tt + 2)); }
      for (const f of this.hpf) v = f.s(v); for (const f of this.pk) v = f.s(v); for (const f of this.lpf) v = f.s(v);
      if (p.agc || p.gate) {
        const a = Math.abs(v); this.agcEnv += (a > this.agcEnv ? 1 - Math.exp(-1 / (0.005 * SR)) : 1 - Math.exp(-1 / (0.25 * SR))) * (a - this.agcEnv); const lv = 20 * Math.log10(this.agcEnv + 1e-9);
        if (p.gate) { const tgt = lv < -48 ? db2a(-18) : 1; this.gateG += (tgt < this.gateG ? 1 - Math.exp(-1 / (0.2 * SR)) : 1 - Math.exp(-1 / (0.01 * SR))) * (tgt - this.gateG); v *= this.gateG; }
        if (p.agc) { if (lv > -50) { const want = Math.max(db2a(-10), Math.min(db2a(24), db2a(-20 - lv))); this.agcG += (want < this.agcG ? 1 - Math.exp(-1 / (0.03 * SR)) : 1 - Math.exp(-1 / (0.8 * SR))) * (want - this.agcG); } v *= this.agcG; }
      }
      if (p.clipDb !== undefined) { const c = db2a(p.clipDb); v = c * Math.tanh(v / c); }
      y[i] = Math.max(-1, Math.min(1, v));
    }
    this.capture?.push(y);
    return y;
  }
  /** 2 s of room before the session starts (the tuner screen ran before; both paths were analysed there) */
  begin(from = 0) { for (let i = 0; i < 100; i++) { const x = this.render(); this.sa.push(x); this.n += HOP; this.fed += HOP; if (this.fed >= E.FRAME_SIZE) { this.sa.frame('guitar', this.t); this.sa.frame('voice', this.t); } } this.s.start(from); this.stage = 'delay'; this.left = 0.4; this.wasMuted = false; }
  add(buf: Float32Array, gainDb: number, tag: Tag, midi: number, string = -1, delay = 0, lead = 0): Ev {
    const start = this.n + Math.round(delay * SR);
    if (string >= 0) for (const e of this.evs) if (e.tag === 'g' && e.string === string && (e.stop === null || e.stop > start)) { e.stop = start; e.fade = Math.floor(0.005 * SR); }
    const ev: Ev = { buf, start, gain: db2a(gainDb), stop: null, fade: 0, tag, midi, string, onset: start / SR + lead }; this.evs.push(ev); return ev;
  }
  pluck(o: GOpts, levelDb = -14, delay = 0, ok = true): Ev { const ev = this.add(this.wet('g' + JSON.stringify(o), () => guitar(o), 0), levelDb, 'g', o.midi + (o.cents ?? 0) / 100, o.string ?? stringFor(o.midi).s, delay, GLEAD); this.plucks.push({ t: ev.onset, midi: o.midi, ok, db: levelDb }); return ev; }
  sing(o: VOpts, levelDb = -22, delay = 0, track = true): Ev { const ev = this.add(this.wet('v' + JSON.stringify(o), () => voice(o), 1), levelDb, 'v', o.midi + (o.cents ?? 0) / 100, -1, delay, VLEAD); if (track) this.voices.push({ t0: ev.onset, t1: ev.onset + o.dur, midi: o.midi + (o.cents ?? 0) / 100, ev }); return ev; }
  noise(kind: string, seed: number, levelDb: number) { return this.add(this.wet(`x${kind}${seed}`, () => noiseEvent(kind, seed), 2), levelDb, 'x', -1); }
  raw(key: string, mk: () => Float32Array, levelDb: number, variant = 1) { return this.add(this.wet(key, mk, variant), levelDb, 'x', -1); }
  stop(ev: Ev | null, fadeMs = 70) { if (!ev) return; const at = this.n; if (ev.stop === null || ev.stop > at) { ev.stop = at; ev.fade = Math.floor(fadeMs / 1000 * SR); } for (const v of this.voices) if (v.ev === ev && v.t1 > at / SR) v.t1 = at / SR; }
  damp(ms = 50) { for (const e of this.evs) if (e.tag === 'g' && e.stop === null) { e.stop = this.n; e.fade = Math.floor(ms / 1000 * SR); } }
  ringing(): number[] { return this.evs.filter((e) => e.tag === 'g' && this.n < e.start + e.buf.length && (e.stop === null || this.n < e.stop)).map((e) => Math.round(e.midi)); }
  step(): any {
    const x = this.render(); this.sa.push(x); this.n += HOP; this.fed += HOP; const tNow = this.t;
    let v = this.s.view(); if (v.phase === 'done') return v;
    if (v.phase === 'listen') {
      this.left -= HOP / SR;
      if (this.stage === 'delay') {
        if (!this.wasMuted) { const fr = this.sa.frame(this.s.listeningPath(), tNow); this.s.pitch(fr); }
        if (this.left <= 0) {
          const notes: { midi: number; sec: number }[] = v.listenKind === 'phrase' ? v.listenNotes.map((q: any) => ({ midi: q.midi, sec: Math.max(0.12, (q.beats * 60) / SONG.bpm) })) : [{ midi: v.targetMidi, sec: 0.9 }];
          let tt = 0.06; for (const q of notes) { if (this.env.spk != null) { const d = Math.max(0.2, q.sec); this.add(this.wet(`ref${q.midi}:${d}`, () => refTone(q.midi, d), 3), this.env.spk, 'ref', q.midi, -1, tt); } tt += q.sec; }
          this.stage = 'playing'; this.left = tt + 0.35 + 0.3 + 0.02; this.wasMuted = true;
        }
      } else if (this.left <= 0) { this.stage = 'none'; this.s.listenDone(tNow); this.stepT = this.t; v = this.s.view(); }
      return v;
    }
    if (this.wasMuted) { this.sa.attacks?.clear?.(); this.wasMuted = false; }
    const before = v; const fr = this.sa.frame(this.s.listeningPath(), tNow); const adv = this.s.pitch(fr);
    const h = this.s.view().match?.hint ?? null; if (!adv && h) { const k = `${before.phase}:${h}`; this.hints[k] = (this.hints[k] ?? 0) + 1; }
    this.onFrame?.(fr, before, adv);
    if (adv) {
      const t = this.t; let legit = false; let why = ''; let lat: number | undefined; let pluckMidi: number | undefined; let pdb: number | undefined;
      const acc = this.s.lastAccepted;
      if (before.phase === 'sing') {
        const exact = !!(this.env.settings as any)?.singExactOctave;
        const pc = (a: number, b: number) => exact ? Math.abs(a - b) : Math.abs(((((a - b) % 12) + 18) % 12) - 6);
        const vi = this.voices.filter((q) => q.t1 >= this.stepT - 0.05 && q.t0 < t && t <= q.t1 + 1.0 && pc(q.midi, before.targetMidi) < 0.65).pop();
        legit = !!vi; if (vi) lat = (t - Math.max(vi.t0, this.stepT)) * 1000; else { const vo = this.voices.filter((q) => q.t0 < t && t <= q.t1 + 1.0).pop(); why = `sing passed with no right sung note (voice ${vo ? vo.midi.toFixed(2) : '-'}; ringing ${this.ringing().join(',') || '-'}; det ${acc?.detectedMidi?.toFixed?.(2)})`; }
      } else {
        const since = before.phase === 'play' ? this.stepT : this.lastAdvT;
        const lp = this.plucks.filter((q) => q.t >= since - 0.03 && q.t <= t).pop();
        legit = !!lp && lp.ok && lp.midi === before.targetMidi; pluckMidi = lp?.midi; pdb = lp?.db;
        if (legit) lat = (t - lp!.t) * 1000;
        else { const vo = this.voices.filter((q) => q.t0 <= t && q.t1 >= since - 0.3).pop(); why = lp ? `WRONG NOTE (${lp.midi - before.targetMidi} st${lp.ok ? '' : ', hunting'}) accepted ${((t - lp.t) * 1000).toFixed(0)} ms after it` : `NO PLUCK in step (voice ${vo ? vo.midi.toFixed(1) + ', ended ' + ((t - vo.t1) * 1000).toFixed(0) + ' ms ago' : '-'}; ringing ${this.ringing().join(',') || '-'})`; }
      }
      this.log.push({ t, index: before.index, phase: before.phase, pos: before.review?.pos ?? -1, target: before.targetMidi, legit, why, lat, det: acc?.detectedMidi ?? null, reason: acc?.reason ?? null, pluckMidi, db: pdb });
      this.lastAdvT = t; this.stepT = t; v = this.s.view();
      if (v.phase === 'listen') { this.stage = 'delay'; this.left = 0.7; }
    }
    return v;
  }
  skip() { this.s.skip(this.t); this.stepT = this.t; this.lastAdvT = this.t; if (this.s.view().phase === 'listen') { this.stage = 'delay'; this.left = 0.3; } }
  /** run until predicate or timeout; returns view */
  run(sec: number, until?: (v: any) => boolean, each?: () => void): any { const end = this.t + sec; let v = this.s.view(); while (this.t < end) { each?.(); v = this.step(); if (v.phase === 'done' || (until && until(v))) break; } return v; }
}
export const med = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
export const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
export { speech, noiseEvent, voice, guitar, refTone, musicBed, smallSpeaker };
