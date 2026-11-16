// Shared pitch-engine configuration used by both the browser app and the offline gauntlet,
// so what is measured offline is what runs on the phone. No DOM.
import { NoteMatcher, PLUCKED_DEFAULTS, SUNG_DEFAULTS, type FrameAttack, type MatchConfig, type PitchFrame } from './matcher.ts';
import { PitchDetector } from './pitch.ts';
import { Biquad } from './engine-filters.ts';
import { AttackTracker } from './attack.ts';

export { Biquad };

/** Analysis window. 2048 samples ≈ 43 ms at 48 kHz: ~3.5 periods of guitar low E (82.4 Hz). */
export const FRAME_SIZE = 2048;
/** Analysis hop (the app polls the analysers at this interval). */
export const HOP_MS = 20;
/**
 * Guitar exact-octave tolerance. Beginners' fretted notes are often 10–30 c sharp (pressing hard,
 * high action) and a hard pick reads a few cents sharp at the attack; a neighbouring fret is
 * 100 c away, and the identity read at the attack must also be on the target fret.
 */
export const GUITAR_TOLERANCE_CENTS = 45;
/**
 * The guitar path is high-passed (4th-order Butterworth) at this frequency before detection, and
 * searches no lower than GUITAR_MIN_HZ: mains hum (50/60 Hz) is attenuated and cannot be
 * reported as a pitch. The voice path is low-passed instead and goes down to 60 Hz (a bass singing C2).
 */
export const GUITAR_HPF_HZ = 70;
/** The voice path is low-passed here (4th order): breath noise is mostly above it, voice fundamentals below. */
export const VOICE_LPF_HZ = 1800;
export const GUITAR_MIN_HZ = 72;
export const VOICE_MIN_HZ = 60;
/** Butterworth 4th order = two biquads with these Qs. */
export const BUTTERWORTH4_Q = [0.5411961, 1.3065630];

export type AnalysisPath = 'voice' | 'guitar';

export function singConfig(targetMidi: number, toleranceCents: number, exactOctave: boolean, strict = false): MatchConfig {
  return { ...SUNG_DEFAULTS, targetMidi, toleranceCents, mode: exactOctave ? 'exact' : 'pitchClass', strict };
}

export function guitarConfig(targetMidi: number, strict = false, fast = false): MatchConfig {
  // Phrase review uses a shorter steady window so sixteenth notes at the written tempo (≈180 ms) fit.
  return { ...PLUCKED_DEFAULTS, targetMidi, toleranceCents: GUITAR_TOLERANCE_CENTS, mode: 'exact', strict, needPluck: !fast, ...(fast ? { pitchWindowMs: 90, repeatOnsets: true } : {}) };
}

export function makeDetector(sampleRate: number, path: AnalysisPath = 'voice'): PitchDetector {
  return new PitchDetector(FRAME_SIZE, sampleRate, {
    minFreq: path === 'guitar' ? GUITAR_MIN_HZ : VOICE_MIN_HZ,
    // guitar tops out at E5 (659 Hz); a high voice singing two octaves up can reach G6 (1568 Hz)
    maxFreq: path === 'guitar' ? 1200 : 1700,
    cutoff: 0.9,
    // Guitar path: stationary room noise (fan, hiss) is learned from frames that hold nothing
    // else and removed from every frame. Not on the voice path (its notes are what it listens to
    // for seconds at a time).
    denoise: path === 'guitar',
    hopSec: HOP_MS / 1000,
  });
}

/** Streaming front end: keeps the latest FRAME_SIZE samples of the raw and the high-passed signal. */
export class StreamAnalyzer {
  readonly sampleRate: number;
  private lp = new Float32Array(FRAME_SIZE);
  private hp = new Float32Array(FRAME_SIZE);
  private filters: Biquad[];
  private lpFilters: Biquad[];
  private det: Record<AnalysisPath, PitchDetector>;
  /** attack shapes of the guitar-path signal, from every sample pushed */
  readonly attacks: AttackTracker;

  constructor(sampleRate: number) {
    this.attacks = new AttackTracker(sampleRate);
    this.sampleRate = sampleRate;
    this.filters = BUTTERWORTH4_Q.map((q) => new Biquad(sampleRate, GUITAR_HPF_HZ, q, 'highpass'));
    this.lpFilters = BUTTERWORTH4_Q.map((q) => new Biquad(sampleRate, VOICE_LPF_HZ, q, 'lowpass'));
    this.det = { voice: makeDetector(sampleRate, 'voice'), guitar: makeDetector(sampleRate, 'guitar') };
  }

