// Turns a stream of raw pitch detections into "the student produced the target note" decisions.
// Pure TypeScript, no DOM.
//
// Design priorities (in this order):
//  (a) an honest student must never get stuck (no false rejects),
//  (b) an honest student must never be advanced by accident (their own sung answer must not
//      pass the guitar step, a wrong note / wrong octave must not pass, a note still ringing
//      from the previous step must not pass the next one),
//  (c) catching deliberate gaming (humming instead of playing) is lowest priority.
//
// So the default rules are simple physical gates, not timbre classification:
//
//  * 'sung'    — the pitch is smoothed with a two-stage moving average (≈320 ms triangular
//                window, which cancels 4.5–6 Hz vibrato of any width); the smoothed centre must
//                be inside the tolerance and have stopped moving (a glide is not a held note).
//                The only level rule: a sound that was already there when the step opened, at
//                the pitch of the previous (possibly still ringing) note, must not be dying away.
//  * 'plucked' — a NEW attack (level jump, or a clean jump to a new pitch for hammer-ons/
//                legato) opens a candidate; the note's identity is read from the first steady
//                window after that attack and is locked: a later octave flip of the detector (a
//                dying note, hum) cannot turn it into a different note. A sound that has no
//                attack of its own — the tail of the sung answer, a note still ringing — never
//                opens a candidate.
//
// `strict` ("strict instrument check" setting, off by default) adds envelope-shape tests: sung
// notes must not decay like a string, plucked notes must decay freely after the attack.
import { centsFromMidi, centsFromPitchClass, freqToMidi, midiToFreq } from './music.ts';
import { periodicityAt, rmsToDb } from './pitch.ts';

/** One analysed frame: time in seconds plus the detector output. */
export interface PitchFrame {
  t: number;
  freq: number;
  clarity: number;
  rms: number;
  /** NSDF height at half the detected period, 0 if unknown. */
  upClarity?: number;
  /** Level after stationary-noise removal; falls back to rms. */
  cleanRms?: number;
  /** NSDF of the frame (lag in samples) and the sample rate, for periodicity checks. */
  nsdf?: Float32Array;
  sr?: number;
}

export type MatchMode = 'pitchClass' | 'exact';
export type SourceKind = 'sung' | 'plucked';

export interface MatchConfig {
  targetMidi: number;
  /** 'pitchClass' = any octave counts; 'exact' = same octave. */
  mode: MatchMode;
  toleranceCents: number;
  kind: SourceKind;
  /** Strict instrument check: envelope-shape tests (off by default). */
  strict: boolean;
  /** Minimum NSDF clarity for a frame to count as voiced. */
  minClarity: number;
  /** Minimum frame level (dBFS, after noise removal) for a frame to count as voiced. */
  minDb: number;
  /** An unvoiced gap shorter than this does not break a sung note. */
  graceMs: number;
  /** A held/plucked wrong note equal to this (rounded) MIDI note is not counted as a wrong attempt. */
  ignoreMidi?: number;

  // ---- sung
  smoothMs: number;
  trendMs: number;
  maxTrendCents: number;
  jumpCents: number;
  holdMs: number;
  /** Exact pitch that may still be ringing from the previous step (guards carry-over). */
  carryMidi?: number;
  /** Strict mode: level slope over the hold window must be above this (dB/s). */
  minDbSlope: number;

  // ---- plucked
  /** Level rise (dB) over the previous ~100 ms that counts as a new attack. */
  onsetRiseDb: number;
  /** Length of the steady-pitch window read after the attack. */
  pitchWindowMs: number;
  /** Max difference between the means of the two halves of that window (slides vs vibrato). */
  maxStepCents: number;
  /** A candidate must be identified within this time after its attack. */
  maxIdentityMs: number;
  /** Strict mode: free-decay check segments. */
  decaySegMs: number;
  minSegDecayDb: number;
  /** Analyse but never accept (gauntlet octave scans). */
  neverAccept?: boolean;
}

const COMMON = {
  minDb: -78,
  graceMs: 80,
  ignoreMidi: undefined,
  smoothMs: 160,
  trendMs: 180,
  maxTrendCents: 14,
  jumpCents: 200,
  holdMs: 500,
  minDbSlope: -5,
  onsetRiseDb: 6,
  pitchWindowMs: 120,
  maxStepCents: 30,
  maxIdentityMs: 800,
  decaySegMs: 100,
  minSegDecayDb: 0.4,
};

