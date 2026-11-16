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
//                window after that attack. A later octave/fifth flip of the detector (a dying
//                note, hum) does not change it — the candidate is given up instead; only a jump
//                of a few semitones early on (a late-landing finger, a hammer-on or pull-off)
//                re-identifies the note. It is accepted only when the reading NOW is on the
//                target fret (still settling down from a hard pick on the sharp side counts; still
//                falling on the flat side does not) AND the identity was not below the target
//                fret (so the fret below on a sharp string, whose reading creeps up as it decays,
//                never counts). A sound with no attack of its own — the tail of the sung answer,
//                a note still ringing — never opens a candidate. Guitar step, default: an attack
//                is taken as a pluck unless there is positive evidence of a voice (after its
//                peak it does not die away steadily like a string but holds its level — after
//                any onset accent — up to 0.6 s, or it is the sung answer that has not stopped
//                since the step opened); the attack's rise time is NOT used — in a room the
//                reverberation makes a pluck rise as slowly as a hum.
//
// `strict` ("strict instrument check" setting, off by default) adds envelope-shape tests: sung
// notes must not decay like a string, plucked notes must decay freely after the attack and must
// start like a pluck (fast rise) — which can reject honest plucks in echoey rooms.
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
  /** level of harmonics 4–10 relative to harmonics 1–2 of the detected pitch (dB) */
  tiltDb?: number;
  /** of the new power, odd vs even harmonics of the detected pitch (dB) */
  novOddDb?: number;
  /** attack shapes measured on every sample of the guitar path in the last few seconds */
  attacks?: FrameAttack[];
  /** loudest level heard while the analysis last stopped listening (our reference tone), dB */
  mutePeakDb?: number | null;
}

/** One attack seen by the stream analyser: when its rise started, how fast and how big it was. */
export interface FrameAttack {
  t: number;
  riseMs: number;
  riseDb: number;
  band: 'full' | 'hf' | 'mid';
  /** see AttackEvent.edgeDb */
  edgeDb?: number;
  /** see AttackEvent.carried */
  carried?: boolean;
  /** see AttackEvent.muted */
  muted?: boolean;
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
   * Plucked only: only a sound that started like a plucked string counts (see `classify`): a
   * hum, a sung or spoken vowel builds up too slowly. On in the guitar step, off in the phrase
   * review (fast playing over ringing strings, where a new note barely changes the level).
   */
  needPluck?: boolean;
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
  /** The reference tone just played for this step: its tail in a live room is not the student. */
  refMidi?: number;
  /** Level (dB) heard just before the reference was played — at the previous step's accept: what
   * the previous note's string has to decay from (guards carry-over). */
  preDb?: number;
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
  /** Guitar step right after the singing step: the pitch the student just sang (diagnostics). */
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

/**
 * What kind of attack is this? Rise times (10 → 80 % of the added power, 5 ms envelope) measured
 * on all our string models are 1–8 ms (up to 11 on the lowest notes), with a sharp click above
 * 3 kHz from the pick or nail; voices (hum, sung or spoken vowels) take 9 ms and more and have
 * no such click. Flesh and thumb plucks (no click, 11–31 ms) are ambiguous: decided later by
 * the timbre (see TILT_DROP_DB).
 */
export function attackKind(full: FrameAttack | undefined, hf: FrameAttack | undefined, mid?: FrameAttack, midRise = true): 'pluck' | 'ambiguous' | 'voice' | null {
  const click = !!hf && hf.riseMs <= 6 && hf.riseDb >= 8;
  // A low steady sound (mains hum, fan rumble) as loud as a quiet pluck swings the full band's
  // level by several dB every cycle and hides the attack there; above 500 Hz and 3 kHz the
  // pluck still starts at once.
  if (full && mid && hf && full.riseDb < 10 && mid.riseMs <= 5 && mid.riseDb >= 6 && hf.riseMs <= 4 && hf.riseDb >= 4) return 'pluck';
  // (the rise above the guitar body's resonances, when it is faster: a voice builds up equally
  // slowly in every band, a string is at full strength at once wherever the body does not ring.
  // Only from G3 up: a lower voice's glottal pulses come further apart than the 5 ms envelope,
  // and there the first pulse alone looks like an instant rise.)
  if (midRise && full && mid && mid.riseDb >= 6 && mid.riseMs < full.riseMs) full = { ...full, riseMs: mid.riseMs };
  // (a pick's click that is sharp and strong both above 500 Hz and above 3 kHz: whatever the low
  // band does — a TV or a body resonance can blur it — no voice starts like that; a spoken
  // consonant's burst is followed by its vowel, which puts the middle band's peak later)
  if (hf && mid && hf.riseMs <= 3 && hf.riseDb >= 15 && mid.riseMs <= 3 && mid.riseDb >= 15) return 'pluck';
  // (the full band barely moved — a louder voice was sounding — but the pick's click clearly did)
  if (full && full.riseDb < 6 && hf && hf.riseMs <= 6 && hf.riseDb >= 10) return 'pluck';
  if (full && full.riseDb >= 3 && !(full.riseMs <= 3 && full.riseDb < 5 && hf && hf.riseDb >= 5)) {
    // (a sharp rise of only a few dB is a flicker of the room noise, or of a string still ringing,
    // unless the click confirms it)
    if (full.riseMs <= 8 && click) return 'pluck';
    // (a rise this fast only comes from an impulse: a voice — even a hard "da" — needs a few
    // glottal cycles to build up, which the 5 ms envelope shows as at least ~5 ms)
    if (full.riseMs <= 4 && full.riseDb >= 8) return 'pluck';
    // (a soft pluck without a click, or a hard-onset syllable: the sound's development decides)
    if (full.riseMs <= 8 && full.riseDb >= 8) return 'ambiguous';
    if (full.riseMs <= 12 && click) return 'pluck';
    if (full.riseMs <= 8) return null;
    if (full.riseMs <= AMBIGUOUS_RISE_MS) return 'ambiguous';
    return 'voice';
  }
  // the full band barely moved (a louder voice was sounding): a pick's click still shows above
  // 3 kHz — clearly on its own, or as a smaller rise together with an instant full-band step
  if (hf && hf.riseMs <= 6 && hf.riseDb >= 10) return 'pluck';
  if (full && hf && full.riseMs <= 3 && full.riseDb >= 2.5 && hf.riseDb >= 5) return 'pluck';
  return null;
}
/** NSDF height at half the read period above which a reading is taken one octave up (plucked). */
export const OCTAVE_UP_CLARITY = 0.65;
/** Up to this rise time the source is decided by how the timbre develops. */
export const AMBIGUOUS_RISE_MS = 34;
/** ...a string's upper partials lose at least this much against its fundamental in 0.25 s. */
export const TILT_DROP_DB = 1.5;
/** A plucked note must have sounded at least this long (from its attack) before it is accepted. */
export const MIN_DWELL_S = 0.16;

export type MatchHint =
  /** guitar step: the right pitch is sounding but it started like a voice (hum, sung or spoken), not a pluck */
  | 'voiceLike'
  /** guitar step: the student is still singing (louder than the string): stop, then pluck */
  | 'singing'
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
  /** phrase review: the same note as the one before still sounds — pluck it again, firmer */
  | 'repeatSoft'
  /** singing step: what is heard is the note the app just played, still echoing in the room */
  | 'refEcho'
  /** singing step, repeated note: the note just played still sounds (the string, or the echo) */
  | 'stillSounding'
  /** the note stopped before it could be judged (singing: hold it about half a second; guitar: a
   * pluck damped at once) */
  | 'tooShort'
  /** singing step: something is sounding but its pitch can't be read (too quiet for the room) */
  | 'unclear'
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
  /** the detector's own reading (before any octave lift) */
  raw?: number | null;
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
  /** spectral tilt (upper vs lower harmonics), dB, when pitched */
  tilt: number | null;
  /** new power on odd vs even harmonics (dB) */
  novOdd: number | null;
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
  /** what made the attack: a plucked string, a voice, or not decided yet */
  source: 'pending' | 'ambiguous' | 'pluck' | 'voice';
  /** taken over from the attack before (an onset with no attack of its own) */
  inherited?: boolean;
  /** opened while the sung answer was still sounding: the voice's loudest level just before */
  underVoice?: number;
  /** level of the last frame before the onset window */
  preLast?: number;
  /** identified on the target (this reading) while its source was still being decided */
  ready?: number;
  /** loudest level in the 0.3 s before the onset */
  preMax?: number;
  /** positive evidence of a new plucked sound over one already sounding (see isBright) */
  bright?: boolean;
  /** the "what's new" reading identified the target right after the attack */
  novTarget?: boolean;
  /** default guitar step: did not lose level just after its peak (second look pending) */
  held?: boolean;
  /** this pluck is the octave above the note that was sounding (that note's MIDI) */
  octaveUp?: number;
  /** time after the onset before pitch is read (skips the pick noise of an attack) */
  lead: number;
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
  /** the carry-over guard has held this segment back (see pushSung) */
  private guardHeld = false;
  /** something new began since the reference started (see pushSung) */
  private newSound = false;
  private onsetCut = false;
  private levelRoseT: number | null = null;
  private cutAt: { t: number; quiet: number } | null = null;
  private openDb = -Infinity;
  /** attacks heard while the reference played (see mergeAttacks) */
  private mutedAtk: FrameAttack[] = [];
  private tooShortUntil = -Infinity;
  private unclearUntil = -Infinity;
  private lastSungMidi: number | null = null;
  /** consecutive sung frames read within 0.3 st of each other */
  private sungRun = 0;
  private lastVoicedT = -Infinity;
  private lastCountedWrong: number | null = null;
  // plucked
  private cand: Candidate | null = null;
  private lastOnsetT = -Infinity;
  private lastLevelOnsetT = -Infinity;
  /** attack events up to this time belong to a candidate already opened */
  private coveredT = -Infinity;
  /** attack events from the stream analyser */
  private atk: FrameAttack[] = [];
  /** what started the most recent classified sound */
  private lastSource: { kind: 'pluck' | 'voice'; t: number } | null = null;
  private prevNovShare = 1;
  private prevNovShare2 = 1;
  /** when the share of new power last rose past 0.4 (its rising edge), and whether it was used */
  private novEdgeT = -Infinity;

