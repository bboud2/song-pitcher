// Browser audio: microphone capture + analysis loop, reference-tone synthesis, wake lock.
// Playback and listening never overlap: while a reference plays (plus a decay tail) the
// analysis loop drops frames, and the session state machine ignores mic input in 'listen'.
import { FRAME_SIZE, HOP_MS, makeDetector } from '../core/engine.ts';
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
  private analyser: AnalyserNode | null = null;
  private buf: Float32Array<ArrayBuffer> = new Float32Array(FRAME_SIZE);
  private detector: PitchDetector | null = null;
  private timer: number | null = null;
  private onFrame: ((f: PitchFrame) => void) | null = null;
  private mutedUntil = 0;
  private playing: { stop: () => void } | null = null;
  private master: GainNode | null = null;

  get ready(): boolean {
    return !!this.ctx && !!this.analyser;
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
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = FRAME_SIZE;
      this.analyser.smoothingTimeConstant = 0;
      src.connect(this.analyser); // never connected to the speakers
      this.detector = makeDetector(this.ctx.sampleRate);
    }
    await resume;
  }

  /** Start delivering analysed frames every HOP_MS. */
  listen(cb: (f: PitchFrame) => void): void {
    this.onFrame = cb;
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
    if (!ctx || !this.analyser || !this.detector || !this.onFrame) return;
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    const t = ctx.currentTime;
    if (this.playing || t < this.mutedUntil) return; // never analyse our own reference tone
    this.analyser.getFloatTimeDomainData(this.buf);
    const r = this.detector.detect(this.buf);
    this.onFrame({ t, freq: r.freq, clarity: r.clarity, rms: r.rms });
  }

  /** Current audio-clock time (seconds). */
  now(): number {
    return this.ctx?.currentTime ?? performance.now() / 1000;
  }

  /**
   * Play notes (midi, seconds) with a soft electric-piano-like voice. Resolves when the notes
   * and the decay tail are done. Mic frames are dropped for the whole time.
   */
  play(notes: { midi: number; sec: number }[]): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || !this.master) return Promise.resolve();
    this.stopPlayback();
    const start = ctx.currentTime + 0.06;
    let t = start;
    const nodes: AudioScheduledSourceNode[] = [];
    for (const n of notes) {
      nodes.push(...this.voice(n.midi, t, Math.max(0.2, n.sec)));
      t += n.sec;
    }
    const end = t + 0.35; // release
    this.mutedUntil = end + TAIL_SEC;
    return new Promise<void>((resolve) => {
      const timeout = window.setTimeout(() => finish(), (this.mutedUntil - ctx.currentTime) * 1000 + 20);
      const finish = () => {
        clearTimeout(timeout);
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

  /** One note: additive harmonic tone + slightly detuned partner, gentle low-pass, piano-ish envelope. */
  private voice(midi: number, t: number, dur: number): AudioScheduledSourceNode[] {
    const ctx = this.ctx!;
    if (!this.wave) {
      const harmonics = [0, 1, 0.42, 0.22, 0.12, 0.07, 0.04, 0.025, 0.015];
      const real = new Float32Array(harmonics.length);
      const imag = new Float32Array(harmonics);
      this.wave = ctx.createPeriodicWave(real, imag);
    }
    const f = midiToFreq(midi);
    const env = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(6000, f * 9);
    lp.Q.value = 0.4;
    const peak = 0.32;
    const sustain = 0.18;
    const rel = 0.3;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.012);
    env.gain.exponentialRampToValueAtTime(sustain, t + 0.25);
    env.gain.setValueAtTime(sustain, t + Math.max(0.26, dur - 0.05));
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur + rel);
    const out: AudioScheduledSourceNode[] = [];
    for (const detune of [-4, 4]) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(this.wave);
      o.frequency.value = f;
      o.detune.value = detune;
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + rel + 0.05);
      out.push(o);
    }
    lp.connect(env).connect(this.master!);
    return out;
  }

  /** Release the microphone (e.g. when leaving a session). */
  close(): void {
    this.stopListening();
    this.stopPlayback();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.analyser = null;
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
