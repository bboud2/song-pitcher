// Gauntlet case definitions. Every case is a job that returns one or more result groups:
//   P  must be accepted (≥ 98 % of fixtures)
//   N  must never be accepted (0)
//   I  informational (no target; documented trade-offs and deliberate-gaming cases)
//   S  a simulated student session with explicit expectations (ok / not ok)
// Three independent synthesis models are used: fixtures.ts (Karplus-Strong + formant voice),
// fixtures2.ts (additive strings + formant voices) and fixtures3.ts (two-polarisation strings,
// source-filter voices, rooms, phone processing), plus the review's ported conditions.
import { StreamAnalyzer, guitarConfig, singConfig, HOP_MS, FRAME_SIZE, type AnalysisPath } from '../src/core/engine.ts';
import { NoteMatcher, type MatchConfig, type PitchFrame } from '../src/core/matcher.ts';
import { noteName } from '../src/core/music.ts';
import { SR, addNoise, concat, mixInto, noise, pluck, silence as sil1, voice as voice1 } from './fixtures.ts';
import { guitar, highpass, hum, mix, reverb, rms, rng, silence, voice, whiteNoise, type GuitarOpts, type VoiceOpts } from './fixtures2.ts';
import * as S3 from './fixtures3.ts';
import { G as G2, V as V2, gbase, pre as PRE2, wrap as wrap2, type Fx } from './cases-critic2.ts';
import { guitarOnly, guitarOnlyRepeated, honest, setSimSettings, voiceOnly, type SimRow } from './sessionsim.ts';
import { student, type Style } from './students.ts';
import type { RigOpts } from './students.ts';
import { CONDS as C3CONDS } from './critic3/run.ts';
import { student as c3student, type Res as C3Res } from './critic3/student.ts';
import { BIAS_NOTES, biasTable, sessionSnapshots } from './bias.ts';
import { CASES as C4CASES } from './critic4/cases.ts';
import { student as c4student, type Res as C4Res } from './critic4/rig4.ts';
import { STY as C5STY } from './critic5/cases5.ts';
import { honest as c5honest, type Res as C5Res } from './critic5/rig5.ts';
import { pluckRoom, ROOMS5, STYLES5 } from './critic5/pluckroom5.ts';
import { BQ, makeRoom, reverb as reverb5, type Room as Room5 } from './critic5/synth5.ts';
import { wg as wg4, voice as voice4 } from './critic4/synth4.ts';
import { gtr as gtr3 } from './critic3/synth.ts';

export type Kind = 'P' | 'N' | 'I' | 'S';
export interface GroupResult {
  name: string;
  kind: Kind;
  n: number;
  acc: number;
  tta: number[];
  oct: number;
  fails: string[];
  /** S rows: whether expectations were met, and a one-line summary */
  ok?: boolean;
  summary?: string;
  /** sort key (definition order) */
  order?: number;
}
export interface Job {
  name: string;
  /** included in --quick */
  quick: boolean;
  /** rough cost, for balancing shards */
  cost: number;
  run: (quick: boolean) => GroupResult[] | Promise<GroupResult[]>;
}

const ONSET = 0.3;
const FLOOR = 0.0018;
const GUITAR = Array.from({ length: 37 }, (_, i) => 40 + i);
const SONG_C = [48, 50, 52, 54, 55, 57, 59, 60, 62, 64, 65, 67];
const pickNotes = <T>(xs: T[], quick: boolean, every = 4): T[] => (quick ? xs.filter((_, i) => i % every === 0) : xs);

export function framesOf(x: Float32Array, path: AnalysisPath, sr = SR, jitter?: () => number): PitchFrame[] {
  const sa = new StreamAnalyzer(sr);
  const out: PitchFrame[] = [];
  let pos = 0;
  for (;;) {
    const hop = Math.round(((jitter ? jitter() : HOP_MS) / 1000) * sr);
    if (pos + hop > x.length) break;
    sa.push(x.subarray(pos, pos + hop));
    pos += hop;
    if (pos < FRAME_SIZE) continue;
    out.push(sa.frame(path, pos / sr));
  }
  return out;
}

function runCfg(fr: PitchFrame[], cfg: MatchConfig, from = 0): number | null {
  const m = new NoteMatcher(cfg);
  for (const f of fr) {
    if (f.t < from) continue;
    const s = m.push(f);
    if (s.accepted) return s.acceptedAt;
  }
  return null;
}

function octaveScan(fr: PitchFrame[], cfg: MatchConfig, truth: number, from: number, to: number, alsoTrue: number[] = []): boolean {
  const m = new NoteMatcher({ ...cfg, holdMs: 1e9, neverAccept: true });
  let errs = 0;
  for (const f of fr) {
    const s = m.push(f);
    if (f.t < from || f.t > to || !s.stable || s.detectedMidi === null) continue;
    if (alsoTrue.some((x) => Math.abs(s.detectedMidi! - x) < 0.5)) continue;
    const d = Math.abs(s.detectedMidi - truth);
    if ([7, 12, 19, 24].some((iv) => Math.abs(d - iv) < 0.5)) errs++;
  }
  return errs >= 3;
}

class Group {
  r: GroupResult;
  constructor(name: string, kind: Kind) {
    this.r = { name, kind, n: 0, acc: 0, tta: [], oct: 0, fails: [] };
  }
  add(label: string, at: number | null, onset: number, octErr = false): void {
    const r = this.r;
    r.n++;
    if (at !== null) {
      r.acc++;
      r.tta.push((at - onset) * 1000);
      if (r.kind === 'N') r.fails.push(`${label} (accepted @ ${((at - onset) * 1000).toFixed(0)} ms)`);
      if (r.kind === 'P' && at < onset - 0.01) r.fails.push(`${label} (accepted BEFORE onset)`);
    } else if (r.kind === 'P') r.fails.push(label);
    if (octErr) {
      r.oct++;
      r.fails.push(`${label} (octave misread)`);
    }
  }
}

const jobs: Job[] = [];
function job(name: string, cost: number, quick: boolean, run: (quick: boolean) => GroupResult[] | Promise<GroupResult[]>): void {
  jobs.push({ name, cost, quick, run });
}

const floorBase = (sr: number, dur: number, seed: number, lvl = FLOOR) => whiteNoise(silence(dur, sr), lvl, seed);
const ks = (m: number, o: Parameters<typeof pluck>[2] = {}, lead = ONSET) => concat(sil1(lead), pluck(m, 1.6, o), sil1(0.2));
const add = (m: number, sr: number, o: Partial<GuitarOpts> = {}, dur = 2.0) => mix(floorBase(sr, dur + 0.4, m), guitar(m, dur, { sr, seed: m + 3, ...o }), ONSET, sr);

// ========================================================================== guitar step, models 1+2
type GuitarMk = (m: number, sr: number) => { x: Float32Array; target?: number; onset?: number; listenFrom?: number; alsoTrue?: number[] } | null;
function guitarGroup(name: string, kind: Kind, mk: GuitarMk, opts: { sr?: number; notes?: number[]; strict?: boolean; quick?: boolean } = {}) {
  const full = `guitar ${name}`;
  job(full, 1, opts.quick ?? true, (quick) => {
    const g = new Group(full, kind);
    const sr = opts.sr ?? SR;
    for (const m of pickNotes(opts.notes ?? GUITAR, quick)) {
      const r = mk(m, sr);
      if (!r) continue;
      const target = r.target ?? m;
      const cfg = guitarConfig(target, opts.strict ?? false);
      const fr = framesOf(r.x, 'guitar', sr);
      const on = r.onset ?? ONSET;
      const at = runCfg(fr, cfg, r.listenFrom ?? 0);
      const oe = kind === 'P' && octaveScan(fr, cfg, m, on + 0.05, on + 1.0, r.alsoTrue ?? []);
      g.add(`${noteName(m)}→${noteName(target)}`, at, on, oe);
    }
    return [g.r];
  });
}

