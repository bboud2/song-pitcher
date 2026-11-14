// Ported from the third external review (independent synthesis and session rig), kept as a permanent test.
import { student, fmt, type Style } from './student.ts';
import type { RigOpts } from './rig.ts';
import { speech, tv, scaleToRms } from './synth.ts';

const bgTalk = (sr: number, db: number, female = false) => ({ buf: scaleToRms(speech(40, { sr, seed: 9001, female, um: true, peakDb: -10 }), db), db });
const bgTv = (sr: number, db: number) => ({ buf: scaleToRms(tv(45, sr, 777), db), db });
const allG = ['plain', 'squeak', 'lateFretOpen', 'glideIn', 'double', 'adjacent', 'buzz', 'alt', 'soft', 'hard', 'bright'] as const;
const allS = ['plain', 'slide', 'restart', 'throat', 'okayUm', 'breathIn', 'scoopWobble'] as const;
const octFifth = (idx: number) => [[-12], [12], [7], [-7], [-5], [5], [12, -12], [-12, 7]][idx % 8];

export const CONDS: Record<string, () => [Style, RigOpts]> = {
  base: () => [{ name: 'baseline: clean acoustic, male singer, quiet room, notes ring' }, {}],
  baseNoThump: () => [{ name: 'baseline, no body thump', g: { thump: false } }, {}],
  baseDamp: () => [{ name: 'baseline, damps every note', ring: false }, {}],
  loudG: () => [{ name: 'baseline but guitar louder than voice (guitar -12 dBFS peak, voice -22)', g: { peakDb: -12 }, vPeak: -22 }, {}],
  quietV: () => [{ name: 'baseline, quiet singer (-30 dBFS peak), guitar -20', vPeak: -30 }, {}],
  loudV: () => [{ name: 'baseline, loud singer (-10 dBFS peak), guitar -24', vPeak: -10, g: { peakDb: -24 } }, {}],
  base441: () => [{ name: 'baseline at 44.1 kHz' }, { sr: 44100 }],
  female: () => [{ name: 'female singer (octave up), clean acoustic', female: true }, {}],
  electric: () => [{ name: 'unplugged electric (-34 dBFS peak, weak lows)', g: { body: 'electric', peakDb: -34 } }, {}],
  detune10: () => [{ name: 'guitar strings detuned [+10,-10,+10,-10,+10,-10] c', stringCents: [10, -10, 10, -10, 10, -10] }, {}],
  detune20: () => [{ name: 'guitar strings detuned [-20,+20,-20,+20,-20,+20] c', stringCents: [-20, 20, -20, 20, -20, 20] }, {}],
  detune20s: () => [{ name: 'guitar all strings +20 c, hard picking', stringCents: [20, 20, 20, 20, 20, 20], g: { hard: 1, peakDb: -10 } }, {}],
  detune30: () => [{ name: 'guitar all strings +30 c', stringCents: [30, 30, 30, 30, 30, 30] }, {}],
  detune35: () => [{ name: 'guitar strings [+35,-35,+35,-35,+35,-35] c', stringCents: [35, -35, 35, -35, 35, -35] }, {}],
  detuneM30: () => [{ name: 'guitar all strings -30 c (old strings gone flat)', stringCents: [-30, -30, -30, -30, -30, -30] }, {}],
  gvars: () => [{ name: 'guitar technique mix: squeak, late fret, glide-in, double pluck, adjacent string, buzz, alt string, soft, hard, bright', gVars: [...allG] }, {}],
  svars: () => [{ name: 'singer mix: slide up, restart, throat clear, "okay um", audible breath, wobble', sVars: [...allS] }, {}],
  svarsF: () => [{ name: 'female singer mix (as above)', sVars: [...allS], female: true }, {}],
  sloppy: () => [{ name: 'sloppy singer: intonation sd 30 c, vibrato 40 c, breathy', intonSd: 30, vib: 40, breathy: 0.5 }, {}],
  octDown: () => [{ name: 'singer an octave below comfortable (bass, G1..)', octaveShift: -1 }, {}],
  huntOct: () => [{ name: 'hunting: plucks wrong octave/fifth/fourth first (ringing on), then right note', hunt: (i) => octFifth(i) }, {}],
  huntOctFast: () => [{ name: 'hunting fast (0.35 s gaps): wrong octave/fifth first, ringing', hunt: (i) => octFifth(i), huntGap: 0.35 }, {}],
  huntStep: () => [{ name: 'hunting: neighbouring frets first (+1,-1,+2,-2 st), ringing', hunt: (i) => [[1], [-1], [2, 1], [-2, -1], [1, -1]][i % 5], huntGap: 0.6 }, {}],
  huntDamped: () => [{ name: 'hunting: wrong octave/fifth first, damping each note', hunt: (i) => octFifth(i), ring: false }, {}],
  idleTalk: () => [{ name: 'talks ("okay... um") while hunting, then plucks', idle: 'talk' }, {}],
  idleTalkF: () => [{ name: 'female talks while hunting, then plucks', idle: 'talk', female: true }, {}],
  idleHum: () => [{ name: 'hums the target (own octave) while hunting, then plucks', idle: 'humTarget' }, {}],
  idleHumF: () => [{ name: 'female hums the target while hunting, then plucks', idle: 'humTarget', female: true }, {}],
  idleHumStrict: () => [{ name: 'hums the target while hunting [strict check ON]', idle: 'humTarget' }, { settings: { strictCheck: true } }],
  strict: () => [{ name: 'baseline with strict instrument check ON' }, { settings: { strictCheck: true } }],
  strictVars: () => [{ name: 'technique + singer mix with strict check ON', gVars: [...allG], sVars: [...allS] }, { settings: { strictCheck: true } }],
  fan: () => [{ name: 'fan/fridge noise -42 dBFS' }, { fanDb: -42 }],
  fanQuiet: () => [{ name: 'fan -42 dBFS + soft player (-36 dBFS peak)', g: { peakDb: -36, hard: 0.2 } }, { fanDb: -42 }],
  hum50: () => [{ name: 'mains hum 50 Hz -40 dBFS' }, { humDb: -40, humHz: 50 }],
  hum60loud: () => [{ name: 'mains hum 60 Hz -32 dBFS', }, { humDb: -32, humHz: 60 }],
  talker: () => [{ name: 'another person talking, -38 dBFS rms' }, { bg: bgTalk(48000, -38) }],
  talkerLoud: () => [{ name: 'another person talking, -30 dBFS rms' }, { bg: bgTalk(48000, -30, true) }],
  tv: () => [{ name: 'TV (speech + jingles) -40 dBFS rms' }, { bg: bgTv(48000, -40) }],
  tvLoud: () => [{ name: 'TV (speech + jingles) -32 dBFS rms' }, { bg: bgTv(48000, -32) }],
  bathroom: () => [{ name: 'reverberant room RT60 1.1 s, wet 0.6' }, { reverb: { rt60: 1.1, wet: 0.6 } }],
  agc: () => [{ name: 'phone AGC (6 dB/s up, +24 dB max)' }, { agc: { slew: 6, max: 24 } }],
  agcFast: () => [{ name: 'phone AGC fast (15 dB/s up, +30 dB max) + fan -46', }, { agc: { slew: 15, max: 30 }, fanDb: -46 }],
  gate: () => [{ name: 'noise suppression gating below -45 dBFS by 18 dB' }, { gate: { thDb: -45, attDb: 18 } }],
  gateSoft: () => [{ name: 'noise gate + soft player (-34 dBFS)', g: { peakDb: -34, hard: 0.2 } }, { gate: { thDb: -42, attDb: 18 } }],
  hp200: () => [{ name: 'phone mic high-pass 200 Hz' }, { hpHz: 200 }],
  jitter: () => [{ name: 'irregular timer (20±7 ms, 16% 30-48 ms, 4% stalls 80-250 ms)' }, { timer: 'jitter' }],
  jitterMild: () => [{ name: 'mildly irregular timer (20±4 ms, 9.5% 28-40 ms, 0.5% stalls 80-150 ms)' }, { timer: 'jitterMild' }],
  jitterMildLoudG: () => [{ name: 'mild jitter, guitar louder than voice (control for the sharp-bias effect)', g: { peakDb: -12 }, vPeak: -22 }, { timer: 'jitterMild' }],
  huntStepLoudG: () => [{ name: 'hunting neighbouring frets, guitar louder than voice', hunt: (i) => [[1], [-1], [2, 1], [-2, -1], [1, -1]][i % 5], huntGap: 0.6, g: { peakDb: -12 }, vPeak: -22 }, {}],
  huntStepSlow: () => [{ name: 'hunting neighbouring frets, 1.3 s between plucks', hunt: (i) => [[-1], [1, -1], [-2, -1]][i % 3], huntGap: 1.3 }, {}],
  slow40: () => [{ name: 'timer throttled to 40 ms' }, { timer: 'slow40' }],
  burst20: () => [{ name: 'audio delivered in 21 ms bursts (duplicate/uneven frames)' }, { timer: 'burst20' }],
  burst40: () => [{ name: 'audio delivered in 40 ms bursts' }, { timer: 'burst40' }],
  phoneAll: () => [{ name: 'phone: 44.1 kHz + HP 150 + AGC + gate + jitter timer, technique+singer mix', gVars: [...allG], sVars: [...allS] }, { sr: 44100, hpHz: 150, agc: { slew: 6, max: 20 }, gate: { thDb: -48, attDb: 12 }, timer: 'jitter' }],
  review03: () => [{ name: 'phrase review at 0.3 s/note', reviewIOI: 0.3 }, {}],
  review03LoudG: () => [{ name: 'phrase review at 0.3 s/note, guitar louder than voice', reviewIOI: 0.3, g: { peakDb: -12 }, vPeak: -22 }, {}],
  review06LoudG: () => [{ name: 'phrase review at 0.6 s/note, guitar louder than voice', reviewIOI: 0.6, g: { peakDb: -12 }, vPeak: -22 }, {}],
  review03Damp: () => [{ name: 'phrase review at 0.3 s/note, damped, guitar louder than voice', reviewIOI: 0.3, ring: false, g: { peakDb: -12 }, vPeak: -22 }, {}],
  review045: () => [{ name: 'phrase review at 0.45 s/note', reviewIOI: 0.45 }, {}],
  review1: () => [{ name: 'phrase review at 1.0 s/note, detuned ±15', reviewIOI: 1.0, stringCents: [15, -15, 15, -15, 15, -15] }, {}],
};

const names = process.env.NO_MAIN ? [] : process.argv.slice(2).filter((a) => !a.startsWith('--'));
const maxNotes = Number(process.argv.find((a) => a.startsWith('--max='))?.slice(6) ?? 101);
const verbose = process.argv.includes('--verbose');
const noReview = process.argv.includes('--noreview');
for (const n of names) {
  const t0 = Date.now();
  const [st, ro] = CONDS[n]();
  const keepReview = n.startsWith('review') || n === 'base' || n === 'gvars' || n.startsWith('jitter') || n === 'phoneAll';
  const r = student({ ...st, maxNotes, verbose, noReview: noReview || !keepReview }, ro);
  console.log(`[${n}] ${fmt(r)}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
