// Browser audio: microphone capture + analysis, reference-tone synthesis, wake lock.
//
// Every sample of the microphone goes through the same StreamAnalyzer the offline tests use:
// an AudioWorklet hands the raw samples to the page, which analyses one frame per 20 ms of
// AUDIO (not per timer tick), so a slow or throttled timer only delays the analysis, it never
// skips audio. Fallbacks, in order: ScriptProcessorNode, then reading the newest samples from an
// AnalyserNode on a timer (gap-free while the timer fires at least every ~170 ms).
// Playback and listening never overlap: while a reference plays (plus a decay tail) frames are
// dropped and what was heard is forgotten, and the session ignores mic input in 'listen'.
import { FRAME_SIZE, HOP_MS, StreamAnalyzer, warmAnalyzer, type AnalysisPath } from '../core/engine.ts';
import type { PitchFrame } from '../core/matcher.ts';
import { midiToFreq } from '../core/music.ts';

/** Silence after a reference tone before the mic is trusted again (room decay + analysis window). */
const TAIL_SEC = 0.3;

type AudioSessionNav = Navigator & { audioSession?: { type: string } };
type WakeLockSentinelLike = { release(): Promise<void>; addEventListener?: (t: string, f: () => void) => void };
type WakeLockNav = Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } };

/** length of the sample counter's loop (exact integers in float; ~5 s at 48 kHz) */
const RAMP_LEN = 1 << 18;

export class AudioEngine {
  ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  /** Both analysis paths (voice, guitar) and the attack tracker, fed with every sample. */
  private sa: StreamAnalyzer | null = null;
  /** how the samples arrive: 'worklet' | 'script' | 'poll' (diagnostics, e2e) */
  captureMode: 'worklet' | 'script' | 'poll' | 'none' = 'none';
  private acc = new Float32Array(0);
  private fed = 0;
  private wasMuted = false;
  private muteFrom = 0;
  private pollBuf: Float32Array<ArrayBuffer> | null = null;
  private pollLast = -1;
  private rampBuf: Float32Array<ArrayBuffer> | null = null;
  private rawAnalyser: AnalyserNode | null = null;
  private specBuf: Float32Array<ArrayBuffer> | null = null;

  /** dB magnitude spectrum of the raw mic signal (for hum detection), or null. */
  spectrumDb(): { db: Float32Array; sampleRate: number; fftSize: number } | null {
    const a = this.rawAnalyser;
    if (!a || !this.ctx) return null;
    this.specBuf ??= new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(this.specBuf);
    return { db: this.specBuf, sampleRate: this.ctx.sampleRate, fftSize: a.fftSize };
  }
  private timer: number | null = null;
  private onFrame: ((f: PitchFrame) => void) | null = null;
  private pathFn: () => AnalysisPath = () => 'voice';
  /** paths analysed every tick without delivering frames (so they learn the room) */
  private warm: AnalysisPath[] = [];
  private mutedUntil = 0;
  private playing: { stop: () => void } | null = null;
  private master: GainNode | null = null;

  get ready(): boolean {
    return !!this.ctx && !!this.sa;
  }

  get isPlaying(): boolean {
    return this.playing !== null;
  }

