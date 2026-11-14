// Ported from the fourth external review (read-only original), kept as a permanent test.
// Critic-4 rig: simulated mic (mixer + room + phone chain + timer) driving the real StreamAnalyzer +
// Session with main.ts timing; honest/adversarial student scripts on top. Own code (not the critic3 rig).
import { FRAME_SIZE, HOP_MS, StreamAnalyzer, analyzeBuffer, guitarConfig } from '../../src/core/engine.ts';
import { NoteMatcher } from '../../src/core/matcher.ts';
import { Session, type SessionView } from '../../src/core/session.ts';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings.ts';
import { STAR_SPANGLED_BANNER } from '../../src/core/songs.ts';
import { babble, db2a, pinkGen, rng, stringFor, voice, wg, type VOpts, type WOpts } from './synth4.ts';

export interface RoomOpts {
  sr?: number; seed?: number; settings?: Partial<Settings>;
  floorDb?: number; fanDb?: number; humDb?: number; humHz?: number;
  /** changes applied when the session reaches a note index */
  changes?: { note: number; floorDb?: number; fanDb?: number | null; humDb?: number | null }[];
  bg?: { buf: Float32Array; gain: number };
  hpHz?: number;
  agc?: { up: number; down: number; target: number; max: number };
  comp?: { thDb: number; ratio: number };
  gate?: { thDb: number; digital?: boolean; attDb?: number };
  zeroStartSec?: number; // the mic delivers exact zeros at first
  timer?: 'regular' | 'jitter' | 'burst' | 'slow50' | 'drops' | number;
  /** 'hop' (default): one analysis per 20 ms of audio, as the app does now; 'tick': per timer tick (old app) */
  delivery?: 'hop' | 'tick';
  checkSec?: number; checkPluck?: boolean; noCheck?: boolean;
}
interface Ev { buf: Float32Array; start: number; stop: number | null; fade: number; tag: string; midi: number; string: number; gain: number }
export interface Adv { t: number; index: number; phase: string; pos: number; target: number; legit: boolean; why: string; tta?: number; detected: number | null; cents: number | null }

export class Rig4 {
  s: Session; sa: StreamAnalyzer; sr: number; n = 0; evs: Ev[] = []; log: Adv[] = []; o: RoomOpts; r: () => number;
  private pink: () => number; private stage: 'none' | 'delay' | 'playing' = 'none'; private left = 0;
  private fl1 = 0; private fl2 = 0; private bgPos = 0; private hp = [0, 0, 0, 0]; private hpc: number[] | null = null;
  private agcG = 0; private agcE = 0; private cE = 0; private gE = 0; private gG = 0; private gHold = 0;
  private pend = new Float32Array(0); private lastT = -1;
  floorDb: number; fanDb: number | null; humDb: number | null;
  voiceI: { midi: number; t0: number; stop: number | null } | null = null;
  lastPluck: { midi: number; t: number; nominal: number } | null = null;
  stepT = 0; lastAdvT = 0;
  hintLog: Record<string, number> = {};
  onHint: ((phase: string, hint: string, t: number) => void) | null = null;

  constructor(o: RoomOpts = {}) {
    this.o = o; this.sr = o.sr ?? 48000; this.r = rng(o.seed ?? 77); this.pink = pinkGen((o.seed ?? 77) + 1);
    this.floorDb = o.floorDb ?? -62; this.fanDb = o.fanDb ?? null; this.humDb = o.humDb ?? null;
    this.sa = new StreamAnalyzer(this.sr);
    this.s = new Session(STAR_SPANGLED_BANNER, 48, { ...DEFAULT_SETTINGS, playKeyAtStart: false, ...(o.settings ?? {}) });
    if (o.hpHz) { const w = (2 * Math.PI * o.hpHz) / this.sr, al = Math.sin(w) / 1.414, cw = Math.cos(w), a0 = 1 + al; this.hpc = [(1 + cw) / 2 / a0, -(1 + cw) / a0, (-2 * cw) / a0, (1 - al) / a0]; }
  }
  get t() { return this.n / this.sr; }
  begin(from = 0) { this.s.start(from); this.stage = 'delay'; this.left = 0.4; }

