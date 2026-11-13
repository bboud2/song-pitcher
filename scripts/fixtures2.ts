// Second, independent synthesis model for adversarial gauntlet cases (contributed by the independent
// review of round 1; it shares no code with scripts/fixtures.ts): additive plucked strings with
// inharmonicity, per-partial decay, pitch glide, fret buzz; formant voices incl. humming; hum,
// high-pass, reverb. Deterministic.
export function rng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
export const mf = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export interface GuitarOpts {
  sr: number; seed?: number; amp?: number;
  profile?: 'normal' | 'weakfund' | 'nofund' | 'bright';
  glideCents?: number; glideTau?: number; // starts sharp, settles
  cents?: number;
  B?: number; t60?: number; buzz?: number;
  slideFromSemis?: number; slideSec?: number; // slide into the note
  f0fn?: (t: number) => number; // overrides: semitone offset vs midi over time
}
/** Additive plucked-string model: inharmonic partials, per-partial decay, pitch glide, pick noise, optional fret buzz. */
export function guitar(midi: number, dur: number, o: GuitarOpts): Float32Array {
  const sr = o.sr; const n = Math.floor(dur * sr); const out = new Float32Array(n);
  const r = rng((o.seed ?? 1) + midi * 131);
  const f = mf(midi) * Math.pow(2, (o.cents ?? 0) / 1200);
  const B = o.B ?? (midi < 50 ? 4e-4 : 1.5e-4);
  const K = Math.min(24, Math.floor((sr * 0.42) / f));
  const amps: number[] = []; const phases: number[] = []; const taus: number[] = [];
  const t60 = o.t60 ?? Math.max(1.0, 3.5 - (midi - 40) * 0.06);
  const pickPos = 0.13 + 0.1 * r();
  for (let k = 1; k <= K; k++) {
    let a = Math.abs(Math.sin(k * Math.PI * pickPos)) / k;
    const p = o.profile ?? 'normal';
    if (p === 'weakfund') a = k === 1 ? 0.08 : k === 2 ? 1 : k === 3 ? 0.8 : k === 4 ? 0.45 : 1.2 / k;
    if (p === 'nofund') a = k === 1 ? 0 : k === 2 ? 1 : k === 3 ? 0.8 : 1.5 / k;
    if (p === 'bright') a = Math.abs(Math.sin(k * Math.PI * 0.08)) / Math.sqrt(k);
    amps.push(a); phases.push(r() * 2 * Math.PI); taus.push((t60 / 6.9) / (1 + 0.22 * (k - 1)));
  }
  const glide = o.glideCents ?? 0; const gTau = o.glideTau ?? 0.08;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let semis = (glide * Math.exp(-t / gTau)) / 100;
    if (o.slideFromSemis && o.slideSec) semis += o.slideFromSemis * Math.max(0, 1 - t / o.slideSec);
    if (o.f0fn) semis += o.f0fn(t);
    const ratio = Math.pow(2, semis / 12);
    let v = 0;
    for (let k = 1; k <= K; k++) {
      const fk = f * ratio * k * Math.sqrt(1 + B * k * k);
      phases[k - 1] += (2 * Math.PI * fk) / sr;
      v += amps[k - 1] * Math.exp(-t / taus[k - 1]) * Math.sin(phases[k - 1]);
    }
    const att = Math.min(1, t / 0.002);
    out[i] = v * att;
  }
  // pick noise 6 ms
  const cl = Math.floor(0.006 * sr);
  for (let i = 0; i < cl && i < n; i++) out[i] += 0.6 * (r() * 2 - 1) * (1 - i / cl);
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const s = (o.amp ?? 0.4) / (peak || 1);
  for (let i = 0; i < n; i++) out[i] *= s;
  if (o.buzz) {
    // fret buzz: noise bursts gated once per period where the waveform is near its positive peak, decaying
    const thr = 0.35 * (o.amp ?? 0.4);
    let hp = 0; let prev = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const x = r() * 2 - 1; hp = 0.7 * (hp + x - prev); prev = x;
      const gate = out[i] > thr * Math.exp(-t / 0.5) ? 1 : 0;
      out[i] += o.buzz * (o.amp ?? 0.4) * gate * hp * Math.exp(-t / 0.6);
    }
  }
  const fade = Math.floor(0.003 * sr);
  for (let i = 0; i < fade && i < n; i++) out[n - 1 - i] *= i / fade;
  return out;
}

