// Behaviour through reverberant rooms (round 7): the guitar step must not take the student's own
// sung answer, a held hum or a wrong octave; a thin voice must pass the singing step; a finger
// pluck in a live room must pass without a false "octave too high". Sources from the sixth
// review's synthesiser, rooms from the fifth review's (convolution with a stochastic RIR).
import { describe, expect, it } from 'vitest';
import { FRAME_SIZE, HOP_MS, StreamAnalyzer, guitarConfig, singConfig, type AnalysisPath } from '../src/core/engine.ts';
import { NoteMatcher, type MatchConfig } from '../src/core/matcher.ts';
import { guitar, voice } from '../scripts/critic6/syn6.ts';
import { makeRoom, reverb, type Room } from '../scripts/critic5/synth5.ts';

const SR = 48000;
const LIVE = makeRoom(-4, 0.8, 7);
const LIVING = makeRoom(2, 0.5, 8);

/** Mix sources (buffer, start s, peak dBFS) through a room, with a quiet noise floor. */
function scene(dur: number, room: Room | null, parts: [Float32Array, number, number][]): Float32Array {
  const out = new Float32Array(Math.floor(dur * SR));
  let s = 12345;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    out[i] = (s / 4294967296 - 0.5) * 2e-4;
  }
  for (const [buf, at, db] of parts) {
    const wet = reverb(buf, room);
    let pk = 0;
    for (const v of wet) pk = Math.max(pk, Math.abs(v));
    const g = Math.pow(10, db / 20) / (pk || 1);
    const o = Math.floor(at * SR);
    for (let i = 0; i < wet.length && o + i < out.length; i++) out[o + i] += g * wet[i];
  }
  return out;
}

/** Run a matcher over the audio from `from` s; returns the accept time and every hint seen. */
function run(x: Float32Array, path: AnalysisPath, cfg: MatchConfig, from: number): { at: number | null; hints: Set<string> } {
  const sa = new StreamAnalyzer(SR);
  const m = new NoteMatcher(cfg);
  const hop = Math.round((HOP_MS / 1000) * SR);
  const hints = new Set<string>();
  for (let n = 0; n + hop <= x.length; n += hop) {
    sa.push(x.subarray(n, n + hop));
    const t = (n + hop) / SR;
    if (n + hop < FRAME_SIZE) continue;
    const f = sa.frame(path, t);
    if (t < from) continue;
    const s = m.push(f);
    if (s.hint) hints.add(s.hint);
    if (s.accepted) return { at: t, hints };
  }
  return { at: null, hints };
}

describe('guitar step in rooms', () => {
  it("the student's own sung answer (vibrato, live room) stopping with no pluck never passes", () => {
    for (const m of [55, 60]) {
      // the answer started in the singing step and goes on into the guitar step, then stops
      const v = voice({ midi: m, dur: 2.2, vowel: 'o', vibCents: 25, seed: m });
      const x = scene(4, LIVE, [[v, 0.2, -18]]);
      expect(run(x, 'guitar', { ...guitarConfig(m), voiceMidi: m }, 1.2).at).toBeNull();
    }
  });

  it('a held hum at the target (1.5 s, living room) does not pass', () => {
    for (const m of [52, 57, 62]) {
      const hum = voice({ midi: m, dur: 1.5, vowel: 'm', onset: 'soft', seed: m + 3 });
      const x = scene(3.5, LIVING, [[hum, 0.8, -24]]);
      expect(run(x, 'guitar', guitarConfig(m), 0.4).at).toBeNull();
    }
  });

  it('a pick an octave below the target (live room) is never accepted', () => {
    for (const m of [57, 60, 64]) {
      const g = guitar({ midi: m - 12, dur: 2.5, seed: 4 }).main;
      const x = scene(3.5, LIVE, [[g, 0.8, -14]]);
      expect(run(x, 'guitar', guitarConfig(m), 0.4).at).toBeNull();
    }
  });

  it('a finger pluck after the sung answer at the same pitch is accepted, with no "octave too high"', () => {
    for (const m of [55, 60]) {
      const v = voice({ midi: m, dur: 1.0, vowel: 'o', vibCents: 20, seed: m });
      const g = guitar({ midi: m, dur: 2.5, pluck: 'finger', seed: 5 }).main;
      const x = scene(4.5, LIVE, [[v, 0.2, -20], [g, 1.9, -14]]);
      const r = run(x, 'guitar', { ...guitarConfig(m), voiceMidi: m }, 0.9);
      expect(r.at).not.toBeNull();
      expect(r.hints.has('octaveHigh')).toBe(false);
    }
  });
});

describe('singing step in rooms', () => {
  it('a thin voice (third harmonic far above the fundamental) passes', () => {
    for (const m of [48, 52, 55]) {
      const v = voice({ midi: m, dur: 2.0, vowel: 'a', thin: true, seed: m } as Parameters<typeof voice>[0]);
      const x = scene(3, LIVING, [[v, 0.4, -24]]);
      expect(run(x, 'voice', singConfig(m, 50, false), 0.2).at).not.toBeNull();
    }
  });
});