  play(buf: Float32Array, tag: string, midi: number, string = -1, gain = 1) {
    if (string >= 0) for (const e of this.evs) if (e.string === string && e.stop === null) { e.stop = this.n; e.fade = Math.floor(0.012 * this.sr); }
    this.evs.push({ buf, start: this.n, stop: null, fade: 0, tag, midi, string, gain });
  }
  stop(pred: (e: Ev) => boolean, fadeMs = 60) { for (const e of this.evs) if (e.stop === null && pred(e)) { e.stop = this.n; e.fade = Math.floor((fadeMs / 1000) * this.sr); } }
  sounding(): string { return [...new Set(this.evs.filter((e) => this.n < e.start + e.buf.length && (e.stop === null || this.n < e.stop + e.fade)).map((e) => e.tag))].join('+'); }
  voiceOn(): boolean { const v = this.voiceI; return !!v && this.t >= v.t0 && (v.stop === null || this.t < v.stop + 0.12); }

  private render(len: number): Float32Array {
    const x = new Float32Array(len); const sr = this.sr; const o = this.o;
    this.evs = this.evs.filter((e) => this.n < e.start + e.buf.length && (e.stop === null || this.n < e.stop + e.fade));
    for (const e of this.evs) {
      const off = this.n - e.start;
      for (let i = 0; i < len && off + i < e.buf.length; i++) {
        let g = e.gain;
        if (e.stop !== null) { const past = this.n + i - e.stop; g *= past <= 0 ? 1 : Math.max(0, 1 - past / Math.max(1, e.fade)); }
        x[i] += g * e.buf[off + i];
      }
    }
    if (o.bg) { const b = o.bg.buf; for (let i = 0; i < len; i++) { x[i] += o.bg.gain * b[this.bgPos]; this.bgPos = (this.bgPos + 1) % b.length; } }
    const fl = db2a(this.floorDb);
    for (let i = 0; i < len; i++) x[i] += fl * this.pink();
    if (this.fanDb !== null) {
      const a = db2a(this.fanDb);
      for (let i = 0; i < len; i++) {
        const tt = (this.n + i) / sr; const w = this.r() * 2 - 1;
        this.fl1 += 0.03 * (w - this.fl1); this.fl2 += 0.03 * (this.fl1 - this.fl2);
        x[i] += a * (11 * this.fl2 + 0.5 * Math.sin(2 * Math.PI * 118 * tt + 0.8 * Math.sin(2 * Math.PI * 0.9 * tt)) + 0.25 * Math.sin(2 * Math.PI * 236 * tt + 1));
      }
    }
    if (this.humDb !== null) {
      const a = db2a(this.humDb) * 1.2; const f = o.humHz ?? 50;
      for (let i = 0; i < len; i++) { const tt = (this.n + i) / sr; x[i] += a * (Math.sin(2 * Math.PI * f * tt) + 0.5 * Math.sin(4 * Math.PI * f * tt + 1) + 0.4 * Math.sin(6 * Math.PI * f * tt + 2) + 0.15 * Math.sin(10 * Math.PI * f * tt)); }
    }
    if (this.hpc) { const [b0, b1, a1, a2] = this.hpc; const h = this.hp; for (let i = 0; i < len; i++) { const y = b0 * x[i] + b1 * h[0] + b0 * h[1] - a1 * h[2] - a2 * h[3]; h[1] = h[0]; h[0] = x[i]; h[3] = h[2]; h[2] = y; x[i] = y; } }
    if (o.comp) {
      const ka = Math.exp(-1 / (0.005 * sr)), kr = Math.exp(-1 / (0.12 * sr));
      for (let i = 0; i < len; i++) { const p = x[i] * x[i]; this.cE = p > this.cE ? ka * this.cE + (1 - ka) * p : kr * this.cE + (1 - kr) * p; const lv = 10 * Math.log10(this.cE + 1e-14); const over = lv - o.comp.thDb; if (over > 0) x[i] *= db2a(-over * (1 - 1 / o.comp.ratio)); }
    }
    if (o.agc) {
      const k = Math.exp(-1 / (0.05 * sr));
      for (let i = 0; i < len; i++) {
        this.agcE = k * this.agcE + (1 - k) * x[i] * x[i];
        const lvl = 10 * Math.log10(this.agcE + 1e-14) + this.agcG;
        this.agcG += (lvl > o.agc.target ? -o.agc.down : o.agc.up) / sr;
        this.agcG = Math.max(-15, Math.min(o.agc.max, this.agcG));
        x[i] = Math.max(-1, Math.min(1, x[i] * db2a(this.agcG)));
      }
    }
    if (o.gate) {
      const k = Math.exp(-1 / (0.02 * sr)); const th = Math.pow(10, o.gate.thDb / 10); const att = o.gate.digital ? 0 : db2a(-(o.gate.attDb ?? 30));
      for (let i = 0; i < len; i++) {
        this.gE = k * this.gE + (1 - k) * x[i] * x[i];
        if (this.gE > th) this.gHold = Math.floor(0.15 * sr); else if (this.gHold > 0) this.gHold--;
        const tg = this.gHold > 0 ? 1 : att;
        this.gG += (tg > this.gG ? 1 / (0.008 * sr) : 1 / (0.06 * sr)) * (tg - this.gG);
        if (o.gate.digital && this.gG < 1e-3) this.gG = 0;
        x[i] *= this.gG;
      }
    }
    if (o.zeroStartSec && this.n < o.zeroStartSec * sr) for (let i = 0; i < len && this.n + i < o.zeroStartSec * sr; i++) x[i] = 0;
    return x;
  }

