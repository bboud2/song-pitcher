// Ported from the sixth external review (read-only original), kept as a permanent test.
// Critic-6 synthesis. Methods deliberately different from every earlier rig:
//  guitar: frequency-domain transfer-function synthesis (closed-form string loop response with dispersion,
//          frequency-dependent loss, two polarisations, body resonators, sympathetic open strings) -> one IFFT,
//          then time-warp for tension glide, time-domain fret-buzz nonlinearity.
//  voice : FOF (formant-wave-function / CHANT) grains per glottal pulse, jitter/shimmer/vibrato, consonant onsets.
//  room  : feedback delay network (live, in rig6) + discrete early reflections (table/floor/wall comb).
export const SR = Number(process.env.SR ?? 48000);
export const db2a = (d: number) => Math.pow(10, d / 20);
export const a2db = (a: number) => 20 * Math.log10(Math.max(a, 1e-12));
export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export function rng(seed: number) { let s = (seed * 2654435761) >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
export function gauss(r: () => number) { let u = 0; for (let i = 0; i < 6; i++) u += r(); return (u - 3) * 1.414; }

export function fft(re: Float64Array, im: Float64Array, inv = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len; const wr = Math.cos(ang), wi = Math.sin(ang); const h = len >> 1;
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < h; k++) { const a = i + k, b = a + h; const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr; re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
export class BQ {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0; z1 = 0; z2 = 0;
  constructor(type: 'lp' | 'hp' | 'bp' | 'pk', f: number, q: number, gainDb = 0, sr = SR) {
    const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q); let a0 = 1 + al;
    if (type === 'lp') { this.b0 = (1 - c) / 2; this.b1 = 1 - c; this.b2 = (1 - c) / 2; }
    else if (type === 'hp') { this.b0 = (1 + c) / 2; this.b1 = -(1 + c); this.b2 = (1 + c) / 2; }
    else if (type === 'bp') { this.b0 = al; this.b1 = 0; this.b2 = -al; }
    else { const A = Math.pow(10, gainDb / 40); this.b0 = 1 + al * A; this.b1 = -2 * c; this.b2 = 1 - al * A; a0 = 1 + al / A; this.a1 = -2 * c / a0; this.a2 = (1 - al / A) / a0; this.b0 /= a0; this.b1 /= a0; this.b2 /= a0; return; }
    this.b0 /= a0; this.b1 /= a0; this.b2 /= a0; this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  }
  s(x: number) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
}

// ---------------------------------------------------------------- guitar
export const OPEN = [40, 45, 50, 55, 59, 64];
export function stringFor(midi: number): { s: number; fret: number } { let s = 0; for (let i = 0; i < 6; i++) if (OPEN[i] <= midi) s = i; return { s, fret: midi - OPEN[s] }; }
export type Pluck = 'pick' | 'hardpick' | 'nail' | 'finger' | 'thumb';
export interface GOpts {
  midi: number; string?: number; cents?: number; pluck?: Pluck; beta?: number; kind?: 'steel' | 'nylon'; age?: 'new' | 'normal' | 'old';
  dur?: number; glide?: number; glideTau?: number; buzz?: number; mute?: boolean; t60x?: number; seed?: number; body?: number; noBody?: boolean;
  /** slide into the note from this many semitones (negative = from below) over slideMs */
  slide?: number; slideMs?: number;
}
const BODY = [[98, 14, 0.9], [186, 22, 1.3], [232, 25, 0.5], [287, 28, 0.7], [395, 30, 0.6], [445, 35, 0.35], [530, 35, 0.45], [640, 40, 0.3]];
function nOf(f: number, f0: number, B: number) { const x = f / f0; return B > 0 ? Math.sqrt((-1 + Math.sqrt(1 + 4 * B * x * x)) / (2 * B)) : x; }
function sigma(f: number, f0: number, o: GOpts, fretted: boolean) {
  const nylon = o.kind === 'nylon'; const ageK = o.age === 'new' ? 0.4 : o.age === 'old' ? 4 : 1;
  let s0 = nylon ? 2.2 + 0.006 * f0 : 1.2 + 0.004 * f0; let s2 = (nylon ? 2.5e-6 : 6e-7) * ageK; let s1 = nylon ? 0.0012 : 0.0006;
  if (fretted) { s0 *= 1.3; s2 *= 1.3; }
  if (o.mute) { s0 += 15; s2 *= 6; s1 *= 4; }
  return (s0 + s1 * f + s2 * f * f) / (o.t60x ?? 1);
}
const Bcoef = (string: number, fret: number, nylon: boolean) => (nylon ? [4e-5, 3e-5, 3e-5, 8e-5, 5e-5, 3e-5] : [7e-5, 6e-5, 9e-5, 4e-4, 2.2e-4, 1.1e-4])[string] * Math.pow(2, fret / 6);
/** returns {main, sym}: main = the played string (with body), sym = sympathetic ringing of the other open strings */
export function guitar(o: GOpts): { main: Float32Array; sym: Float32Array } {
  const r = rng((o.seed ?? 1) * 97 + o.midi); const pos = o.string !== undefined ? { s: o.string, fret: o.midi - OPEN[o.string] } : stringFor(o.midi);
  const dur = o.dur ?? 3.2; const N = 1 << 19; const nOut = Math.min(N - 4096, Math.round(dur * SR));
  const f0 = mtof(o.midi + (o.cents ?? 0) / 100); const B = Bcoef(pos.s, pos.fret, o.kind === 'nylon');
  const pl = o.pluck ?? 'pick'; const fc = { pick: 6500, hardpick: 8000, nail: 4800, finger: 2400, thumb: 1300 }[pl] * (o.kind === 'nylon' ? 0.75 : 1) * (0.9 + 0.2 * r());
  const beta = o.beta ?? 0.13 + 0.07 * r(); const t0 = 0.012; const df = SR / N; const kmax = Math.min(N / 2 - 1, Math.floor(14000 / df));
  const re = new Float64Array(N), im = new Float64Array(N), sr_ = new Float64Array(N), si_ = new Float64Array(N);
  const pol = [{ d: 1, a: 1, sx: 1 }, { d: 1 + (0.0006 + 0.0012 * r()) * (r() < 0.5 ? -1 : 1), a: 0.25 + 0.3 * r(), sx: 1.5 + r() }];
  const body: { f: number; q: number; g: number }[] = o.noBody ? [] : BODY.map(([f, q, g]) => ({ f: f * (0.97 + 0.06 * r()), q, g: g * (o.body ?? 1) * (0.7 + 0.6 * r()) }));
  if (!o.noBody) for (let i = 0; i < 36; i++) body.push({ f: 700 * Math.pow(7, r()), q: 25 + 40 * r(), g: (r() < 0.5 ? -1 : 1) * 0.22 * (0.4 + r()) });
  const others = OPEN.map((m, s) => ({ m, s })).filter((q) => q.s !== pos.s);
  for (let k = Math.ceil(25 / df); k <= kmax; k++) {
    const f = k * df;
    // excitation: integrated force pulse, gaussian roll-off from the plectrum/finger width
    const eMag = (f0 / f) * Math.exp(-0.5 * (f / fc) * (f / fc)) + (pl === 'thumb' || pl === 'finger' ? 0 : 0.0);
    let yr = 0, yi = 0;
    for (const p of pol) {
      const n = nOf(f, f0 * p.d, B); const th = 2 * Math.PI * n; const g = Math.exp(-sigma(f, f0, o, pos.fret > 0) * p.sx / f0);
      // comb numerator (1 - e^{-j 2 pi beta n}), loop denominator (1 - g e^{-j th})
      const cr = 1 - Math.cos(th * beta), ci = Math.sin(th * beta); const dr = 1 - g * Math.cos(th), di = g * Math.sin(th); const dd = dr * dr + di * di;
      yr += p.a * (cr * dr + ci * di) / dd; yi += p.a * (ci * dr - cr * di) / dd;
    }
    // times E(f) = eMag / j  (integration) -> multiply by -j
    let xr = eMag * yi, xi = -eMag * yr;
    // sympathetic strings driven by bridge motion (before body)
    let lr = 0, li = 0;
    for (const q of others) {
      const fs = mtof(q.m + 0.03 * (q.s - 2.5)); const n = nOf(f, fs, Bcoef(q.s, 0, o.kind === 'nylon')); const th = 2 * Math.PI * n; const g = Math.exp(-sigma(f, fs, { ...o, mute: false, t60x: 1 }, false) / fs);
      const nr = g * Math.cos(th), ni = -g * Math.sin(th); const dr = 1 - g * Math.cos(th), di = g * Math.sin(th); const dd = dr * dr + di * di;
      lr += (nr * dr + ni * di) / dd; li += (ni * dr - nr * di) / dd;
    }
    const kap = 0.004; let s_r = kap * (xr * lr - xi * li), s_i = kap * (xr * li + xi * lr);
    // body: 1 + sum of resonators g*(j x/Q)/(1 - x^2 + j x/Q)
    let br = o.noBody ? 1 : 0.55, bi = 0;
    for (const m of body) { const x = f / m.f; const ar = 1 - x * x, ai = x / m.q; const den = ar * ar + ai * ai; br += m.g * (ai * ai) / den; bi += m.g * (ai * ar) / den; }
    const rad = f / Math.sqrt(f * f + 110 * 110); br *= rad; bi *= rad;
    let t = xr * br - xi * bi; xi = xr * bi + xi * br; xr = t;
    t = s_r * br - s_i * bi; s_i = s_r * bi + s_i * br; s_r = t;
    const ph = -2 * Math.PI * f * t0; const c = Math.cos(ph), s = Math.sin(ph);
    re[k] = xr * c - xi * s; im[k] = xr * s + xi * c; re[N - k] = re[k]; im[N - k] = -im[k];
    sr_[k] = s_r * c - s_i * s; si_[k] = s_r * s + s_i * c; sr_[N - k] = sr_[k]; si_[N - k] = -si_[k];
  }
  fft(re, im, true); fft(sr_, si_, true);
  // pick/nail click + string chiff: short noise burst through a couple of body modes
  const click = { pick: 0.5, hardpick: 0.9, nail: 0.3, finger: 0.05, thumb: 0.02 }[pl];
  let pk = 0; for (let i = 0; i < nOut; i++) pk = Math.max(pk, Math.abs(re[i]));
  const i0 = Math.round(t0 * SR); const bp = new BQ('bp', 3500 + 2500 * r(), 0.8), bp2 = new BQ('bp', 900 + 600 * r(), 1.5);
  for (let i = 0; i < 0.03 * SR; i++) { const e = Math.exp(-i / (0.0025 * SR)); const nz = gauss(r) * e; re[i0 + i] += pk * click * (0.5 * bp.s(nz) + 0.25 * bp2.s(nz)); }
  // glide (tension modulation) and slide by time-warp
  const gl = o.glide ?? (pl === 'hardpick' ? 18 : pl === 'pick' ? 5 : 2); const tau = o.glideTau ?? 0.22;
  const main = new Float32Array(nOut); let phs = 0;
  const slide = o.slide ?? 0, sms = (o.slideMs ?? 120) / 1000;
  for (let i = 0; i < nOut; i++) {
    const t = Math.max(0, (i - i0) / SR); let cents = gl * Math.exp(-t / tau);
    if (slide && i >= i0) cents += 100 * slide * Math.max(0, 1 - t / sms);
    const a = Math.floor(phs), fr = phs - a; main[i] = a + 1 < N ? re[a] * (1 - fr) + re[a + 1] * fr : 0;
    phs += Math.pow(2, cents / 1200);
  }
  // fret buzz: where slow displacement exceeds threshold the string hits the fret -> short hf rattles, once per period
  if (o.buzz) {
    const lp = new BQ('lp', f0 * 1.5, 0.7), hp = new BQ('hp', 2200, 0.7); let integ = 0; const disp = new Float32Array(nOut); let dm = 0;
    for (let i = 0; i < nOut; i++) { integ = 0.999 * integ + lp.s(main[i]); disp[i] = integ; dm = Math.max(dm, Math.abs(integ)); }
    const th = dm * (1 - 0.75 * o.buzz);
    for (let i = 0; i < nOut; i++) { const ex = disp[i] > th ? (disp[i] - th) / dm : 0; main[i] += pk * 2.5 * hp.s(ex * (0.6 + 0.4 * gauss(r))); }
  }
  let m = 0; for (let i = 0; i < nOut; i++) m = Math.max(m, Math.abs(main[i]));
  const sym = new Float32Array(nOut); for (let i = 0; i < nOut; i++) { main[i] /= m; sym[i] = sr_[i] / m; }
  const fo = Math.min(nOut, Math.round(0.03 * SR)); for (let i = 0; i < fo; i++) { main[nOut - 1 - i] *= i / fo; sym[nOut - 1 - i] *= i / fo; }
  return { main, sym };
}

// ---------------------------------------------------------------- FOF voice
const VOW: Record<string, { F: number[]; A: number[]; W: number[] }> = {
  a: { F: [700, 1220, 2600, 3300, 3750], A: [0, -5, -18, -22, -30], W: [80, 90, 120, 130, 140] },
  i: { F: [280, 2250, 2890, 3500, 4950], A: [0, -22, -18, -28, -40], W: [60, 90, 100, 120, 140] },
  u: { F: [310, 870, 2250, 3300, 3750], A: [0, -12, -38, -44, -50], W: [60, 80, 100, 120, 130] },
  o: { F: [450, 800, 2830, 3300, 3750], A: [0, -9, -30, -32, -40], W: [70, 80, 100, 130, 135] },
  e: { F: [400, 1700, 2600, 3200, 3580], A: [0, -10, -16, -22, -30], W: [70, 80, 100, 120, 120] },
  m: { F: [250, 1100, 2300, 3000, 3600], A: [0, -28, -36, -46, -54], W: [60, 150, 200, 250, 250] },
};
export interface VOpts {
  midi: number; dur: number; vowel?: string; female?: boolean; seed?: number;
  onset?: 'soft' | 'normal' | 'hard' | 'd' | 't' | 'b' | 'l' | 'm' | 'h';
  /** amplitude envelope after onset: decay in dB/s (0 = held), or a function of t returning dB */
  fadeDbS?: number; envDb?: (t: number) => number; release?: number;
  scoop?: number; drift?: number; vibCents?: number; vibHz?: number; jitter?: number; shimmer?: number; breath?: number;
  /** pitch contour in semitones added to midi */
  contour?: (t: number) => number;
  /** vowel to morph to (speech) */
  vowel2?: string; morphAt?: number;
  /** true = original FOF-only voice with a weak fundamental (stress case: thin voice / small mic) */
  thin?: boolean;
}
export const VOICE_LEAD = 0.02;
export function voice(o: VOpts): Float32Array {
  const r = rng((o.seed ?? 3) * 131 + Math.round(o.midi * 7)); const n = Math.round((o.dur + 0.25) * SR); const y = new Float32Array(n + 4096);
  const V = VOW[o.vowel ?? 'a'], V2 = VOW[o.vowel2 ?? o.vowel ?? 'a']; const sc = o.female ? 1.17 : 1; const onset = o.onset ?? 'normal';
  const rise = { soft: 0.11, normal: 0.045, hard: 0.012, d: 0.016, t: 0.02, b: 0.018, l: 0.03, m: 0.03, h: 0.06 }[onset];
  const pre = { soft: 0, normal: 0, hard: 0, d: 0.012, t: 0.03, b: 0.01, l: 0.07, m: 0.09, h: 0.09 }[onset];
  const rel = o.release ?? 0.07; const jit = o.jitter ?? 0.006, shim = o.shimmer ?? 0.04; const vibHz = o.vibHz ?? 5.4;
  let t = VOICE_LEAD; let wander = 0; const tStart = VOICE_LEAD + pre;
  // consonant / breath pre-noise
  if (onset === 'd' || onset === 't' || onset === 'b' || onset === 'h') {
    const f = onset === 'h' ? 1500 : onset === 'b' ? 700 : 3800; const bp = new BQ('bp', f, onset === 'h' ? 0.6 : 1.2); const L = Math.round((pre + 0.008) * SR); const a = onset === 'h' ? 0.05 : onset === 't' ? 0.22 : 0.12;
    for (let i = 0; i < L; i++) { const e = onset === 'h' ? Math.sin(Math.PI * i / L) : Math.exp(-i / (0.004 * SR)); y[Math.round(VOICE_LEAD * SR) + i] += a * e * bp.s(gauss(r)); }
  }
  const murmur = onset === 'l' || onset === 'm';
  if (murmur) t = VOICE_LEAD; else t = tStart;
  const br = new BQ('bp', 2500, 0.7);
  while (t < VOICE_LEAD + pre + o.dur + rel) {
    const tt = t - tStart; // time since vowel start (may be negative in murmur)
    const tv = Math.max(0, tt);
    wander += 0.25 * gauss(r) - 0.05 * wander;
    let cents = wander * 1.5 + (o.drift ?? 0) * tv - (o.scoop ?? 0) * Math.exp(-tv / 0.06) + (o.vibCents ?? 0) * Math.min(1, tv / 0.5) * Math.sin(2 * Math.PI * vibHz * tv) + 100 * (o.contour ? o.contour(tv) : 0);
    const f0 = mtof(o.midi + cents / 100) * (1 + jit * gauss(r));
    let amp: number;
    if (tt < 0) amp = 0.12 * Math.min(1, (t - VOICE_LEAD) / 0.02);
    else {
      const start = murmur ? 0.12 : 0; amp = start + (1 - start) * (1 - Math.exp(-tt / (rise / 2.2)));
      if (onset === 'hard' && tt < 0.03) amp *= 1.25;
      amp *= db2a(-(o.fadeDbS ?? 0) * tv + (o.envDb ? o.envDb(tv) : 0));
      if (tv > o.dur) amp *= Math.max(0, 1 - (tv - o.dur) / rel);
    }
    amp *= 1 + shim * gauss(r);
    const morph = o.vowel2 ? Math.min(1, Math.max(0, (tv - (o.morphAt ?? 0.08)) / 0.06)) : 0; const nasal = murmur && tt < 0 ? 1 : 0;
    const i0 = t * SR; const ii = Math.ceil(i0);
    for (let k = 0; k < 5; k++) {
      const Vn = VOW.m; let F = (nasal ? Vn.F[k] : V.F[k] * (1 - morph) + V2.F[k] * morph) * sc; if (k === 0) F = Math.max(F, f0 * 1.04);
      const A = db2a(nasal ? Vn.A[k] : V.A[k] * (1 - morph) + V2.A[k] * morph) * amp; const W = nasal ? Vn.W[k] : V.W[k]; const L = Math.min(Math.round(6.9 / (Math.PI * W) * SR), 3000); const tr = 0.0006 * SR;
      const w = 2 * Math.PI * F / SR, dk = Math.PI * W / SR;
      for (let j = 0; j < L; j++) { const x = ii + j - i0; const e = x < tr ? 0.5 * (1 - Math.cos(Math.PI * x / tr)) : 1; y[ii + j] += A * e * Math.exp(-dk * x) * Math.sin(w * x); }
    }
    // glottal formant: FOF grains alone leave the fundamental ~18 dB too weak below F1 (no source tilt);
    // one broad grain at f0 per pulse restores a natural h1 (about level with the strongest formant harmonic)
    if (!o.thin) { const Wg = 0.9 * f0; const Ag = 0.7 * (Wg / (nasal ? 60 : V.W[0])) * amp; const L = Math.min(Math.round(6.9 / (Math.PI * Wg) * SR), 3000); const w = 2 * Math.PI * f0 / SR, dk = Math.PI * Wg / SR; const tr = 0.0012 * SR;
      for (let j = 0; j < L; j++) { const x = ii + j - i0; const e = x < tr ? 0.5 * (1 - Math.cos(Math.PI * x / tr)) : 1; y[ii + j] += Ag * e * Math.exp(-dk * x) * Math.sin(w * x); } }
    // aspiration, pulsed with the period
    const T = 1 / f0; const Ls = Math.round(T * SR); const ba = (o.breath ?? 0.015) * amp; for (let j = 0; j < Ls; j++) y[ii + j] += ba * (0.5 + 0.5 * Math.cos(2 * Math.PI * j / Ls)) * br.s(gauss(r));
    t += T;
  }
  let m = 0; const hp = new BQ('hp', 70, 0.7); for (let i = 0; i < y.length; i++) { y[i] = hp.s(y[i]); m = Math.max(m, Math.abs(y[i])); }
  const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = y[i] / m; return out;
}

// reference tone as the app plays it (harmonics from audio.ts), through a small phone speaker (2nd-order HP + mild distortion)
export function refTone(midi: number, dur: number, speakerHp = 450, dist = 0.08): Float32Array {
  const H = [1, 0.42, 0.22, 0.12, 0.07, 0.04, 0.025, 0.015]; const f = mtof(midi); const n = Math.round((dur + 0.4) * SR); const y = new Float32Array(n);
  const hp1 = new BQ('hp', speakerHp, 0.9), lp = new BQ('lp', Math.min(6000, f * 9), 0.4);
  for (let i = 0; i < n; i++) {
    const t = i / SR; let e: number;
    if (t < 0.015) e = 0.34 * t / 0.015; else if (t < 0.18) e = 0.34 * Math.pow(0.22 / 0.34, (t - 0.015) / 0.165); else if (t < Math.max(0.19, dur - 0.05)) e = 0.22; else e = 0.22 * Math.pow(0.0001 / 0.22, Math.min(1, (t - Math.max(0.19, dur - 0.05)) / (0.35)));
    let s = 0; for (let h = 0; h < H.length; h++) if ((h + 1) * f < SR * 0.45) s += H[h] * Math.sin(2 * Math.PI * (h + 1) * f * t);
    let x = lp.s(s) * e / 0.34; x = x + dist * x * x - dist * 0.5 * x * x * x; y[i] = speakerHp > 0 ? hp1.s(x) : x;
  }
  return y;
}
// misc noises
export function thump(seed: number, f = 85): Float32Array { const r = rng(seed); const n = Math.round(0.35 * SR); const y = new Float32Array(n); const bp = new BQ('bp', 2500, 0.7); for (let i = 0; i < n; i++) { const t = i / SR; y[i] = Math.exp(-t / 0.05) * Math.sin(2 * Math.PI * f * t * (1 + 0.3 * Math.exp(-t / 0.01))) + 0.5 * Math.exp(-t / 0.006) * Math.sin(2 * Math.PI * 240 * t) + 0.35 * Math.exp(-t / 0.002) * bp.s(gauss(r)); } return y; }
export function squeak(seed: number): Float32Array { const r = rng(seed); const d = 0.08 + 0.15 * r(); const n = Math.round(d * SR); const y = new Float32Array(n); const f0 = 2200 + 1500 * r(), f1 = f0 * (1.3 + 0.6 * r()); let ph = 0; for (let i = 0; i < n; i++) { const x = i / n; const f = f0 + (f1 - f0) * x; ph += 2 * Math.PI * f / SR; y[i] = Math.sin(Math.PI * x) * (Math.sin(ph) * 0.5 + 0.3 * Math.sin(2.01 * ph) + 0.25 * gauss(r)); } return y; }
export function breathNoise(seed: number, dur: number, f = 1200): Float32Array { const r = rng(seed); const n = Math.round(dur * SR); const y = new Float32Array(n); const bp = new BQ('bp', f, 0.5); for (let i = 0; i < n; i++) y[i] = 0.5 * Math.sin(Math.PI * i / n) ** 0.7 * bp.s(gauss(r)); return y; }
export function clap(seed: number): Float32Array { const r = rng(seed); const n = Math.round(0.12 * SR); const y = new Float32Array(n); const bp = new BQ('bp', 1800, 0.8); for (let i = 0; i < n; i++) y[i] = Math.exp(-i / (0.012 * SR)) * bp.s(gauss(r)) * 3; return y; }
