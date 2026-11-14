// Ported from the fifth external review (read-only original), kept as a permanent test.
// Critic-5 synthesis. Independent of the four earlier synths:
//  * guitar: explicit finite-difference (FDTD) stiff, lossy string (Bilbao scheme) with a spatially
//    wide pluck released over a finite time, tension modulation (hard pick -> sharp then falling),
//    bridge force through body resonators + broadband radiation path.
//  * voice: KLGLOTT88-style glottal flow driving a Kelly-Lochbaum tube tract (2x oversampled) with
//    nasal branch, consonant closures/bursts by area modulation.
//  * room: synthetic impulse response (direct + early reflections + diffuse tail), FFT convolution.
export const SR = 48000;
export function rng(seed: number): () => number {
  let a = (seed * 0x9e3779b1) >>> 0 || 7;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
export const db2a = (d: number) => Math.pow(10, d / 20);
export const m2f = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const OPEN = [40, 45, 50, 55, 59, 64];
export function stringFor(midi: number): { s: number; fret: number } {
  let s = 0;
  for (let i = 0; i < 6; i++) if (OPEN[i] <= midi) s = i;
  return { s, fret: midi - OPEN[s] };
}

class BQ {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0; x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  constructor(type: 'lp' | 'hp' | 'bp', f: number, q: number, sr = SR) {
    const w = (2 * Math.PI * f) / sr, al = Math.sin(w) / (2 * q), cw = Math.cos(w), a0 = 1 + al;
    if (type === 'lp') { this.b0 = (1 - cw) / 2 / a0; this.b1 = (1 - cw) / a0; this.b2 = this.b0; }
    else if (type === 'hp') { this.b0 = (1 + cw) / 2 / a0; this.b1 = -(1 + cw) / a0; this.b2 = this.b0; }
    else { this.b0 = al / a0; this.b1 = 0; this.b2 = -al / a0; }
    this.a1 = (-2 * cw) / a0; this.a2 = (1 - al) / a0;
  }
  s(x: number): number { const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2; this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y; }
}
export { BQ };

// ------------------------------------------------------------------ guitar (FDTD)
export interface GOpts {
  midi: number; cents?: number; kind?: 'steel' | 'nylon'; pluck?: 'pick' | 'nail' | 'finger' | 'thumb';
  /** cents sharp at the attack from string stretch (hard picking) */
  tm?: number; pos?: number; relMs?: number; width?: number; mute?: boolean; dur?: number; seed?: number;
  /** semitone offset of the string over time (late fretting, hammer-on, pull-off) */
  semis?: (t: number) => number; semisMax?: number;
  /** extra energy loss events (finger landing) */
  bright?: number;
  /** multiplies both decay times (default 1 = fundamental T60 about 2-3.5 s steel, 1-2 s nylon; 2 = long-sustain guitar) */
  t60x?: number;
}
export function guitar(o: GOpts): Float32Array {
  const sr = SR, k = 1 / sr; const r = rng(o.seed ?? 1);
  const kind = o.kind ?? 'steel'; const pl = o.pluck ?? 'pick';
  const { s: str, fret } = stringFor(o.midi);
  const f0 = m2f(o.midi + (o.cents ?? 0) / 100);
  const dur = o.dur ?? 3.0; const n = Math.floor(dur * sr);
  const Bopen = kind === 'steel' ? [7e-5, 6e-5, 5e-5, 1.1e-4, 8e-5, 4e-5][str] : [4e-5, 3.5e-5, 3e-5, 6e-5, 4e-5, 2.5e-5][str];
  const B = Bopen * Math.pow(2, (2 * fret) / 12);
  let T1 = kind === 'steel' ? [7, 7, 6, 5, 4.5, 4][str] : [4, 3.5, 3, 2.6, 2.2, 1.8][str];
  let T2 = kind === 'steel' ? 1.1 : 0.45; // T60 at 3 kHz
  if (fret > 0) { T1 *= 0.7; T2 *= 0.8; }
  if (o.mute) { T1 = 0.8; T2 = 0.2; }
  // NB amplitude decays as exp(-sigma t), so the effective T60 is half of T1/T2 as written; t60x scales it
  T1 *= o.t60x ?? 1; T2 *= o.t60x ?? 1;
  const gam0 = 2 * f0; const kap = (gam0 * Math.sqrt(B)) / Math.PI;
  const xi = (w: number) => (-gam0 * gam0 + Math.sqrt(gam0 ** 4 + 4 * kap * kap * w * w)) / (2 * kap * kap);
  const w1 = 2 * Math.PI * f0, w2 = 2 * Math.PI * 3000; const x1 = xi(w1), x2 = xi(w2);
  const sig0 = Math.max(0.05, ((6 * Math.LN10) / (x2 - x1)) * (x2 / T1 - x1 / T2));
  const sig1 = Math.max(0, ((6 * Math.LN10) / (x2 - x1)) * (-1 / T1 + 1 / T2));
  const tm = o.tm ?? 0; const maxF = Math.pow(2, (tm * 1.15 + 12) / 1200) * Math.pow(2, (o.semisMax ?? 0) / 12);
  const gmax = gam0 * maxF * 1.004;
  const a = gmax * gmax * k * k + 4 * sig1 * k;
  const hmin = Math.sqrt((a + Math.sqrt(a * a + 16 * kap * kap * k * k)) / 2);
  const N = Math.floor(1 / hmin); const h = 1 / N;
  const mu2 = (kap * k / (h * h)) ** 2;
  const s1 = Math.sin(Math.PI * h / 2);
  // calibrated wave speed so that mode 1 of the discrete scheme sits on f (per-step, for time-varying pitch)
  const lam2For = (f: number) => (Math.sin(Math.PI * f * k) ** 2 - 4 * mu2 * s1 ** 4) / (s1 * s1);
  const lam2Base = lam2For(f0);
  // initial shape: triangle at pos (from the bridge end), smoothed over `width`
  const pos = o.pos ?? (0.13 + 0.08 * r());
  const width = o.width ?? { pick: 0.003, nail: 0.006, finger: 0.018, thumb: 0.03 }[pl];
  // (the string leaves flesh within about a period of its own motion: a slow release cannot be slower than that)
  const relMs = o.relMs ?? Math.min({ pick: 0.35, nail: 0.8, finger: 2.5, thumb: 6 }[pl], (pl === 'thumb' ? 1.2 : 0.8) * 1000 / f0);
  const u0 = new Float64Array(N + 1);
  for (let l = 0; l <= N; l++) { const x = l * h; u0[l] = x < pos ? x / pos : (1 - x) / (1 - pos); }
  const sm = Math.max(1, Math.round((width * N) / 2));
  for (let pass = 0; pass < 3; pass++) { const t = Float64Array.from(u0); for (let l = 1; l < N; l++) { let s = 0, c = 0; for (let j = -sm; j <= sm; j++) { const q = l + j; if (q >= 0 && q <= N) { s += t[q]; c++; } } u0[l] = s / c; } }
  const dxx = (u: Float64Array, l: number) => u[l + 1] - 2 * u[l] + u[l - 1];
  const A0 = new Float64Array(N + 1), B0 = new Float64Array(N + 1);
  for (let l = 1; l < N; l++) {
    A0[l] = dxx(u0, l);
    const um2 = l >= 2 ? u0[l - 2] : -u0[1], up2 = l <= N - 2 ? u0[l + 2] : -u0[N - 1];
    B0[l] = up2 - 4 * u0[l + 1] + 6 * u0[l] - 4 * u0[l - 1] + um2;
  }
  let E0 = 0; for (let l = 0; l < N; l++) E0 += (u0[l + 1] - u0[l]) ** 2;
  const tmC = Math.pow(2, tm / 600) - 1;
  let u = Float64Array.from(u0), up = Float64Array.from(u0), un = new Float64Array(N + 1);
  const t0 = Math.round(0.003 * sr); const relN = Math.max(1, Math.round((relMs / 1000) * sr));
  const force = new Float64Array(n);
  const c1 = 1 / (1 + sig0 * k), c2 = 1 - sig0 * k, c3 = (2 * sig1 * k) / (h * h);
  let E = E0; let lam2 = lam2Base;
  for (let i = 0; i < n; i++) {
    const t = (i - t0) / sr;
    if ((i & 15) === 0) {
      E = 0; for (let l = 0; l < N; l++) E += (u[l + 1] - u[l]) ** 2;
      const st = o.semis ? o.semis(Math.max(0, t)) : 0;
      const f = f0 * Math.pow(2, st / 12) * Math.sqrt(1 + tmC * Math.min(1.1, E / E0));
      lam2 = lam2For(f);
    }
    const hold = i < t0 ? 1 : i < t0 + relN ? 0.5 * (1 + Math.cos((Math.PI * (i - t0)) / relN)) : 0;
    for (let l = 1; l < N; l++) {
      const um2 = l >= 2 ? u[l - 2] : -u[1], up2 = l <= N - 2 ? u[l + 2] : -u[N - 1];
      const d2 = u[l + 1] - 2 * u[l] + u[l - 1];
      const d4 = up2 - 4 * u[l + 1] + 6 * u[l] - 4 * u[l - 1] + um2;
      const d2p = up[l + 1] - 2 * up[l] + up[l - 1];
      let v = 2 * u[l] - c2 * up[l] + lam2 * d2 - mu2 * d4 + c3 * (d2 - d2p);
      if (hold > 0) v -= hold * (lam2 * A0[l] - mu2 * B0[l]);
      un[l] = c1 * v;
    }
    const tmp = up; up = u; u = un; un = tmp;
    force[i] = u[1] / h;
  }
  // body: broadband radiation path + resonators
  const modes = kind === 'steel' ? [[100, 12, 0.3], [195, 18, 0.55], [280, 15, 0.4], [410, 20, 0.5], [560, 20, 0.4], [780, 15, 0.3]] : [[95, 10, 0.35], [185, 16, 0.6], [232, 14, 0.45], [390, 18, 0.45], [510, 18, 0.35]];
  const res = modes.map(([f, q]) => new BQ('bp', f, q));
  const hp = new BQ('hp', 180, 0.6), lp = new BQ('lp', kind === 'steel' ? 6500 : 4000, 0.7), dc = new BQ('hp', 30, 0.7);
  const out = new Float32Array(n);
  const br = o.bright ?? 1.4;
  let pk = 0;
  for (let i = 0; i < n; i++) {
    const x = dc.s(force[i] - force[0]);
    let y = br * lp.s(hp.s(x));
    for (let j = 0; j < res.length; j++) y += modes[j][2] * res[j].s(x);
    out[i] = y; if (Math.abs(y) > pk) pk = Math.abs(y);
  }
  if (pl === 'pick') { // faint pick scrape just before the release
    const hpn = new BQ('hp', 2500, 0.7); for (let i = 0; i < Math.round(0.0015 * sr); i++) { const j = t0 - Math.round(0.0008 * sr) + i; if (j >= 0) out[j] += pk * 0.04 * hpn.s(gauss(r)) * Math.exp(-i / (0.0005 * sr)); }
  }
  for (let i = 0; i < n; i++) out[i] /= pk;
  const fo = Math.round(0.05 * sr); for (let i = 0; i < fo; i++) out[n - 1 - i] *= i / fo;
  return out;
}

/** knock on the guitar top / body tap: short force pulse into the body filter */
export function tap(seed = 1, hard = 1): Float32Array {
  const n = Math.floor(0.4 * SR); const out = new Float32Array(n); const r = rng(seed);
  const modes = [[100, 10, 1.0], [195, 14, 1.0], [280, 12, 0.6], [410, 14, 0.5]]; const res = modes.map(([f, q]) => new BQ('bp', f, q));
  const hp = new BQ('hp', 600, 0.7); const w = Math.round((0.0012 / hard) * SR); let pk = 0;
  for (let i = 0; i < n; i++) { const j = i - 100; const x = j >= 0 && j < w ? Math.sin((Math.PI * j) / w) : 0; let y = 0.5 * hp.s(x + (j >= 0 && j < 3 * w ? 0.2 * gauss(r) * Math.exp(-j / w) : 0)); for (let q = 0; q < res.length; q++) y += modes[q][2] * res[q].s(x); out[i] = y; pk = Math.max(pk, Math.abs(y)); }
  for (let i = 0; i < n; i++) out[i] /= pk; return out;
}
export function clap(seed = 1): Float32Array {
  const n = Math.floor(0.25 * SR); const out = new Float32Array(n); const r = rng(seed); const bp = new BQ('bp', 1800, 1.2); let pk = 0;
  for (let i = 0; i < n; i++) { const j = i - 100; const e = j < 0 ? 0 : j < 40 ? j / 40 : Math.exp(-(j - 40) / (0.012 * SR)); out[i] = e * bp.s(gauss(r)); pk = Math.max(pk, Math.abs(out[i])); }
  for (let i = 0; i < n; i++) out[i] /= pk; return out;
}

// ------------------------------------------------------------------ voice (KL tube)
export type Vowel = 'a' | 'i' | 'u' | 'o' | 'e' | 'm';
export interface VOpts {
  midi: number; dur: number; female?: boolean; vowel?: Vowel;
  onset?: 'soft' | 'normal' | 'hard' | 'breathy'; cons?: null | 't' | 'd' | 'b' | 'p' | 'l' | 'dm';
  vibCents?: number; vibHz?: number; vibDelay?: number; scoop?: number; drift?: number; jitter?: number;
  tense?: number; breath?: number; fade?: number /* dB/s decay over the note (fading hum) */; relMs?: number; seed?: number;
}
const SHAPES: Record<Vowel, [number, number][]> = {
  a: [[0, 0.5], [0.1, 0.5], [0.2, 0.8], [0.35, 0.6], [0.5, 1.5], [0.7, 5], [0.9, 6], [1, 5]],
  i: [[0, 0.5], [0.1, 0.6], [0.2, 6], [0.4, 8], [0.6, 3], [0.75, 0.5], [0.85, 0.5], [0.95, 1.5], [1, 2]],
  u: [[0, 0.5], [0.1, 0.6], [0.2, 5], [0.4, 6], [0.55, 1.0], [0.65, 0.7], [0.8, 6], [0.93, 1], [1, 0.4]],
  o: [[0, 0.5], [0.1, 0.5], [0.2, 1.5], [0.35, 1], [0.5, 2], [0.7, 6], [0.9, 4], [1, 1.2]],
  e: [[0, 0.5], [0.1, 0.6], [0.2, 4], [0.4, 5], [0.6, 2.5], [0.75, 1.2], [0.9, 2.5], [1, 3]],
  m: [[0, 0.5], [0.1, 0.6], [0.2, 3], [0.5, 3], [0.8, 3], [1, 3]],
};
function shape(v: Vowel, n: number): Float64Array {
  const p = SHAPES[v]; const a = new Float64Array(n);
  for (let i = 0; i < n; i++) { const x = i / (n - 1); let j = 0; while (j < p.length - 2 && p[j + 1][0] < x) j++; const u = Math.min(1, Math.max(0, (x - p[j][0]) / (p[j + 1][0] - p[j][0]))); const w = 0.5 - 0.5 * Math.cos(Math.PI * u); a[i] = p[j][1] * (1 - w) + p[j + 1][1] * w; }
  return a;
}
export function voice(o: VOpts): Float32Array {
  const sr2 = SR * 2; const r = rng(o.seed ?? 3);
  const n = o.female ? 42 : 48; const nn = 28; const nv = Math.round(0.45 * n);
  const vowel = o.vowel ?? 'a'; const base = shape(vowel, n);
  const noseA = new Float64Array(nn); for (let i = 0; i < nn; i++) { const x = i / (nn - 1); noseA[i] = x < 0.4 ? 0.4 + 4 * x : x < 0.8 ? 2 : 2 - 7.5 * (x - 0.8); }
  const A = Float64Array.from(base);
  let R = new Float64Array(n), L = new Float64Array(n), jR = new Float64Array(n + 1), jL = new Float64Array(n + 1);
  let nR = new Float64Array(nn), nL = new Float64Array(nn), njR = new Float64Array(nn + 1), njL = new Float64Array(nn + 1);
  const total = Math.floor((o.dur + 0.25) * SR); const out = new Float32Array(total);
  const cons = o.cons ?? null; const onset = o.onset ?? 'normal';
  // timing (s): tV = voicing start, tR = consonant release
  const lead = 0.06; let tR = lead, tV = lead;
  if (cons === 'b' || cons === 'd' || cons === 'dm') tV = tR - 0.03;
  if (cons === 'p' || cons === 't') tV = tR + 0.045;
  if (cons === 'l') { tV = lead; tR = lead + 0.08; }
  const ramp = cons === 'p' || cons === 't' ? 0.02 : cons === 'b' || cons === 'd' || cons === 'dm' ? 0.012 : { soft: 0.1, normal: 0.04, hard: 0.007, breathy: 0.15 }[onset];
  const tEnd = lead + o.dur; const rel = (o.relMs ?? 60) / 1000;
  const tense = o.tense ?? (onset === 'hard' ? 0.8 : onset === 'breathy' ? 0.3 : 0.6);
  const OQ = 0.75 - 0.3 * tense; const tiltHz = 800 + 5000 * tense; const breath = o.breath ?? (onset === 'breathy' ? 0.12 : 0.03);
  const ci = cons === 'b' || cons === 'p' ? n - 1 : Math.round(0.88 * n); // constriction index
  const nasal = vowel === 'm' || cons === 'dm';
  let ph = 0, T0 = 1, amp = 1, lpS = 0, drift = 0, prevLip = 0, prevNose = 0;
  const kt = Math.exp((-2 * Math.PI * tiltHz) / sr2);
  const hpA0 = new BQ('bp', 2500, 0.6, sr2), hpB0 = new BQ('bp', 4000, 0.7, sr2); const hpA = { s: (x: number) => 0.25 * hpA0.s(x) }, hpB = { s: (x: number) => 0.4 * hpB0.s(x) }; const aa1 = new BQ('lp', 11000, 0.54, sr2), aa2 = new BQ('lp', 11000, 1.3, sr2);
  let acc = 0;
  for (let i = 0; i < total * 2; i++) {
    const t = i / sr2;
    // ---- areas
    if ((i & 31) === 0) {
      for (let j = 0; j < n; j++) A[j] = base[j];
      if (vowel === 'm' && cons !== 'dm') A[n - 1] = 0.0005; // lips closed
      if (cons === 'dm') { A[n - 1] = 0.0005; }
      if (cons && cons !== 'dm') {
        const open = cons === 'l' ? Math.min(1, Math.max(0.12, 0.12 + 0.88 * (t - tR) / 0.035)) : Math.min(1, Math.max(0.0005, (t - tR) / (cons === 'b' || cons === 'd' ? 0.014 : 0.01)));
        for (let j = -2; j <= 2; j++) { const q = ci + j; if (q >= 1 && q < n) A[q] = Math.min(A[q], Math.max(0.0005, A[q] * open * (1 - 0.15 * Math.abs(j)) + (Math.abs(j) * 0.15) * A[q])); }
        if (cons !== 'l') A[Math.min(n - 1, ci)] = Math.max(0.0005, base[Math.min(n - 1, ci)] * (t < tR ? 0.0002 : Math.min(1, (t - tR) / (cons === 'b' || cons === 'd' ? 0.014 : 0.01))));
      }
    }
    const velum = nasal ? (cons === 'dm' ? Math.min(1, Math.max(0, (t - tR) / 0.008)) : 1) * 0.6 : 0.01;
    // ---- glottal source
    const tv = t - tV; let g = 0;
    if (tv >= 0 && t < tEnd + rel) {
      if (ph >= 1 || tv === 0) {
        ph -= ph >= 1 ? 1 : 0;
        drift += 0.08 * (gauss(r) * (o.drift ?? 6) - drift);
        const vibOn = Math.min(1, Math.max(0, (tv - (o.vibDelay ?? 0.25)) / 0.3));
        const cents = -(o.scoop ?? 0) * Math.exp(-tv / 0.05) + drift + vibOn * (o.vibCents ?? 0) * Math.sin(2 * Math.PI * (o.vibHz ?? 5.5) * tv);
        T0 = (1 / (m2f(o.midi + cents / 100))) * (1 + (o.jitter ?? 0.005) * gauss(r));
        amp = 1 + 0.03 * gauss(r);
      }
      const x = ph / OQ;
      const flow = x < 1 ? 6.75 * x * x * (1 - x) : 0;
      let env = Math.min(1, tv / ramp); env = 0.5 - 0.5 * Math.cos(Math.PI * env);
      if (onset === 'hard' && !cons) env *= 1 + 0.35 * Math.exp(-tv / 0.03);
      if (t > tEnd) env *= Math.max(0, 1 - (t - tEnd) / rel);
      if (o.fade) env *= db2a(-o.fade * tv);
      const noise = breath * (0.3 + flow) * hpA.s(gauss(r));
      lpS = kt * lpS + (1 - kt) * (amp * flow + noise);
      g = env * lpS;
      ph += 1 / (T0 * sr2);
    }
    if (onset === 'breathy' && !cons && t > tV - 0.08 && t < tV + 0.1) g += 0.02 * hpA.s(gauss(r)) * Math.min(1, (t - tV + 0.08) / 0.05);
    // aspiration after an unvoiced stop
    if ((cons === 'p' || cons === 't') && t >= tR && t < tV + 0.02) g += 0.05 * hpA.s(gauss(r)) * Math.min(1, (t - tR) / 0.005) * Math.max(0, 1 - (t - tV) / 0.02);
    // ---- tube step
    jR[0] = L[0] * 0.75 + g;
    jL[n] = R[n - 1] * (A[n - 1] < 0.001 ? 0.98 : -0.85);
    for (let j = 1; j < n; j++) {
      if (j === nv) continue;
      const kk = (A[j - 1] - A[j]) / (A[j - 1] + A[j]); const w = kk * (R[j - 1] + L[j]);
      jR[j] = R[j - 1] - w; jL[j] = L[j] + w;
    }
    { // velum three-port
      const a1 = A[nv - 1], a2 = A[nv], a3 = velum; const sum = a1 + a2 + a3;
      const rl = (2 * a1 - sum) / sum, rr = (2 * a2 - sum) / sum, rn = (2 * a3 - sum) / sum;
      jL[nv] = rl * R[nv - 1] + (1 + rl) * (nL[0] + L[nv]);
      jR[nv] = rr * L[nv] + (1 + rr) * (R[nv - 1] + nL[0]);
      njR[0] = rn * nL[0] + (1 + rn) * (L[nv] + R[nv - 1]);
    }
    // burst noise at the release of a stop
    if (cons && cons !== 'l' && cons !== 'dm' && t >= tR && t < tR + 0.012) {
      const lv = { b: 0.06, d: 0.12, p: 0.25, t: 0.35 }[cons as 'b'] ?? 0;
      jR[Math.min(n - 1, ci + 1)] += lv * hpB.s(gauss(r)) * Math.exp(-(t - tR) / 0.004);
    }
    for (let j = 0; j < n; j++) { R[j] = jR[j] * 0.9992; L[j] = jL[j + 1] * 0.9992; }
    njL[nn] = nR[nn - 1] * -0.9;
    for (let j = 1; j < nn; j++) { const kk = (noseA[j - 1] - noseA[j]) / (noseA[j - 1] + noseA[j]); const w = kk * (nR[j - 1] + nL[j]); njR[j] = nR[j - 1] - w; njL[j] = nL[j] + w; }
    for (let j = 0; j < nn; j++) { nR[j] = njR[j] * 0.996; nL[j] = njL[j + 1] * 0.996; }
    const lip = A[n - 1] < 0.001 ? 0 : R[n - 1]; const nose = nR[nn - 1];
    const y = (lip - prevLip) + (nose - prevNose); prevLip = lip; prevNose = nose;
    acc = aa2.s(aa1.s(y));
    if (i & 1) out[i >> 1] = acc;
  }
  // normalise to unit RMS over the steady part
  const a = Math.floor((lead + Math.min(0.15, o.dur / 3)) * SR), b = Math.floor((lead + Math.min(o.dur, 0.6)) * SR); let e = 0; for (let i = a; i < b; i++) e += out[i] * out[i];
  const g = 1 / Math.sqrt(e / (b - a) + 1e-20); for (let i = 0; i < total; i++) out[i] *= g;
  return out;
}
/** time (s) into a voice() buffer where the sound starts */
export const VOICE_LEAD = 0.06;

export function whistle(midi: number, dur: number, seed = 1): Float32Array {
  const n = Math.floor((dur + 0.1) * SR); const out = new Float32Array(n); const r = rng(seed); let ph = 0, d = 0; const bp = new BQ('bp', m2f(midi), 8);
  for (let i = 0; i < n; i++) { const t = i / SR; d += 0.002 * (gauss(r) * 8 - d); ph += (2 * Math.PI * m2f(midi + d / 100 - 0.5 * Math.exp(-t / 0.04))) / SR; const e = Math.min(1, t / 0.05) * Math.min(1, Math.max(0, (dur - t) / 0.05)); out[i] = e * (Math.sin(ph) * (1 + 0.05 * gauss(r)) + 0.15 * bp.s(gauss(r))) * Math.SQRT2; }
  return out;
}

// ------------------------------------------------------------------ noise & room
export function pinkGen(seed: number): () => number {
  const r = rng(seed); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  return () => { const w = r() * 2 - 1; b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898; const o = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926; return o * 0.25; };
}
function fft(re: Float64Array, im: Float64Array, inv: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? -2 : 2) * Math.PI) / len; const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let j = 0; j < len / 2; j++) { const ur = re[i + j], ui = im[i + j]; const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr; re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
export interface Room { ir: Float32Array }
/** drrDb = direct-to-reverberant energy ratio; rt = RT60 (s) */
export function makeRoom(drrDb: number, rt: number, seed = 5): Room {
  const r = rng(seed); const n = Math.floor(Math.min(1.2, rt * 1.1) * SR); const ir = new Float32Array(n);
  const lp = new BQ('lp', 4500, 0.7); let e = 0;
  for (let i = Math.floor(0.012 * SR); i < n; i++) { const t = i / SR; ir[i] = lp.s(gauss(r)) * Math.pow(10, (-3 * t) / rt) * Math.min(1, (t - 0.012) / 0.02); e += ir[i] * ir[i]; }
  for (let q = 0; q < 6; q++) { const t = 0.004 + 0.03 * r(); const j = Math.floor(t * SR); const g = (r() < 0.5 ? -1 : 1) * db2a(-4 - 10 * r()); e += g * g * 0.5; ir[j] += g * Math.sqrt(0.5); }
  const g = Math.sqrt(Math.pow(10, -drrDb / 10) / e); for (let i = 0; i < n; i++) ir[i] *= g; ir[0] = 1;
  return { ir };
}
export function reverb(x: Float32Array, room: Room | null): Float32Array {
  if (!room) return x;
  const m = x.length + room.ir.length; let n = 1; while (n < m) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(x); br.set(room.ir); fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < n; i++) { const t = ar[i] * br[i] - ai[i] * bi[i]; ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = t; }
  fft(ar, ai, true); const out = new Float32Array(m); for (let i = 0; i < m; i++) out[i] = ar[i]; return out;
}
/** the app's reference tone as it leaks into the mic (same recipe as src/ui/audio.ts scheduleTone) */
export function refTone(midi: number, dur: number): Float32Array {
  const n = Math.floor((dur + 0.4) * SR); const out = new Float32Array(n); const f = m2f(midi); const hs = [1, 0.42, 0.22, 0.12, 0.07, 0.04, 0.025, 0.015];
  const peak = 0.34, sus = 0.22; const tS = Math.max(0.19, dur - 0.05);
  for (let i = 0; i < n; i++) { const t = i / SR; let e: number; if (t < 0.015) e = (peak * t) / 0.015; else if (t < 0.18) e = peak * Math.pow(sus / peak, (t - 0.015) / 0.165); else if (t < tS) e = sus; else e = sus * Math.pow(0.0001 / sus, Math.min(1, (t - tS) / (dur + 0.3 - tS))); let s = 0; for (let h = 0; h < 8; h++) s += hs[h] * Math.sin(2 * Math.PI * f * (h + 1) * t); out[i] = e * s; }
  return out;
}
export function rmsDb(x: Float32Array, a = 0, b = x.length): number { let e = 0; for (let i = a; i < b; i++) e += x[i] * x[i]; return 10 * Math.log10(e / (b - a) + 1e-20); }

