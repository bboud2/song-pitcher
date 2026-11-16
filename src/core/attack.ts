// Attack-shape tracker: how fast does a new sound reach full strength? Pure TypeScript, no DOM.
//
// A plucked string is excited by an impulse: its sound is at full strength within a few
// milliseconds of the pick (or nail, or thumb) leaving the string. A voice — humming, a sung
// "la", the vowel of a spoken syllable — builds up over tens of milliseconds as the vocal folds
// start vibrating. That rise time is the one cue every source model we test on agrees on (see
// scripts/gauntlet-cases.ts, "attack shape"), and it does not depend on what the sound does
// afterwards (a fading hum decays like a string; a held string can sustain like a voice).
//
// The tracker sees EVERY sample (it is fed by the audio stream, not by the analysis timer).
// Energy is summed in 1 ms blocks; a 5 ms sliding power envelope is formed at 1 ms steps, in
// three bands: the guitar path (above 70 Hz); a middle band (above ~500 Hz), clear of the
// guitar body's low resonances, which ring up over tens of milliseconds and can make a pluck on
// a note near them look slow in the full band; and a high band (above ~3 kHz) where a pick's
// click still shows when a louder voice masks the rise of the full band. When the envelope jumps
// (≥ 1.5× the mean of the 40 ms before), the rise is measured over the next 120 ms (long enough for
// a voice to build up, so one early glottal pulse cannot pass for the peak): the time from
// 10 % to 80 % of the added power, and how many dB were added.
import { Biquad } from './engine-filters.ts';

export interface AttackEvent {
  /** sample index (in the stream) where the rise starts (its 10 % point) */
  sample: number;
  /** time from 10 % to 80 % of the added power (ms) */
  riseMs: number;
  /** level added by the attack (dB above what was sounding before) */
  riseDb: number;
  band: 'full' | 'hf' | 'mid';
  /** level 6 ms after the rise starts, against the peak of the added power (dB, ≤ 0): how much
   * of the sound arrives at once. A pluck's direct sound arrives in one go, whatever the room
   * adds afterwards; a voice builds up over several glottal cycles. */
  edgeDb: number;
  /** heard before the last time the analysis stopped listening (kept through our own sound) */
  carried?: boolean;
}

const BLOCK_MS = 1;
const WIN_BLOCKS = 5;
const PRE_FROM = 45;
const PRE_TO = 5;
const HORIZON = 120;
const RING = 512;

class BandTracker {
  private blk = new Float64Array(RING); // 1 ms block energies
  private env = new Float64Array(RING); // 10 ms sliding power
  private n = 0; // blocks seen
  private pending: { k: number; pre: number; preMax: number; retry?: boolean } | null = null;
  private lastStart = -1e9;
  private band: 'full' | 'hf' | 'mid';
  private emit: (e: AttackEvent) => void;
  private blockLen: number;
  constructor(band: 'full' | 'hf' | 'mid', emit: (e: AttackEvent) => void, blockLen: number) {
    this.band = band;
    this.emit = emit;
    this.blockLen = blockLen;
  }

