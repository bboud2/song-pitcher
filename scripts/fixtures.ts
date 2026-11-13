// Synthetic audio fixtures for the pitch-engine gauntlet and the end-to-end test WAVs.
// Deterministic (seeded PRNG). No DOM, no dependencies.

export const SR = 48000;

/** Mulberry32 PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Approximately Gaussian noise from a uniform PRNG. */
function gauss(r: () => number): number {
  return (r() + r() + r() + r() - 2) * 1.7320508;
}

export function midiFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export function rmsOf(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

/**
 * Karplus-Strong plucked string with a tuned fractional-delay allpass, pick-position comb,
 * a short pick click, and a few slightly stretched (inharmonic, B ~ 1e-4) partials that add
 * attack brightness. Pitch is accurate to well under 1 cent.
 */
export function pluck(
  midi: number,
  durSec: number,
  opts: { seed?: number; sr?: number; amp?: number; brightness?: number; pickPos?: number; t60?: number; cents?: number } = {},
): Float32Array {
  const sr = opts.sr ?? SR;
  const r = rng(opts.seed ?? midi * 7919 + 1);
  const f = midiFreq(midi) * Math.pow(2, (opts.cents ?? 0) / 1200);
  const n = Math.floor(durSec * sr);
  const out = new Float32Array(n);

  // Loop: delay line N + averaging filter (0.5 samples) + allpass (d samples) = sr/f
  const P = sr / f;
  let N = Math.floor(P - 0.5 - 0.1);
  let d = P - 0.5 - N;
  if (d < 0.1) {
    N -= 1;
    d += 1;
  }
  const C = (1 - d) / (1 + d);
  // Decay: low strings ring longer.
  const t60 = opts.t60 ?? Math.max(1.2, 4.5 - (midi - 40) * 0.08);
  const g = Math.pow(10, -3 / (t60 * f));
  const brightness = opts.brightness ?? 0.75; // 0..1, lowpass on the excitation

  // Excitation: filtered noise burst with pick-position comb.
  const buf = new Float64Array(N);
  const pick = Math.max(1, Math.round(N * (opts.pickPos ?? 0.18)));
  const raw = new Float64Array(N);
  let lp = 0;
  for (let i = 0; i < N; i++) {
    lp = lp + brightness * (r() * 2 - 1 - lp);
    raw[i] = lp;
  }
  for (let i = 0; i < N; i++) buf[i] = raw[i] - (i >= pick ? raw[i - pick] : 0);
  let mean = 0;
  for (let i = 0; i < N; i++) mean += buf[i];
  mean /= N;
  for (let i = 0; i < N; i++) buf[i] -= mean;

  let idx = 0;
  let prev = 0;
  let apX = 0;
  let apY = 0;
  for (let i = 0; i < n; i++) {
    const cur = buf[idx];
    const avg = 0.5 * (cur + prev);
    prev = cur;
    // first-order allpass fractional delay
    const y = C * avg + apX - C * apY;
    apX = avg;
    apY = y;
    buf[idx] = y * g;
    out[i] = cur;
    idx++;
    if (idx >= N) idx = 0;
  }

  // Inharmonic brightness: stretched partials with fast decay.
  const B = 1.2e-4;
  for (let k = 2; k <= 12; k++) {
    const fk = f * k * Math.sqrt(1 + B * k * k);
    if (fk > sr * 0.45) break;
    const a = (0.08 / k) * brightness;
    const tau = 0.08 + 0.4 / k;
    const ph = r() * Math.PI * 2;
    const len = Math.min(n, Math.floor(tau * 6 * sr));
    for (let i = 0; i < len; i++) out[i] += a * Math.exp(-i / sr / tau) * Math.sin(ph + (2 * Math.PI * fk * i) / sr);
  }
  // Pick click (~3 ms broadband).
  const clickLen = Math.floor(0.003 * sr);
  for (let i = 0; i < clickLen; i++) out[i] += 0.25 * (r() * 2 - 1) * (1 - i / clickLen);

  // Normalize peak to amp, with a 2 ms fade-out at the end.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const s = (opts.amp ?? 0.5) / (peak || 1);
  const fade = Math.floor(0.002 * sr);
  for (let i = 0; i < n; i++) {
    out[i] *= s;
    if (i > n - fade) out[i] *= (n - i) / fade;
  }
  return out;
}

const VOWELS: Record<string, [number, number][]> = {
  // [formant Hz, bandwidth Hz]
  ah: [[730, 90], [1090, 110], [2440, 160], [3400, 250]],
  ee: [[300, 60], [2300, 120], [3000, 180], [3700, 250]],
  oo: [[320, 70], [870, 100], [2250, 160], [3300, 250]],
  eh: [[530, 80], [1840, 120], [2480, 160], [3500, 250]],
};

function formantGain(freq: number, formants: [number, number][]): number {
  let g = 0.02;
  for (const [fc, bw] of formants) {
    const x = (freq - fc) / (bw / 2);
    g += 1 / (1 + x * x);
  }
  return g;
}

/**
 * Voice-like tone: glottal-ish harmonic stack (-6 dB/oct) shaped by vowel formants, with
 * 5–6 Hz vibrato (±30 cents), a scoop up into pitch from below, jitter, shimmer and breath noise.
 */
export function voice(
  midi: number,
  durSec: number,
  opts: {
    seed?: number; sr?: number; amp?: number; vowel?: keyof typeof VOWELS;
    vibratoCents?: number; vibratoHz?: number; scoopCents?: number; scoopSec?: number; detuneCents?: number;
  } = {},
): Float32Array {
  const sr = opts.sr ?? SR;
  const r = rng(opts.seed ?? midi * 104729 + 3);
  const n = Math.floor(durSec * sr);
  const out = new Float32Array(n);
  const f0 = midiFreq(midi) * Math.pow(2, (opts.detuneCents ?? 0) / 1200);
  const formants = VOWELS[opts.vowel ?? 'ah'];
  const vibC = opts.vibratoCents ?? 30;
  const vibHz = opts.vibratoHz ?? 5 + r(); // 5–6 Hz
  const scoopC = opts.scoopCents ?? -90;
  const scoopT = opts.scoopSec ?? 0.12;
  const vibOnset = 0.25; // vibrato fades in after the onset
  const nh = Math.max(1, Math.floor(4800 / f0));
  const amps = new Float64Array(nh + 1);
  const phases = new Float64Array(nh + 1);
  for (let k = 1; k <= nh; k++) {
    amps[k] = (1 / k) * formantGain(k * f0, formants);
    phases[k] = r() * Math.PI * 2;
  }
  let phase = 0;
  let jitter = 0;
  let shimmer = 0;
  let breathLp = 0;
  const attack = 0.06;
  const release = 0.08;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    jitter = 0.999 * jitter + 0.001 * gauss(r) * 8; // slow random pitch wander, a few cents
    shimmer = 0.999 * shimmer + 0.001 * gauss(r) * 0.3;
    const vibDepth = vibC * Math.min(1, Math.max(0, (t - vibOnset) / 0.3));
    const cents = scoopC * Math.exp(-t / scoopT) + vibDepth * Math.sin(2 * Math.PI * vibHz * t) + jitter;
    const f = f0 * Math.pow(2, cents / 1200);
    phase += (2 * Math.PI * f) / sr;
    if (phase > 1e6) phase -= 2 * Math.PI * Math.floor(phase / (2 * Math.PI));
    let s = 0;
    for (let k = 1; k <= nh; k++) s += amps[k] * Math.sin(k * phase + phases[k]);
    breathLp += 0.3 * (gauss(r) - breathLp);
    s += 0.015 * breathLp;
    const env = Math.min(1, t / attack) * Math.min(1, (durSec - t) / release) * (1 + shimmer);
    out[i] = s * env;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const sc = (opts.amp ?? 0.4) / (peak || 1);
  for (let i = 0; i < n; i++) out[i] *= sc;
  return out;
}

export function silence(durSec: number, sr = SR): Float32Array {
  return new Float32Array(Math.floor(durSec * sr));
}

/** White-ish noise with a given RMS. */
export function noise(durSec: number, rmsLevel: number, seed = 99, sr = SR): Float32Array {
  const r = rng(seed);
  const n = Math.floor(durSec * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = gauss(r) * rmsLevel;
  return out;
}

/** Concatenate buffers. */
export function concat(...parts: Float32Array[]): Float32Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Mix `b` into `a` starting at sample `at` (in place, extends nothing). */
export function mixInto(a: Float32Array, b: Float32Array, at: number): void {
  for (let i = 0; i < b.length && at + i < a.length; i++) a[at + i] += b[i];
}

/** Add white noise at a given SNR (dB) relative to the RMS of `x` over [from, to). */
export function addNoise(x: Float32Array, snrDb: number, seed: number, from = 0, to = x.length): Float32Array {
  const sig = rmsOf(x, from, to);
  const nr = sig / Math.pow(10, snrDb / 20);
  const nz = noise(x.length / SR, nr, seed);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] + (nz[i] ?? 0);
  return out;
}

/** Encode mono float samples as a 16-bit PCM WAV file. */
export function encodeWav(x: Float32Array, sr = SR): Uint8Array {
  const dataLen = x.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, dataLen, true);
  for (let i = 0; i < x.length; i++) {
    const s = Math.max(-1, Math.min(1, x[i]));
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}
