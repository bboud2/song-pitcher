// @ts-nocheck (ported review tooling, kept as written)
// Twelfth review (ported unchanged except for where it finds the build; it writes to ./out of the
// directory it is run from).
// Critic-12 synthesis (own, from scratch): additive inharmonic guitar with two-stage decay, additive
// source-filter voice with level/pitch trajectories, modal+diffuse rooms, the app's reference tone
// (src/ui/audio.ts scheduleTone re-implemented) through speaker models, noise beds, bumps.
export const SR = 48000;
export function rng(seed: number) { let a = (seed * 2654435761 + 0x9e3779b9) >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function gauss(r: () => number) { let u = r(); if (u < 1e-12) u = 1e-12; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
export const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);
export const lin = (d: number) => 10 ** (d / 20);
export const dB = (x: number) => 20 * Math.log10(Math.max(1e-12, x));

/** RBJ biquad */
export class BQ {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0; z1 = 0; z2 = 0;
  constructor(kind: 'lp' | 'hp' | 'bp' | 'pk' | 'ls' | 'hs', f: number, q: number, g = 0) {
    const w = 2 * Math.PI * Math.min(f, SR * 0.45) / SR, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q), A = 10 ** (g / 40); let b0, b1, b2, a0, a1, a2;
    if (kind === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (kind === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (kind === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (kind === 'pk') { b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; }
    else { const sq = 2 * Math.sqrt(A) * al; if (kind === 'ls') { b0 = A * ((A + 1) - (A - 1) * c + sq); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - sq); a0 = (A + 1) + (A - 1) * c + sq; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - sq; } else { b0 = A * ((A + 1) + (A - 1) * c + sq); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - sq); a0 = (A + 1) - (A - 1) * c + sq; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - sq; } }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  p(x: number) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
  run(x: Float32Array) { const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = this.p(x[i]); return y; }
}
export function peakNorm(y: Float32Array, upto = y.length) { let pk = 1e-9; for (let i = 0; i < Math.min(upto, y.length); i++) { const a = Math.abs(y[i]); if (a > pk) pk = a; } for (let i = 0; i < y.length; i++) y[i] /= pk; return y; }
export function rmsNorm(y: Float32Array, from = 0, to = y.length) { let e = 0; for (let i = from; i < to; i++) e += y[i] * y[i]; const g = 1 / Math.sqrt(e / (to - from) + 1e-20); for (let i = 0; i < y.length; i++) y[i] *= g; return y; }

// ------------------------------------------------------------------ guitar (additive, inharmonic)
export interface GOpt { midi: number; cents?: number; type?: 'steel' | 'nylon' | 'electric'; touch?: 'pick' | 'finger' | 'thumb' | 'nail'; dur?: number; seed?: number; sustain?: number; bright?: number; buzz?: boolean; str?: number }
export const OPEN = [40, 45, 50, 55, 59, 64];
/** lowest-fret string in open position */
export function stringFor(m: number) { let s = 0; for (let i = 0; i < 6; i++) if (OPEN[i] <= m) s = i; return s; }
export function guitar(o: GOpt): Float32Array {
  const r = rng(7 * (o.seed ?? 1) + 131 * o.midi + 3); const type = o.type ?? 'steel', touch = o.touch ?? 'pick';
  const f0 = hz(o.midi + (o.cents ?? 0) / 100); const dur = o.dur ?? 4.5; const n = Math.floor(dur * SR); const y = new Float32Array(n);
  const s = o.str ?? stringFor(o.midi); const fretted = o.midi !== OPEN[s];
  const B = (type === 'nylon' ? 0.4 : 1) * [9e-5, 7e-5, 5e-5, 1.4e-4, 9e-5, 6e-5][s] * (hz(o.midi) / hz(OPEN[s])) ** 2;
  const pos = 0.13 + 0.14 * r(); // pluck point (fraction of the string)
  const roll = { pick: 0.9, nail: 1.1, finger: 1.6, thumb: 2.3 }[touch] + (type === 'nylon' ? 0.25 : 0) - (o.bright ?? 0);
  const atk = { pick: 0.0012, nail: 0.002, finger: 0.006, thumb: 0.016 }[touch];
  const t1 = (type === 'nylon' ? 1.1 : type === 'electric' ? 3.2 : 1.7) * (fretted ? 0.75 : 1.1) * Math.sqrt(160 / f0) * (o.sustain ?? 1); // amplitude time constant of the fundamental (s)
  const K = Math.min(48, Math.floor(9000 / f0));
  // body response (acoustic): air ~100 Hz, top ~200 Hz, plate ~400 Hz; electric: pickup lowpass
  const body = (f: number) => { if (type === 'electric') return 1 / Math.sqrt(1 + (f / 3500) ** 4); const pk = (fc: number, q: number, g: number) => 1 + g / (1 + ((f - fc) / (fc / q)) ** 2); return pk(type === 'nylon' ? 92 : 104, 5, 1.6) * pk(type === 'nylon' ? 185 : 208, 6, 1.2) * pk(410, 4, 0.7) * (f < 85 ? (f / 85) ** 2 : 1) / Math.sqrt(1 + (f / 5000) ** 2); };
  for (let k = 1; k <= K; k++) {
    const fk = k * f0 * Math.sqrt(1 + B * k * k); if (fk > 0.45 * SR) break;
    let a = Math.abs(Math.sin(Math.PI * k * pos)) / k ** roll * body(fk) * (0.8 + 0.4 * r());
    if (a < 1e-5) continue;
    const tau = t1 / (1 + 0.012 * k * k + 0.08 * k); const tauFast = tau * 0.18; const fastShare = 0.35 + 0.2 * r(); // two-stage decay
    const det = (r() - 0.5) * 0.5; const ph1 = 2 * Math.PI * r(), ph2 = 2 * Math.PI * r(); const w1 = 2 * Math.PI * fk / SR, w2 = 2 * Math.PI * (fk + det) / SR;
    const e1 = Math.exp(-1 / (tau * SR)), e2 = Math.exp(-1 / (tauFast * SR)); let g1 = a * (1 - fastShare), g2 = a * fastShare; const an = Math.floor(atk * SR * (1 + 0.3 / k));
    for (let i = 0; i < n; i++) { const on = i < an ? 0.5 - 0.5 * Math.cos(Math.PI * i / an) : 1; y[i] += on * (g1 * Math.sin(w1 * i + ph1) + g2 * Math.sin(w2 * i + ph2)); g1 *= e1; g2 *= e2; if (g1 + g2 < 1e-7) break; }
  }
  peakNorm(y, SR / 2);
  // contact noise
  if (touch === 'pick' || touch === 'nail') { const h = new BQ('hp', 2500, 0.7); const g = touch === 'pick' ? 0.45 : 0.2; for (let i = 0; i < 0.012 * SR; i++) y[i] += g * h.p(gauss(r)) * Math.exp(-i / (0.0025 * SR)); }
  else if (type !== 'electric') { const fb = type === 'nylon' ? 92 : 104; for (let i = 0; i < 0.1 * SR; i++) { const t = i / SR; y[i] += (touch === 'thumb' ? 0.3 : 0.15) * Math.exp(-t / 0.025) * Math.sin(2 * Math.PI * fb * t) * Math.min(1, t / 0.004); } }
  if (o.buzz) { const h = new BQ('bp', 3000, 1); for (let i = 0; i < Math.min(n, 0.5 * SR); i++) y[i] += 0.12 * h.p(gauss(r)) * Math.exp(-i / (0.15 * SR)) * (Math.sin(2 * Math.PI * f0 * i / SR) > 0.7 ? 1 : 0); }
  return y;
}

// ------------------------------------------------------------------ voice (additive source-filter)
const FORM: Record<string, number[][]> = { // [freq, bandwidth, gain dB]
  a: [[730, 90, 0], [1090, 110, -5], [2440, 160, -20], [3400, 200, -28]],
  o: [[500, 80, 0], [900, 100, -8], [2500, 160, -28], [3350, 200, -36]],
  u: [[330, 70, 0], [870, 90, -14], [2240, 150, -34], [3300, 200, -42]],
  i: [[290, 60, 0], [2250, 130, -16], [2900, 170, -20], [3500, 220, -30]],
  e: [[520, 80, 0], [1800, 120, -10], [2550, 160, -18], [3400, 200, -30]],
  m: [[260, 60, 0], [1100, 300, -26], [2300, 300, -36], [3300, 400, -44]],
  n: [[280, 70, 0], [1500, 300, -24], [2500, 300, -34], [3300, 400, -44]],
};
export interface VOpt {
  midi: number; cents?: number; dur: number; vowel?: string; seed?: number; sex?: 'm' | 'f' | 'c';
  /** onset: rise time (ms) of the level from nothing */ riseMs?: number;
  /** consonant in front: 'l','d','n','m','h' or none */ cons?: string;
  /** scoop from below (cents) settling with this time constant (ms) */ scoop?: number; scoopMs?: number;
  vib?: number; vibHz?: number; /** steady level fall (dB/s) */ fade?: number; /** pitch drift (cents/s) */ drift?: number; breathy?: number; relMs?: number;
  /** pitch trajectory override: breakpoints [t, midi] (linear in semitones, smoothed) */ traj?: number[][];
  /** level trajectory (dB) breakpoints [t, dB], multiplies the envelope */ lev?: number[][];
}
function interp(bp: number[][], t: number) { if (t <= bp[0][0]) return bp[0][1]; for (let i = 1; i < bp.length; i++) if (t <= bp[i][0]) { const u = (t - bp[i - 1][0]) / (bp[i][0] - bp[i - 1][0]); const s = u * u * (3 - 2 * u); return bp[i - 1][1] + s * (bp[i][1] - bp[i - 1][1]); } return bp[bp.length - 1][1]; }
export function voice(o: VOpt): Float32Array {
  const r = rng(o.seed ?? 1); const n = Math.floor((o.dur + (o.relMs ?? 100) / 1000 + 0.05) * SR); const y = new Float32Array(n);
  const sc = o.sex === 'c' ? 1.32 : o.sex === 'f' ? 1.17 : 1; const vowel = FORM[o.vowel ?? 'a']; const consF = o.cons === 'm' ? FORM.m : o.cons === 'n' || o.cons === 'l' || o.cons === 'd' ? FORM.n : null; const consDur = o.cons === 'm' || o.cons === 'n' ? 0.09 : o.cons === 'l' ? 0.06 : o.cons === 'd' ? 0.025 : 0;
  const rise = (o.riseMs ?? 70) / 1000, rel = (o.relMs ?? 100) / 1000; const tiltExp = 1.7 + 0.8 * (o.breathy ?? 0) + 0.2 * r();
  const vib = o.vib ?? 12 + 14 * r(), vhz = o.vibHz ?? 5 + 1.2 * r(), scoop = o.scoop ?? 20 + 60 * r(), scoopT = (o.scoopMs ?? 70) / 1000;
  const K = 40; const ph = new Float64Array(K + 1); const amp = new Float64Array(K + 1), ampT = new Float64Array(K + 1);
  let jit = 0, shim = 0, wow = 0; const BL = 48; const asp = new BQ('bp', 2200 * sc, 0.8); const asp2 = new BQ('hp', 900, 0.7); let f = hz(o.midi);
  const envAt = (fr: number, F: number[][]) => { let v = 0; for (const [fc, bw, g] of F) { const d = (fr - fc * sc) / (bw * sc); v += lin(g) / Math.sqrt(1 + d * d * 4); } return v; };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (i % BL === 0) {
      jit += 0.25 * (gauss(r) * 6 - jit); shim += 0.2 * (gauss(r) * 0.06 - shim); wow += 0.01 * (gauss(r) * 14 - wow);
      const base = o.traj ? interp(o.traj, t) : o.midi; const vOn = Math.min(1, Math.max(0, (t - 0.25) / 0.4));
      const cents = (o.cents ?? 0) - scoop * Math.exp(-t / scoopT) + vOn * vib * Math.sin(2 * Math.PI * vhz * t) + jit + wow + (o.drift ?? 0) * t;
      f = hz(base + cents / 100);
      const cmix = consF && t < consDur + 0.03 ? Math.min(1, Math.max(0, (t - consDur) / 0.03)) : 1;
      for (let k = 1; k <= K; k++) { const fk = k * f; if (fk > 6000) { ampT[k] = 0; continue; } const ev = cmix >= 1 ? envAt(fk, vowel) : cmix * envAt(fk, vowel) + (1 - cmix) * 0.6 * envAt(fk, consF!); ampT[k] = ev / k ** tiltExp * k; /* flow derivative: +6 dB/oct */ }
    }
    let e = t < o.dur ? Math.min(1, t / rise) : Math.max(0, 1 - (t - o.dur) / rel); e = e * e * (3 - 2 * e);
    e *= lin(-(o.fade ?? 0) * Math.max(0, t - rise)) * (o.lev ? lin(interp(o.lev, t)) : 1) * (1 + shim);
    let s = 0; const dph = f / SR;
    for (let k = 1; k <= K; k++) { amp[k] += 0.02 * (ampT[k] - amp[k]); if (amp[k] < 1e-6) continue; ph[k] += k * dph; if (ph[k] > 1) ph[k] -= Math.floor(ph[k]); s += amp[k] * Math.sin(2 * Math.PI * ph[k]); }
    const an = (0.015 + 0.12 * (o.breathy ?? 0)) * asp2.p(asp.p(gauss(r))) * (0.6 + 0.4 * Math.sin(2 * Math.PI * ph[1]));
    y[i] = e * (s + an);
  }
  // normalise by the steady part's RMS so that "level" means the same for all vowels
  rmsNorm(y, Math.min(n - 1, Math.floor(Math.min(o.dur * 0.3, rise + 0.05) * SR)), Math.min(n, Math.floor(Math.min(o.dur, rise + 0.6) * SR)));
  for (let i = 0; i < n; i++) y[i] *= 0.25;
  if (o.cons === 'd') { const h = new BQ('hp', 2200, 0.7); for (let i = 0; i < 0.012 * SR; i++) y[i] += 0.12 * h.p(gauss(r)) * Math.exp(-i / (0.003 * SR)); }
  if (o.cons === 'h') { const h = new BQ('bp', 1500, 0.6); const L = Math.floor(0.1 * SR); const pre = new Float32Array(n + L); for (let i = 0; i < L; i++) pre[i] = 0.05 * h.p(gauss(r)) * Math.sin(Math.PI * i / L) ** 2; for (let i = 0; i < n; i++) pre[i + L * 0.6 | 0] += y[i]; return pre; }
  return y;
}

/** speech-like babble: syllables with falling/rising pitch, fricatives, pauses. RMS-normalised over voiced parts. */
export function speech(sec: number, seed: number, sex: 'm' | 'f' = 'm'): Float32Array {
  const r = rng(seed * 13 + 5); const y = new Float32Array(Math.floor(sec * SR)); let t = 0.1; const base = sex === 'f' ? 57 : 45; const vw = ['a', 'o', 'u', 'i', 'e'], cs = ['', 'l', 'd', 'n', 'm', 'h', ''];
  const fr = new BQ('hp', 3500, 0.7);
  while (t < sec - 0.5) {
    const words = 3 + Math.floor(7 * r()); let m = base + 6 * r();
    for (let w = 0; w < words && t < sec - 0.4; w++) {
      const d = 0.07 + 0.2 * r(); const m0 = m + 3 * (r() - 0.5); const m1 = m0 + 4 * (r() - 0.6);
      const v = voice({ midi: m0, dur: d, vowel: vw[Math.floor(5 * r())], cons: cs[Math.floor(7 * r())], riseMs: 15 + 25 * r(), relMs: 35, vib: 0, scoop: 0, traj: [[0, m0], [d, m1]], seed: Math.floor(1e6 * r()), sex });
      const g = lin(-8 * r()); const s0 = Math.floor(t * SR); for (let i = 0; i < v.length && s0 + i < y.length; i++) y[s0 + i] += g * v[i];
      t += d + 0.02; if (r() < 0.3) { const L = Math.floor((0.04 + 0.08 * r()) * SR); const s1 = Math.floor(t * SR); for (let i = 0; i < L && s1 + i < y.length; i++) y[s1 + i] += 0.06 * fr.p(gauss(r)) * Math.sin(Math.PI * i / L); t += L / SR; }
      m -= 0.4;
    }
    t += 0.15 + 0.7 * r();
  }
  return y;
}

// ------------------------------------------------------------------ noises
export function bump(kind: string, seed = 1): Float32Array {
  const r = rng(seed * 101 + kind.length * 7); const n = Math.floor(0.8 * SR); const y = new Float32Array(n);
  if (kind === 'knock') { const f1 = 110 + 80 * r(), f2 = 260 + 150 * r(); for (let i = 0; i < n; i++) { const t = i / SR; y[i] = Math.exp(-t / 0.025) * Math.sin(2 * Math.PI * f1 * t) + 0.5 * Math.exp(-t / 0.012) * Math.sin(2 * Math.PI * f2 * t) + (t < 0.003 ? 0.7 * gauss(r) : 0); } }
  else if (kind === 'cough') { const b = new BQ('bp', 700, 0.5), b2 = new BQ('bp', 1800, 0.7); for (let i = 0; i < n; i++) { const t = i / SR; const e = (t < 0.01 ? t / 0.01 : Math.exp(-(t - 0.01) / 0.06)) + (t > 0.22 ? 0.5 * Math.exp(-(t - 0.22) / 0.07) * Math.min(1, (t - 0.22) / 0.01) : 0); const w = gauss(r); y[i] = e * (b.p(w) + 0.5 * b2.p(w)); } }
  else if (kind === 'page') { const h = new BQ('hp', 3000, 0.6); for (let i = 0; i < n; i++) { const t = i / SR; y[i] = t < 0.4 ? h.p(gauss(r)) * Math.sin(Math.PI * t / 0.4) ** 2 * (0.4 + 0.6 * Math.abs(Math.sin(55 * t + 3 * Math.sin(9 * t)))) : 0; } }
  else if (kind === 'chair') { const b = new BQ('bp', 420, 5), b2 = new BQ('bp', 95, 2); for (let i = 0; i < n; i++) { const t = i / SR; const w = gauss(r); y[i] = t < 0.35 ? (b.p(w) * (1 + 0.6 * Math.sin(2 * Math.PI * 11 * t)) + 2 * b2.p(w)) * Math.sin(Math.PI * t / 0.35) : 0; } }
  else if (kind === 'clap') { const b = new BQ('bp', 1500, 0.8); for (let i = 0; i < n; i++) { const t = i / SR; y[i] = b.p(gauss(r)) * Math.exp(-t / 0.012); } }
  else if (kind === 'door') { for (let i = 0; i < n; i++) { const t = i / SR; y[i] = Math.exp(-t / 0.09) * Math.sin(2 * Math.PI * 62 * t) + 0.4 * Math.exp(-t / 0.03) * Math.sin(2 * Math.PI * 180 * t) + (t < 0.006 ? 0.5 * gauss(r) : 0); } }
  else if (kind === 'breath') { const b = new BQ('bp', 1100, 0.5); for (let i = 0; i < n; i++) { const t = i / SR; y[i] = t < 0.5 ? b.p(gauss(r)) * Math.sin(Math.PI * t / 0.5) ** 2 : 0; } }
  else if (kind === 'thump') { for (let i = 0; i < n; i++) { const t = i / SR; y[i] = Math.exp(-t / 0.05) * Math.sin(2 * Math.PI * 104 * t) * Math.min(1, t / 0.002) + 0.3 * Math.exp(-t / 0.02) * Math.sin(2 * Math.PI * 205 * t); } } // hand on the guitar body
  return peakNorm(y);
}
/** steady beds, `sec` long, RMS 1 */
export function bed(kind: 'fan' | 'traffic' | 'hum' | 'hiss', sec: number, seed = 1): Float32Array {
  const r = rng(seed * 17 + kind.length); const n = Math.floor(sec * SR); const y = new Float32Array(n);
  if (kind === 'fan') { const l = new BQ('lp', 700, 0.6), h = new BQ('hp', 60, 0.7); for (let i = 0; i < n; i++) { const t = i / SR; y[i] = h.p(l.p(gauss(r))) * (1 + 0.15 * Math.sin(2 * Math.PI * 23 * t)) + 0.05 * Math.sin(2 * Math.PI * 100 * t) + 0.03 * Math.sin(2 * Math.PI * 200 * t + 1) + 0.02 * Math.sin(2 * Math.PI * 300 * t); } }
  else if (kind === 'traffic') { const l = new BQ('lp', 250, 0.6), l2 = new BQ('lp', 1200, 0.6); let sw = 0; for (let i = 0; i < n; i++) { const t = i / SR; if (i % 480 === 0) sw += 0.02 * (gauss(r) * 2 - sw); const w = gauss(r); y[i] = (l.p(w) + 0.15 * l2.p(w)) * (1 + 0.5 * Math.sin(2 * Math.PI * t / 7 + 1) + 0.4 * sw); } }
  else if (kind === 'hum') { for (let i = 0; i < n; i++) { const t = i / SR; y[i] = Math.sin(2 * Math.PI * 50 * t) + 0.5 * Math.sin(2 * Math.PI * 100 * t + 1) + 0.3 * Math.sin(2 * Math.PI * 150 * t + 2) + 0.1 * Math.sin(2 * Math.PI * 250 * t); } }
  else { for (let i = 0; i < n; i++) y[i] = gauss(r); }
  return rmsNorm(y);
}
/** TV: speech over a quiet music bed (sustained chords with a tune), RMS 1 */
export function tv(sec: number, seed = 1, music = 0.5): Float32Array {
  const r = rng(seed * 29 + 1); const n = Math.floor(sec * SR); const y = new Float32Array(n); const sp = speech(sec, seed * 3 + 1, r() < 0.5 ? 'm' : 'f'); rmsNorm(sp);
  for (let i = 0; i < n; i++) y[i] = sp[i];
  if (music > 0) { let t = 0; const roots = [45, 50, 52, 48, 53]; while (t < sec) { const d = 0.9 + 1.2 * r(); const root = roots[Math.floor(5 * r())]; const ms = [root, root + 7, root + 12 + (r() < 0.5 ? 4 : 3), root + 19 + Math.floor(5 * r())]; const s0 = Math.floor(t * SR), L = Math.floor(d * SR); for (const m of ms) { const f = hz(m); const ph = 2 * Math.PI * r(); for (let i = 0; i < L && s0 + i < n; i++) { const tt = i / SR; const e = Math.min(1, tt / 0.03) * Math.min(1, (d - tt) / 0.08) * Math.exp(-tt / 1.5); y[s0 + i] += music * 0.35 * e * (Math.sin(2 * Math.PI * f * tt + ph) + 0.4 * Math.sin(4 * Math.PI * f * tt) + 0.2 * Math.sin(6 * Math.PI * f * tt)); } } t += d; } }
  const sp1 = new BQ('hp', 180, 0.7).run(y); return rmsNorm(sp1);
}

// ------------------------------------------------------------------ the app's reference tone
// src/ui/audio.ts scheduleTone: periodic wave [1,.42,.22,.12,.07,.04,.025,.015], lowpass min(6000, 9f) Q 0.4,
// gain: 0.0001 -> linear to 0.34 at 15 ms -> exp to 0.22 at 180 ms -> hold to max(0.19, dur-0.05) -> exp to 0.0001 at dur+0.3
export function refTone(midi: number, dur: number, speaker: 'phone' | 'smallphone' | 'tablet' | 'flat' = 'phone'): Float32Array {
  const H = [1, 0.42, 0.22, 0.12, 0.07, 0.04, 0.025, 0.015]; const f = hz(midi); const n = Math.floor((dur + 0.36) * SR); let osc = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR; let s = 0; for (let k = 0; k < 8; k++) s += H[k] * Math.sin(2 * Math.PI * (k + 1) * f * t); osc[i] = s; }
  osc = new BQ('lp', Math.min(6000, 9 * f), 0.4).run(osc);
  const hold = Math.max(0.19, dur - 0.05), end = dur + 0.3;
  for (let i = 0; i < n; i++) { const t = i / SR; let e; if (t < 0.015) e = 0.0001 + (0.34 - 0.0001) * t / 0.015; else if (t < 0.18) e = 0.34 * (0.22 / 0.34) ** ((t - 0.015) / 0.165); else if (t < hold) e = 0.22; else if (t < end) e = 0.22 * (0.0001 / 0.22) ** ((t - hold) / (end - hold)); else e = 0; osc[i] *= e; }
  let y = osc;
  if (speaker === 'phone') { y = new BQ('hp', 420, 0.8).run(new BQ('hp', 300, 0.6).run(y)); y = new BQ('pk', 1100, 1.5, 5).run(y); y = new BQ('pk', 3200, 2, 4).run(y); }
  else if (speaker === 'smallphone') { y = new BQ('hp', 700, 0.9).run(new BQ('hp', 600, 0.7).run(y)); y = new BQ('pk', 1800, 2, 7).run(y); }
  else if (speaker === 'tablet') { y = new BQ('hp', 180, 0.7).run(new BQ('hp', 140, 0.7).run(y)); }
  // level convention: the SUSTAIN (0.25–0.6 s) has RMS 1
  return rmsNorm(y, Math.floor(0.25 * SR), Math.floor(Math.min(0.6, dur - 0.1) * SR));
}