export const SUNG_DEFAULTS: Omit<MatchConfig, 'targetMidi' | 'toleranceCents' | 'mode'> = {
  ...COMMON,
  kind: 'sung',
  strict: false,
  minClarity: 0.7,
};

export const PLUCKED_DEFAULTS: Omit<MatchConfig, 'targetMidi' | 'toleranceCents' | 'mode'> = {
  ...COMMON,
  kind: 'plucked',
  strict: false,
  minClarity: 0.55,
};

export type MatchHint =
  /** guitar step: the right pitch is sounding but nothing was plucked (a voice, or a note still ringing) */
  | 'noAttack'
  /** guitar step: the plucked note is the right note in the wrong octave */
  | 'octaveHigh'
  | 'octaveLow'
  /** pitch still gliding/sliding */
  | 'moving'
  /** singing step: the guitar note from the previous step is still ringing */
  | 'carryOver'
  /** strict mode only */
  | 'sustained'
  | 'decaying';

export interface MatchState {
  voiced: boolean;
  stable: boolean;
  /** Detected pitch as fractional MIDI (for the meter), or null. */
  detectedMidi: number | null;
  /** Deviation from the target in cents (octave-folded in pitchClass mode), or null. */
  cents: number | null;
  inTolerance: boolean;
  progress: number;
  accepted: boolean;
  acceptedAt: number | null;
  meanAbsCents: number | null;
  wrongAttempts: number;
  hint: MatchHint | null;
}

interface Rec {
  t: number;
  db: number;
  clarity: number;
  midi: number | null;
  up: number;
  nsdf?: Float32Array;
  sr?: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function slope(ts: number[], ys: number[]): number {
  const n = ts.length;
  if (n < 2) return 0;
  let st = 0, sy = 0, stt = 0, sty = 0;
  for (let i = 0; i < n; i++) {
    st += ts[i]; sy += ys[i]; stt += ts[i] * ts[i]; sty += ts[i] * ys[i];
  }
  const d = n * stt - st * st;
  return d === 0 ? 0 : (n * sty - st * sy) / d;
}

interface Candidate {
  onsetT: number;
  peakT: number;
  peakDb: number;
  /** pitched sound sounding just before the attack (a ringing note), if any */
  preMidi: number | null;
  /** frames just before the attack, for "what changed" periodicity checks */
  pre: Rec[];
  identity: number | null;
  lastWindowMidi: number | null;
  done: boolean;
  counted: boolean;
  decay: 'pending' | 'confirmed' | 'rejected';
}

export class NoteMatcher {
  readonly cfg: MatchConfig;
  private hist: Rec[] = [];
  private state: MatchState;
  private firstT: number | null = null;
  // sung
  private seg: { t: number; c: number; db: number }[] = [];
  private sm1: { t: number; v: number }[] = [];
  private sm2: { t: number; v: number }[] = [];
  private segFirstT: number | null = null;
  private segOnset = false;
  private lastVoicedT = -Infinity;
  private lastCountedWrong: number | null = null;
  // plucked
  private cand: Candidate | null = null;
  private lastOnsetT = -Infinity;

  constructor(cfg: MatchConfig) {
    this.cfg = cfg;
    this.state = {
      voiced: false, stable: false, detectedMidi: null, cents: null, inTolerance: false,
      progress: 0, accepted: false, acceptedAt: null, meanAbsCents: null, wrongAttempts: 0, hint: null,
    };
  }

  get current(): MatchState {
    return this.state;
  }

  /** Deviation of a pitch from the target in cents (folded to the nearest octave in pitchClass mode). */
  deviation(midi: number): number {
    const freq = midiToFreq(midi);
    return this.cfg.mode === 'exact' ? centsFromMidi(freq, this.cfg.targetMidi) : centsFromPitchClass(freq, this.cfg.targetMidi);
  }