  /**
   * Must be called from a user gesture (tap). Creates/resumes the AudioContext synchronously
   * inside the gesture (required by iOS Safari), then opens the microphone with all browser
   * voice processing disabled.
   */
  async init(): Promise<void> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      const e = new Error('The microphone only works on a secure (https://) page.');
      e.name = 'InsecureContextError';
      throw e;
    }
    if (!this.ctx) {
      const nav = navigator as AudioSessionNav;
      // Safari 16.4+: ask for simultaneous playback + recording explicitly.
      try {
        if (nav.audioSession) nav.audioSession.type = 'play-and-record';
      } catch {
        /* ignore */
      }
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.ratio.value = 4;
      this.master.connect(comp).connect(this.ctx.destination);
    }
    const resume = this.ctx.resume();
    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
      const ctx = this.ctx;
      const src = ctx.createMediaStreamSource(this.stream);
      this.sa = new StreamAnalyzer(ctx.sampleRate);
      await this.startCapture(src);
      // unfiltered, high-resolution spectrum for the mic/room check (hum lines)
      this.rawAnalyser = ctx.createAnalyser();
      this.rawAnalyser.fftSize = 8192;
      this.rawAnalyser.smoothingTimeConstant = 0.5;
      src.connect(this.rawAnalyser);
    }
    await resume;
  }

  /** Hook the microphone up to the analysis: AudioWorklet, else ScriptProcessor, else polling. */
  private async startCapture(src: MediaStreamAudioSourceNode): Promise<void> {
    const ctx = this.ctx!;
    const sink = ctx.createGain();
    sink.gain.value = 0; // processing nodes must reach the destination to run; nothing is heard
    sink.connect(ctx.destination);
    try {
      await ctx.audioWorklet.addModule(new URL('capture-worklet.js', document.baseURI).href);
      const node = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (e: MessageEvent<{ samples: Float32Array; frame: number }>) => this.onAudio(e.data.samples, e.data.frame / ctx.sampleRate, e.data.frame - e.data.samples.length);
      src.connect(node).connect(sink);
      this.captureMode = 'worklet';
      return;
    } catch {
      /* fall through */
    }
    // Without a worklet nothing numbers the samples, so a sample counter rides along: a looped
    // buffer holding 0, 1, 2, ... (exact in float) on a second channel / analyser. It tells which
    // samples arrived, so lost or repeated blocks are logged and the sample clock stays true.
    const ramp = ctx.createBufferSource();
    const rb = ctx.createBuffer(1, RAMP_LEN, ctx.sampleRate);
    const rd = rb.getChannelData(0);
    for (let i = 0; i < RAMP_LEN; i++) rd[i] = i;
    ramp.buffer = rb;
    ramp.loop = true;
    try {
      // (a large buffer: the main thread may be busy for a while, and latency does not matter here)
      const sp = ctx.createScriptProcessor(4096, 2, 1);
      const merge = ctx.createChannelMerger(2);
      src.connect(merge, 0, 0);
      ramp.connect(merge, 0, 1);
      sp.onaudioprocess = (e) => {
        const ch = e.inputBuffer.getChannelData(1);
        this.onAudio(new Float32Array(e.inputBuffer.getChannelData(0)), ctx.currentTime, this.unwrap(ch[0]));
      };
      merge.connect(sp).connect(sink);
      ramp.start();
      this.captureMode = 'script';
      return;
    } catch {
      /* fall through */
    }
    try {
      this.rampAnalyser = ctx.createAnalyser();
      this.rampAnalyser.fftSize = 8192;
      ramp.connect(this.rampAnalyser);
      ramp.start();
    } catch {
      this.rampAnalyser = null;
    }
    this.captureMode = 'poll';
  }

  private rampAnalyser: AnalyserNode | null = null;
  /** the capture's own index of the next sample expected (counter-based modes) */
  private nextIdx: number | null = null;
  /** A counter value (mod RAMP_LEN) as a full index, taking the one nearest to what is expected. */
  private unwrap(v: number): number {
    const k = Math.round(v);
    if (this.nextIdx === null) return k;
    const base = this.nextIdx - (((this.nextIdx % RAMP_LEN) + RAMP_LEN) % RAMP_LEN);
    let idx = base + k;
    if (idx - this.nextIdx > RAMP_LEN / 2) idx -= RAMP_LEN;
    else if (this.nextIdx - idx > RAMP_LEN / 2) idx += RAMP_LEN;
    return idx;
  }

  /**
   * One sample clock for the analysis and the practice recorder: `received` counts every sample
   * handed to the analysis since the microphone opened (capture index); analysis frames fall at
   * capture indices FRAME_SIZE, FRAME_SIZE + hop, ... (every whole hop), and a frame's time is
   * t0 + index / sampleRate.
   */
  received = 0;
  /** capture index of the end of the last analysed hop */
  captured = 0;
  /** audio-clock time of capture index 0 */
  t0Cap: number | null = null;
  /** The last 60 s of input as the analysis received it (16-bit), so a recording can include
   * what the detector heard before it started (its noise and attack history). */
  private preroll: Int16Array | null = null;
  private prerollFilled = 0;
  /** Audio-clock time of capture index `c`. */
  clockTime(c: number): number {
    return this.t0Cap === null || !this.ctx ? this.now() : this.t0Cap + c / this.ctx.sampleRate;
  }
  /** The analysis frames' time base and hop, for a recording's log. */
  clock(): { t0Cap: number | null; hop: number; frameSize: number; sampleRate: number } {
    const sr = this.ctx?.sampleRate ?? 48000;
    return { t0Cap: this.t0Cap, hop: Math.round((HOP_MS / 1000) * sr), frameSize: FRAME_SIZE, sampleRate: sr };
  }
  /** Raw microphone samples as the analysis receives them, 16-bit, with their capture index. */
  tap: ((samples: Int16Array, cStart: number) => void) | null = null;
  /** Samples the capture path lost or repeated: at capture index `c`, `n` samples (+ dropped, − repeated). */
  onGap: ((c: number, n: number) => void) | null = null;

  /** The pre-roll (oldest first) and the capture index of its first sample. */
  prerollSamples(): { samples: Int16Array; cStart: number } {
    const r = this.preroll;
    if (!r) return { samples: new Int16Array(0), cStart: this.received };
    const n = Math.min(this.prerollFilled, r.length);
    const out = new Int16Array(n);
    const end = this.received % r.length;
    for (let i = 0; i < n; i++) out[i] = r[(end - n + i + r.length * 2) % r.length];
    return { samples: out, cStart: this.received - n };
  }
  /** The reference tone is playing (frames dropped) from/to these audio times (practice recorder). */
  /** Frames from capture index `from` up to (not including) `to` were dropped while our own sound played. */
  onMute: ((from: number, to: number) => void) | null = null;

  /** What the browser actually applied to the microphone (echo cancellation, AGC, ...). */
  trackSettings(): Record<string, unknown> {
    const tr = this.stream?.getAudioTracks()[0];
    try {
      return tr ? { ...(tr.getSettings() as Record<string, unknown>), label: tr.label } : {};
    } catch {
      return {};
    }
  }

  /**
   * New samples whose last one is at audio time `tEnd`; `startIdx` numbers the first one (the
   * capture's own sample counter), so a lost block is filled with silence of its length and a
   * repeated one dropped, each logged: the sample clock never slips. Quantised to 16 bits (exactly
   * what a recording keeps), then every whole hop is analysed.
   */
  private onAudio(raw0: Float32Array, tEnd: number, startIdx?: number): void {
    const sa = this.sa;
    if (!sa) return;
    const sr = sa.sampleRate;
    let raw = raw0;
    if (startIdx !== undefined) {
      if (this.nextIdx !== null && startIdx !== this.nextIdx) {
        const d = startIdx - this.nextIdx;
        this.onGap?.(this.received, d);
        if (d > 0) {
          const fill = new Float32Array(Math.min(d, sr) + raw.length);
          fill.set(raw, fill.length - raw.length);
          raw = fill;
        } else raw = raw.subarray(Math.min(raw.length, -d));
      }
      this.nextIdx = startIdx + raw0.length;
      if (!raw.length) return;
    }
    const n = raw.length;
    const q = new Int16Array(n);
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, raw[i]));
      q[i] = Math.round(v < 0 ? v * 0x8000 : v * 0x7fff);
      samples[i] = q[i] < 0 ? q[i] / 0x8000 : q[i] / 0x7fff;
    }
    if (this.t0Cap === null) this.t0Cap = tEnd - n / sr;
    this.preroll ??= new Int16Array(Math.round(60 * sr));
    const r = this.preroll;
    for (let i = 0; i < n; i++) r[(this.received + i) % r.length] = q[i];
    this.prerollFilled += n;
    this.tap?.(q, this.received);
    this.received += n;
    const hop = Math.round((HOP_MS / 1000) * sa.sampleRate);
    const all = new Float32Array(this.acc.length + samples.length);
    all.set(this.acc);
    all.set(samples, this.acc.length);
    let off = 0;
    while (all.length - off >= hop) {
      sa.push(all.subarray(off, off + hop));
      off += hop;
      this.fed += hop;
      this.captured = this.fed;
      const t = this.t0Cap + this.fed / sr;
      if (this.fed >= FRAME_SIZE) this.deliver(t);
    }
    this.acc = all.slice(off);
  }

  private deliver(t: number): void {
    const sa = this.sa!;
    if (this.playing || t < this.mutedUntil) {
      if (!this.wasMuted) this.muteFrom = this.captured;
      this.wasMuted = true; // never analyse our own reference tone
      return;
    }
    if (this.wasMuted) {
      sa.attacks.clear(); // ...nor remember its attacks
      this.wasMuted = false;
      this.onMute?.(this.muteFrom, this.captured);
    }
    if (!this.onFrame) return;
    const path = this.pathFn();
    const f = sa.frame(path, t);
    // (e.g. the mic check also runs the guitar detector, so it has learned the room's noise
    // before the first guitar step)
    for (const w of this.warm) if (w !== path) sa.frame(w, t);
    this.onFrame(f);
  }

  /**
   * Start the analysis afresh from the last `warmSec` of input (both paths analysed every hop), so
   * that what it knows depends only on samples a recording can include: the replay does exactly
   * the same. Done in slices between audio callbacks (a phone needs a second or two for 6 s of
   * audio, which must not freeze the page); it catches up with the audio still arriving and
   * takes over from the old analysis at a hop boundary. Returns the capture index the warm-up
   * started at and where the new analysis took over.
   */
  async resetAnalysis(warmSec = 6): Promise<{ cWarm: number; cEnd: number }> {
    const ctx = this.ctx;
    if (!ctx || !this.sa || this.t0Cap === null) return { cWarm: this.captured, cEnd: this.captured };
    const sr = ctx.sampleRate;
    const hop = Math.round((HOP_MS / 1000) * sr);
    const oldest = this.received - Math.min(this.prerollFilled, this.preroll?.length ?? 0);
    const have = Math.floor((this.captured - oldest) / hop);
    const k = Math.max(0, Math.min(have, Math.floor((warmSec * sr) / hop)));
    const cWarm = this.captured - k * hop;
    const t0 = this.t0Cap;
    const sa = new StreamAnalyzer(sr);
    let c = cWarm;
    let pushed = 0;
    const t1 = performance.now();
    for (;;) {
      // (a slow device that cannot keep up in slices finishes the rest in one go after 2 s)
      const upto = performance.now() - t1 > 2000 ? this.captured : Math.min(this.captured, c + 25 * hop);
      if (upto > c) {
        pushed = warmAnalyzer(sa, this.prerollRange(c, upto), c, t0, hop, pushed);
        c = upto;
      }
      // (caught up with what the old analysis has done: take over here, between two hops)
      if (c >= this.captured) {
        this.sa = sa;
        return { cWarm, cEnd: c };
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  /** Samples [c0, c1) of the pre-roll (capture indices). */
  private prerollRange(c0: number, c1: number): Int16Array {
    const r = this.preroll!;
    const out = new Int16Array(c1 - c0);
    for (let i = 0; i < out.length; i++) out[i] = r[(c0 + i) % r.length];
    return out;
  }

  /** Start delivering analysed frames (one per 20 ms of audio), from the path `pathFn` names. */
  listen(cb: (f: PitchFrame) => void, pathFn: () => AnalysisPath = () => 'voice', warm: AnalysisPath[] = []): void {
    this.warm = warm;
    this.onFrame = cb;
    this.pathFn = pathFn;
    if (this.timer !== null) return;
    // (the timer only keeps the context running and, in the last-resort mode, reads the samples)
    this.timer = window.setInterval(() => this.tick(), HOP_MS);
  }

  stopListening(): void {
    this.onFrame = null;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    if (this.captureMode !== 'poll' || !this.rawAnalyser) return;
    // Last resort: the newest samples from the analyser (8192 = ~170 ms of history), numbered by
    // the sample counter's analyser where there is one.
    const a = this.rawAnalyser;
    this.pollBuf ??= new Float32Array(a.fftSize);
    const now = ctx.currentTime;
    const ra = this.rampAnalyser;
    if (ra) {
      this.rampBuf ??= new Float32Array(ra.fftSize);
      for (let tries = 0; tries < 3; tries++) {
        ra.getFloatTimeDomainData(this.rampBuf);
        const before = this.rampBuf[ra.fftSize - 1];
        a.getFloatTimeDomainData(this.pollBuf);
        ra.getFloatTimeDomainData(this.rampBuf);
        if (this.rampBuf[ra.fftSize - 1] === before) break;
      }
      const end = this.unwrap(this.rampBuf[ra.fftSize - 1]) + 1;
      if (this.nextIdx === null) this.nextIdx = end - FRAME_SIZE;
      const want = end - this.nextIdx;
      if (want <= 0) return;
      const fresh = Math.min(a.fftSize, want);
      this.onAudio(this.pollBuf.slice(a.fftSize - fresh), now, end - fresh);
      return;
    }
    const want = this.pollLast < 0 ? FRAME_SIZE : Math.round((now - this.pollLast) * ctx.sampleRate);
    const fresh = Math.min(a.fftSize, want);
    if (fresh <= 0) return;
    // (a timer stall longer than the analyser's history loses audio: say so)
    if (want > fresh) this.onGap?.(this.received, want - fresh);
    this.pollLast = now;
    a.getFloatTimeDomainData(this.pollBuf);
    this.onAudio(this.pollBuf.slice(a.fftSize - fresh), now);
  }

  /** Current audio-clock time (seconds). */
  now(): number {
    return this.ctx?.currentTime ?? performance.now() / 1000;
  }

  /**
   * Play notes (midi, seconds) with a soft electric-piano-like voice. Resolves when the notes
   * and the decay tail are done. Mic frames are dropped for the whole time.
   */
  play(notes: { midi: number | number[]; sec: number }[], onNote?: (i: number) => void): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || !this.master) return Promise.resolve();
    this.stopPlayback();
    const start = ctx.currentTime + 0.06;
    let t = start;
    const nodes: AudioScheduledSourceNode[] = [];
    const timers: number[] = [];
    notes.forEach((n, i) => {
      for (const m of Array.isArray(n.midi) ? n.midi : [n.midi]) nodes.push(...this.voice(m, t, Math.max(0.2, n.sec), Array.isArray(n.midi) ? 0.6 : 1));
      if (onNote) timers.push(window.setTimeout(() => onNote(i), Math.max(0, (t - ctx.currentTime) * 1000)));
      t += n.sec;
    });
    const end = t + 0.35; // release
    this.mutedUntil = end + TAIL_SEC;
    return new Promise<void>((resolve) => {
      const timeout = window.setTimeout(() => finish(), (this.mutedUntil - ctx.currentTime) * 1000 + 20);
      const finish = () => {
        clearTimeout(timeout);
        timers.forEach((x) => clearTimeout(x));
        if (this.playing === handle) this.playing = null;
        resolve();
      };
      const handle = {
        stop: () => {
          for (const node of nodes) {
            try {
              node.stop();
            } catch {
              /* already stopped */
            }
          }
          this.mutedUntil = ctx.currentTime + TAIL_SEC;
          finish();
        },
      };
      this.playing = handle;
    });
  }

  stopPlayback(): void {
    this.playing?.stop();
    this.playing = null;
  }

  private wave: PeriodicWave | null = null;

  private voice(midi: number, t: number, dur: number, gain = 1): AudioScheduledSourceNode[] {
    const ctx = this.ctx!;
    this.wave ??= makeToneWave(ctx);
    return [scheduleTone(ctx, this.master!, this.wave, midi, t, dur, gain)];
  }

  /** Release the microphone (e.g. when leaving a session). */
  close(): void {
    this.stopListening();
    this.stopPlayback();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.sa = null;
    this.captureMode = 'none';
  }
}