guitarGroup('P ks clean', 'P', (m) => ({ x: ks(m) }));
guitarGroup('P ks +noise 20dB', 'P', (m) => ({ x: addNoise(ks(m), 20, 1000 + m, Math.floor(ONSET * SR), Math.floor((ONSET + 1) * SR)) }));
guitarGroup('P ks detuned ±22c', 'P', (m) => ({ x: addNoise(ks(m, { cents: m % 2 ? 22 : -22 }), 30, 3000 + m) }));
guitarGroup('P ks quiet -36dBFS peak', 'P', (m) => ({ x: addNoise(ks(m, { amp: 0.016, seed: m + 5 }), 25, 4000 + m, Math.floor(ONSET * SR), Math.floor((ONSET + 1) * SR)) }));
guitarGroup('P ks dull tone', 'P', (m) => ({ x: ks(m, { brightness: 0.25, pickPos: 0.45, seed: m + 9 }) }));
guitarGroup('P add normal', 'P', (m, sr) => ({ x: add(m, sr) }));
guitarGroup('P add normal 44.1k', 'P', (m, sr) => ({ x: add(m, sr) }), { sr: 44100, quick: false });
guitarGroup('P add weak fundamental (h1 -22dB)', 'P', (m, sr) => ({ x: add(m, sr, { profile: 'weakfund' }) }));
guitarGroup('P add missing fundamental', 'P', (m, sr) => ({ x: add(m, sr, { profile: 'nofund' }) }), { quick: false });
guitarGroup('P add bright', 'P', (m, sr) => ({ x: add(m, sr, { profile: 'bright' }) }), { quick: false });
guitarGroup('P add sharp +30c settling 80ms', 'P', (m, sr) => ({ x: add(m, sr, { glideCents: 30 }) }), { quick: false });
guitarGroup('P add sharp +60c settling 150ms', 'P', (m, sr) => ({ x: add(m, sr, { glideCents: 60, glideTau: 0.15 }) }));
guitarGroup('P add fret buzz', 'P', (m, sr) => ({ x: add(m, sr, { buzz: 0.6 }) }), { quick: false });
guitarGroup('P add phone HPF 180Hz + weak fundamental', 'P', (m, sr) => ({ x: highpass(add(m, sr, { profile: 'weakfund' }), sr, 180) }), { quick: false });
guitarGroup('P add room reverb RT60 0.6s', 'P', (m, sr) => ({ x: reverb(add(m, sr), sr, 0.6, 0.6) }), { quick: false });
guitarGroup('P add slide in from -2 st over 400ms', 'P', (m, sr) => ({ x: add(m, sr, { slideFromSemis: -2, slideSec: 0.4 }) }), { quick: false });
guitarGroup('P add detuned +35c', 'P', (m, sr) => ({ x: add(m, sr, { cents: 35 }) }), { quick: false });
guitarGroup('P add quiet -40dBFS peak (body SNR ≈4 dB)', 'P', (m, sr) => ({ x: add(m, sr, { amp: 0.01 }) }), { quick: false });
guitarGroup('P add combo weakfund+glide+HPF180+reverb', 'P', (m, sr) => ({ x: reverb(highpass(add(m, sr, { profile: 'weakfund', glideCents: 30 }), sr, 180), sr, 0.5, 0.5) }), { quick: false });
guitarGroup('P add + 60Hz hum -35dBFS', 'P', (m, sr) => ({ x: hum(add(m, sr), sr, 60, 0.0178) }));
guitarGroup('P add quiet -34dBFS + 60Hz hum -40dBFS', 'P', (m, sr) => ({ x: hum(add(m, sr, { amp: 0.02 }), sr, 60, 0.01) }));
for (const iv of [3, -4, 7, -7, 12, -12]) {
  guitarGroup(`P over ringing previous note ${iv > 0 ? '+' : ''}${iv} st`, 'P', (m, sr) => {
    const prev = m + iv;
    if (prev < 40 || prev > 76) return null;
    const x = floorBase(sr, 3.1, m);
    mix(x, guitar(prev, 2.8, { sr, seed: m }), ONSET, sr);
    mix(x, guitar(m, 2.0, { sr, seed: m + 9 }), ONSET + 0.8, sr);
    return { x, onset: ONSET + 0.8, listenFrom: ONSET + 0.7, alsoTrue: [prev] };
  }, { quick: Math.abs(iv) === 12 });
}
guitarGroup('N re-pluck the octave below while it rings (target +12)', 'N', (m, sr) => {
  if (m + 12 > 76) return null;
  const x = floorBase(sr, 3.1, m);
  mix(x, guitar(m, 2.8, { sr, seed: m }), ONSET, sr);
  mix(x, guitar(m, 2.0, { sr, seed: m + 9 }), ONSET + 0.8, sr);
  return { x, target: m + 12, onset: ONSET + 0.8, listenFrom: ONSET + 0.7 };
});
guitarGroup('N target ringing, then the octave ABOVE plucked', 'N', (m, sr) => {
  if (m + 12 > 76) return null;
  const x = floorBase(sr, 3.1, m);
  mix(x, guitar(m, 2.8, { sr, seed: m }), ONSET, sr);
  mix(x, guitar(m + 12, 2.0, { sr, seed: m + 9 }), ONSET + 0.8, sr);
  return { x, target: m, onset: ONSET + 0.8, listenFrom: ONSET + 0.7 };
});
for (const snr of [20, 15, 12, 9]) {
  guitarGroup(`P add SNR ${snr}dB (vs first 300 ms)`, 'P', (m, sr) => {
    if (m % 2) return null;
    const g = guitar(m, 2.0, { sr, seed: m });
    const x = mix(silence(2.6, sr), g, ONSET, sr);
    return { x: whiteNoise(x, rms(g, 0, Math.floor(0.3 * sr)) / Math.pow(10, snr / 20), m) };
  }, { quick: snr === 12 });
}
guitarGroup('N ks semitone off (both sides)', 'N', (m) => (m < 76 ? { x: ks(m), target: m + 1 } : { x: ks(m), target: m - 1 }));
guitarGroup('N ks wrong octave', 'N', (m) => ({ x: ks(m), target: m + 12 <= 76 ? m + 12 : m - 12 }));
guitarGroup('N add wrong octave (target an octave up)', 'N', (m, sr) => (m + 12 <= 76 ? { x: add(m, sr), target: m + 12 } : null));
guitarGroup('N add wrong octave (target an octave down)', 'N', (m, sr) => (m - 12 >= 40 ? { x: add(m, sr), target: m - 12 } : null));
guitarGroup('N add weakfund wrong octave (target up)', 'N', (m, sr) => (m + 12 <= 76 ? { x: add(m, sr, { profile: 'weakfund' }), target: m + 12 } : null));
guitarGroup('N add detuned +55c', 'N', (m, sr) => ({ x: add(m, sr, { cents: 55 }) }));
// trade-off: a slow slide that passes through the note is the right pitch for a moment
guitarGroup('I slide through target 2 st/s, never stops (accepting is a documented trade-off)', 'I', (m, sr) => ({ x: add(m, sr, { f0fn: (t) => -2 + 2 * t, t60: 6 }) }), { quick: false });
guitarGroup('N slide through target 4 st/s', 'N', (m, sr) => ({ x: add(m, sr, { f0fn: (t) => -3 + 4 * t, t60: 6 }) }), { quick: false });
guitarGroup('N slide through target 8 st/s', 'N', (m, sr) => ({ x: add(m, sr, { f0fn: (t) => -6 + 8 * t, t60: 6 }) }));
guitarGroup('N slide-in passes the fret below (target -1)', 'N', (m, sr) => (m > 40 ? { x: add(m, sr, { slideFromSemis: -2, slideSec: 0.4 }), target: m - 1 } : null), { quick: false });
// a sung note with its own fresh attack in the guitar step: (c) deliberate humming by default,
// rejected by the strict instrument check
const VOWELS = ['a', 'i', 'u', 'o', 'hum'] as const;
for (const strict of [false, true]) {
  for (const vib of [0, 15, 50]) {
    guitarGroup(`${strict ? 'N [strict]' : 'I [default]'} sung note with a fresh attack (vib ±${vib}c), exact octave`, strict ? 'N' : 'I', (m, sr) => {
      if (m > 69 || m % 2) return null;
      return { x: mix(floorBase(sr, 2.1, m), voice(m, 1.5, { sr, seed: m, vowel: VOWELS[m % 5], vibCents: vib }), ONSET, sr) };
    }, { strict, quick: vib === 15 });
  }
}
guitarGroup('P [strict] add normal', 'P', (m, sr) => ({ x: add(m, sr) }), { strict: true });
guitarGroup('P [strict] ks clean', 'P', (m) => ({ x: ks(m) }), { strict: true, quick: false });

function staticNegatives(name: string, mkX: () => Float32Array, path: AnalysisPath, mkCfg: (t: number) => MatchConfig, targets: number[]) {
  const full = `${path === 'guitar' ? 'guitar' : 'voice'} ${name}`;
  job(full, 1, true, (quick) => {
    const g = new Group(full, 'N');
    const fr = framesOf(mkX(), path);
    for (const t of pickNotes(targets, quick)) g.add(noteName(t), runCfg(fr, mkCfg(t)), 0);
    return [g.r];
  });
}
staticNegatives('N silence', () => silence(3, SR), 'guitar', (t) => guitarConfig(t), GUITAR);
staticNegatives('N white noise -30dBFS', () => noise(3, 0.03, 9), 'guitar', (t) => guitarConfig(t), GUITAR);
staticNegatives('N 60Hz hum only -40dBFS', () => hum(floorBase(SR, 4, 3), SR, 60, 0.01), 'guitar', (t) => guitarConfig(t), GUITAR);
staticNegatives('N 120Hz-dominant hum -40dBFS', () => hum(floorBase(SR, 4, 3), SR, 60, 0.01, [0.3, 1, 0.3, 0.2]), 'guitar', (t) => guitarConfig(t), GUITAR);
staticNegatives('N 100Hz-dominant hum (50Hz mains)', () => hum(floorBase(SR, 4, 3), SR, 50, 0.01, [0.3, 1, 0.3, 0.2]), 'guitar', (t) => guitarConfig(t), GUITAR);

