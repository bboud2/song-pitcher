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
  /** NSDF height at half the detected period (periodicity one octave up), 0 if none. */
  upClarity?: number;
  /** RMS after stationary-noise removal (equals rms when denoising is off). */
  cleanRms?: number;
  /** Copy of the NSDF (index = lag in samples) for target-aware periodicity checks. */
  nsdf?: Float32Array;
  /** Pitch of the power that is new since 160 ms ago (0 if none), its clarity, and its share of the frame power. */
  novFreq?: number;
  novClarity?: number;
  novShare?: number;
  /** Level (dB) of the 2–6 kHz band: the pick/finger noise of an attack shows up here. */
  hfDb?: number;
  /** harmonics 4–10 vs 1–2 of the detected pitch (dB): strings lose their upper partials first */
  tiltDb?: number;
  /** new power on odd vs even harmonics of the detected pitch (dB), when something new appeared */
  novOddDb?: number;
}

/**
 * Periodicity (NSDF height) of a frame at a given frequency: the highest NSDF value within
 * ±2.5 % of that period. 0 when unknown or out of range.
 */
export function periodicityAt(nsdf: Float32Array | undefined, sampleRate: number, hz: number): number {
  if (!nsdf || !(hz > 0)) return 0;
  const lag = sampleRate / hz;
  const lo = Math.max(2, Math.floor(lag * 0.975));
  const hi = Math.min(nsdf.length - 1, Math.ceil(lag * 1.025));
  let best = 0;
  for (let k = lo; k <= hi; k++) if (nsdf[k] > best) best = nsdf[k];
  return best;
}

