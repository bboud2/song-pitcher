// McLeod Pitch Method (MPM) pitch detector. Pure TypeScript, no DOM.
// Input: a Float32Array frame of audio samples + sample rate. Output: frequency, clarity, RMS level.
//
// The normalized square difference function (NSDF) is computed with an FFT-based
// autocorrelation so a 2048-sample frame costs two 4096-point FFTs.

export interface PitchResult {
  /** Detected fundamental in Hz, or 0 when no pitch was found. */
  freq: number;
  /** NSDF peak height, 0..1. ~1 = perfectly periodic. */
  clarity: number;
  /** RMS level of the frame (linear, full scale = 1). */
  rms: number;
}

export interface PitchDetectorOptions {
  /** Lowest frequency searched (Hz). Default 60 (below guitar low E, 82.4 Hz). */
  minFreq?: number;
  /** Highest frequency searched (Hz). Default 1200 (above E5 / soprano range used here). */
  maxFreq?: number;
  /** MPM key-maximum threshold, fraction of the highest key maximum. Default 0.9. */
  cutoff?: number;
}

class FFT {
  readonly n: number;
  private rev: Uint32Array;
  private cos: Float64Array;
  private sin: Float64Array;

  constructor(n: number) {
    if (n & (n - 1)) throw new Error('FFT size must be a power of two');
    this.n = n;
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }

  /** In-place complex FFT. `inverse` uses +i sign and does NOT scale. */
  transform(re: Float64Array, im: Float64Array, inverse: boolean): void {
    const n = this.n;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = sgn * this.sin[k * step];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

export class PitchDetector {
  readonly size: number;
  readonly sampleRate: number;
  private minLag: number;
  private maxLag: number;
  private cutoff: number;
  private fft: FFT;
  private re: Float64Array;
  private im: Float64Array;
  /** Last computed NSDF (exposed for debugging/tests). */
  readonly nsdf: Float64Array;

  constructor(size: number, sampleRate: number, opts: PitchDetectorOptions = {}) {
    this.size = size;
    this.sampleRate = sampleRate;
    const minFreq = opts.minFreq ?? 60;
    const maxFreq = opts.maxFreq ?? 1200;
    this.cutoff = opts.cutoff ?? 0.9;
    this.minLag = Math.max(2, Math.floor(sampleRate / maxFreq));
    this.maxLag = Math.min(Math.floor(size * 0.6), Math.ceil(sampleRate / minFreq));
    let n = 1;
    while (n < size * 2) n <<= 1;
    this.fft = new FFT(n);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.nsdf = new Float64Array(this.maxLag + 2);
  }

  detect(frame: Float32Array): PitchResult {
    const N = Math.min(frame.length, this.size);
    const off = frame.length - N; // use the most recent samples
    const re = this.re;
    const im = this.im;
    re.fill(0);
    im.fill(0);
    let mean = 0;
    for (let i = 0; i < N; i++) mean += frame[off + i];
    mean /= N;
    let energy = 0;
    for (let i = 0; i < N; i++) {
      const v = frame[off + i] - mean;
      re[i] = v;
      energy += v * v;
    }
    const rms = Math.sqrt(energy / N);
    if (energy < 1e-12) return { freq: 0, clarity: 0, rms };

    // Autocorrelation via FFT: r = IFFT(|X|^2)
    this.fft.transform(re, im, false);
    for (let i = 0; i < re.length; i++) {
      re[i] = re[i] * re[i] + im[i] * im[i];
      im[i] = 0;
    }
    this.fft.transform(re, im, true);
    const scale = 1 / re.length;

    // NSDF with running m(tau) = sum_{j} x_j^2 + x_{j+tau}^2
    const nsdf = this.nsdf;
    const maxLag = this.maxLag;
    let m = 2 * energy;
    nsdf[0] = 1;
    for (let tau = 1; tau <= maxLag + 1 && tau < N; tau++) {
      const a = frame[off + tau - 1] - mean;
      const b = frame[off + N - tau] - mean;
      m -= a * a + b * b;
      nsdf[tau] = m > 1e-12 ? (2 * re[tau] * scale) / m : 0;
    }

    // Key maxima: highest point of each positive lobe after the first negative zero crossing.
    const peaks: number[] = [];
    let tau = 1;
    while (tau < maxLag && nsdf[tau] > 0) tau++; // skip the zero-lag lobe
    let lobeMax = -1;
    let lobeMaxTau = -1;
    for (; tau <= maxLag; tau++) {
      const v = nsdf[tau];
      if (v > 0) {
        if (v > lobeMax) {
          lobeMax = v;
          lobeMaxTau = tau;
        }
      } else if (lobeMaxTau > 0) {
        peaks.push(lobeMaxTau);
        lobeMax = -1;
        lobeMaxTau = -1;
      }
    }
    if (lobeMaxTau > 0 && lobeMaxTau < maxLag) peaks.push(lobeMaxTau);

    let best = -Infinity;
    for (const p of peaks) if (p >= this.minLag && nsdf[p] > best) best = nsdf[p];
    if (!(best > 0)) return { freq: 0, clarity: 0, rms };
    const threshold = this.cutoff * best;
    let chosen = -1;
    for (const p of peaks) {
      if (p >= this.minLag && nsdf[p] >= threshold) {
        chosen = p;
        break;
      }
    }
    if (chosen < 0) return { freq: 0, clarity: 0, rms };

    // Parabolic interpolation around the peak.
    const y0 = nsdf[chosen - 1];
    const y1 = nsdf[chosen];
    const y2 = nsdf[chosen + 1];
    const denom = y0 - 2 * y1 + y2;
    let shift = 0;
    let peakVal = y1;
    if (denom !== 0) {
      shift = (0.5 * (y0 - y2)) / denom;
      if (shift > 0.5 || shift < -0.5) shift = 0;
      peakVal = y1 - 0.25 * (y0 - y2) * shift;
    }
    const period = chosen + shift;
    return { freq: this.sampleRate / period, clarity: Math.min(1, peakVal), rms };
  }
}

export function rmsToDb(rms: number): number {
  return 20 * Math.log10(Math.max(rms, 1e-10));
}
