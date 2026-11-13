import { describe, expect, it } from 'vitest';
import { guitarConfig, runMatcher, singConfig } from '../src/core/engine.ts';
import { centsFromMidi, midiToFreq } from '../src/core/music.ts';
import { PitchDetector } from '../src/core/pitch.ts';
import { SR, concat, noise, pluck, silence, voice } from '../scripts/fixtures.ts';

function sine(freq: number, n: number, sr = SR): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sr);
  return x;
}

describe('MPM pitch detector', () => {
  it('detects sines across E2–E5 within 2 cents at 44.1k and 48k', () => {
    for (const sr of [44100, 48000]) {
      const d = new PitchDetector(2048, sr);
      for (let m = 40; m <= 76; m += 3) {
        const r = d.detect(sine(midiToFreq(m), 2048, sr));
        expect(Math.abs(centsFromMidi(r.freq, m))).toBeLessThan(2);
        expect(r.clarity).toBeGreaterThan(0.95);
      }
    }
  });
  it('reports zero pitch / clarity for silence and low clarity for noise', () => {
    const d = new PitchDetector(2048, SR);
    expect(d.detect(new Float32Array(2048)).freq).toBe(0);
    expect(d.detect(noise(0.1, 0.1, 5).subarray(0, 2048)).clarity).toBeLessThan(0.8);
  });
  it('plucked low E is found in the right octave', () => {
    const x = pluck(40, 1);
    const d = new PitchDetector(2048, SR);
    const r = d.detect(x.subarray(9600, 9600 + 2048));
    expect(Math.abs(centsFromMidi(r.freq, 40))).toBeLessThan(5);
  });
});

describe('matcher on synthetic audio', () => {
  it('guitar note accepted quickly, wrong octave never', () => {
    const x = concat(silence(0.2), pluck(52, 1.5));
    const ok = runMatcher(x, SR, guitarConfig(52));
    expect(ok.acceptedAt).not.toBeNull();
    expect(ok.acceptedAt! - 0.2).toBeLessThan(0.4);
    expect(runMatcher(x, SR, guitarConfig(64)).acceptedAt).toBeNull();
    expect(runMatcher(x, SR, guitarConfig(40)).acceptedAt).toBeNull();
  });
  it('sung note with vibrato passes in any octave after the hold', () => {
    const x = concat(silence(0.2), voice(57, 1.5));
    const r = runMatcher(x, SR, singConfig(45, 50, false));
    expect(r.acceptedAt).not.toBeNull();
    expect(r.acceptedAt! - 0.2).toBeGreaterThan(0.5);
    expect(runMatcher(x, SR, singConfig(58, 50, false)).acceptedAt).toBeNull();
  });
});