  private nextDt(): number {
    const hop = Math.round((HOP_MS / 1000) * this.sr); const m = this.o.timer ?? 'regular';
    // The app now analyses every 20 ms of AUDIO (AudioWorklet / ScriptProcessor / reading the
    // analyser's history), whatever its timer does; 'tick' replays the old timer-driven analysis.
    if ((this.o.delivery ?? 'hop') === 'hop' && m !== 'burst') return hop;
    if (m === 'jitter') { const u = this.r(); const ms = u < 0.75 ? 20 + (this.r() * 2 - 1) * 8 : u < 0.95 ? 30 + 25 * this.r() : 70 + 130 * this.r(); return Math.max(48, Math.round((ms / 1000) * this.sr)); }
    if (m === 'drops') { const u = this.r(); const ms = u < 0.97 ? 20 + (this.r() * 2 - 1) * 3 : 150 + 300 * this.r(); return Math.round((ms / 1000) * this.sr); }
    if (m === 'slow50') return Math.round(0.05 * this.sr);
    if (typeof m === 'number') return Math.round((m / 1000) * this.sr);
    return hop;
  }

  /** mic check: voice path + warm guitar path, like the tuner screen */
  check(sec: number) { const end = this.n + sec * this.sr; while (this.n < end) { const dt = this.nextDt(); this.sa.push(this.render(dt)); this.n += dt; if (this.n >= FRAME_SIZE) { this.sa.frame('voice', this.t); this.sa.frame('guitar', this.t); } } }

