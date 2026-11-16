// @ts-nocheck (ported review tooling, kept as written)
// Twelfth review (ported unchanged except for where it finds the build; it writes to ./out of the
// directory it is run from).
// Critic-12 rig. Drives the build's StreamAnalyzer + Session with the app's own schedule (read from
// src/main.ts onFrame/runListen and src/ui/audio.ts play/deliver at 74cd03b):
//   advance into 'listen' -> 700 ms timer (frames still analysed on the guitar path, session ignores them)
//   -> play(): frames dropped from now; tone starts 60 ms later (+ env.lat output/input latency at the mic)
//   -> mutedUntil = start + sum(sec) + 0.35 + 0.3; finish timer +20 ms -> listenDone(now) -> attacks.clear() -> frames.
import { SR, rng, gauss, lin, dB, BQ, guitar, voice, refTone, wet, stringFor, bed, tv, speech, bump, writeWav } from './syn.ts';
export * from './syn.ts';
// (ported: BUILD_DIR still selects another checkout; by default this repository)
process.env.BUILD_DIR ??= new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const BUILD = process.env.BUILD_DIR!;
export const E = await import(`${BUILD}/src/core/engine.ts`);
export const SES = await import(`${BUILD}/src/core/session.ts`);
export const SET = await import(`${BUILD}/src/core/settings.ts`);
export const SONG = (await import(`${BUILD}/src/core/songs.ts`)).STAR_SPANGLED_BANNER;
export const HOP = 960;
export const MIDIS: number[] = SONG.notes.map((q) => 48 + q.offset);
export interface Env {
  room: string; seed?: number;
  /** reference sustain RMS at the mic, dBFS (null: headphones) */ ref?: number | null; speaker?: string; /** output+input latency of the reference at the mic (s) */ lat?: number;
  micHp?: number; /** mic self-noise, dBFS RMS */ floor?: number; agc?: false | 'slow' | 'fast'; settings?: any; from?: number;
  /** beds: [kind, dBFS RMS] */ beds?: [string, number][];
}
const cache = new Map<string, Float32Array>();
export function cached(key: string, mk: () => Float32Array) { let v = cache.get(key); if (!v) { if (cache.size > 400) cache.clear(); v = mk(); cache.set(key, v); } return v; }
export class Rig {
  env: Env; s; sa; n = 0; fed = 0; evs: any[] = []; r; hp1: BQ; hp2: BQ; agL = 1e-4; agG = 1; pink = 0;
  stage = 'none'; left = 0; muteEnd = 0; refStart = 0; cleared = true; openT = 0;
  advs: any[] = []; hintLog: any[] = []; lastHint: string | null = null; cap: Float32Array[] | null = null;
  expect: { phase: string; index: number; pos: number; from: number } | null = null; accidental: any[] = [];
  beds: { buf: Float32Array; g: number }[] = []; frames = 0; meterLog: any[] | null = null;
  constructor(env: Env) {
    this.env = env; this.r = rng((env.seed ?? 1) * 7 + 3); this.hp1 = new BQ('hp', env.micHp ?? 90, 0.707); this.hp2 = new BQ('hp', (env.micHp ?? 90) * 0.7, 0.6);
    this.sa = new E.StreamAnalyzer(SR); this.s = new SES.Session(SONG, 48, { ...SET.DEFAULT_SETTINGS, playKeyAtStart: false, ...(env.settings ?? {}) });
    for (const [k, d] of env.beds ?? []) { const buf = cached(`bed${k}|${env.room}`, () => wet(k === 'tv' ? tv(40, 3) : k === 'tvtalk' ? tv(40, 5, 0) : k === 'talk' ? (() => { const x = speech(40, 9); let e = 0; for (const v of x) e += v * v; const g = 1 / Math.sqrt(e / x.length); return x.map((v) => v * g); })() : bed(k as any, 40, 2), env.room, 5, -4)); this.beds.push({ buf, g: lin(d) }); }
  }
  get t() { return this.n / SR; }
  add(buf: Float32Array, at: number, db: number, tag = 'x', extra: any = {}) { const ev = { buf, start: Math.round(at * SR), g: lin(db), stop: null as number | null, fade: 0, tag, ...extra }; this.evs.push(ev); return ev; }
  /** guitar: db = peak dBFS at the mic (dry) */
  pluck(o: any, at: number, db = -14) { const st = o.str ?? stringFor(o.midi); for (const e of this.evs) if (e.tag === 'g' && e.str === st && (e.stop === null || e.stop > at * SR)) { e.stop = Math.round((at - 0.008) * SR); e.fade = 400; } return this.add(cached('g' + JSON.stringify(o) + this.env.room, () => wet(guitar(o), this.env.room, 2)), at, db, 'g', { str: st }); }
  /** voice: db = steady RMS dBFS at the mic (dry) */
  sing(o: any, at: number, db = -26, cache = true) { const mk = () => wet(voice(o), this.env.room, 1); return this.add(cache ? cached('v' + JSON.stringify(o) + this.env.room, mk) : mk(), at, db + 12.04, 'v'); }
  noise(key: string, mk: () => Float32Array, at: number, db: number, src = 4) { return this.add(cached(key + this.env.room + src, () => wet(mk(), this.env.room, src)), at, db, 'n'); }
  stop(ev: any, at: number, ms = 80) { const a = Math.round(at * SR); if (ev.stop === null || ev.stop > a) { ev.stop = a; ev.fade = Math.floor(ms / 1000 * SR); } }
  damp(at: number, ms = 40) { for (const e of this.evs) if (e.tag === 'g') this.stop(e, at, ms); }
  render(): Float32Array {
    const y = new Float32Array(HOP), n0 = this.n;
    this.evs = this.evs.filter((e) => n0 < e.start + e.buf.length && (e.stop === null || n0 < e.stop + e.fade));
    for (const e of this.evs) { const i0 = Math.max(0, e.start - n0); for (let i = i0; i < HOP; i++) { const off = n0 + i - e.start; if (off >= e.buf.length) break; let g = e.g; if (e.stop !== null) { const past = n0 + i - e.stop; if (past > 0) { if (past >= e.fade) break; g *= 0.5 + 0.5 * Math.cos(Math.PI * past / e.fade); } } y[i] += g * e.buf[off]; } }
    for (const b of this.beds) { const L = b.buf.length; for (let i = 0; i < HOP; i++) y[i] += b.g * b.buf[(n0 + i) % L]; }
    const fl = lin(this.env.floor ?? -66); const agc = this.env.agc;
    for (let i = 0; i < HOP; i++) {
      const w = gauss(this.r); this.pink += 0.03 * (w - this.pink); let v = this.hp2.p(this.hp1.p(y[i])) + fl * (0.75 * w + 3 * this.pink);
      if (agc) {
        const a = Math.abs(v); this.agL += (a > this.agL ? 1 / (0.005 * SR) : 1 / (0.3 * SR)) * (a - this.agL); const L = dB(this.agL);
        const want = Math.min(24, Math.max(-12, -21 - L)); const cur = dB(this.agG);
        // gain falls quickly (limiter), rises slowly; no rise while only noise is present
        let nxt = cur; if (want < cur) nxt = cur + (want - cur) / (0.02 * SR); else if (L > -58) nxt = Math.min(want, cur + (agc === 'fast' ? 20 : 7) / SR);
        this.agG = lin(nxt); v *= this.agG;
      }
      y[i] = Math.max(-1, Math.min(1, v));
    }
    this.cap?.push(y); return y;
  }
  /** warm the analysis for `sec` (both paths, as the app's resetAnalysis does), then start the session */
  begin(sec = 3) { for (let i = 0; i < sec * 50; i++) { this.sa.push(this.render()); this.n += HOP; this.fed += HOP; if (this.fed >= E.FRAME_SIZE) { this.sa.frame('voice', this.t); this.sa.frame('guitar', this.t); } } this.s.start(this.env.from ?? 0); this.stage = 'delay'; this.left = 0.3; }
  onRef: ((refStart: number, muteEnd: number) => void) | null = null;
  tick(): boolean {
    this.sa.push(this.render()); this.n += HOP; const t = this.t; const v = this.s.view(); if (v.phase === 'done') return false;
    if (v.phase === 'listen') {
      if (this.stage === 'delay') {
        this.left -= HOP / SR; this.s.pitch(this.sa.frame(this.s.listeningPath(), t));
        if (this.left <= 1e-9) {
          const notes = v.listenKind === 'phrase' ? v.listenNotes.map((q) => ({ midi: q.midi, sec: Math.max(0.12, q.beats * 60 / SONG.bpm) })) : [{ midi: v.targetMidi, sec: 0.9 }];
          let tt = t + 0.06; this.refStart = tt;
          for (const q of notes) { if (this.env.ref != null) { const d = Math.max(0.2, q.sec); const spk = this.env.speaker ?? 'phone'; this.add(cached(`ref${q.midi}:${d}:${spk}:${this.env.room}`, () => wet(refTone(q.midi, d, spk as any), this.env.room, 3, 16)), tt + (this.env.lat ?? 0), this.env.ref, 'ref'); } tt += q.sec; }
          this.muteEnd = tt + 0.35 + 0.3 + 0.02; this.stage = 'playing'; this.onRef?.(this.refStart, this.muteEnd);
        }
      } else if (t >= this.muteEnd - 1e-9) { this.stage = 'none'; this.cleared = false; this.s.listenDone(t); this.openT = t; }
      return false;
    }
    if (!this.cleared) { this.sa.attacks.clear(); this.cleared = true; }
    const adv = this.s.pitch(this.sa.frame(this.s.listeningPath(), t)); this.frames++;
    const m = this.s.view().match; const h = adv ? null : m?.hint ?? null;
    if (this.meterLog && !adv) this.meterLog.push({ t, phase: v.phase, index: v.index, hint: h, voiced: m?.voiced, stable: m?.stable, det: m?.detectedMidi, cents: m?.cents, prog: m?.progress });
    if (h !== this.lastHint) { if (h) this.hintLog.push({ t, phase: v.phase, index: v.index, hint: h }); this.lastHint = h; }
    if (adv) {
      const a = this.s.lastAccepted; const rec = { t, phase: v.phase, index: v.index, pos: v.review?.pos ?? -1, target: v.targetMidi, det: a?.detectedMidi ?? null };
      this.advs.push(rec); const x = this.expect;
      if (!(x && x.phase === rec.phase && x.index === rec.index && x.pos === rec.pos && t >= x.from)) this.accidental.push(rec);
      const nv = this.s.view(); if (nv.phase === 'listen') { this.stage = 'delay'; this.left = 0.7; } else this.openT = t;
    }
    return adv;
  }
  run(until: number, stopIf?: () => boolean) { while (this.t < until) { this.tick(); if (stopIf?.() || this.s.view().phase === 'done') break; } }
  phase() { return this.s.view().phase; } idx() { return this.s.view().index; } pos() { return this.s.view().review?.pos ?? -1; }
  key() { const v = this.s.view(); return `${v.phase}|${v.index}|${v.review?.pos ?? -1}`; }
  /** run until a step (not 'listen') is open; returns false if the session is done or it never opens */
  untilOpen(max = 15) { this.run(this.t + max, () => this.phase() !== 'listen'); return this.phase() !== 'listen' && this.phase() !== 'done'; }
}
export const med = (xs: number[], q = 0.5) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
export const U = (r: () => number, a: number, b: number) => a + (b - a) * r();