  push(f: PitchFrame): MatchState {
    if (this.state.accepted) return this.state;
    const c = this.cfg;
    this.firstT ??= f.t;
    const db = rmsToDb(f.cleanRms ?? f.rms);
    const voiced = f.freq > 0 && f.clarity >= c.minClarity && db >= c.minDb && f.freq >= 55 && f.freq <= 1700;
    const midi = voiced ? freqToMidi(f.freq) : null;
    this.hist.push({ t: f.t, db, clarity: f.clarity, midi, up: f.upClarity ?? 0, nsdf: f.nsdf, sr: f.sr });
    while (this.hist.length && this.hist[0].t < f.t - 2.5) this.hist.shift();
    // keep the (large) NSDF copies only for the last ~0.6 s
    for (let i = this.hist.length - 1; i >= 0 && this.hist[i].t >= f.t - 0.8; i--) {
      if (this.hist[i].t < f.t - 0.6) this.hist[i].nsdf = undefined;
    }
    this.state = c.kind === 'sung' ? this.pushSung(f, db, midi) : this.pushPlucked(f, db, midi);
    return this.state;
  }

  private displayMidi(): number | null {
    // The meter is stricter than the decision gate for plucked notes: weak-clarity frames (a
    // dying note mixed with hum) are where sub-octave misreads happen.
    const minClar = this.cfg.kind === 'plucked' ? 0.8 : 0;
    let recent = this.hist.slice(-3).filter((r) => r.clarity >= minClar).map((r) => r.midi).filter((m): m is number => m !== null);
    const g = this.cand && !this.cand.done ? this.cand.identity : null;
    if (this.cfg.kind === 'plucked' && g !== null) {
      recent = recent.filter((m) => ![7, 12, 19, 24].some((iv) => Math.abs(Math.abs(m - g) - iv) < 0.6));
    }
    return recent.length ? median(recent) : null;
  }

  // ------------------------------------------------------------------ sung

  private resetSeg(): void {
    this.seg = [];
    this.sm1 = [];
    this.sm2 = [];
    this.segFirstT = null;
  }

