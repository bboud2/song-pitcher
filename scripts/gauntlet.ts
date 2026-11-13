// Pitch-engine gauntlet: synthesizes fixtures with two independent synthesis models, runs them
// through the exact front end + detector + matcher the app uses, prints metric tables, runs the
// session simulations, and exits non-zero if any target is missed.
//
//   npm run gauntlet                 (≈5 min)
//   npm run gauntlet -- --only=slide (run groups whose name contains "slide"; skips simulations)
//   npm run gauntlet -- --no-sims    (skip the session simulations)
//   npm run gauntlet -- --verbose    (list failing fixtures)
//
// Groups: "P …" must be accepted (target ≥ 98 %), "N …" must never be accepted (target 0),
// "I …" are informational (no target). Octave-err counts fixtures where the matcher reported a
// pitch an octave/fifth/twelfth away from the truth while the note sounded.
import { analyzeBuffer, guitarConfig, singConfig, type AnalysisPath } from '../src/core/engine.ts';
import { NoteMatcher, type MatchConfig, type PitchFrame } from '../src/core/matcher.ts';
import { noteName } from '../src/core/music.ts';
import { SR, addNoise, concat, mixInto, noise, pluck, rng as rng1, silence as sil1, voice as voice1 } from './fixtures.ts';
import { guitar, highpass, hum, mix, reverb, rms, rng, silence, voice, whiteNoise, type GuitarOpts, type VoiceOpts } from './fixtures2.ts';
import { printSims, runAllSims } from './sessionsim.ts';

const verbose = process.argv.includes('--verbose');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const noSims = process.argv.includes('--no-sims') || !!only;
const ONSET = 0.3;
const FLOOR = 0.0018; // ≈ -55 dBFS room noise under the additive-model fixtures
const GUITAR = Array.from({ length: 37 }, (_, i) => 40 + i); // E2..E5
const SONG_C = [48, 50, 52, 54, 55, 57, 59, 60, 62, 64, 65, 67]; // song notes in C (C3..G4)

type Kind = 'P' | 'N' | 'I';
interface Stats {
  kind: Kind;
  n: number;
  acc: number;
  tta: number[];
  oct: number;
  fails: string[];
}
const groups = new Map<string, Stats>();
const t0 = Date.now();

function framesOf(x: Float32Array, path: AnalysisPath, sr = SR): PitchFrame[] {
  const out: PitchFrame[] = [];
  analyzeBuffer(x, sr, (f) => {
    out.push(f);
  }, path);
  return out;
}

function runCfg(fr: PitchFrame[], cfg: MatchConfig, from = 0): { at: number | null; octErr: boolean; truthOk: boolean } {
  const m = new NoteMatcher(cfg);
  for (const f of fr) {
    if (f.t < from) continue;
    const s = m.push(f);
    if (s.accepted) return { at: s.acceptedAt, octErr: false, truthOk: true };
  }
  return { at: null, octErr: false, truthOk: true };
}

/** Octave scan: run a never-accepting matcher and look at the pitch it reports while the note sounds. */
function octaveScan(fr: PitchFrame[], cfg: MatchConfig, truth: number, from: number, to: number, alsoTrue: number[] = []): boolean {
  const m = new NoteMatcher({ ...cfg, holdMs: 1e9, neverAccept: true });
  let errs = 0;
  for (const f of fr) {
    const s = m.push(f);
    if (f.t < from || f.t > to || !s.stable || s.detectedMidi === null) continue;
    if (alsoTrue.some((m) => Math.abs(s.detectedMidi! - m) < 0.5)) continue; // another note really is sounding
    const d = Math.abs(s.detectedMidi - truth);
    if ([7, 12, 19, 24].some((iv) => Math.abs(d - iv) < 0.5)) errs++;
  }
  return errs >= 3; // three or more frames (60 ms) misread
}

function want(name: string): boolean {
  return !only || name.includes(only);
}

