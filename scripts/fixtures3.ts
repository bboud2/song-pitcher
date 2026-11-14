// Third synthesis model for gauntlet cases (contributed by the round-2 independent review; shares
// no code with fixtures.ts / fixtures2.ts): two-polarisation Karplus-Strong strings with beating,
// bends, hammer-ons, taps; source-filter voices with fry/falsetto; whistle; fan, hum, TV babble,
// clicks, reverb, compressor, phone AGC, clipping. Deterministic.
export function rng(seed: number): () => number {
  let a = (seed * 0x9e3779b1 + 0x85ebca6b) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const mf = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const db2a = (d: number) => Math.pow(10, d / 20);
export function peakNorm(x: Float32Array, peak: number): Float32Array {
  let p = 0; for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  const s = peak / (p || 1); for (let i = 0; i < x.length; i++) x[i] *= s; return x;
}
export function rms(x: Float32Array, a = 0, b = x.length) { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); }

export interface KsOpts {
  sr: number; seed?: number; peak?: number;
  /** decay of the slow polarisation, dB per second */
  decayDbS?: number;
  /** decay of the fast polarisation (two-stage decay), dB/s; default 3x slow */
  fastDecayDbS?: number;
  /** Hz difference between the two polarisations (beating) */
  beatHz?: number;
  /** relative level of the second polarisation */
  pol2?: number;
  /** brightness 0..1 (loss filter coefficient; higher = duller) */
  dull?: number;
  /** attack time of the excitation in s (finger = 0.02-0.04, pick = 0.002) */
  attack?: number;
  /** semitone offset over time (bend, vibrato, slide, hammer) */
  semis?: (t: number) => number;
  /** extra excitation bursts: [time, gain] (hammer-on tap etc) */
  taps?: [number, number][];
  cents?: number;
  pickNoise?: number;
  /** sine-like (harmonic at 12th fret): excite with only fundamental */
  pure?: boolean;
}
/** Two-polarisation Karplus-Strong string with a time-varying delay. */
export function ks(midi: number, dur: number, o: KsOpts): Float32Array {
  const sr = o.sr; const n = Math.floor(dur * sr); const out = new Float32Array(n);
  const r = rng((o.seed ?? 1) * 7919 + midi);
  const f0 = mf(midi) * Math.pow(2, (o.cents ?? 0) / 1200);
  const a = o.dull ?? Math.max(0.03, Math.min(0.4, 0.35 * Math.pow(110 / f0, 0.8))); // one-pole coefficient
  const lpDelay = a / (1 - a);
  const L = 4096 * 2;
  const pols = [
    { det: 0, rate: o.decayDbS ?? 12, gain: 1 },
    { det: o.beatHz ?? 0.25, rate: o.fastDecayDbS ?? (o.decayDbS ?? 12) * 3, gain: o.pol2 ?? 0.8 },
  ];
  // excitation: band-limited noise burst shaped by pick position comb
  const exLen = Math.floor(sr / f0);
  const ex = new Float32Array(exLen + 1);
  const pos = 0.12 + 0.1 * r();
  if (o.pure) {
    for (let i = 0; i < exLen; i++) ex[i] = Math.sin((2 * Math.PI * i) / exLen);
  } else {
    let lp = 0;
    const raw = new Float32Array(exLen);
    for (let i = 0; i < exLen; i++) { lp = 0.6 * lp + 0.4 * (r() * 2 - 1); raw[i] = lp; }
    const d = Math.max(1, Math.floor(pos * exLen));
    for (let i = 0; i < exLen; i++) ex[i] = raw[i] - raw[(i + exLen - d) % exLen];
  }
  const attN = Math.max(1, Math.floor((o.attack ?? 0.002) * sr));
  for (const p of pols) {
    const buf = new Float32Array(L); let w = 0; let lpz = 0;
    const tapsQ = (o.taps ?? []).map(([t, g]) => ({ i: Math.floor(t * sr), g }));
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const f = (f0 + p.det) * Math.pow(2, (o.semis ? o.semis(t) : 0) / 12);
      const g = Math.pow(10, -p.rate / (20 * f)); // per-period amplitude loss
      const D = sr / f - lpDelay;
      const rp = w - D; const i0 = Math.floor(rp); const fr = rp - i0;
      const x0 = buf[(i0 + L * 4) % L]; const x1 = buf[(i0 + 1 + L * 4) % L];
      const x = x0 + fr * (x1 - x0);
      lpz = (1 - a) * x + a * lpz;
      let y = g * lpz;
      if (i < exLen) y += ex[i];
      for (const tq of tapsQ) { const k = i - tq.i; if (k >= 0 && k < exLen) y += tq.g * ex[k]; }
      buf[w % L] = y; w++;
      out[i] += p.gain * y;
    }
  }
  if ((o.attack ?? 0) > 0.004) { for (let i = 0; i < attN && i < n; i++) out[i] *= i / attN; }
  if (o.pickNoise ?? 0.3) {
    const cl = Math.floor(0.005 * sr); let p = 0;
    for (let i = 0; i < cl && i < n; i++) p = Math.max(p, Math.abs(out[i + cl] || 0));
    for (let i = 0; i < cl && i < n; i++) out[i] += (o.pickNoise ?? 0.3) * p * (r() * 2 - 1) * (1 - i / cl);
  }
  return peakNorm(out, o.peak ?? 0.2);
}