  private pushSung(f: PitchFrame, db: number, midi: number | null): MatchState {
    const c = this.cfg;
    const s = this.state;
    if (midi === null) {
      if ((f.t - this.lastVoicedT) * 1000 > c.graceMs) {
        this.resetSeg();
        return { ...s, voiced: false, stable: false, detectedMidi: null, cents: null, inTolerance: false, progress: 0, hint: null };
      }
      return { ...s, voiced: false };
    }
    this.lastVoicedT = f.t;
    let cents = this.deviation(midi);
    if (c.mode === 'pitchClass' && this.seg.length) {
      const prev = this.seg[this.seg.length - 1].c;
      while (cents - prev > 600) cents -= 1200;
      while (prev - cents > 600) cents += 1200;
    }
    if (this.seg.length && Math.abs(cents - this.seg[this.seg.length - 1].c) > c.jumpCents) this.resetSeg();
    if (!this.seg.length) {
      this.segFirstT = f.t;
      // Did this note start with an attack inside this step, or was it already sounding?
      const prior = this.hist.filter((r) => r.t < f.t - 1e-6 && r.t >= f.t - 0.4);
      this.segOnset = prior.length > 0 && db - Math.min(...prior.map((r) => r.db)) >= 6;
    }
    this.seg.push({ t: f.t, c: cents, db });
    const horizon = f.t - (c.holdMs + 200) / 1000;
    while (this.seg.length && this.seg[0].t < horizon) this.seg.shift();

    const w = c.smoothMs / 1000;
    const in1 = this.seg.filter((p) => p.t > f.t - w);
    const v1 = mean(in1.map((p) => p.c));
    this.sm1.push({ t: f.t, v: v1 });
    while (this.sm1.length && this.sm1[0].t < horizon) this.sm1.shift();
    const in2 = this.sm1.filter((p) => p.t > f.t - w);
    const v2 = mean(in2.map((p) => p.v));
    this.sm2.push({ t: f.t, v: v2 });
    while (this.sm2.length && this.sm2[0].t < horizon) this.sm2.shift();

    const age = (f.t - (this.segFirstT ?? f.t)) * 1000;
    const settledAge = Math.max(2 * c.smoothMs + c.trendMs, c.holdMs);
    const inTolNow = Math.abs(v2) <= c.toleranceCents;

    let hint: MatchHint | null = null;
    let accepted = false;
    let wrong = s.wrongAttempts;
    let meanAbs: number | null = null;
    if (age >= settledAge - 10) {
      const old = this.sm2.find((p) => p.t >= f.t - c.trendMs / 1000 - 1e-6);
      const trend = old ? Math.abs(v2 - old.v) : Infinity;
      const win = this.seg.filter((p) => p.t > f.t - c.holdMs / 1000);
      const span = this.hist.filter((r) => r.t > f.t - c.holdMs / 1000);
      const voicedFrac = span.length ? span.filter((r) => r.midi !== null).length / span.length : 0;
      const wander = Math.max(...win.map((p) => Math.abs(p.c - v2)));
      const steady = trend <= c.maxTrendCents && voicedFrac >= 0.9 && wander <= 220;
      const dbSlope = slope(win.map((p) => p.t), win.map((p) => p.db));
      // Carry-over guard: a sound that was already there when the step opened, at the exact
      // pitch of the previous (possibly still ringing) note, only counts once it stops dying away
      // (i.e. a voice is actually holding it).
      const fromStart = !this.segOnset && this.segFirstT !== null && this.firstT !== null && this.segFirstT - this.firstT < 0.1;
      const sungMidi = this.cfg.targetMidi + v2 / 100 + Math.round((midi - (this.cfg.targetMidi + v2 / 100)) / 12) * 12;
      const carry = fromStart && c.carryMidi !== undefined && Math.abs(sungMidi - c.carryMidi) < 0.6 && dbSlope < -3;
      let sustainedOk = true;
      if (c.strict) {
        const mid = f.t - c.holdMs / 2000;
        const h1 = win.filter((p) => p.t <= mid);
        const h2 = win.filter((p) => p.t > mid);
        const s1 = slope(h1.map((p) => p.t), h1.map((p) => p.db));
        const s2 = slope(h2.map((p) => p.t), h2.map((p) => p.db));
        sustainedOk = dbSlope >= c.minDbSlope && s1 >= 2 * c.minDbSlope && s2 >= 2 * c.minDbSlope;
      }
      if (!steady) hint = 'moving';
      else if (carry) hint = 'carryOver';
      else if (!sustainedOk) hint = 'decaying';
      if (steady && !carry && sustainedOk) {
        if (inTolNow) {
          accepted = !c.neverAccept;
          meanAbs = Math.abs(v2);
        } else {
          const rounded = Math.round(this.cfg.targetMidi + v2 / 100);
          if (rounded !== this.lastCountedWrong && rounded !== c.ignoreMidi) {
            wrong++;
            this.lastCountedWrong = rounded;
          }
        }
      }
    }
    const progress = Math.abs(v1) <= c.toleranceCents ? Math.min(1, age / settledAge) : 0;
    return {
      voiced: true, stable: true, detectedMidi: this.displayMidi(),
      cents: v1, inTolerance: Math.abs(v1) <= c.toleranceCents, progress: accepted ? 1 : progress,
      accepted, acceptedAt: accepted ? f.t : null, meanAbsCents: meanAbs, wrongAttempts: wrong, hint: accepted ? null : hint,
    };
  }

  // ------------------------------------------------------------------ plucked