// ========================================================================== singing step, models 1+2
type VoiceMk = (t: number, sung: number, sr: number) => { x: Float32Array; onset?: number } | null;
function voiceGroup(name: string, kind: Kind, mk: VoiceMk, opts: { tol?: number; exact?: boolean; octaves?: number[]; targets?: number[]; sr?: number; strict?: boolean; quick?: boolean } = {}) {
  const full = `voice ${name}`;
  job(full, 1.5, opts.quick ?? true, (quick) => {
    const g = new Group(full, kind);
    const sr = opts.sr ?? SR;
    for (const oc of opts.octaves ?? [0, 12]) {
      for (const t of pickNotes(opts.targets ?? SONG_C, quick)) {
        const sung = t + oc;
        const r = mk(t, sung, sr);
        if (!r) continue;
        const cfg = singConfig(t, opts.tol ?? 50, opts.exact ?? false, opts.strict ?? false);
        const fr = framesOf(r.x, 'voice', sr);
        const on = r.onset ?? ONSET;
        const at = runCfg(fr, cfg);
        const oe = kind === 'P' && octaveScan(fr, cfg, sung, on + 0.05, on + 1.5);
        g.add(`${noteName(sung)}→${noteName(t)}`, at, on, oe);
      }
    }
    return [g.r];
  });
}
const sv = (sung: number, sr: number, o: Partial<VoiceOpts> & { dur?: number; floor?: number } = {}) =>
  mix(floorBase(sr, (o.dur ?? 2.5) + 0.6, sung, o.floor), voice(sung, o.dur ?? 2.5, { sr, seed: sung, ...o }), ONSET, sr);
const LOWHIGH = Array.from({ length: 30 }, (_, i) => 40 + i);
const v1x = (m: number, noisy: boolean) => {
  const x = concat(sil1(ONSET), voice1(m, 2.0, { vowel: (['ah', 'ee', 'oo', 'eh'] as const)[m % 4] }), sil1(0.2));
  return noisy ? addNoise(x, 20, 2000 + m, Math.floor(ONSET * SR), Math.floor((ONSET + 2) * SR)) : x;
};
voiceGroup('P model-1 voice E2–A4 clean', 'P', (t) => ({ x: v1x(t, false) }), { targets: LOWHIGH, octaves: [0] });
voiceGroup('P model-1 voice E2–A4 +noise 20dB', 'P', (t) => ({ x: v1x(t, true) }), { targets: LOWHIGH, octaves: [0], quick: false });
voiceGroup('P model-1 voice strict ±25', 'P', (t) => ({ x: v1x(t, t % 2 === 0) }), { targets: LOWHIGH, octaves: [0], tol: 25, quick: false });
voiceGroup('P model-1 voice exact-octave on', 'P', (t) => ({ x: v1x(t, false) }), { targets: LOWHIGH, octaves: [0], exact: true, quick: false });
for (const v of ['a', 'i', 'u', 'o'] as const) voiceGroup(`P vowel ${v}`, 'P', (_t, s, sr) => ({ x: sv(s, sr, { vowel: v }) }), { quick: v === 'a' });
voiceGroup('P vowels 44.1k', 'P', (t, s, sr) => ({ x: sv(s, sr, { vowel: (['a', 'i', 'u', 'o'] as const)[t % 4] }) }), { sr: 44100, quick: false });
voiceGroup('P humming (mmm)', 'P', (_t, s, sr) => ({ x: sv(s, sr, { vowel: 'hum' }) }));
voiceGroup('P vibrato ±100c 4.5Hz', 'P', (_t, s, sr) => ({ x: sv(s, sr, { vibCents: 100, vibRate: 4.5 }) }));
voiceGroup('P vibrato ±150c 6Hz', 'P', (_t, s, sr) => ({ x: sv(s, sr, { vibCents: 150, vibRate: 6 }) }), { quick: false });
voiceGroup('P vibrato ±50c at strict ±25', 'P', (_t, s, sr) => ({ x: sv(s, sr, { vibCents: 50 }) }), { tol: 25, quick: false });
voiceGroup('P vibrato ±80c centred +40c', 'P', (_t, s, sr) => ({ x: sv(s, sr, { vibCents: 80, f0fn: () => 0.4 }) }), { quick: false });
voiceGroup('P breathy', 'P', (_t, s, sr) => ({ x: sv(s, sr, { breath: 2.0, vowel: 'u' }) }), { quick: false });
voiceGroup('P quiet -52dBFS, floor -75', 'P', (_t, s, sr) => ({ x: sv(s, sr, { amp: 0.0025, floor: 0.00018 }) }), { quick: false });
voiceGroup('P scoop from -300c over 300ms', 'P', (_t, s, sr) => ({ x: sv(s, sr, { f0fn: (t) => -3 * Math.max(0, 1 - t / 0.3) }) }), { quick: false });
voiceGroup('P low voice an octave down (C2–G3)', 'P', (_t, s, sr) => ({ x: sv(s, sr) }), { octaves: [-12] });
voiceGroup('P high voice two octaves up (C5–G6)', 'P', (_t, s, sr) => ({ x: sv(s, sr) }), { octaves: [24], quick: false });
for (const snr of [12, 6]) {
  voiceGroup(`P SNR ${snr}dB`, 'P', (_t, s, sr) => {
    const v = voice(s, 2.5, { sr, vowel: s % 2 ? 'a' : 'u', vibCents: 20, seed: s });
    const x = mix(silence(3.1, sr), v, ONSET, sr);
    return { x: whiteNoise(x, rms(v) / Math.pow(10, snr / 20), s) };
  }, { octaves: [0], quick: snr === 6 });
}
voiceGroup('P fades -12 dB/s from the start (no envelope test by default)', 'P', (_t, s, sr) => {
  const v = voice(s, 1.8, { sr, seed: s });
  for (let i = 0; i < v.length; i++) v[i] *= Math.pow(10, (-12 * i) / sr / 20);
  return { x: mix(floorBase(sr, 2.6, s), v, ONSET, sr) };
});
voiceGroup('N semitone sharp', 'N', (_t, s, sr) => ({ x: sv(s + 1, sr) }));
voiceGroup('N +55c sharp', 'N', (_t, s, sr) => ({ x: sv(s, sr, { f0fn: () => 0.55 }) }), { quick: false });
voiceGroup('N +30c at strict ±25', 'N', (_t, s, sr) => ({ x: sv(s, sr, { f0fn: () => 0.3 }) }), { tol: 25, quick: false });
voiceGroup('N vibrato ±80c centred +70c', 'N', (_t, s, sr) => ({ x: sv(s, sr, { vibCents: 80, f0fn: () => 0.7 }) }), { quick: false });
for (const rate of [1, 2, 4]) {
  voiceGroup(`N glide through target ${rate} st/s, never settles`, 'N', (_t, s, sr) => ({ x: sv(s, sr, { dur: Math.min(6, 6 / rate + 0.5), f0fn: (t) => -3 + rate * t }) }), { quick: rate === 1 });
}
voiceGroup('N exact-octave on, sung an octave up', 'N', (t, _s, sr) => ({ x: sv(t + 12, sr) }), { exact: true, octaves: [0] });
voiceGroup('N exact-octave on, sung an octave down', 'N', (t, _s, sr) => ({ x: sv(t - 12, sr) }), { exact: true, octaves: [0], quick: false });
for (const strict of [false, true]) {
  voiceGroup(`${strict ? 'N [strict]' : 'I [default]'} guitar pluck (additive) in the singing step`, strict ? 'N' : 'I', (_t, s, sr) => (s >= 40 && s <= 76 ? { x: add(s, sr) } : null), { octaves: [0, 12], strict });
  voiceGroup(`${strict ? 'N [strict]' : 'I [default]'} guitar pluck (KS) in the singing step`, strict ? 'N' : 'I', (_t, s) => (s >= 40 && s <= 76 ? { x: ks(s) } : null), { octaves: [0], strict, quick: false });
}
voiceGroup('P [strict] vowel a', 'P', (_t, s, sr) => ({ x: sv(s, sr, { vowel: 'a' }) }), { strict: true });
staticNegatives('N silence', () => silence(3, SR), 'voice', (t) => singConfig(t, 50, false), SONG_C);
staticNegatives('N white noise -30dBFS', () => noise(3, 0.03, 19), 'voice', (t) => singConfig(t, 50, false), SONG_C);
staticNegatives('N 60Hz hum only -40dBFS', () => hum(floorBase(SR, 4, 3), SR, 60, 0.01), 'voice', (t) => singConfig(t, 50, false), SONG_C);
staticNegatives('N 50Hz hum only -32dBFS', () => S3.hum(S3.white(S3.silence(4, SR), -62, 3), SR, 50, -32), 'voice', (t) => singConfig(t, 50, false), SONG_C);