  step(): SessionView {
    const dt = this.nextDt(); const x = this.render(dt); let tNow: number;
    if (this.o.timer === 'burst') {
      const B = 1920; const p = new Float32Array(this.pend.length + x.length); p.set(this.pend); p.set(x, this.pend.length);
      const whole = Math.floor(p.length / B) * B; if (whole) this.sa.push(p.subarray(0, whole)); this.pend = p.slice(whole); this.n += dt; tNow = (this.n - this.pend.length) / this.sr;
    } else { this.sa.push(x); this.n += dt; tNow = this.t; }
    let v = this.s.view();
    if (v.phase === 'done' || this.n < FRAME_SIZE) return v;
    for (const c of this.o.changes ?? []) if (c.note === v.index && !(c as { done?: boolean }).done) { (c as { done?: boolean }).done = true; if (c.floorDb !== undefined) this.floorDb = c.floorDb; if (c.fanDb !== undefined) this.fanDb = c.fanDb; if (c.humDb !== undefined) this.humDb = c.humDb; }
    if (v.phase === 'listen') {
      this.left -= dt / this.sr;
      if (this.stage === 'delay') {
        if (tNow !== this.lastT) { this.lastT = tNow; this.sa.frame('guitar', tNow); }
        if (this.left <= 0) { const dur = v.listenKind === 'phrase' ? v.listenNotes.reduce((a, q) => a + Math.max(0.12, (q.beats * 60) / STAR_SPANGLED_BANNER.bpm), 0) : 0.9; this.stage = 'playing'; this.left = 0.06 + dur + 0.35 + 0.3 + 0.02; }
      } else if (this.left <= 0) { this.stage = 'none'; this.s.listenDone(tNow); this.stepT = this.t; v = this.s.view(); }
      return v;
    }
    if (tNow === this.lastT) return v;
    this.lastT = tNow;
    const before = v;
    const fr = this.sa.frame(this.s.listeningPath(), tNow);
    const adv = this.s.pitch(fr);
    if (process.env.TRACE && Number(process.env.TRACE) === before.index + 1 && (!process.env.TRACE_PHASE || process.env.TRACE_PHASE === before.phase)) {
      const m = (this.s as unknown as { matcher: { armed: boolean; cand: { identity: number | null; whileSinging: boolean; hum: string; done: boolean; onsetT: number } | null; startLevels: number[]; segOnset: boolean; current: { hint: string | null; cents: number | null } } | null }).matcher;
      const c = m?.cand;
      console.log(`  t=${this.t.toFixed(2)} ${before.phase} raw ${(20 * Math.log10(fr.rms + 1e-12)).toFixed(1)} clean ${(20 * Math.log10((fr.cleanRms ?? fr.rms) + 1e-12)).toFixed(1)} midi ${fr.freq ? (69 + 12 * Math.log2(fr.freq / 440)).toFixed(2) : '-'} clar ${fr.clarity.toFixed(2)} | armed ${m?.armed} start ${m?.startLevels?.map((x) => x.toFixed(0)).join(',')} segOnset ${m?.segOnset} cand ${c ? `on@${c.onsetT.toFixed(2)} id ${c.identity?.toFixed(2)} sing ${c.whileSinging} hum ${c.hum} done ${c.done}` : '-'} hint ${adv ? 'ACCEPT' : m?.current.hint} | ${this.sounding()} voice ${this.voiceOn()}`);
    }
    const h = this.s.view().match?.hint;
    if (h && !adv) { const k = `${before.phase}:${h}`; this.hintLog[k] = (this.hintLog[k] ?? 0) + 1; this.onHint?.(before.phase, h, this.t); }
    if (adv) {
      const t = this.t; let legit = false; let why = ''; let tta: number | undefined; const lp = this.lastPluck; const tg = this.sounding();
      if (before.phase === 'sing') {
        const pc = (a: number, b: number) => Math.abs(((((a - b) % 12) + 18) % 12) - 6);
        const vi = this.voiceI;
        legit = !!vi && t >= vi.t0 && (vi.stop === null || t < vi.stop + 0.3) && pc(vi.midi, before.targetMidi) < 0.5;
        if (legit) tta = (t - vi!.t0) * 1000; else why = `sing step passed without the right sung note (sounding: ${tg || 'nothing'})`;
      } else {
        const since = before.phase === 'play' ? this.stepT : this.lastAdvT;
        legit = !!lp && lp.midi === before.targetMidi && lp.t >= since - 1e-6 && t - lp.t <= 3;
        if (legit) tta = (t - lp!.t) * 1000;
        else if (lp && lp.t >= since && lp.midi !== before.targetMidi) why = `WRONG NOTE ${lp.midi - before.targetMidi > 0 ? '+' : ''}${lp.midi - before.targetMidi} st accepted ${(1000 * (t - lp.t)).toFixed(0)} ms after it (sounding ${tg})`;
        else why = `no new right pluck in this step (sounding: ${tg || 'nothing'}; voice ${this.voiceOn() ? 'on' : 'off'}; last pluck ${lp ? `${lp.midi} ${(t - lp.t).toFixed(2)} s ago` : '-'})`;
      }
      const la = this.s.lastAccepted;
      this.log.push({ t, index: before.index, phase: before.phase, pos: before.review?.pos ?? -1, target: before.targetMidi, legit, why, tta, detected: la?.detectedMidi ?? null, cents: la?.cents ?? null });
      this.lastAdvT = t; this.stepT = t;
      v = this.s.view();
      if (v.phase === 'listen') { this.stage = 'delay'; this.left = 0.7; }
    }
    return v;
  }
  run(sec: number, until?: (v: SessionView) => boolean): SessionView { let v = this.s.view(); const end = this.n + sec * this.sr; while (this.n < end) { v = this.step(); if (v.phase === 'done' || (until && until(v))) break; } return v; }
  skip() { this.s.skip(); if (this.s.view().phase === 'listen') { this.stage = 'delay'; this.left = 0.3; } }
}

