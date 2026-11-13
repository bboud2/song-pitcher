import { describe, expect, it } from 'vitest';
import { noteName } from '../src/core/music.ts';
import { STAR_SPANGLED_BANNER as SSB, parseMelody, placeTonic, songRange, transpose, validTonics } from '../src/core/songs.ts';

describe('melody parser', () => {
  it('parses degrees, accidentals and octave marks', () => {
    expect(parseMelody("1:1 #4:0.5 7,:2 5'':1 b7:1")).toEqual([
      { offset: 0, beats: 1 }, { offset: 6, beats: 0.5 }, { offset: -1, beats: 2 }, { offset: 31, beats: 1 }, { offset: 10, beats: 1 },
    ]);
    expect(() => parseMelody('9:1')).toThrow();
    expect(() => parseMelody('1:0')).toThrow();
  });
});

describe('The Star-Spangled Banner data', () => {
  it('has the complete melody: 101 notes, 16 phrases, 32 bars of 3/4 plus a one-beat pickup', () => {
    expect(SSB.notes).toHaveLength(101);
    expect(SSB.phrases).toHaveLength(16);
    const beats = SSB.notes.reduce((a, n) => a + n.beats, 0);
    expect(beats).toBe(97);
    expect((beats - 1) % 3).toBe(0);
  });
  it('phrases tile the melody contiguously and are reviewable lengths', () => {
    let next = 0;
    for (const p of SSB.phrases) {
      expect(p.start).toBe(next);
      expect(p.end).toBeGreaterThanOrEqual(p.start);
      const len = p.end - p.start + 1;
      expect(len).toBeGreaterThanOrEqual(5);
      expect(len).toBeLessThanOrEqual(8);
      next = p.end + 1;
    }
    expect(next).toBe(SSB.notes.length);
  });
  it('in C the range is C3–G4 and it opens G3 E3 C3 E3 G3 C4', () => {
    const tonic = placeTonic(SSB, 0);
    expect(tonic).toBe(48);
    const midis = transpose(SSB, tonic);
    expect(noteName(Math.min(...midis))).toBe('C3');
    expect(noteName(Math.max(...midis))).toBe('G4');
    expect(midis.slice(0, 6).map((m) => noteName(m))).toEqual(['G3', 'E3', 'C3', 'E3', 'G3', 'C4']);
    // "...land of the free" climbs to the top note; "...home of the brave" ends on the tonic.
    expect(noteName(midis[midis.length - 1])).toBe('C4');
    expect(midis.slice(88, 95).map((m) => noteName(m))).toEqual(['G3', 'G3', 'C4', 'D4', 'E4', 'F4', 'G4']);
  });
  it('interval sanity: diatonic except the raised 4th, steps/leaps of plausible size', () => {
    const diatonicPlusSharp4 = new Set([0, 2, 4, 5, 6, 7, 9, 11]);
    for (const n of SSB.notes) expect(diatonicPlusSharp4.has(((n.offset % 12) + 12) % 12)).toBe(true);
    const leaps = SSB.notes.slice(1).map((n, i) => n.offset - SSB.notes[i].offset);
    expect(Math.max(...leaps.map(Math.abs))).toBe(16); // "streaming? / And the" — the famous leap of a 10th
    expect(leaps.filter((l) => Math.abs(l) > 9)).toHaveLength(1);
    // The opening arpeggio: 5 3 1 3 5 8 = down m3, down M3, up M3, up m3, up P4
    expect(leaps.slice(0, 5)).toEqual([-3, -4, 4, 3, 5]);
    // Exactly the ♯4 appears in "dawn's early light", "perilous fight", "still there".
    expect(SSB.notes.filter((n) => n.offset === 6)).toHaveLength(3);
  });
  it('"banner yet wave" matches the transcriptions: D4 F4 E4 D4 C4 | C4 B3', () => {
    const p = SSB.phrases[13];
    const midis = transpose(SSB, 48).slice(p.start, p.end + 1).map((m) => noteName(m));
    expect(midis).toEqual(['D4', 'F4', 'E4', 'D4', 'C4', 'C4', 'B3']);
    expect(SSB.notes.slice(p.start, p.end + 1).map((n) => n.beats)).toEqual([1, 0.5, 0.5, 0.5, 0.5, 1, 1]);
    // every bar is complete: phrase starts fall on the beat before a downbeat, except "banner" (a downbeat)
    let t = 0;
    for (const ph of SSB.phrases) {
      expect(t % 3).toBe(ph === p ? 1 : 0);
      for (let i = ph.start; i <= ph.end; i++) t += SSB.notes[i].beats;
    }
  });
  it('spans an octave and a fifth', () => {
    expect(songRange(SSB)).toEqual({ min: 0, max: 19 });
  });
});

describe('key transposition and range placement', () => {
  it('every key keeps the melody inside guitar range E2–E5 with the right tonic', () => {
    for (let k = 0; k < 12; k++) {
      const t = placeTonic(SSB, k);
      expect(((t % 12) + 12) % 12).toBe(k);
      const m = transpose(SSB, t);
      expect(Math.min(...m)).toBeGreaterThanOrEqual(40);
      expect(Math.max(...m)).toBeLessThanOrEqual(76);
      expect(validTonics(SSB, k)).toContain(t);
    }
  });
  it('prefers the register closest to the default (C3–G4)', () => {
    expect(placeTonic(SSB, 2)).toBe(50); // D3
    expect(placeTonic(SSB, 5)).toBe(53); // F3, not F2
    expect(placeTonic(SSB, 4)).toBe(52); // E3, not E2
    expect(placeTonic(SSB, 7)).toBe(43); // G2 (G3 would reach D5)
    expect(placeTonic(SSB, 11)).toBe(47); // B2
  });
  it('transposition preserves intervals', () => {
    const a = transpose(SSB, 48);
    const b = transpose(SSB, 53);
    a.forEach((m, i) => expect(b[i] - m).toBe(5));
  });
});