  /** guitar step: the sung answer may still be sounding (until the level has gone quiet) */
  private sungOn = true;
  /** when the sung answer was found to have stopped */
  private sungEndT = -Infinity;
  /** a fall of the sung answer's level, not yet confirmed as its end */
  private sungDrop: { t: number; ref: number } | null = null;
  private startLevels: number[] = [];
  private quietFrames = 0;

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

  /**
   * Give the matcher recent context (frames heard just before it was created) without letting
   * anything in them count: an attack inside them opens no candidate. Lets a following note's
   * attack or pitch change be recognised right away (fast phrase review).
   */
  prime(frames: PitchFrame[]): void {
    for (const f of frames) {
      const db = rmsToDb(f.cleanRms ?? f.rms);
      const voiced = f.freq > 0 && f.clarity >= this.cfg.minClarity && db >= this.cfg.minDb;
      this.hist.push({ t: f.t, db, rawDb: rmsToDb(f.rms), clarity: f.clarity, midi: voiced ? freqToMidi(f.freq) : null, nov: null, up: f.upClarity ?? 0, hf: f.hfDb ?? -200, tilt: f.freq > 0 ? (f.tiltDb ?? null) : null, novOdd: null, nsdf: f.nsdf, sr: f.sr });
      this.mergeAttacks(f);
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
    let voiced = f.freq > 0 && f.clarity >= c.minClarity && db >= c.minDb && f.freq >= 55 && f.freq <= 1700;
    // Singing: a quiet voice in a noisy room reads less clearly (clarity 0.45–0.7) but its pitch
    // carries on smoothly from the frame before — that frame still counts.
    if (!voiced && c.kind === 'sung' && f.freq >= 55 && f.freq <= 1700 && f.clarity >= 0.45 && db >= c.minDb && this.lastSungMidi !== null && f.t - this.lastVoicedT <= 0.1 && Math.abs(freqToMidi(f.freq) - this.lastSungMidi) < 0.3) voiced = true;
    let midi = voiced ? freqToMidi(f.freq) : null;
    // (a quiet voice in a noisy room: the detector can lock onto every third cycle for a frame,
    // a twelfth (or a twelfth and an octave) below the note sung a moment ago — that is still the
    // same note, no voice jumps that far within 0.1 s)
    // (only toward a pitch already read steadily for 3 frames: a thin voice whose third harmonic
    // is read for one frame at the onset must not drag every later, correct frame up with it)
    if (c.kind === 'sung' && midi !== null && this.lastSungMidi !== null && this.sungRun >= 3 && f.t - this.lastVoicedT <= 0.1) {
      for (const d of [19, 31]) if (Math.abs(midi + d - this.lastSungMidi) < 0.3) midi += d;
    }
    // (a voice whose third harmonic a room resonance has lifted above the fundamental — "oh" in a
    // live room — reads a twelfth high with full clarity; the waveform still repeats better at
    // three times the period read than at the period itself or twice it, which no note at the
    // read pitch does: that is the note sung. Only toward the target.)
    if (c.kind === 'sung' && midi !== null && f.nsdf) {
      const low = midi - 19;
      const d = low - c.targetMidi;
      const near = c.mode === 'exact' ? Math.abs(d) < 0.6 : Math.abs((((d % 12) + 18) % 12) - 6) < 0.6;
      if (near) {
        const sr = f.sr ?? 48000;
        const p1 = periodicityAt(f.nsdf, sr, f.freq);
        const p2 = periodicityAt(f.nsdf, sr, f.freq / 2);
        const p3 = periodicityAt(f.nsdf, sr, f.freq / 3);
        if (p3 >= 0.98 && p3 >= p1 + 0.005 && p3 >= p2 + 0.005) midi = low;
      }
    }
    if (c.kind === 'sung' && midi !== null) {
      this.sungRun = this.lastSungMidi !== null && Math.abs(midi - this.lastSungMidi) < 0.3 ? this.sungRun + 1 : 1;
      this.lastSungMidi = midi;
    }
    // (a guitar note read an octave low: the detector took two periods for one — the waveform
    // also repeats strongly at half the period read, which a real note an octave lower never
    // does. Heard with nylon and thumb plucks in reverberant rooms.)
    // (a real note an octave lower reads with full clarity; the misread is less clear)
    // (not while the sung answer is still sounding at exactly that pitch: a thin voice repeats
    // strongly at half its period too, and it is not the string)
    const rawMidi = midi;
    if (c.kind === 'plucked' && midi !== null && (f.upClarity ?? 0) >= OCTAVE_UP_CLARITY && f.clarity < 0.96 && Math.abs(midi + 12 - c.targetMidi) < 0.6 &&
      !(this.sungOn && c.voiceMidi !== undefined && Math.abs(midi - c.voiceMidi) < 0.5)) {
      midi += 12;
    }
    const nov = f.novFreq && (f.novClarity ?? 0) >= 0.75 && f.novFreq >= 55 && f.novFreq <= 1700 ? freqToMidi(f.novFreq) : null;
    this.hist.push({ t: f.t, db, rawDb: rmsToDb(f.rms), clarity: f.clarity, midi, raw: rawMidi, nov, up: f.upClarity ?? 0, hf: f.hfDb ?? -200, tilt: midi !== null ? (f.tiltDb ?? null) : null, novOdd: midi !== null && (f.novShare ?? 0) >= 0.2 ? (f.novOddDb ?? null) : null, nsdf: f.nsdf, sr: f.sr });
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
    this.guardHeld = false;
  }

  private pushSung(f: PitchFrame, db: number, midi: number | null): MatchState {
    const c = this.cfg;
    const s = this.state;
    this.mergeAttacks(f);
    if (midi === null) {
      if ((f.t - this.lastVoicedT) * 1000 > c.graceMs) {
        // A note that stopped before it could be judged: say so — if it really stopped (the level
        // fell); if the sound goes on but its pitch can't be read (a quiet voice in a noisy room),
        // say that instead. (Whatever the pitch: with the meter off this must not reveal it.)
        const len = this.segFirstT !== null ? this.lastVoicedT - this.segFirstT : 0;
        // (not of a sound that was there before anything new began — the reference's echo, a
        // string ringing: a student who has not sung is not told to sing longer or louder)
        if (this.seg.length && len >= 0.15 && len < (c.holdMs + 150) / 1000 && (this.segOnset || this.newSound)) {
          const segDb = median(this.seg.map((p) => p.db));
          if (rmsToDb(f.rms) < segDb - 6) {
            this.tooShortUntil = f.t + 2;
            this.unclearUntil = -Infinity;
          } else this.unclearUntil = f.t + 2;
        }
        this.resetSeg();
        const hint: MatchHint | null = f.t < this.tooShortUntil ? 'tooShort' : f.t < this.unclearUntil ? 'unclear' : null;
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
    // (followed that way from something else — a TV, speech — the note can end up counted an
    // octave away from the target although its pitch class is right: start afresh from it)
    if (c.mode === 'pitchClass' && Math.abs(cents) > 600) {
      this.resetSeg();
      while (cents > 600) cents -= 1200;
      while (cents < -600) cents += 1200;
    }
    // (the carry-over guard was holding back a sound left over from before — the reference's
    // tail, a string still ringing — and the level now turns up: something new has started. It
    // is judged on its own from here, not by the old segment it landed on, whose smoothed pitch
    // still lags at the old note for a moment)
    // (the new segment keeps the old one's "was it already sounding" answer: what is left when
    // the new sound stops — the string still ringing — is still the old sound)
    let risen = false;
    if (this.guardHeld && this.seg.length) {
      // (louder than anything in the last few tenths of a second: not the old sound's own wobble)
      const recent = this.hist.filter((r) => r.t < f.t - 0.05 && r.t >= f.t - 0.3);
      if (recent.length && db - Math.max(...recent.map((r) => r.db)) >= 2) {
        this.resetSeg();
        risen = true;
      }
    }
    // Has anything new begun since the reference started — an attack while the reference played
    // or in this step, or the level rising well above where it has been? A sound that was already
    // there, unchanged, when the step opened (the reference's echo, a string ringing in sympathy)
    // is not the student starting to sing (see the carry-over guard below).
    const t0 = this.firstT ?? f.t;
    const stepOnsets = this.atk.filter((a) => !a.carried && a.band !== 'hf' && a.riseDb >= 6 && a.t >= t0 - 0.3);
    const quietest = Math.min(...this.hist.filter((r) => r.t >= t0 - 1e-6).map((r) => r.db), db);
    // (when the level first rose well above the quietest it has been since the step opened)
    if (this.levelRoseT === null && db >= quietest + 9) this.levelRoseT = f.t;
    // (or what is there when the step opens is nearly as loud as the reference itself was — within
    // 20 dB: an echo 0.7 s after the reference has fallen further than that; a singer who began
    // with it, their onset hidden under it, has not)
    if (f.mutePeakDb != null && f.t - t0 <= 0.2) this.openDb = Math.max(this.openDb, db);
    if (!this.newSound) {
      this.newSound = this.mutedAtk.some((a) => a.band !== 'hf' && a.riseDb >= 3) || stepOnsets.length > 0 || db >= quietest + 9 ||
        (f.mutePeakDb != null && this.openDb >= f.mutePeakDb - 20);
    }
    // (and when it begins over a sound that was already there, it is judged from its own start,
    // not together with what it landed on, whose smoothed pitch still lags — once per step)
    const mutedNew = this.mutedAtk.some((a) => a.band !== 'hf' && a.riseDb >= 3);
    if (!this.segOnset && !this.onsetCut && !mutedNew && this.seg.length && this.segFirstT !== null) {
      // (an old sound heard for a while first, and the first new thing since: a sound that began
      // with the step, or while the reference played, is judged whole)
      const first = stepOnsets.reduce<FrameAttack | null>((a, b) => (a === null || b.t < a.t ? b : a), null);
      const on = first !== null && first.t > (this.segFirstT as number) + 0.25 ? first : undefined;
      const cut = on ? on.t : this.levelRoseT !== null && this.levelRoseT > (this.segFirstT as number) + 0.25 ? this.levelRoseT : null;
      if (cut !== null) {
        this.onsetCut = true;
        this.seg = this.seg.filter((p) => p.t >= cut - 1e-6);
        this.sm1 = this.sm1.filter((p) => p.t >= cut - 1e-6);
        this.sm2 = this.sm2.filter((p) => p.t >= cut - 1e-6);
        this.segFirstT = this.seg.length ? this.seg[0].t : null;
        // (a clear new start — an attack, or the level up 15 dB on what was there — is a new
        // sound, judged as one; a smaller bump in a decaying room or string is still watched by
        // the guards below)
        if (on || db >= quietest + 15) this.segOnset = true;
        else this.cutAt = { t: cut, quiet: quietest };
        risen = true;
      }
    } else if (this.cutAt !== null && !this.segOnset && f.t - this.cutAt.t <= 0.3 && db >= this.cutAt.quiet + 15) {
      // (the level went on rising after the cut: a new sound after all)
      this.segOnset = true;
      this.cutAt = null;
    }
    if (!this.seg.length) {
      this.segFirstT = f.t;
      // Did this note start with an attack inside this step, or was it already sounding?
      const prior = this.hist.filter((r) => r.t < f.t - 1e-6 && r.t >= f.t - 0.4);
      if (!risen) this.segOnset = prior.length > 0 && db - Math.min(...prior.map((r) => r.db)) >= 6;
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
    let refusing = false;
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
      // ...and whatever the pitch: if the last attack before this note was a pluck (sharp) and no
      // voice has started since, the sound is a string ringing — the previous note, an older one,
      // or one plucked during this step — unless it shows a voice's wobble and holds its level.
      const segT = this.segFirstT ?? f.t;
      const before = this.atk.filter((a) => a.t <= segT + 0.05 && (a.band === 'full' ? a.riseDb >= 1.5 : a.band === 'hf' && a.riseDb >= 10));
      const hfNear = (a: FrameAttack) => this.atk.find((b) => b.band === 'hf' && Math.abs(b.t - a.t) < 0.03);
      const midNear = (a: FrameAttack) => this.near(a, 'mid');
      // (a pluck here: its click above 3 kHz, or a sharp rise that is not followed by a further
      // build-up — a voice's first glottal pulses can look sharp, but the voice keeps growing)
      const isPluck = (a: FrameAttack) => {
        if (a.band === 'hf') return attackKind(undefined, a) === 'pluck';
        const k = attackKind(a, hfNear(a), midNear(a), this.midRise);
        // (a fast rise without a click — a soft pluck or a hard "da", or a voice's onset through a
        // phone's fast compressor — counts only when the note is as steady in pitch as a string;
        // even a plain singer wobbles by 2-6 c)
        if (k === 'ambiguous' && a.riseMs <= 8 && a.riseDb >= 8 && pitchSd < 1.5) return !this.atk.some((b) => b.band === 'full' && b.t > a.t && b.t - a.t <= 0.1 && b.riseDb >= 6);
        if (k !== 'pluck') return false;
        const h = hfNear(a);
        if (h && h.riseMs <= 6 && h.riseDb >= 8) return true;
        return !this.atk.some((b) => b.band === 'full' && b.t > a.t && b.t - a.t <= 0.1 && b.riseDb >= 6);
      };
      const lastPluck = [...before].reverse().find(isPluck);
      // (a voice starting over the ringing string adds a slow rise of its own, however small)
      const voiceSince = lastPluck !== undefined && this.atk.some((a) => a.band === 'full' && a.t > lastPluck.t + 0.03 && a.riseDb >= 4 && a.riseMs >= 5 && a.riseMs <= 80 && attackKind(a, hfNear(a), midNear(a), this.midRise) !== 'pluck');
      // (how fast the level has fallen since the step opened, over up to the last 1.5 s: a string or
      // a room's tail keeps falling, a singer holding the note does not)
      const sinceOpen = this.hist.filter((r) => r.t >= (this.firstT ?? f.t) - 1e-6 && r.t > f.t - 1.5);
      const openSlope = sinceOpen.length >= 5 ? slope(sinceOpen.map((r) => r.t), sinceOpen.map((r) => r.db)) : 0;
      // (a way out, so nobody is held up for ever: a phone's hard compressor can flatten a voice's
      // onset to nothing, but a note held at a level that does not fall, with a singer's small
      // pitch wobble, for 2 s on end is not a string left ringing)
      const heldLikeVoice = f.t - segT >= 2.0 && dbSlope >= -1 && pitchSd >= 2;
      // (a pluck from before this step — the previous note's, remembered across the reference —
      // says only how the sound left over from then began; a voice that started while the app was
      // playing the reference left no attack the step could see, so here the sound itself must
      // still behave like a string: dying away, or dead steady in pitch)
      // ...or 20 dB or more below the level heard just before the reference: what is left of a
      // string, not a voice begun meanwhile (one starts 5-17 dB under the pluck it follows)
      const leftover = c.preDb !== undefined && db < c.preDb - 20;
      const carriedOk = !lastPluck?.carried || dbSlope < -1.5 || pitchSd < 3 || openSlope < -1.5 || leftover;
      const stringSound = lastPluck !== undefined && !voiceSince && f.t - lastPluck.t < 12 && !heldLikeVoice && carriedOk;
      // (and the same for the reference tone the app just played: in a very live room its tail
      // is still sounding, at the target's pitch, when the step opens)
      const pcRef = c.refMidi === undefined ? 99 : Math.abs(((((this.cfg.targetMidi + v2 / 100 - c.refMidi) % 12) + 18) % 12) - 6);
      // (the reference's tail is told by its dying away, which a room makes fast — 10 dB/s and
      // more, measured since the step opened; a singer fading out of a long note, or one who began
      // with the reference and is running out of breath, falls 3-8 dB/s. In the first half second
      // there is too little to measure: anything at the reference's pitch that is falling at all is
      // held until then.)
      // (and whatever its slope, a sound at the reference's pitch that was already there when the
      // step opened, with nothing new begun since the reference started, is not the student)
      // (that needs the reference to have been heard: the level it reached tells an echo from a
      // singer whose start it hid)
      const refTail = pcRef < 0.6 && ((f.t - (this.firstT ?? f.t) < 0.5 && dbSlope < -1.5) || openSlope < -10 || (!this.newSound && f.mutePeakDb != null));
      const carry = (fromStart && ((pcDiff < 0.6 && (dbSlope < -1.5 || pitchSd < 3)) || refTail)) || stringSound;
      let sustainedOk = true;
      if (c.strict) {
        const mid = f.t - c.holdMs / 2000;
        const h1 = win.filter((p) => p.t <= mid);
        const h2 = win.filter((p) => p.t > mid);
        const s1 = slope(h1.map((p) => p.t), h1.map((p) => p.db));
        const s2 = slope(h2.map((p) => p.t), h2.map((p) => p.db));
        sustainedOk = dbSlope >= c.minDbSlope && s1 >= 2 * c.minDbSlope && s2 >= 2 * c.minDbSlope;
      }
      if (carry) this.guardHeld = true;
      refusing = carry;
      // (what is held back is named only as far as it can be told: a string with its pluck heard
      // and no voice since, at another pitch than the note just played, is the guitar; on the
      // same pitch as the note just played it may be that string or the reference's echo — said
      // neutrally; otherwise it is the echo)
      if (!steady) hint = fromStart && !this.newSound ? null : 'moving';
      else if (carry) hint = pcDiff < 0.6 ? 'stillSounding' : stringSound ? 'carryOver' : 'refEcho';
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
    // (a sound being held back — or, before it can be judged, one that was already there with
    // nothing new begun, at the pitch just heard — shows no needle and fills no hold bar)
    if (!accepted && !refusing && !this.segOnset && !this.newSound && f.mutePeakDb != null) {
      const pcOf = (m: number | undefined) => (m === undefined ? 99 : Math.abs(((((this.cfg.targetMidi + v1 / 100 - m) % 12) + 18) % 12) - 6));
      refusing = pcOf(c.refMidi) < 0.6 || pcOf(c.carryMidi) < 0.6;
    }
    if (refusing && !accepted) {
      return { voiced: true, stable: false, detectedMidi: null, cents: null, inTolerance: false, progress: 0, accepted: false, acceptedAt: null, meanAbsCents: null, wrongAttempts: wrong, hint };
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

    this.mergeAttacks(f);

    // ---- the sung answer still sounding (guitar step right after the singing step): positive
    // evidence of the voice, as long as it has not stopped since the step opened
    if (this.sungOn && c.voiceMidi !== undefined) {
      if (this.startLevels.length < 3) this.startLevels.push(db);
      const startLevel = median(this.startLevels);
      if (db <= startLevel - 20 || db <= -60 || midi === null) this.quietFrames++;
      else this.quietFrames = 0;
      if (this.quietFrames >= 3) this.sungOn = false;
      if (!this.sungOn) this.sungEndT = t;
      // (or the voice stopped over a string still ringing: the level falls by 6 dB within 60 ms,
      // faster than any string dies)
      // (confirmed only if the level stays down for 0.15 s: in a room a sung vowel's vibrato
      // swings the level by 5 dB and more, and a dip that comes back is the voice going on)
      const recent = this.hist.filter((r) => r.t >= t - 0.16 - 1e-6 && r.t <= t - 0.06 + 1e-6);
      if (this.sungDrop === null && recent.length && db <= Math.max(...recent.map((r) => r.db)) - 6) this.sungDrop = { t, ref: Math.max(...recent.map((r) => r.db)) };
      else if (this.sungDrop !== null && db >= this.sungDrop.ref - 3) this.sungDrop = null;
      else if (this.sungDrop !== null && t - this.sungDrop.t >= 0.15 - 1e-6) {
        this.sungOn = false;
        this.sungEndT = this.sungDrop.t;
      }
      // (or, after an attack, the pitch has gone dead steady — no vibrato, no jitter, under 1.5 c
      // around its trend for 0.2 s: what sounds now is a string; the voice, however loud its tail
      // in the room, has stopped)
      const cd = this.cand;
      if (this.sungOn && cd && !cd.done && t - cd.onsetT >= 0.15) {
        const fr = this.hist.filter((r) => r.t >= t - 0.2 - 1e-6 && r.t >= cd.onsetT + 0.05 && r.midi !== null);
        if (fr.length >= 8) {
          const ts = fr.map((r) => r.t);
          const cs = fr.map((r) => (r.midi as number) * 100);
          const k = slope(ts, cs);
          const mt = mean(ts);
          const mc = mean(cs);
          const res = Math.sqrt(mean(fr.map((r, i) => (cs[i] - mc - k * (r.t - mt)) ** 2)));
          if (res < 1.5 && Math.max(...cs) - Math.min(...cs) < 25) {
            this.sungOn = false;
            this.sungEndT = cd.onsetT;
          }
        }
      }
    } else this.sungOn = false;

    // ---- new attack: a level jump, or a clean jump to a new steady pitch (hammer-on, legato)
    let onset = false;
    // Attacks only count when most of the frame's energy is signal, not room noise (after noise
    // removal the level of pure noise sits well below the raw level).
    const signalDominant = rmsToDb(f.rms) - db <= 6;
    // A swell far below what was just played (the null-to-peak of a beating string, a
    // resonance) is not an attack: the level must reach within 12 dB of the envelope of recent
    // attacks, allowing that envelope to die away at 10 dB/s.
    const env = Math.max(...hist.filter((r) => r.t >= t - 1.5 && r.t < t - 0.03).map((r) => r.db - 10 * (t - r.t)), -Infinity);
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
    // A pluck the frame level barely shows (a louder voice or note was sounding) is still seen by
    // the attack tracker — its click and sharp rise: open a candidate there (reported ~0.1 s late,
    // so the candidate starts in the past).
    let fromEvent: 'pluck' | 'ambiguous' | null = null;
    if (!onset && c.needPluck) {
      const kindOf = (a: FrameAttack) => {
        const full = a.band === 'full' ? a : this.near(a, 'full');
        return attackKind(full, a.band === 'hf' ? a : this.near(a, 'hf'), full && this.near(full, 'mid'), this.midRise);
      };
      // (only an attack no candidate has covered yet: later than the latest onset)
      const ev = this.atk.find((a) => a.t > this.coveredT && a.t < t - 0.02 && a.t >= (this.firstT ?? t) &&
        (kindOf(a) === 'pluck' || (kindOf(a) === 'ambiguous' && a.riseDb >= 6) || this.isBright(a)));
      if (ev) {
        onset = true;
        fromEvent = kindOf(ev) === 'pluck' ? 'pluck' : 'ambiguous';
        onsetT = ev.t + 0.005;
        lead = 0.02;
      }
    }
    if (onset) {
      const pre = hist.filter((r) => r.t >= onsetT - 0.3 && r.t <= onsetT - 0.04 + 1e-6);
      const preVoiced = pre.filter((r) => r.midi !== null && r.clarity >= 0.75).map((r) => r.midi as number);
      const preMax = pre.length ? Math.max(...pre.map((r) => r.db)) : -Infinity;
      this.cand = {
        onsetT, peakT: t, peakDb: db, lead, source: fromEvent ?? 'pending',
        preSounding: preMax >= c.minDb + 10 && preMax >= db - 25,
        underVoice: this.sungOn && c.voiceMidi !== undefined ? preMax : undefined,
        preLast: pre.length ? pre[pre.length - 1].db : -Infinity,
        preMax,
        preMidi: preVoiced.length >= 3 ? median(preVoiced) : null,
        pre: pre.slice(-6),
        identity: null, lastWindowMidi: null, done: false, counted: false, decay: 'pending',
      };
      this.lastOnsetT = t;
      this.coveredT = Math.max(this.coveredT, onsetT + 0.05);
    }

    const cand = this.cand;
    let hint: MatchHint | null = null;
    let accepted = false;
    let wrong = s.wrongAttempts;
    let accMidi: number | null = null;
    let reason: MatchState['reason'];

    if (cand && !cand.done) {
      if (t - cand.onsetT > c.maxIdentityMs / 1000) cand.done = true;
      // (attack events arrive ~0.1 s late: look for the bright onset while the candidate is young)
      // (it lifts the holds that the sung answer puts on a candidate; whether the sound is a
      // string is still decided as for any other — a consonant's hiss is bright too)
      if (!cand.bright && t - cand.onsetT <= 0.3 && this.atk.some((a) => this.isBright(a) && a.t >= cand.onsetT - 0.08 && a.t <= cand.onsetT + 0.05)) cand.bright = true;
      // A pluck reads as a steady note within a few hundred ms; a sound whose first steady reading
      // comes later (a note below the guitar's range, a muddled mixture dying away) is not
      // identified at all.
      if (cand.identity === null && t - cand.onsetT > 0.6) cand.done = true;
      if (t - cand.onsetT <= 0.1 && db > cand.peakDb) {
        cand.peakDb = db;
        cand.peakT = t;
      }
      if (c.strict) this.strictDecay(cand, t);
      this.classify(cand, t);
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
        // A pluck an octave above a note that was already sounding (singing the octave below while
        // plucking): the mixture reads as the lower note, but everything NEW sits on its even
        // harmonics only — the new note is the octave above.
        // (only to reach the target: the note sounding before is the target's lower octave)
        if (cand.octaveUp === undefined && cand.preMidi !== null && Math.abs(cand.preMidi + 12 - c.targetMidi) < 0.5 && t - cand.onsetT <= 0.4 && vw.some((r) => Math.abs((r.midi as number) - (cand.preMidi as number)) < 0.5)) {
          // (the frames that read the lower note, early after the attack while the new power is fresh)
          const odd = this.hist.filter((r) => r.t >= cand.onsetT - 1e-6 && r.t <= cand.onsetT + 0.25 && r.novOdd !== null && r.midi !== null && Math.abs(r.midi - (cand.preMidi as number)) < 0.5).map((r) => r.novOdd as number);
          // (unless what is new reads as the lower note itself: the same low string plucked again)
          const newN = this.hist.filter((r) => r.t >= cand.onsetT - 1e-6 && r.t <= cand.onsetT + 0.25 && r.nov !== null).map((r) => r.nov as number);
          const sameLow = newN.length >= 3 && newN.filter((n) => Math.abs(n - (cand.preMidi as number)) < 0.6).length >= newN.length / 2;
          if (odd.length >= 2 && median(odd) <= -8 && !sameLow) {
            cand.octaveUp = cand.preMidi;
            // (what it was read as so far was that lower note: it is this note's octave — not a jump)
            const lift = (m: number | null) => (m !== null && Math.abs(m - (cand.octaveUp as number)) < 0.5 ? m + 12 : m);
            cand.identity = lift(cand.identity);
            cand.lastWindowMidi = lift(cand.lastWindowMidi);
          }
        }
        // (while the lower note still reads, this candidate's note is its octave)
        if (pickC && cand.octaveUp !== undefined && Math.abs(median(pickC.members) - cand.octaveUp) < 0.5) pickC = { members: pickC.members.map((m) => m + 12), steady: pickC.steady };
        const steady = pickC !== null;
        const midis = pickC ? pickC.members : bl.members;
        if (pickC === nov && nov.steady && Math.abs(this.deviation(median(nov.members))) <= c.toleranceCents) cand.novTarget = true;
        // (the octave below, read clearly by the detector itself in most of the window)
        const lowOctave = () => {
          const low = vw.filter((r) => r.raw !== null && r.raw !== undefined && Math.abs((r.raw as number) + 12 - c.targetMidi) < 0.6);
          // (not the sung answer, an octave below the target, still sounding or ringing on)
          if (c.voiceMidi !== undefined && Math.abs(c.voiceMidi + 12 - c.targetMidi) < 0.6 && (this.sungOn || t - this.sungEndT < 2)) return false;
          // (nor the previous note, an octave below, still ringing from before this attack. A low
          // note plucked in this step and plucked again reads exactly like the octave above
          // plucked over it — even the "what's new" test cannot tell them apart — so the octave
          // above over a wrong low note of this step needs the low note to die away first.)
          if (c.ignoreMidi !== undefined && Math.abs(c.ignoreMidi + 12 - c.targetMidi) < 0.6 && cand.preMidi !== null && Math.abs(cand.preMidi - c.ignoreMidi) < 0.6) return false;
          return vw.length >= 3 && low.length >= 0.6 * vw.length && median(low.map((r) => r.clarity)) >= 0.965;
        };
        if (steady) {
          const wm = median(midis);
          // A pluck under a louder voice: what read so far was the voice (the pitch already
          // sounding before the attack); once the voice stops (the level falls by 10 dB or more),
          // the string itself reads — that is this candidate's note, not a jump.
          if (cand.source === 'pluck' && cand.preMidi !== null && cand.lastWindowMidi !== null && Math.abs(cand.lastWindowMidi - cand.preMidi) < 0.5 &&
            Math.abs(wm - cand.preMidi) >= 0.6 && db <= cand.peakDb - 10 && t - cand.onsetT <= 2) {
            cand.lastWindowMidi = null;
            cand.identity = null;
            cand.steadySince = undefined;
            cand.preMidi = null;
          }
          const jump = cand.lastWindowMidi === null ? 0 : Math.abs(wm - cand.lastWindowMidi);
          const flip = [7, 12, 19, 24].some((iv) => Math.abs(jump - iv) < 0.6);
          // ...and the other way round: the string read first, then the louder voice (still
          // sounding from before the attack) took over the reading — that window is the voice.
          const voiceOver = cand.source === 'pluck' && cand.preMidi !== null && cand.lastWindowMidi !== null && Math.abs(wm - cand.preMidi) < 0.5 && jump > 1.5;
          if (voiceOver) {
            cand.steadySince = undefined;
            if (this.voiceSounding(t) || (cand.preSounding && db >= cand.peakDb - 6)) hint = 'singing';
          } else if (jump > 1.5 && flip && t - cand.onsetT <= 0.22 && !cand.preSounding && db >= cand.peakDb - 15 && Math.abs(this.deviation(wm)) <= c.toleranceCents && cand.lastWindowMidi !== null && cand.lastWindowMidi > wm) {
            // (right after the attack a string whose fundamental is weak reads an octave or two
            // high, then settles on its own note while still loud: that note is the identity —
            // only very early, and not over another note ringing, where the reading of a real
            // higher note can drop an octave into the lower one's period)
            cand.steadySince = undefined;
            cand.identity = wm;
            cand.lastWindowMidi = wm;
          } else if (jump > 1.5 && flip && t - cand.onsetT <= 0.35 && cand.lastWindowMidi !== null && !(c.repeatOnsets && c.ignoreMidi !== undefined && Math.abs(cand.lastWindowMidi - c.ignoreMidi) < 0.6) && wm > cand.lastWindowMidi && Math.abs(this.deviation(cand.lastWindowMidi)) <= c.toleranceCents) {
            // (...and the other way: a note already read on the target that reads an octave or
            // two higher for a moment — its upper partials while it is fresh — is still that note;
            // this window does not count. Not over a note already ringing: there the flip can be
            // the old note's misread, and keeping the candidate lets the old note pass for a pluck)
            cand.steadySince = undefined;
          } else if (jump > 1.5 && (flip || jump > 5 || t - cand.onsetT > 0.5)) {
            // the reading jumped by an octave/fifth (a dying note's misread, hum) or far, late:
            // this attack is not trusted any more
            cand.done = true;
          } else {
            // (a jump of a few semitones early on is the finger landing late, a hammer-on, a
            // pull-off or a slide: the note is whatever it now settles on)
            // (re-identified then: the identity is what the string settles on after such a jump)
            if (jump > 0.6) {
              cand.steadySince = undefined;
              cand.identity = wm;
            }
            cand.lastWindowMidi = wm;
            cand.identity ??= wm;
            // The note identified at the attack must not have been below the target fret: the
            // fret below on a sharp string, whose decaying reading creeps up toward the target
            // later, never counts. (On the sharp side no such check: a hard pick starts sharp and
            // settles, and a fret above stays above — the reading now must be on target anyway.)
            const idDev = this.deviation(cand.identity);
            const idOk = idDev > -50;
            const dev = this.deviation(wm);
            // pitch moving away from the target within the window (a neighbouring fret settling
            // after a hard pick) is not yet a decision
            const half = Math.floor(midis.length / 2);
            const early = this.deviation(mean(midis.slice(0, half)));
            const late = this.deviation(mean(midis.slice(midis.length - half)));
            // (also any note on the flat side still falling: a hard pick on the fret below a sharp
            // string reads near the target at first and settles well below it — wait for it)
            const recent = hist.filter((r) => r.t >= Math.max(t - 0.2, cand.onsetT + cand.lead) - 1e-6 && r.midi !== null && Math.abs((r.midi as number) - wm) < 0.5);
            const fallRate = recent.length >= 4 ? slope(recent.map((r) => r.t), recent.map((r) => (r.midi as number) * 100)) : 0;
            const leaving = half >= 1 && ((Math.abs(late) > Math.abs(early) + 4 && Math.abs(late) > c.toleranceCents - 10) || (late < 0 && late < early - 2 && t - cand.onsetT < 0.8)) ||
              (dev < -15 && fallRate < -15 && t - cand.onsetT < 1.0);
            // A hard pick stretches the string: for the first few tenths of a second the note is
            // up to ~15 c sharp of where it settles, and falling. A note that is just outside the
            // tolerance on the sharp side but clearly settling down into it counts.
            // (and later, a note that came down from a sharper attack and is still at most 5 c
            // over: the stretch of a hard pick takes a second or more to relax completely)
            const settling = (half >= 1 && t - cand.onsetT <= 0.35 && dev > c.toleranceCents && dev <= c.toleranceCents + 15 && late < early - 2) ||
              (cand.identity !== null && dev > c.toleranceCents && dev <= c.toleranceCents + 5 && this.deviation(cand.identity) >= dev + 5);
            if (c.needPluck && cand.source === 'voice') {
              // whatever its pitch: it started like a voice (said whether or not it is the right note)
              hint = 'voiceLike';
              cand.steadySince = undefined;
            } else if (this.sungOn && c.voiceMidi !== undefined && Math.abs(wm - c.voiceMidi) < 0.6 && !(cand.bright && cand.novTarget)) {
              // the sung answer has not stopped since the step opened and this is its pitch: the
              // voice is what reads (a pluck under it is taken once the voice stops)
              hint = 'singing';
              cand.steadySince = undefined;
            } else if (!cand.bright && cand.underVoice !== undefined && c.voiceMidi !== undefined && Math.abs(((((wm - c.voiceMidi) % 12) + 18) % 12) - 6) < 0.6 && cand.peakDb < cand.underVoice + 3) {
              // (a pluck under the voice, or as it dies away, shows itself by its bright onset — see
              // isBright — and is not held here; a level that merely swings back up is the voice)
              // Opened while the sung answer was still sounding, at its pitch (or an octave of
              // it), and never louder than the voice itself was just before: that "onset" was the
              // voice swelling (vibrato in a room swings it by several dB), and what is left once
              // it stops is its reverberant tail — not a pluck. A pluck under the voice that does
              // not stand out has to be plucked again after the voice has stopped.
              cand.steadySince = undefined;
              if (!this.sungOn) cand.done = true;
            } else if (!cand.bright && c.voiceMidi !== undefined && cand.onsetT >= this.sungEndT && cand.onsetT - this.sungEndT < 1.0 &&
              Math.abs(((((wm - c.voiceMidi) % 12) + 18) % 12) - 6) < 0.6 && cand.peakDb <= (cand.preMax ?? -Infinity) && cand.peakDb - (cand.preLast ?? -Infinity) < 8) {
              // Just after the sung answer stopped, at its pitch, never louder than what was
              // sounding just before, without a jump out of the moment before it and with nothing
              // new and bright in it: the voice's tail swelling again in the room (two room modes
              // beating), not a pluck.
              cand.steadySince = undefined;
              cand.done = true;
            } else if (!cand.bright && cand.onsetT < this.sungEndT && (t < this.sungEndT + 0.06 || db < cand.peakDb - 14)) {
              // opened while the student was still singing: only what is left once the voice has
              // stopped can be the string — and a pluck leaves a string sounding, not a fading
              // echo of the voice
              cand.steadySince = undefined;
            } else if (lowOctave()) {
              // the note sounding is the octave below: the detector's own reading, clear and
              // steady, is there; only the "octave up" correction or what is new in the attack
              // read the target
              cand.steadySince = undefined;
              hint = 'octaveLow';
            } else if ((Math.abs(dev) <= c.toleranceCents || settling) && !leaving && idOk) {
              // the note must have sounded on the target for a moment, and still be on it now: a
              // hammer-on or slide that leaves the target right after the attack does not count
              cand.steadySince ??= t;
              const dwell = t - cand.steadySince >= c.persistMs / 1000 - 1e-6 && this.dwelled(cand, t);
              if (!dwell) {
                // keep waiting
              } else if (c.needPluck && cand.source !== 'pluck') {
                // (still deciding what made the attack: remember that the note was right, in case
                // it is decided only after another string or the room has taken over the reading)
                if (cand.source !== 'voice') cand.ready ??= wm;
              } else if ((db < cand.peakDb - 30 && t - cand.onsetT > 0.4) || this.attackless(cand)) {
                // (never on the last breath of a sound: 30 dB under its peak, late in its decay,
                // the reading is the room's noise as much as the note and can read an octave off —
                // a palm-muted or staccato pluck gets there fast, and still counts)
              } else if (!c.strict || cand.decay === 'confirmed') {
                accepted = !c.neverAccept;
                accMidi = wm;
                reason = 'window';
              } else if (cand.decay === 'rejected') {
                hint = 'sustained';
              }
            } else {
              const d = wm - this.cfg.targetMidi;
              // the pluck is read at the pitch the student is still singing: the voice is louder
              if (cand.source === 'pluck' && c.voiceMidi !== undefined && Math.abs(wm - c.voiceMidi) < 0.6 && this.voiceSounding(t)) hint = 'singing';
              else if (Math.abs(d - 12) < 0.5) hint = 'octaveHigh';
              else if (Math.abs(d + 12) < 0.5) hint = 'octaveLow';
              else if (Math.abs(dev) < 75 && Math.abs(dev) > c.toleranceCents) hint = 'outOfTune';
              if (Math.abs(dev) > c.toleranceCents) cand.steadySince = undefined;
              if (!cand.counted && t - cand.onsetT >= 0.25 && Math.abs(dev) >= 75) {
                if (Math.round(wm) !== c.ignoreMidi) wrong++;
                cand.counted = true;
              }
            }
          }
        } else if (cand.steadySince !== undefined && !c.strict && (!c.needPluck || cand.source === 'pluck') && cand.identity !== null && this.deviation(cand.identity) > -50 && t - cand.steadySince >= c.persistMs / 1000 - 1e-6 && this.dwelled(cand, t) &&
          [nov, bl].some((k) => k.members.length >= 3 && Math.abs(this.deviation(median(k.members))) <= c.toleranceCents) && !this.attackless(cand)) {
          // The note read steady on the target in the previous window and still reads it in at least
          // three frames now (a fast-dying note slipping into noise): that is enough.
          accepted = !c.neverAccept;
          accMidi = cand.lastWindowMidi;
          reason = 'window';
        } else {
          // ("stop on the note" only for a note that is near the target and gliding — not for a
          // thump, a squeak or a spoken word, which never settle anywhere)
          const near = this.hist.slice(-3).filter((r) => r.midi !== null && Math.abs((r.midi as number) - c.targetMidi) <= 1.5).length;
          // (and not for a note stopped short — damped or palm-muted to nothing within a few
          // tenths of a second: it did not slide, it was too short to read)
          if (db < cand.peakDb - 20 && t - cand.onsetT < 0.6) hint = 'tooShort';
          else if ((cand.identity !== null || near >= 3) && t - cand.onsetT >= 0.3) hint = 'moving';
          cand.steadySince = undefined;
        }
      }
    }

    // The note was identified on the target while its source was still being decided; it has
    // now been decided a pluck: that is the accept, whatever reads by now.
    if (!accepted && cand && cand.ready !== undefined && cand.source === 'pluck' && c.needPluck && !c.strict && !c.neverAccept && t - cand.onsetT <= 1.5) {
      accepted = true;
      accMidi = cand.ready;
      reason = 'window';
      hint = null;
    }
    const disp = this.displayMidi();
    const centsNow = disp !== null ? this.deviation(disp) : null;
    const inTolNow = centsNow !== null && Math.abs(centsNow) <= c.toleranceCents;
    // The right pitch is sounding but no new pluck opened a candidate: the student's voice (its
    // attack was the last one heard), or a note still ringing.
    // (the voice case is said whatever its pitch, so it reveals nothing when the meter is off)
    if (!accepted && !hint && midi !== null && (!cand || cand.done || t - cand.onsetT > 0.4)) {
      if (this.voiceSounding(t)) hint = 'singing';
      // (only said when the last attack heard was a string's: after an attack that could have been
      // a voice, the sound may well be the student still singing)
      else if (inTolNow && this.lastAttackWasPluck(t)) hint = 'ringing';
      // (phrase review, the same note twice: the second pluck, a good deal softer than the first,
      // can sink into the first's ring unnoticed — at least say what to do)
      else if (inTolNow && c.repeatOnsets && c.ignoreMidi !== undefined && Math.abs(c.ignoreMidi - c.targetMidi) < 0.6 && t - (this.firstT ?? t) > 0.8) hint = 'repeatSoft';
    }
    // The meter shows only what was attacked in this step and has been identified: not the
    // previous note still ringing, and not the first, still-settling readings of an attack.
    const shown = accepted || (cand !== null && !cand.done && cand.identity !== null && t - cand.onsetT < 2);
    const cents = accepted && accMidi !== null ? this.deviation(accMidi) : shown ? centsNow : null;
    const inTol = cents !== null && Math.abs(cents) <= c.toleranceCents;
    return {
      voiced: midi !== null,
      stable: shown && disp !== null,
      detectedMidi: accepted && accMidi !== null ? accMidi : shown ? disp : null,
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

  /**
   * Guitar step: the note has sounded for a moment AND the last two readings are still on the
   * target — a hammer-on or slide that leaves the target right after the attack does not count.
   * (Phrase review: no wait, notes can be 180 ms apart.)
   */
  private dwelled(cand: Candidate, t: number): boolean {
    if (!this.cfg.needPluck) return true;
    if (t - cand.onsetT < MIN_DWELL_S - 1e-6) return false;
    const last = this.hist.slice(-2);
    const up = (m: number) => (cand.octaveUp !== undefined && Math.abs(m - cand.octaveUp) < 0.5 ? m + 12 : m);
    return last.length === 2 && last.every((r) => r.midi !== null && Math.abs(this.deviation(up(r.midi))) <= this.cfg.toleranceCents);
  }

  /** Was the last real attack heard a string's (clearly, or resolved so by its decay)? */
  private lastAttackWasPluck(t: number): boolean {
    if (!this.cfg.strict) return this.lastSource?.kind === 'pluck' && t - this.lastSource.t < 10;
    const hfNear = (a: FrameAttack) => this.atk.find((b) => b.band === 'hf' && Math.abs(b.t - a.t) < 0.03);
    const last = [...this.atk].reverse().find((a) => a.band === 'full' && a.riseDb >= 6 && a.t <= t);
    if (!last) return false;
    const k = attackKind(last, hfNear(last), this.near(last, 'mid'), this.midRise);
    return k === 'pluck' || (k === 'ambiguous' && this.lastSource?.kind === 'pluck' && Math.abs(this.lastSource.t - last.t) < 0.25);
  }

  /** Is the last attack heard (still sounding) a voice's? */
  private voiceSounding(t: number): boolean {
    if (!this.cfg.strict) {
      // (only on positive evidence: the last attack swelled like a voice and is still going)
      const ls = this.lastSource;
      if (!ls || ls.kind !== 'voice') return false;
      const since = this.hist.filter((r) => r.t >= ls.t);
      if (!since.length) return false;
      return this.hist[this.hist.length - 1].db >= Math.max(...since.map((r) => r.db)) - 12;
    }
    const hfNear = (a: FrameAttack) => this.atk.find((b) => b.band === 'hf' && Math.abs(b.t - a.t) < 0.03);
    const last = [...this.atk].reverse().find((a) => a.band === 'full' && a.riseDb >= 6 && a.t <= t);
    if (!last || attackKind(last, hfNear(last), this.near(last, 'mid'), this.midRise) !== 'voice') return false;
    // (and the level has not dropped away since: it is still going)
    const since = this.hist.filter((r) => r.t >= last.t);
    if (!since.length) return false;
    const peak = Math.max(...since.map((r) => r.db));
    return this.hist[this.hist.length - 1].db >= peak - 12;
  }

  /** judge a rise by the middle band too (see attackKind) */
  private get midRise(): boolean {
    return this.cfg.targetMidi >= 55;
  }

  /** The event of another band for the same attack (within 30 ms), if any. */
  /**
   * Positive evidence of a new plucked sound over one already sounding (the sung answer going on
   * or dying away in the room): above 3 kHz the level jumped by 15 dB or more within 25 ms (or
   * 12 dB within 12 ms) — well more than the whole band rose. A voice that goes on, swells or fades changes its whole
   * spectrum together; a pick or a nail adds a bright, sudden sound on top.
   */
  private isBright(a: FrameAttack): boolean {
    if (a.band !== 'hf' || a.riseDb < 12 || a.riseMs > (a.riseDb >= 15 ? 25 : 12)) return false;
    const full = this.atk.filter((b) => b.band === 'full' && Math.abs(b.t - a.t) < 0.06).map((b) => b.riseDb);
    return (full.length ? Math.max(...full) : 0) <= a.riseDb - 6;
  }

  /**
   * Phrase review, a repeated note: a "re-pluck" of the note already ringing that neither raised the level by 4 dB
   * nor showed any attack (no band rose 8 dB around it) is the old note swelling — two
   * polarisations beating — not a new pluck.
   */
  private attackless(cand: Candidate): boolean {
    if (!this.cfg.repeatOnsets || !cand.preSounding) return false;
    // (only a repeated note: the note ringing before is this one)
    const rep = (m: number | null | undefined) => m !== null && m !== undefined && Math.abs(m - this.cfg.targetMidi) <= 0.6;
    if (!rep(cand.preMidi) && !rep(this.cfg.ignoreMidi)) return false;
    if (cand.peakDb - (cand.preLast ?? -Infinity) >= 4) return false;
    return !this.atk.some((a) => a.riseDb >= 8 && a.t >= cand.onsetT - 0.15 && a.t <= cand.onsetT + 0.05);
  }

  private near(a: FrameAttack, band: FrameAttack['band']): FrameAttack | undefined {
    // (the full band's start can be marked a little early by a slow body resonance or the room)
    return this.atk.find((b) => b.band === band && Math.abs(b.t - a.t) < (band === 'mid' ? 0.05 : 0.03));
  }

  /** Merge the stream analyser's attack events into the matcher's own list. */
  private mergeAttacks(f: PitchFrame): void {
    const c = this.cfg;
    // Attacks from before this step are remembered across the reference (see AttackTracker.clear)
    // only for one question: in the singing step of a repeated note, was the sound still ringing
    // from the previous step started by a pluck? Everywhere else this step starts afresh.
    const keepOld = c.kind === 'sung' && c.carryMidi !== undefined && Math.abs(((((c.targetMidi - c.carryMidi) % 12) + 18) % 12) - 6) < 0.6;
    for (const a of f.attacks ?? []) {
      // (heard while the reference played: only whether something new began then — see pushSung)
      if (a.muted) {
        if (!a.carried && !this.mutedAtk.some((b) => b.band === a.band && Math.abs(b.t - a.t) < 0.004)) this.mutedAtk.push(a);
        continue;
      }
      if (!keepOld && a.carried) continue;
      if (!this.atk.some((b) => b.band === a.band && Math.abs(b.t - a.t) < 0.004)) this.atk.push(a);
    }
    while (this.atk.length && this.atk[0].t < f.t - 10) this.atk.shift();
  }

  /**
   * What made this attack: a plucked string (it was at full strength within ~20 ms), a voice
   * (built up over 50 ms or more), or — between the two — decided by whether the upper
   * partials die away faster than the fundamental (a string's do; a sung vowel keeps its colour).
   * An onset without an attack of its own (a hammer-on, legato, a new note read from the
   * "what's new" spectrum) belongs to whatever started the sound it grew out of.
   */
  private classify(cand: Candidate, t: number): void {
    // (guitar step only: the phrase review takes every on-target attack, as fast playing over
    // ringing strings leaves no clean envelope to judge)
    if (!this.cfg.needPluck) return;
    if (!this.cfg.strict) {
      this.classifyByEvidence(cand, t);
      return;
    }
    // (decided once every attack event around the onset has been measured: they are reported
    // 120 ms after they start)
    if (cand.source === 'pending' && t >= cand.onsetT + 0.15) {
      // (a slow ramp is detected as a level onset up to ~100 ms after it began, and can trigger
      // a second onset on its way up: the biggest rise around the onset is what started it)
      const near = this.atk.filter((a) => a.t >= cand.onsetT - 0.2 && a.t <= cand.onsetT + 0.04);
      const full = near.filter((a) => a.band === 'full' && a.riseDb >= 1.5).sort((a, b) => b.riseDb - a.riseDb)[0];
      const hf = near.filter((a) => a.band === 'hf').sort((a, b) => b.riseDb - a.riseDb)[0];
      // (the middle band's rise nearest the full band's, or — where a low hum hides the start of
      // the full band's rise — the biggest one around the onset)
      const mid = (full && this.near(full, 'mid')) ?? near.filter((a) => a.band === 'mid').sort((a, b) => b.riseDb - a.riseDb)[0];
      const kind = attackKind(full, hf, mid, this.midRise);
      if (kind) cand.source = kind;
      else {
        const last = this.lastSource;
        cand.source = last && cand.onsetT - last.t < 3 ? last.kind : 'voice';
        cand.inherited = true;
      }
      if (cand.source === 'pluck' || cand.source === 'voice') this.lastSource = { kind: cand.source, t: cand.onsetT };
    }
    if (cand.source === 'ambiguous' && t >= cand.onsetT + 0.33) {
      const tilt = (a: number, b: number) => {
        const xs = this.hist.filter((r) => r.t >= cand.onsetT + a - 1e-6 && r.t <= cand.onsetT + b + 1e-6 && r.tilt !== null).map((r) => r.tilt as number);
        return xs.length ? mean(xs) : NaN;
      };
      const drop = tilt(0.04, 0.09) - tilt(0.28, 0.33);
      // (only while the sound still rings: a short sung note that is ending loses its upper
      // harmonics into the room noise and would look like a string)
      const lvl = (a: number, b: number) => {
        const xs = this.hist.filter((r) => r.t >= cand.onsetT + a - 1e-6 && r.t <= cand.onsetT + b + 1e-6).map((r) => r.db);
        return xs.length ? mean(xs) : -Infinity;
      };
      const ringing = lvl(0.28, 0.33) >= lvl(0.04, 0.09) - 9;
      // (and only if there ARE upper partials to judge: in a dark vowel they sit in the noise)
      const bright = tilt(0.04, 0.09) >= -30;
      // ...or the pitch of a string: dead steady (no vocal jitter or vibrato: < 1 c around its
      // trend) while the level dies away freely (≥ 3 dB/s)
      const fr = this.hist.filter((r) => r.t >= cand.onsetT + 0.06 && r.t <= cand.onsetT + 0.33 && r.midi !== null);
      let steadyString = false;
      let wobble = false;
      if (fr.length >= 8) {
        const ts = fr.map((r) => r.t);
        const cs = fr.map((r) => (r.midi as number) * 100);
        const k = slope(ts, cs);
        const mt = mean(ts);
        const mc = mean(cs);
        const res = Math.sqrt(mean(fr.map((r, i) => (cs[i] - mc - k * (r.t - mt)) ** 2)));
        const dbSlope = slope(ts, fr.map((r) => r.db));
        // (nylon and flesh plucks die fast — 12 dB/s and more — far faster than a voice fades)
        steadyString = (res < 1.0 && dbSlope <= -3) || (res < 3 && dbSlope <= -12);
        wobble = res >= 4;
      }
      // (below ~B2 a sung vowel's own upper harmonics wander through its formants with every
      // vibrato swing — a few dB either way — so only a clearly bigger drop counts there)
      const need = this.cfg.targetMidi < 47 && wobble ? 2.5 * TILT_DROP_DB : TILT_DROP_DB;
      cand.source = (drop >= need && ringing && bright) || steadyString ? 'pluck' : 'voice';
      this.lastSource = { kind: cand.source, t: cand.onsetT };
    }
  }

  /**
   * Default guitar step: a new attack on the target counts unless there is positive evidence
   * that it is a voice. The shape of the attack is no such evidence: in a room the reverberation
   * and the guitar body keep adding level for 30-70 ms after the pick, so a pluck at 1 m rises as
   * slowly as a hum. What a string cannot do is HOLD its level: from the peak of its attack it
   * dies away exponentially — reverberation included, the room only adds a tail — so it loses
   * about the same number of dB in each step of time. A sound that held its level, or lost only
   * an onset accent and then held (an accented hum, "la", "da"), and still holds 0.6 s after
   * its peak, is held like a voice: that is the evidence. Long-sustain strings, and strings
   * whose two polarisations beat, pass the second look at 0.6 s; most strings are decided
   * within 0.15-0.4 s.
   */
  private classifyByEvidence(cand: Candidate, t: number): void {
    if (cand.source === 'voice' || cand.source === 'pluck') return;
    cand.source = 'ambiguous';
    const meanDb = (a: number, b: number) => {
      const xs = this.hist.filter((r) => r.t >= cand.peakT + a - 1e-6 && r.t <= cand.peakT + b + 1e-6).map((r) => r.db);
      if (xs.length) return mean(xs);
      const next = this.hist.find((r) => r.t > cand.peakT + b && r.t <= cand.peakT + b + 0.3);
      return next ? next.db : NaN;
    };
    const voicedIn = (a: number, b: number) => this.hist.filter((r) => r.t >= cand.peakT + a - 1e-6 && r.t <= cand.peakT + b + 1e-6 && r.midi !== null).length;
    // (a string's level only goes down after its peak; a held tone in a room swings by a few dB
    // as its pitch wanders across the room's resonances — so a dip that recovers, by more than
    // `tol` dB above the lowest level reached so far, is no sign of a string)
    const recovers = (a: number, b: number, tol: number) => {
      const xs = this.hist.filter((r) => r.t >= cand.peakT + a - 1e-6 && r.t <= cand.peakT + b + 1e-6).map((r) => r.db);
      let lo = Infinity;
      for (let i = 1; i < xs.length; i++) {
        const v = (xs[i] + xs[i - 1]) / 2;
        if (v >= lo + tol) return true;
        lo = Math.min(lo, v);
      }
      return false;
    };
    // (a sound that stops — its level falls 4 dB or more from one 20 ms frame to the next — is a
    // voice ending, not a string dying: even a nylon string dies by under 3 dB per frame)
    // (...unless it started with a pick's click — sharp and strong both above 500 Hz and above
    // 3 kHz, which no voice does: then an abrupt end is a string stopped by the hand, staccato)
    const click = t >= cand.onsetT + 0.13 && this.atk.some((h) => h.band === 'hf' && h.t >= cand.onsetT - 0.2 && h.t <= cand.onsetT + 0.04 && h.riseMs <= 6 && h.riseDb >= 15 &&
      this.atk.some((m) => m.band === 'mid' && Math.abs(m.t - h.t) < 0.03 && m.riseMs <= 6 && m.riseDb >= 15));
    const ends = (a: number, b: number) => {
      if (click) return false;
      const xs = this.hist.filter((r) => r.t >= cand.peakT + a - 1e-6 && r.t <= cand.peakT + b + 1e-6).map((r) => r.db);
      for (let i = 1; i < xs.length; i++) if (xs[i - 1] - xs[i] >= 4) return true;
      return false;
    };
    const decide = (k: 'pluck' | 'voice') => {
      cand.source = k;
      this.lastSource = { kind: k, t: cand.onsetT };
    };
    // (0) A pick's click (above 3 kHz the level jumps 20 dB within 6 ms, together with a big
    // rise of the whole band and of the middle band) and, from the peak on, a level that only
    // falls: a string, decided as soon as the click has been measured. (A sung onset builds up
    // over several glottal cycles; a spoken consonant's hiss rises more slowly or comes without
    // the rise of the whole sound; a voice that follows its consonant holds or regains its level.)
    if (t >= cand.peakT + 0.08 - 1e-6 && t < cand.peakT + 0.4 - 1e-6) {
      const sharp = this.atk.some((h) => h.band === 'hf' && h.t >= cand.onsetT - 0.2 && h.t <= cand.onsetT + 0.04 && h.riseMs <= 10 && h.riseDb >= 20 &&
        this.atk.some((b) => b.band === 'full' && Math.abs(b.t - h.t) < 0.03 && b.riseDb >= 10) &&
        this.atk.some((b) => b.band === 'mid' && Math.abs(b.t - h.t) < 0.03 && b.riseDb >= 10));
      const a1 = mean(this.hist.filter((r) => r.t >= t - 0.04 - 1e-6).map((r) => r.db));
      // (not on the lowest strings, whose reading can still be an octave off this early; and only
      // once the note read has held since it was first identified)
      // (nor when the reading needed the "octave up" correction: decided by the decay instead)
      const settled = this.cfg.targetMidi >= 45 && cand.identity !== null && cand.lastWindowMidi !== null && Math.abs(cand.lastWindowMidi - cand.identity) < 0.3 &&
        !this.hist.some((r) => r.t >= cand.onsetT && r.midi !== null && r.raw !== r.midi);
      if (sharp && settled && cand.peakDb - a1 >= 1.5 && this.hist[this.hist.length - 1].midi !== null && !ends(0.04, t - cand.peakT)) return decide('pluck');
    }
    // (1) A loss of 3.5 dB or more within 0.15-0.4 s of the peak, steadily: a string (a voice's accent relaxes
    // by less), decided at once.
    if (t >= cand.peakT + 0.14 - 1e-6 && t < cand.peakT + 0.4 - 1e-6) {
      const a0 = meanDb(0.02, 0.08);
      const a1 = mean(this.hist.filter((r) => r.t >= t - 0.04 - 1e-6).map((r) => r.db));
      if (a0 - a1 >= 3.5 && this.hist[this.hist.length - 1].midi !== null && !recovers(0.02, t - cand.peakT, 1.5) && !ends(0.1, t - cand.peakT)) return decide('pluck');
    }
    if (t < cand.peakT + 0.4 - 1e-6) return;
    // (2) At 0.4 s: a string loses about the same number of dB in each 0.14 s step (it dies
    // away exponentially, a straight line in dB); an accented hum, "la" or "da" loses most of its
    // accent in the first step and then holds.
    const w1 = meanDb(0.02, 0.12);
    const w2 = meanDb(0.16, 0.26);
    const w3 = meanDb(0.3, 0.4);
    if ([w1, w2, w3].some(Number.isNaN)) return;
    const d1 = w1 - w2;
    const d2 = w2 - w3;
    if (!cand.held) {
      if (d1 >= 0.8 && d2 >= 0.8 && d2 >= 0.6 * d1 && voicedIn(0.3, 0.4) >= 1 && !recovers(0.02, 0.4, 2) && !ends(0.1, 0.4)) return decide('pluck');
      cand.held = true;
    }
    if (t < cand.peakT + 0.62 - 1e-6) return;
    // (3) Second look at 0.6 s: a string whose two polarisations beat, or whose body resonance
    // swelled, may only now be dying steadily; a voice that held its level (after any accent)
    // still holds it. Only that is taken for a voice.
    const w4 = meanDb(0.52, 0.62);
    if (Number.isNaN(w4)) return;
    const d3 = w3 - w4;
    if (d3 >= 0.6 && w2 - w4 >= 1.5 && voicedIn(0.52, 0.62) >= 1 && !ends(0.1, 0.62)) return decide('pluck');
    // A held level is no evidence after all when a compressor or a phone's gain control holds it:
    // the sound is still a string if its upper partials die away against the fundamental (a
    // voice keeps its colour; compression changes the level, not the balance of the partials).
    // (Not the attack shape: a hard "da" or "ta" starts as sharply as a pick.)
    const tilt = (a: number, b: number) => {
      const xs = this.hist.filter((r) => r.t >= cand.peakT + a - 1e-6 && r.t <= cand.peakT + b + 1e-6 && r.tilt !== null).map((r) => r.tilt as number);
      return xs.length >= 2 ? mean(xs) : NaN;
    };
    // (by a clear margin and step by step: a held hum's colour wanders by ±2 dB in a room)
    const ta = tilt(0.02, 0.12);
    const tb = tilt(0.26, 0.36);
    const tc = tilt(0.5, 0.62);
    const tiltDrop = ta > tb && tb > tc ? ta - tc : 0;
    decide(tiltDrop >= 3.5 ? 'pluck' : 'voice');
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
    // (read an octave low — two periods taken for one — when the waveform clearly repeats at half
    // the period read too: a quiet string in a noisy room)
    const m = freqToMidi(f.freq) + ((f.upClarity ?? 0) >= 0.7 ? 12 : 0);
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
