// Practice recorder: keeps the microphone stream exactly as the detector receives it (16-bit, the
// same samples, numbered by the same sample clock) plus a log of what the app decided, each event
// stamped with the sample index it happened at, so a real session can be replayed offline and
// compared step by step (scripts/replay.ts). It is written to this browser's storage while it is
// made (recstore.ts) and stays there until the user deletes it; nothing leaves the device unless
// the user saves it. One file: the log travels inside the WAV as a RIFF chunk.
import { LOG_CHUNK, riffChunk, wavHeader } from '../core/wav.ts';
import type { RecStore, TakeHeader } from './recstore.ts';

/** Stop keeping audio after this long (≈ 260 MB at 48 kHz, in storage, not in memory); the log goes on. */
export const RECORD_MAX_SEC = 45 * 60;
export const RECORDING_FORMAT = 'song-pitcher-recording/2';

export interface RecEvent {
  /** capture sample index (the analysis frame that ended at this sample, or the last one before the event) */
  c: number;
  /** audio-clock time, s */
  t: number;
  type: string;
  [k: string]: unknown;
}

/** A unique file name stem: kind, date and time to the second, and a counter if taken. */
export function takeName(kind: string, taken: Set<string>, d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stem = `song-pitcher-${kind}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  let name = stem;
  for (let k = 2; taken.has(name); k++) name = `${stem}-${k}`;
  return name;
}

export class Recorder {
  readonly head: TakeHeader;
  private pending: Int16Array[] = [];
  private pendingN = 0;
  private pendingEv: RecEvent[] = [];
  private writing: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** capture index of the first sample kept, and of the next one expected */
  c0: number | null = null;
  private cNext = 0;
  onFull: (() => void) | null = null;
  /** the storage failed (e.g. full): what was written so far is kept */
  error: string | null = null;
  /** events in order (kept in memory too: small) */
  readonly events: RecEvent[] = [];

  private store: RecStore;
  readonly maxSec: number;

  constructor(
    store: RecStore,
    kind: 'session' | 'soundcheck',
    sampleRate: number,
    meta: Record<string, unknown>,
    name: string,
    /** stop keeping audio after this long (s) */
    maxSec = RECORD_MAX_SEC,
  ) {
    this.maxSec = maxSec;
    this.store = store;
    const now = Date.now();
    this.head = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind, name, createdAt: now, updatedAt: now, sampleRate,
      samples: 0, audioChunks: 0, eventChunks: 0,
      captureMode: String(meta.captureMode ?? ''), gaps: 0, full: false, open: true, saved: false,
      meta: { ...meta, kind, sampleRate, startedAt: new Date(now).toISOString() },
    };
    void this.write(null, null);
    this.timer = setInterval(() => this.flush(), 1000);
  }

  get kind(): 'session' | 'soundcheck' {
    return this.head.kind;
  }
  get sampleRate(): number {
    return this.head.sampleRate;
  }
  get samples(): number {
    return this.head.samples;
  }
  get seconds(): number {
    return this.head.samples / this.head.sampleRate;
  }
  get full(): boolean {
    return this.head.full;
  }

  /** 16-bit samples starting at capture index `cStart`. */
  push(q: Int16Array, cStart: number): void {
    if (this.c0 === null) {
      this.c0 = cStart;
      this.cNext = cStart;
      this.head.meta.c0 = cStart;
    }
    if (cStart !== this.cNext) {
      // (cannot happen: the engine hands over every sample once; logged in case it ever does)
      this.log(cStart, 0, 'recorderSkip', { expected: this.cNext });
    }
    this.cNext = cStart + q.length;
    if (this.head.full) return;
    const room = Math.floor(this.maxSec * this.head.sampleRate) - this.head.samples - this.pendingN;
    const take = Math.min(room, q.length);
    if (take > 0) {
      this.pending.push(take === q.length ? q : q.slice(0, take));
      this.pendingN += take;
    }
    if (take < q.length) {
      this.head.full = true;
      this.log(cStart + take, 0, 'recordingFull', {});
      this.onFull?.();
    }
  }

  log(c: number, t: number, type: string, data: Record<string, unknown> = {}): RecEvent {
    const e: RecEvent = { c, t, type, ...data };
    this.events.push(e);
    this.pendingEv.push(e);
    if (type === 'gap') this.head.gaps++;
    return e;
  }

  private flush(): Promise<void> {
    let audio: Int16Array | null = null;
    if (this.pendingN > 0) {
      audio = new Int16Array(this.pendingN);
      let o = 0;
      for (const p of this.pending) {
        audio.set(p, o);
        o += p.length;
      }
      this.pending = [];
      this.pendingN = 0;
    }
    const ev = this.pendingEv.length ? this.pendingEv : null;
    this.pendingEv = [];
    return this.write(audio, ev);
  }

  private write(audio: Int16Array | null, ev: RecEvent[] | null): Promise<void> {
    this.writing = this.writing.then(async () => {
      if (audio) {
        this.head.audioChunks++;
        this.head.samples += audio.length;
      }
      if (ev) this.head.eventChunks++;
      this.head.updatedAt = Date.now();
      try {
        await this.store.append({ ...this.head, meta: { ...this.head.meta } }, audio, ev);
      } catch (e) {
        this.error = String((e as Error)?.message ?? e);
        if (audio) {
          this.head.audioChunks--;
          this.head.samples -= audio.length;
        }
        if (ev) this.head.eventChunks--;
      }
    });
    return this.writing;
  }

  /** Stop: write what is left and mark the take finished. */
  async finish(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.head.open = false;
    await this.flush();
  }
}

/** The JSON log of a stored take. */
export async function takeLog(store: RecStore, h: TakeHeader): Promise<string> {
  const events = await store.events(h.id, h.eventChunks);
  return JSON.stringify({
    format: RECORDING_FORMAT,
    meta: { ...h.meta, name: h.name, samples: h.samples, seconds: h.samples / h.sampleRate, full: h.full, gaps: h.gaps, interrupted: h.open },
    events,
  });
}

/**
 * The take as one WAV file (the log inside it), built from the stored chunks a few at a time:
 * the samples are never all in memory at once.
 */
export async function takeWav(store: RecStore, h: TakeHeader): Promise<Blob> {
  const log = riffChunk(LOG_CHUNK, new TextEncoder().encode(await takeLog(store, h)));
  let n = 0;
  let blob = new Blob([]);
  let parts: BlobPart[] = [];
  let partBytes = 0;
  await store.eachAudio(h.id, h.audioChunks, (c) => {
    parts.push(c as unknown as BlobPart);
    n += c.length;
    partBytes += c.byteLength;
    if (partBytes > 8e6) {
      blob = new Blob([blob, ...parts]);
      parts = [];
      partBytes = 0;
    }
  });
  const pad = (n * 2) & 1 ? [new Uint8Array(1)] : [];
  return new Blob([wavHeader(n * 2, h.sampleRate, log.length) as BlobPart, blob, ...parts, ...(pad as BlobPart[]), log as BlobPart], { type: 'audio/wav' });
}

export type SaveOutcome = { status: 'shared' | 'downloaded' | 'cancelled' | 'failed'; files: string[]; bytes: number; error?: string };

/**
 * Hand a take to the user: the share sheet where the browser can share files (iOS Safari, Android
 * Chrome), otherwise a download. A cancelled share sheet is not a save.
 */
export async function saveTake(store: RecStore, h: TakeHeader, what: 'wav' | 'log' = 'wav'): Promise<SaveOutcome> {
  let file: File;
  try {
    file =
      what === 'wav'
        ? new File([await takeWav(store, h)], `${h.name}.wav`, { type: 'audio/wav' })
        : new File([await takeLog(store, h)], `${h.name}.json`, { type: 'application/json' });
  } catch (e) {
    return { status: 'failed', files: [], bytes: 0, error: String((e as Error)?.message ?? e) };
  }
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: 'Song Pitcher recording' });
      return { status: 'shared', files: [file.name], bytes: file.size };
    } catch (e) {
      if ((e as Error).name === 'AbortError') return { status: 'cancelled', files: [], bytes: file.size };
      // (other share failures: fall back to a download)
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
  return { status: 'downloaded', files: [file.name], bytes: file.size };
}