export interface VoOpts {
  sr: number; seed?: number; peak?: number;
  vowel?: 'a' | 'e' | 'i' | 'o' | 'u' | 'm';
  semis?: (t: number) => number; env?: (t: number) => number;
  vibCents?: number; vibHz?: number; jitter?: number; shimmer?: number;
  breath?: number; tilt?: number; // tilt: source low-pass corner in harmonics (lower = more sine-like)
  fry?: number; // 0..1 alternate-pulse amplitude modulation (period doubling)
  formantScale?: number;
  attack?: number; release?: number;
}
const FORM: Record<string, [number, number, number][]> = {
  a: [[800, 80, 1], [1150, 90, 0.6], [2900, 120, 0.2], [3900, 130, 0.1]],
  e: [[400, 70, 1], [1700, 100, 0.4], [2600, 120, 0.25], [3200, 120, 0.1]],
  i: [[280, 60, 1], [2250, 100, 0.25], [2900, 120, 0.2], [3500, 130, 0.1]],
  o: [[450, 70, 1], [800, 80, 0.5], [2830, 100, 0.08], [3800, 130, 0.03]],
  u: [[325, 50, 1], [700, 60, 0.3], [2700, 100, 0.03], [3800, 120, 0.01]],
  m: [[250, 60, 1], [1200, 200, 0.03], [2400, 300, 0.01], [3600, 300, 0.005]],
};
class Reson {
  private b0: number; private a1: number; private a2: number; private y1 = 0; private y2 = 0;
  constructor(sr: number, f: number, bw: number) {
    const rr = Math.exp((-Math.PI * bw) / sr);
    this.a1 = -2 * rr * Math.cos((2 * Math.PI * f) / sr); this.a2 = rr * rr; this.b0 = 1 - rr;
  }
  p(x: number) { const y = this.b0 * x - this.a1 * this.y1 - this.a2 * this.y2; this.y2 = this.y1; this.y1 = y; return y; }
}
/** Source-filter voice: polyBLEP pulse train through parallel formant resonators. */
export function vo(midi: number, dur: number, o: VoOpts): Float32Array {
  const sr = o.sr; const n = Math.floor(dur * sr); const out = new Float32Array(n);
  const r = rng((o.seed ?? 3) * 104729 + midi * 31);
  const fs = o.formantScale ?? 1;
  const res = FORM[o.vowel ?? 'a'].map(([f, bw, g]) => ({ r: new Reson(sr, f * fs, bw * fs), g }));
  let ph = r(); let pulse = 0; let jit = 0; let shim = 1; let lp1 = 0; let lp2 = 0; let nz1 = 0;
  const vibPh = r() * 6.283; const vib = o.vibCents ?? 0; const vHz = o.vibHz ?? 5.3;
  const att = o.attack ?? 0.05; const rel = o.release ?? 0.06;
  let drift = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    drift = 0.9995 * drift + 0.0005 * (r() * 2 - 1) * 40;
    const semis = (o.semis ? o.semis(t) : 0) + (vib * Math.sin(vibPh + 6.283 * vHz * t)) / 100 + (drift * 6) / 100 + jit;
    const f = mf(midi) * Math.pow(2, semis / 12);
    const dt = f / sr;
    ph += dt;
    let saw = 2 * ph - 1;
    if (ph >= 1) {
      ph -= 1; pulse++;
      jit = (o.jitter ?? 0.004) * (r() * 2 - 1) * 12; // semitone fraction per period
      shim = 1 + (o.shimmer ?? 0.03) * (r() * 2 - 1);
      if (o.fry && pulse % 2 === 1) shim *= 1 - o.fry;
      saw = 2 * ph - 1;
    }
    // polyBLEP
    if (ph < dt) { const x = ph / dt; saw -= x + x - x * x - 1; }
    else if (ph > 1 - dt) { const x = (ph - 1) / dt; saw -= x * x + x + x + 1; }
    // glottal tilt: two one-poles at tilt*f
    const fc = Math.min(0.45 * sr, (o.tilt ?? 6) * f);
    const k = 1 - Math.exp((-6.283 * fc) / sr);
    lp1 += k * (saw * shim - lp1); lp2 += k * (lp1 - lp2);
    const nz = r() * 2 - 1; nz1 = 0.7 * nz1 + 0.3 * nz;
    const src = lp2 + (o.breath ?? 0.02) * (nz - nz1) * (0.6 + 0.4 * Math.max(0, saw));
    let v = 0; for (const q of res) v += q.g * q.r.p(src);
    v += 0.15 * lp2; // some direct low-frequency energy
    const e = Math.min(1, t / att) * Math.min(1, Math.max(0, (dur - t) / rel)) * (o.env ? o.env(t) : 1);
    out[i] = e * v;
  }
  return peakNorm(out, o.peak ?? 0.15);
}