function record(group: string, kind: Kind, label: string, fr: PitchFrame[], cfg: MatchConfig, onset: number, truth: number | null, listenFrom = 0, scanTo = onset + 1.0, alsoTrue: number[] = []) {
  let g = groups.get(group);
  if (!g) groups.set(group, (g = { kind, n: 0, acc: 0, tta: [], oct: 0, fails: [] }));
  g.n++;
  const { at } = runCfg(fr, cfg, listenFrom);
  if (at !== null) {
    g.acc++;
    g.tta.push((at - onset) * 1000);
    if (kind === 'N') g.fails.push(`${label} (accepted @ ${((at - onset) * 1000).toFixed(0)} ms)`);
    if (kind === 'P' && at < onset) g.fails.push(`${label} (accepted BEFORE onset)`);
  } else if (kind === 'P') g.fails.push(label);
  if (truth !== null && kind !== 'N' && octaveScan(fr, cfg, truth, onset + 0.05, scanTo, alsoTrue)) {
    g.oct++;
    g.fails.push(`${label} (octave misread)`);
  }
}

const floorBase = (sr: number, dur: number, seed: number, lvl = FLOOR) => whiteNoise(silence(dur, sr), lvl, seed);

// ======================================================================= GUITAR STEP (plucked)
function guitarGroup(name: string, kind: Kind, mk: (m: number, sr: number) => { x: Float32Array; target?: number; onset?: number; listenFrom?: number; alsoTrue?: number[] } | null, opts: { sr?: number; notes?: number[] } = {}) {
  const full = `guitar ${name}`;
  if (!want(full)) return;
  const sr = opts.sr ?? SR;
  for (const m of opts.notes ?? GUITAR) {
    const r = mk(m, sr);
    if (!r) continue;
    const target = r.target ?? m;
    const on = r.onset ?? ONSET;
    record(full, kind, `${noteName(m)}→${noteName(target)}`, framesOf(r.x, 'guitar', sr), guitarConfig(target), on, kind === 'N' ? null : m, r.listenFrom ?? 0, on + 1.0, r.alsoTrue ?? []);
  }
}

const ks = (m: number, o: Parameters<typeof pluck>[2] = {}, lead = ONSET) => concat(sil1(lead), pluck(m, 1.6, o), sil1(0.2));
const add = (m: number, sr: number, o: Partial<GuitarOpts> = {}, dur = 2.0) => mix(floorBase(sr, dur + 0.4, m), guitar(m, dur, { sr, seed: m + 3, ...o }), ONSET, sr);