// ------------------------------------------------------------------ students
export interface Style {
  name: string; female?: boolean; lo?: number;
  g?: Partial<WOpts> | ((midi: number, idx: number, r: () => number) => Partial<WOpts>);
  v?: Partial<VOpts> | ((midi: number, idx: number, r: () => number) => Partial<VOpts>);
  stringCents?: number[]; intonSd?: number;
  ring?: boolean; damp?: boolean;        // damp = mute the string before the app's next reference
  hold?: [number, number];               // voice continues this long after the sing accept
  pause?: [number, number];              // sing accept → pluck
  react?: [number, number];
  hunt?: (idx: number, target: number, r: () => number) => number[]; huntGap?: number;
  idleV?: Partial<VOpts>;
  idle?: 'humTarget' | 'humOther' | 'talk' | 'singOn';
  reviewIOI?: number; noReview?: boolean; maxNotes?: number; from?: number;
  extra?: (rig: Rig4, midi: number, idx: number) => void; // extra sound with each right pluck
  verbose?: boolean;
}
export interface Res {
  name: string; total: number; clean: number; stuckSing: number; stuckPlay: number; accidental: Adv[];
  extraPlucks: number; needPluck: number; extraBreaths: number; needBreath: number; singTta: number[]; playTta: number[];
  rev: number; revFirst: number; revStuck: number; minutes: number; hints: Record<string, number>;
  bias: { idx: number; midi: number; inSession: number; fresh: number | null }[]; falseHints: Record<string, number>;
}
const cache = new Map<string, Float32Array>();
const memo = (k: string, f: () => Float32Array) => { let b = cache.get(k); if (!b) cache.set(k, (b = f())); return b; };
const freshCache = new Map<Float32Array, number | null>();
/** what a fresh detector + matcher reads for this buffer alone in a quiet room (cents vs midi) */
export function freshRead(buf: Float32Array, midi: number, sr: number): number | null {
  if (freshCache.has(buf)) return freshCache.get(buf)!;
  const lead = Math.floor(0.6 * sr); const x = new Float32Array(lead + Math.min(buf.length, sr * 2)); const p = pinkGen(99); const a = db2a(-70);
  x.set(buf.subarray(0, x.length - lead), lead); for (let i = 0; i < x.length; i++) x[i] += a * p();
  const m = new NoteMatcher(guitarConfig(midi)); let out: number | null = null;
  analyzeBuffer(x, sr, (f) => { const s = m.push(f); if (s.accepted) { out = s.cents; return true; } }, 'guitar');
  freshCache.set(buf, out); return out;
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(6.283 * r());
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
export const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };

