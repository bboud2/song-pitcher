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
//                dying note, hum) cannot turn it into a different note, and the note is only
//                accepted while both that identity and the current reading are on the target
//                fret. A sound that has no
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
  /** Pitch of what is new since ~160 ms ago (the note just attacked, without what was ringing). */
  novFreq?: number;
  novClarity?: number;
  /** share of the frame's power that is new since ~160 ms ago */
  novShare?: number;
  /** level of the 2–6 kHz band (attack noise), dB */
  hfDb?: number;
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
  /**
   * Plucked only: the note must start dying away right after its attack (a hum, a sung or
   * spoken vowel holds its level). Lenient (≥ 0.3 dB lost over ~120 ms) so that real
   * strings pass; costs ~100 ms of accept time. On in the guitar step, off in the
   * phrase review (fast playing over ringing strings).
   */
  humGuard?: boolean;
  /** Plucked only (phrase review): recognise a repeat re-plucked over the same ringing string. */
  repeatOnsets?: boolean;
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
  /** The in-tolerance identity must stay steady this long before accepting. */
  persistMs: number;
  /** Strict mode: free-decay check segments. */
  decaySegMs: number;
  minSegDecayDb: number;
  /** Analyse but never accept (gauntlet octave scans). */
  neverAccept?: boolean;
  /**
   * Guitar step right after the singing step: the pitch the student just sang. Until their voice
   * has actually stopped (the level falls well below where the step started, or goes quiet), an
   * attack at this pitch is not counted — it is the sung answer's tail, not a pluck.
   */
  voiceMidi?: number;
}

const COMMON = {
  minDb: -78,
  graceMs: 80,
  ignoreMidi: undefined,
  smoothMs: 150,
  trendMs: 160,
  maxTrendCents: 10,
  jumpCents: 200,
  holdMs: 460,
  minDbSlope: -5,
  onsetRiseDb: 6,
  pitchWindowMs: 100,
  maxStepCents: 15,
  maxIdentityMs: 1200,
  persistMs: 20,
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

/** Hum guard: minimum level drop (dB) between the two windows after a plucked attack. */
export const HUM_MIN_DECAY_DB = 0.3;

export type MatchHint =
  /** guitar step: the right pitch is sounding with no new pluck while the student is still singing */
  | 'noAttack'
  /** guitar step: the right pitch is sounding but it is an earlier note still ringing (no new pluck) */
  | 'ringing'
  /** guitar step: the plucked note is near the target fret but outside the tolerance (string out of tune?) */
  | 'outOfTune'
  /** guitar step: the plucked note is the right note in the wrong octave */
  | 'octaveHigh'
  | 'octaveLow'
  /** pitch still gliding/sliding */
  | 'moving'
  /** singing step: the guitar note from the previous step is still ringing */
  | 'carryOver'
  /** singing step: the note was on pitch but too short to judge (hold it about half a second) */
  | 'tooShort'
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
  /** how the accept was decided (diagnostics) */
  reason?: 'window';
}