/** Keeps the screen awake during practice where the Screen Wake Lock API exists. */
export class WakeLock {
  private sentinel: WakeLockSentinelLike | null = null;
  private wanted = false;

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (this.wanted && document.visibilityState === 'visible') void this.acquire();
    });
  }

  get supported(): boolean {
    return !!(navigator as WakeLockNav).wakeLock;
  }

  async acquire(): Promise<void> {
    this.wanted = true;
    const wl = (navigator as WakeLockNav).wakeLock;
    if (!wl || this.sentinel) return;
    try {
      this.sentinel = await wl.request('screen');
      this.sentinel.addEventListener?.('release', () => {
        this.sentinel = null;
      });
    } catch {
      /* not allowed (e.g. low battery); ignore */
    }
  }

  async release(): Promise<void> {
    this.wanted = false;
    const s = this.sentinel;
    this.sentinel = null;
    await s?.release().catch(() => {});
  }
}

/** Harmonic recipe of the reference tone (a soft, organ/e-piano-like timbre). */
export function makeToneWave(ctx: BaseAudioContext): PeriodicWave {
  const harmonics = [0, 1, 0.42, 0.22, 0.12, 0.07, 0.04, 0.025, 0.015];
  return ctx.createPeriodicWave(new Float32Array(harmonics.length), new Float32Array(harmonics));
}

