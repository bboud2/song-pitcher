// Single-note conditions from the round-2 independent review (ported verbatim as permanent gauntlet
// cases): guitar techniques/rooms (G) and singing styles/rooms (V), built on fixtures3.ts.
// Single-note conditions through the real front end (StreamAnalyzer) and NoteMatcher configs.
import { FRAME_SIZE, HOP_MS, StreamAnalyzer, guitarConfig } from '../src/core/engine.ts';
import { NoteMatcher, type PitchFrame } from '../src/core/matcher.ts';
import * as S from './fixtures3.ts';

const FLOOR = -62;
export function frames(buf: Float32Array, sr: number, path: 'voice' | 'guitar', jitter?: () => number): PitchFrame[] {
  const sa = new StreamAnalyzer(sr); const out: PitchFrame[] = []; let pos = 0;
  for (;;) {
    const hop = Math.round(((jitter ? jitter() : HOP_MS) / 1000) * sr);
    if (pos + hop > buf.length) break;
    // push in 128-sample quanta like a render thread would; equivalent to one push
    sa.push(buf.subarray(pos, pos + hop)); pos += hop;
    if (pos < FRAME_SIZE) continue;
    out.push(sa.frame(path, pos / sr));
  }
  return out;
}
export function run(fr: PitchFrame[], cfg: ReturnType<typeof guitarConfig>, from = 0): number | null {
  const m = new NoteMatcher(cfg);
  for (const f of fr) { if (f.t < from) continue; const s = m.push(f); if (s.accepted) return s.acceptedAt; }
  return null;
}
export interface Fx { buf: Float32Array; onset: number; sr: number; midi: number; jitter?: () => number; from?: number }
export type Cond = (m: number, seed: number) => Fx;
export const SR = 48000;
export const pre = 0.7;
export function wrap(note: Float32Array, sr: number, seed: number, onsetIn = 0, tail = 0.4): Fx {
  const buf = S.cat(S.silence(pre, sr), note, S.silence(tail, sr));
  S.white(buf, FLOOR, seed + 77);
  return { buf, onset: pre + onsetIn, sr, midi: 0 };
}
const R = (seed: number) => S.rng(seed * 31 + 5);
export function gbase(m: number, seed: number, o: Partial<S.KsOpts> = {}, dur = 2.0, sr = SR): Float32Array {
  const r = R(seed);
  return S.ks(m, dur, { sr, seed, decayDbS: 9 + 9 * r(), cents: (r() * 2 - 1) * 8, peak: 0.2, ...o });
}
export const G: Record<string, Cond> = {
  'base pick, -14 dBFS peak': (m, s) => wrap(gbase(m, s), SR, s),
  'sustain ~2 dB/s (1 polarisation)': (m, s) => wrap(gbase(m, s, { decayDbS: 2, pol2: 0, dull: 0.02, pickNoise: 0.05 }), SR, s),
  'sustain ~3 dB/s': (m, s) => wrap(gbase(m, s, { decayDbS: 3, pol2: 0, dull: 0.02, pickNoise: 0.05 }), SR, s),
  'sustain ~4 dB/s': (m, s) => wrap(gbase(m, s, { decayDbS: 4, pol2: 0, dull: 0.02, pickNoise: 0.05 }), SR, s),
  'sustain ~6 dB/s': (m, s) => wrap(gbase(m, s, { decayDbS: 6, pol2: 0, dull: 0.02, pickNoise: 0.05 }), SR, s),
  'sustain ~8 dB/s': (m, s) => wrap(gbase(m, s, { decayDbS: 8, pol2: 0, dull: 0.02, pickNoise: 0.05 }), SR, s),
  'compressor 8:1 (pedal)': (m, s) => { const f = wrap(gbase(m, s), SR, s); f.buf = S.compress(f.buf, SR, -45, 8, 14); return f; },
  'compressor 3:1': (m, s) => { const f = wrap(gbase(m, s), SR, s); f.buf = S.compress(f.buf, SR, -40, 3, 8); return f; },
  'phone AGC slow (6 dB/s)': (m, s) => { const f = wrap(gbase(m, s), SR, s); f.buf = S.agc(f.buf, SR, -20, 6); return f; },
  'phone AGC medium (12 dB/s)': (m, s) => { const f = wrap(gbase(m, s), SR, s); f.buf = S.agc(f.buf, SR, -20, 12); return f; },
  'phone AGC fast (25 dB/s)': (m, s) => { const f = wrap(gbase(m, s), SR, s); f.buf = S.agc(f.buf, SR, -20, 25); return f; },
  'vibrato +-20c 5 Hz': (m, s) => wrap(gbase(m, s, { semis: (t) => (t > 0.12 ? 0.2 * Math.sin(6.283 * 5 * (t - 0.12)) : 0) }), SR, s),
  'vibrato +-35c 6 Hz': (m, s) => wrap(gbase(m, s, { semis: (t) => (t > 0.12 ? 0.35 * Math.sin(6.283 * 6 * (t - 0.12)) : 0) }), SR, s),
  'bend up a semitone over 0.3 s, hold': (m, s) => wrap(gbase(m, s, { semis: (t) => -1 + Math.min(1, Math.max(0, (t - 0.05) / 0.3)) }), SR, s),
  'hammer-on from 2 frets below': (m, s) => wrap(gbase(m, s, { semis: (t) => (t < 0.6 ? -2 : 0), taps: [[0.6, 0.12]] }, 2.4), SR, s, 0.6),
  'pull-off from 2 frets above': (m, s) => wrap(gbase(m, s, { semis: (t) => (t < 0.6 ? 2 : 0), taps: [[0.6, 0.25]] }, 2.4), SR, s, 0.6),
  'slide up 3 frets in 0.25 s, stop': (m, s) => wrap(gbase(m, s, { semis: (t) => -3 + 3 * Math.min(1, t / 0.25) }), SR, s),
  'fingerstyle soft (30 ms attack, dull)': (m, s) => wrap(gbase(m, s, { attack: 0.03, dull: 0.55, pickNoise: 0 }), SR, s),
  'palm mute (t60 0.4 s)': (m, s) => wrap(gbase(m, s, { decayDbS: 150, fastDecayDbS: 200, dull: 0.5 }, 1.2), SR, s),
  'staccato (damped after 0.25 s)': (m, s) => { const n = gbase(m, s, {}, 0.25); S.fadeOut(n, SR, 40); return wrap(n, SR, s, 0, 1.5); },
  'staccato (damped after 0.4 s)': (m, s) => { const n = gbase(m, s, {}, 0.4); S.fadeOut(n, SR, 40); return wrap(n, SR, s, 0, 1.5); },
  'natural harmonic (near sine, slow decay)': (m, s) => wrap(gbase(m, s, { pure: true, pol2: 0, dull: 0.02, decayDbS: 5, pickNoise: 0.1 }), SR, s),
  'beating 2.5 Hz (two polarisations equal)': (m, s) => wrap(gbase(m, s, { beatHz: 2.5, pol2: 0.9, decayDbS: 10, fastDecayDbS: 10 }), SR, s),
  'beating 5 Hz': (m, s) => wrap(gbase(m, s, { beatHz: 5, pol2: 0.9, decayDbS: 10, fastDecayDbS: 10 }), SR, s),
  'beating 1 Hz': (m, s) => wrap(gbase(m, s, { beatHz: 1, pol2: 0.9, decayDbS: 10, fastDecayDbS: 10 }), SR, s),
  'open string ringing sympathetically (-12 dB)': (m, s) => {
    const n = gbase(m, s); const open = [40, 45, 50, 55].reduce((a, b) => (Math.abs(b - (m - 12)) < Math.abs(a - (m - 12)) ? b : a));
    const sy = S.ks(open, 2.0, { sr: SR, seed: s + 5, decayDbS: 5, pol2: 0.2, attack: 0.08, pickNoise: 0, peak: 0.05 });
    return wrap(S.mixAt(n, sy, 0.01, SR), SR, s);
  },
  'previous note (2 frets up) still ringing': (m, s) => {
    const p = gbase(m + 2, s + 9, { decayDbS: 8 }, 2.8); const n = gbase(m, s, {}, 2.0);
    return wrap(S.mixAt(p, n, 0.8, SR), SR, s, 0.8);
  },
  'previous note (fifth below) still ringing': (m, s) => {
    const p = gbase(m - 7, s + 9, { decayDbS: 6 }, 2.8); const n = gbase(m, s, {}, 2.0);
    return wrap(S.mixAt(p, n, 0.8, SR), SR, s, 0.8);
  },
  'previous note (octave below) still ringing': (m, s) => {
    const p = gbase(m - 12, s + 9, { decayDbS: 6 }, 2.8); const n = gbase(m, s, {}, 2.0);
    return wrap(S.mixAt(p, n, 0.8, SR), SR, s, 0.8);
  },
  'same note re-plucked after 0.8 s (still ringing)': (m, s) => {
    const p = gbase(m, s + 9, { decayDbS: 8 }, 2.8); const n = gbase(m, s, {}, 2.0);
    const f = wrap(S.mixAt(p, n, 0.8, SR), SR, s, 0.8); f.from = pre + 0.5; return f; // matcher starts after first pluck
  },
  'pick scratch / muted strum 0.2 s before': (m, s) => {
    const n = S.cat(S.silence(0.3, SR), gbase(m, s)); const r = R(s + 3);
    for (let k = 0; k < 3; k++) { const b = S.biquad(S.white(S.silence(0.03, SR), -26, s + k), SR, 'hp', 800); S.fadeOut(b, SR, 20); S.mixAt(n, b, 0.05 + k * 0.05 + 0.02 * r(), SR); }
    return wrap(n, SR, s, 0.3);
  },
  'quiet: -30 dBFS peak': (m, s) => wrap(gbase(m, s, { peak: S.db2a(-30) }), SR, s),
  'quiet: -40 dBFS peak': (m, s) => wrap(gbase(m, s, { peak: S.db2a(-40) }), SR, s),
  'quiet: -46 dBFS peak': (m, s) => wrap(gbase(m, s, { peak: S.db2a(-46) }), SR, s),
  'reverb RT60 0.5 s': (m, s) => { const f = wrap(gbase(m, s), SR, s); f.buf = S.reverb(f.buf, SR, 0.5, -6, s); return f; },
  'reverb RT60 1.0 s': (m, s) => { const f = wrap(gbase(m, s), SR, s); f.buf = S.reverb(f.buf, SR, 1.0, -3, s); return f; },
  'reverb RT60 1.8 s (tiled room)': (m, s) => { const f = wrap(gbase(m, s), SR, s); f.buf = S.reverb(f.buf, SR, 1.8, 0, s); return f; },
  'hum 60 Hz -50 dBFS': (m, s) => { const f = wrap(gbase(m, s), SR, s); S.hum(f.buf, SR, 60, -50); return f; },
  'hum 60 Hz -40 dBFS': (m, s) => { const f = wrap(gbase(m, s), SR, s); S.hum(f.buf, SR, 60, -40); return f; },
  'hum 60 Hz -30 dBFS': (m, s) => { const f = wrap(gbase(m, s), SR, s); S.hum(f.buf, SR, 60, -30); return f; },
  'hum 50 Hz -40 dBFS': (m, s) => { const f = wrap(gbase(m, s), SR, s); S.hum(f.buf, SR, 50, -40); return f; },
  'hum 50 Hz -30 dBFS': (m, s) => { const f = wrap(gbase(m, s), SR, s); S.hum(f.buf, SR, 50, -30); return f; },
  'fan noise -45 dBFS': (m, s) => { const f = wrap(gbase(m, s), SR, s); S.fan(f.buf, SR, -45, s); return f; },
  'fan noise -35 dBFS': (m, s) => { const f = wrap(gbase(m, s), SR, s); S.fan(f.buf, SR, -35, s); return f; },
  'white noise -40 dBFS': (m, s) => { const f = wrap(gbase(m, s), SR, s); S.white(f.buf, -40, s); return f; },
  'TV speech -40 dBFS rms': (m, s) => { const f = wrap(gbase(m, s), SR, s); const t = S.tv(f.buf.length / SR, SR, s); S.mixAt(f.buf, t, 0, SR, S.db2a(-40) / S.rms(t)); return f; },
  'TV speech -30 dBFS rms': (m, s) => { const f = wrap(gbase(m, s), SR, s); const t = S.tv(f.buf.length / SR, SR, s); S.mixAt(f.buf, t, 0, SR, S.db2a(-30) / S.rms(t)); return f; },
  'metronome click 120 bpm -20 dBFS': (m, s) => { const f = wrap(gbase(m, s), SR, s); S.clicks(f.buf, SR, 120, -20); return f; },
  '44.1 kHz': (m, s) => wrap(gbase(m, s, {}, 2.0, 44100), 44100, s),
  'phone mic high-pass 180 Hz (4th order)': (m, s) => { const f = wrap(gbase(m, s), SR, s); f.buf = S.biquad(S.biquad(f.buf, SR, 'hp', 180), SR, 'hp', 180); return f; },
  'clipping (+18 dB into full scale)': (m, s) => { const f = wrap(gbase(m, s), SR, s); f.buf = S.clip(f.buf, 18); return f; },
  'timer jitter: hops 20-45 ms': (m, s) => { const f = wrap(gbase(m, s), SR, s); const r = R(s + 1); f.jitter = () => 20 + 25 * r(); return f; },
  'slow timer: hops 40 ms': (m, s) => { const f = wrap(gbase(m, s), SR, s); f.jitter = () => 40; return f; },
  'slow timer: hops 33 ms': (m, s) => { const f = wrap(gbase(m, s), SR, s); f.jitter = () => 33.3; return f; },
  'timer stalls: 20 ms hops, 120 ms stall every ~0.5 s': (m, s) => { const f = wrap(gbase(m, s), SR, s); const r = R(s + 2); let k = 0; f.jitter = () => (++k % 22 === Math.floor(r() * 3) ? 120 : 20); return f; },
};

