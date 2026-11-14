// Practice recorder: keeps the raw microphone stream exactly as the detector receives it (same
// capture path, native sample rate, nothing of ours applied) plus a JSON log of what the app
// decided, so a real session can be replayed offline (scripts/replay.ts). Nothing leaves the
// device until the user saves the files.
import { encodeWav } from '../core/wav.ts';

/** Stop keeping audio after this long (≈ 230 MB of float samples at 48 kHz). */
export const RECORD_MAX_SEC = 20 * 60;

export interface RecEvent {
  /** audio-clock time (AudioContext.currentTime, s) */
  t: number;
  type: string;
  [k: string]: unknown;
}

export class Recorder {
  readonly kind: 'session' | 'soundcheck';
  readonly sampleRate: number;
  private chunks: Float32Array[] = [];
  /** samples kept */
  samples = 0;
  /** audio-clock time of the first sample kept */
  t0: number | null = null;
  /** the cap was reached: audio after it was not kept */
  full = false;
  readonly events: RecEvent[] = [];
  readonly meta: Record<string, unknown>;
  onFull: (() => void) | null = null;

  constructor(kind: 'session' | 'soundcheck', sampleRate: number, meta: Record<string, unknown>) {
    this.kind = kind;
    this.sampleRate = sampleRate;
    this.meta = { ...meta, kind, sampleRate, startedAt: new Date().toISOString() };
  }

  /** Raw samples whose last one is at audio time `tEnd`. */
  push(samples: Float32Array, tEnd: number): void {
    if (this.full) return;
    if (this.t0 === null) this.t0 = tEnd - samples.length / this.sampleRate;
    const room = Math.floor(RECORD_MAX_SEC * this.sampleRate) - this.samples;
    const take = Math.min(room, samples.length);
    if (take > 0) {
      this.chunks.push(samples.slice(0, take));
      this.samples += take;
    }
    if (take < samples.length) {
      this.full = true;
      this.log(tEnd, 'recordingFull', {});
      this.onFull?.();
    }
  }

  log(t: number, type: string, data: Record<string, unknown>): void {
    this.events.push({ t, type, ...data });
  }

  get seconds(): number {
    return this.samples / this.sampleRate;
  }

  wav(): Uint8Array {
    return encodeWav(this.chunks, this.sampleRate);
  }

  json(): string {
    return JSON.stringify({ format: 'song-pitcher-recording/1', meta: { ...this.meta, t0: this.t0, samples: this.samples, seconds: this.seconds, full: this.full }, events: this.events }, null, 1);
  }

  /** File names for this recording (same stem). */
  names(): { wav: string; json: string } {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const stem = `song-pitcher-${this.kind}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
    return { wav: `${stem}.wav`, json: `${stem}.json` };
  }
}

/**
 * Hand the two files to the user: the share sheet where the browser can share files (iOS Safari,
 * Android Chrome), otherwise two downloads.
 */
export async function saveRecording(rec: Recorder): Promise<'shared' | 'downloaded'> {
  const n = rec.names();
  const wav = new File([rec.wav() as BlobPart], n.wav, { type: 'audio/wav' });
  const json = new File([rec.json()], n.json, { type: 'application/json' });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.share && nav.canShare?.({ files: [wav, json] })) {
    try {
      await nav.share({ files: [wav, json], title: 'Song Pitcher recording' });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'shared';
      // (fall back to downloads)
    }
  }
  for (const f of [wav, json]) {
    const url = URL.createObjectURL(f);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    await new Promise((r) => setTimeout(r, 300));
  }
  return 'downloaded';
}
