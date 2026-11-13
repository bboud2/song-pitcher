// Pure note / frequency / cents math. No DOM.

export const A4_MIDI = 69;
export const A4_FREQ = 440;

/** Guitar range in standard tuning (concert/sounding pitch): E2..E5 (24th fret area is beyond; E5 = 1st string 12th fret). */
export const GUITAR_LOW_MIDI = 40; // E2, 82.41 Hz
export const GUITAR_HIGH_MIDI = 76; // E5, 659.26 Hz

const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

/** Key names shown in the key picker, indexed by pitch class of the tonic. */
export const KEY_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

/** Major keys whose signature uses flats (by tonic pitch class). */
const FLAT_KEYS = new Set([1, 3, 5, 8, 10]); // Db, Eb, F, Ab, Bb

export function midiToFreq(midi: number): number {
  return A4_FREQ * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** Fractional MIDI number for a frequency. */
export function freqToMidi(freq: number): number {
  return A4_MIDI + 12 * Math.log2(freq / A4_FREQ);
}

/** Cents from frequency b to frequency a (positive = a is sharp of b). */
export function centsBetween(a: number, b: number): number {
  return 1200 * Math.log2(a / b);
}

/** Cents of a frequency relative to a target MIDI note (positive = sharp). */
export function centsFromMidi(freq: number, midi: number): number {
  return centsBetween(freq, midiToFreq(midi));
}

/** Positive modulo. */
export function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

export function pitchClass(midi: number): number {
  return mod(Math.round(midi), 12);
}

/**
 * Signed cents between a frequency and the nearest octave of a target pitch class,
 * in (-600, 600]. Used when "any octave" is allowed.
 */
export function centsFromPitchClass(freq: number, targetMidi: number): number {
  const c = centsFromMidi(freq, targetMidi);
  let r = mod(c, 1200);
  if (r > 600) r -= 1200;
  return r;
}

/** Nearest note to a frequency and the cents offset from it. */
export function nearestNote(freq: number): { midi: number; cents: number } {
  const m = freqToMidi(freq);
  const midi = Math.round(m);
  return { midi, cents: (m - midi) * 100 };
}

export function octaveOf(midi: number): number {
  return Math.floor(Math.round(midi) / 12) - 1;
}

/** Note name such as "C3" or "B♭2". `keyTonicPc` chooses sharp/flat spelling. */
export function noteName(midi: number, keyTonicPc?: number, withOctave = true): string {
  const pc = pitchClass(midi);
  const useFlats = keyTonicPc !== undefined && FLAT_KEYS.has(mod(keyTonicPc, 12));
  const name = (useFlats ? FLAT_NAMES : SHARP_NAMES)[pc];
  return withOctave ? `${name}${octaveOf(midi)}` : name;
}

/** Major-scale degree label for a semitone offset from the tonic, e.g. 0→"1", 6→"♯4", 10→"♭7". */
export function degreeLabel(offset: number): string {
  const labels = ['1', '♭2', '2', '♭3', '3', '4', '♯4', '5', '♭6', '6', '♭7', '7'];
  return labels[mod(offset, 12)];
}

/** Solfège (movable do) for a semitone offset from the tonic. */
export function solfege(offset: number): string {
  const labels = ['do', 'ra', 're', 'me', 'mi', 'fa', 'fi', 'sol', 'le', 'la', 'te', 'ti'];
  return labels[mod(offset, 12)];
}

/** Standard-tuning open strings (sounding pitch), low to high. */
export const OPEN_STRINGS = [40, 45, 50, 55, 59, 64];

/** All (string, fret) positions for a midi note within `maxFret`. string 6 = low E. */
export function fretPositions(midi: number, maxFret = 15): { string: number; fret: number }[] {
  const out: { string: number; fret: number }[] = [];
  OPEN_STRINGS.forEach((open, i) => {
    const fret = midi - open;
    if (fret >= 0 && fret <= maxFret) out.push({ string: 6 - i, fret });
  });
  return out;
}