  private pushPlucked(f: PitchFrame, db: number, midi: number | null): MatchState {
    const c = this.cfg;
    const s = this.state;
    const t = f.t;
    const hist = this.hist;
    const n = hist.length;

    // ---- new attack: a level jump, or a clean jump to a new steady pitch (hammer-on, legato)
    let onset = false;
    const before = hist.filter((r) => r.t >= t - 0.14 - 1e-6 && r.t <= t - 0.04 + 1e-6);
    const prevDb = n >= 2 ? hist[n - 2].db : -Infinity;
    if (before.length >= 2 && t - this.lastOnsetT >= 0.08) {
      const minBefore = Math.min(...before.map((r) => r.db));
      if (db - minBefore >= c.onsetRiseDb && db >= c.minDb && db > prevDb + 1) onset = true;
    }
    if (!onset && n >= 6 && t - this.lastOnsetT >= 0.15) {
      const last = hist.slice(-3).map((r) => r.midi);
      const prior = hist.slice(-6, -3).map((r) => r.midi);
      if (last.every((m) => m !== null) && prior.every((m) => m !== null)) {
        const l = last as number[];
        const p = prior as number[];
        if (Math.max(...l) - Math.min(...l) <= 0.4 && Math.max(...p) - Math.min(...p) <= 0.4 && Math.abs(median(l) - median(p)) >= 0.8) onset = true;
      }
    }
    if (onset) {
      const pre = hist.filter((r) => r.t >= t - 0.3 && r.t <= t - 0.04 + 1e-6);
      const preVoiced = pre.filter((r) => r.midi !== null && r.clarity >= 0.75).map((r) => r.midi as number);
      this.cand = {
        onsetT: t, peakT: t, peakDb: db,
        preMidi: preVoiced.length >= 3 ? median(preVoiced) : null,
        pre: pre.slice(-6),
        identity: null, lastWindowMidi: null, done: false, counted: false, decay: 'pending',
      };
      this.lastOnsetT = t;
    }

    const cand = this.cand;
    let hint: MatchHint | null = null;
    let accepted = false;
    let wrong = s.wrongAttempts;
    let accMidi: number | null = null;

    if (cand && !cand.done) {
      if (t - cand.onsetT > c.maxIdentityMs / 1000) cand.done = true;
      if (t - cand.onsetT <= 0.1 && db > cand.peakDb) {
        cand.peakDb = db;
        cand.peakT = t;
      }
      if (c.strict) this.strictDecay(cand, t);
    }

    if (cand && !cand.done && t >= cand.onsetT + 0.04) {
      const W = c.pitchWindowMs / 1000;
      const from = Math.max(t - W, cand.onsetT + 0.04);
      const win = hist.filter((r) => r.t > from - 1e-6);
      const span = (t - from) * 1000;
      const vw = win.filter((r) => r.midi !== null);
      if (span >= c.pitchWindowMs - 25 && vw.length >= win.length - 1 && vw.length >= 3) {
        let midis = vw.map((r) => r.midi as number);
        // New note an octave above a still-ringing note: the detector keeps reporting the lower,
        // common period, but periodicity one octave up jumped with this attack.
        if (cand.preMidi !== null && Math.abs(median(midis) - cand.preMidi) < 0.5) {
          const upHz = midiToFreq(cand.preMidi + 12);
          const post = median(vw.map((r) => periodicityAt(r.nsdf, r.sr ?? 48000, upHz) || r.up));
          const preUp = cand.pre.length ? median(cand.pre.map((r) => periodicityAt(r.nsdf, r.sr ?? 48000, upHz) || r.up)) : 0;
          if (post >= 0.8 && post - preUp >= 0.25) midis = midis.map((m) => m + 12);
        }
        const half = Math.floor(midis.length / 2);
        const a = mean(midis.slice(0, half));
        const b = mean(midis.slice(midis.length - half));
        const steady = Math.abs(a - b) * 100 <= c.maxStepCents && (Math.max(...midis) - Math.min(...midis)) * 100 <= 150;
        if (steady) {
          const wm = median(midis);
          if (cand.lastWindowMidi !== null && Math.abs(wm - cand.lastWindowMidi) > 1.0) {
            // the reading jumped (octave flip of a dying note, hum): this attack is not trusted any more
            cand.done = true;
          } else {
            cand.lastWindowMidi = wm;
            cand.identity ??= wm;
            const dev = this.deviation(wm);
            if (Math.abs(dev) <= c.toleranceCents) {
              if (!c.strict || cand.decay === 'confirmed') {
                accepted = !c.neverAccept;
                accMidi = wm;
              } else if (cand.decay === 'rejected') {
                hint = 'sustained';
              }
            } else {
              const d = wm - this.cfg.targetMidi;
              if (Math.abs(d - 12) < 0.5) hint = 'octaveHigh';
              else if (Math.abs(d + 12) < 0.5) hint = 'octaveLow';
              if (!cand.counted && t - cand.onsetT >= 0.1) {
                if (Math.round(wm) !== c.ignoreMidi) wrong++;
                cand.counted = true;
              }
            }
          }
        } else {
          hint = 'moving';
        }
        // Target-aware fallback for mixtures (a new note over a different ringing note can make
        // the detector report a common sub-harmonic): accept when periodicity at the target
        // appeared with this attack, there is no periodicity an octave above it, and the blind
        // reading is not the target's octave neighbour.
        if (!accepted && !c.strict && !c.neverAccept && !cand.done) {
          const tHz = midiToFreq(this.cfg.targetMidi);
          const withN = vw.filter((r) => r.nsdf);
          if (withN.length >= 3 && cand.pre.length) {
            const sr = withN[0].sr ?? 48000;
            const postT = median(withN.map((r) => periodicityAt(r.nsdf, sr, tHz)));
            const postUp = median(withN.map((r) => periodicityAt(r.nsdf, sr, tHz * 2)));
            const preT = median(cand.pre.map((r) => (r.nsdf ? periodicityAt(r.nsdf, sr, tHz) : 0)));
            const blind = median(midis);
            const octaveReading = [12, -12, 24, -24].some((iv) => Math.abs(blind - (this.cfg.targetMidi + iv)) < 0.5);
            const targetReading = Math.abs(blind - this.cfg.targetMidi) < 0.5;
            if (postT >= 0.75 && postUp <= 0.6 && postT - preT >= 0.25 && !octaveReading && !targetReading) {
              accepted = true;
              accMidi = this.cfg.targetMidi;
            }
          }
        }
      }
    }

    const disp = this.displayMidi();
    const cents = accepted && accMidi !== null ? this.deviation(accMidi) : disp !== null ? this.deviation(disp) : null;
    const inTol = cents !== null && Math.abs(cents) <= c.toleranceCents;
    // The right pitch is sounding but nothing opened a candidate: a voice, or a note still ringing.
    if (!accepted && !hint && inTol && (!cand || cand.done || t - cand.onsetT > 0.4)) hint = 'noAttack';
    return {
      voiced: midi !== null,
      stable: disp !== null,
      detectedMidi: accepted && accMidi !== null ? accMidi : disp,
      cents,
      inTolerance: inTol,
      progress: accepted ? 1 : 0,
      accepted,
      acceptedAt: accepted ? t : null,
      meanAbsCents: accepted && cents !== null ? Math.abs(cents) : null,
      wrongAttempts: wrong,
      hint: accepted ? null : hint,
    };
  }