// --- positives, model 1 (Karplus-Strong)
guitarGroup('P ks clean', 'P', (m) => ({ x: ks(m) }));
guitarGroup('P ks +noise 20dB', 'P', (m) => ({ x: addNoise(ks(m), 20, 1000 + m, Math.floor(ONSET * SR), Math.floor((ONSET + 1) * SR)) }));
guitarGroup('P ks detuned ±22c', 'P', (m) => ({ x: addNoise(ks(m, { cents: m % 2 ? 22 : -22 }), 30, 3000 + m) }));
guitarGroup('P ks quiet -36dBFS peak', 'P', (m) => ({ x: addNoise(ks(m, { amp: 0.016, seed: m + 5 }), 25, 4000 + m, Math.floor(ONSET * SR), Math.floor((ONSET + 1) * SR)) }));
guitarGroup('P ks dull tone', 'P', (m) => ({ x: ks(m, { brightness: 0.25, pickPos: 0.45, seed: m + 9 }) }));
// --- positives, model 2 (additive, inharmonic)
guitarGroup('P add normal', 'P', (m, sr) => ({ x: add(m, sr) }));
guitarGroup('P add normal 44.1k', 'P', (m, sr) => ({ x: add(m, sr) }), { sr: 44100 });
guitarGroup('P add weak fundamental (h1 -22dB)', 'P', (m, sr) => ({ x: add(m, sr, { profile: 'weakfund' }) }));
guitarGroup('P add weak fundamental 44.1k', 'P', (m, sr) => ({ x: add(m, sr, { profile: 'weakfund' }) }), { sr: 44100 });
guitarGroup('P add missing fundamental', 'P', (m, sr) => ({ x: add(m, sr, { profile: 'nofund' }) }));
guitarGroup('P add bright', 'P', (m, sr) => ({ x: add(m, sr, { profile: 'bright' }) }));
guitarGroup('P add sharp +30c settling 80ms', 'P', (m, sr) => ({ x: add(m, sr, { glideCents: 30 }) }));
guitarGroup('P add sharp +60c settling 150ms', 'P', (m, sr) => ({ x: add(m, sr, { glideCents: 60, glideTau: 0.15 }) }));
guitarGroup('P add fret buzz', 'P', (m, sr) => ({ x: add(m, sr, { buzz: 0.6 }) }));
guitarGroup('P add phone HPF 180Hz', 'P', (m, sr) => ({ x: highpass(add(m, sr), sr, 180) }));
guitarGroup('P add HPF 180Hz + weak fundamental', 'P', (m, sr) => ({ x: highpass(add(m, sr, { profile: 'weakfund' }), sr, 180) }));
guitarGroup('P add room reverb RT60 0.6s', 'P', (m, sr) => ({ x: reverb(add(m, sr), sr, 0.6, 0.6) }));
guitarGroup('P add slide in from -2 st over 400ms', 'P', (m, sr) => ({ x: add(m, sr, { slideFromSemis: -2, slideSec: 0.4 }) }));
guitarGroup('P add detuned +35c', 'P', (m, sr) => ({ x: add(m, sr, { cents: 35 }) }));
guitarGroup('I add quiet -40dBFS peak (body SNR ≈4 dB)', 'I', (m, sr) => ({ x: add(m, sr, { amp: 0.01 }) }));
guitarGroup('P add combo weakfund+glide+HPF180+reverb', 'P', (m, sr) => ({ x: reverb(highpass(add(m, sr, { profile: 'weakfund', glideCents: 30 }), sr, 180), sr, 0.5, 0.5) }));
guitarGroup('P add + 60Hz hum -35dBFS', 'P', (m, sr) => ({ x: hum(add(m, sr), sr, 60, 0.0178) }));
guitarGroup('I add quiet -34dBFS + 60Hz hum -40dBFS (SNR<0 dB)', 'I', (m, sr) => ({ x: hum(add(m, sr, { amp: 0.02 }), sr, 60, 0.01) }));
for (const iv of [3, -4, 7, -7, 5, -5, 12, -12]) {
  guitarGroup(`P over ringing previous note ${iv > 0 ? '+' : ''}${iv} st`, 'P', (m, sr) => {
    const prev = m + iv;
    if (prev < 40 || prev > 76) return null;
    const x = floorBase(sr, 3.1, m);
    mix(x, guitar(prev, 2.8, { sr, seed: m }), ONSET, sr);
    mix(x, guitar(m, 2.0, { sr, seed: m + 9 }), ONSET + 0.8, sr);
    return { x, onset: ONSET + 0.8, listenFrom: ONSET + 0.7, alsoTrue: [prev] };
  });
}
// Re-plucking the LOWER octave while it still rings must not pass a target an octave up.
guitarGroup('N re-pluck the octave below while it rings (target +12)', 'N', (m, sr) => {
  if (m + 12 > 76) return null;
  const x = floorBase(sr, 3.1, m);
  mix(x, guitar(m, 2.8, { sr, seed: m }), ONSET, sr);
  mix(x, guitar(m, 2.0, { sr, seed: m + 9 }), ONSET + 0.8, sr);
  return { x, target: m + 12, onset: ONSET + 0.8, listenFrom: ONSET + 0.7 };
});
guitarGroup('N KS re-pluck the octave below while it rings (target +12)', 'N', (m) => {
  if (m + 12 > 76) return null;
  const x = concat(sil1(ONSET), pluck(m, 2.8, { seed: m }), sil1(0.2));
  mixInto(x, pluck(m, 2.0, { seed: m + 9, pickPos: 0.3 }), Math.floor((ONSET + 0.8) * SR));
  return { x, target: m + 12, onset: ONSET + 0.8, listenFrom: ONSET + 0.7 };
});
for (const snr of [20, 15, 12, 9]) {
  guitarGroup(`${snr >= 12 ? 'P' : 'I'} add SNR ${snr}dB (vs first 300 ms)`, snr >= 12 ? 'P' : 'I', (m, sr) => {
    if (m % 2) return null;
    const g = guitar(m, 2.0, { sr, seed: m });
    const x = mix(silence(2.6, sr), g, ONSET, sr);
    return { x: whiteNoise(x, rms(g, 0, Math.floor(0.3 * sr)) / Math.pow(10, snr / 20), m) };
  });
}
// --- negatives
guitarGroup('N ks semitone off (both sides)', 'N', (m) => (m < 76 ? { x: ks(m), target: m + 1 } : { x: ks(m), target: m - 1 }));
guitarGroup('N ks wrong octave', 'N', (m) => ({ x: ks(m), target: m + 12 <= 76 ? m + 12 : m - 12 }));
guitarGroup('N add wrong octave (target an octave up)', 'N', (m, sr) => (m + 12 <= 76 ? { x: add(m, sr), target: m + 12 } : null));
guitarGroup('N add wrong octave (target an octave down)', 'N', (m, sr) => (m - 12 >= 40 ? { x: add(m, sr), target: m - 12 } : null));
guitarGroup('N add weakfund wrong octave (target up)', 'N', (m, sr) => (m + 12 <= 76 ? { x: add(m, sr, { profile: 'weakfund' }), target: m + 12 } : null));
guitarGroup('N add detuned +55c', 'N', (m, sr) => ({ x: add(m, sr, { cents: 55 }) }));
guitarGroup('N slide through target 2 st/s, never stops', 'N', (m, sr) => ({ x: add(m, sr, { f0fn: (t) => -2 + 2 * t, t60: 6 }) }));
guitarGroup('N slide through target 4 st/s', 'N', (m, sr) => ({ x: add(m, sr, { f0fn: (t) => -3 + 4 * t, t60: 6 }) }));
guitarGroup('N slide through target 8 st/s', 'N', (m, sr) => ({ x: add(m, sr, { f0fn: (t) => -6 + 8 * t, t60: 6 }) }));
guitarGroup('N slide-in passes the fret below (target -1)', 'N', (m, sr) => (m > 40 ? { x: add(m, sr, { slideFromSemis: -2, slideSec: 0.4 }), target: m - 1 } : null));
// a SUNG note in the guitar's exact octave must not pass the guitar step
const VOWELS = ['a', 'i', 'u', 'o', 'hum'] as const;
for (const vib of [0, 15, 50]) {
  guitarGroup(`N sung note (vib ±${vib}c) in the exact octave`, 'N', (m, sr) => {
    if (m > 69 || m % 2) return null;
    return { x: mix(floorBase(sr, 2.1, m), voice(m, 1.5, { sr, seed: m, vowel: VOWELS[m % 5], vibCents: vib }), ONSET, sr) };
  });
}
guitarGroup('N sung note, sharp "ta" attack (5 ms), straight tone', 'N', (m, sr) => {
  if (m > 69 || m % 2 === 0) return null;
  return { x: mix(floorBase(sr, 2.1, m), voice(m, 1.5, { sr, seed: m, vowel: 'a', vibCents: 0, attack: 0.005 }), ONSET, sr) };
});
guitarGroup('N sung note, model-1 voice (scoop + vibrato)', 'N', (m) => (m > 69 ? null : { x: concat(sil1(ONSET), voice1(m, 1.5), sil1(0.2)) }));

