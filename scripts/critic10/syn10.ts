// Tenth review (ported unchanged except for where it finds the build).
// @ts-nocheck (ported review tooling, kept as written)
// Critic-10 synthesis: written from scratch (no code shared with earlier critics' rigs).
export const SR = 48000;
export function rng(seed: number): () => number { let a = (seed * 2654435761) >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function gauss(r: () => number): number { let u = 0; while (u < 1e-12) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307 * r()); }
export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const db2a = (d: number) => Math.pow(10, d / 20);
export const a2db = (a: number) => 20 * Math.log10(Math.max(a, 1e-12));

// ---------- biquad (RBJ)
export class BQ {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0; z1 = 0; z2 = 0;
  constructor(type: 'hp' | 'lp' | 'bp' | 'pk', f: number, q: number, gainDb = 0) {
    const w = 2 * Math.PI * f / SR, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q); let b0, b1, b2, a0, a1, a2;
    if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else { const A = Math.pow(10, gainDb / 40); b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  s(x: number): number { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
  run(x: Float32Array): Float32Array { const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = this.s(x[i]); return y; }
}

// ---------- FFT convolution
function fft(re: Float64Array, im: Float64Array, inv: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? -2 : 2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const ur = re[i + k], ui = im[i + k]; const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr; re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
export function convolve(x: Float32Array, ir: Float32Array): Float32Array {
  const L = x.length + ir.length - 1; let n = 1; while (n < L) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(x); br.set(ir); fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < n; i++) { const r = ar[i] * br[i] - ai[i] * bi[i]; ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = r; }
  fft(ar, ai, true); const y = new Float32Array(L); for (let i = 0; i < L; i++) y[i] = ar[i]; return y;
}

// ---------- rooms. drr = direct-to-reverberant energy ratio (dB) for a source 50 cm from the phone.
export const ROOMS: Record<string, { rt: number; drr: number } | null> = {
  dry: null,
  living: { rt: 0.45, drr: 7 },
  garage: { rt: 1.6, drr: -1 },
  tiled: { rt: 2.4, drr: -5 },
};
const irMemo = new Map<string, Float32Array | null>();
/** extraDrr: add for a source nearer the mic (the phone's own speaker ~5 cm: +20 dB) */
export function roomIR(room: string, variant: number, extraDrr = 0): Float32Array | null {
  const k = `${room}|${variant}|${extraDrr}`; if (irMemo.has(k)) return irMemo.get(k)!;
  const R = ROOMS[room]; if (!R) { irMemo.set(k, null); return null; }
  const r = rng(977 + variant * 31 + room.length * 7); const n = Math.floor(Math.min(3.2, R.rt * 1.35) * SR); const ir = new Float32Array(n);
  const lo = new BQ('lp', 1600, 0.6), hi = new BQ('hp', 1600, 0.6); const t0 = Math.floor(0.012 * SR);
  for (let i = t0; i < n; i++) { const t = (i - t0) / SR; const w = gauss(r); const build = Math.min(1, t / 0.02); ir[i] = build * (lo.s(w) * Math.exp(-6.908 * t / R.rt) + 0.8 * hi.s(w) * Math.exp(-6.908 * t / (R.rt * 0.55))); }
  // early reflections
  for (let k2 = 0; k2 < 7; k2++) { const d = Math.floor((0.003 + 0.028 * r()) * SR); ir[d] += (r() < 0.5 ? -1 : 1) * (0.25 + 0.4 * r()) * 3; }
  let e = 0; for (let i = 0; i < n; i++) e += ir[i] * ir[i];
  const g = Math.sqrt(Math.pow(10, -(R.drr + extraDrr) / 10) / e); for (let i = 0; i < n; i++) ir[i] *= g;
  ir[0] += 1; irMemo.set(k, ir); return ir;
}

// ---------- guitar
export type Style = 'pick' | 'finger' | 'thumb' | 'hammer';
export interface GOpts { midi: number; cents?: number; style?: Style; dur?: number; seed?: number; pos?: number; open?: boolean; sustain?: number }
export const G_LEAD = 0.002;
const OPEN = [40, 45, 50, 55, 59, 64];
export function stringFor(m: number): number { let s = 0; for (let i = 0; i < 6; i++) if (OPEN[i] <= m) s = i; return s; }
export function guitar(o: GOpts): Float32Array {
  const r = rng((o.seed ?? 1) * 7919 + o.midi * 13); const style = o.style ?? 'pick';
  const f0 = mtof(o.midi + (o.cents ?? 0) / 100); const dur = o.dur ?? 5; const n = Math.floor(dur * SR); const y = new Float32Array(n);
  const open = o.open ?? OPEN.includes(o.midi); const str = stringFor(o.midi); const wound = str <= 2;
  const B = wound ? 6e-5 : 2.5e-5 * (1 + 0.5 * (o.midi - OPEN[str]) / 4);
  const pos = o.pos ?? (0.13 + 0.1 * r());
  const ramp = { pick: 0.0006, finger: 0.004, thumb: 0.011, hammer: 0.003 }[style];
  const roll = { pick: 1.0, finger: 1.5, thumb: 2.1, hammer: 1.4 }[style];
  let t60 = Math.max(2.2, Math.min(8, 5.5 * Math.sqrt(110 / f0))) * (open ? 1 : 0.7) * (o.sustain ?? 1); if (style === 'hammer') t60 *= 0.7;
  const lead = Math.floor(G_LEAD * SR); const nr = Math.max(1, Math.floor(ramp * SR));
  const K = Math.min(60, Math.floor(11000 / f0));
  const bodyG = (f: number) => 1 + 1.2 * Math.exp(-Math.pow((f - 105) / 25, 2)) + 1.0 * Math.exp(-Math.pow((f - 205) / 40, 2)) + 0.4 * Math.exp(-Math.pow((f - 420) / 90, 2));
  for (let k = 1; k <= K; k++) {
    const fk = k * f0 * Math.sqrt(1 + B * k * k); if (fk > 0.45 * SR) break;
    let a = Math.abs(Math.sin(k * Math.PI * pos)) / Math.pow(k, roll) * bodyG(fk) * (0.8 + 0.4 * r());
    if (style === 'hammer' && k > 6) a *= 0.5;
    const tk = t60 / (1 + 0.07 * Math.pow(k - 1, 1.35)) / 6.908;
    for (let pol = 0; pol < 2; pol++) {
      const fp = fk * (pol ? 1 + (0.25 + 0.6 * r()) * 0.00058 : 1); const ap = a * (pol ? 0.55 : 1); const tp = tk * (pol ? 0.45 : 1);
      const w = 2 * Math.PI * fp / SR; const ph = 6.2832 * r(); const dec = Math.exp(-1 / (tp * SR)); let env = ap;
      // recursive oscillator
      let s1 = Math.sin(ph - w), s2 = Math.sin(ph - 2 * w); const c2 = 2 * Math.cos(w);
      for (let i = lead; i < n; i++) { const s = c2 * s1 - s2; s2 = s1; s1 = s; const j = i - lead; y[i] += (j < nr ? 0.5 - 0.5 * Math.cos(Math.PI * j / nr) : 1) * env * s; env *= dec; if (env < 1e-6) break; }
    }
  }
  // normalise the string part to a peak of 1 before adding transients
  let pk = 0; for (let i = 0; i < Math.min(n, SR / 2); i++) pk = Math.max(pk, Math.abs(y[i])); for (let i = 0; i < n; i++) y[i] /= pk;
  const clickDb = { pick: -10, finger: -30, thumb: -60, hammer: -26 }[style];
  if (clickDb > -50) { const hp = new BQ('hp', 3200, 0.7); const g = db2a(clickDb); for (let i = 0; i < 0.012 * SR; i++) y[lead + i] += g * 2.2 * hp.s(gauss(r)) * Math.exp(-i / (0.0018 * SR)); }
  const thump = { pick: -16, finger: -14, thumb: -9, hammer: -20 }[style]; const tg = db2a(thump);
  for (let i = 0; i < 0.09 * SR; i++) { const t = i / SR; y[lead + i] += tg * Math.exp(-t / 0.018) * (Math.sin(6.2832 * 102 * t) + 0.6 * Math.sin(6.2832 * 196 * t + 1)); }
  return y;
}

// ---------- voice (additive harmonics under a moving formant envelope)
const VOWELS: Record<string, [number, number, number][]> = {
  a: [[730, 90, 1], [1090, 110, 0.5], [2440, 160, 0.25]],
  o: [[500, 80, 1], [850, 100, 0.45], [2500, 160, 0.12]],
  u: [[330, 70, 1], [780, 100, 0.25], [2400, 160, 0.06]],
  e: [[520, 80, 1], [1800, 130, 0.4], [2500, 170, 0.22]],
  i: [[290, 60, 1], [2250, 150, 0.3], [3000, 200, 0.2]],
  m: [[250, 60, 1], [1100, 300, 0.05], [2500, 300, 0.02]],
};
export type Onset = 'soft' | 'normal' | 'd' | 't' | 'm' | 'l';
export interface VOpts { midi: number; cents?: number; dur: number; vowel?: string; onset?: Onset; scoop?: number; vib?: number; fade?: number; seed?: number; female?: boolean; breath?: number; rise?: number }
export const V_LEAD = 0.03;
function formantGain(f: number, F: [number, number, number][], scale: number): number { let g = 0.02; for (const [fc, bw, a] of F) { const x = (f - fc * scale) / (bw * scale); g += a / (1 + x * x); } return g; }
export function voice(o: VOpts): Float32Array {
  const r = rng((o.seed ?? 1) * 104729 + o.midi * 17 + Math.floor(o.dur * 100));
  const n = Math.floor((o.dur + 0.25) * SR); const y = new Float32Array(n); const lead = Math.floor(V_LEAD * SR);
  const m0 = o.midi + (o.cents ?? 0) / 100; const onset = o.onset ?? 'normal'; const scale = o.female ? 1.17 : 1;
  const rise = o.rise ?? { soft: 0.14, normal: 0.07, d: 0.018, t: 0.022, m: 0.05, l: 0.05 }[onset];
  const scoop = o.scoop ?? (40 + 60 * r()); const vib = o.vib ?? (12 + 14 * r()); const vr = 5.2 + 0.9 * r();
  const F = VOWELS[o.vowel ?? 'a']; const Fc = onset === 'm' || onset === 'l' ? VOWELS.m : F; const cDur = onset === 'm' ? 0.09 : onset === 'l' ? 0.06 : 0;
  const BL = 96; // control block
  const K = Math.min(48, Math.floor(5200 / mtof(m0)));
  const ph = new Float64Array(K + 1); const amp = new Float64Array(K + 1); const ampT = new Float64Array(K + 1);
  let jit = 0, shim = 0, drift = 0;
  for (let b = lead; b < n; b += BL) {
    const t = (b - lead) / SR;
    jit += 0.25 * (gauss(r) * 6 - jit); shim += 0.2 * (gauss(r) * 0.06 - shim); drift += 0.01 * (gauss(r) * 8 - drift);
    const cents = -scoop * Math.exp(-t / 0.05) + (t > 0.25 ? vib * Math.min(1, (t - 0.25) / 0.4) * Math.sin(6.2832 * vr * t) : 0) + jit + drift;
    const f0 = mtof(m0 + cents / 100);
    let env = t < o.dur ? Math.min(1, 0.02 + t / rise) : Math.max(0, 1 - (t - o.dur) / 0.09);
    env = env * env * (3 - 2 * env); env *= (1 + shim) * db2a(-(o.fade ?? 0) * t);
    const mix = cDur ? Math.min(1, Math.max(0, (t - cDur + 0.02) / 0.03)) : 1;
    for (let k = 1; k <= K; k++) { const fk = k * f0; const src = 1 / Math.pow(k, 1.9 + (o.breath ?? 0)); ampT[k] = fk < 0.45 * SR ? env * src * ((1 - mix) * 0.5 * formantGain(fk, Fc, scale) + mix * formantGain(fk, F, scale)) : 0; }
    const w0 = 2 * Math.PI * f0 / SR;
    for (let i = b; i < Math.min(n, b + BL); i++) { const u = (i - b) / BL; let s = 0; for (let k = 1; k <= K; k++) { ph[k] += k * w0; s += (amp[k] + u * (ampT[k] - amp[k])) * Math.sin(ph[k]); } y[i] = s; }
    for (let k = 1; k <= K; k++) { amp[k] = ampT[k]; if (ph[k] > 1e4) ph[k] %= 6.283185307; }
  }
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(y[i])); for (let i = 0; i < n; i++) y[i] /= pk;
  // breath noise
  const bp = new BQ('bp', 2200, 0.8); const bg = db2a(-34 + 10 * (o.breath ?? 0));
  for (let i = lead; i < n; i++) { const t = (i - lead) / SR; const e = t < o.dur ? Math.min(1, t / 0.05) : Math.max(0, 1 - (t - o.dur) / 0.1); y[i] += bg * e * bp.s(gauss(r)) * db2a(-(o.fade ?? 0) * t); }
  if (onset === 'd' || onset === 't') { const hp = new BQ('hp', onset === 't' ? 3500 : 1800, 0.7); const L = onset === 't' ? 0.035 : 0.012; const g = db2a(onset === 't' ? -14 : -18); const st = lead - Math.floor((onset === 't' ? 0.02 : 0.004) * SR); for (let i = 0; i < L * SR; i++) if (st + i >= 0) y[st + i] += g * 2 * hp.s(gauss(r)) * Math.exp(-i / (L * 0.4 * SR)); }
  return y;
}

// ---------- talking: syllables on a falling, wandering pitch
export function speech(sec: number, seed: number, female = false): Float32Array {
  const r = rng(seed * 31337 + 5); const y = new Float32Array(Math.floor(sec * SR)); let t = 0.1; const base = female ? 57 : 45; let m = base + 3;
  const vs = ['a', 'o', 'u', 'e', 'i']; const ons: Onset[] = ['normal', 'd', 't', 'm', 'l', 'normal'];
  while (t < sec - 0.5) {
    const words = 3 + Math.floor(6 * r()); m = base + 2 + 4 * r();
    for (let w = 0; w < words && t < sec - 0.4; w++) {
      const d = 0.09 + 0.16 * r(); m += -0.5 + (r() - 0.5) * 3; const stress = r() < 0.3 ? 2.5 : 0;
      const v = voice({ midi: Math.round(m + stress), cents: Math.round((m + stress - Math.round(m + stress)) * 100), dur: d, vowel: vs[Math.floor(5 * r())], onset: ons[Math.floor(6 * r())], scoop: (r() - 0.3) * 250, vib: 0, seed: Math.floor(r() * 1e6), female });
      const g = db2a(-6 * r() - (stress ? 0 : 3)); const st = Math.floor(t * SR); for (let i = 0; i < v.length && st + i < y.length; i++) y[st + i] += g * v[i];
      t += d + (r() < 0.25 ? 0.05 + 0.1 * r() : 0.01);
    }
    t += 0.25 + 0.7 * r();
  }
  return y;
}

// ---------- the app's reference tone (src/ui/audio.ts scheduleTone), then a phone loudspeaker
export function refTone(midi: number, dur: number, phoneSpeaker = true): Float32Array {
  const H = [1, 0.42, 0.22, 0.12, 0.07, 0.04, 0.025, 0.015]; const f = mtof(midi); const n = Math.floor((dur + 0.4) * SR); let y = new Float32Array(n);
  const peak = 0.34, sus = 0.22, hold = Math.max(0.19, dur - 0.05);
  for (let i = 0; i < n; i++) {
    const t = i / SR; let e: number;
    if (t < 0.015) e = 0.0001 + (peak - 0.0001) * t / 0.015; else if (t < 0.18) e = peak * Math.pow(sus / peak, (t - 0.015) / 0.165); else if (t < hold) e = sus; else if (t < dur + 0.3) e = sus * Math.pow(0.0001 / sus, (t - hold) / (dur + 0.3 - hold)); else e = 0;
    let s = 0; for (let k = 0; k < H.length; k++) s += H[k] * Math.sin(6.2832 * (k + 1) * f * t); y[i] = e * s;
  }
  y = new BQ('lp', Math.min(6000, 9 * f), 0.4).run(y);
  if (phoneSpeaker) { y = new BQ('hp', 420, 0.8).run(y); y = new BQ('hp', 300, 0.7).run(y); y = new BQ('pk', 1100, 1.5, 5).run(y); }
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(y[i])); for (let i = 0; i < n; i++) y[i] /= pk; return y;
}
export function smallSpeaker(x: Float32Array): Float32Array { return new BQ('pk', 1500, 1.2, 4).run(new BQ('hp', 250, 0.7).run(new BQ('hp', 180, 0.7).run(x))); }