export function student(st: Style, ro: RoomOpts = {}): Res {
  const rig = new Rig4({ ...ro, settings: { ...(ro.settings ?? {}), ...(st.noReview ? { phraseReview: false } : {}) } });
  const sr = rig.sr; const r = rng(4242 + (ro.seed ?? 0));
  const res: Res = { name: st.name, total: 0, clean: 0, stuckSing: 0, stuckPlay: 0, accidental: [], extraPlucks: 0, needPluck: 0, extraBreaths: 0, needBreath: 0, singTta: [], playTta: [], rev: 0, revFirst: 0, revStuck: 0, minutes: 0, hints: {}, bias: [], falseHints: {} };
  const U = (a: [number, number]) => a[0] + (a[1] - a[0]) * r();
  const lo = st.lo ?? (st.female ? 55 : 43); const fold = (m: number) => { while (m >= lo + 12) m -= 12; while (m < lo) m += 12; return m; };
  let logPos = 0; let lastBuf: Float32Array | null = null;
  rig.onHint = (phase, hint, t) => {
    const lp = rig.lastPluck; const sincePluck = lp ? t - lp.t : 99; const vo = rig.voiceOn();
    let bad: string | null = null;
    if (phase === 'play' && hint === 'sustained' && !vo && sincePluck < 2) bad = 'play:"sounded like humming" after a real pluck, no voice';
    if (phase === 'play' && hint === 'noAttack' && !vo && (!rig.voiceI || rig.voiceI.stop === null || t > rig.voiceI.stop + 0.4)) bad = 'play:"stop singing" while nobody sings';
    if (phase === 'play' && hint === 'ringing' && vo) bad = 'play:"still ringing" while it is the voice';
    if (phase === 'sing' && hint === 'carryOver' && vo && t - (rig.voiceI?.t0 ?? t) > 0.6) bad = 'sing:"guitar still ringing — now sing" while singing ≥0.6 s';
    if (phase === 'review' && hint === 'sustained') bad = 'review:"humming"';
    if (bad) res.falseHints[bad] = (res.falseHints[bad] ?? 0) + 1;
  };
  const gbuf = (midi: number, idx: number, k: number, extra: Partial<WOpts> = {}): { buf: Float32Array; s: number; cents: number } => {
    const { s, fret } = stringFor(midi);
    const go = typeof st.g === 'function' ? st.g(midi, idx, r) : (st.g ?? {});
    const cents = (st.stringCents?.[s] ?? 0) + (fret > 0 ? 3 : 0);
    const o: WOpts = { sr, seed: midi * 7 + (k % 4), cents, ...go, ...extra };
    return { s, cents, buf: memo(`g${midi}|${JSON.stringify(o)}`, () => wg(midi, 3.2, o)) };
  };
  const pluck = (midi: number, target: number, idx: number, k: number, extra: Partial<WOpts> = {}) => {
    const g = gbuf(midi, idx, k, extra);
    if (st.ring === false) rig.stop((e) => e.tag === 'g', 40);
    rig.play(g.buf, 'g', midi, g.s); rig.lastPluck = { midi, t: rig.t, nominal: g.cents }; lastBuf = g.buf;
    if (midi === target && st.extra) st.extra(rig, midi, idx);
  };
  const drain = () => { for (; logPos < rig.log.length; logPos++) { const a = rig.log[logPos]; if (!a.legit) res.accidental.push(a); else if (a.tta !== undefined) { if (a.phase === 'sing') res.singTta.push(a.tta); else if (a.phase === 'play') { res.playTta.push(a.tta); if (lastBuf && a.cents !== null) res.bias.push({ idx: a.index, midi: a.target, inSession: a.cents - (rig.lastPluck?.nominal ?? 0), fresh: (() => { const f = freshRead(lastBuf!, a.target, sr); return f === null ? null : f - (rig.lastPluck?.nominal ?? 0); })() }); } } } };

  // mic check
  if (!ro.noCheck) { rig.check(ro.checkSec ?? 2.5); if (ro.checkPluck !== false) { rig.play(wg(52, 2.5, { sr, seed: 1 }), 'g', 52, 2); rig.check(1.6); } }
  rig.begin(st.from ?? 0);
  const max = st.maxNotes ?? 101; const t0 = rig.t;
  let v = rig.run(8, (q) => q.phase !== 'listen');
  while (v.phase !== 'done' && res.total < max) {
    const idx = v.index; const target = v.targetMidi; res.total++;
    const accBefore = res.accidental.length; let clean = true;
    // ---- sing
    if (v.phase === 'sing') {
      let ok = false;
      for (let attempt = 0; attempt < 4 && !ok; attempt++) {
        rig.run(U(st.react ?? [0.25, 0.7]), (q) => q.phase !== 'sing' || q.index !== idx);
        if (rig.s.view().phase !== 'sing' || rig.s.view().index !== idx) { ok = true; break; }
        const sm = fold(target); const vo = typeof st.v === 'function' ? st.v(sm, idx, r) : (st.v ?? {});
        const cents = (st.intonSd ?? 12) * gauss(r);
        const o: VOpts = { sr, female: st.female, seed: idx * 5 + attempt, cents: Math.round(Math.max(-35, Math.min(35, cents))), ...vo };
        const vb = memo(`v${sm}|${JSON.stringify(o)}`, () => voice(sm, 3.4, o));
        rig.play(vb, 'v', sm); rig.voiceI = { midi: sm, t0: rig.t, stop: null };
        const q = rig.run(3.2, (w) => w.phase !== 'sing' || w.index !== idx);
        ok = q.phase !== 'sing' || q.index !== idx;
        if (!ok) { rig.stop((e) => e.tag === 'v', 80); rig.voiceI.stop = rig.t; res.extraBreaths++; clean = false; rig.run(0.7, (w) => w.phase !== 'sing'); }
      }
      if (res.extraBreaths && !clean) res.needBreath++;
      if (!ok) { res.stuckSing++; if (st.verbose) console.log(`   STUCK sing note ${idx + 1} target ${target}`); drain(); rig.stop(() => true, 50); rig.skip(); v = rig.run(8, (q) => q.phase !== 'listen'); continue; }
      drain();
    }
    v = rig.s.view();
    // ---- play
    if (v.phase === 'play' && v.index === idx) {
      const hold = U(st.hold ?? [0.1, 0.45]); const pause = Math.max(U(st.pause ?? [0.5, 1.3]), 0.15);
      const stopVoiceAt = rig.t + (st.idle === 'singOn' ? pause + 0.6 : hold);
      const untilT = rig.t + pause; let stopped = false;
      const tickTo = (tEnd: number) => { while (rig.t < tEnd) { if (!stopped && rig.t >= stopVoiceAt) { rig.stop((e) => e.tag === 'v', 90); if (rig.voiceI) rig.voiceI.stop = rig.t; stopped = true; } const q = rig.step(); if (q.phase !== 'play' || q.index !== idx) return true; } return false; };
      let done = tickTo(Math.min(untilT, stopVoiceAt + 0.01));
      if (!done && st.idle && st.idle !== 'singOn') {
        // idle sound between the sung answer and the pluck
        tickTo(stopVoiceAt + 0.25);
        const sm = fold(target);
        const ib = st.idle === 'talk' ? memo(`talk${idx % 7}${st.female}`, () => babble(2.2, { sr, seed: idx % 7, female: st.female, levelDb: -22 }))
          : memo(`hum${st.idle}${sm}${idx % 3}${JSON.stringify(st.idleV ?? {}).length}${st.name}`, () => voice(st.idle === 'humTarget' ? sm : sm + [2, -3, 5][idx % 3], 1.6, { sr, female: st.female, vowel: 'm', levelDb: -24, seed: idx, scoop: -60, ...(st.idleV ?? {}) }));
        rig.play(ib, 'idle', -1); done = tickTo(rig.t + (st.idle === 'talk' ? 2.0 : 1.5)); rig.stop((e) => e.tag === 'idle', 60); if (!done) done = tickTo(rig.t + 0.35);
      } else if (!done) done = tickTo(untilT);
      if (!done) {
        const wrongs = st.hunt ? st.hunt(idx, target, r) : [];
        for (const w of wrongs) { pluck(target + w, target, idx, 0); if (tickTo(rig.t + (st.huntGap ?? 0.9))) { done = true; break; } }
      }
      let k = 0;
      while (!done && k < 4) {
        pluck(target, target, idx, k);
        done = tickTo(rig.t + 2.2);
        if (!done) { res.extraPlucks++; clean = false; }
        k++;
      }
      if (k > 1) { res.needPluck++; if (st.verbose) console.log(`   note ${idx + 1} target ${target} needed ${k} plucks (t=${rig.t.toFixed(1)})`); }
      if (!stopped) { rig.stop((e) => e.tag === 'v', 90); if (rig.voiceI) rig.voiceI.stop = rig.t; }
      if (!done) { res.stuckPlay++; if (st.verbose) console.log(`   STUCK play note ${idx + 1} target ${target} t=${rig.t.toFixed(1)}`); drain(); rig.skip(); v = rig.run(8, (q) => q.phase !== 'listen'); continue; }
      drain();
    }
    v = rig.s.view();
    // ---- review
    if (v.phase === 'review') {
      const notes = v.review!.notes; const ioi = st.reviewIOI ?? 0.6;
      rig.run(0.5, (q) => q.phase !== 'review');
      for (let p = 0; p < notes.length && rig.s.view().phase === 'review'; p++) {
        let ok = false; res.rev++;
        for (let k = 0; k < 4 && !ok; k++) {
          pluck(notes[p], notes[p], idx, k);
          const q = rig.run(k === 0 ? ioi : Math.max(ioi, 1.0), (w) => w.phase !== 'review' || (w.review?.pos ?? 99) > p);
          ok = q.phase !== 'review' || (q.review?.pos ?? 99) > p;
          if (ok && k === 0) res.revFirst++;
          // finish the inter-onset interval before the next note
          if (ok && rig.s.view().phase === 'review') { const rest = rig.lastPluck!.t + ioi - rig.t; if (rest > 0) rig.run(rest, (w) => w.phase !== 'review' || (w.review?.pos ?? 0) > p + 1); }
        }
        if (!ok) { res.revStuck++; rig.skip(); break; }
      }
      drain();
    }
    if (st.damp) rig.stop((e) => e.tag === 'g', 50);
    if (clean && res.accidental.length === accBefore) res.clean++;
    v = rig.run(10, (q) => q.phase !== 'listen');
    drain();
  }
  res.minutes = (rig.t - t0) / 60; res.hints = rig.hintLog; (res as Res & { rig?: Rig4 }).rig = rig;
  return res;
}

