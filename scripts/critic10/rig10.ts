// Tenth review (ported unchanged except for where it finds the build).
// @ts-nocheck (ported review tooling, kept as written)
// Critic-10 rig: own mixer + room + phone chain, driving the build's StreamAnalyzer + Session with the
// timing of src/main.ts + src/ui/audio.ts (verified by reading them at 59f3f12):
//  accept -> 700 ms (frames still analysed on the guitar path, session ignores them) -> reference starts 60 ms later,
//  frames dropped until notes + 0.35 + 0.3 s + 20 ms, attacks.clear() on the first frame after, listenDone at that moment.
import { BQ, SR, db2a, gauss, rng, guitar, G_LEAD, voice, V_LEAD, refTone, roomIR, convolve, stringFor, type GOpts, type VOpts } from './syn10.ts';
export * from './syn10.ts';
// (ported: BUILD_DIR still selects another checkout; by default this repository)
const BUILD = process.env.BUILD_DIR ?? new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
export const E = await import(`${BUILD}/src/core/engine.ts`);
export const S = await import(`${BUILD}/src/core/session.ts`);
export const SET = await import(`${BUILD}/src/core/settings.ts`);
export const SONG = (await import(`${BUILD}/src/core/songs.ts`)).STAR_SPANGLED_BANNER;
export const HOP = Math.round(0.02 * SR);
export interface Phone { hp: number; floorDb: number; agc?: boolean }
export interface Env { room: string; seed?: number; spkDb?: number | null; spkNear?: boolean; phone?: Phone; settings?: Record<string, unknown> }
export interface Ev { buf: Float32Array; start: number; gain: number; stop: number | null; fade: number; tag: string; string: number; midi: number }
const memo = new Map<string, Float32Array>();
export class Rig {
  s: any; sa: any; n = 0; evs: Ev[] = []; env: Env; r: () => number; ph: Phone; hpf: BQ[]; p1 = 0; p2 = 0; agcEnv = 0; agcG = 1;
  stage: 'none' | 'delay' | 'playing' = 'none'; left = 0; muteEnd = 0; wasMuted = false; fed = 0;
  openT = 0; refStart = 0; refDur = 0; advs: { t: number; phase: string; index: number; pos: number; target: number; det: number | null; reason: string | null }[] = [];
  hints: string[] = []; onRef: ((refStart: number, openT: number) => void) | null = null; onOpen: ((v: any) => void) | null = null; capture: Float32Array[] | null = null; trace: ((fr: any, v: any) => void) | null = null;
  constructor(env: Env) {
    this.env = env; this.r = rng((env.seed ?? 1) + 99); this.ph = env.phone ?? { hp: 110, floorDb: -62 };
    this.hpf = [new BQ('hp', this.ph.hp, 0.707)];
    this.sa = new E.StreamAnalyzer(SR);
    this.s = new S.Session(SONG, 48, { ...SET.DEFAULT_SETTINGS, playKeyAtStart: false, ...(env.settings ?? {}) });
  }
  get t() { return this.n / SR; }
  wet(key: string, mk: () => Float32Array, variant: number, extraDrr = 0): Float32Array {
    const k = `${key}|${this.env.room}|${variant}|${extraDrr}`; let v = memo.get(k);
    if (!v) { if (memo.size > 400) memo.clear(); const ir = roomIR(this.env.room, variant, extraDrr); v = ir ? convolve(mk(), ir) : mk(); memo.set(k, v); } return v;
  }
  /** at = absolute time (s) of the buffer's first sample */
  add(buf: Float32Array, at: number, gainDb: number, tag: string, string = -1, midi = -1): Ev {
    const ev: Ev = { buf, start: Math.round(at * SR), gain: db2a(gainDb), stop: null, fade: 0, tag, string, midi }; this.evs.push(ev); return ev;
  }
  /** pluck with onset at absolute time `at`; a pluck on the same string cuts the note sounding on it */
  pluck(o: GOpts, at: number, levelDb = -14, string?: number): Ev {
    const st = string ?? stringFor(o.midi); const start = at - G_LEAD;
    for (const e of this.evs) if (e.tag === 'g' && e.string === st && (e.stop === null || e.stop > start * SR)) { e.stop = Math.round((start - 0.012) * SR); e.fade = Math.floor(0.012 * SR); }
    return this.add(this.wet('g' + JSON.stringify(o), () => guitar(o), 0), start, levelDb, 'g', st, o.midi);
  }
  sing(o: VOpts, at: number, levelDb = -24): Ev { return this.add(this.wet('v' + JSON.stringify(o), () => voice(o), 1), at - V_LEAD, levelDb, 'v', -1, o.midi); }
  raw(key: string, mk: () => Float32Array, at: number, levelDb: number, variant = 2): Ev { return this.add(this.wet(key, mk, variant), at, levelDb, 'x'); }
  stop(ev: Ev, at: number, fadeMs = 60) { const a = Math.round(at * SR); if (ev.stop === null || ev.stop > a) { ev.stop = a; ev.fade = Math.floor(fadeMs / 1000 * SR); } }
  damp(at: number, ms = 40) { for (const e of this.evs) if (e.tag === 'g') this.stop(e, at, ms); }
  render(): Float32Array {
    const y = new Float32Array(HOP); const n0 = this.n;
    this.evs = this.evs.filter((e) => n0 < e.start + e.buf.length && (e.stop === null || n0 < e.stop + e.fade));
    for (const e of this.evs) for (let i = Math.max(0, e.start - n0); i < HOP; i++) { const off = n0 + i - e.start; if (off >= e.buf.length) break; let g = e.gain; if (e.stop !== null) { const past = n0 + i - e.stop; if (past > 0) { if (past >= e.fade) break; g *= 0.5 + 0.5 * Math.cos(Math.PI * past / e.fade); } } y[i] += g * e.buf[off]; }
    const fl = db2a(this.ph.floorDb);
    for (let i = 0; i < HOP; i++) {
      let v = y[i]; const w = gauss(this.r); this.p1 += 0.01 * (w - this.p1); this.p2 += 0.12 * (w - this.p2); v += fl * (6 * this.p1 + 1.6 * this.p2 + 0.5 * w);
      for (const f of this.hpf) v = f.s(v);
      if (this.ph.agc) { const a = Math.abs(v); this.agcEnv += (a > this.agcEnv ? 1 - Math.exp(-1 / (0.004 * SR)) : 1 - Math.exp(-1 / (0.2 * SR))) * (a - this.agcEnv); const lv = 20 * Math.log10(this.agcEnv + 1e-9); if (lv > -52) { const want = Math.max(db2a(-12), Math.min(db2a(26), db2a(-18 - lv))); this.agcG += (want < this.agcG ? 1 - Math.exp(-1 / (0.025 * SR)) : 1 - Math.exp(-1 / (0.7 * SR))) * (want - this.agcG); } v *= this.agcG; }
      y[i] = Math.max(-1, Math.min(1, v));
    }
    this.capture?.push(y); return y;
  }
  begin(from = 0) { for (let i = 0; i < 100; i++) { this.sa.push(this.render()); this.n += HOP; this.fed += HOP; if (this.fed >= E.FRAME_SIZE) { this.sa.frame('voice', this.t); this.sa.frame('guitar', this.t); } } this.s.start(from); this.stage = 'delay'; this.left = 0.4; }
  tick(): boolean {
    this.sa.push(this.render()); this.n += HOP; const t = this.t; let v = this.s.view(); if (v.phase === 'done') return false;
    if (v.phase === 'listen') {
      if (this.stage === 'delay') {
        this.left -= HOP / SR; const fr = this.sa.frame(this.s.listeningPath(), t); this.s.pitch(fr);
        if (this.left <= 0) {
          const notes: { midi: number; sec: number }[] = v.listenKind === 'phrase' ? v.listenNotes.map((q: any) => ({ midi: q.midi, sec: Math.max(0.12, (q.beats * 60) / SONG.bpm) })) : [{ midi: v.targetMidi, sec: 0.9 }];
          let tt = t + 0.06; this.refStart = tt;
          for (const q of notes) { if (this.env.spkDb != null) { const d = Math.max(0.2, q.sec); const near = this.env.spkNear !== false; this.add(this.wet(`ref${q.midi}:${d}:${near}`, () => refTone(q.midi, d, near), 3, near ? 20 : 0), tt, this.env.spkDb, 'ref'); } tt += q.sec; }
          this.refDur = tt - this.refStart; this.muteEnd = tt + 0.35 + 0.3 + 0.02; this.stage = 'playing'; this.onRef?.(this.refStart, this.muteEnd);
        }
      } else if (t >= this.muteEnd - 1e-9) { this.stage = 'none'; this.wasMuted = true; this.s.listenDone(t); this.openT = t; this.hints = []; this.onOpen?.(this.s.view()); }
      return false;
    }
    if (this.wasMuted) { this.sa.attacks.clear(); this.wasMuted = false; }
    const fr = this.sa.frame(this.s.listeningPath(), t); const adv = this.s.pitch(fr);
    const h = this.s.view().match?.hint; if (!adv && h && this.hints[this.hints.length - 1] !== h) this.hints.push(h);
    this.trace?.(fr, v);
    if (adv) {
      const a = this.s.lastAccepted; this.advs.push({ t, phase: v.phase, index: v.index, pos: v.review?.pos ?? -1, target: v.targetMidi, det: a?.detectedMidi ?? null, reason: a?.reason ?? null });
      const nv = this.s.view(); if (nv.phase === 'listen') { this.stage = 'delay'; this.left = 0.7; } else { this.openT = t; if (nv.phase !== v.phase) this.hints = []; }
    }
    return adv;
  }
  /** run until time `until` (absolute) or `stopIf` */
  run(until: number, stopIf?: () => boolean): void { while (this.t < until) { this.tick(); if (stopIf?.() || this.s.view().phase === 'done') break; } }
  phase(): string { return this.s.view().phase; }
  wav(path: string, fs: any) { const all = this.capture!; const n = all.length * HOP; const b = Buffer.alloc(44 + 2 * n); b.write('RIFF', 0); b.writeUInt32LE(36 + 2 * n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(2 * SR, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(2 * n, 40); let o = 44; for (const c of all) for (let i = 0; i < HOP; i++) { b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, c[i])) * 32767), o); o += 2; } fs.writeFileSync(path, b); }
}
export const MIDIS: number[] = SONG.notes.map((q: any) => 48 + q.offset);
/** the voice's octave for a target (a man: C3..D4 as written, above that an octave down) */
export const manMidi = (m: number) => (m > 62 ? m - 12 : m);
export const womanMidi = (m: number) => (m < 55 ? m + 12 : m);
/** play one whole note honestly (sing after 0.5 s, pluck 0.9 s after the sing accept); returns false if stuck */
export function honestNote(rig: Rig, seed: number, letRing = true): boolean {
  const i0 = rig.s.view().index; const target = MIDIS[i0];
  rig.run(rig.t + 6, () => rig.phase() === 'sing'); if (rig.phase() !== 'sing') return false;
  let ev = rig.sing({ midi: manMidi(target), dur: 2.5, seed }, rig.t + 0.5);
  rig.run(rig.t + 4, () => rig.phase() !== 'sing'); if (rig.phase() === 'sing') return false;
  rig.stop(ev, rig.t + 0.25, 80);
  for (let k = 0; k < 3 && rig.phase() === 'play' && rig.s.view().index === i0; k++) { rig.pluck({ midi: target, seed: seed + k }, rig.t + 0.9 + k * 0.3); rig.run(rig.t + 3.2, () => rig.phase() !== 'play' || rig.s.view().index !== i0); }
  if (rig.phase() === 'play' && rig.s.view().index === i0) return false;
  if (!letRing) rig.damp(rig.t + 0.3);
  return true;
}