// Carry-over: the guitar note of the previous step still ringing when the singing step opens.
job('voice N carry-over: previous note (same pitch) still ringing at the sing step', 1, true, (quick) => {
  const g = new Group('voice N carry-over: previous note (same pitch) still ringing at the sing step', 'N');
  for (const m of pickNotes(SONG_C, quick, 3)) {
    for (const seed of [1, 2]) {
      const x = S3.white(S3.silence(3.5, SR), -62, seed);
      S3.mixAt(x, gbase(m, seed * 7 + m, { decayDbS: 6 + seed * 3 }, 3.3), 0.05, SR);
      // the singing step opens 1.6 s after the pluck (reference tone + tail)
      const fr = framesOf(x, 'voice');
      const cfg = { ...singConfig(m, 50, false), carryMidi: m };
      g.add(`${noteName(m)} seed ${seed}`, runCfg(fr, cfg, 1.6), 1.6);
    }
  }
  return [g.r];
});
job('voice P carry-over guard: singing over the previous note still ringing', 1, true, (quick) => {
  const g = new Group('voice P carry-over guard: singing over the previous note still ringing', 'P');
  for (const m of pickNotes(SONG_C, quick, 3)) {
    const x = S3.white(S3.silence(4.5, SR), -62, m);
    S3.mixAt(x, gbase(m, m, { decayDbS: 8 }, 3.3), 0.05, SR);
    S3.mixAt(x, S3.vo(m, 2.0, { sr: SR, seed: m, vowel: 'a', vibCents: 15, peak: 0.12 }), 2.0, SR);
    const fr = framesOf(x, 'voice');
    g.add(noteName(m), runCfg(fr, { ...singConfig(m, 50, false), carryMidi: m }, 1.6), 2.0);
  }
  return [g.r];
});

// ========================================================================== review's ported conditions (model 3)
const GM = [40, 43, 45, 48, 50, 52, 55, 57, 59, 60, 62, 64, 65, 67, 69, 72, 76];
const VM = [43, 45, 48, 50, 52, 54, 55, 57, 59, 60, 62, 64];
/** Voice conditions that are shorter than the required ~0.5 s hold by construction. */
const V_TOO_SHORT = new Set(['short note 0.35 s', 'staccato da-da-da-da (4 x 0.25 s, 0.12 s gaps)', 'short "da" 0.4 s, 30 dB/s decay', 'staccato da x4 (0.45 s each, 0.15 s gaps)']);
for (const [cname, cond] of Object.entries(G2)) {
  const full = `guitar3 P ${cname}`;
  job(full, 2, ['base pick, -14 dBFS peak', 'quiet: -40 dBFS peak', 'fan noise -35 dBFS', 'hum 60 Hz -40 dBFS', 'hammer-on from 2 frets below', 'vibrato +-35c 6 Hz', 'previous note (octave below) still ringing', 'TV speech -30 dBFS rms'].includes(cname), (quick) => {
    const acc = new Group(full, 'P');
    const oct = new Group(`guitar3 N ${cname} — accepted as the wrong octave or a fifth`, 'N');
    const sing = new Group(`guitar3 N ${cname} — the same pluck accepted by the singing step`, 'N');
    for (const m of pickNotes(GM, quick, 3)) {
      for (const s0 of quick ? [1] : [1, 2, 3]) {
        const fx: Fx = cond(m, s0 * 17 + m);
        const fg = framesOf(fx.buf, 'guitar', fx.sr, fx.jitter);
        acc.add(`${noteName(m)}#${s0}`, runCfg(fg, guitarConfig(m), fx.from), fx.onset);
        // (from just before this note's attack: an earlier note in the fixture really was played)
        const wrong = [12, -12, 7, -7].map((d) => m + d).filter((t) => t >= 40 && t <= 76).some((t) => runCfg(fg, guitarConfig(t), Math.max(fx.from ?? 0, fx.onset - 0.1)) !== null);
        oct.add(`${noteName(m)}#${s0}`, wrong ? fx.onset : null, fx.onset);
        const fv = framesOf(fx.buf, 'voice', fx.sr, fx.jitter);
        sing.add(`${noteName(m)}#${s0}`, runCfg(fv, singConfig(m, 50, false), fx.from), fx.onset);
      }
    }
    return [acc.r, oct.r, sing.r];
  });
}
for (const [cname, cond] of Object.entries(V2)) {
  const kind: Kind = 'P';
  const full = `voice3 ${kind} ${cname}${V_TOO_SHORT.has(cname) ? ' (shorter than the ~0.5 s hold)' : ''}`;
  job(full, 2, ['base 1.5 s, vibrato 10-30c', 'fades out -15 dB/s from the start', 'out of breath: 0.3 s steady then -25 dB/s', 'short accented "da" 0.5 s, 12 dB/s decay', 'already singing when the step opens (sang along with the tone)', 'vocal fry 85%'].includes(cname), (quick) => {
    const acc = new Group(full, kind);
    const octX = new Group(`voice3 N ${cname} — exact-octave mode accepted the wrong octave`, 'N');
    const play = new Group(`voice3 N ${cname} — the same voice accepted by the guitar step`, 'N');
    for (const m of pickNotes(VM, quick, 3)) {
      for (const s0 of quick ? [1] : [1, 2, 3]) {
        const fx: Fx = cond(m, s0 * 17 + m);
        const sung = cname.startsWith('falsetto') || cname.startsWith('child') ? m + 12 : cname.startsWith('low bass') ? m - 12 : cname.startsWith('whistl') ? m + 24 : m;
        const fv = framesOf(fx.buf, 'voice', fx.sr, fx.jitter);
        acc.add(`${noteName(m)}#${s0}`, runCfg(fv, singConfig(m, 50, false), fx.from), fx.onset);
        const wrong = runCfg(fv, singConfig(sung - 12, 50, true), fx.from) !== null || runCfg(fv, singConfig(sung + 12, 50, true), fx.from) !== null;
        octX.add(`${noteName(m)}#${s0}`, wrong ? fx.onset : null, fx.onset);
        if (sung >= 40 && sung <= 76) {
          const fg = framesOf(fx.buf, 'guitar', fx.sr, fx.jitter);
          play.add(`${noteName(m)}#${s0}`, runCfg(fg, guitarConfig(sung), fx.from), fx.onset);
        }
      }
    }
    return [acc.r, octX.r, play.r];
  });
}
// ringing-string rows from the review (the matcher starts after the previous note)
const after = PRE2 + 0.5;
const ringRows: [string, (m: number, s: number) => Fx & { prev?: number }][] = [
  ['prev note 2 frets up ringing', (m, s) => ({ ...wrap2(S3.mixAt(gbase(m + 2, s + 9, { decayDbS: 8 }, 2.8), gbase(m, s), 0.8, SR), SR, s, 0.8), from: after })],
  ['prev note 5th below ringing', (m, s) => ({ ...wrap2(S3.mixAt(gbase(m - 7, s + 9, { decayDbS: 6 }, 2.8), gbase(m, s), 0.8, SR), SR, s, 0.8), from: after })],
  ['prev note 4th above ringing', (m, s) => ({ ...wrap2(S3.mixAt(gbase(m + 5, s + 9, { decayDbS: 6 }, 2.8), gbase(m, s), 0.8, SR), SR, s, 0.8), from: after })],
  ['prev note octave below ringing', (m, s) => ({ ...wrap2(S3.mixAt(gbase(m - 12, s + 9, { decayDbS: 6 }, 2.8), gbase(m, s), 0.8, SR), SR, s, 0.8), from: after })],
  ['prev note octave above ringing', (m, s) => ({ ...wrap2(S3.mixAt(gbase(m + 12, s + 9, { decayDbS: 6 }, 2.8), gbase(m, s), 0.8, SR), SR, s, 0.8), from: after })],
  ['prev note major 3rd below ringing', (m, s) => ({ ...wrap2(S3.mixAt(gbase(m - 4, s + 9, { decayDbS: 6 }, 2.8), gbase(m, s), 0.8, SR), SR, s, 0.8), from: after })],
  ['prev note semitone below ringing', (m, s) => ({ ...wrap2(S3.mixAt(gbase(m - 1, s + 9, { decayDbS: 6 }, 2.8), gbase(m, s), 0.8, SR), SR, s, 0.8), from: after })],
  ['sympathetic partial at f, -8 dB, swells 0.15 s', (m, s) => wrap2(S3.mixAt(gbase(m, s), S3.ks(m, 2.0, { sr: SR, seed: s + 5, pure: true, pol2: 0, dull: 0.02, decayDbS: 3, attack: 0.15, pickNoise: 0, peak: 0.2 * S3.db2a(-8), cents: 3 }), 0, SR), SR, s)],
  ['palm mute 60 dB/s', (m, s) => wrap2(gbase(m, s, { decayDbS: 60, fastDecayDbS: 90, dull: 0.5 }, 1.5), SR, s)],
  ['hum 60 Hz -45 dBFS, guitar at -30 peak', (m, s) => { const f = wrap2(gbase(m, s, { peak: S3.db2a(-30) }), SR, s); S3.hum(f.buf, SR, 60, -45); return f; }],
  ['quiet pluck -43 dBFS peak, floor -62', (m, s) => wrap2(gbase(m, s, { peak: S3.db2a(-43) }), SR, s)],
];
for (const [rname, mk] of ringRows) {
  const full = `guitar3 P ${rname}`;
  job(full, 1.5, rname.includes('octave'), (quick) => {
    const acc = new Group(full, 'P');
    const oct = new Group(`guitar3 N ${rname} — accepted as the wrong octave`, 'N');
    for (const m of pickNotes(GM, quick, 3)) {
      for (const s0 of quick ? [1] : [1, 2, 3]) {
        const fx = mk(m, s0 * 17 + m);
        const fg = framesOf(fx.buf, 'guitar', fx.sr);
        acc.add(`${noteName(m)}#${s0}`, runCfg(fg, guitarConfig(m), fx.from), fx.onset);
        const wrong = [12, -12].map((d) => m + d).filter((t) => t >= 40 && t <= 76).some((t) => runCfg(fg, guitarConfig(t), fx.from) !== null);
        oct.add(`${noteName(m)}#${s0}`, wrong ? fx.onset : null, fx.onset);
      }
    }
    return [acc.r, oct.r];
  });
}

