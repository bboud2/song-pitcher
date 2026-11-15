// Eighth review's rig, ported unchanged except for where it finds the build.
// Critic-8 rig: dry sources -> streaming room (early taps + 8-line FDN + low room modes) -> phone chain -> the build's real
// StreamAnalyzer + Session, with main.ts timing (700 ms after an accept, reference muted + 0.3 s tail, attacks cleared after mute).
import { BQ, SR, db2a, gauss, guitar, GLEAD, voice, VLEAD, speech, refTone, knock, rng, stringFor, mtof, type GOpts, type VOpts } from './syn8.ts';
export { SR, rng, stringFor };
// (ported: BUILD_DIR still selects another checkout; by default this repository)
const BUILD = process.env.BUILD_DIR ?? new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
export const E = await import(`${BUILD}/src/core/engine.ts`);
export const S = await import(`${BUILD}/src/core/session.ts`);
export const SET = await import(`${BUILD}/src/core/settings.ts`);
export const SONG = (await import(`${BUILD}/src/core/songs.ts`)).STAR_SPANGLED_BANNER;
export const HOP = Math.round(0.02 * SR);
const mem = new Map<string, Float32Array>();
const memo = (k: string, mk: () => Float32Array) => { let v = mem.get(k); if (!v) { if (mem.size > 500) mem.clear(); v = mk(); mem.set(k, v); } return v; };
export const G = (o: GOpts) => memo('g' + JSON.stringify(o), () => guitar(o));
export const V = (o: VOpts) => memo('v' + JSON.stringify(o), () => voice(o));

export interface Room { rt: number; wet: number; size: number; damp: number; earlyG: [number, number][]; earlyV: [number, number][]; modes?: [number, number, number][]; }
export const ROOMS: Record<string, Room | null> = {
  dry: null,
  // carpeted bedroom, phone on a music stand 50 cm away
  bed: { rt: 0.35, wet: 0.10, size: 0.8, damp: 0.45, earlyG: [[2.9, 0.35], [7.3, 0.25], [11.9, 0.2]], earlyV: [[3.7, 0.3], [8.1, 0.25], [13.3, 0.18]], modes: [[48, 14, 0.05], [57, 14, 0.04], [71, 16, 0.04]] },
  // living room, phone lying on a coffee table (strong 0.9 ms table bounce = comb)
  table: { rt: 0.6, wet: 0.16, size: 1.15, damp: 0.3, earlyG: [[0.9, 0.7], [5.1, 0.3], [9.7, 0.3], [17.9, 0.22]], earlyV: [[1.1, 0.65], [6.3, 0.3], [12.1, 0.25], [21.0, 0.2]], modes: [[34, 16, 0.05], [44, 16, 0.05], [68, 18, 0.04]] },
  // tiled kitchen, phone on the counter 1.2 m away
  kitchen: { rt: 1.0, wet: 0.32, size: 0.9, damp: 0.15, earlyG: [[1.4, 0.6], [4.4, 0.45], [8.8, 0.4], [14.2, 0.35]], earlyV: [[1.7, 0.55], [5.0, 0.45], [9.9, 0.4], [16.0, 0.3]], modes: [[52, 25, 0.08], [78, 25, 0.07], [104, 28, 0.06], [131, 28, 0.05]] },
  // stairwell / bathroom: very live, 1.5 m
  bath: { rt: 1.5, wet: 0.5, size: 0.6, damp: 0.1, earlyG: [[2.2, 0.6], [3.9, 0.55], [6.1, 0.5], [9.0, 0.45]], earlyV: [[2.6, 0.6], [4.4, 0.5], [7.0, 0.5], [10.1, 0.4]], modes: [[82, 35, 0.1], [110, 35, 0.1], [147, 35, 0.08], [165, 35, 0.07]] },
};
export interface Phone { hp: number; hpQ?: number; peak?: [number, number, number]; lp?: number; floorDb: number; humDb?: number; humHz?: number; agc?: boolean; ns?: boolean; clipDb?: number; }
export const PHONES: Record<string, Phone> = {
  pixel: { hp: 80, floorDb: -64 },
  iphoneVP: { hp: 150, floorDb: -58, agc: true, ns: true }, // voice processing left on (constraints ignored)
  budget: { hp: 250, hpQ: 0.9, peak: [3200, 1.2, 7], floorDb: -50, clipDb: -4 },
  airpods: { hp: 200, lp: 3600, floorDb: -52, agc: true }, // hands-free profile mic
  hum: { hp: 90, floorDb: -56, humDb: -44, humHz: 60 },
  tablet: { hp: 110, peak: [1100, 2, -5], floorDb: -54 },
};
class FDN {
  d: Float32Array[] = []; p: number[] = []; g: number[] = []; lpz: number[] = []; damp: number; N = 8;
  constructor(room: Room) { const ms = [29.7, 37.1, 41.1, 43.7, 53.3, 59.9, 67.3, 73.1]; this.damp = room.damp; for (const m of ms) { const L = Math.round(m * room.size * SR / 1000) | 1; this.d.push(new Float32Array(L)); this.p.push(0); this.g.push(Math.pow(10, -3 * L / (room.rt * SR))); this.lpz.push(0); } }
  s(x: number) { let sum = 0; const y: number[] = []; for (let i = 0; i < 8; i++) { const v = this.d[i][this.p[i]]; this.lpz[i] = v * (1 - this.damp) + this.lpz[i] * this.damp; y.push(this.lpz[i]); sum += this.lpz[i]; } const h = sum * 0.25; let out = 0;
    for (let i = 0; i < 8; i++) { this.d[i][this.p[i]] = this.g[i] * (y[i] - h) + x * (i % 2 ? -1 : 1); this.p[i] = (this.p[i] + 1) % this.d[i].length; out += y[i] * (i % 3 === 0 ? -1 : 1); } return out * 0.35; }
}
class Taps { buf: Float32Array; p = 0; taps: [number, number][]; constructor(t: [number, number][]) { this.buf = new Float32Array(4096); this.taps = t.map(([ms, g]) => [Math.round(ms * SR / 1000), g]); }
  s(x: number) { this.buf[this.p] = x; let y = x; for (const [d, g] of this.taps) y += g * this.buf[(this.p - d + 4096) & 4095]; this.p = (this.p + 1) & 4095; return y; } }
