// Shared pitch-engine configuration used by both the browser app and the offline gauntlet,
// so what is measured offline is what runs on the phone. No DOM.
import { GUITAR_DEFAULTS, NoteMatcher, SING_DEFAULTS, type MatchConfig, type PitchFrame } from './matcher.ts';
import { PitchDetector } from './pitch.ts';

/** Analysis window. 2048 samples ≈ 43 ms at 48 kHz: ~3.5 periods of guitar low E (82.4 Hz). */
export const FRAME_SIZE = 2048;
/** Analysis hop (the app polls the analyser at this interval). */
export const HOP_MS = 20;
/** Guitar exact-octave tolerance. */
export const GUITAR_TOLERANCE_CENTS = 40;

export function singConfig(targetMidi: number, toleranceCents: number, exactOctave: boolean): MatchConfig {
  return { ...SING_DEFAULTS, targetMidi, toleranceCents, mode: exactOctave ? 'exact' : 'pitchClass' };
}

export function guitarConfig(targetMidi: number): MatchConfig {
  return { ...GUITAR_DEFAULTS, targetMidi, toleranceCents: GUITAR_TOLERANCE_CENTS };
}

export function makeDetector(sampleRate: number): PitchDetector {
  return new PitchDetector(FRAME_SIZE, sampleRate, { minFreq: 60, maxFreq: 1200, cutoff: 0.9 });
}

/**
 * Run a buffer through the same frame/hop schedule the app uses. Calls `onFrame` for each
 * analysed frame with t = time (s) of the newest sample in the window.
 */
export function analyzeBuffer(
  samples: Float32Array,
  sampleRate: number,
  onFrame: (f: PitchFrame) => void | boolean,
): void {
  const det = makeDetector(sampleRate);
  const hop = Math.round((HOP_MS / 1000) * sampleRate);
  for (let end = FRAME_SIZE; end <= samples.length; end += hop) {
    const r = det.detect(samples.subarray(end - FRAME_SIZE, end));
    const stop = onFrame({ t: end / sampleRate, freq: r.freq, clarity: r.clarity, rms: r.rms });
    if (stop === true) break;
  }
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
  });
  return { acceptedAt, matcher: m };
}