export interface VoiceOpts {
  sr: number; seed?: number; amp?: number; vowel?: 'a' | 'i' | 'u' | 'o' | 'hum';
  vibCents?: number; vibRate?: number; breath?: number; jitterCents?: number;
  /** semitone offset over time added to midi */
  f0fn?: (t: number) => number;
  /** amplitude envelope */
  envfn?: (t: number) => number;
  attack?: number;
}
const FORMANTS: Record<string, [number, number, number][]> = {
  a: [[730, 90, 1], [1090, 110, 0.5], [2440, 160, 0.25]],
  i: [[270, 60, 1], [2290, 120, 0.3], [3010, 180, 0.2]],
  u: [[300, 60, 1], [870, 90, 0.3], [2240, 150, 0.08]],
  o: [[570, 80, 1], [840, 100, 0.5], [2410, 160, 0.12]],
  hum: [[250, 80, 1], [1000, 300, 0.03], [2400, 400, 0.01]],
};
function formantGain(freq: number, vowel: string): number {
  let g = 0.02;
  for (const [F, bw, a] of FORMANTS[vowel]) g += a / Math.sqrt(1 + Math.pow((freq - F) / (bw / 2), 2));
  return g;
}
export function voice(midi: number, dur: number, o: VoiceOpts): Float32Array {
  const sr = o.sr; const n = Math.floor(dur * sr); const out = new Float32Array(n);
  const r = rng((o.seed ?? 7) + midi * 17);
  const vowel = o.vowel ?? 'a';
  const f = mf(midi);
  const K = Math.min(40, Math.floor(5000 / f));
  const ph = new Float64Array(K + 1);
  for (let k = 1; k <= K; k++) ph[k] = r() * 6.283;
  const vibPh0 = r() * 6.283; const vibRate = o.vibRate ?? 5.5; const vib = o.vibCents ?? 0;
  let jit = 0; let noiseLp = 0;
  const att = o.attack ?? 0.04;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    jit = 0.999 * jit + 0.001 * (r() * 2 - 1) * 30; // slow random drift, scaled below
    const semis = (o.f0fn ? o.f0fn(t) : 0) + (vib * Math.sin(vibPh0 + 2 * Math.PI * vibRate * t)) / 100 + ((o.jitterCents ?? 4) * jit) / 100;
    const f0 = f * Math.pow(2, semis / 12);
    let v = 0;
    for (let k = 1; k <= K; k++) {
      const fk = f0 * k;
      ph[k] += (2 * Math.PI * fk) / sr;
      v += (formantGain(fk, vowel) / Math.pow(k, 1.6)) * Math.sin(ph[k]);
    }
    const env = Math.min(1, t / att) * Math.min(1, (dur - t) / 0.05) * (o.envfn ? o.envfn(t) : 1);
    const nz = r() * 2 - 1; noiseLp = 0.6 * noiseLp + 0.4 * nz;
    out[i] = env * v + env * (o.breath ?? 0) * (nz - noiseLp) * 0.5;
  }
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const s = (o.amp ?? 0.3) / (peak || 1);
  for (let i = 0; i < n; i++) out[i] *= s;
  return out;
}

export function silence(dur: number, sr: number) { return new Float32Array(Math.floor(dur * sr)); }
export function mix(dst: Float32Array, src: Float32Array, atSec: number, sr: number, gain = 1) {
  const at = Math.floor(atSec * sr);
  for (let i = 0; i < src.length && at + i < dst.length; i++) dst[at + i] += gain * src[i];
  return dst;
}
export function whiteNoise(x: Float32Array, rms: number, seed: number) {
  const r = rng(seed); const a = rms * Math.sqrt(3);
  for (let i = 0; i < x.length; i++) x[i] += a * (r() * 2 - 1);
  return x;
}
export function hum(x: Float32Array, sr: number, base: number, rms: number, harm = [1, 0.6, 0.35, 0.1]) {
  let norm = 0; for (const h of harm) norm += h * h / 2; norm = Math.sqrt(norm);
  for (let i = 0; i < x.length; i++) {
    let v = 0; for (let k = 0; k < harm.length; k++) v += harm[k] * Math.sin((2 * Math.PI * base * (k + 1) * i) / sr + k);
    x[i] += (rms / norm) * v;
  }
  return x;
}
/** RBJ high-pass biquad applied `stages` times (2 = 4th order). */
export function highpass(x: Float32Array, sr: number, fc: number, stages = 2): Float32Array {
  let y = x;
  for (let s = 0; s < stages; s++) {
    const w = (2 * Math.PI * fc) / sr; const al = Math.sin(w) / (2 * 0.7071); const c = Math.cos(w);
    const b0 = (1 + c) / 2, b1 = -(1 + c), b2 = (1 + c) / 2, a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
    const o = new Float32Array(y.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = (b0 * y[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1; x1 = y[i]; y2 = y1; y1 = v; o[i] = v;
    }
    y = o;
  }
  return y;
}
/** Sparse-tap room reverb (early reflections + diffuse tail), RT60 configurable. */
export function reverb(x: Float32Array, sr: number, rt60 = 0.5, wet = 0.5, seed = 5): Float32Array {
  const r = rng(seed); const taps: [number, number][] = [];
  for (let k = 0; k < 120; k++) {
    const t = 0.004 + r() * rt60 * 1.1;
    taps.push([Math.floor(t * sr), (r() < 0.5 ? -1 : 1) * Math.pow(10, (-3 * t) / rt60) * wet * 0.25]);
  }
  const o = new Float32Array(x.length); o.set(x);
  for (const [d, g] of taps) for (let i = d; i < x.length; i++) o[i] += g * x[i - d];
  return o;
}
export function rms(x: Float32Array, a = 0, b = x.length) { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); }
export function encodeWav(x: Float32Array, sr: number): Uint8Array {
  const b = new ArrayBuffer(44 + x.length * 2); const v = new DataView(b);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + x.length * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  return new Uint8Array(b);
}
