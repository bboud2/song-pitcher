// Turns a stream of raw pitch detections into "the student produced the target note" decisions.
// Pure TypeScript, no DOM.
//
// Two source models, because the app must tell singing from playing:
//
//  * 'sung'    — a SUSTAINED tone. The pitch is smoothed with a two-stage moving average
//                (≈320 ms triangular window, which cancels 4.5–6 Hz vibrato of any width), then
//                the smoothed centre must be inside the tolerance AND have stopped moving
//                (a glide is not a held note), AND the level must not be dying away like a
//                plucked string. Accepts ≈0.5 s after the voice settles.
//  * 'plucked' — an IMPULSIVE tone: a fresh onset (level jump), then a FREE DECAY (the level
//                falls steadily in two consecutive 120 ms segments without swelling back), with
//                a steady pitch (not sliding) in tolerance. A sung or hummed note has an onset
//                but then sustains, so it never qualifies; a slide never holds still.
import { centsFromMidi, centsFromPitchClass, freqToMidi, midiToFreq } from './music.ts';
import { rmsToDb } from './pitch.ts';

/** One analysed frame: time in seconds plus the detector output. */
export interface PitchFrame {
  t: number;
  freq: number;
  clarity: number;
  rms: number;
  /**
   * NSDF height at half the detected period (i.e. how periodic the frame is one octave above
   * the detected pitch), 0 if unknown. Used to hear a new note over a still-ringing note an
   * octave below it.
   */
  upClarity?: number;
}

export type MatchMode = 'pitchClass' | 'exact';
export type SourceKind = 'sung' | 'plucked';

export interface MatchConfig {
  targetMidi: number;
  /** 'pitchClass' = any octave counts; 'exact' = same octave. */
  mode: MatchMode;
  toleranceCents: number;
  kind: SourceKind;
  /** Minimum NSDF clarity for a frame to count as voiced. */
  minClarity: number;
  /** Minimum frame level (dBFS) for a frame to count as voiced. */
  minDb: number;
  /** An unvoiced gap shorter than this does not break a sung note. */
  graceMs: number;
  /** A held/plucked wrong note equal to this (rounded) MIDI note is not counted as a wrong attempt. */
  ignoreMidi?: number;

  // ---- sung
  /** Length of each of the two moving-average stages. */
  smoothMs: number;
  /** The smoothed pitch must not have moved more than maxTrendCents over this span. */
  trendMs: number;
  maxTrendCents: number;
  /** Level regression slope over the last holdMs must be above this (dB/s): rejects plucks. */
  minDbSlope: number;
  /** A jump bigger than this between consecutive frames starts a new note. */
  jumpCents: number;
  /** Total settle time needed (≥ 2·smoothMs + trendMs). */
  holdMs: number;

  // ---- plucked
  /** Level rise (dB) over the previous ~100 ms that counts as a new attack. */
  onsetRiseDb: number;
  /** The level must fall at least minSegDecayDb in each of two consecutive segments of this length after the peak. */
  decaySegMs: number;
  minSegDecayDb: number;
  /** How late after the peak the two decay segments may start. */
  decayStartSlackMs: number;
  /** After the peak, a swell of more than this above the running minimum disqualifies (voice, speech). */
  maxReswellDb: number;
  /** Pitch must be steady (range ≤ pitchRangeCents) over this window, entirely after the onset. */
  pitchWindowMs: number;
  pitchRangeCents: number;
  /** A pluck must be recognised within this time after its onset. */
  maxAcceptAfterOnsetMs: number;
  /** Analyse but never accept (used by the gauntlet's octave scan). */
  neverAccept?: boolean;
}

export const SUNG_DEFAULTS: Omit<MatchConfig, 'targetMidi' | 'toleranceCents' | 'mode'> = {
  kind: 'sung',
  minClarity: 0.7,
  minDb: -75,
  graceMs: 80,
  smoothMs: 160,
  trendMs: 180,
  maxTrendCents: 14,
  minDbSlope: -5,
  jumpCents: 200,
  holdMs: 500,
  onsetRiseDb: 6,
  decaySegMs: 100,
  minSegDecayDb: 0.4,
  decayStartSlackMs: 200,
  maxReswellDb: 3,
  pitchWindowMs: 160,
  pitchRangeCents: 25,
  maxAcceptAfterOnsetMs: 1200,
};

