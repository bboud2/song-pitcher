// Mic-check tuner (round 8): out-of-tune warnings only from plucked strings, two plucks agreeing,
// at least 30 c; far-out strings named; the D string 35 c sharp (on 150 Hz) is not taken for
// mains hum. Each case failed on the round-7 tuner logic (noted per test).
import { describe, expect, it } from 'vitest';
import { StreamAnalyzer } from '../src/core/engine.ts';
import { StablePitch } from '../src/core/matcher.ts';
import { OctaveSlipFilter, TuneWatch } from '../src/core/tunewatch.ts';
import { SR, guitar, voice } from '../scripts/critic6/syn6.ts';

/** Run sounds (each placed at a time, s) through the analysis and the tuner logic as the app does. */
function run(parts: { at: number; x: Float32Array; db?: number }[], total: number) {
  const n = Math.round(total * SR);
  const y = new Float32Array(n);
  let s = 7;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    y[i] = ((s >>> 8) / 16777216 - 0.5) * 2e-4;
  }
  for (const p of parts) {
    const g = Math.pow(10, (p.db ?? -12) / 20);
    const o = Math.round(p.at * SR);
    for (let i = 0; i < p.x.length && o + i < n; i++) y[o + i] += p.x[i] * g;
  }
  const sa = new StreamAnalyzer(SR);
  const st = new StablePitch();
  const w = new TuneWatch();
  const hop = Math.round(0.02 * SR);
  const shown: (number | null)[] = [];
  const slips = new OctaveSlipFilter();
  let pushed = 0;
  for (let o = 0; o + hop <= n; o += hop) {
    sa.push(y.subarray(o, o + hop));
    pushed += hop;
    if (pushed < 2048) continue;
    const f = sa.frame('guitar', (o + hop) / SR);
    sa.frame('voice', f.t);
    const m = st.push(f);
    w.push(f.t, m, 20 * Math.log10(Math.max(f.rms, 1e-6)), f.attacks ?? []);
    shown.push(slips.push(m));
  }
  return { w, shown };
}
const pluck = (midi: number, cents: number, seed = 1, pluckKind: 'pick' | 'finger' = 'pick') => guitar({ midi, cents, seed, dur: 3, pluck: pluckKind }).main;

describe('tuner: out-of-tune strings', () => {
  it('D string 35 c sharp: two plucks give a warning (round 7: shown as "– –", taken for 150 Hz mains hum)', () => {
    const { w } = run([{ at: 0.5, x: pluck(50, 35, 1) }, { at: 4, x: pluck(50, 35, 2) }], 7.5);
    expect(w.message()).toMatch(/D3 string sounds about 3\d¢ sharp/);
  });

  it('one pluck is not enough', () => {
    const { w } = run([{ at: 0.5, x: pluck(55, -40, 1) }], 4);
    expect(w.message()).toBeNull();
  });

  it('a string 160 c flat is named as far out of tune (round 7: no warning at all past 50 c)', () => {
    const { w } = run([{ at: 0.5, x: pluck(45, -160, 1) }, { at: 4, x: pluck(45, -160, 3) }], 7.5);
    expect(w.message()).toMatch(/may be the A2 string, far out of tune \(about 1[56]\d¢ flat\)/);
  });

  it('a stiff string, hard pick, 15 c sharp: no warning (round 7 warned past 25 c on the attack)', () => {
    const { w } = run([{ at: 0.5, x: guitar({ midi: 40, cents: 15, seed: 4, dur: 3, pluck: 'hardpick' }).main }, { at: 4, x: guitar({ midi: 40, cents: 15, seed: 5, dur: 3, pluck: 'hardpick' }).main }], 7.5);
    expect(w.message()).toBeNull();
  });

  it('a sung note near an open string does not warn (round 7 counted any steady reading)', () => {
    const { w } = run([{ at: 0.5, x: voice({ midi: 55.4, dur: 3, seed: 2 }), db: -16 }, { at: 4.5, x: voice({ midi: 55.4, dur: 3, seed: 3 }), db: -16 }], 8);
    expect(w.message()).toBeNull();
  });

  it('a fretted note a semitone from an open string does not warn as "far out of tune"', () => {
    const { w } = run([{ at: 0.5, x: pluck(41, 0, 1) }, { at: 4, x: pluck(41, 0, 2) }], 7.5);
    expect(w.message()).toBeNull();
  });

  it('the warning clears when an in-tune pluck of that string is heard', () => {
    const { w } = run([{ at: 0.5, x: pluck(50, 40, 1) }, { at: 4, x: pluck(50, 40, 2) }, { at: 7.5, x: pluck(50, 2, 3) }], 11);
    expect(w.message()).toBeNull();
    expect(w.measured.length).toBe(3);
  });
});

describe('tuner: note display', () => {
  it('a single-frame octave slip is not shown', () => {
    const f = new OctaveSlipFilter();
    expect([50, 50, 62, 50, 50].map((m) => f.push(m))).toEqual([50, 50, 50, 50, 50]);
    expect([62, 62].map((m) => f.push(m))).toEqual([50, 62]);
  });
});