interface Rec {
  t: number;
  db: number;
  /** raw level (before noise removal): envelope-shape tests use this, since the noise tracker
   *  slowly learns any long sound and would make it look like it is dying away */
  rawDb: number;
  clarity: number;
  midi: number | null;
  /** pitch of what is new since ~160 ms ago, if clear */
  nov: number | null;
  up: number;
  /** 2–6 kHz band level (attack noise) */
  hf: number;
  /** heard while the student's sung answer was still sounding (guitar step) */
  voice?: boolean;
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

/** Largest cluster of readings within ±40 c; steady if it covers ≥ 60 % of the window and does not slide. */
function cluster(xs: number[], windowLen: number, maxStepCents: number): { members: number[]; steady: boolean } {
  if (!xs.length) return { members: [], steady: false };
  let bestIdx = 0;
  let bestCount = 0;
  for (let i = 0; i < xs.length; i++) {
    const cnt = xs.filter((x) => Math.abs(x - xs[i]) <= 0.4).length;
    if (cnt > bestCount) {
      bestCount = cnt;
      bestIdx = i;
    }
  }
  const centre = xs[bestIdx];
  const members = xs.filter((x) => Math.abs(x - centre) <= 0.4);
  const half = Math.floor(members.length / 2);
  const a = mean(members.slice(0, half));
  const b = mean(members.slice(members.length - half));
  return { members, steady: members.length >= 3 && members.length >= 0.6 * windowLen && Math.abs(a - b) * 100 <= maxStepCents };
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
  /** something audible (a note still ringing, a voice) was sounding just before the attack */
  preSounding: boolean;
  /** frames just before the attack, for "what changed" periodicity checks */
  pre: Rec[];
  identity: number | null;
  lastWindowMidi: number | null;
  done: boolean;
  counted: boolean;
  decay: 'pending' | 'confirmed' | 'rejected';
  /** default hum guard verdict */
  hum: 'pending' | 'ok' | 'flat';
  humRetried?: boolean;
  /** time after the onset before pitch is read (skips the pick noise of an attack) */
  lead: number;
  /** opened before the student's voice had stopped (guitar step after singing) */
  whileSinging: boolean;
  /** the loudest level in the 1.5 s before the attack */
  loudest: number;
  /** reading at which the note was identified on the target, waiting for the hum guard */
  ready?: number;
  /** first time the in-tolerance identity was read steadily */
  steadySince?: number;
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
  private tooShortUntil = -Infinity;
  private lastVoicedT = -Infinity;
  private lastCountedWrong: number | null = null;
  // plucked
  private cand: Candidate | null = null;
  private lastOnsetT = -Infinity;
  private lastLevelOnsetT = -Infinity;
  /** notes identified at recent attacks (and when) */
  private identities: { midi: number; t: number }[] = [];
  private prevNovShare = 1;
  private prevNovShare2 = 1;
  /** when the share of new power last rose past 0.4 (its rising edge), and whether it was used */
  private novEdgeT = -Infinity;
  private armed = true;
  private startLevels: number[] = [];
  private quietFrames = 0;

  constructor(cfg: MatchConfig) {
    this.cfg = cfg;
    this.armed = cfg.voiceMidi === undefined;
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

  /**
   * Give the matcher recent context (frames heard just before it was created) without letting
   * anything in them count: an attack inside them opens no candidate. Lets a following note's
   * attack or pitch change be recognised right away (fast phrase review).
   */
  prime(frames: PitchFrame[]): void {
    for (const f of frames) {
      const db = rmsToDb(f.cleanRms ?? f.rms);
      const voiced = f.freq > 0 && f.clarity >= this.cfg.minClarity && db >= this.cfg.minDb;
      this.hist.push({ t: f.t, db, rawDb: rmsToDb(f.rms), clarity: f.clarity, midi: voiced ? freqToMidi(f.freq) : null, nov: null, up: f.upClarity ?? 0, hf: f.hfDb ?? -200, nsdf: f.nsdf, sr: f.sr });
    }
    if (frames.length) {
      this.firstT = frames[0].t;
      this.prevNovShare = frames[frames.length - 1].novShare ?? 1;
      this.prevNovShare2 = frames.length > 1 ? frames[frames.length - 2].novShare ?? 1 : 1;
    }
  }

  push(f: PitchFrame): MatchState {
    if (this.state.accepted) return this.state;
    const c = this.cfg;
    this.firstT ??= f.t;
    const db = rmsToDb(f.cleanRms ?? f.rms);
    const voiced = f.freq > 0 && f.clarity >= c.minClarity && db >= c.minDb && f.freq >= 55 && f.freq <= 1700;
    const midi = voiced ? freqToMidi(f.freq) : null;
    const nov = f.novFreq && (f.novClarity ?? 0) >= 0.75 && f.novFreq >= 55 && f.novFreq <= 1700 ? freqToMidi(f.novFreq) : null;
    this.hist.push({ t: f.t, db, rawDb: rmsToDb(f.rms), clarity: f.clarity, midi, nov, up: f.upClarity ?? 0, hf: f.hfDb ?? -200, nsdf: f.nsdf, sr: f.sr });
    while (this.hist.length && this.hist[0].t < f.t - 2.5) this.hist.shift();
    // keep the (large) NSDF copies only for the last ~0.6 s
    for (let i = this.hist.length - 1; i >= 0 && this.hist[i].t >= f.t - 0.8; i--) {
      if (this.hist[i].t < f.t - 0.6) this.hist[i].nsdf = undefined;
    }
    this.state = c.kind === 'sung' ? this.pushSung(f, db, midi) : this.pushPlucked(f, db, midi);
    return this.state;
  }

  private shown: { midi: number; t: number } | null = null;
  private pendingJump = 0;

  private displayMidi(): number | null {
    // The meter is stricter than the decision gate for plucked notes: weak-clarity frames (a
    // dying note mixed with hum) are where sub-octave misreads happen.
    const minClar = this.cfg.kind === 'plucked' ? 0.8 : 0;
    let recent = this.hist.slice(-3).filter((r) => r.clarity >= minClar).map((r) => r.midi).filter((m): m is number => m !== null);
    // (the last attack's note stays the reference for ~2 s, even after its candidate closed)
    const last = this.hist.length ? this.hist[this.hist.length - 1].t : 0;
    const g = this.cand && last - this.cand.onsetT < 2 ? this.cand.identity : null;
    const octaveish = (a: number, b: number) => [7, 12, 19, 24].some((iv) => Math.abs(Math.abs(a - b) - iv) < 0.6);
    if (this.cfg.kind === 'plucked' && g !== null) recent = recent.filter((m) => !octaveish(m, g));
    if (!recent.length) return null;
    const m = median(recent);
    // Hysteresis: an octave/fifth jump of the reading is only shown once it persists (5 frames);
    // a brief detector flip is not shown as "You: E2" on the meter.
    if (this.shown && last - this.shown.t < 0.3 && octaveish(m, this.shown.midi) && this.pendingJump < 5) {
      this.pendingJump++;
      return this.shown.midi;
    }
    this.pendingJump = 0;
    this.shown = { midi: m, t: last };
    return m;
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
        // a note that was on pitch but stopped before it could be judged: say so
        const len = this.segFirstT !== null ? this.lastVoicedT - this.segFirstT : 0;
        if (this.seg.length && len >= 0.15 && s.inTolerance) this.tooShortUntil = f.t + 2;
        this.resetSeg();
        const hint: MatchHint | null = f.t < this.tooShortUntil ? 'tooShort' : null;
        return { ...s, voiced: false, stable: false, detectedMidi: null, cents: null, inTolerance: false, progress: 0, hint };
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
    this.seg.push({ t: f.t, c: cents, db: rmsToDb(f.rms) });
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
      // (any segment without an attack of its own: a ringing string's readings can flip and
      // restart the segment, so "started with the step" is not required)
      const fromStart = !this.segOnset;
      // (pitch class: the ringing string's readings may flip octave)
      const pcDiff = c.carryMidi === undefined ? 99 : Math.abs(((((this.cfg.targetMidi + v2 / 100 - c.carryMidi) % 12) + 18) % 12) - 6);
      // A string is far steadier in pitch than any voice (no vibrato, no jitter): a sound at the
      // previous note's pitch class that is both "dying away" or "dead steady" is the string,
      // even when a phone's gain control or a long-sustain guitar hides the decay.
      const cs = win.map((p) => p.c);
      const pitchSd = cs.length >= 3 ? Math.sqrt(mean(cs.map((x) => (x - mean(cs)) ** 2))) : 99;
      const carry = fromStart && pcDiff < 0.6 && (dbSlope < -1.5 || pitchSd < 3);
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

    // ---- disarmed while the sung answer is still sounding
    if (!this.armed) {
      if (this.startLevels.length < 3) this.startLevels.push(db);
      const startLevel = median(this.startLevels);
      if (db <= startLevel - 20 || db <= -60 || midi === null) this.quietFrames++;
      else this.quietFrames = 0;
      if (this.quietFrames >= 3) this.armed = true;
    }
    hist[n - 1].voice = !this.armed;

    // ---- new attack: a level jump, or a clean jump to a new steady pitch (hammer-on, legato)
    let onset = false;
    // Attacks only count when most of the frame's energy is signal, not room noise (after noise
    // removal the level of pure noise sits well below the raw level).
    const signalDominant = rmsToDb(f.rms) - db <= 6;
    // A swell far below what was just played (the null-to-peak of a beating string, a
    // resonance) is not an attack: the level must reach within 12 dB of the envelope of recent
    // attacks, allowing that envelope to die away at 10 dB/s.
    // (the student's own voice is louder than the guitar and does not count as an attack)
    const env = Math.max(...hist.filter((r) => r.t >= t - 1.5 && r.t < t - 0.03 && !r.voice).map((r) => r.db - 10 * (t - r.t)), -Infinity);
    const loudEnough = db >= env - 12;
    let before = hist.filter((r) => r.t >= t - 0.14 - 1e-6 && r.t <= t - 0.04 + 1e-6);
    // (after a stalled audio callback there may be a single earlier frame: use the last two heard)
    if (before.length < 2 && n >= 3) before = hist.slice(n - 3, n - 1);
    const prevDb = n >= 2 ? hist[n - 2].db : -Infinity;
    // (a level attack is strong evidence: only another level attack holds it off)
    if (signalDominant && before.length >= 2 && t - this.lastLevelOnsetT >= 0.08) {
      const minBefore = Math.min(...before.map((r) => r.db));
      // a big rise, or a sharp one-frame jump (a re-pluck over the same note still ringing)
      // (the small sharp jump only counts near the loudness of recent attacks: a re-pluck returns
      // to about the old peak, a beating string's swell does not)
      const recentMax = Math.max(...hist.filter((r) => r.t >= t - 1.0).map((r) => r.db));
      const sharpReplay = db - prevDb >= 3 && db - minBefore >= 3.5 && db >= recentMax - 6;
      const bigRise = db - minBefore >= c.onsetRiseDb && db > prevDb + 1 && loudEnough;
      // a re-pluck of the same string while it still rings: the 4–6 dB jump is spread over two
      // frames; it must climb back to about the loudness of the recent attacks
      const prev2Db = n >= 3 ? hist[n - 3].db : -Infinity;
      const twoFrameReplay = db - prev2Db >= 4 && db - prevDb >= 1.5 && db - minBefore >= 4 && db >= recentMax - 4 && t - this.lastLevelOnsetT >= 0.15;
      // Phrase review only: an immediate repeat re-plucked on its still-ringing string. The level
      // climbs only 3–5 dB over two or three frames, but the "what's new" spectrum is clearly
      // that same note again (a string merely ringing on adds nothing new).
      const n4 = hist.slice(-5, -1).map((r) => r.db);
      const novSame = f.novFreq && midi !== null && Math.abs(freqToMidi(f.novFreq) - midi) < 0.5;
      const repeatReplay = !!c.repeatOnsets && !!novSame && (f.novShare ?? 0) >= 0.35 && (f.novClarity ?? 0) >= 0.85 && n4.length === 4 && db - Math.min(...n4) >= 3 && db >= recentMax - 6 && t - this.lastLevelOnsetT >= 0.15;
      // Phrase review only: the pick noise of a re-pluck (a jump of the 2–6 kHz band) with the
      // level at least holding, near the loudness of recent attacks.
      const hfBefore = hist.filter((r) => r.t >= t - 0.12 - 1e-6 && r.t <= t - 0.03 + 1e-6).map((r) => r.hf);
      const pickNoise = !!c.repeatOnsets && hfBefore.length >= 2 && f.hfDb !== undefined && f.hfDb - Math.max(...hfBefore) >= 6 && db - prevDb >= 0.5 && db >= recentMax - 8 && t - this.lastLevelOnsetT >= 0.15;
      if (db >= c.minDb && (bigRise || sharpReplay || twoFrameReplay || repeatReplay || pickNoise)) {
        onset = true;
        this.lastLevelOnsetT = t;
      }
    }
    let onsetT = t;
    let lead = 0.02;
    // (not right after another attack, and not an octave/fifth jump: that is the detector
    // flipping between readings of the same sound, not a new note)
    if (!onset && signalDominant && loudEnough && n >= 6 && t - this.lastOnsetT >= 0.3) {
      const last = hist.slice(-3).map((r) => r.midi);
      const prior = hist.slice(-6, -3).map((r) => r.midi);
      if (last.every((m) => m !== null) && prior.every((m) => m !== null)) {
        const l = last as number[];
        const p = prior as number[];
        const jump = Math.abs(median(l) - median(p));
        // a real hammer-on/pull-off adds energy; a dying chord whose reading wanders does not
        const lv = hist.slice(-3).map((r) => r.db);
        const pv = hist.slice(-6, -3).map((r) => r.db);
        const notDying = mean(lv) >= mean(pv) - 0.5;
        if (notDying && Math.max(...l) - Math.min(...l) <= 0.4 && Math.max(...p) - Math.min(...p) <= 0.4 && jump >= 0.8 && jump <= 5.5) {
          onset = true;
          // the new pitch started three frames ago; no attack noise to skip
          onsetT = hist[n - 3].t;
          lead = 0;
        }
      }
    }
    // A new note over others still ringing barely raises the level: recognise it from the
    // "what changed" spectrum (a clear new pitch that differs from what was sounding).
    // (rising edge only: the new power just appeared in this frame)
    // (a hammer-on on a fast-dying high string can be well below the envelope of the pluck, so a
    // looser level rule than for level attacks: the clear new pitch is the evidence here)
    // (the new pitch may take a frame or two to read clearly after the edge)
    // (rising edge: the share was low within the last two frames — the rise can straddle a frame)
    if ((f.novShare ?? 0) >= 0.4 && Math.min(this.prevNovShare, this.prevNovShare2) < 0.3 && t - this.novEdgeT > 0.1) this.novEdgeT = t;
    if (!onset && signalDominant && db >= env - 20 && f.novFreq && (f.novShare ?? 0) >= 0.4 && (f.novClarity ?? 0) >= 0.85 && t - this.novEdgeT <= 0.045 && t - this.lastOnsetT >= 0.25 && before.length >= 2) {
      const novM = freqToMidi(f.novFreq);
      // (what was sounding just before the edge)
      const earlier = hist.filter((r) => r.t < this.novEdgeT - 1e-6).slice(-4).map((r) => r.midi).filter((m): m is number => m !== null);
      const minBefore = Math.min(...before.map((r) => r.db));
      // (not an octave/fifth of what is already sounding: a beating string's swell reads that way)
      const related = earlier.some((m) => [7, 12, 19, 24].some((iv) => Math.abs(Math.abs(m - novM) - iv) < 0.6));
      if (earlier.length >= 2 && !related && earlier.every((m) => Math.abs(m - novM) >= 0.5) && (db - minBefore >= 1 || ((f.novShare ?? 0) >= 0.7 && (f.novClarity ?? 0) >= 0.95))) {
        // (a hammer-on adds little level; then the new pitch must clearly dominate what changed)
        onset = true;
        lead = 0;
      }
    }
    this.prevNovShare2 = this.prevNovShare;
    this.prevNovShare = f.novShare ?? 0;
    if (onset) {
      const pre = hist.filter((r) => r.t >= onsetT - 0.3 && r.t <= onsetT - 0.04 + 1e-6);
      const preVoiced = pre.filter((r) => r.midi !== null && r.clarity >= 0.75).map((r) => r.midi as number);
      const preMax = pre.length ? Math.max(...pre.map((r) => r.db)) : -Infinity;
      const loudest = Math.max(...hist.filter((r) => r.t >= t - 1.5 && r.t < t - 0.03 && !r.voice).map((r) => r.db), -Infinity);
      this.cand = {
        onsetT, peakT: t, peakDb: db, lead, whileSinging: !this.armed,
        loudest,
        preSounding: preMax >= c.minDb + 10 && preMax >= db - 25,
        preMidi: preVoiced.length >= 3 ? median(preVoiced) : null,
        pre: pre.slice(-6),
        identity: null, lastWindowMidi: null, done: false, counted: false, decay: 'pending', hum: 'pending',
      };
      this.lastOnsetT = t;
    }

    const cand = this.cand;
    let hint: MatchHint | null = null;
    let accepted = false;
    let wrong = s.wrongAttempts;
    let accMidi: number | null = null;
    let reason: MatchState['reason'];

    if (cand && !cand.done) {
      if (t - cand.onsetT > c.maxIdentityMs / 1000) cand.done = true;
      // A pluck reads as a steady note within a few hundred ms; a sound whose first steady reading
      // comes later (a note below the guitar's range, a muddled mixture dying away) is not
      // identified at all.
      if (cand.identity === null && t - cand.onsetT > 0.6) cand.done = true;
      if (t - cand.onsetT <= 0.1 && db > cand.peakDb) {
        cand.peakDb = db;
        cand.peakT = t;
      }
      if (c.strict) this.strictDecay(cand, t);
      if (c.humGuard) this.humCheck(cand, t);
    }

    if (cand && !cand.done && t >= cand.onsetT + cand.lead) {
      const W = c.pitchWindowMs / 1000;
      const from = Math.max(t - W, cand.onsetT + cand.lead);
      const win = hist.filter((r) => r.t > from - 1e-6);
      const span = (t - from) * 1000;
      const vw = win.filter((r) => r.midi !== null);
      // Over other sounds still ringing, read the note from what is NEW since the attack.
      const nv = cand.preSounding && t - cand.onsetT <= 0.18 ? win.filter((r) => r.nov !== null) : [];
      if (span >= c.pitchWindowMs - 25 && (nv.length >= 3 || vw.length >= 3)) {
        let blind = vw.map((r) => r.midi as number);
        // New note an octave above a still-ringing note: the detector keeps reporting the lower,
        // common period, but periodicity one octave up jumped with this attack.
        if (cand.preMidi !== null && blind.length && Math.abs(median(blind) - cand.preMidi) < 0.5) {
          const upHz = midiToFreq(cand.preMidi + 12);
          const post = median(vw.map((r) => periodicityAt(r.nsdf, r.sr ?? 48000, upHz) || r.up));
          const preUp = cand.pre.length ? median(cand.pre.map((r) => periodicityAt(r.nsdf, r.sr ?? 48000, upHz) || r.up)) : 0;
          if (post >= 0.8 && post - preUp >= 0.25) blind = blind.map((m) => m + 12);
        }
        // Majority reading: in noise or with other strings ringing, some frames read an octave or a
        // sub-harmonic; the note is the largest cluster of readings (within ±40 c) if it holds at
        // least 60 % of the window, and it must not be sliding (halves test). The "what's new"
        // reading wins when it qualifies; otherwise the normal reading.
        const nov = cluster(nv.map((r) => r.nov as number), win.length, c.maxStepCents);
        const bl = cluster(blind, win.length, c.maxStepCents);
        // (a blind reading must be clearly periodic: a muddled one is often a sub-octave misread)
        const blClear = median(vw.map((r) => r.clarity)) >= 0.65;
        let pickC = nov.steady ? nov : bl.steady && blClear ? bl : null;
        // Near-silence or noise can make the normal reading drop an octave (the sub-harmonic period
        // also repeats); right after an attack the "what's new" reading still shows the true note.
        if (pickC === bl && t - cand.onsetT <= 0.18) {
          const na = cluster(win.filter((r) => r.nov !== null).map((r) => r.nov as number), win.length, c.maxStepCents);
          if (na.steady && Math.abs(median(na.members) - median(bl.members) - 12) < 0.6) pickC = na;
        }
        // A note an octave or a fifth away from a note heard in the last 2 s (a swell of a beating
        // string, a dying note's misread) only counts after a full-strength attack, and then (if
        // that note may still be sounding) only when the "what's new" reading confirms it.
        if (pickC && cand.identity === null) {
          const wm0 = median(pickC.members);
          const related = this.identities.some((p) => t - p.t < 2 && [7, 12, 19, 24].some((iv) => Math.abs(Math.abs(wm0 - p.midi) - iv) < 0.6));
          // (a full-strength attack: its peak about as loud as anything in the 1.5 s before; not a swell)
          // (when nothing was still sounding, e.g. the wrong note was damped, a full attack is enough)
          if (related && (cand.peakDb < cand.loudest - 4 || (cand.preSounding && pickC !== nov))) pickC = null;
        }
        const steady = pickC !== null;
        const midis = pickC ? pickC.members : bl.members;
        if (steady) {
          const wm = median(midis);
          if (cand.lastWindowMidi !== null && Math.abs(wm - cand.lastWindowMidi) > 1.5) {
            // the reading jumped (octave flip of a dying note, hum): this attack is not trusted any more
            cand.done = true;
          } else {
            cand.lastWindowMidi = wm;
            // A deliberate bend or slide: the note moved at least 0.6 st within a second of the
            // attack and holds the new pitch — that is the note now. (A string never drifts that
            // far by itself, so a neighbouring fret still cannot creep into the window.)
            // (it must have GLIDED there — readings in between — and moved at most 2.5 st: a
            // detector octave flip or a misread jumps straight across)
            if (cand.identity !== null && Math.abs(wm - cand.identity) >= 0.6 && Math.abs(wm - cand.identity) <= 2.5 && t - cand.onsetT <= 1.0) {
              const lo = Math.min(wm, cand.identity) + 0.25;
              const hi = Math.max(wm, cand.identity) - 0.25;
              const glided = hist.filter((r) => r.t >= cand.onsetT && r.midi !== null && r.midi > lo && r.midi < hi).length >= 2;
              if (glided) cand.identity = wm;
            }
            if (cand.identity === null) {
              cand.identity = wm;
              this.identities.push({ midi: wm, t });
              while (this.identities.length && this.identities[0].t < t - 2) this.identities.shift();
            }
            const dev = this.deviation(wm);
            const sungTail = cand.whileSinging && c.voiceMidi !== undefined && Math.abs(wm - c.voiceMidi) < 0.6;
            if (sungTail) {
              // the student's own sung answer (or a pluck drowned in it): not a pluck we can trust
              hint = 'noAttack';
            } else if (Math.abs(dev) <= c.toleranceCents && Math.abs(this.deviation(cand.identity)) < 50) {
              // (both the reading now AND the note identified at the attack must be the target
              // fret: a neighbouring fret's reading cannot drift into the window later)
              // the note must hold steady for a moment (speech syllables rarely do)
              cand.steadySince ??= t;
              if (t - cand.steadySince < c.persistMs / 1000 - 1e-6) {
                // keep waiting
              } else if (c.humGuard && cand.hum !== 'ok') {
                // identified on the target: decided as soon as the envelope verdict is in, even
                // if a fast-dying note's later readings get unreliable
                cand.ready ??= wm;
                if (cand.hum === 'flat') hint = 'sustained';
              } else if (!c.strict || cand.decay === 'confirmed') {
                accepted = !c.neverAccept;
                accMidi = wm;
                reason = 'window';
              } else if (cand.decay === 'rejected') {
                hint = 'sustained';
              }
            } else {
              const d = wm - this.cfg.targetMidi;
              if (Math.abs(d - 12) < 0.5) hint = 'octaveHigh';
              else if (Math.abs(d + 12) < 0.5) hint = 'octaveLow';
              else if (Math.abs(dev) < 75 && Math.abs(dev) > c.toleranceCents) hint = 'outOfTune';
              if (!cand.counted && t - cand.onsetT >= 0.1) {
                if (Math.round(wm) !== c.ignoreMidi) wrong++;
                cand.counted = true;
              }
            }
          }
        } else if (cand.steadySince !== undefined && !c.strict && (!c.humGuard || cand.hum === 'ok') && t - cand.steadySince >= c.persistMs / 1000 - 1e-6 &&
          [nov, bl].some((k) => k.members.length >= 3 && Math.abs(this.deviation(median(k.members))) <= c.toleranceCents)) {
          // The note read steady on the target in the previous window and still reads it in at least
          // three frames now (a fast-dying note slipping into noise): that is enough.
          accepted = !c.neverAccept;
          accMidi = cand.lastWindowMidi;
          reason = 'window';
        } else {
          hint = 'moving';
          cand.steadySince = undefined;
        }
      }
    }

    if (cand && cand.ready !== undefined && c.humGuard) this.humCheck(cand, t);
    // (not in strict mode: there the note must still read steady when its decay is confirmed)
    if (!accepted && cand && cand.ready !== undefined && cand.hum === 'ok' && !c.strict) {
      accepted = !c.neverAccept;
      accMidi = cand.ready;
      reason = 'window';
    } else if (!accepted && cand && cand.ready !== undefined && cand.hum === 'flat') {
      hint = 'sustained';
    }
    const disp = this.displayMidi();
    const cents = accepted && accMidi !== null ? this.deviation(accMidi) : disp !== null ? this.deviation(disp) : null;
    const inTol = cents !== null && Math.abs(cents) <= c.toleranceCents;
    // The right pitch is sounding but nothing opened a candidate: the student's voice (while it
    // is still sounding), or a note still ringing.
    if (!accepted && !hint && inTol && (!cand || cand.done || t - cand.onsetT > 0.4)) hint = this.armed ? 'ringing' : 'noAttack';
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
      reason,
    };
  }

  /** Strict mode: the level must fall freely after the attack (two consecutive segments). */
  /**
   * Hum guard: compare the level (above the room noise) 20–100 ms after the attack's peak with 120–220 ms after it.
   * A string has lost at least ~0.3 dB by then (nearly always, even an unplugged electric); a hum, a held
   * vowel or the "m" of "um" has not.
   */
  private humCheck(cand: Candidate, t: number): void {
    if (cand.hum === 'ok' || cand.humRetried || t < cand.peakT + 0.22 - 1e-6) return;
    const voicedIn = (a: number, b: number) => this.hist.filter((r) => r.t >= cand.peakT + a - 1e-6 && r.t <= cand.peakT + b + 1e-6 && r.midi !== null).length;
    // (level above the room noise: in a noisy room the raw level of a soft pluck barely moves)
    // (after a stalled audio callback a window can be empty: then the next frame heard counts)
    const meanDb = (a: number, b: number) => {
      const xs = this.hist.filter((r) => r.t >= a - 1e-6 && r.t <= b + 1e-6).map((r) => r.db);
      if (xs.length) return mean(xs);
      const next = this.hist.find((r) => r.t > b && r.t <= b + 0.3);
      return next ? next.db : NaN;
    };
    // (windows wide enough to hold a frame even with 45 ms timer gaps)
    const m0 = meanDb(cand.peakT + 0.02, cand.peakT + 0.1);
    const m1 = meanDb(cand.peakT + 0.12, cand.peakT + 0.22);
    // ...and a string (even palm-muted) is still sounding then; a spoken syllable has usually stopped
    const voicedLate = this.hist.filter((r) => r.t >= cand.peakT + 0.12 - 1e-6 && r.t <= t + 1e-6 && r.midi !== null).length;
    if (Number.isNaN(m1)) return; // nothing heard after the window yet (a stall): decide on the next frame
    if (cand.hum === 'pending') {
      cand.hum = m0 - m1 >= HUM_MIN_DECAY_DB && voicedLate >= 1 ? 'ok' : 'flat';
      return;
    }
    // Second look, once: a string whose level swelled at first (a sympathetic resonance building
    // up) is dying away at a string's rate by 0.3–0.4 s and still sounding at 0.5 s; a hum that
    // simply ends drops out instead.
    if (cand.hum === 'flat' && !cand.humRetried && t >= cand.peakT + 0.62 - 1e-6) {
      cand.humRetried = true;
      const m2 = meanDb(cand.peakT + 0.3, cand.peakT + 0.4);
      const m3 = meanDb(cand.peakT + 0.52, cand.peakT + 0.62);
      // (dying steadily: about the same loss in each 0.2 s step, not a sudden end)
      const d1 = m1 - m2;
      const d2 = m2 - m3;
      if (d1 >= 0.6 && d2 >= 0.6 && d2 <= 2.5 * d1 && voicedIn(0.52, 0.62) >= 1) cand.hum = 'ok';
    }
  }

  private strictDecay(cand: Candidate, t: number): void {
    const c = this.cfg;
    if (cand.decay !== 'pending') return;
    const seg = c.decaySegMs / 1000;
    if (t < cand.peakT + 2 * seg - 1e-6) return;
    const meanDb = (a: number, b: number) => {
      const xs = this.hist.filter((r) => r.t >= a - 1e-6 && r.t <= b + 1e-6).map((r) => r.rawDb);
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