// hum / noise / silence against every target
function staticNegatives(name: string, x: Float32Array, path: AnalysisPath, mkCfg: (t: number) => MatchConfig, targets: number[]) {
  const full = `${path === 'guitar' ? 'guitar' : 'voice'} ${name}`;
  if (!want(full)) return;
  const fr = framesOf(x, path);
  for (const t of targets) record(full, 'N', noteName(t), fr, mkCfg(t), 0, null);
}
staticNegatives('N silence', silence(3, SR), 'guitar', guitarConfig, GUITAR);
staticNegatives('N white noise -30dBFS', noise(3, 0.03, 9), 'guitar', guitarConfig, GUITAR);
staticNegatives('N 60Hz hum only -40dBFS', hum(floorBase(SR, 4, 3), SR, 60, 0.01), 'guitar', guitarConfig, GUITAR);
staticNegatives('N 120Hz-dominant hum -40dBFS', hum(floorBase(SR, 4, 3), SR, 60, 0.01, [0.3, 1, 0.3, 0.2]), 'guitar', guitarConfig, GUITAR);
staticNegatives('N 100Hz-dominant hum (50Hz mains)', hum(floorBase(SR, 4, 3), SR, 50, 0.01, [0.3, 1, 0.3, 0.2]), 'guitar', guitarConfig, GUITAR);