export function whistle(midi: number, dur: number, sr: number, seed = 1, peak = 0.1): Float32Array {
  const n = Math.floor(dur * sr); const out = new Float32Array(n); const r = rng(seed * 13 + midi);
  let ph = 0; let d = 0; let bp1 = 0; let bp2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr; d = 0.999 * d + 0.001 * (r() * 2 - 1) * 60;
    const f = mf(midi) * Math.pow(2, (d * 0.5 + 8 * Math.sin(6.283 * 5 * t)) / 1200);
    ph += (6.283 * f) / sr;
    const nz = r() * 2 - 1; bp1 += 0.3 * (nz - bp1); bp2 += 0.05 * (bp1 - bp2);
    const e = Math.min(1, t / 0.06) * Math.min(1, (dur - t) / 0.05) * (1 + 0.15 * Math.sin(6.283 * 5 * t + 1));
    out[i] = e * (Math.sin(ph) + 0.03 * Math.sin(2 * ph) + 0.25 * (bp1 - bp2));
  }
  return peakNorm(out, peak);
}

export function silence(dur: number, sr: number) { return new Float32Array(Math.floor(dur * sr)); }
export function cat(...xs: Float32Array[]): Float32Array {
  const o = new Float32Array(xs.reduce((a, x) => a + x.length, 0)); let p = 0;
  for (const x of xs) { o.set(x, p); p += x.length; } return o;
}
export function mixAt(dst: Float32Array, src: Float32Array, atSec: number, sr: number, gain = 1) {
  const at = Math.floor(atSec * sr);
  for (let i = Math.max(0, -at); i < src.length && at + i < dst.length; i++) dst[at + i] += gain * src[i];
  return dst;
}
export function white(x: Float32Array, levelDb: number, seed: number) {
  const r = rng(seed); const a = db2a(levelDb) * Math.sqrt(3);
  for (let i = 0; i < x.length; i++) x[i] += a * (r() * 2 - 1); return x;
}
/** fan / room rumble: brown-ish noise + a couple of blade tones */
export function fan(x: Float32Array, sr: number, levelDb: number, seed: number) {
  const r = rng(seed); const t = new Float32Array(x.length); let b = 0; let b2 = 0;
  for (let i = 0; i < x.length; i++) {
    b = 0.995 * b + 0.05 * (r() * 2 - 1); b2 = 0.9 * b2 + 0.1 * (r() * 2 - 1);
    t[i] = b + 0.3 * b2 + 0.05 * Math.sin((6.283 * 87 * i) / sr) + 0.03 * Math.sin((6.283 * 174 * i) / sr);
  }
  const s = db2a(levelDb) / (rms(t) || 1);
  for (let i = 0; i < x.length; i++) x[i] += s * t[i]; return x;
}
export function hum(x: Float32Array, sr: number, base: number, levelDb: number, harm = [1, 0.5, 0.7, 0.15, 0.3]) {
  const t = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) { let v = 0; for (let k = 0; k < harm.length; k++) v += harm[k] * Math.sin((6.283 * base * (k + 1) * i) / sr + k * 1.3); t[i] = v; }
  const s = db2a(levelDb) / rms(t);
  for (let i = 0; i < x.length; i++) x[i] += s * t[i]; return x;
}
/** speech-like babble: syllables with gliding pitch, changing vowels, fricative bursts, pauses */
export function tv(dur: number, sr: number, seed: number): Float32Array {
  const r = rng(seed); const out = new Float32Array(Math.floor(dur * sr)); let t = 0.05;
  const vowels = ['a', 'e', 'i', 'o', 'u'] as const;
  while (t < dur - 0.3) {
    const d = 0.09 + 0.2 * r(); const m = 45 + 14 * r() + (r() < 0.3 ? 12 : 0); const gl = (r() * 2 - 1) * 5;
    const syl = vo(Math.round(m), d, { sr, seed: Math.floor(r() * 1e6), vowel: vowels[Math.floor(r() * 5)], semis: (tt) => (m - Math.round(m)) + (gl * tt) / d, peak: 0.1 + 0.1 * r(), attack: 0.015, release: 0.03 });
    mixAt(out, syl, t, sr);
    if (r() < 0.4) { const fr = white(silence(0.05 + 0.05 * r(), sr), -24, Math.floor(r() * 1e6)); let hp = 0; for (let i = 0; i < fr.length; i++) { const v = fr[i]; fr[i] = v - hp; hp = v; } mixAt(out, fr, t + d, sr); }
    t += d + (r() < 0.2 ? 0.25 + 0.3 * r() : 0.03 + 0.08 * r());
  }
  return out;
}
export function clicks(x: Float32Array, sr: number, bpm: number, levelDb: number) {
  const per = Math.floor((60 / bpm) * sr); const len = Math.floor(0.03 * sr); const a = db2a(levelDb);
  for (let s = Math.floor(0.11 * sr); s < x.length; s += per) for (let i = 0; i < len && s + i < x.length; i++) x[s + i] += a * Math.sin((6.283 * 1500 * i) / sr) * Math.exp(-i / (0.004 * sr));
  return x;
}
export function biquad(x: Float32Array, sr: number, type: 'hp' | 'lp', fc: number, q = 0.707): Float32Array {
  const w = (6.283185 * fc) / sr; const al = Math.sin(w) / (2 * q); const c = Math.cos(w);
  const b0 = type === 'hp' ? (1 + c) / 2 : (1 - c) / 2; const b1 = type === 'hp' ? -(1 + c) : 1 - c; const a0 = 1 + al;
  const o = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b0 * x2 + 2 * c * y1 - (1 - al) * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; o[i] = v; }
  return o;
}
/** exponentially decaying noise impulse response reverb, sparse taps */
export function reverb(x: Float32Array, sr: number, rt60: number, wetDb: number, seed = 9): Float32Array {
  const r = rng(seed); const o = new Float32Array(x.length); o.set(x); const N = 220;
  const wet = db2a(wetDb) / Math.sqrt(N / 6);
  for (let k = 0; k < N; k++) {
    const t = 0.006 + Math.pow(r(), 1.5) * rt60; const d = Math.floor(t * sr); const g = (r() < 0.5 ? -1 : 1) * Math.pow(10, (-3 * t) / rt60) * wet;
    for (let i = d; i < x.length; i++) o[i] += g * x[i - d];
  }
  return o;
}
/** feed-forward compressor on a peak envelope */
export function compress(x: Float32Array, sr: number, threshDb: number, ratio: number, makeupDb: number, attMs = 5, relMs = 150): Float32Array {
  const o = new Float32Array(x.length); let env = 0; const ka = Math.exp(-1 / ((attMs / 1000) * sr)); const kr = Math.exp(-1 / ((relMs / 1000) * sr));
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]); env = a > env ? ka * env + (1 - ka) * a : kr * env + (1 - kr) * a;
    const d = 20 * Math.log10(Math.max(env, 1e-7)); const over = d - threshDb; const gr = over > 0 ? -over * (1 - 1 / ratio) : 0;
    o[i] = x[i] * db2a(gr + makeupDb);
  }
  return o;
}
/** AGC: rides the gain toward a target RMS; gain slews at most slewDbS, limited to maxGainDb; fast limiter down. */
export function agc(x: Float32Array, sr: number, targetDb = -20, slewDbS = 6, maxGainDb = 30, downDbS = 40): Float32Array {
  const o = new Float32Array(x.length); let gDb = 10; let e = 0; const k = Math.exp(-1 / (0.03 * sr));
  for (let i = 0; i < x.length; i++) {
    e = k * e + (1 - k) * x[i] * x[i];
    const lvl = 10 * Math.log10(Math.max(e, 1e-12)) + gDb;
    if (lvl > targetDb) gDb -= downDbS / sr; else if (lvl > targetDb - 45) gDb += slewDbS / sr; // only rides gain up when there is signal (noise gate at -65)
    gDb = Math.max(-10, Math.min(maxGainDb, gDb));
    o[i] = Math.max(-1, Math.min(1, x[i] * db2a(gDb)));
  }
  return o;
}
export function clip(x: Float32Array, gainDb: number): Float32Array {
  const g = db2a(gainDb); const o = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) o[i] = Math.max(-1, Math.min(1, x[i] * g)); return o;
}
export function fadeOut(x: Float32Array, sr: number, ms = 40): Float32Array {
  const n = Math.min(x.length, Math.floor((ms / 1000) * sr));
  for (let i = 0; i < n; i++) x[x.length - 1 - i] *= i / n; return x;
}
/** level in dB over [a,b] seconds */
export function lvl(x: Float32Array, sr: number, a: number, b: number) { return 20 * Math.log10(rms(x, Math.floor(a * sr), Math.min(x.length, Math.floor(b * sr))) + 1e-12); }