// ------------------------------------------------------------------ rooms
function fft(re: Float64Array, im: Float64Array, inv: boolean) { const n = re.length; for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } } for (let L = 2; L <= n; L <<= 1) { const a = (inv ? -2 : 2) * Math.PI / L, wr = Math.cos(a), wi = Math.sin(a); for (let i = 0; i < n; i += L) { let cr = 1, ci = 0; for (let k = 0; k < L / 2; k++) { const p = i + k, q = p + L / 2; const vr = re[q] * cr - im[q] * ci, vi = re[q] * ci + im[q] * cr; re[q] = re[p] - vr; im[q] = im[p] - vi; re[p] += vr; im[p] += vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } } if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; } }
export function convolve(x: Float32Array, ir: Float32Array): Float32Array { const L = x.length + ir.length - 1; let n = 1; while (n < L) n <<= 1; const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n); ar.set(x); br.set(ir); fft(ar, ai, false); fft(br, bi, false); for (let i = 0; i < n; i++) { const t = ar[i] * br[i] - ai[i] * bi[i]; ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = t; } fft(ar, ai, true); const y = new Float32Array(L); for (let i = 0; i < L; i++) y[i] = ar[i]; return y; }
/** rt: mid RT60 (s); vol: critical-distance proxy -> direct/reverb at 0.5 m in dB */
export const ROOMS: Record<string, { rt: number; drr: number }> = {
  dry: { rt: 0, drr: 99 }, carpet: { rt: 0.3, drr: 10 }, living: { rt: 0.5, drr: 6 }, bare: { rt: 0.8, drr: 3 }, kitchen: { rt: 1.0, drr: 1 }, hallway: { rt: 1.5, drr: -2 }, bathroom: { rt: 2.0, drr: -4 }, stairwell: { rt: 2.5, drr: -6 },
};
const irCache = new Map<string, Float32Array | null>();
/** src: which source position (different reflections); near: extra dB of direct sound (a source right at the mic) */
export function roomIR(room: string, src: number, near = 0): Float32Array | null {
  const key = `${room}|${src}|${near}`; if (irCache.has(key)) return irCache.get(key)!;
  const R = ROOMS[room]; if (!R.rt) { irCache.set(key, null); return null; }
  const r = rng(977 * src + Math.round(R.rt * 1000) + 5); const n = Math.floor(Math.min(3.6, R.rt * 1.5 + 0.15) * SR); const tail = new Float32Array(n);
  // diffuse tail: three bands with different decay; build-up over the first 25 ms
  const lo = new BQ('lp', 350, 0.7), mid = new BQ('bp', 1100, 0.45), hi = new BQ('hp', 3000, 0.7); const pre = Math.floor((0.004 + 0.006 * r()) * SR);
  for (let i = pre; i < n; i++) { const t = (i - pre) / SR; const w = gauss(r); tail[i] = Math.min(1, t / 0.025) * (lo.p(w) * Math.exp(-6.91 * t / (R.rt * 1.25)) + mid.p(w) * Math.exp(-6.91 * t / R.rt) + 0.6 * hi.p(w) * Math.exp(-6.91 * t / (R.rt * 0.55))); }
  // a few low room modes ringing longer than the diffuse field
  const nm = 4; for (let k = 0; k < nm; k++) { const fm = 70 + 220 * r(), ph = 2 * Math.PI * r(), a = 0.02 + 0.03 * r(), tm = R.rt * (1.2 + 0.5 * r()); for (let i = pre; i < n; i++) { const t = (i - pre) / SR; tail[i] += a * Math.exp(-6.91 * t / tm) * Math.sin(2 * Math.PI * fm * t + ph); } }
  let e = 0; for (let i = 0; i < n; i++) e += tail[i] * tail[i]; const g = Math.sqrt(10 ** (-(R.drr + near) / 10) / e); for (let i = 0; i < n; i++) tail[i] *= g;
  // early reflections (floor, wall, table)
  for (let k = 0; k < 6; k++) { const d = Math.floor((0.0015 + 0.03 * r() * r()) * SR); tail[d] += (r() < 0.4 ? -1 : 1) * (0.1 + 0.35 * r()) * lin(-near / 2); }
  tail[0] += 1; irCache.set(key, tail); return tail;
}
export function wet(x: Float32Array, room: string, src: number, near = 0) { const ir = roomIR(room, src, near); return ir ? convolve(x, ir) : x; }
export function writeWav(path: string, chunks: Float32Array[], fs: any) { let n = 0; for (const c of chunks) n += c.length; const b = Buffer.alloc(44 + 2 * n); b.write('RIFF', 0); b.writeUInt32LE(36 + 2 * n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(2 * SR, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(2 * n, 40); let o = 44; for (const c of chunks) for (let i = 0; i < c.length; i++) { b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, c[i])) * 32767), o); o += 2; } fs.writeFileSync(path, b); }