// ======================================================================= SINGING STEP (sung)
function voiceGroup(name: string, kind: Kind, mk: (t: number, sung: number, sr: number) => { x: Float32Array; onset?: number } | null, opts: { tol?: number; exact?: boolean; octaves?: number[]; targets?: number[]; sr?: number } = {}) {
  const full = `voice ${name}`;
  if (!want(full)) return;
  const sr = opts.sr ?? SR;
  for (const oc of opts.octaves ?? [0, 12]) {
    for (const t of opts.targets ?? SONG_C) {
      const sung = t + oc;
      const r = mk(t, sung, sr);
      if (!r) continue;
      record(full, kind, `${noteName(sung)}→${noteName(t)}`, framesOf(r.x, 'voice', sr), singConfig(t, opts.tol ?? 50, opts.exact ?? false), r.onset ?? ONSET, kind === 'N' ? null : sung, 0, (r.onset ?? ONSET) + 1.5);
    }
  }
}
const sv = (sung: number, sr: number, o: Partial<VoiceOpts> & { dur?: number; floor?: number } = {}) =>
  mix(floorBase(sr, (o.dur ?? 2.5) + 0.6, sung, o.floor), voice(sung, o.dur ?? 2.5, { sr, seed: sung, ...o }), ONSET, sr);