export const PLUCKED_DEFAULTS: Omit<MatchConfig, 'targetMidi' | 'toleranceCents' | 'mode'> = {
  ...SUNG_DEFAULTS,
  kind: 'plucked',
  // Low: a quiet pluck in a noisy room still has a clear pitch; the onset + decay + steady-pitch
  // requirements are what keep noise, speech and voices out.
  minClarity: 0.55,
};

export interface MatchState {
  /** True when the current frame passes level + clarity gating. */
  voiced: boolean;
  /** True when a trustworthy pitch is being reported. */
  stable: boolean;
  /** Smoothed detected pitch as fractional MIDI, or null. */
  detectedMidi: number | null;
  /** Smoothed deviation from the target in cents (octave-folded in pitchClass mode), or null. */
  cents: number | null;
  inTolerance: boolean;
  /** 0..1 progress towards acceptance. */
  progress: number;
  accepted: boolean;
  acceptedAt: number | null;
  /** Mean |cents| over the frames that justified the accept. */
  meanAbsCents: number | null;
  /** Number of wrong notes held / plucked (attempts that missed). */
  wrongAttempts: number;
  /**
   * Why the right pitch is not being accepted, for user feedback:
   * 'sustained' — a held tone during the guitar step (sounds like singing);
   * 'decaying'  — a dying, plucked-sounding tone during the singing step;
   * 'moving'    — pitch still gliding/sliding.
   */
  hint: 'sustained' | 'decaying' | 'moving' | null;
}

const MAINS_HZ = [50, 60, 100, 120, 150, 180, 200, 240];

interface Rec {
  t: number;
  db: number;
  clarity: number;
  /** fractional midi if voiced */
  midi: number | null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
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
  runMin: number;
  state: 'pending' | 'confirmed' | 'rejected';
  counted: boolean;
  /** upClarity just before the onset (ringing lower-octave note). */
  preUp: number;
  preMidi: number | null;
  /** Median pitch of the latest steady post-onset window, if any. */
  goodMidi: number | null;
}

export class NoteMatcher {
  readonly cfg: MatchConfig;
  private hist: Rec[] = [];
  private state: MatchState;
  // sung
  private seg: { t: number; c: number; db: number }[] = []; // current continuous sung segment (cents vs target, unfolded)
  private sm1: { t: number; v: number }[] = [];
  private sm2: { t: number; v: number }[] = [];
  private lastVoicedT = -Infinity;
  private lastCountedWrong: number | null = null;
  // plucked
  private cand: Candidate | null = null;
  private lastOnsetT = -Infinity;
  private upHist: { t: number; up: number; midi: number | null }[] = [];

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
    const db = rmsToDb(f.rms);
    const voiced = f.freq > 0 && f.clarity >= c.minClarity && db >= c.minDb && f.freq >= 55 && f.freq <= 1700;
    const midi = voiced ? freqToMidi(f.freq) : null;
    this.hist.push({ t: f.t, db, clarity: f.clarity, midi });
    while (this.hist.length && this.hist[0].t < f.t - 2.5) this.hist.shift();
    this.state = c.kind === 'sung' ? this.pushSung(f, db, midi) : this.pushPlucked(f, db, midi);
    return this.state;
  }

  private displayMidi(): number | null {
    // The meter is stricter than the decision gate in plucked mode: weak-clarity frames (a
    // decayed note mixed with hum) are where sub-octave misreads happen.
    const minClar = this.cfg.kind === 'plucked' ? 0.8 : 0;
    let recent = this.hist.slice(-3).filter((r) => r.clarity >= minClar).map((r) => r.midi).filter((m): m is number => m !== null);
    // A plucked string cannot jump an octave (or fifth) without a new attack: such readings of
    // the note being tracked are detector misreads (e.g. a dying note mixed with hum).
    const g = this.cand && this.cand.state !== 'rejected' ? this.cand.goodMidi : null;
    if (this.cfg.kind === 'plucked' && g !== null) {
      recent = recent.filter((m) => ![7, 12, 19, 24].some((iv) => Math.abs(Math.abs(m - g) - iv) < 0.6));
    }
    return recent.length ? median(recent) : null;
  }

  // ------------------------------------------------------------------ sung

  private pushSung(f: PitchFrame, db: number, midi: number | null): MatchState {
    const c = this.cfg;
    const s = this.state;
    if (midi === null) {
      if ((f.t - this.lastVoicedT) * 1000 > c.graceMs) {
        this.seg = [];
        this.sm1 = [];
        this.sm2 = [];
        return { ...s, voiced: false, stable: false, detectedMidi: null, cents: null, inTolerance: false, progress: 0, hint: null };
      }
      return { ...s, voiced: false };
    }
    this.lastVoicedT = f.t;
    // Unfolded cents relative to the target; in pitchClass mode fold each note to the target's
    // nearest octave, but keep continuity with the previous frame (no wrap jumps).
    let cents = this.deviation(midi);
    if (c.mode === 'pitchClass' && this.seg.length) {
      const prev = this.seg[this.seg.length - 1].c;
      while (cents - prev > 600) cents -= 1200;
      while (prev - cents > 600) cents += 1200;
    }
    if (this.seg.length && Math.abs(cents - this.seg[this.seg.length - 1].c) > c.jumpCents) {
      this.seg = [];
      this.sm1 = [];
      this.sm2 = [];
    }
    if (!this.seg.length) {
      this.segFirstT = f.t;
      // Did this note start with an attack (rise from a quieter level), or was it already there?
      const prior = this.hist.filter((r) => r.t < f.t - 1e-6 && r.t >= f.t - 0.4);
      this.segOnset = prior.length > 0 && db - Math.min(...prior.map((r) => r.db)) >= 6;
    }
    this.seg.push({ t: f.t, c: cents, db });
    const horizon = f.t - (c.holdMs + 200) / 1000;
    while (this.seg.length && this.seg[0].t < horizon) this.seg.shift();

    // Two-stage moving average.
    const w = c.smoothMs / 1000;
    const in1 = this.seg.filter((p) => p.t > f.t - w);
    const v1 = in1.reduce((a, p) => a + p.c, 0) / in1.length;
    this.sm1.push({ t: f.t, v: v1 });
    while (this.sm1.length && this.sm1[0].t < horizon) this.sm1.shift();
    const in2 = this.sm1.filter((p) => p.t > f.t - w);
    const v2 = in2.reduce((a, p) => a + p.v, 0) / in2.length;
    this.sm2.push({ t: f.t, v: v2 });
    while (this.sm2.length && this.sm2[0].t < horizon) this.sm2.shift();

    const segStart = this.segStartT();
    const age = (f.t - segStart) * 1000;
    const settledAge = 2 * c.smoothMs + c.trendMs;
    const display = v1; // single-stage average: responsive, vibrato mostly damped
    const inTolNow = Math.abs(v2) <= c.toleranceCents;

    let hint: MatchState['hint'] = null;
    let accepted = false;
    let wrong = s.wrongAttempts;
    let meanAbs: number | null = null;
    if (age >= Math.max(settledAge, c.holdMs) - 10) {
      const old = this.sm2.find((p) => p.t >= f.t - c.trendMs / 1000 - 1e-6);
      const trend = old ? Math.abs(v2 - old.v) : Infinity;
      const win = this.seg.filter((p) => p.t > f.t - c.holdMs / 1000);
      const dbSlope = slope(win.map((p) => p.t), win.map((p) => p.db));
      // Speech: syllables leave unvoiced gaps and wander far from the smoothed centre.
      const span = this.hist.filter((r) => r.t > f.t - c.holdMs / 1000);
      const voicedFrac = span.length ? span.filter((r) => r.midi !== null).length / span.length : 0;
      const wander = Math.max(...win.map((p) => Math.abs(p.c - v2)));
      const steady = trend <= c.maxTrendCents && voicedFrac >= 0.96 && wander <= 190;
      // Sustained = no plucked-string behaviour anywhere in the window: neither half may be
      // dying away fast, and there must be no re-attack (repeated plucks look "sustained" on
      // average).
      const mid = f.t - c.holdMs / 2000;
      const h1 = win.filter((p) => p.t <= mid);
      const h2 = win.filter((p) => p.t > mid);
      const s1 = slope(h1.map((p) => p.t), h1.map((p) => p.db));
      const s2 = slope(h2.map((p) => p.t), h2.map((p) => p.db));
      let maxRise = 0;
      for (let i = 0; i < win.length; i++) {
        let lo = Infinity;
        for (let j = i - 1; j >= 0 && win[i].t - win[j].t <= 0.1 + 1e-6; j--) lo = Math.min(lo, win[j].db);
        if (lo < Infinity) maxRise = Math.max(maxRise, win[i].db - lo);
      }
      const sustained = dbSlope >= c.minDbSlope && s1 >= 2 * c.minDbSlope && s2 >= 2 * c.minDbSlope && maxRise < 9;
      // Mains hum (50/60 Hz and low harmonics) is steady, exactly on frequency and has no attack.
      // A note within 8 cents of one of those frequencies only counts if it started with an attack.
      const hz = midiToFreq(median(win.map((p) => p.c)) / 100 + this.cfg.targetMidi + this.octaveOffset(midi));
      const humLike = MAINS_HZ.some((m) => Math.abs(1200 * Math.log2(hz / m)) < 8) && !this.segOnset;
      if (!steady) hint = 'moving';
      else if (!sustained) hint = 'decaying';
      if (steady && sustained && !humLike) {
        if (inTolNow) {
          accepted = true;
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
    const progress = inTolNow || Math.abs(display) <= c.toleranceCents ? Math.min(1, age / Math.max(settledAge, c.holdMs)) : 0;
    return {
      voiced: true, stable: true, detectedMidi: this.displayMidi(),
      cents: display, inTolerance: Math.abs(display) <= c.toleranceCents, progress: accepted ? 1 : progress,
      accepted, acceptedAt: accepted ? f.t : null, meanAbsCents: meanAbs, wrongAttempts: wrong, hint,
    };
  }

  /** Octave (in semitones) between the folded target-relative value and the sung pitch. */
  private octaveOffset(midi: number): number {
    const last = this.seg[this.seg.length - 1];
    return Math.round((midi - (this.cfg.targetMidi + last.c / 100)) / 12) * 12;
  }

  private segStartT(): number {
    return this.segFirstT ?? Infinity;
  }
  private segFirstT: number | null = null;
  private segOnset = false;

  // ------------------------------------------------------------------ plucked

  private pushPlucked(f: PitchFrame, db: number, midi: number | null): MatchState {
    const c = this.cfg;
    const s = this.state;
    const t = f.t;
    this.upHist.push({ t, up: f.upClarity ?? 0, midi });
    while (this.upHist.length && this.upHist[0].t < t - 0.5) this.upHist.shift();

    // ---- onset
    const before = this.hist.filter((r) => r.t >= t - 0.14 - 1e-6 && r.t <= t - 0.04 + 1e-6);
    if (before.length >= 2 && t - this.lastOnsetT >= 0.08) {
      const minBefore = Math.min(...before.map((r) => r.db));
      const prevDb = this.hist.length >= 2 ? this.hist[this.hist.length - 2].db : -Infinity;
      // An attack: well above the level of 40–140 ms ago, and still rising at this frame.
      if (db - minBefore >= c.onsetRiseDb && db >= c.minDb && db > prevDb + 1) {
        const pre = this.upHist.filter((u) => u.t < t - 0.03);
        const preUps = pre.slice(-4).map((u) => u.up);
        const preMidis = pre.slice(-4).map((u) => u.midi).filter((m): m is number => m !== null);
        this.cand = {
          onsetT: t, peakT: t, peakDb: db, runMin: db, state: 'pending', counted: false,
          preUp: preUps.length ? Math.max(...preUps) : 0, preMidi: preMidis.length ? median(preMidis) : null,
          goodMidi: null,
        };
        this.lastOnsetT = t;
      }
    }

    const cand = this.cand;
    let hint: MatchState['hint'] = null;
    if (cand && cand.state !== 'rejected') {
      if (t - cand.onsetT <= 0.1 && db > cand.peakDb) {
        cand.peakDb = db;
        cand.peakT = t;
        cand.runMin = db;
      } else if (t > cand.peakT) {
        cand.runMin = Math.min(cand.runMin, db);
        if (db > cand.runMin + c.maxReswellDb) cand.state = 'rejected';
      }
      const seg = c.decaySegMs / 1000;
      if (cand.state === 'pending' && t >= cand.peakT + 2 * seg - 1e-6) {
        // Free decay: the level falls in each of two consecutive segments. The segments start at
        // the peak, or a little later (up to decayStartSlackMs) because room reflections can hold
        // the level up briefly after the attack.
        const mean = (a: number, b: number) => {
          const xs = this.hist.filter((r) => r.t >= a - 1e-6 && r.t <= b + 1e-6).map((r) => r.db);
          return xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : NaN;
        };
        const s0 = t - 2 * seg;
        const m0 = mean(s0, s0 + 0.03);
        const m1 = mean(s0 + seg - 0.02, s0 + seg + 0.02);
        const m2 = mean(t - 0.04, t);
        // A string rings continuously; speech has unvoiced gaps between syllables.
        const gaps = this.hist.filter((r) => r.t >= cand.peakT - 1e-6 && r.midi === null).length;
        if (m0 - m1 >= c.minSegDecayDb && m1 - m2 >= c.minSegDecayDb && gaps <= 1) cand.state = 'confirmed';
        else if (s0 >= cand.peakT + c.decayStartSlackMs / 1000) {
          cand.state = 'rejected';
          hint = 'sustained';
        }
      }
      if (t - cand.onsetT > c.maxAcceptAfterOnsetMs / 1000) cand.state = 'rejected';
    } else if (cand && cand.state === 'rejected' && t - cand.onsetT < 1.5) {
      hint = 'sustained';
    }

    // New note an octave above a still-ringing note: the detector keeps reporting the lower
    // (ringing) pitch, but periodicity at half its period jumped with this onset. Re-read such
    // frames an octave up. Only after an onset, only when that same lower note was already
    // ringing before it, and only for the octave below the target.
    if (cand && c.mode === 'exact' && cand.preMidi !== null && midi !== null && t > cand.onsetT) {
      const up = f.upClarity ?? 0;
      if (
        Math.abs(midi - cand.preMidi) < 0.5 &&
        Math.abs(midi - (c.targetMidi - 12)) < 0.5 &&
        up >= 0.8 &&
        up - cand.preUp >= 0.25
      ) {
        this.hist[this.hist.length - 1].midi = midi + 12;
      }
    }

    // ---- pitch over a window entirely after the onset
    const disp = this.displayMidi();
    if (cand && cand.state !== 'rejected') {
      const from = Math.max(t - c.pitchWindowMs / 1000, cand.onsetT + 0.04);
      const win = this.hist.filter((r) => r.t > from - 1e-6);
      const span = (t - from) * 1000;
      const voicedWin = win.filter((r) => r.midi !== null) as { t: number; db: number; midi: number }[];
      if (span >= c.pitchWindowMs - 25 && voicedWin.length >= win.length - 1 && voicedWin.length >= 5) {
        const midis = voicedWin.map((r) => r.midi);
        const range = (Math.max(...midis) - Math.min(...midis)) * 100;
        if (range <= c.pitchRangeCents) {
          // Remember the latest steady window: the pitch may already be clear before the decay
          // has been confirmed (and a ringing neighbour may take over the detector later).
          cand.goodMidi = median(midis);
        } else if (!hint) hint = 'moving';
      }
    }
    const windowMidi = cand && cand.state !== 'rejected' ? cand.goodMidi : null;
    const windowDev = windowMidi !== null ? this.deviation(windowMidi) : null;
    const pitchOk = windowMidi !== null;

    let wrong = s.wrongAttempts;
    let accepted = false;
    if (cand && cand.state === 'confirmed' && pitchOk && windowDev !== null) {
      if (Math.abs(windowDev) <= c.toleranceCents) {
        accepted = !c.neverAccept;
      } else if (!cand.counted && windowMidi !== null) {
        const rounded = Math.round(windowMidi);
        if (rounded !== c.ignoreMidi) wrong++;
        cand.counted = true;
      }
    }
    const cents = accepted && windowDev !== null ? windowDev : disp !== null ? this.deviation(disp) : null;
    const inTol = cents !== null && Math.abs(cents) <= c.toleranceCents;
    let progress = 0;
    if (cand && cand.state !== 'rejected' && inTol) progress = cand.state === 'confirmed' ? 0.8 : Math.min(0.7, (t - cand.onsetT) / 0.35);
    return {
      voiced: midi !== null,
      stable: disp !== null,
      detectedMidi: accepted && windowMidi !== null ? windowMidi : disp,
      cents,
      inTolerance: inTol,
      progress: accepted ? 1 : progress,
      accepted,
      acceptedAt: accepted ? t : null,
      meanAbsCents: accepted && windowDev !== null ? Math.abs(windowDev) : null,
      wrongAttempts: wrong,
      hint: accepted ? null : hint,
    };
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
  private minDb = -75;
  private stableFrames = 3;
  private stableCents = 40;
  private smoothFrames = 5;
  private graceMs = 80;

  push(f: PitchFrame): number | null {
    const voiced = f.freq > 0 && f.clarity >= this.minClarity && rmsToDb(f.rms) >= this.minDb;
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