  /** one finished 1 ms block of energy (sum of squares) */
  block(energy: number): void {
    const k = this.n++;
    this.blk[k % RING] = energy;
    let s = 0;
    for (let i = 0; i < WIN_BLOCKS && k - i >= 0; i++) s += this.blk[(k - i) % RING];
    this.env[k % RING] = s / (WIN_BLOCKS * this.blockLen) + 1e-14;
    if (k < PRE_FROM + WIN_BLOCKS) return;
    const P = (i: number) => this.env[i % RING];
    if (!this.pending && k - this.lastStart >= HORIZON + 20) {
      let pre = 0;
      let preMax = 0;
      for (let i = k - PRE_FROM; i < k - PRE_TO; i++) {
        pre += P(i);
        preMax = Math.max(preMax, P(i));
      }
      pre /= PRE_FROM - PRE_TO;
      if (P(k) >= 1.5 * pre) this.pending = { k, pre, preMax };
    }
    const p = this.pending;
    if (p && k >= p.k + HORIZON) {
      let peak = 0;
      let peakAt = p.k;
      for (let i = p.k; i <= k; i++) if (P(i) - p.pre > peak) [peak, peakAt] = [P(i) - p.pre, i];
      if (peak <= 0) {
        this.pending = null;
        return;
      }
      // A flicker of the noise triggered early and a real sound started only near the end of the
      // horizon: the window caught just its first few milliseconds (a voice's first glottal pulse
      // would look like a pluck). Measure that sound over a full horizon of its own instead.
      if (!p.retry && peakAt >= k - 15 && P(k - 30) - p.pre < 0.5 * peak) {
        let a0 = k - 60;
        while (a0 < k && P(a0) - p.pre <= 0.1 * peak) a0++;
        this.pending = { k: a0, pre: p.pre, preMax: p.preMax, retry: true };
        return;
      }
      // the rise: from the last point below 10 % of the added power to the first point at 80 %
      // (anchored on the 80 % point, so a trigger by a noise flicker just before does not count)
      let b = p.k;
      while (b < k && P(b) - p.pre < 0.8 * peak) b++;
      this.pending = null;
      // (the EARLIEST 10 % crossing: a voice's level ripples with each glottal pulse, and walking
      // back from the 80 % point would stop at the nearest ripple dip)
      // (the 10 % point of a soft note can lie within the ups and downs of what was sounding
      // before — room noise, a hum's cycle — which would mark a too-early start: it must also
      // clear the highest level heard just before the trigger)
      let a = Math.max(p.k - 40, b - 160);
      while (a < b && P(a) - p.pre <= Math.max(0.1 * peak, p.preMax - p.pre)) a++;
      const riseDb = 10 * Math.log10((p.pre + peak) / p.pre);
      // (a flicker of the noise does not hold off the next trigger; a real attack does, for 100 ms)
      if (riseDb >= 3) this.lastStart = p.k;
      const edgeDb = 10 * Math.log10(Math.max(P(Math.min(a + 6, k)) - p.pre, 1e-3 * peak) / peak);
      if (riseDb >= 1.5) this.emit({ sample: a * this.blockLen, riseMs: (b - a) * BLOCK_MS, riseDb, band: this.band, edgeDb });
    }
  }
}

/** Feeds on the guitar-path signal (already high-passed at 70 Hz). */
export class AttackTracker {
  private full: BandTracker;
  private hf: BandTracker;
  private mid: BandTracker;
  private hfFilters: Biquad[];
  private midFilters: Biquad[];
  private blockLen: number;
  private accFull = 0;
  private accHf = 0;
  private accMid = 0;
  private inBlock = 0;
  /** samples seen */
  samples = 0;
  /** recent events, oldest first (kept ~10 s) */
  readonly events: AttackEvent[] = [];

  readonly sampleRate: number;
  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.blockLen = Math.round((sampleRate * BLOCK_MS) / 1000);
    const add = (e: AttackEvent) => {
      this.events.push(e);
      while (this.events.length && this.events[0].sample < this.samples - 10 * sampleRate) this.events.shift();
    };
    this.full = new BandTracker('full', add, this.blockLen);
    this.hf = new BandTracker('hf', add, this.blockLen);
    this.mid = new BandTracker('mid', add, this.blockLen);
    this.hfFilters = [new Biquad(sampleRate, 3000, 0.7071, 'highpass'), new Biquad(sampleRate, 3000, 0.7071, 'highpass')];
    this.midFilters = [new Biquad(sampleRate, 500, 0.7071, 'highpass'), new Biquad(sampleRate, 500, 0.7071, 'highpass')];
  }

  push(x: Float32Array): void {
    let h = x;
    for (const b of this.hfFilters) h = b.process(h);
    let md = x;
    for (const b of this.midFilters) md = b.process(md);
    for (let i = 0; i < x.length; i++) {
      this.accFull += x[i] * x[i];
      this.accHf += h[i] * h[i];
      this.accMid += md[i] * md[i];
      this.samples++;
      if (++this.inBlock === this.blockLen) {
        this.full.block(this.accFull);
        this.hf.block(this.accHf);
        this.mid.block(this.accMid);
        this.accMid = 0;
        this.accFull = 0;
        this.accHf = 0;
        this.inBlock = 0;
      }
    }
  }

  /** samples pushed when the analysis last read a frame (see mark) */
  private markSample = -1;

  /** The analysis read a frame now: what was heard up to here was listened to. */
  mark(): void {
    this.markSample = this.samples;
  }

  /**
   * Forget what was heard while nobody listened — our own reference tone and its tail — but keep
   * the attacks heard before it (the pluck that ended the last step is still a pluck: a string
   * left ringing into the next step must not be taken for a voice).
   */
  clear(): void {
    const keep = this.events.filter((e) => e.sample <= this.markSample).map((e) => ({ ...e, carried: true }));
    this.events.length = 0;
    this.events.push(...keep);
  }
}