export function report(x: Res): string {
  const b = x.bias.filter((q) => q.fresh !== null); const third = (a: number, c: number) => b.filter((q) => q.idx >= a && q.idx < c).map((q) => q.inSession - (q.fresh as number));
  const bs = (xs: number[]) => xs.length ? `${med(xs).toFixed(1)} (max |${Math.max(...xs.map(Math.abs)).toFixed(1)}|)` : '-';
  return `${x.name.padEnd(26)} notes ${x.total} clean ${x.clean} | stuck sing ${x.stuckSing} play ${x.stuckPlay} | extra plucks ${x.extraPlucks} on ${x.needPluck} notes, extra breaths ${x.extraBreaths} | ACCIDENTAL ${x.accidental.length} | sing med ${med(x.singTta).toFixed(0)} ms, play med ${med(x.playTta).toFixed(0)} p90 ${pct(x.playTta, 0.9).toFixed(0)} ms | review first-try ${x.revFirst}/${x.rev} stuck ${x.revStuck} | ${x.minutes.toFixed(1)} min\n   bias in-session−fresh (c) notes 0-33: ${bs(third(0, 34))}  34-66: ${bs(third(34, 67))}  67-101: ${bs(third(67, 102))}\n   hints ${JSON.stringify(x.hints)}\n   false hints ${JSON.stringify(x.falseHints)}${x.accidental.slice(0, 6).map((a) => `\n   !! note ${a.index + 1} ${a.phase}: ${a.why}`).join('')}`;
}