// ------------------------------------------------------------------ the honest student
export interface Student {
  seed?: number; /** which octave they sing a target in */ oct?: (m: number) => number;
  v?: any; /** voice level (steady RMS dBFS) */ vDb?: number; /** onset relative to the step opening (s); negative = early */ singDelay?: (r: () => number) => number; hold?: number;
  g?: any; gDb?: number; pluckDelay?: (r: () => number) => number; ring?: boolean; /** level spread (dB) */ spread?: number;
  reviewGap?: (r: () => number) => number; singEv?: any;
}
export const MAN = (m: number) => (m > 62 ? m - 12 : m), WOMAN = (m: number) => (m < 57 ? m + 12 : m), CHILD = (m: number) => m + 12, BASS = (m: number) => (m > 55 ? m - 12 : m);
export interface Res { sing: { n: number; first: number; stuck: number; lat: number[] }; play: { n: number; first: number; stuck: number; lat: number[] }; rev: { n: number; first: number; stuck: number; lat: number[] }; acc: any[]; notes: number; stuckAt: string[]; hints: Record<string, number> }
export function newRes(): Res { const z = () => ({ n: 0, first: 0, stuck: 0, lat: [] }); return { sing: z(), play: z(), rev: z(), acc: [], notes: 0, stuckAt: [], hints: {} }; }
/** play honest notes from..to (inclusive) through a begun rig */
export function honest(rig: Rig, st: Student, from: number, to: number, res: Res = newRes()): Res {
  const r = rng((st.seed ?? 1) * 31 + 7); const oct = st.oct ?? MAN; const vowels = ['a', 'o', 'u', 'a', 'e', 'i'], cons = ['', 'l', '', 'd', 'n', 'm', 'h'];
  const sp = st.spread ?? 3; let vcount = 0;
  const mkVoice = (tg: number) => ({ midi: oct(tg), dur: st.hold ?? 2.2, vowel: vowels[Math.floor(6 * r())], cons: cons[Math.floor(7 * r())], cents: Math.round(U(r, -18, 18)), riseMs: Math.round(U(r, 40, 140)), seed: 1000 * (st.seed ?? 1) + vcount++, ...(st.v ?? {}) });
  let refInfo: any = null; rig.onRef = (a, b) => { refInfo = { a, b, idx: rig.idx() }; };
  for (let i = from; i <= to; i++) {
    if (rig.phase() === 'done') break; const tg = MIDIS[i];
    // --- sing
    if (!rig.s.settings?.skipSing && !(rig.env.settings?.skipSing)) {
      rig.expect = null; refInfo = null;
      rig.run(rig.t + 6, () => refInfo !== null || rig.phase() !== 'listen');
      if (rig.idx() !== i) { res.stuckAt.push(`desync@${i}->${rig.idx()}`); i = rig.idx() - 1; continue; }
      let done = false, first = true;
      const d0 = (st.singDelay ?? ((q) => U(q, 0.3, 0.9)))(r);
      let onset = refInfo ? refInfo.b + d0 : rig.t + Math.max(0.1, d0); if (onset < rig.t + 0.02) onset = rig.t + 0.02;
      res.sing.n++;
      for (let k = 0; k < 4 && !done; k++) {
        let vo = mkVoice(tg); let ev; const cu = k === 0 && st.singEv && refInfo ? st.singEv(rig, i, tg, refInfo, r, vo) : null;
        if (cu) { ev = cu.ev; onset = cu.onset; vo = { dur: cu.dur }; } else ev = rig.sing(vo, onset, (st.vDb ?? -26) + U(r, -sp, sp));
        rig.expect = { phase: 'sing', index: i, pos: -1, from: onset };
        const endT = onset + vo.dur + 0.25;
        rig.run(endT, () => rig.idx() !== i || (rig.phase() !== 'sing' && rig.phase() !== 'listen'));
        if (rig.phase() === 'play' && rig.idx() === i) { done = true; if (first && rig.t >= onset) { res.sing.first++; res.sing.lat.push(rig.t - Math.max(onset, refInfo ? refInfo.b : onset)); } rig.stop(ev, rig.t + U(r, 0.12, 0.3), 90); }
        else if (rig.idx() !== i) { done = true; rig.stop(ev, rig.t + 0.1, 90); }
        else { first = false; onset = rig.t + U(r, 0.5, 0.8); }
      }
      if (rig.idx() === i && rig.phase() === 'sing') { res.sing.stuck++; res.stuckAt.push(`sing@${i}`); rig.s.skip(); if (rig.s.view().phase === 'listen') { rig.stage = 'delay'; rig.left = 0; } continue; }
      if (rig.idx() !== i) { i = rig.idx() - 1; continue; }
    }
    // --- play
    if (rig.phase() === 'listen') rig.untilOpen();
    if (st.noPlay) { res.notes++; if (i < to && rig.phase() === 'play') { rig.damp(rig.t); for (const e of rig.evs) if (e.tag === 'v') rig.stop(e, rig.t + 0.1); rig.run(rig.t + 1.2); rig.s.skip(); if (rig.s.view().phase === 'review') rig.s.skip(); if (rig.s.view().phase === 'listen') { rig.stage = 'delay'; rig.left = 0.2; } } continue; }
    if (rig.phase() === 'play' && rig.idx() === i) {
      res.play.n++; let done = false, first = true; let at = rig.t + (st.pluckDelay ?? ((q) => U(q, 0.6, 1.2)))(r);
      for (let k = 0; k < 4 && !done; k++) {
        rig.pluck({ midi: tg, seed: 100 * (st.seed ?? 1) + i * 7 + k, cents: Math.round(U(r, -8, 12)), ...(st.g ?? {}) }, at, (st.gDb ?? -14) + U(r, -sp, sp)); rig.expect = { phase: 'play', index: i, pos: -1, from: at };
        rig.run(at + 2.6, () => rig.key() !== `play|${i}|-1`);
        if (rig.key() !== `play|${i}|-1`) { done = true; if (first) { res.play.first++; res.play.lat.push(rig.t - at); } }
        else { first = false; at = rig.t + U(r, 0.3, 0.6); }
      }
      if (!done) { res.play.stuck++; res.stuckAt.push(`play@${i}`); rig.s.skip(); if (rig.s.view().phase === 'listen') { rig.stage = 'delay'; rig.left = 0; } continue; }
      if (st.ring === false) rig.damp(rig.t + 0.35);
    }
    // --- review
    if (st.noReview && rig.phase() === 'review') { res.notes++; continue; }
    if (rig.phase() === 'review' && rig.idx() === i) {
      const notes: number[] = rig.s.view().review.notes; let at = rig.t + 0.6 + U(r, 0.4, 0.9);
      for (let p = rig.pos(); p < notes.length && rig.phase() === 'review' && rig.idx() === i;) {
        res.rev.n++; let done = false, first = true;
        for (let k = 0; k < 4 && !done; k++) {
          rig.pluck({ midi: notes[p], seed: 100 * (st.seed ?? 1) + i * 11 + p * 3 + k + 50, cents: Math.round(U(r, -8, 12)), ...(st.g ?? {}) }, at, (st.gDb ?? -14) + U(r, -sp, sp)); rig.expect = { phase: 'review', index: i, pos: p, from: at };
          rig.run(at + 2.2, () => rig.key() !== `review|${i}|${p}`);
          if (rig.key() !== `review|${i}|${p}`) { done = true; if (first) { res.rev.first++; res.rev.lat.push(rig.t - at); } }
          else { first = false; at = rig.t + U(r, 0.3, 0.6); }
        }
        if (!done) { res.rev.stuck++; res.stuckAt.push(`rev@${i}.${p}`); rig.s.skip(); if (rig.s.view().phase === 'listen') { rig.stage = 'delay'; rig.left = 0; } break; }
        at = rig.t + (st.reviewGap ?? ((q) => U(q, 0.35, 0.7)))(r);
        if (rig.phase() === 'review' && rig.idx() === i) { const np = rig.pos(); if (np !== p + 1) { /* skipped ahead by an accidental advance: already counted */ } p = np; } else break;
      }
      if (st.ring === false) rig.damp(rig.t + 0.35);
    }
    res.notes++;
  }
  rig.expect = null; res.acc = rig.accidental; for (const h of rig.hintLog) res.hints[`${h.phase}:${h.hint}`] = (res.hints[`${h.phase}:${h.hint}`] ?? 0) + 1;
  return res;
}
export function fmt(res: Res) { const f = (x: any) => `${x.first}/${x.n} stuck ${x.stuck} med ${Math.round(1000 * med(x.lat))} p90 ${Math.round(1000 * med(x.lat, 0.9))}`; return `sing ${f(res.sing)} | play ${f(res.play)} | review ${f(res.rev)} | accidental ${res.acc.length}`; }