/**
 * One reference note: a single additive-harmonic oscillator (no detuned partner, so the sustain
 * level is steady), gentle low-pass, quick soft attack, short settle to a flat sustain, release.
 */
export function scheduleTone(ctx: BaseAudioContext, dest: AudioNode, wave: PeriodicWave, midi: number, t: number, dur: number, gain = 1): OscillatorNode {
  const f = midiToFreq(midi);
  const env = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = Math.min(6000, f * 9);
  lp.Q.value = 0.4;
  const peak = 0.34 * gain;
  const sustain = 0.22 * gain;
  const rel = 0.3;
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(peak, t + 0.015);
  env.gain.exponentialRampToValueAtTime(sustain, t + 0.18);
  env.gain.setValueAtTime(sustain, t + Math.max(0.19, dur - 0.05));
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur + rel);
  const o = ctx.createOscillator();
  o.setPeriodicWave(wave);
  o.frequency.value = f;
  o.connect(lp);
  lp.connect(env).connect(dest);
  o.start(t);
  o.stop(t + dur + rel + 0.05);
  return o;
}

/** Render one reference note offline (used by the end-to-end test to check the tone is steady). */
export async function renderToneOffline(midi: number, dur = 0.9, sr = 48000): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil(sr * (dur + 0.6)), sr);
  scheduleTone(ctx, ctx.destination, makeToneWave(ctx), midi, 0.05, dur);
  return (await ctx.startRendering()).getChannelData(0);
}
