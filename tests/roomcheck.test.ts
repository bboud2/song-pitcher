import { describe, expect, it } from 'vitest';
import { RoomCheck, findHumLine } from '../src/core/roomcheck.ts';

const SR = 48000;
const FFT = 8192;
function spectrum(lines: { hz: number; db: number }[]): Float32Array {
  const s = new Float32Array(FFT / 2).fill(-100);
  for (const l of lines) {
    const b = Math.round((l.hz * FFT) / SR);
    s[b] = Math.max(s[b], l.db);
  }
  return s;
}

describe('room check', () => {
  it('finds a steady 60 Hz hum family', () => {
    expect(findHumLine(spectrum([{ hz: 60, db: -60 }, { hz: 120, db: -66 }]), SR, FFT)?.base).toBe(60);
    expect(findHumLine(spectrum([{ hz: 50, db: -60 }, { hz: 100, db: -66 }]), SR, FFT)?.base).toBe(50);
    expect(findHumLine(spectrum([{ hz: 60, db: -60 }]), SR, FFT)?.base).toBe(60);
    expect(findHumLine(spectrum([{ hz: 50, db: -60 }]), SR, FFT)?.base).toBe(50);
    expect(findHumLine(spectrum([]), SR, FFT)).toBeNull();
  });

  it('a plucked open D string (146.8 Hz, next to the 150 Hz line) is not reported as hum', () => {
    const r = new RoomCheck();
    let t = 0;
    for (let k = 0; k < 120; k++) {
      t += 0.02;
      const hearing = k > 20 && k < 110; // the string rings for ~1.8 s
      r.frame(t, hearing ? -25 : -65, hearing);
      if (k % 10 === 0) r.spectrum(spectrum(hearing ? [{ hz: 146.8, db: -40 }, { hz: 293.7, db: -50 }] : []), SR, FFT);
    }
    expect(r.verdict().hum).toBeNull();
  });

  it('real hum in a quiet room is reported', () => {
    const r = new RoomCheck();
    let t = 0;
    for (let k = 0; k < 100; k++) {
      t += 0.02;
      r.frame(t, -60, false);
      if (k % 10 === 0) r.spectrum(spectrum([{ hz: 50, db: -55 }, { hz: 100, db: -60 }, { hz: 150, db: -62 }]), SR, FFT);
    }
    expect(r.verdict().hum).toBe(50);
  });

  it('the margin figure holds steady after the note (no sinking while you read it)', () => {
    const r = new RoomCheck();
    let t = 0;
    for (let k = 0; k < 60; k++) r.frame((t += 0.02), -65, false);
    for (let k = 0; k < 20; k++) r.frame((t += 0.02), -30, true);
    const first = r.verdict().marginDb!;
    for (let k = 0; k < 150; k++) r.frame((t += 0.02), -65, false); // 3 s later
    expect(Math.abs(r.verdict().marginDb! - first)).toBeLessThan(0.5);
    expect(r.verdict().messages[0]).toMatch(/^Good/);
  });
});