// model 1 voices over E2–A4 (low and high voices), clean and noisy
const LOWHIGH = Array.from({ length: 30 }, (_, i) => 40 + i);
const v1x = (m: number, noisy: boolean) => {
  const x = concat(sil1(ONSET), voice1(m, 2.0, { vowel: (['ah', 'ee', 'oo', 'eh'] as const)[m % 4] }), sil1(0.2));
  return noisy ? addNoise(x, 20, 2000 + m, Math.floor(ONSET * SR), Math.floor((ONSET + 2) * SR)) : x;
};
voiceGroup('P model-1 voice E2–A4 clean', 'P', (t) => ({ x: v1x(t, false) }), { targets: LOWHIGH, octaves: [0] });
voiceGroup('P model-1 voice E2–A4 +noise 20dB', 'P', (t) => ({ x: v1x(t, true) }), { targets: LOWHIGH, octaves: [0] });
voiceGroup('P model-1 voice strict ±25', 'P', (t) => ({ x: v1x(t, t % 2 === 0) }), { targets: LOWHIGH, octaves: [0], tol: 25 });
voiceGroup('P model-1 voice exact-octave on', 'P', (t) => ({ x: v1x(t, false) }), { targets: LOWHIGH, octaves: [0], exact: true });
for (const v of ['a', 'i', 'u', 'o'] as const) voiceGroup(`P vowel ${v}`, 'P', (_t, s, sr) => ({ x: sv(s, sr, { vowel: v }) }));
voiceGroup('P vowels 44.1k', 'P', (t, s, sr) => ({ x: sv(s, sr, { vowel: (['a', 'i', 'u', 'o'] as const)[t % 4] }) }), { sr: 44100 });
voiceGroup('P humming (mmm)', 'P', (_t, s, sr) => ({ x: sv(s, sr, { vowel: 'hum' }) }));
voiceGroup('P vibrato ±50c 5.5Hz', 'P', (_t, s, sr) => ({ x: sv(s, sr, { vibCents: 50 }) }));
voiceGroup('P vibrato ±100c 5.5Hz', 'P', (_t, s, sr) => ({ x: sv(s, sr, { vibCents: 100 }) }));
voiceGroup('P vibrato ±100c 4.5Hz', 'P', (_t, s, sr) => ({ x: sv(s, sr, { vibCents: 100, vibRate: 4.5 }) }));
voiceGroup('P vibrato ±150c 6Hz', 'P', (_t, s, sr) => ({ x: sv(s, sr, { vibCents: 150, vibRate: 6 }) }));
voiceGroup('P vibrato ±50c at strict ±25', 'P', (_t, s, sr) => ({ x: sv(s, sr, { vibCents: 50 }) }), { tol: 25 });
voiceGroup('P vibrato ±80c centred +40c', 'P', (_t, s, sr) => ({ x: sv(s, sr, { vibCents: 80, f0fn: () => 0.4 }) }));
voiceGroup('P breathy', 'P', (_t, s, sr) => ({ x: sv(s, sr, { breath: 2.0, vowel: 'u' }) }));
voiceGroup('P quiet -40dBFS, floor -55', 'P', (_t, s, sr) => ({ x: sv(s, sr, { amp: 0.01 }) }));
voiceGroup('P quiet -52dBFS, floor -75', 'P', (_t, s, sr) => ({ x: sv(s, sr, { amp: 0.0025, floor: 0.00018 }) }));
voiceGroup('P breathy + quiet -40, floor -60', 'P', (_t, s, sr) => ({ x: sv(s, sr, { amp: 0.01, breath: 1.5, floor: 0.001 }) }));
voiceGroup('P scoop from -300c over 300ms', 'P', (_t, s, sr) => ({ x: sv(s, sr, { f0fn: (t) => -3 * Math.max(0, 1 - t / 0.3) }) }));
voiceGroup('P +45c sharp (inside ±50)', 'P', (_t, s, sr) => ({ x: sv(s, sr, { f0fn: () => 0.45 }) }));
voiceGroup('P low voice an octave down (C2–G3)', 'P', (_t, s, sr) => ({ x: sv(s, sr) }), { octaves: [-12] });
voiceGroup('P high voice two octaves up (C5–G6)', 'P', (_t, s, sr) => ({ x: sv(s, sr) }), { octaves: [24] });
voiceGroup('P exact-octave on, right octave', 'P', (_t, s, sr) => ({ x: sv(s, sr) }), { exact: true, octaves: [0] });
for (const snr of [20, 12, 6]) {
  voiceGroup(`P SNR ${snr}dB`, 'P', (_t, s, sr) => {
    const v = voice(s, 2.5, { sr, vowel: s % 2 ? 'a' : 'u', vibCents: 20, seed: s });
    const x = mix(silence(3.1, sr), v, ONSET, sr);
    return { x: whiteNoise(x, rms(v) / Math.pow(10, snr / 20), s) };
  }, { octaves: [0] });
}
// negatives
voiceGroup('N semitone sharp', 'N', (_t, s, sr) => ({ x: sv(s + 1, sr) }));
voiceGroup('N +55c sharp', 'N', (_t, s, sr) => ({ x: sv(s, sr, { f0fn: () => 0.55 }) }));
voiceGroup('N +30c at strict ±25', 'N', (_t, s, sr) => ({ x: sv(s, sr, { f0fn: () => 0.3 }) }), { tol: 25 });
voiceGroup('N vibrato ±80c centred +70c', 'N', (_t, s, sr) => ({ x: sv(s, sr, { vibCents: 80, f0fn: () => 0.7 }) }));
for (const rate of [1, 1.5, 2, 4]) {
  voiceGroup(`N glide through target ${rate} st/s, never settles`, 'N', (_t, s, sr) => {
    const dur = Math.min(6, 6 / rate + 0.5);
    return { x: sv(s, sr, { dur, f0fn: (t) => -3 + rate * t }) };
  });
}
voiceGroup('N exact-octave on, sung an octave up', 'N', (t, _s, sr) => ({ x: sv(t + 12, sr) }), { exact: true, octaves: [0] });
voiceGroup('N exact-octave on, sung an octave down', 'N', (t, _s, sr) => ({ x: sv(t - 12, sr) }), { exact: true, octaves: [0] });
voiceGroup('N model-1 voice semitone off', 'N', (t) => ({ x: v1x(t + (t % 2 ? 1 : -1), t % 3 === 0) }), { targets: LOWHIGH, octaves: [0] });
// a PLUCKED note (any octave) must not pass the singing step
voiceGroup('N guitar pluck (additive) in the singing step', 'N', (_t, s, sr) => (s >= 40 && s <= 76 ? { x: add(s, sr) } : null), { octaves: [0, 12, -12] });
voiceGroup('N guitar pluck (KS) in the singing step', 'N', (_t, s) => (s >= 40 && s <= 76 ? { x: ks(s) } : null), { octaves: [0, 12, -12] });
voiceGroup('N repeated plucks every 1.2 s (KS) in the singing step', 'N', (_t, s) => {
  if (s < 40 || s > 76) return null;
  const x = sil1(ONSET + 5);
  for (let k = 0; k < 4; k++) mixInto(x, pluck(s, 1.15, { seed: s + k }), Math.floor((ONSET + 1.2 * k) * SR));
  return { x };
}, { octaves: [0, 12] });
voiceGroup('N repeated plucks every 0.6 s (additive) in the singing step', 'N', (_t, s, sr) => {
  if (s < 40 || s > 76) return null;
  const x = floorBase(sr, ONSET + 4, s);
  for (let k = 0; k < 6; k++) mix(x, guitar(s, 0.8, { sr, seed: s + k }), ONSET + 0.6 * k, sr);
  return { x };
}, { octaves: [0] });
voiceGroup('I tremolo re-plucks every 0.3 s in the singing step (KNOWN GAP: accepted)', 'I', (_t, s, sr) => {
  if (s < 40 || s > 76) return null;
  const x = floorBase(sr, ONSET + 4, s);
  for (let k = 0; k < 12; k++) mix(x, guitar(s, 0.5, { sr, seed: s + k }), ONSET + 0.3 * k, sr);
  return { x };
}, { octaves: [0] });
voiceGroup('N guitar pluck slow decay (t60 6s) in the singing step', 'N', (_t, s, sr) => (s >= 40 && s <= 76 ? { x: add(s, sr, { t60: 6 }) } : null), { octaves: [0] });
// informational: tolerance-edge wobbles
voiceGroup('I wobble +50c ±15c @1.5Hz (edge)', 'I', (_t, s, sr) => ({ x: sv(s, sr, { f0fn: (t) => 0.5 + 0.15 * Math.sin(2 * Math.PI * 1.5 * t) }) }));
voiceGroup('I wobble +40c ±25c @1.5Hz', 'I', (_t, s, sr) => ({ x: sv(s, sr, { f0fn: (t) => 0.4 + 0.25 * Math.sin(2 * Math.PI * 1.5 * t) }) }));
staticNegatives('N silence', silence(3, SR), 'voice', (t) => singConfig(t, 50, false), SONG_C);
staticNegatives('N white noise -30dBFS', noise(3, 0.03, 19), 'voice', (t) => singConfig(t, 50, false), SONG_C);
staticNegatives('N 60Hz hum only -40dBFS', hum(floorBase(SR, 4, 3), SR, 60, 0.01), 'voice', (t) => singConfig(t, 50, false), SONG_C);