// ========================================================================== speech / coughs
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
for (const [sname, mk] of [
  ['male speech 95-180Hz', (s: number, d: number) => speech(d, 43, 54, s)],
  ['female speech 170-300Hz', (s: number, d: number) => speech(d, 53, 62, s)],
  ['TV babble (model 3)', (s: number, d: number) => S3.white(S3.tv(d, SR, s), -62, s)],
] as [string, (s: number, d: number) => Float32Array][]) {
  job(`speech ${sname}`, 3, sname.startsWith('male'), (quick) => {
    const dur = quick ? 20 : 60;
    const out: GroupResult[] = [];
    for (const strict of [false, true]) {
      let singFA = 0, playFA = 0, singT = 0, playT = 0;
      for (const seed of quick ? [11] : [11, 22]) {
        const x = mk(seed, dur);
        const fv = framesOf(x, 'voice');
        const fg = framesOf(x, 'guitar');
        for (let pc = 0; pc < 12; pc++) {
          singT += dur / 60;
          let m = new NoteMatcher(singConfig(48 + pc, 50, false, strict));
          for (const f of fv) if (m.push(f).accepted) { singFA++; m = new NoteMatcher(singConfig(48 + pc, 50, false, strict)); }
        }
        for (const t of [43, 45, 47, 48, 50, 52, 53, 54, 55, 57, 59, 60, 62, 64, 65, 67]) {
          playT += dur / 60;
          let m = new NoteMatcher(guitarConfig(t, strict));
          for (const f of fg) if (m.push(f).accepted) { playFA++; m = new NoteMatcher(guitarConfig(t, strict)); }
        }
      }
      const sRate = singFA / singT;
      const pRate = playFA / playT;
      // Speech must rarely advance a step, default settings included (it is not the student
      // playing): target ≤ 0.5 per minute per target in the guitar step, ≤ 1 in the singing step.
      const bad = [pRate > 0.5 ? `guitar step ${pRate.toFixed(2)}/min` : '', sRate > 1 ? `singing step ${sRate.toFixed(2)}/min` : ''].filter(Boolean);
      out.push({
        name: `speech ${sname}${strict ? ' [strict]' : ' [default]'}: false accepts per minute per target (target ≤ 0.5 guitar, ≤ 1 singing)`,
        kind: 'S', n: 1, acc: 0, tta: [], oct: 0, fails: bad,
        ok: bad.length === 0, summary: `sing ${sRate.toFixed(2)}/min, guitar ${pRate.toFixed(2)}/min`,
      });
    }
    return out;
  });
}

// ========================================================================== simulated students
type StudentRes = ReturnType<typeof student>;
interface StudentSpec {
  st: Style;
  o?: RigOpts;
  /** expectation; returns a failure description or null */
  expect: (r: StudentRes, total: number) => string | null;
  quick?: boolean;
  /** informational: deliberate gaming (priority c) */
  info?: boolean;
}
const honestExpect = (opts: { reviews?: boolean; maxExtraPluckShare?: number } = {}) => (r: StudentRes, total: number): string | null => {
  const p: string[] = [];
  if (r.skippedNotes > 0) p.push(`${r.skippedNotes} notes given up`);
  if (r.notes < total) p.push(`only ${r.notes}/${total} notes done`);
  if (r.playByVoice > 0) p.push(`${r.playByVoice} guitar steps passed by the voice`);
  if (r.playWrongNote > 0) p.push(`${r.playWrongNote} passed on a wrong pluck`);
  if (r.singByGuitar > 0) p.push(`${r.singByGuitar} singing steps passed by the guitar`);
  if (opts.reviews && r.reviewSkipped > 0) p.push(`${r.reviewSkipped} phrase reviews given up`);
  const extra = r.plucks.filter((x) => x > 1).length;
  if (opts.maxExtraPluckShare !== undefined && extra > opts.maxExtraPluckShare * Math.max(1, r.plucks.length)) p.push(`${extra} notes needed more than one pluck`);
  return p.length ? p.join('; ') : null;
};
const students: StudentSpec[] = [
  { st: { name: 'A1 honest: sings, stops, pause 0.5 s, one pluck, damps; review at the written tempo' }, expect: honestExpect({ reviews: true, maxExtraPluckShare: 0.02 }), quick: true },
  { st: { name: 'A2 honest, lets every note ring (incl. review)', ring: true }, expect: honestExpect({ reviews: true, maxExtraPluckShare: 0.02 }), quick: true },
  { st: { name: 'A3 plucks 0.15 s after the sing accept while still singing (told: stop singing, then play)', pluckDuringSing: true, noReview: true }, expect: honestExpect() },
  { st: { name: 'B1 wrong fret first (2 frets up), then right, damped', wrongFirst: [2], noReview: true }, expect: honestExpect() },
  { st: { name: 'B2 wrong fret first, lets it ring', wrongFirst: [2], ring: true, noReview: true }, expect: honestExpect(), quick: true },
  { st: { name: 'B3 wrong OCTAVE first (+12), then right; damped', wrongFirst: [12], noReview: true }, expect: honestExpect() },
  { st: { name: 'B4 wrong OCTAVE first (+12) while ringing', wrongFirst: [12], ring: true, noReview: true }, expect: honestExpect(), quick: true },
  { st: { name: 'B5 hunts -5, +2, -1 then right, 0.6 s apart, ringing', wrongFirst: [-5, 2, -1], wrongGap: 0.6, ring: true, noReview: true }, expect: honestExpect(), quick: true },
  { st: { name: 'B6 hunts +7, +12, -12 (1.4 s each), ringing', wrongFirst: [7, 12, -12], wrongGap: 1.4, ring: true, noReview: true }, expect: honestExpect() },
  { st: { name: 'B7 hunts +7, +12, -12 (1.4 s each), damped', wrongFirst: [7, 12, -12], wrongGap: 1.4, noReview: true }, expect: honestExpect() },
  { st: { name: 'C1 hums a short dying "hm" at the target pitch while hunting', humWhileHunting: true, noReview: true }, expect: (r) => (r.playByVoice > 0 ? `${r.playByVoice} guitar steps passed by humming` : null) },
  { st: { name: 'C1s same, strict instrument check on', humWhileHunting: true, noReview: true }, o: { settings: { strictCheck: true } }, expect: (r) => (r.playByVoice > 0 ? `${r.playByVoice} guitar steps passed by humming` : null) },
  { st: { name: 'C3 voice-only, never plays', noGuitar: true, vDur: 1.2, intonSd: 5 }, o: { maxNotes: 30 }, expect: (r) => (r.playByVoice > 0 || r.reviewByVoice > 0 ? `voice passed ${r.playByVoice} guitar steps, ${r.reviewByVoice} reviews` : null) },
  { st: { name: 'C3s voice-only, strict instrument check on', noGuitar: true, vDur: 1.2, intonSd: 5 }, o: { maxNotes: 30, settings: { strictCheck: true } }, expect: (r) => (r.playByVoice > 0 || r.reviewByVoice > 0 ? `voice passed ${r.playByVoice} guitar steps, ${r.reviewByVoice} reviews` : null) },
  { st: { name: 'C4 guitar-only, never sings', noSing: true, noReview: true }, o: { maxNotes: 30 }, expect: (r) => (r.singByGuitar > 0 ? `${r.singByGuitar} singing steps passed by the guitar` : null) },
  { st: { name: 'C4s guitar-only, strict instrument check on', noSing: true, noReview: true }, o: { maxNotes: 30, settings: { strictCheck: true } }, expect: (r) => (r.singByGuitar > 0 ? `${r.singByGuitar} singing steps passed by the guitar` : null) },
  { st: { name: 'D review at 50% of the written tempo, damped', reviewTempo: 0.5 }, expect: honestExpect({ reviews: true }) },
  { st: { name: 'D review, even notes every 0.3 s, ringing', reviewIOI: 0.3, ring: true }, expect: honestExpect({ reviews: true }), quick: true },
  { st: { name: 'D review, even notes every 0.5 s, ringing', reviewIOI: 0.5, ring: true }, expect: honestExpect({ reviews: true }) },
  { st: { name: 'D review, even notes every 1.0 s, ringing', reviewIOI: 1.0, ring: true }, expect: honestExpect({ reviews: true }) },
  { st: { name: 'F3 review 0.6 s per note, only the previous note rings', reviewIOI: 0.6, ring: true, ringOne: true }, expect: honestExpect({ reviews: true }), quick: true },
  { st: { name: 'E1 honest + phone AGC 12 dB/s', noReview: true }, o: { agc: 12 }, expect: honestExpect() },
  { st: { name: 'E3 honest + 60 Hz hum -45 dBFS', noReview: true }, o: { humDb: -45 }, expect: honestExpect() },
  { st: { name: 'E4 honest + 60 Hz hum -38 dBFS', noReview: true }, o: { humDb: -38 }, expect: honestExpect() },
  { st: { name: 'E5 honest, quiet guitar -36 dBFS peak', noReview: true, gPeak: S3.db2a(-36) }, expect: honestExpect({ maxExtraPluckShare: 0.05 }) },
  { st: { name: 'E6 honest, guitar -30 dBFS + fan -42 dBFS', noReview: true, gPeak: S3.db2a(-30) }, o: { fanDb: -42 }, expect: honestExpect({ maxExtraPluckShare: 0.1 }), quick: true },
  { st: { name: 'E7 honest, singer fades each note -9 dB/s', noReview: true, voice: { env: (t) => S3.db2a(-9 * t) } }, expect: honestExpect() },
  { st: { name: 'E7b honest, singer fades each note -15 dB/s', noReview: true, voice: { env: (t) => S3.db2a(-15 * t) } }, expect: honestExpect(), quick: true },
  { st: { name: 'E8 honest, sloppy singer (intonation sd 30c)', noReview: true, intonSd: 30 }, expect: honestExpect() },
  { st: { name: 'H1 wrong octave first (+12, rings 1.6 s); 60 Hz hum -50 dBFS', wrongFirst: [12], wrongGap: 1.6, noReview: true }, o: { humDb: -50 }, expect: honestExpect(), quick: true },
  { st: { name: 'H4 key of G: wrong octave first (+12, 1.6 s); hum -50', wrongFirst: [12], wrongGap: 1.6, noReview: true }, o: { humDb: -50, tonic: 43 }, expect: honestExpect() },
  // round 4: a neighbouring fret first, left ringing; whole guitar sharp/flat (in-session detune sweep)
  { st: { name: 'W1 one fret BELOW first (rings 1.3 s), then right', wrongFirst: [-1], wrongGap: 1.3, ring: true, noReview: true }, expect: honestExpect(), quick: true },
  { st: { name: 'W2 one fret below first (1.3 s), quiet guitar -26 dBFS, strings +20 c', wrongFirst: [-1], wrongGap: 1.3, ring: true, noReview: true, gPeak: 0.05, guitar: { cents: 20 } }, expect: honestExpect() },
  { st: { name: 'W3 one fret ABOVE first (rings 1.3 s), strings -20 c', wrongFirst: [1], wrongGap: 1.3, ring: true, noReview: true, guitar: { cents: -20 } }, expect: honestExpect() },
  ...[-30, -15, 15, 30].map((c) => ({ st: { name: `T${c > 0 ? '+' : ''}${c} honest, lets ring, whole guitar ${c > 0 ? '+' : ''}${c} c`, ring: true, noReview: true, guitar: { cents: c } } as Style, expect: honestExpect(), quick: c === 30 })),
];
for (const sp of students) {
  job(`student ${sp.st.name}`, 6, sp.quick ?? false, (quick) => {
    const o: RigOpts = { ...(sp.o ?? {}), ...(quick ? { maxNotes: Math.min(sp.o?.maxNotes ?? 101, 14) } : {}) };
    const log = console.log;
    console.log = () => {};
    let r: StudentRes;
    try {
      r = student(sp.st, o);
    } finally {
      console.log = log;
    }
    const total = Math.min(o.maxNotes ?? 101, 101);
    const problem = sp.expect(r, total);
    const extra = r.plucks.filter((x) => x > 1).length;
    const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : NaN);
    const summary = `done ${r.notes}/${total}, given up ${r.skippedNotes}; sing: >1 breath ${r.singBreaths.filter((b) => b > 1).length}, by GUITAR ${r.singByGuitar}; play: >1 pluck ${extra}, median ${med(r.playMs).toFixed(0)} ms, by VOICE ${r.playByVoice}, WRONG ${r.playWrongNote}; review: ${r.reviews} (1st try ${r.reviewFirstTry}, given up ${r.reviewSkipped})`;
    return [{ name: `student ${sp.st.name}`, kind: sp.info ? 'I' : 'S', n: 1, acc: 0, tta: [], oct: 0, fails: problem ? [problem] : [], ok: sp.info ? true : problem === null, summary: problem ? `${summary} — ${problem}` : summary }];
  });
}