export interface Env { room: string; phone: string; seed?: number; spk?: number | null; settings?: Record<string, unknown>; tvDb?: number; tvFemale?: boolean; }
type Tag = 'g' | 'v' | 'x' | 'ref';
export interface Ev { buf: Float32Array; start: number; gain: number; stop: number | null; fade: number; tag: Tag; midi: number; string: number; onset: number }
export interface Adv { t: number; index: number; phase: string; pos: number; target: number; legit: boolean; why: string; lat?: number }
export class Rig {
  s: any; sa: any; n = 0; evs: Ev[] = []; log: Adv[] = []; env: Env; r: () => number; room: Room | null; ph: Phone;
  fdn: FDN | null = null; tg: Taps | null = null; tv: Taps | null = null; modes: { bq: BQ; g: number }[] = []; hpf: BQ[]; pk: BQ | null = null; lpf: BQ[] = []; pink = 0; pink2 = 0;
  agcEnv = 0; agcG = 1; nsG = 1; nsEnv = 0;
  stage: 'none' | 'delay' | 'playing' = 'none'; left = 0; wasMuted = true; fed = 0; stepT = 0; lastAdvT = 0;
  plucks: { t: number; midi: number; ok: boolean }[] = []; voices: { t0: number; t1: number; midi: number; ev: Ev }[] = []; hints: Record<string, number> = {};
  tvBuf: Float32Array | null = null; capture: Float32Array[] | null = null;
  constructor(env: Env) {
    this.env = env; this.r = rng(env.seed ?? 3); this.room = ROOMS[env.room]; this.ph = PHONES[env.phone];
    if (this.room) { this.fdn = new FDN(this.room); this.tg = new Taps(this.room.earlyG); this.tv = new Taps(this.room.earlyV); this.modes = (this.room.modes ?? []).map(([f, q, g]) => ({ bq: new BQ('bp', f, q), g })); }
    this.hpf = [new BQ('hp', this.ph.hp, this.ph.hpQ ?? 0.707)]; if (this.ph.peak) this.pk = new BQ('pk', this.ph.peak[0], this.ph.peak[1], this.ph.peak[2]); if (this.ph.lp) this.lpf = [new BQ('lp', this.ph.lp, 0.6), new BQ('lp', this.ph.lp, 1.2)];
    if (env.tvDb !== undefined) this.tvBuf = speech(40, (env.seed ?? 3) + 77, env.tvFemale);
    this.sa = new E.StreamAnalyzer(SR);
    this.s = new S.Session(SONG, 48, { ...SET.DEFAULT_SETTINGS, playKeyAtStart: false, ...(env.settings ?? {}) });
  }
  get t() { return this.n / SR; }
  private render(): Float32Array {
    const y = new Float32Array(HOP); const n0 = this.n; const bg = new Float32Array(HOP), bv = new Float32Array(HOP), bx = new Float32Array(HOP), br = new Float32Array(HOP);
    this.evs = this.evs.filter((e) => n0 < e.start + e.buf.length && (e.stop === null || n0 < e.stop + e.fade));
    for (const e of this.evs) { const b = e.tag === 'g' ? bg : e.tag === 'v' ? bv : e.tag === 'x' ? bx : br; for (let i = Math.max(0, e.start - n0); i < HOP; i++) { const off = n0 + i - e.start; if (off >= e.buf.length) break; let g = e.gain; if (e.stop !== null) { const past = n0 + i - e.stop; if (past > 0) { if (past >= e.fade) break; g *= 0.5 + 0.5 * Math.cos(Math.PI * past / e.fade); } } b[i] += g * e.buf[off]; } }
    if (this.tvBuf) { const g = db2a(this.env.tvDb!); for (let i = 0; i < HOP; i++) bx[i] += g * this.tvBuf[(n0 + i) % this.tvBuf.length]; }
    const p = this.ph; const fl = db2a(p.floorDb); const hum = p.humDb !== undefined ? db2a(p.humDb) : 0;
    for (let i = 0; i < HOP; i++) {
      let v: number;
      if (this.room) { const g = this.tg!.s(bg[i]), vv = this.tv!.s(bv[i]); const send = bg[i] + bv[i] + 1.5 * bx[i] + 0.25 * br[i]; let wet = this.fdn!.s(send); for (const m of this.modes) wet += m.g * 6 * m.bq.s(send); v = g + vv + this.room.wet * wet + br[i] + 0.3 * bx[i]; }
      else v = bg[i] + bv[i] + bx[i] + br[i];
      const w = gauss(this.r); this.pink += 0.02 * (w - this.pink); this.pink2 += 0.2 * (w - this.pink2); v += fl * (3 * this.pink + 0.8 * this.pink2 + 0.35 * w);
      if (hum) { const tt = (n0 + i) / SR, f = p.humHz ?? 50; v += hum * (Math.sin(2 * Math.PI * f * tt) + 0.6 * Math.sin(2 * Math.PI * 2 * f * tt + 0.7) + 0.5 * Math.sin(2 * Math.PI * 3 * f * tt + 1.9) + 0.2 * Math.sin(2 * Math.PI * 5 * f * tt)); }
      for (const f of this.hpf) v = f.s(v); if (this.pk) v = this.pk.s(v); for (const f of this.lpf) v = f.s(v);
      if (p.agc || p.ns) { const a = Math.abs(v); this.agcEnv += (a > this.agcEnv ? 1 - Math.exp(-1 / (0.01 * SR)) : 1 - Math.exp(-1 / (0.4 * SR))) * (a - this.agcEnv); const lv = 20 * Math.log10(this.agcEnv + 1e-9);
        if (p.ns) { const tgt = lv < -46 ? db2a(-14) : 1; this.nsG += (tgt < this.nsG ? 1 - Math.exp(-1 / (0.12 * SR)) : 1 - Math.exp(-1 / (0.015 * SR))) * (tgt - this.nsG); v *= this.nsG; }
        if (p.agc) { if (lv > -45) { const want = Math.max(db2a(-6), Math.min(db2a(22), db2a(-18 - lv))); this.agcG += (want < this.agcG ? 1 - Math.exp(-1 / (0.15 * SR)) : 1 - Math.exp(-1 / (1.5 * SR))) * (want - this.agcG); } v *= this.agcG; } }
      if (p.clipDb !== undefined) { const c = db2a(p.clipDb); v = Math.max(-c, Math.min(c, v)); }
      y[i] = Math.max(-1, Math.min(1, v));
    }
    this.capture?.push(y);
    return y;
  }
  begin(from = 0) { for (let i = 0; i < 100; i++) { const x = this.render(); this.sa.push(x); this.n += HOP; this.fed += HOP; if (this.fed >= E.FRAME_SIZE) { this.sa.frame('guitar', this.t); this.sa.frame('voice', this.t); } } this.s.start(from); this.stage = 'delay'; this.left = 0.4; this.wasMuted = false; }
  add(buf: Float32Array, gainDb: number, tag: Tag, midi: number, string = -1, delay = 0, lead = 0): Ev {
    const start = this.n + Math.round(delay * SR);
    if (string >= 0) for (const e of this.evs) if (e.tag === 'g' && e.string === string && (e.stop === null || e.stop > start)) { e.stop = start; e.fade = Math.floor(0.006 * SR); }
    const ev: Ev = { buf, start, gain: db2a(gainDb), stop: null, fade: 0, tag, midi, string, onset: start / SR + lead }; this.evs.push(ev); return ev;
  }
  pluck(o: GOpts, levelDb = -14, delay = 0, ok = true): Ev { const ev = this.add(G(o), levelDb, 'g', o.midi + (o.cents ?? 0) / 100, o.string ?? stringFor(o.midi).s, delay, GLEAD(o.pluck)); this.plucks.push({ t: ev.onset, midi: o.midi, ok }); return ev; }
  sing(o: VOpts, levelDb = -22, delay = 0, track = true): Ev { const ev = this.add(V(o), levelDb, 'v', o.midi + (o.cents ?? 0) / 100, -1, delay, VLEAD); if (track) this.voices.push({ t0: ev.onset, t1: ev.onset + o.dur, midi: o.midi + (o.cents ?? 0) / 100, ev }); return ev; }
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
          let tt = 0.06; for (const q of notes) { if (this.env.spk != null) this.add(refTone(q.midi, Math.max(0.2, q.sec)), this.env.spk, 'ref', q.midi, -1, tt); tt += q.sec; }
          this.stage = 'playing'; this.left = tt + 0.35 + 0.3 + 0.02; this.wasMuted = true;
        }
      } else if (this.left <= 0) { this.stage = 'none'; this.s.listenDone(tNow); this.stepT = this.t; v = this.s.view(); }
      return v;
    }
    if (this.wasMuted) { this.sa.attacks?.clear?.(); this.wasMuted = false; }
    const before = v; const fr = this.sa.frame(this.s.listeningPath(), tNow); const adv = this.s.pitch(fr);
    const h = this.s.view().match?.hint ?? null; if (!adv && h) { const k = `${before.phase}:${h}`; this.hints[k] = (this.hints[k] ?? 0) + 1; }
    if (adv) {
      const t = this.t; let legit = false; let why = ''; let lat: number | undefined;
      if (before.phase === 'sing') {
        const pc = (a: number, b: number) => Math.abs(((((a - b) % 12) + 18) % 12) - 6);
        const vi = this.voices.filter((q) => q.t1 >= this.stepT - 0.05 && q.t0 < t && t <= q.t1 + 1.0 && pc(q.midi, before.targetMidi) < 0.65).pop();
        legit = !!vi; if (vi) lat = (t - Math.max(vi.t0, this.stepT)) * 1000; else { const vo = this.voices.filter((q) => q.t0 < t && t <= q.t1 + 1.0).pop(); why = `sing passed with no right sung note (voice ${vo ? vo.midi.toFixed(2) : '-'}; ringing ${this.ringing().join(',') || '-'}; det ${this.s.lastAccepted?.detectedMidi})`; }
      } else {
        const since = before.phase === 'play' ? this.stepT : this.lastAdvT;
        const lp = this.plucks.filter((q) => q.t >= since - 0.03 && q.t <= t).pop();
        legit = !!lp && lp.ok && lp.midi === before.targetMidi;
        if (legit) lat = (t - lp!.t) * 1000;
        else { const vo = this.voices.filter((q) => q.t0 <= t && q.t1 >= since - 0.3).pop(); why = lp ? `WRONG NOTE (${lp.midi - before.targetMidi} st${lp.ok ? '' : ', hunting'}) accepted ${((t - lp.t) * 1000).toFixed(0)} ms after it` : `NO PLUCK in step (voice ${vo ? vo.midi.toFixed(1) + ', ended ' + ((t - vo.t1) * 1000).toFixed(0) + ' ms ago' : '-'}; ringing ${this.ringing().join(',') || '-'})`; }
      }
      this.log.push({ t, index: before.index, phase: before.phase, pos: before.review?.pos ?? -1, target: before.targetMidi, legit, why, lat });
      this.lastAdvT = t; this.stepT = t; v = this.s.view();
      if (v.phase === 'listen') { this.stage = 'delay'; this.left = 0.7; }
    }
    return v;
  }
  skip() { this.s.skip(this.t); this.stepT = this.t; this.lastAdvT = this.t; if (this.s.view().phase === 'listen') { this.stage = 'delay'; this.left = 0.3; } }
}
export const med = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
export const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
export { knock, speech, mtof };