export interface PitchDetectorOptions {
  /** Lowest frequency searched (Hz). Default 60 (below guitar low E, 82.4 Hz). */
  minFreq?: number;
  /** Highest frequency searched (Hz). Default 1200 (above E5 / soprano range used here). */
  maxFreq?: number;
  /** MPM key-maximum threshold, fraction of the highest key maximum. Default 0.9. */
  cutoff?: number;
  /** A lobe at twice the chosen lag wins if it is this much more periodic. Default 0.04. */
  octaveMargin?: number;
  /**
   * Remove stationary room noise (fan, hiss, mains hum) before pitch analysis. A per-bin noise
   * spectrum is learned only from frames that are room noise alone (level within 6 dB of the
   * quietest frame heard, which forgets only 0.5 dB/s), from a spectrum smoothed over those
   * frames alone. The student's voice and notes never feed it: an estimate that absorbed them
   * would carve their partials out of every later frame and bias the pitch sharp.
   */
  denoise?: boolean;
  /** Nominal time between frames (s), used when `detect` is not given timestamps. */
  hopSec?: number;
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
  private octaveMargin: number;
  private denoise: boolean;
  private hopSec: number;
  /** seconds of room noise learned so far (fast learning for the first 1.5 s) */
  private learned = 0;
  private smooth: Float64Array | null = null;
  private noise: Float64Array | null = null;
  /** quietest recent frame power (slowly forgets: +0.5 dB/s) */
  private quietPower = Infinity;
  private seen = 0;
  private lastT: number | null = null;
  private fft: FFT;
  private lastPower: Float64Array | null = null;
  /** the rectified "what's new" power spectrum of the current frame (for novOdd) */
  private novSpec: Float64Array | null = null;
  /** recent power spectra with their times, for the "what's new since 160 ms ago" pitch */
  private history: { t: number; p: Float64Array }[] = [];
  private acf: Float64Array;
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
    this.octaveMargin = opts.octaveMargin ?? 0.04;
    this.denoise = opts.denoise ?? false;
    this.hopSec = opts.hopSec ?? 0.02;
    this.minLag = Math.max(2, Math.floor(sampleRate / maxFreq));
    this.maxLag = Math.min(Math.floor(size * 0.6), Math.ceil(sampleRate / minFreq));
    let n = 1;
    while (n < size * 2) n <<= 1;
    this.fft = new FFT(n);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.nsdf = new Float64Array(this.maxLag + 2);
    this.acf = new Float64Array(this.maxLag + 2);
  }

  /**
   * Analyse the latest frame. `t` is the audio time of its last sample (s); rates (noise
   * tracking, the novelty look-back) use real elapsed time, so irregular timers do not matter.
   */
  detect(frame: Float32Array, t?: number): PitchResult {
    const now = t ?? (this.lastT ?? 0) + this.hopSec;
    const dt = this.lastT === null ? this.hopSec : Math.min(0.5, Math.max(0, now - this.lastT));
    this.lastT = now;
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
    // Digital silence or a dropout (exact zeros: a mic that is not delivering yet, a gated or
    // interrupted stream): nothing to learn from, and it must not count as "the quietest the room
    // gets" either — that would switch noise learning off for the rest of the session.
    let zeros = 0;
    for (let i = 0; i < N; i++) if (frame[off + i] === 0) zeros++;
    if (energy < 1e-12 || zeros > N / 8) {
      return { freq: 0, clarity: 0, rms, cleanRms: energy < 1e-12 ? 0 : rms };
    }

    // Autocorrelation via FFT: r = IFFT(|X|^2)
    this.fft.transform(re, im, false);
    const nb = re.length;
    for (let i = 0; i < nb; i++) {
      re[i] = re[i] * re[i] + im[i] * im[i];
      im[i] = 0;
    }
    let hf = 0;
    const hfLo = Math.round((2000 * nb) / this.sampleRate);
    const hfHi = Math.min(nb >> 1, Math.round((6000 * nb) / this.sampleRate));
    for (let i = hfLo; i <= hfHi; i++) hf += re[i];
    const hfDb = 10 * Math.log10(hf / (nb * N) + 1e-20);
    let cleanFactor = 1;
    if (this.denoise) {
      // Is this frame room noise alone? About as quiet as the quietest earlier frame (within
      // 6 dB): the student's voice and notes are louder than the room, so they never qualify.
      // (only after a few frames: the very first sound heard may be a note)
      const power = energy / N;
      const roomOnly = this.seen >= 5 && power <= 4 * this.quietPower;
      // (the quietest level forgets very slowly, 0.5 dB/s: a session is almost never silent —
      // voice, ringing strings — and a fast-forgetting floor would climb up to the student's sound)
      this.quietPower = Math.min(power, this.quietPower * Math.pow(10, (0.5 * dt) / 10));
      this.seen++;
      // (the smoothed spectrum it learns from is built from room-only frames alone, so the
      // tail of a louder sound just before cannot leak in)
      if (roomOnly) {
        if (!this.smooth) this.smooth = Float64Array.from(re);
        const sm0 = this.smooth;
        for (let i = 0; i < nb; i++) sm0[i] = 0.8 * sm0[i] + 0.2 * re[i];
        if (!this.noise) this.noise = Float64Array.from(sm0);
      }
      const sm = this.smooth;
      const nz = this.noise;
      if (nz && sm) {
        // learn fast for the first 1.5 s of room noise (the mic check), then slowly (+4 dB/s)
        // so a faint note tail that is as quiet as the room only nudges it; fall at 12 dB/s
        if (roomOnly) {
          const rise = Math.pow(10, ((this.learned < 1.5 ? 32 : 4) * dt) / 10);
          const fall = Math.pow(10, (-12 * dt) / 10);
          this.learned += dt;
          for (let i = 0; i < nb; i++) nz[i] = sm[i] > nz[i] ? Math.min(sm[i], nz[i] * rise) : Math.max(sm[i], nz[i] * fall);
        }
        const fl = nz;
        let before = 0;
        let after = 0;
        for (let i = 0; i < nb; i++) {
          const p = re[i];
          const c = Math.max(p - 2 * fl[i], 0.03 * p);
          before += p;
          after += c;
          re[i] = c;
        }
        cleanFactor = before > 0 ? after / before : 1;
      }
    }
    this.lastPower = Float64Array.from(re);
    this.fft.transform(re, im, true);
    const scale = 1 / re.length;
    const cleanRms = rms * Math.sqrt(cleanFactor);

    // NSDF with running m(tau) = sum_{j} x_j^2 + x_{j+tau}^2
    const nsdf = this.nsdf;
    const maxLag = this.maxLag;
    let m = 2 * energy;
    nsdf[0] = 1;
    for (let tau = 1; tau <= maxLag + 1 && tau < N; tau++) {
      const a = frame[off + tau - 1] - mean;
      const b = frame[off + N - tau] - mean;
      m -= a * a + b * b;
      // with noise removed from the spectrum, scale the energy terms by the same factor
      const mm = m * cleanFactor;
      nsdf[tau] = mm > 1e-12 ? Math.min(1, (2 * re[tau] * scale) / mm) : 0;
    }

    const nov = this.noveltyPitch(now);
    const picked = this.pick(nsdf);
    if (!picked) return { freq: 0, clarity: 0, rms, cleanRms, nsdf: Float32Array.from(nsdf), hfDb, ...nov };
    const { period, peakVal } = picked;
    // Periodicity one octave above the detected pitch (local max of the NSDF around period/2).
    let upClarity = 0;
    const half = period / 2;
    const lo = Math.max(1, Math.floor(half * 0.97));
    const hi = Math.min(maxLag, Math.ceil(half * 1.03));
    for (let k = lo; k <= hi; k++) if (nsdf[k] > upClarity) upClarity = nsdf[k];
    const freq = this.sampleRate / period;
    return { freq, clarity: Math.min(1, peakVal), rms, upClarity, cleanRms, nsdf: Float32Array.from(nsdf), hfDb, tiltDb: this.tilt(freq), novOddDb: this.novOdd(freq), ...nov };
  }

  /**
   * Of the power that is NEW since 160 ms ago, how much sits on the odd harmonics (1, 3, 5) of
   * `f0` versus the even ones (2, 4, 6), in dB. A new note an octave above a sounding one (a
   * pluck while singing the octave below) adds only even harmonics: strongly negative.
   */
  private novOdd(f0: number): number | undefined {
    const P = this.novSpec;
    this.novSpec = null;
    if (!P) return undefined;
    const nb = P.length;
    const h = (k: number) => {
      const c = (k * f0 * nb) / this.sampleRate;
      let best = 0;
      for (let b = Math.floor(c * 0.98); b <= Math.ceil(c * 1.02) && b < nb >> 1; b++) best = Math.max(best, P[b]);
      return best;
    };
    const odd = h(1) + h(3) + h(5);
    const even = h(2) + h(4) + h(6);
    if (odd + even <= 0) return undefined;
    return 10 * Math.log10((odd + 1e-20) / (even + 1e-20));
  }

  /** Spectral tilt across the harmonics of `f0` in the last (noise-cleaned) power spectrum. */
  private tilt(f0: number): number {
    const P = this.lastPower;
    if (!P) return 0;
    const nb = P.length;
    const h = (k: number) => {
      const c = (k * f0 * nb) / this.sampleRate;
      let best = 0;
      for (let b = Math.floor(c * 0.97); b <= Math.ceil(c * 1.03) && b < nb >> 1; b++) best = Math.max(best, P[b]);
      return best;
    };
    let lo = 0;
    let hi = 0;
    for (let k = 1; k <= 2; k++) lo += h(k);
    for (let k = 4; k <= 10; k++) if (k * f0 < 5000) hi += h(k);
    return 10 * Math.log10((hi + 1e-20) / (lo + 1e-20));
  }

  /** MPM peak picking on an NSDF-like array: returns the fractional period and its height. */
  private pick(nsdf: Float64Array, octaveGuard = true): { period: number; peakVal: number } | null {
    const maxLag = this.maxLag;
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
    if (!(best > 0)) return null;
    const threshold = this.cutoff * best;
    let chosen = -1;
    for (const p of peaks) {
      if (p >= this.minLag && nsdf[p] >= threshold) {
        chosen = p;
        break;
      }
    }
    if (chosen < 0) return null;

    // Octave-up guard: when the fundamental is weak (e.g. a vowel formant sitting on the 2nd
    // harmonic), the half-period lobe can clear the MPM cutoff. If a lobe at ~2x the lag is
    // clearly more periodic, the true period is the longer one.
    for (let guard = 0; octaveGuard && guard < 2; guard++) {
      const target = chosen * 2;
      let better = -1;
      for (const p of peaks) {
        if (Math.abs(p - target) <= Math.max(2, target * 0.03) && nsdf[p] > nsdf[chosen] + this.octaveMargin) {
          if (better < 0 || nsdf[p] > nsdf[better]) better = p;
        }
      }
      if (better < 0) break;
      chosen = better;
    }

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
    return { period: chosen + shift, peakVal };
  }

  /**
   * "What changed" pitch: the pitch of the power that is new compared with 160 ms ago (the
   * spectrum now minus the earlier one). Right after an attack this is the new note alone, even
   * over other strings still ringing (let-ring playing) whose sum would mislead the normal
   * pitch. Returns novelty fields for the frame.
   */
  private noveltyPitch(now: number): { novFreq: number; novClarity: number; novShare: number } {
    this.novSpec = null;
    const P = this.lastPower;
    if (!P) return { novFreq: 0, novClarity: 0, novShare: 0 };
    // the most recent stored spectrum at least 160 ms old (by audio time, not frame count)
    const h = this.history;
    let ref: Float64Array | undefined;
    for (const e of h) if (now - e.t >= 0.16 - 1e-6) ref = e.p;
    h.push({ t: now, p: P });
    while (h.length > 2 && now - h[1].t >= 0.16 - 1e-6) h.shift();
    if (h.length > 64) h.shift();
    // (too old to compare after a long stall)
    if (ref && now - h[0].t > 0.5) ref = undefined;
    if (!ref) return { novFreq: 0, novClarity: 0, novShare: 0 };
    const re = this.re;
    const im = this.im;
    let tot = 0;
    let nov = 0;
    for (let i = 0; i < P.length; i++) {
      const d = P[i] - 1.25 * ref[i];
      tot += P[i];
      re[i] = d > 0 ? d : 0;
      nov += re[i];
      im[i] = 0;
    }
    if (!(nov > 0) || !(tot > 0)) return { novFreq: 0, novClarity: 0, novShare: 0 };
    this.novSpec = Float64Array.from(re);
    this.fft.transform(re, im, true);
    const N = this.size;
    const r0 = re[0];
    const acf = this.acf;
    for (let tau = 0; tau <= this.maxLag + 1; tau++) acf[tau] = (re[tau] * N) / ((N - tau) * r0);
    // (no octave-down guard here: the rectified difference spectrum has spurious sub-harmonic periodicity)
    const picked = this.pick(acf, false);
    if (!picked) return { novFreq: 0, novClarity: 0, novShare: nov / tot };
    return { novFreq: this.sampleRate / picked.period, novClarity: Math.min(1, picked.peakVal), novShare: nov / tot };
  }
}

export function rmsToDb(rms: number): number {
  return 20 * Math.log10(Math.max(rms, 1e-10));
}
