// Shared pitch-engine configuration used by both the browser app and the offline gauntlet,
// so what is measured offline is what runs on the phone. No DOM.
import { NoteMatcher, PLUCKED_DEFAULTS, SUNG_DEFAULTS, type MatchConfig, type PitchFrame } from './matcher.ts';
import { PitchDetector } from './pitch.ts';

/** Analysis window. 2048 samples ≈ 43 ms at 48 kHz: ~3.5 periods of guitar low E (82.4 Hz). */
export const FRAME_SIZE = 2048;
/** Analysis hop (the app polls the analysers at this interval). */
export const HOP_MS = 20;
/** Guitar exact-octave tolerance. */
export const GUITAR_TOLERANCE_CENTS = 40;
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
  return { ...PLUCKED_DEFAULTS, targetMidi, toleranceCents: GUITAR_TOLERANCE_CENTS, mode: 'exact', strict, ...(fast ? { pitchWindowMs: 90 } : {}) };
}

export function makeDetector(sampleRate: number, path: AnalysisPath = 'voice'): PitchDetector {
  return new PitchDetector(FRAME_SIZE, sampleRate, {
    minFreq: path === 'guitar' ? GUITAR_MIN_HZ : VOICE_MIN_HZ,
    // guitar tops out at E5 (659 Hz); a high voice singing two octaves up can reach G6 (1568 Hz)
    maxFreq: path === 'guitar' ? 1200 : 1700,
    cutoff: 0.9,
    // Guitar path: stationary noise (fan, hiss, mains hum) is tracked and removed from every
    // frame. Not on the voice path: a held sung note is itself steady, and the tracker would
    // slowly learn it as "noise".
    denoise: path === 'guitar',
    hopSec: HOP_MS / 1000,
  });
}

/** RBJ high-/low-pass biquad (same formulas as Web Audio's BiquadFilterNode). */
export class Biquad {
  private b0: number; private b1: number; private b2: number; private a1: number; private a2: number;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  constructor(sampleRate: number, fc: number, q: number, type: 'highpass' | 'lowpass' = 'highpass') {
    const w = (2 * Math.PI * fc) / sampleRate;
    const alpha = Math.sin(w) / (2 * q);
    const cw = Math.cos(w);
    const a0 = 1 + alpha;
    const k = type === 'highpass' ? 1 + cw : 1 - cw;
    this.b0 = k / 2 / a0;
    this.b1 = (type === 'highpass' ? -k : k) / a0;
    this.b2 = k / 2 / a0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  process(x: Float32Array, out: Float32Array = new Float32Array(x.length)): Float32Array {
    for (let i = 0; i < x.length; i++) {
      const y = this.b0 * x[i] + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x[i]; this.y2 = this.y1; this.y1 = y;
      out[i] = y;
    }
    return out;
  }
}

/** Streaming front end: keeps the latest FRAME_SIZE samples of the raw and the high-passed signal. */
export class StreamAnalyzer {
  readonly sampleRate: number;
  private lp = new Float32Array(FRAME_SIZE);
  private hp = new Float32Array(FRAME_SIZE);
  private filters: Biquad[];
  private lpFilters: Biquad[];
  private det: Record<AnalysisPath, PitchDetector>;

  constructor(sampleRate: number) {
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
  }

  frame(path: AnalysisPath, t: number): PitchFrame {
    const r = this.det[path].detect(path === 'guitar' ? this.hp : this.lp);
    return { t, freq: r.freq, clarity: r.clarity, rms: r.rms, upClarity: r.upClarity ?? 0, cleanRms: r.cleanRms, nsdf: r.nsdf, sr: this.sampleRate, novFreq: r.novFreq, novClarity: r.novClarity, novShare: r.novShare };
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