// ======================================================================= speech, coughs: false accepts per minute
const fapm: string[] = [];
function speech(dur: number, lo: number, hi: number, seed: number): Float32Array {
  const r = rng(seed);
  const x = floorBase(SR, dur, seed);
  let t = 0.3;
  let m = (lo + hi) / 2;
  const vowels = ['a', 'i', 'u', 'o'] as const;
  while (t < dur - 0.5) {
    const d = 0.09 + r() * 0.22;
    m = Math.max(lo, Math.min(hi, m + (r() * 2 - 1) * 3));
    const g = (r() * 2 - 1) * 2.5;
    const syl = voice(60, d, { sr: SR, seed: Math.floor(r() * 1e6), vowel: vowels[Math.floor(r() * 4)], f0fn: (tt) => m - 60 + (g * tt) / d, amp: 0.15 + 0.2 * r(), attack: 0.02, breath: 0.3 });
    mix(x, syl, t, SR);
    t += d + (r() < 0.25 ? 0.15 + r() * 0.3 : 0.02 + r() * 0.05);
  }
  return x;
}
function coughs(dur: number, seed: number): Float32Array {
  const r = rng(seed);
  const x = floorBase(SR, dur, seed);
  for (let t = 0.4; t < dur - 0.5; t += 0.5 + r() * 0.8) {
    const n = Math.floor((0.12 + r() * 0.15) * SR);
    const at = Math.floor(t * SR);
    let lp = 0, bp1 = 0, bp2 = 0;
    const w = (2 * Math.PI * (300 + r() * 500)) / SR;
    for (let i = 0; i < n; i++) {
      const e = Math.exp(-i / (0.05 * SR)) * Math.min(1, i / 60);
      const nz = r() * 2 - 1;
      lp = 0.5 * lp + 0.5 * nz;
      const y = 2 * 0.985 * Math.cos(w) * bp1 - 0.985 * 0.985 * bp2 + nz * 0.1;
      bp2 = bp1; bp1 = y;
      x[at + i] += 0.4 * e * (0.6 * lp + 0.4 * y);
    }
  }
  return x;
}
if (want('speech')) {
  void rng1;
  for (const [name, mk] of [
    ['male speech 95-180Hz', (s: number) => speech(60, 43, 54, s)],
    ['female speech 170-300Hz', (s: number) => speech(60, 53, 62, s)],
    ['coughs / throat clearing', (s: number) => coughs(60, s)],
  ] as [string, (s: number) => Float32Array][]) {
    let singFA = 0, playFA = 0, singT = 0, playT = 0;
    for (const seed of [11, 22]) {
      const x = mk(seed);
      const fv = framesOf(x, 'voice');
      const fg = framesOf(x, 'guitar');
      for (let pc = 0; pc < 12; pc++) {
        singT++;
        let m = new NoteMatcher(singConfig(48 + pc, 50, false));
        for (const f of fv) if (m.push(f).accepted) { singFA++; m = new NoteMatcher(singConfig(48 + pc, 50, false)); }
      }
      for (const t of [43, 45, 47, 48, 50, 52, 53, 54, 55, 57, 59, 60, 62, 64, 65, 67]) {
        playT++;
        let m = new NoteMatcher(guitarConfig(t));
        for (const f of fg) if (m.push(f).accepted) { playFA++; m = new NoteMatcher(guitarConfig(t)); }
      }
    }
    fapm.push(`${name.padEnd(26)} sing step ${(singFA / singT).toFixed(2)} /min/target (${singFA} in ${singT} target-min)   guitar step ${(playFA / playT).toFixed(2)} /min/target (${playFA} in ${playT} target-min)`);
  }
}