/** Image-source shoebox room (independent check of the stochastic IR): returns IR normalised to direct = 1 */
export function makeRoomISM(dist: number, dims: [number, number, number] = [4.2, 5.1, 2.5], alpha = 0.3, seed = 1): Room {
  const r = rng(seed); const c = 343; const beta = -Math.sqrt(1 - alpha); const [Lx, Ly, Lz] = dims;
  const src = [1.3 + 0.4 * r(), 1.6 + 0.5 * r(), 0.9]; const ang = 2 * Math.PI * r(); const mic = [src[0] + dist * Math.cos(ang) * 0.95, src[1] + dist * Math.sin(ang) * 0.95, src[2] + dist * 0.3];
  const tmax = 0.7; const n = Math.floor(tmax * SR); const ir = new Float32Array(n); const N = Math.ceil((c * tmax) / Math.min(Lx, Ly, Lz)) + 1;
  const d0 = Math.hypot(mic[0] - src[0], mic[1] - src[1], mic[2] - src[2]);
  for (let nx = -N; nx <= N; nx++) for (let px = 0; px < 2; px++) { const x = (px ? -src[0] : src[0]) + 2 * nx * Lx - mic[0]; const hx = Math.abs(2 * nx - px);
    for (let ny = -N; ny <= N; ny++) for (let py = 0; py < 2; py++) { const y = (py ? -src[1] : src[1]) + 2 * ny * Ly - mic[1]; const hy = Math.abs(2 * ny - py); const dxy = x * x + y * y; if (dxy > (c * tmax) ** 2) continue;
      for (let nz = -N; nz <= N; nz++) for (let pz = 0; pz < 2; pz++) { const z = (pz ? -src[2] : src[2]) + 2 * nz * Lz - mic[2]; const d = Math.sqrt(dxy + z * z); const t = (d - d0) / c; if (t >= tmax) continue;
        const g = (Math.pow(beta, hx + hy + Math.abs(2 * nz - pz)) * d0) / d; const p = t * SR; const i = Math.floor(p); const fr = p - i; ir[i] += g * (1 - fr); if (i + 1 < n) ir[i + 1] += g * fr; } } }
  return { ir };
}
export function drrOf(room: Room): number { let d = 0, e = 0; for (let i = 0; i < room.ir.length; i++) { if (i < 0.0025 * SR) d += room.ir[i] ** 2; else e += room.ir[i] ** 2; } return 10 * Math.log10(d / e); }
