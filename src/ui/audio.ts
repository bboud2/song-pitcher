// Browser audio: microphone capture + analysis loop, reference-tone synthesis, wake lock.
// Playback and listening never overlap: while a reference plays (plus a decay tail) the
// analysis loop drops frames, and the session state machine ignores mic input in 'listen'.
import {
  BUTTERWORTH4_Q, FRAME_SIZE, GUITAR_HPF_HZ, HOP_MS, VOICE_LPF_HZ, makeDetector, type AnalysisPath,
} from '../core/engine.ts';
import type { PitchFrame } from '../core/matcher.ts';
import { midiToFreq } from '../core/music.ts';
import type { PitchDetector } from '../core/pitch.ts';

/** Silence after a reference tone before the mic is trusted again (room decay + analysis window). */
const TAIL_SEC = 0.3;

type AudioSessionNav = Navigator & { audioSession?: { type: string } };
type WakeLockSentinelLike = { release(): Promise<void>; addEventListener?: (t: string, f: () => void) => void };
type WakeLockNav = Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } };

export class AudioEngine {
  ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  /** Two analysis paths, the same as the offline engine: voice (low-passed) and guitar (high-passed). */
  private analysers: Partial<Record<AnalysisPath, AnalyserNode>> = {};
  private detectors: Partial<Record<AnalysisPath, PitchDetector>> = {};
  private buf: Float32Array<ArrayBuffer> = new Float32Array(FRAME_SIZE);
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
  private mutedUntil = 0;
  private playing: { stop: () => void } | null = null;
  private master: GainNode | null = null;

  get ready(): boolean {
    return !!this.ctx && !!this.analysers.voice;
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
      // Web Audio's lowpass/highpass Q is in dB.
      const chain = (type: BiquadFilterType, hz: number): AudioNode => {
        let node: AudioNode = src;
        for (const q of BUTTERWORTH4_Q) {
          const b = ctx.createBiquadFilter();
          b.type = type;
          b.frequency.value = hz;
          b.Q.value = 20 * Math.log10(q);
          node.connect(b);
          node = b;
        }
        return node;
      };
      for (const [path, node] of [['voice', chain('lowpass', VOICE_LPF_HZ)], ['guitar', chain('highpass', GUITAR_HPF_HZ)]] as const) {
        const a = ctx.createAnalyser();
        a.fftSize = FRAME_SIZE;
        a.smoothingTimeConstant = 0;
        node.connect(a); // never connected to the speakers
        this.analysers[path] = a;
        this.detectors[path] = makeDetector(ctx.sampleRate, path);
      }
      // unfiltered, high-resolution spectrum for the mic/room check (hum lines)
      this.rawAnalyser = ctx.createAnalyser();
      this.rawAnalyser.fftSize = 8192;
      this.rawAnalyser.smoothingTimeConstant = 0.5;
      src.connect(this.rawAnalyser);
    }
    await resume;
  }

  /** Start delivering analysed frames every HOP_MS, from the path `pathFn` names at each tick. */
  listen(cb: (f: PitchFrame) => void, pathFn: () => AnalysisPath = () => 'voice'): void {
    this.onFrame = cb;
    this.pathFn = pathFn;
    if (this.timer !== null) return;
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
    const path = this.pathFn();
    const an = this.analysers[path];
    const det = this.detectors[path];
    if (!ctx || !an || !det || !this.onFrame) return;
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    const t = ctx.currentTime;
    if (this.playing || t < this.mutedUntil) return; // never analyse our own reference tone
    an.getFloatTimeDomainData(this.buf);
    const r = det.detect(this.buf);
    this.onFrame({
      t, freq: r.freq, clarity: r.clarity, rms: r.rms, upClarity: r.upClarity ?? 0, cleanRms: r.cleanRms, nsdf: r.nsdf,
      sr: ctx.sampleRate, novFreq: r.novFreq, novClarity: r.novClarity, novShare: r.novShare,
    });
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
    this.analysers = {};
    this.detectors = {};
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