export function vbase(m: number, seed: number, dur = 1.5, o: Partial<S.VoOpts> = {}, sr = SR): Float32Array {
  const r = R(seed + 100); const vw = (['a', 'o', 'u', 'e', 'm'] as const)[Math.floor(r() * 5)];
  const off = (r() * 2 - 1) * 12; const sem = o.semis;
  return S.vo(m, dur, { sr, seed, vowel: vw, vibCents: 10 + 20 * r(), peak: 0.12, ...o, semis: (t) => off / 100 + (sem ? sem(t) : 0) });
}
export const V: Record<string, Cond> = {
  'base 1.5 s, vibrato 10-30c': (m, s) => wrap(vbase(m, s), SR, s),
  'short note 0.35 s': (m, s) => wrap(vbase(m, s, 0.35), SR, s, 0, 1.2),
  'short note 0.6 s': (m, s) => wrap(vbase(m, s, 0.6), SR, s, 0, 1.2),
  'short note 0.8 s': (m, s) => wrap(vbase(m, s, 0.8), SR, s, 0, 1.2),
  'staccato da-da-da-da (4 x 0.25 s, 0.12 s gaps)': (m, s) => { const b = S.silence(1.6, SR); for (let k = 0; k < 4; k++) S.mixAt(b, vbase(m, s + k, 0.25, { attack: 0.015, release: 0.05 }), k * 0.37, SR); return wrap(b, SR, s); },
  'staccato da x4 (0.45 s each, 0.15 s gaps)': (m, s) => { const b = S.silence(2.5, SR); for (let k = 0; k < 4; k++) S.mixAt(b, vbase(m, s + k, 0.45, { attack: 0.015, release: 0.08 }), k * 0.6, SR); return wrap(b, SR, s); },
  'fades out -6 dB/s from the start': (m, s) => wrap(vbase(m, s, 1.8, { env: (t) => S.db2a(-6 * t) }), SR, s),
  'fades out -10 dB/s from the start': (m, s) => wrap(vbase(m, s, 1.8, { env: (t) => S.db2a(-10 * t) }), SR, s),
  'fades out -15 dB/s from the start': (m, s) => wrap(vbase(m, s, 1.8, { env: (t) => S.db2a(-15 * t) }), SR, s),
  'accented start: +8 dB falling over 0.25 s, then steady': (m, s) => wrap(vbase(m, s, 1.5, { attack: 0.012, env: (t) => S.db2a(8 * Math.exp(-t / 0.1)) }), SR, s),
  'accented, then -8 dB/s (a sung "dah" dying away)': (m, s) => wrap(vbase(m, s, 1.3, { attack: 0.012, env: (t) => S.db2a(6 * Math.exp(-t / 0.08) - 8 * t) }), SR, s),
  'short accented "da" 0.5 s, natural 20 dB/s decay': (m, s) => wrap(vbase(m, s, 0.5, { attack: 0.012, release: 0.1, env: (t) => S.db2a(-20 * t) }), SR, s, 0, 1.2),
  'short accented "da" 0.5 s, 12 dB/s decay': (m, s) => wrap(vbase(m, s, 0.5, { attack: 0.012, release: 0.1, env: (t) => S.db2a(-12 * t) }), SR, s, 0, 1.2),
  'short "da" 0.4 s, 30 dB/s decay': (m, s) => wrap(vbase(m, s, 0.4, { attack: 0.01, release: 0.1, env: (t) => S.db2a(-30 * t) }), SR, s, 0, 1.2),
  'out of breath: 0.5 s steady then -25 dB/s, pitch sags 40c': (m, s) => wrap(vbase(m, s, 1.5, { env: (t) => S.db2a(-25 * Math.max(0, t - 0.5)), semis: (t) => -0.4 * Math.max(0, t - 0.5) }), SR, s),
  'out of breath: 0.3 s steady then -25 dB/s': (m, s) => wrap(vbase(m, s, 1.2, { env: (t) => S.db2a(-25 * Math.max(0, t - 0.3)) }), SR, s),
  '"ta": noise burst + 10 ms attack': (m, s) => { const n = S.cat(S.silence(0.05, SR), vbase(m, s, 1.4, { attack: 0.01 })); S.mixAt(n, S.fadeOut(S.biquad(S.white(S.silence(0.04, SR), -22, s), SR, 'hp', 2500), SR, 25), 0.01, SR); return wrap(n, SR, s, 0.05); },
  '"doo": scoop from 150c flat over 0.12 s': (m, s) => wrap(vbase(m, s, 1.5, { semis: (t) => -1.5 * Math.max(0, 1 - t / 0.12), vowel: 'u' }), SR, s),
  'scoop from 3 semitones below over 0.25 s': (m, s) => wrap(vbase(m, s, 1.6, { semis: (t) => -3 * Math.max(0, 1 - t / 0.25) }), SR, s),
  'falsetto (near sine, breathy)': (m, s) => wrap(vbase(m + 12, s, 1.5, { tilt: 1.3, breath: 0.12, vowel: 'u' }), SR, s),
  'vocal fry 50%': (m, s) => wrap(vbase(m, s, 1.5, { fry: 0.5, jitter: 0.01 }), SR, s),
  'vocal fry 85%': (m, s) => wrap(vbase(m, s, 1.5, { fry: 0.85, jitter: 0.015 }), SR, s),
  'child / woman octave up (+12, formants x1.2)': (m, s) => wrap(vbase(m + 12, s, 1.5, { formantScale: 1.2 }), SR, s),
  'low bass octave down (-12)': (m, s) => wrap(vbase(m - 12, s, 1.5, {}), SR, s),
  'wide vibrato +-60c 6 Hz': (m, s) => wrap(vbase(m, s, 1.6, { vibCents: 60, vibHz: 6 }), SR, s),
  'tremolo +-3 dB 5.5 Hz': (m, s) => wrap(vbase(m, s, 1.5, { env: (t) => S.db2a(3 * Math.sin(6.283 * 5.5 * t)) }), SR, s),
  'crescendo +12 dB over 1.5 s': (m, s) => wrap(vbase(m, s, 1.5, { env: (t) => S.db2a(-12 + 8 * t) }), SR, s),
  'quiet singing -40 dBFS peak': (m, s) => wrap(vbase(m, s, 1.5, { peak: S.db2a(-40) }), SR, s),
  'breathy quiet -36 dBFS peak': (m, s) => wrap(vbase(m, s, 1.5, { peak: S.db2a(-36), breath: 0.2 }), SR, s),
  'over own guitar note still ringing (same note, -6 dB)': (m, s) => { const g = gbase(m, s, { peak: 0.06, decayDbS: 7 }, 2.4); const f = wrap(S.mixAt(g, vbase(m, s), 0.6, SR), SR, s, 0.6); f.from = pre + 0.3; return f; },
  'over previous guitar note ringing (different note, -6 dB)': (m, s) => { const g = gbase(m + 4, s, { peak: 0.06, decayDbS: 7 }, 2.4); const f = wrap(S.mixAt(g, vbase(m, s), 0.6, SR), SR, s, 0.6); f.from = pre + 0.3; return f; },
  'already singing when the step opens (sang along with the tone)': (m, s) => { const f = wrap(vbase(m, s, 2.0), SR, s); f.from = pre + 0.5; f.onset = pre + 0.5; return f; },
  'whistling two octaves up': (m, s) => wrap(S.whistle(m + 24, 1.5, SR, s), SR, s),
  'reverb RT60 1.0 s': (m, s) => { const f = wrap(vbase(m, s), SR, s); f.buf = S.reverb(f.buf, SR, 1.0, -3, s); return f; },
  'reverb RT60 1.8 s': (m, s) => { const f = wrap(vbase(m, s), SR, s); f.buf = S.reverb(f.buf, SR, 1.8, 0, s); return f; },
  'hum 60 Hz -40 dBFS': (m, s) => { const f = wrap(vbase(m, s), SR, s); S.hum(f.buf, SR, 60, -40); return f; },
  'hum 50 Hz -30 dBFS': (m, s) => { const f = wrap(vbase(m, s), SR, s); S.hum(f.buf, SR, 50, -30); return f; },
  'fan noise -35 dBFS': (m, s) => { const f = wrap(vbase(m, s), SR, s); S.fan(f.buf, SR, -35, s); return f; },
  'TV speech -30 dBFS rms': (m, s) => { const f = wrap(vbase(m, s), SR, s); const t = S.tv(f.buf.length / SR, SR, s); S.mixAt(f.buf, t, 0, SR, S.db2a(-30) / S.rms(t)); return f; },
  'metronome click 120 bpm -20 dBFS': (m, s) => { const f = wrap(vbase(m, s), SR, s); S.clicks(f.buf, SR, 120, -20); return f; },
  '44.1 kHz': (m, s) => wrap(vbase(m, s, 1.5, {}, 44100), 44100, s),
  'phone mic high-pass 180 Hz': (m, s) => { const f = wrap(vbase(m, s), SR, s); f.buf = S.biquad(S.biquad(f.buf, SR, 'hp', 180), SR, 'hp', 180); return f; },
  'clipping (+20 dB)': (m, s) => { const f = wrap(vbase(m, s), SR, s); f.buf = S.clip(f.buf, 20); return f; },
  'phone AGC medium': (m, s) => { const f = wrap(vbase(m, s), SR, s); f.buf = S.agc(f.buf, SR, -20, 12); return f; },
  'timer jitter: hops 20-45 ms': (m, s) => { const f = wrap(vbase(m, s), SR, s); const r = R(s + 1); f.jitter = () => 20 + 25 * r(); return f; },
  'slow timer: hops 40 ms': (m, s) => { const f = wrap(vbase(m, s), SR, s); f.jitter = () => 40; return f; },
};