// Earlier-round simulations (whole song): honest students must finish with every guitar step passed by the pluck.
function simJob(name: string, fn: () => SimRow, check: (r: SimRow) => string | null, strict = false, info = false) {
  job(`sim ${name}`, 8, false, () => {
    setSimSettings(strict ? { strictCheck: true } : {});
    const r = fn();
    setSimSettings({});
    const problem = check(r);
    const summary = `sing by voice/guitar ${r.passedSing.voice}/${r.passedSing.guitar}; guitar by voice/guitar ${r.passedPlay.voice}/${r.passedPlay.guitar}; review by voice/guitar ${r.passedReview.voice}/${r.passedReview.guitar}; finished ${r.finished ? 'yes' : `no (note ${r.reached})`}`;
    return [{ name: `sim ${r.name}${strict ? ' [strict]' : ''}`, kind: info ? 'I' : 'S', n: 1, acc: 0, tta: [], oct: 0, fails: problem ? [problem] : [], ok: info || problem === null, summary: problem ? `${summary} — ${problem}` : summary }];
  });
}
const honestCheck = (r: SimRow) => (r.passedPlay.voice > 0 ? `voice passed ${r.passedPlay.voice} guitar steps` : !r.finished ? 'did not finish' : r.passedPlay.guitar < r.notes ? `only ${r.passedPlay.guitar} guitar steps by the pluck` : null);
simJob('honest 0.8 s', () => honest(0.8), honestCheck);
simJob('honest 1.5 s straight tone', () => honest(1.5, 0, { vibCents: 0 }), honestCheck);
simJob('honest humming', () => honest(1.5, 0, { vowel: 'hum' }), honestCheck);
simJob('honest KS + review', () => honest(1.2, 0, {}, 'ks', true), honestCheck);
simJob('voice-only', () => voiceOnly(0, 1.2), (r) => (r.passedPlay.voice + r.passedReview.voice > 0 ? `voice passed ${r.passedPlay.voice} guitar steps / ${r.passedReview.voice} review notes` : null));
simJob('voice-only', () => voiceOnly(0, 1.2), (r) => (r.passedPlay.voice + r.passedReview.voice > 0 ? `voice passed ${r.passedPlay.voice} guitar steps / ${r.passedReview.voice} review notes` : null), true);
simJob('guitar-only', () => guitarOnly('additive'), (r) => (r.passedSing.guitar > 0 ? `guitar passed ${r.passedSing.guitar} sing steps` : null));
simJob('guitar-only', () => guitarOnly('additive'), (r) => (r.passedSing.guitar > 0 ? `guitar passed ${r.passedSing.guitar} sing steps` : null), true);
simJob('guitar-only re-plucks', () => guitarOnlyRepeated('ks'), (r) => (r.passedSing.guitar > 0 ? `guitar passed ${r.passedSing.guitar} sing steps` : null), true);