  push(chunk: Float32Array): void {
    let f = chunk;
    for (const b of this.filters) f = b.process(f);
    let g = chunk;
    for (const b of this.lpFilters) g = b.process(g);
    shiftIn(this.lp, g);
    shiftIn(this.hp, f);
    this.attacks.push(f);
  }

  frame(path: AnalysisPath, t: number): PitchFrame {
    this.attacks.mark();
    const r = this.det[path].detect(path === 'guitar' ? this.hp : this.lp, t);
    return { t, freq: r.freq, clarity: r.clarity, rms: r.rms, upClarity: r.upClarity ?? 0, cleanRms: r.cleanRms, nsdf: r.nsdf, sr: this.sampleRate, novFreq: r.novFreq, novClarity: r.novClarity, novShare: r.novShare, hfDb: r.hfDb, tiltDb: r.tiltDb, novOddDb: r.novOddDb, attacks: this.recentAttacks(t) };
  }

  /** attack events of the last 10 s, timed against `t` (the time of the newest sample pushed) */
  recentAttacks(t: number): FrameAttack[] {
    const a = this.attacks;
    const out: FrameAttack[] = [];
    for (const e of a.events) {
      const et = t - (a.samples - e.sample) / this.sampleRate;
      if (t - et <= 10) out.push({ t: et, riseMs: e.riseMs, riseDb: e.riseDb, band: e.band, edgeDb: e.edgeDb, ...(e.carried ? { carried: true } : {}) });
    }
    return out;
  }
}

function shiftIn(buf: Float32Array, chunk: Float32Array): void {
  const n = chunk.length;
  if (n >= buf.length) {
    buf.set(chunk.subarray(n - buf.length));
    return;
  }
  buf.copyWithin(0, n);
  buf.set(chunk, buf.length - n);
}

/**
 * Run a buffer through the same frame/hop schedule and front end the app uses. Calls `onFrame`
 * for each analysed frame with t = time (s) of the newest sample in the window.
 */
export function analyzeBuffer(
  samples: Float32Array,
  sampleRate: number,
  onFrame: (f: PitchFrame) => void | boolean,
  path: AnalysisPath = 'voice',
): void {
  const sa = new StreamAnalyzer(sampleRate);
  const hop = Math.round((HOP_MS / 1000) * sampleRate);
  for (let start = 0; start + hop <= samples.length; start += hop) {
    sa.push(samples.subarray(start, start + hop));
    const end = start + hop;
    if (end < FRAME_SIZE) continue;
    const stop = onFrame(sa.frame(path, end / sampleRate));
    if (stop === true) break;
  }
}

/** Which analysis path a session phase listens through. */
/**
 * Warm a fresh analyser on 16-bit samples that start at capture index `c0` (a whole number of hops
 * after the start of capture): push them hop by hop and analyse both paths at every hop once a
 * full frame is in. The app does this when a session starts and the replay does the same, so both
 * start from the same state. Frame time = t0 + capture index / sample rate. It can be done in
 * pieces (each a whole number of hops; pass the samples pushed so far): the result is the same.
 */
export function warmAnalyzer(sa: StreamAnalyzer, q: Int16Array, c0: number, t0: number, hop: number, pushedBefore = 0): number {
  const sr = sa.sampleRate;
  const buf = new Float32Array(hop);
  let pushed = pushedBefore;
  for (let off = 0; off + hop <= q.length; off += hop) {
    for (let i = 0; i < hop; i++) {
      const v = q[off + i];
      buf[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
    }
    sa.push(buf);
    pushed += hop;
    if (pushed >= FRAME_SIZE) {
      const t = t0 + (c0 + off + hop) / sr;
      sa.frame('voice', t);
      sa.frame('guitar', t);
    }
  }
  return pushed;
}

/** A 16-bit sample as the analysis sees it. */
export const fromInt16 = (v: number): number => (v < 0 ? v / 0x8000 : v / 0x7fff);

export function pathForPhase(phase: string): AnalysisPath {
  return phase === 'sing' ? 'voice' : 'guitar';
}

/** Convenience: feed a buffer to a matcher and return when (if ever) it accepted. */
export function runMatcher(samples: Float32Array, sampleRate: number, cfg: MatchConfig): { acceptedAt: number | null; matcher: NoteMatcher } {
  const m = new NoteMatcher(cfg);
  let acceptedAt: number | null = null;
  analyzeBuffer(samples, sampleRate, (f) => {
    const s = m.push(f);
    if (s.accepted) {
      acceptedAt = s.acceptedAt;
      return true;
    }
  }, cfg.kind === 'plucked' ? 'guitar' : 'voice');
  return { acceptedAt, matcher: m };
}