// ======================================================================= report
const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
};
const ms = (v: number) => (Number.isFinite(v) ? v.toFixed(0) : '-');
const problems: string[] = [];
const head = ['group', 'n', 'accept', 'false-acc', 'oct-err', 'tta med', 'p90', 'max'];
const rows: string[][] = [];
const guitarPosTimes: number[] = [];
for (const [name, g] of groups) {
  const pct = `${((100 * g.acc) / g.n).toFixed(1)}%`;
  rows.push([
    name, String(g.n),
    g.kind === 'N' ? '-' : pct,
    g.kind === 'N' ? `${g.acc}/${g.n}` : '-',
    g.kind === 'N' ? '-' : `${g.oct}/${g.n}`,
    g.kind === 'N' ? '-' : ms(q(g.tta, 0.5)), g.kind === 'N' ? '-' : ms(q(g.tta, 0.9)), g.kind === 'N' ? '-' : ms(Math.max(...g.tta)),
  ]);
  if (g.kind === 'P' && g.acc / g.n < 0.98) problems.push(`${name}: accept ${pct} < 98%`);
  if (g.kind === 'N' && g.acc > 0) problems.push(`${name}: ${g.acc} false accepts`);
  if (g.kind !== 'N' && g.oct > 0) problems.push(`${name}: ${g.oct} fixtures with octave misreads`);
  if (g.kind === 'P' && name.startsWith('guitar') && !name.includes('over ringing') && !name.includes('slide in') && !name.includes('+60c')) guitarPosTimes.push(...g.tta);
  if ((verbose || g.kind !== 'I') && g.fails.length && (verbose || problems.some((p) => p.startsWith(name)))) {
    problems.push(`   ${name}: ${g.fails.slice(0, 10).join(', ')}${g.fails.length > 10 ? ` … (+${g.fails.length - 10})` : ''}`);
  }
}
const gMed = q(guitarPosTimes, 0.5);
rows.push(['guitar: all plain-pluck positives, time-to-accept', String(guitarPosTimes.length), '', '', '', ms(gMed), ms(q(guitarPosTimes, 0.9)), ms(Math.max(...guitarPosTimes))]);
if (gMed > 400) problems.push(`guitar median time-to-accept ${ms(gMed)} ms > 400 ms`);

const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (c: string[]) => c.map((x, i) => (i === 0 ? x.padEnd(w[i]) : x.padStart(w[i]))).join('  ');
console.log(`\nPitch-engine gauntlet — ${[...groups.values()].reduce((a, g) => a + g.n, 0)} fixture runs (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
console.log('P = must accept (≥98%), N = must never accept, I = informational. tta = ms after note onset.\n');
console.log(line(head));
console.log(w.map((n) => '-'.repeat(n)).join('  '));
for (const r of rows) console.log(line(r));
if (fapm.length) {
  console.log('\nFalse accepts from speech / coughs (continuous 60 s recordings, every target):');
  for (const f of fapm) console.log('  ' + f);
}

if (!noSims) {
  console.log('\nSession simulations (real Session + front end; voice-only / guitar-only must pass 0 cross-steps):\n');
  const { rows: simRows, problems: simProblems } = runAllSims();
  printSims(simRows);
  problems.push(...simProblems);
}

const failed = problems.some((p) => !p.startsWith('   '));
if (problems.length) {
  console.log('\nTargets missed:');
  for (const p of problems) console.log('  ' + p);
}
console.log(`\nGAUNTLET: ${failed ? 'FAIL' : 'PASS'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
process.exit(failed ? 1 : 0);
