// Generates the fake-microphone WAVs for the end-to-end test.
//
// correct.wav: for each of the first 6 notes of the song (in C: G3 E3 C3 E3 G3 C4) a 5 s
//   segment: a sung note (0–2.6 s) then two guitar plucks of the same note in the same octave;
//   then the phrase played once in order on guitar; then segments for notes 7 and 8.
//   Segments are longer than the app needs per note, so the app always finishes early and
//   re-synchronises at the next segment boundary (Chromium loops the file).
// wrong.wav: same timing, but every sung note is a semitone sharp and every pluck is either a
//   semitone flat or the right pitch class in the wrong octave.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SR, concat, encodeWav, mixInto, noise, pluck, silence, voice } from '../scripts/fixtures.ts';

const SEG = 5.0;

function noteSegment(sungMidi: number, pluckMidis: [number, number], seed: number): Float32Array {
  const seg = silence(SEG);
  mixInto(seg, voice(sungMidi, 2.6, { seed, amp: 0.35, vowel: 'ah' }), 0);
  mixInto(seg, pluck(pluckMidis[0], 1.1, { seed: seed + 1, amp: 0.45 }), Math.floor(2.75 * SR));
  mixInto(seg, pluck(pluckMidis[1], 1.1, { seed: seed + 2, amp: 0.45 }), Math.floor(3.85 * SR));
  return seg;
}

function phraseSegment(midis: number[], seed: number): Float32Array {
  const step = 0.8;
  const once = midis.length * step;
  const seg = silence(0.4 + once + 1.2);
  midis.forEach((m, k) => {
    mixInto(seg, pluck(m, step + 0.05, { seed: seed + k, amp: 0.45 }), Math.floor((0.4 + k * step) * SR));
  });
  return seg;
}

export const FIRST_NOTES = [55, 52, 48, 52, 55, 60, 64, 62]; // G3 E3 C3 E3 G3 C4 | E4 D4

export function buildWavs(outDir: string): { correct: string; wrong: string; voiceOnly: string; guitarOnly: string } {
  const lead = silence(4.0);
  const phrase = FIRST_NOTES.slice(0, 6);
  const correct = concat(
    lead,
    ...phrase.map((m, i) => noteSegment(m, [m, m], 10 + i * 10)),
    phraseSegment(phrase, 500),
    ...FIRST_NOTES.slice(6).map((m, i) => noteSegment(m, [m, m], 200 + i * 10)),
  );
  const wrong = concat(
    lead,
    ...phrase.map((m, i) => noteSegment(m + 1, [m - 1, m + 12], 10 + i * 10)),
    phraseSegment(phrase.map((m) => m + 1), 500),
    ...FIRST_NOTES.slice(6).map((m, i) => noteSegment(m + 1, [m - 1, m - 12], 200 + i * 10)),
  );
  // voice-only: same sung notes (in the guitar's octave, vibrato ±30 c), no plucks at all.
  const voiceOnly = concat(lead, ...FIRST_NOTES.map((m, i) => {
    const seg = silence(SEG);
    mixInto(seg, voice(m, 2.6, { seed: 10 + i * 10, amp: 0.35, vowel: 'ah' }), 0);
    mixInto(seg, voice(m, 1.6, { seed: 11 + i * 10, amp: 0.35, vowel: 'oo', vibratoCents: 5 }), Math.floor(3.0 * SR));
    return seg;
  }));
  // guitar-only: the plucks of every note, never a sung note.
  const guitarOnly = concat(lead, ...FIRST_NOTES.map((m, i) => {
    const seg = silence(SEG);
    for (const at of [0.2, 1.4, 2.6, 3.8]) mixInto(seg, pluck(m, 1.15, { seed: 300 + i * 10 + at * 10, amp: 0.45 }), Math.floor(at * SR));
    return seg;
  }));
  // A little room noise everywhere (about -50 dBFS).
  const addFloor = (x: Float32Array, seed: number) => {
    const n = noise(x.length / SR, 0.003, seed);
    for (let i = 0; i < x.length; i++) x[i] += n[i] ?? 0;
    return x;
  };
  const c = `${outDir}/correct.wav`;
  const w = `${outDir}/wrong.wav`;
  mkdirSync(dirname(c), { recursive: true });
  writeFileSync(c, encodeWav(addFloor(correct, 1)));
  writeFileSync(w, encodeWav(addFloor(wrong, 2)));
  const vo = `${outDir}/voice-only.wav`;
  const go = `${outDir}/guitar-only.wav`;
  writeFileSync(vo, encodeWav(addFloor(voiceOnly, 3)));
  writeFileSync(go, encodeWav(addFloor(guitarOnly, 4)));
  return { correct: c, wrong: w, voiceOnly: vo, guitarOnly: go };
}
