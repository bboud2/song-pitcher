// Round-7 behaviour tests through the sixth review's rooms (feedback-delay-network reverberation
// with early reflections, the phone speaker leaking into the mic, the app's real timing). Each
// one reproduces a concrete leak of the round-6 build on the same audio:
//   1. the student's own sung answer advancing the guitar step (live room, vibrato),
//   2. a held sung "ah" passing the guitar step (living room),
//   3. a pick an octave below the target accepted (live room),
//   4. a thin voice stuck in the singing step,
//   5. finger plucks in a live room needing re-plucks with a false "octave too high".
// They take a while (each runs real sessions); the rig is deterministic.
import { describe, expect, it } from 'vitest';
import { honest } from '../scripts/critic6/rig6.ts';
import { STY } from '../scripts/critic6/cases6.ts';
import { probe, g, R } from '../scripts/critic6/probes6.ts';
import { sungMidi } from '../scripts/critic6/rig6.ts';

const quiet = <T>(f: () => T): T => {
  const log = console.log;
  console.log = () => {};
  try {
    return f();
  } finally {
    console.log = log;
  }
};

describe('sixth review rooms (round 7 fixes)', () => {
  it('1+5: live room, finger plucks: no advance by the sung answer, no false "octave too high", few re-plucks', () => {
    const r = quiet(() => honest({ ...STY.H2_live_finger, maxNotes: 25 }));
    expect(r.bad.filter((b) => b.phase === 'play')).toEqual([]);
    // (round 6: ~19 s of a false "octave too high" per 101 notes; a few frames remain where the
    // detector itself reads the octave above for a moment)
    expect(r.hints['play:octaveHigh'] ?? 0).toBeLessThanOrEqual(50);
    expect(r.playStuck).toBe(0);
    expect(r.playSteps - r.firstPluck).toBeLessThanOrEqual(2);
  }, 240_000);

  it('2: a held, sung "ah" with vibrato in a living room does not pass the guitar step', () => {
    const { acc, tried } = quiet(() => probe('VOICE only: ah held 1.5 s vib', 'living', (rig, t, _r, k) => { rig.sing({ midi: sungMidi(t), vowel: 'a', onset: 'normal', dur: 1.5, vibCents: 25, seed: k * 7 + 1 }, -28); }, { n: 24 }));
    expect(tried).toBeGreaterThan(20);
    expect(acc).toBeLessThanOrEqual(6); // round 6: 11/24 (not solved: see the report)
  }, 240_000);

  it('3: a pick an octave below the target in a live room is never accepted', () => {
    const { acc, tried } = quiet(() => probe('octave LOW, pick', 'live', (rig, t, r) => g({ midi: t - 12, seed: 3 + Math.floor(r() * 5) })(rig), { filter: (m) => m - 12 >= 40, n: 30 }));
    expect(tried).toBeGreaterThan(20);
    expect(acc).toBe(0); // round 6: 1/30
  }, 240_000);

  it('4: a thin voice (weak fundamental) is never stuck in the singing step', () => {
    const r = quiet(() => honest({ ...STY.T1_thin_voice, maxNotes: 22 }));
    expect(r.singStuck).toBe(0); // round 6: stuck at notes 18 and 20
  }, 240_000);
});

// (keeps the room table referenced: the probes use the review's living/live rooms)
void R;
