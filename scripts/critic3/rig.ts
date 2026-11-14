// Ported from the third external review (independent synthesis and session rig), kept as a permanent test.
// Critic-3 rig: a simulated microphone (mixer + room + phone chain + browser-like timer) driving the
// real StreamAnalyzer + Session, mirroring src/main.ts timing (700 ms gap, reference playback with
// dropped frames, 300 ms tail).
import { FRAME_SIZE, HOP_MS, StreamAnalyzer } from '../../src/core/engine.ts';
import { Session, type SessionView } from '../../src/core/session.ts';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings.ts';
import { STAR_SPANGLED_BANNER } from '../../src/core/songs.ts';
import { db2a, rng } from './synth.ts';

export interface RigOpts {
  sr?: number;
  settings?: Partial<Settings>;
  floorDb?: number;
  fanDb?: number;
  humDb?: number; humHz?: number;
  bg?: { buf: Float32Array; db: number }; // looped background (TV / talker), rms dB
  reverb?: { rt60: number; wet: number };
  hpHz?: number;
  agc?: { slew: number; max: number; target?: number };
  gate?: { thDb: number; attDb: number };
  timer?: 'regular' | 'jitter' | 'jitterMild' | 'burst20' | 'burst40' | 'slow40';
  seed?: number;
}
interface Ev { buf: Float32Array; start: number; stop: number | null; fade: number; tag: string; midi: number; string: number; gain: number }
export interface Adv { t: number; index: number; phase: string; reviewPos: number; target: number; legit: boolean; why: string; tta?: number; detected: number | null }

export class Rig {
  s: Session; sa: StreamAnalyzer; sr: number; n = 0; evs: Ev[] = []; log: Adv[] = []; o: RigOpts;
  r: () => number;
  // listen modelling
  private listenStage: 'none' | 'delay' | 'playing' = 'none'; private listenLeft = 0;
  // student intent (for judging advances)
  voice: { midi: number; t0: number } | null = null;
  lastPluck: { midi: number; t: number } | null = null;
  rightPluckT: number | null = null;
  // noise/phone state
  private fanLp = 0; private fanLp2 = 0; private bgPos = 0;
  private hp: number[] = [0, 0, 0, 0, 0, 0, 0, 0]; private hpc: number[] | null = null;
  private agcG = 0; private agcE = 0; private gateG = 1; private gateE = 0; private gateHold = 0;
  private combs: { buf: Float32Array; pos: number; g: number }[] = []; private aps: { buf: Float32Array; pos: number }[] = [];
  private pending = new Float32Array(0);
  frames = 0;

  constructor(o: RigOpts = {}) {
    this.o = o; this.sr = o.sr ?? 48000; this.r = rng(o.seed ?? 4711);
    this.sa = new StreamAnalyzer(this.sr);
    this.s = new Session(STAR_SPANGLED_BANNER, 48, { ...DEFAULT_SETTINGS, playKeyAtStart: false, ...(o.settings ?? {}) });
    this.s.start(0);
    this.enterListen(0.4);
    if (o.hpHz) {
      const w = (2 * Math.PI * o.hpHz) / this.sr, q = 0.707, al = Math.sin(w) / (2 * q), cw = Math.cos(w), a0 = 1 + al;
      this.hpc = [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, (-2 * cw) / a0, (1 - al) / a0];
    }
    if (o.reverb) {
      for (const d of [0.0297, 0.0371, 0.0411, 0.0437]) this.combs.push({ buf: new Float32Array(Math.floor(d * this.sr)), pos: 0, g: Math.pow(10, (-3 * d) / o.reverb.rt60) });
      for (const d of [0.005, 0.0017]) this.aps.push({ buf: new Float32Array(Math.floor(d * this.sr)), pos: 0 });
    }
  }
  get t() { return this.n / this.sr; }

  play(buf: Float32Array, tag: string, midi: number, string = -1, gain = 1) {
    if (string >= 0) for (const e of this.evs) if (e.string === string && e.stop === null) { e.stop = this.n; e.fade = Math.floor(0.012 * this.sr); }
    this.evs.push({ buf, start: this.n, stop: null, fade: 0, tag, midi, string, gain });
  }
  stop(pred: (e: Ev) => boolean, fadeMs = 60) { for (const e of this.evs) if (e.stop === null && pred(e)) { e.stop = this.n; e.fade = Math.floor((fadeMs / 1000) * this.sr); } }
  tags(): string[] { return [...new Set(this.evs.filter((e) => this.n < e.start + e.buf.length && (e.stop === null || this.n < e.stop + e.fade)).map((e) => e.tag))]; }

