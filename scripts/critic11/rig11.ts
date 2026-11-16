// @ts-nocheck (ported review tooling, kept as written)
// Eleventh review (ported unchanged except for where it finds the build).
// Critic-11 rig: mixer + room + phone, driving the build's StreamAnalyzer + Session with the app's timing
// (src/main.ts onFrame/runListen, src/ui/audio.ts play/deliver, read at 1b6c086):
//   accept -> 700 ms (frames analysed, session in 'listen' ignores them) -> play() starts 60 ms later ->
//   frames dropped until end-of-notes + 0.35 + 0.3 s (+20 ms timer) -> attacks.clear() -> listenDone.
import { SR, rng, gs, amp, Bq, guitar, voice, refTone, roomIR, conv, stringOf, ROOMS } from './syn11.ts';
export * from './syn11.ts';
// (ported: BUILD_DIR still selects another checkout; by default this repository)
process.env.BUILD_DIR ??= new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const BUILD = process.env.BUILD_DIR!;
export const E = await import(`${BUILD}/src/core/engine.ts`);
export const S = await import(`${BUILD}/src/core/session.ts`);
export const SET = await import(`${BUILD}/src/core/settings.ts`);
export const SONG = (await import(`${BUILD}/src/core/songs.ts`)).STAR_SPANGLED_BANNER;
export const TW = await import(`${BUILD}/src/core/tunewatch.ts`).catch(() => null);
export const HOP = 960;
export const MIDIS: number[] = SONG.notes.map((q) => 48 + q.offset);
export interface Env { room: string; seed?: number; spk?: number | null; speaker?: string; hp?: number; floor?: number; agc?: boolean; settings?: any; firstDelay?: number }
const memo = new Map<string, Float32Array>();
export class Rig {
  s; sa; n = 0; evs = []; env: Env; r; hp: Bq; agE = 0; agG = 1; pn = 0;
  stage = 'none'; left = 0; muteEnd = 0; wasMuted = false; fed = 0; openT = 0; refStart = 0;
  advs = []; hints: string[] = []; allHints: { t: number; phase: string; index: number; hint: string }[] = []; cap: Float32Array[] | null = null; onOpen = null; onRef = null;
  constructor(env: Env) { this.env = env; this.r = rng((env.seed ?? 1) * 3 + 11); this.hp = new Bq('hp', env.hp ?? 120, 0.707); this.sa = new E.StreamAnalyzer(SR); this.s = new S.Session(SONG, 48, { ...SET.DEFAULT_SETTINGS, playKeyAtStart: false, ...(env.settings ?? {}) }); }
  get t() { return this.n / SR; }
  wet(key: string, mk: () => Float32Array, variant: number, near = 0) { const k = `${key}|${this.env.room}|${variant}|${near}`; let v = memo.get(k); if (!v) { if (memo.size > 300) memo.clear(); const ir = roomIR(this.env.room, variant, near); v = ir ? conv(mk(), ir) : mk(); memo.set(k, v); } return v; }
  add(buf: Float32Array, at: number, db: number, tag: string, str = -1) { const ev = { buf, start: Math.round(at * SR), g: amp(db), stop: null, fade: 0, tag, str }; this.evs.push(ev); return ev; }
  pluck(o, at: number, db = -14, str?: number) { const st = str ?? stringOf(o.midi); for (const e of this.evs) if (e.tag === 'g' && e.str === st && (e.stop === null || e.stop > at * SR)) { e.stop = Math.round((at - 0.01) * SR); e.fade = 480; } return this.add(this.wet('g' + JSON.stringify(o), () => guitar(o), 0), at, db, 'g', st); }
  sing(o, at: number, db = -24) { return this.add(this.wet('v' + JSON.stringify(o), () => voice(o), 1), at, db, 'v'); }
  raw(key: string, mk: () => Float32Array, at: number, db: number, variant = 2) { return this.add(this.wet(key, mk, variant), at, db, 'x'); }
  stop(ev, at: number, ms = 70) { const a = Math.round(at * SR); if (ev.stop === null || ev.stop > a) { ev.stop = a; ev.fade = Math.floor(ms / 1000 * SR); } }
  damp(at: number, ms = 40) { for (const e of this.evs) if (e.tag === 'g') this.stop(e, at, ms); }
  render() {
    const y = new Float32Array(HOP), n0 = this.n;
    this.evs = this.evs.filter((e) => n0 < e.start + e.buf.length && (e.stop === null || n0 < e.stop + e.fade));
    for (const e of this.evs) for (let i = Math.max(0, e.start - n0); i < HOP; i++) { const off = n0 + i - e.start; if (off >= e.buf.length) break; let g = e.g; if (e.stop !== null) { const past = n0 + i - e.stop; if (past > 0) { if (past >= e.fade) break; g *= 0.5 + 0.5 * Math.cos(Math.PI * past / e.fade); } } y[i] += g * e.buf[off]; }
    const fl = amp(this.env.floor ?? -60);
    for (let i = 0; i < HOP; i++) {
      const w = gs(this.r); this.pn += 0.02 * (w - this.pn); let v = this.hp.p(y[i] + fl * (4 * this.pn + 0.7 * w));
      if (this.env.agc) { const a = Math.abs(v); this.agE += (a > this.agE ? 0.005 : 0.0001) * (a - this.agE); const lv = 20 * Math.log10(this.agE + 1e-9); if (lv > -55) { const want = Math.min(amp(24), Math.max(amp(-10), amp(-20 - lv))); this.agG += (want < this.agG ? 0.001 : 0.00003) * (want - this.agG); } v *= this.agG; }
      y[i] = Math.max(-1, Math.min(1, v));
    }
    this.cap?.push(y); return y;
  }
  begin(from = 0) { for (let i = 0; i < 100; i++) { this.sa.push(this.render()); this.n += HOP; this.fed += HOP; if (this.fed >= E.FRAME_SIZE) { this.sa.frame('voice', this.t); this.sa.frame('guitar', this.t); } } this.s.start(from); this.stage = 'delay'; this.left = this.env.firstDelay ?? 0.4; }
  tick(): boolean {
    this.sa.push(this.render()); this.n += HOP; const t = this.t; const v = this.s.view(); if (v.phase === 'done') return false;
    if (v.phase === 'listen') {
      if (this.stage === 'delay') {
        this.left -= HOP / SR; this.s.pitch(this.sa.frame(this.s.listeningPath(), t));
        if (this.left <= 0) {
          const notes = v.listenKind === 'phrase' ? v.listenNotes.map((q) => ({ midi: q.midi, sec: Math.max(0.12, q.beats * 60 / SONG.bpm) })) : [{ midi: v.targetMidi, sec: 0.9 }];
          let tt = t + 0.06; this.refStart = tt;
          for (const q of notes) { if (this.env.spk != null) { const d = Math.max(0.2, q.sec); const spk = this.env.speaker ?? 'phone'; this.add(this.wet(`ref${q.midi}:${d}:${spk}`, () => refTone(q.midi, d, spk as any), 3, 18), tt, this.env.spk, 'ref'); } tt += q.sec; }
          this.muteEnd = tt + 0.35 + 0.3 + 0.02; this.stage = 'playing'; this.onRef?.(this.refStart, this.muteEnd);
        }
      } else if (t >= this.muteEnd - 1e-9) { this.stage = 'none'; this.wasMuted = true; this.s.listenDone(t); this.openT = t; this.hints = []; this.onOpen?.(this.s.view()); }
      return false;
    }
    if (this.wasMuted) { this.sa.attacks.clear(); this.wasMuted = false; }
    const adv = this.s.pitch(this.sa.frame(this.s.listeningPath(), t));
    const h = this.s.view().match?.hint; if (!adv && h && this.hints[this.hints.length - 1] !== h) { this.hints.push(h); this.allHints.push({ t, phase: v.phase, index: v.index, hint: h }); }
    if (adv) { const a = this.s.lastAccepted; this.advs.push({ t, phase: v.phase, index: v.index, pos: v.review?.pos ?? -1, target: v.targetMidi, det: a?.detectedMidi ?? null, reason: a?.reason ?? null }); const nv = this.s.view(); if (nv.phase === 'listen') { this.stage = 'delay'; this.left = 0.7; } else { this.openT = t; if (nv.phase !== v.phase) this.hints = []; } }
    return adv;
  }
  run(until: number, stopIf?: () => boolean) { while (this.t < until) { this.tick(); if (stopIf?.() || this.s.view().phase === 'done') break; } }
  phase() { return this.s.view().phase; }
  idx() { return this.s.view().index; }
  /** run until the given phase opens (max sec) */
  until(ph: string, max = 8) { this.run(this.t + max, () => this.phase() === ph); return this.phase() === ph; }
  wav(path: string, fs) { const n = this.cap.length * HOP; const b = Buffer.alloc(44 + 2 * n); b.write('RIFF', 0); b.writeUInt32LE(36 + 2 * n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(2 * SR, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(2 * n, 40); let o = 44; for (const c of this.cap) for (let i = 0; i < HOP; i++) { b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, c[i])) * 32767), o); o += 2; } fs.writeFileSync(path, b); }
}
export const man = (m: number) => (m > 60 ? m - 12 : m);
export const woman = (m: number) => (m < 57 ? m + 12 : m);
export const child = (m: number) => (m < 60 ? m + 12 : m);
/** honest standard note i (sing 0.5 s after open, pluck 0.9 s after sing accept). false if stuck. */
export function plainNote(rig: Rig, seed: number, g: any = {}, gDb = -14, vDb = -24, ring = true): boolean {
  const i0 = rig.idx(); const tg = MIDIS[i0];
  if (!rig.until('sing')) return false;
  const ev = rig.sing({ midi: man(tg), dur: 3, seed }, rig.t + 0.5, vDb); rig.run(rig.t + 5, () => rig.phase() !== 'sing'); if (rig.phase() === 'sing') return false; rig.stop(ev, rig.t + 0.25, 80);
  for (let k = 0; k < 3 && rig.phase() === 'play' && rig.idx() === i0; k++) { rig.pluck({ midi: tg, seed: seed + k, ...g }, rig.t + 0.9, gDb); rig.run(rig.t + 3.2, () => rig.phase() !== 'play' || rig.idx() !== i0); }
  if (rig.phase() === 'play' && rig.idx() === i0) return false;
  if (!ring) rig.damp(rig.t + 0.3);
  return true;
}
export function pct(a: number, b: number) { return `${a}/${b}`; }
export function med(xs: number[], q = 0.5) { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }
