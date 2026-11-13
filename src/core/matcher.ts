// Gating, stability and hold logic that turns a stream of raw pitch detections into
// "the student is holding the target note" decisions. Pure TypeScript, no DOM.
import { centsFromMidi, centsFromPitchClass, freqToMidi } from './music.ts';
import { rmsToDb } from './pitch.ts';

/** One analysed frame: time in seconds plus the detector output. */
export interface PitchFrame {
  t: number;
  freq: number;
  clarity: number;
  rms: number;
}

export type MatchMode = 'pitchClass' | 'exact';

export interface MatchConfig {
  targetMidi: number;
  /** 'pitchClass' = any octave counts (singing); 'exact' = same octave (guitar). */
  mode: MatchMode;
  toleranceCents: number;
  /** How long the pitch must stay within tolerance before accepting. */
  holdMs: number;
  /** Minimum NSDF clarity for a frame to count as voiced. */
  minClarity: number;
  /** Minimum frame level in dBFS for a frame to count as voiced. */
  minDb: number;
  /** Number of consecutive voiced frames that must agree before a pitch is trusted. */
  stableFrames: number;
  /** Max spread (cents) among those frames. */
  stableCents: number;
  /** Median-smoothing window (frames) for the displayed / tested pitch. Averages out vibrato. */
  smoothFrames: number;
  /** An unvoiced gap shorter than this does not reset the hold. */
  graceMs: number;
  /** A trusted pitch held this long outside tolerance counts as one wrong attempt. */
  wrongNoteMs: number;
  /**
   * Require a fresh attack (silence gap or a ≥6 dB level jump) before the hold may start.
   * Used for repeated notes so a still-ringing previous note cannot pass the next step.
   */
  needAttack?: boolean;
  /** A still-ringing previous note: holding this (rounded) MIDI note is not counted as a wrong attempt. */
  ignoreMidi?: number;
}

export const SING_DEFAULTS: Omit<MatchConfig, 'targetMidi' | 'toleranceCents'> = {
  mode: 'pitchClass',
  holdMs: 500,
  minClarity: 0.8,
  minDb: -65,
  stableFrames: 3,
  stableCents: 70,
  smoothFrames: 9,
  graceMs: 80,
  wrongNoteMs: 300,
};

export const GUITAR_DEFAULTS: Omit<MatchConfig, 'targetMidi' | 'toleranceCents'> = {
  mode: 'exact',
  holdMs: 80,
  minClarity: 0.88,
  minDb: -70,
  stableFrames: 3,
  stableCents: 25,
  smoothFrames: 3,
  graceMs: 60,
  wrongNoteMs: 150,
};

export interface MatchState {
  /** True when the current frame passes level + clarity gating. */
  voiced: boolean;
  /** True when the recent voiced frames agree (a trusted pitch). */
  stable: boolean;
  /** Smoothed detected pitch as fractional MIDI, or null. */
  detectedMidi: number | null;
  /** Smoothed deviation from the target in cents (octave-folded in pitchClass mode), or null. */
  cents: number | null;
  inTolerance: boolean;
  /** 0..1 progress of the hold. */
  progress: number;
  accepted: boolean;
  /** Time (s) the hold completed. */
  acceptedAt: number | null;
  /** Mean |cents| over the frames counted in the accepted hold. */
  meanAbsCents: number | null;
  /** Number of distinct wrong notes held (attempts that missed). */
  wrongAttempts: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class NoteMatcher {
  readonly cfg: MatchConfig;
  private recent: { t: number; midi: number }[] = []; // consecutive voiced frames
  private smooth: number[] = [];
  private lastVoicedT = -Infinity;
  private holdStart: number | null = null;
  private holdCents: number[] = [];
  private wrongStart: number | null = null;
  private wrongMidi: number | null = null;
  private lastCountedWrong: number | null = null;
  private state: MatchState;
  private attackSeen: boolean;
  private minRms = Infinity;

  constructor(cfg: MatchConfig) {
    this.cfg = cfg;
    this.attackSeen = !cfg.needAttack;
    this.state = {
      voiced: false, stable: false, detectedMidi: null, cents: null, inTolerance: false,
      progress: 0, accepted: false, acceptedAt: null, meanAbsCents: null, wrongAttempts: 0,
    };
  }

  get current(): MatchState {
    return this.state;
  }

  private deviation(midi: number): number {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    return this.cfg.mode === 'exact'
      ? centsFromMidi(freq, this.cfg.targetMidi)
      : centsFromPitchClass(freq, this.cfg.targetMidi);
  }

  push(f: PitchFrame): MatchState {
    const c = this.cfg;
    const s = this.state;
    if (s.accepted) return s;

    const voiced =
      f.freq > 0 && f.clarity >= c.minClarity && rmsToDb(f.rms) >= c.minDb && f.freq >= 55 && f.freq <= 1400;

    if (!this.attackSeen) {
      if ((!voiced && (f.t - this.lastVoicedT) * 1000 > c.graceMs) || f.rms > 2 * this.minRms) this.attackSeen = true;
      this.minRms = Math.min(this.minRms, f.rms);
    }

    if (!voiced) {
      const gap = (f.t - this.lastVoicedT) * 1000;
      if (gap > c.graceMs) {
        this.recent = [];
        this.smooth = [];
        this.holdStart = null;
        this.holdCents = [];
        this.wrongStart = null;
        this.state = { ...s, voiced: false, stable: false, detectedMidi: null, cents: null, inTolerance: false, progress: 0 };
      } else {
        this.state = { ...s, voiced: false };
      }
      return this.state;
    }

    this.lastVoicedT = f.t;
    const midi = freqToMidi(f.freq);
    this.recent.push({ t: f.t, midi });
    if (this.recent.length > c.stableFrames) this.recent.shift();
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of this.recent) {
      lo = Math.min(lo, r.midi);
      hi = Math.max(hi, r.midi);
    }
    const stable = this.recent.length >= c.stableFrames && (hi - lo) * 100 <= c.stableCents;
    if (!stable) {
      // A pitch jump (new note / attack transient): restart smoothing and hold.
      this.smooth = [];
      this.holdStart = null;
      this.holdCents = [];
      this.state = { ...s, voiced: true, stable: false, inTolerance: false, progress: 0 };
      return this.state;
    }

    this.smooth.push(midi);
    if (this.smooth.length > c.smoothFrames) this.smooth.shift();
    const sm = median(this.smooth);
    const cents = this.deviation(sm);
    const inTol = Math.abs(cents) <= c.toleranceCents;
    if (!this.attackSeen) {
      this.state = { ...s, voiced: true, stable: true, detectedMidi: sm, cents, inTolerance: inTol, progress: 0 };
      return this.state;
    }

    let progress = 0;
    let accepted = false;
    let acceptedAt: number | null = null;
    let meanAbs: number | null = null;
    let wrongAttempts = s.wrongAttempts;
    if (inTol) {
      this.wrongStart = null;
      if (this.holdStart === null) {
        this.holdStart = f.t;
        this.holdCents = [];
      }
      this.holdCents.push(Math.abs(cents));
      const held = (f.t - this.holdStart) * 1000;
      progress = Math.min(1, held / c.holdMs);
      if (held >= c.holdMs) {
        accepted = true;
        acceptedAt = f.t;
        meanAbs = this.holdCents.reduce((a, b) => a + b, 0) / this.holdCents.length;
      }
    } else {
      this.holdStart = null;
      this.holdCents = [];
      const rounded = Math.round(sm);
      if (this.wrongMidi !== rounded) {
        this.wrongMidi = rounded;
        this.wrongStart = f.t;
      }
      if (
        this.wrongStart !== null &&
        (f.t - this.wrongStart) * 1000 >= c.wrongNoteMs &&
        this.lastCountedWrong !== rounded &&
        rounded !== c.ignoreMidi
      ) {
        wrongAttempts++;
        this.lastCountedWrong = rounded;
      }
    }

    this.state = {
      voiced: true, stable: true, detectedMidi: sm, cents, inTolerance: inTol, progress,
      accepted, acceptedAt, meanAbsCents: meanAbs, wrongAttempts,
    };
    return this.state;
  }
}

/**
 * Free-running tuner smoothing: reports the trusted, median-smoothed note (no target).
 * Used by the tuner / mic-check screen and for phrase-review "which note is ringing".
 */
export class StablePitch {
  private recent: number[] = [];
  private smooth: number[] = [];
  private lastVoicedT = -Infinity;
  private minClarity = 0.85;
  private minDb = -70;
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
