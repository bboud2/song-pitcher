import { student } from './students.ts';
import * as S from './fixtures3.ts';
const set = process.argv[2] ?? 'A';
const runs: Record<string, () => void> = {
  A: () => {
    student({ name: 'A1 honest: sings, stops, pause 0.5 s, one pluck, damps previous note; review at written tempo (84 bpm)' });
    student({ name: 'A2 honest, lets every note ring', ring: true });
    student({ name: 'A3 plucks 0.15 s after the sing accept while still singing (voice lasts 0.4 s more)', pluckDuringSing: true, noReview: true });
  },
  B: () => {
    student({ name: 'B1 wrong fret first (2 frets up), then right note 0.8 s later, damped', wrongFirst: [2], noReview: true });
    student({ name: 'B2 wrong fret first (2 frets up), lets it ring', wrongFirst: [2], ring: true, noReview: true });
    student({ name: 'B3 wrong OCTAVE first (+12), then right; damped', wrongFirst: [12], noReview: true });
    student({ name: 'B4 wrong OCTAVE first (+12) while ringing', wrongFirst: [12], ring: true, noReview: true });
    student({ name: 'B5 hunts: -5, +2, -1 then right, 0.6 s apart, ringing', wrongFirst: [-5, 2, -1], wrongGap: 0.6, ring: true, noReview: true });
    student({ name: 'B6 hunts: +7, +12, -12 (wrong pluck gets 1.4 s to be accepted), ringing', wrongFirst: [7, 12, -12], wrongGap: 1.4, ring: true, noReview: true });
    student({ name: 'B7 hunts: +7, +12, -12 (1.4 s each), damped', wrongFirst: [7, 12, -12], wrongGap: 1.4, noReview: true });
  },
  C: () => {
    student({ name: 'C1 hums a short "hm" (0.45 s, dies away) twice at the target pitch while hunting, then plucks', humWhileHunting: true, noReview: true });
    student({ name: 'C2 voice-only, staccato "da" 0.5 s notes with 14 dB/s decay (never touches guitar)', noGuitar: true, vDur: 0.5, voice: { attack: 0.015, release: 0.1, env: (t) => S.db2a(-14 * t) }, intonSd: 5 });
    student({ name: 'C3 voice-only, normal 1.2 s notes', noGuitar: true, vDur: 1.2, intonSd: 5 }, { maxNotes: 30 });
    student({ name: 'C4 guitar-only, normal acoustic (9-17 dB/s)', noSing: true, noReview: true }, { maxNotes: 30 });
    student({ name: 'C5 guitar-only, long-sustain guitar (3 dB/s late decay, e.g. electric/DI)', noSing: true, noReview: true, guitar: { decayDbS: 3, pol2: 0.5 } });
    student({ name: 'C6 guitar-only, normal acoustic, phone AGC 12 dB/s', noSing: true, noReview: true }, { agc: 12 });
    student({ name: 'C7 guitar-only, normal acoustic, lets ring, phone AGC 6 dB/s', noSing: true, noReview: true, ring: true }, { agc: 6 });
  },
  D: () => {
    for (const tempo of [1, 0.75, 0.5]) student({ name: `D review at ${tempo * 100}% of written tempo (84 bpm), damped`, reviewTempo: tempo });
    for (const ioi of [0.3, 0.4, 0.5, 0.7, 1.0]) student({ name: `D review, even notes every ${ioi} s, ringing`, reviewIOI: ioi, ring: true });
  },
  F: () => {
    student({ name: 'F1 review at written tempo, damped (verbose)', reviewTempo: 1, verbose: true });
    student({ name: 'F2 review 1 s per note, only the previous note rings (verbose)', reviewIOI: 1.0, ring: true, ringOne: true, verbose: true });
    student({ name: 'F3 review 0.6 s per note, only the previous note rings', reviewIOI: 0.6, ring: true, ringOne: true });
    student({ name: 'F4 review 0.6 s per note, damped', reviewIOI: 0.6 });
    student({ name: 'F5 review 0.45 s per note, damped', reviewIOI: 0.45 });
    student({ name: 'F6 review 0.35 s per note, damped', reviewIOI: 0.35 });
    student({ name: 'F7 review 0.3 s per note, damped', reviewIOI: 0.3 });
  },
  H: () => {
    student({ name: 'H1 wrong octave first (+12, rings 1.6 s) then right; 60 Hz hum -50 dBFS', wrongFirst: [12], wrongGap: 1.6, noReview: true }, { humDb: -50 });
    student({ name: 'H2 wrong octave first (+12, rings 1.6 s) then right; 60 Hz hum -45 dBFS', wrongFirst: [12], wrongGap: 1.6, noReview: true }, { humDb: -45 });
    student({ name: 'H3 wrong octave first (+12, 1.6 s), no hum (control)', wrongFirst: [12], wrongGap: 1.6, noReview: true });
    student({ name: 'H4 key of G (tonic 43): wrong octave first (+12, 1.6 s); hum -50', wrongFirst: [12], wrongGap: 1.6, noReview: true }, { humDb: -50, tonic: 43 });
  },
  E: () => {
    student({ name: 'E1 honest + phone AGC 12 dB/s', noReview: true }, { agc: 12 });
    student({ name: 'E2 honest + phone AGC 25 dB/s', noReview: true }, { agc: 25 });
    student({ name: 'E3 honest + 60 Hz hum -45 dBFS', noReview: true }, { humDb: -45 });
    student({ name: 'E4 honest + 60 Hz hum -38 dBFS', noReview: true }, { humDb: -38 });
    student({ name: 'E5 honest, quiet guitar -36 dBFS peak', noReview: true, gPeak: S.db2a(-36) });
    student({ name: 'E6 honest, guitar -30 dBFS + fan -42 dBFS', noReview: true, gPeak: S.db2a(-30) }, { fanDb: -42 });
    student({ name: 'E7 honest, singer fades each note -9 dB/s', noReview: true, voice: { env: (t) => S.db2a(-9 * t) } });
    student({ name: 'E8 honest, sloppy singer (intonation sd 30c)', noReview: true, intonSd: 30 });
    student({ name: 'E9 honest, key of G (tonic G2: D2..) -> placed tonic 43', noReview: true }, { tonic: 43 });
  },
};
runs[set]();
