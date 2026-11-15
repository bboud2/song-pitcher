// Round-8 behaviour tests through the seventh review's rooms (modal room impulse responses with
// the voice and the guitar convolved separately, so a note stopped dry keeps its true tail). Each
// pins a defect of the round-7 build (45c50a5) on the same audio — every expectation below fails
// there (round-7 figures in the comments):
//   a1  a pluck made as the sung answer stops, or 150 ms after, was refused (the answer's swell
//       and tail held every candidate opened under it);
//   b1  the answer's own tail, swelling again in a bare room, passed the guitar step;
//   a3  a staccato pluck stopped by the hand after 0.18 s was refused (an abrupt end was taken
//       for a voice stopping);
//   a4  in a living room 1 pluck in 10 took 0.44 s or more to accept;
//   a2  a sung "oh" on F♯3 in a live room read a twelfth high and stuck;
//   b3  F♯2 plucked for F♯3 passed (read an octave up).
import { describe, expect, it } from 'vitest';
import { gapProbe, ownProbe, singProbe, stringProbe, wrongProbe } from '../scripts/critic7/probes7.ts';

describe('seventh review rooms (round 8 fixes)', () => {
  it('a1: a pluck as the voice stops, and 150 ms after it, is taken at once (live room)', () => {
    const atStop = gapProbe('live', 0, 0);
    expect(atStop.first).toBeGreaterThanOrEqual(atStop.n - 1); // round 7: 1/10
    const after = gapProbe('live', 0, 150);
    expect(after.first).toBeGreaterThanOrEqual(after.n - 1); // round 7: 7/10
  }, 300_000);

  it('b1: the sung answer going on into the guitar step, then stopping, does not pass it (bare room)', () => {
    const r = ownProbe('bare', 'held e pressed');
    expect(r.n).toBeGreaterThan(30);
    expect(r.adv).toBeLessThanOrEqual(1); // round 7: 14/39
  }, 300_000);

  it('a3: staccato plucks stopped after 0.18 s count (dry room)', () => {
    const r = stringProbe('dry', 'stacc180');
    expect(r.first).toBeGreaterThanOrEqual(r.n - 3); // round 7: 13/20
  }, 300_000);

  it('a4: pick plucks in a living room are accepted within 0.4 s (90th percentile)', () => {
    const r = stringProbe('living', 'base');
    expect(r.first).toBe(r.n);
    expect(r.p90).toBeLessThan(400); // round 7: 443 ms
  }, 300_000);

  it('a2: a sung "oh" read a twelfth high in a live room is still the note sung', () => {
    const r = singProbe('live', 'o', 0.5);
    expect(r.stuck).toBe(0); // round 7: F♯3 stuck (1/11)
  }, 300_000);

  it('b3: the octave below is not accepted (dry room)', () => {
    const r = wrongProbe('dry', 'oct-');
    expect(r.acc).toBe(0); // round 7: 2/38
  }, 300_000);
});