  /** Strict mode: the level must fall freely after the attack (two consecutive segments). */
  private strictDecay(cand: Candidate, t: number): void {
    const c = this.cfg;
    if (cand.decay !== 'pending') return;
    const seg = c.decaySegMs / 1000;
    if (t < cand.peakT + 2 * seg - 1e-6) return;
    const meanDb = (a: number, b: number) => {
      const xs = this.hist.filter((r) => r.t >= a - 1e-6 && r.t <= b + 1e-6).map((r) => r.db);
      return xs.length ? mean(xs) : NaN;
    };
    const s0 = t - 2 * seg;
    const m0 = meanDb(s0, s0 + 0.03);
    const m1 = meanDb(s0 + seg - 0.02, s0 + seg + 0.02);
    const m2 = meanDb(t - 0.04, t);
    if (m0 - m1 >= c.minSegDecayDb && m1 - m2 >= c.minSegDecayDb) cand.decay = 'confirmed';
    else if (s0 >= cand.peakT + 0.2) cand.decay = 'rejected';
  }
}

/**
 * Free-running tuner smoothing: reports the trusted, median-smoothed note (no target).
 * Used by the tuner / mic-check screen.
 */
export class StablePitch {
  private recent: number[] = [];
  private smooth: number[] = [];
  private lastVoicedT = -Infinity;
  private minClarity = 0.8;
  private minDb = -78;
  private stableFrames = 3;
  private stableCents = 40;
  private smoothFrames = 5;
  private graceMs = 80;

  push(f: PitchFrame): number | null {
    const voiced = f.freq > 0 && f.clarity >= this.minClarity && rmsToDb(f.cleanRms ?? f.rms) >= this.minDb;
    if (!voiced) {
      if ((f.t - this.lastVoicedT) * 1000 > this.graceMs) {
        this.recent = [];
        this.smooth = [];
      }
      return this.smooth.length ? median(this.smooth) : null;
    }
    this.lastVoicedT = f.t;
    const m = freqToMidi(f.freq);
    this.recent.push(m);
    if (this.recent.length > this.stableFrames) this.recent.shift();
    const spread = (Math.max(...this.recent) - Math.min(...this.recent)) * 100;
    if (this.recent.length < this.stableFrames || spread > this.stableCents) {
      this.smooth = [];
      return null;
    }
    this.smooth.push(m);
    if (this.smooth.length > this.smoothFrames) this.smooth.shift();
    return median(this.smooth);
  }
}