  private enterListen(delay: number) { this.listenStage = 'delay'; this.listenLeft = delay; }

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
    if (o.bg) { const b = o.bg.buf; for (let i = 0; i < len; i++) { x[i] += b[this.bgPos]; this.bgPos = (this.bgPos + 1) % b.length; } }
    if (o.reverb) {
      for (let i = 0; i < len; i++) {
        let acc = 0;
        for (const c of this.combs) { const y = c.buf[c.pos]; c.buf[c.pos] = x[i] + c.g * y; c.pos = (c.pos + 1) % c.buf.length; acc += y; }
        acc *= 0.25;
        for (const a of this.aps) { const d = a.buf[a.pos]; const y = -0.7 * acc + d; a.buf[a.pos] = acc + 0.7 * y; a.pos = (a.pos + 1) % a.buf.length; acc = y; }
        x[i] += o.reverb.wet * acc;
      }
    }
    const fl = db2a(o.floorDb ?? -62) * Math.sqrt(3);
    for (let i = 0; i < len; i++) x[i] += fl * (this.r() * 2 - 1);
    if (o.fanDb !== undefined) {
      const a = db2a(o.fanDb);
      for (let i = 0; i < len; i++) {
        const tt = (this.n + i) / sr;
        this.fanLp += 0.04 * ((this.r() * 2 - 1) - this.fanLp); this.fanLp2 += 0.04 * (this.fanLp - this.fanLp2);
        x[i] += a * (9.5 * this.fanLp2 + 0.35 * Math.sin(2 * Math.PI * 93 * tt + 0.6 * Math.sin(2 * Math.PI * 0.7 * tt)) + 0.2 * Math.sin(2 * Math.PI * 186 * tt));
      }
    }
    if (o.humDb !== undefined) {
      const a = db2a(o.humDb) * 1.15; const f = o.humHz ?? 60;
      for (let i = 0; i < len; i++) { const tt = (this.n + i) / sr; x[i] += a * (Math.sin(2 * Math.PI * f * tt) + 0.6 * Math.sin(2 * Math.PI * 2 * f * tt + 1) + 0.5 * Math.sin(2 * Math.PI * 3 * f * tt + 2) + 0.2 * Math.sin(2 * Math.PI * 5 * f * tt)); }
    }
    // phone chain
    if (this.hpc) {
      const [b0, b1, b2, a1, a2] = this.hpc; const h = this.hp;
      for (let i = 0; i < len; i++) { const y = b0 * x[i] + b1 * h[0] + b2 * h[1] - a1 * h[2] - a2 * h[3]; h[1] = h[0]; h[0] = x[i]; h[3] = h[2]; h[2] = y; x[i] = y; }
    }
    if (o.gate) {
      const k = Math.exp(-1 / (0.02 * sr)); const att = db2a(-o.gate.attDb); const th = Math.pow(10, o.gate.thDb / 10);
      for (let i = 0; i < len; i++) {
        this.gateE = k * this.gateE + (1 - k) * x[i] * x[i];
        if (this.gateE > th) this.gateHold = Math.floor(0.12 * sr); else if (this.gateHold > 0) this.gateHold--;
        const tgt = this.gateHold > 0 ? 1 : att;
        this.gateG += (tgt > this.gateG ? 1 / (0.01 * sr) : 1 / (0.08 * sr)) * (tgt - this.gateG);
        x[i] *= this.gateG;
      }
    }
    if (o.agc) {
      const k = Math.exp(-1 / (0.03 * sr)); const target = o.agc.target ?? -20;
      for (let i = 0; i < len; i++) {
        this.agcE = k * this.agcE + (1 - k) * x[i] * x[i];
        const lvl = 10 * Math.log10(Math.max(this.agcE, 1e-12)) + this.agcG;
        if (lvl > target) this.agcG -= 40 / sr; else if (lvl > -65 + this.agcG * 0) this.agcG += o.agc.slew / sr;
        this.agcG = Math.max(-12, Math.min(o.agc.max, this.agcG));
        x[i] = Math.max(-1, Math.min(1, x[i] * db2a(this.agcG)));
      }
    }
    return x;
  }

  /** samples until the next timer tick */
  private nextDt(): number {
    const hop = Math.round((HOP_MS / 1000) * this.sr);
    const m = this.o.timer ?? 'regular';
    if (m === 'jitter') {
      const u = this.r();
      const ms = u < 0.8 ? 20 + (this.r() * 2 - 1) * 7 : u < 0.96 ? 30 + 18 * this.r() : 80 + 170 * this.r();
      return Math.max(64, Math.round((ms / 1000) * this.sr));
    }
    if (m === 'jitterMild') { const u = this.r(); const ms = u < 0.9 ? 20 + (this.r() * 2 - 1) * 4 : u < 0.995 ? 28 + 12 * this.r() : 80 + 70 * this.r(); return Math.max(64, Math.round((ms / 1000) * this.sr)); }
    if (m === 'slow40') return hop * 2;
    return hop;
  }

  /** advance one timer tick; returns the view */
  step(): SessionView {
    const dt = this.nextDt();
    const x = this.render(dt);
    const m = this.o.timer ?? 'regular';
    let tNow: number;
    if (m === 'burst20' || m === 'burst40') {
      // audio reaches the analyser only in whole hardware bursts; currentTime advances with them
      const B = Math.round(((m === 'burst20' ? 0.0213 : 0.04) * this.sr) / 128) * 128;
      const p = new Float32Array(this.pending.length + x.length); p.set(this.pending); p.set(x, this.pending.length);
      const whole = Math.floor(p.length / B) * B;
      if (whole) this.sa.push(p.subarray(0, whole));
      this.pending = p.slice(whole);
      this.n += dt;
      tNow = (this.n - this.pending.length) / this.sr;
    } else {
      this.sa.push(x); this.n += dt; tNow = this.t;
    }
    let v = this.s.view();
    if (v.phase === 'done' || this.n < FRAME_SIZE) return v;
    if (v.phase === 'listen') {
      this.listenLeft -= dt / this.sr;
      if (this.listenStage === 'delay') {
        if (!process.env.NO_DELAY_FRAMES) this.sa.frame('guitar', tNow); // main.ts: the tick still runs the guitar detector, session ignores it
        if (this.listenLeft <= 0) {
          const dur = v.listenKind === 'phrase' ? v.listenNotes.reduce((a, q) => a + Math.max(0.12, (q.beats * 60) / 84), 0) : 0.9;
          this.listenStage = 'playing'; this.listenLeft = 0.06 + dur + 0.35 + 0.3 + 0.02;
        }
      } else if (this.listenLeft <= 0) { this.listenStage = 'none'; this.s.listenDone(tNow); v = this.s.view(); }
      return v;
    }
    const before = v;
    this.frames++;
    const adv = this.s.pitch(this.sa.frame(this.s.listeningPath(), tNow));
    if (adv) {
      const t = this.t; let legit = false; let why = ''; let tta: number | undefined;
      const tg = this.tags().join('+');
      if (before.phase === 'sing') {
        const pc = (a: number, b: number) => Math.abs((((a - b) % 12) + 18) % 12 - 6);
        legit = !!this.voice && pc(this.voice.midi, before.targetMidi) < 0.5 && t - this.voice.t0 >= -0.6;
        if (legit) tta = (t - this.voice!.t0) * 1000;
        why = legit ? 'voice' : `sing passed without the sung note (sounding: ${tg}; voice ${this.voice ? this.voice.midi : '-'})`;
      } else {
        const rp = this.rightPluckT;
        const lp = this.lastPluck;
        if (before.phase === 'play') {
          legit = rp !== null && t - rp >= 0.02 && t - rp <= 3 && (!lp || lp.midi === before.targetMidi);
          if (legit) tta = (t - rp!) * 1000;
        } else {
          legit = !!lp && lp.midi === before.targetMidi && t - lp.t <= 3;
          if (legit) tta = (t - lp!.t) * 1000;
        }
        if (!legit) {
          if (lp && t - lp.t < 3 && lp.midi !== before.targetMidi) why = `WRONG NOTE ${lp.midi - before.targetMidi >= 0 ? '+' : ''}${lp.midi - before.targetMidi} st accepted ${(1000 * (t - lp.t)).toFixed(0)} ms after it (sounding ${tg})`;
          else why = `no right pluck (sounding: ${tg || 'nothing'}; voice ${this.voice ? this.voice.midi : '-'})`;
        }
      }
      this.log.push({ t, index: before.index, phase: before.phase, reviewPos: before.review?.pos ?? -1, target: before.targetMidi, legit, why, tta, detected: this.s.lastAccepted?.detectedMidi ?? null });
      v = this.s.view();
      if (v.phase === 'listen') this.enterListen(0.7);
      if (before.phase !== 'review' || v.phase !== 'review') { /* per-step intent resets are done by the student */ }
    }
    return v;
  }
  run(sec: number, until?: (v: SessionView) => boolean): SessionView {
    let v = this.s.view(); const end = this.n + sec * this.sr;
    while (this.n < end) { v = this.step(); if (v.phase === 'done' || (until && until(v))) break; }
    return v;
  }
  skip() { this.s.skip(); if (this.s.view().phase === 'listen') this.enterListen(0.3); }
}