// ========================================================================== third review's rig (permanent)
// Its own synthesis (modal guitar, glottal voice, speech, TV) and session rig that mirrors the app's
// timing (700 ms gap with the guitar detector still running, frames dropped during the reference).
// The detector carries its state through the whole session, so in-session effects are measured.
interface C3Spec { cond: string; quick?: boolean; kind?: 'S' | 'I'; extraPluck?: number; extraBreath?: number; reviewFirst?: number; note?: string }
const C3: C3Spec[] = [
  { cond: 'base', quick: true, reviewFirst: 0.8 },
  { cond: 'baseDamp' }, { cond: 'loudG' }, { cond: 'quietV' }, { cond: 'loudV' }, { cond: 'base441' }, { cond: 'female' },
  { cond: 'electric', extraPluck: 0.25 },
  { cond: 'detune10' }, { cond: 'detune20' }, { cond: 'detune20s', quick: true }, { cond: 'detune30' }, { cond: 'detune35' }, { cond: 'detuneM30' },
  { cond: 'gvars', reviewFirst: 0.6 }, { cond: 'svars' }, { cond: 'svarsF' }, { cond: 'sloppy', extraBreath: 0.15 }, { cond: 'octDown' },
  { cond: 'huntOct' }, { cond: 'huntOctFast' }, { cond: 'huntDamped' }, { cond: 'huntStep', quick: true }, { cond: 'huntStepSlow' }, { cond: 'huntStepLoudG' },
  { cond: 'idleTalk' }, { cond: 'idleTalkF', quick: true }, { cond: 'idleHum' }, { cond: 'idleHumF' }, { cond: 'idleHumStrict' },
  { cond: 'strict' }, { cond: 'strictVars' },
  { cond: 'fan' }, { cond: 'fanQuiet' }, { cond: 'hum50' }, { cond: 'hum60loud' }, { cond: 'talker' }, { cond: 'talkerLoud' }, { cond: 'tv' }, { cond: 'tvLoud' },
  { cond: 'bathroom' }, { cond: 'agc' }, { cond: 'agcFast' }, { cond: 'gate' }, { cond: 'gateSoft' }, { cond: 'hp200' },
  { cond: 'jitter' }, { cond: 'jitterMild', quick: true }, { cond: 'slow40' }, { cond: 'burst20' }, { cond: 'burst40' }, { cond: 'phoneAll', reviewFirst: 0.6 },
  { cond: 'review03', quick: true, reviewFirst: 0.6 }, { cond: 'review045', reviewFirst: 0.8 }, { cond: 'review06LoudG', reviewFirst: 0.8 }, { cond: 'review03Damp', reviewFirst: 0.6 }, { cond: 'review03LoudG', reviewFirst: 0.6 }, { cond: 'review1', reviewFirst: 0.9 },
];
for (const sp of C3) {
  job(`critic3 ${sp.cond}`, 12, sp.quick ?? false, (quick) => {
    const [st, ro] = C3CONDS[sp.cond]();
    const keepReview = sp.reviewFirst !== undefined;
    const log = console.log;
    console.log = () => {};
    let r: C3Res;
    try {
      r = c3student({ ...st, maxNotes: quick ? 14 : 101, noReview: !keepReview }, ro);
    } finally {
      console.log = log;
    }
    const acc = r.accidental.filter((a) => a.phase !== 'review');
    const problems: string[] = [];
    if (r.stuckSing + r.stuckPlay) problems.push(`stuck on ${r.stuckSing + r.stuckPlay} notes`);
    if (acc.length) problems.push(`${acc.length} accidental advances (${acc.slice(0, 2).map((a) => `#${a.idx + 1} ${a.phase}: ${a.why}`).join('; ')})`);
    if (r.wrongOctFifth) problems.push(`${r.wrongOctFifth} wrong octave/fifth`);
    if (r.notesNeedingExtraPluck > Math.ceil((sp.extraPluck ?? 0.05) * r.total)) problems.push(`${r.notesNeedingExtraPluck} notes needed another pluck`);
    if (r.notesNeedingExtraBreath > Math.ceil((sp.extraBreath ?? 0.05) * r.total)) problems.push(`${r.notesNeedingExtraBreath} notes needed another breath`);
    if (keepReview && r.reviews && r.reviewFirstTry < Math.floor((sp.reviewFirst ?? 0) * r.reviews)) problems.push(`review first try ${r.reviewFirstTry}/${r.reviews}`);
    if (r.reviewAccidental) problems.push(`${r.reviewAccidental} accidental review advances`);
    const q = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1].toFixed(0) : '-');
    const summary = `${st.name}: clean ${r.clean}/${r.total}, stuck ${r.stuckSing}/${r.stuckPlay}, accidental ${acc.length}, extra plucks on ${r.notesNeedingExtraPluck}, extra breaths on ${r.notesNeedingExtraBreath}, play median ${q(r.playTta)} ms${keepReview ? `, review first try ${r.reviewFirstTry}/${r.reviews}` : ''}`;
    const info = sp.kind === 'I';
    return [{ name: `critic3 ${sp.cond}`, kind: info ? 'I' : 'S', n: 1, acc: 0, tta: [], oct: 0, fails: problems, ok: info || problems.length === 0, summary: problems.length ? `${summary} — ${problems.join('; ')}` : summary }];
  });
}

// ========================================================================== fourth review's rig (permanent)
// Waveguide guitar + source-filter voice, its own session rig (mic check first, main.ts timing,
// in-session detector state). Every condition is an honest student; some hum, talk or sing while
// hunting. Expectations: never stuck, never advanced by anything but the right pluck / the sung
// note, at most 5 % of notes needing another pluck or breath, phrase review ≥ 90 % first try, no
// hint that says something untrue.
const C4_QUICK = new Set(['base', 'singOn', 'humTargetF', 'laBari', 'thumb', 'det35hard', 'rev03', 'quietSingerFan']);
for (const name of Object.keys(C4CASES)) {
  job(`critic4 ${name}`, 10, C4_QUICK.has(name), (quick) => {
    const c = C4CASES[name];
    const log = console.log;
    console.log = () => {};
    let r: C4Res;
    try {
      r = c4student({ name, maxNotes: quick ? 14 : 101, ...c.st }, c.ro ?? {});
    } finally {
      console.log = log;
    }
    const lim = (share: number) => Math.max(1, Math.ceil(share * r.total));
    const problems: string[] = [];
    if (r.stuckSing + r.stuckPlay) problems.push(`stuck on ${r.stuckSing + r.stuckPlay} notes (sing ${r.stuckSing}, play ${r.stuckPlay})`);
    if (r.accidental.length) problems.push(`${r.accidental.length} accidental advances (${r.accidental.slice(0, 2).map((a) => `#${a.index + 1} ${a.phase}: ${a.why}`).join('; ')})`);
    if (r.needPluck > lim(0.05)) problems.push(`${r.needPluck} notes needed another pluck`);
    if (r.needBreath > lim(0.05)) problems.push(`${r.needBreath} notes needed another breath`);
    if (r.rev && r.revFirst < Math.floor(0.9 * r.rev)) problems.push(`review first try ${r.revFirst}/${r.rev}`);
    if (r.revStuck) problems.push(`review stuck ${r.revStuck}`);
    const fh = Object.entries(r.falseHints);
    if (fh.length) problems.push(`untrue hints: ${fh.map(([k, v]) => `${k} (${v} frames)`).join(', ')}`);
    const med = (xs: number[]) => (xs.length ? [...xs].sort((x, y) => x - y)[xs.length >> 1].toFixed(0) : '-');
    const summary = `clean ${r.clean}/${r.total}, stuck ${r.stuckSing}/${r.stuckPlay}, accidental ${r.accidental.length}, extra plucks on ${r.needPluck}, extra breaths on ${r.needBreath}, play median ${med(r.playTta)} ms, review first try ${r.revFirst}/${r.rev}`;
    return [{ name: `critic4 ${name}`, kind: 'S', n: 1, acc: 0, tta: [], oct: 0, fails: problems, ok: problems.length === 0, summary: problems.length ? `${summary} — ${problems.join('; ')}` : summary }];
  });
}

// Isolation tables of the fourth review (fresh matcher per stimulus). Each script prints a table;
// a row counts as failed when the script marks it FAIL or a pass rate is below its target.
function c4table(file: string, cost: number, quick: boolean, judge: (line: string) => string | null): void {
  job(`critic4 table ${file}`, cost, quick, () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    return import(`./critic4/${file}.ts`).then(
      () => {
        console.log = log;
        const bad = lines.map((l) => judge(l)).filter((x): x is string => !!x);
        return [{ name: `critic4 table ${file}`, kind: 'S' as Kind, n: 1, acc: 0, tta: [], oct: 0, fails: bad, ok: bad.length === 0, summary: bad.length ? `${lines.length} rows, ${bad.length} failing: ${bad.slice(0, 4).join(' | ')}` : `${lines.length} rows, all as expected` }];
      },
      (e) => {
        console.log = log;
        throw e;
      },
    );
  });
}
c4table('hum_iso', 6, true, (l) => (/passes the guitar step [1-9]\d*\/\d+ \(default\)/.test(l) ? l.replace(/\s+/g, ' ').slice(0, 110) : null));
c4table('latefret', 6, false, (l) => { const m = /first pluck accepted (\d+)\/(\d+)/.exec(l); return m && m[1] !== m[2] ? l.replace(/\s+/g, ' ').slice(0, 90) : null; });
c4table('short', 6, false, (l) => { const m = /default (\d+)\/12/.exec(l); return m && m[1] !== '12' ? l.replace(/\s+/g, ' ').slice(0, 90) : null; });
c4table('sing_iso', 8, false, (l) => (l.startsWith('FAIL') ? l.replace(/\s+/g, ' ').slice(0, 110) : null));
c4table('techniques', 14, false, (l) => (l.startsWith('FAIL') ? l.replace(/\s+/g, ' ').slice(0, 110) : null));
c4table('leak', 2, false, (l) => { const m = /on pitch (\d+)\/12, 3 st off (\d+)\/12/.exec(l); return m && m[1] !== m[2] ? l : null; });
c4table('probe_zero', 2, false, (l) => (/clean -1\d\d|clean -2\d\d/.test(l) ? l.slice(0, 120) : null));

