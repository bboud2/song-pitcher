import { describe, expect, it } from 'vitest';
import { guitarConfig } from '../src/core/engine.ts';
import { NoteMatcher, type FrameAttack, type PitchFrame } from '../src/core/matcher.ts';
import { midiToFreq } from '../src/core/music.ts';

/** Feed frames every `hop` s; returns the accept time or null, and the last hint. */
type F = Omit<PitchFrame, 't'> & { attack?: 'pluck' | 'voice' };
let clockT = 0;
function run(m: NoteMatcher, frames: F[], hop = 0.02): { at: number | null; hint: string | null } {
  let t = clockT;
  let hint: string | null = null;
  const ev: FrameAttack[] = [];
  for (const f of frames) {
    t += hop;
    clockT = t;
    if (f.attack === 'pluck') ev.push({ t: t - hop / 2, riseMs: 2, riseDb: 30, band: 'full' }, { t: t - hop / 2, riseMs: 1, riseDb: 25, band: 'hf' });
    if (f.attack === 'voice') ev.push({ t: t - hop / 2, riseMs: 45, riseDb: 30, band: 'full' });
    const s = m.push({ t, ...f, attacks: ev.filter((e) => e.t <= t) });
    hint = s.hint;
    if (s.accepted) return { at: t, hint };
  }
  return { at: null, hint };
}
const quiet = (n: number): F[] => Array.from({ length: n }, () => ({ freq: 0, clarity: 0, rms: 0.0005 }));
/** a string: level jump (a sharp attack), then a free decay at `decay` dB/s; pitch path given per frame */
const pluck = (n: number, pitch: (k: number) => number, decay = 15, peak = 0.2): F[] =>
  Array.from({ length: n }, (_, k) => ({ freq: midiToFreq(pitch(k)), clarity: 0.97, rms: peak * Math.pow(10, (-decay * k * 0.02) / 20), attack: k === 0 ? ('pluck' as const) : undefined }));

describe('plucked matcher', () => {
  it('an in-tune pluck is accepted', () => {
    expect(run(new NoteMatcher(guitarConfig(55)), [...quiet(10), ...pluck(40, () => 55)]).at).not.toBeNull();
  });

  it('a neighbouring fret read sharp at a hard attack (+45 c, settling back) is never accepted', () => {
    // one fret below the target on a string 40 c sharp: −60 c settled, −15 c higher at the attack
    const r = run(new NoteMatcher(guitarConfig(55)), [...quiet(10), ...pluck(60, (k) => 54.4 + 0.15 * Math.exp(-k / 4))]);
    expect(r.at).toBeNull();
  });

  it('a note that settles on the target after a late-landing finger is accepted; one that leaves it is not', () => {
    // open string for 120 ms, then the fretted target
    expect(run(new NoteMatcher(guitarConfig(57)), [...quiet(10), ...pluck(40, (k) => (k < 6 ? 55 : 57))]).at).not.toBeNull();
    // target for 120 ms, then hammered to the next fret
    expect(run(new NoteMatcher(guitarConfig(57)), [...quiet(10), ...pluck(40, (k) => (k < 6 ? 57 : 58))]).at).toBeNull();
  });

  it('a string 40 c sharp still passes (beginners press hard); 60 c sharp is called out of tune', () => {
    expect(run(new NoteMatcher(guitarConfig(55)), [...quiet(10), ...pluck(40, () => 55.4)]).at).not.toBeNull();
    const r = run(new NoteMatcher(guitarConfig(55)), [...quiet(10), ...pluck(40, () => 55.6)]);
    expect(r.at).toBeNull();
    expect(r.hint).toBe('outOfTune');
  });

  it('a hummed note at the target (steady level) does not pass; the following pluck does', () => {
    // (a hum builds up over ~50 ms: the analyser reports a slow attack)
    const hum: F[] = Array.from({ length: 35 }, (_, k) => ({ freq: midiToFreq(55), clarity: 0.97, rms: k < 2 ? 0.02 * (k + 1) : 0.05, attack: k === 0 ? ('voice' as const) : undefined }));
    const m = new NoteMatcher(guitarConfig(55));
    expect(run(m, [...quiet(10), ...hum]).at).toBeNull();
    expect(run(m, [...quiet(15), ...pluck(40, () => 55)]).at).not.toBeNull();
  });

  it('irregular frame timing (40 ms ticks, stalls) still accepts a pluck', () => {
    expect(run(new NoteMatcher(guitarConfig(52)), [...quiet(6), ...pluck(25, () => 52, 15)], 0.04).at).not.toBeNull();
  });
});
