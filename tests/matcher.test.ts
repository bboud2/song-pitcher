import { describe, expect, it } from 'vitest';
import { guitarConfig } from '../src/core/engine.ts';
import { NoteMatcher, type PitchFrame } from '../src/core/matcher.ts';
import { midiToFreq } from '../src/core/music.ts';

/** Feed frames every `hop` s; returns the accept time or null, and the last hint. */
function run(m: NoteMatcher, frames: Omit<PitchFrame, 't'>[], hop = 0.02): { at: number | null; hint: string | null } {
  let t = 0;
  let hint: string | null = null;
  for (const f of frames) {
    t += hop;
    const s = m.push({ t, ...f });
    hint = s.hint;
    if (s.accepted) return { at: t, hint };
  }
  return { at: null, hint };
}
const quiet = (n: number) => Array.from({ length: n }, () => ({ freq: 0, clarity: 0, rms: 0.0005 }));
/** a string: level jump, then a free decay at `decay` dB/s; pitch path given per frame */
const pluck = (n: number, pitch: (k: number) => number, decay = 15, peak = 0.2) =>
  Array.from({ length: n }, (_, k) => ({ freq: midiToFreq(pitch(k)), clarity: 0.97, rms: peak * Math.pow(10, (-decay * k * 0.02) / 20) }));

describe('plucked matcher', () => {
  it('an in-tune pluck is accepted', () => {
    expect(run(new NoteMatcher(guitarConfig(55)), [...quiet(10), ...pluck(40, () => 55)]).at).not.toBeNull();
  });

  it('a pluck one fret below whose reading drifts sharp into the window is never accepted', () => {
    // identified at the attack as F#3 (54), then the reading creeps up to 55 − 0.4 = 40 c flat of G3
    const r = run(new NoteMatcher(guitarConfig(55)), [...quiet(10), ...pluck(60, (k) => 54 + Math.min(0.6, k * 0.02))]);
    expect(r.at).toBeNull();
  });

  it('a string 40 c sharp still passes (beginners press hard); 60 c sharp is called out of tune', () => {
    expect(run(new NoteMatcher(guitarConfig(55)), [...quiet(10), ...pluck(40, () => 55.4)]).at).not.toBeNull();
    const r = run(new NoteMatcher(guitarConfig(55)), [...quiet(10), ...pluck(40, () => 55.6)]);
    expect(r.at).toBeNull();
    expect(r.hint).toBe('outOfTune');
  });

  it('a hummed note at the target (steady level) does not pass; the following pluck does', () => {
    const hum = Array.from({ length: 35 }, (_, k) => ({ freq: midiToFreq(55), clarity: 0.97, rms: k < 2 ? 0.02 * (k + 1) : 0.05 }));
    const m = new NoteMatcher(guitarConfig(55));
    expect(run(m, [...quiet(10), ...hum]).at).toBeNull();
    expect(run(m, [...quiet(15), ...pluck(40, () => 55)]).at).not.toBeNull();
  });

  it('irregular frame timing (40 ms ticks, stalls) still accepts a pluck', () => {
    expect(run(new NoteMatcher(guitarConfig(52)), [...quiet(6), ...pluck(25, () => 52, 15)], 0.04).at).not.toBeNull();
  });
});