// ========================================================================== rooms (fifth review)
// Every fixture before round 6 was anechoic. A pluck in a room keeps gaining level for 30-70 ms
// after the pick (reverberation, body resonance): these jobs make sure no rule rejects it.
//
// (1) The fifth review's honest sessions in rooms (finite-difference string with body, tube-model
// voice, stochastic rooms, phone chains). Expectations: no note stuck, no accidental advance,
// at most 5 % of notes needing another pluck (or breath), phrase review ≥ 90 % first try.
const C5_QUICK = new Set(['B_finger_room0', 'D_pick_liveroom']);
for (const name of Object.keys(C5STY)) {
  job(`critic5 ${name}`, 14, C5_QUICK.has(name), (quick) => {
    const r: C5Res = c5honest({ ...C5STY[name], maxNotes: quick ? 14 : C5STY[name].maxNotes ?? 101 });
    const lim = (share: number, n: number) => Math.max(1, Math.ceil(share * n));
    const problems: string[] = [];
    const stuck = r.playStuck + r.singStuck + r.revStuck;
    if (stuck) problems.push(`stuck on ${stuck} (play ${r.playStuck}, sing ${r.singStuck}, review ${r.revStuck}: ${r.stuckAt.slice(0, 4).join(' ')})`);
    if (r.bad.length) problems.push(`${r.bad.length} accidental advances (${r.bad.slice(0, 2).map((a) => `#${a.index + 1} ${a.phase}: ${a.why}`).join('; ')})`);
    const needPluck = r.playSteps - r.firstPluck - r.playStuck;
    if (needPluck > lim(0.05, r.playSteps)) problems.push(`${needPluck}/${r.playSteps} notes needed another pluck`);
    if (r.singSteps - r.singFirst - r.singStuck > lim(0.05, r.singSteps)) problems.push(`${r.singSteps - r.singFirst - r.singStuck} notes needed another breath`);
    if (r.revNotes && r.revFirst < Math.floor(0.9 * r.revNotes)) problems.push(`review first try ${r.revFirst}/${r.revNotes}`);
    const lat = [...r.lat].sort((x, y) => x - y)[r.lat.length >> 1] ?? NaN;
    const summary = `play ${r.firstPluck}/${r.playSteps} first, +${r.replucks} re-plucks, sing ${r.singFirst}/${r.singSteps}, review ${r.revFirst}/${r.revNotes}, stuck ${stuck}, accidental ${r.bad.length}, play latency median ${lat.toFixed(0)} ms`;
    return [{ name: `critic5 ${name}`, kind: 'S', n: 1, acc: 0, tta: [], oct: 0, fails: problems, ok: problems.length === 0, summary: problems.length ? `${summary} — ${problems.join('; ')}` : summary }];
  });
}
// (2) First-pluck acceptance by room x pluck style (correct, in-tune plucks, 14 pitches x 2).
// Target: ≥ 93 % first pluck (26/28), every note within 4 plucks.
ROOMS5.forEach(([rn], ri) => {
  job(`critic5 pluck room: ${rn}`, 8, ri === 3 || ri === 5, () => {
    const rows = STYLES5.map((_, si) => pluckRoom(ri, si));
    const bad = rows.filter((r) => r.first < Math.ceil(0.93 * r.n) || r.any < r.n).map((r) => `${r.style} ${r.first}/${r.n} first, ${r.any}/${r.n} within 4 (missed ${r.missed.join(',')})`);
    const summary = rows.map((r) => `${r.style} ${r.first}/${r.n}`).join(', ') + `; median latency ${rows.map((r) => r.lat.toFixed(0)).join('/')} ms`;
    return [{ name: `critic5 pluck room: ${rn}`, kind: 'S' as Kind, n: 1, acc: 0, tta: [], oct: 0, fails: bad, ok: bad.length === 0, summary: bad.length ? `${summary} — ${bad.join('; ')}` : summary }];
  });
});
// (3) Our own and the earlier reviews' guitar and voice stimuli through three rooms and a phone
// chain (fresh matcher, like the anechoic groups above).
const OWN_ROOMS: [string, Room5 | null, boolean][] = [
  ['dead room RT 0.25 s, 0.5 m', makeRoom(3, 0.25, 61), false],
  ['living room RT 0.6 s, 1 m', makeRoom(0, 0.6, 62), false],
  ['live room RT 0.7 s, 2 m', makeRoom(-6, 0.7, 63), false],
  ['phone chain (hp 150, lp 3.4k) in the living room', makeRoom(0, 0.6, 64), true],
];
function inRoom(x: Float32Array, room: Room5 | null, phone: boolean, seed: number): { buf: Float32Array; onset: number } {
  let y = reverb5(x, room);
  if (phone) {
    const f = [new BQ('hp', 150, 0.707), new BQ('lp', 3400, 0.54), new BQ('lp', 3400, 1.3)];
    y = Float32Array.from(y, (v) => f.reduce((a, q) => q.s(a), v));
  }
  let pk = 0;
  for (const v of y) pk = Math.max(pk, Math.abs(v));
  const out = S3.white(S3.silence(0.7 + y.length / SR + 0.2, SR), -62, seed);
  const g = S3.db2a(-16) / (pk || 1);
  for (let i = 0; i < y.length; i++) out[Math.floor(0.7 * SR) + i] += g * y[i];
  return { buf: out, onset: 0.7 };
}
const OWN_GUITARS: [string, (m: number, s: number) => Float32Array][] = [
  ['own KS3 pick', (m, s) => S3.ks(m, 2.0, { sr: SR, seed: s })],
  ['own additive', (m, s) => guitar(m, 2.0, { sr: SR, seed: s })],
  ['critic3 modal guitar', (m, s) => gtr3(m, 2.0, { sr: SR, seed: s })],
  ['critic4 waveguide steel', (m, s) => wg4(m, 2.0, { sr: SR, seed: s })],
  ['critic4 waveguide thumb', (m, s) => wg4(m, 2.0, { sr: SR, seed: s, hard: 0, attackMs: 25, pick: 0.3 })],
  ['critic4 nylon', (m, s) => wg4(m, 2.0, { sr: SR, seed: s, kind: 'nylon', hard: 0.2 })],
];
const OWN_VOICES: [string, (m: number, s: number) => Float32Array][] = [
  ['own voice "a" (vibrato)', (m, s) => S3.vo(m, 1.6, { sr: SR, seed: s, vowel: 'a', vibCents: 20 } as never)],
  ['critic4 hum "mm"', (m, s) => voice4(m, 1.6, { sr: SR, seed: s, vowel: 'm', levelDb: -24 })],
  ['critic4 sung "la"', (m, s) => voice4(m, 1.6, { sr: SR, seed: s, vowel: 'a', attackMs: 25 })],
];
for (const [rn, room, phone] of OWN_ROOMS) {
  job(`rooms: own guitars, ${rn}`, 3, rn.startsWith('living'), (quick) => {
    const out: GroupResult[] = [];
    for (const [gn, mk] of OWN_GUITARS) {
      const g = new Group(`rooms P ${gn}, ${rn}`, 'P');
      for (const m of pickNotes(GM, quick, 3)) {
        const fx = inRoom(mk(m, m + 5), room, phone, m);
        g.add(noteName(m), runCfg(framesOf(fx.buf, 'guitar'), guitarConfig(m), 0.3), fx.onset);
      }
      out.push(g.r);
    }
    return out;
  });
  job(`rooms: own voices, ${rn}`, 3, rn.startsWith('living'), (quick) => {
    const out: GroupResult[] = [];
    for (const [vn, mk] of OWN_VOICES) {
      const sing = new Group(`rooms P ${vn} passes the singing step, ${rn}`, 'P');
      const play = new Group(`rooms N ${vn} — accepted by the guitar step, ${rn}`, 'N');
      for (const m of pickNotes(VM, quick, 3)) {
        const fx = inRoom(mk(m, m + 9), room, phone, m);
        sing.add(noteName(m), runCfg(framesOf(fx.buf, 'voice'), singConfig(m, 50, false), 0.3), fx.onset);
        play.add(noteName(m), runCfg(framesOf(fx.buf, 'guitar'), guitarConfig(m), 0.3), fx.onset);
      }
      out.push(sing.r, play.r);
    }
    return out;
  });
}

// ========================================================================== in-session pitch bias
// A detector that has heard a realistic session must read a new pluck as a fresh one does.
job('in-session bias: state learned in a session vs fresh detector', 10, true, (quick) => {
  const snaps = sessionSnapshots(quick ? 12 : 61, quick ? [2, 10] : [2, 10, 30, 60]);
  const rows = biasTable(snaps, quick ? [40, 52, 64, 76] : BIAS_NOTES);
  // (a reading off by a large interval — the faint high E read as its fifth above — is a detector
  // limit on that note that comes and goes with the noise, counted separately)
  const off = (c: number | null) => c === null || Math.abs(c) >= 100;
  const usable = rows.filter((r) => !off(r.fresh) && r.state.every((c) => !off(c)));
  const misreads = rows.filter((r) => off(r.fresh) || r.state.some(off)).map((r) => `${r.synth} ${r.midi} ${r.level} dBFS`);
  const worst = usable.reduce((a, r) => (r.worst > a.worst ? r : a), usable[0]);
  const bad = usable.filter((r) => r.worst > 3);
  const summary = `${usable.length} note/level/synth cases, ${snaps.length} session snapshots: worst |in-session − fresh| ${worst.worst.toFixed(1)} c (${worst.synth} midi ${worst.midi} at ${worst.level} dBFS)${misreads.length ? `; interval misreads (fresh or in session) on ${misreads.join(', ')}` : ''}`;
  return [{ name: 'in-session bias (target ≤ 3 c everywhere)', kind: 'S', n: 1, acc: 0, tta: [], oct: 0, fails: bad.map((r) => `${r.synth} ${r.midi} ${r.level} dBFS: ${r.worst.toFixed(1)} c`), ok: bad.length === 0, summary: bad.length ? `${summary} — ${bad.length} over 3 c` : summary }];
});

export function allJobs(): Job[] {
  return jobs;
}
void mixInto;
void PRE2;
