import { describe, expect, it } from 'vitest';
import {
  centsBetween, centsFromMidi, centsFromPitchClass, degreeLabel, fretPositions, freqToMidi,
  midiToFreq, nearestNote, noteName, pitchClass,
} from '../src/core/music.ts';

describe('note / frequency math', () => {
  it('A4 = 440 Hz and standard reference pitches', () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 9);
    expect(midiToFreq(40)).toBeCloseTo(82.4069, 3); // E2, guitar low E
    expect(midiToFreq(48)).toBeCloseTo(130.8128, 3); // C3
    expect(midiToFreq(76)).toBeCloseTo(659.2551, 3); // E5
  });
  it('freqToMidi inverts midiToFreq', () => {
    for (let m = 30; m < 100; m += 0.37) expect(freqToMidi(midiToFreq(m))).toBeCloseTo(m, 9);
  });
  it('cents', () => {
    expect(centsBetween(880, 440)).toBeCloseTo(1200, 9);
    expect(centsBetween(440, 880)).toBeCloseTo(-1200, 9);
    expect(centsFromMidi(midiToFreq(60.25), 60)).toBeCloseTo(25, 9);
    expect(centsFromMidi(midiToFreq(59.9), 60)).toBeCloseTo(-10, 9);
  });
  it('pitch-class cents fold octaves into (-600, 600]', () => {
    expect(centsFromPitchClass(midiToFreq(48.2), 60)).toBeCloseTo(20, 6); // C3 vs target C4
    expect(centsFromPitchClass(midiToFreq(72 - 0.3), 60)).toBeCloseTo(-30, 6); // C5 slightly flat
    expect(centsFromPitchClass(midiToFreq(61), 60)).toBeCloseTo(100, 6);
    expect(Math.abs(centsFromPitchClass(midiToFreq(66), 60))).toBeCloseTo(600, 6); // tritone edge
    expect(centsFromPitchClass(midiToFreq(65.9), 60)).toBeCloseTo(590, 6);
    expect(centsFromPitchClass(midiToFreq(54.1), 60)).toBeCloseTo(-590, 6);
  });
  it('nearestNote', () => {
    const n = nearestNote(midiToFreq(57.4));
    expect(n.midi).toBe(57);
    expect(n.cents).toBeCloseTo(40, 6);
    expect(nearestNote(midiToFreq(57.6)).midi).toBe(58);
  });
  it('note names with key-appropriate spelling', () => {
    expect(noteName(48)).toBe('C3');
    expect(noteName(40)).toBe('E2');
    expect(noteName(61)).toBe('C♯4');
    expect(noteName(70, 5)).toBe('B♭4'); // F major spells flats
    expect(noteName(70, 7)).toBe('A♯4'); // G major spells sharps
    expect(noteName(59, 0, false)).toBe('B');
    expect(pitchClass(-1)).toBe(11);
  });
  it('scale degree labels', () => {
    expect([0, 2, 4, 5, 7, 9, 11, 12, 19].map(degreeLabel)).toEqual(['1', '2', '3', '4', '5', '6', '7', '1', '5']);
    expect(degreeLabel(6)).toBe('♯4');
  });
  it('fret positions (sounding pitch)', () => {
    expect(fretPositions(48)).toContainEqual({ string: 5, fret: 3 }); // C3 = 5th string 3rd fret
    expect(fretPositions(40)).toEqual([{ string: 6, fret: 0 }]);
  });
});
