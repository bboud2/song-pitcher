// Where practice recordings live while they are made and until the user deletes them: IndexedDB
// in this browser (chunks of 16-bit samples and of log events, written about once a second, so a
// reload, a back swipe or a crash loses at most the last second), or memory when IndexedDB is not
// available (private windows on some browsers).

export interface TakeHeader {
  id: string;
  kind: 'session' | 'soundcheck';
  /** file name stem, unique (date and time to the second, plus a counter) */
  name: string;
  createdAt: number;
  updatedAt: number;
  sampleRate: number;
  /** samples stored */
  samples: number;
  /** audio and event chunks stored */
  audioChunks: number;
  eventChunks: number;
  captureMode: string;
  /** discontinuities the capture path reported */
  gaps: number;
  /** stopped keeping audio at the length cap */
  full: boolean;
  /** still being recorded (or the page went away while it was) */
  open: boolean;
  /** handed to the share sheet or downloaded */
  saved: boolean;
  meta: Record<string, unknown>;
}

export interface RecStore {
  readonly persistent: boolean;
  putHeader(h: TakeHeader): Promise<void>;
  /** one write: a chunk of audio and/or of events, and the header */
  append(h: TakeHeader, audio: Int16Array | null, events: unknown[] | null): Promise<void>;
  list(): Promise<TakeHeader[]>;
  get(id: string): Promise<TakeHeader | null>;
  /** audio chunks in order, a few at a time (so a long take is never all in memory) */
  eachAudio(id: string, n: number, fn: (chunk: Int16Array) => void | Promise<void>): Promise<void>;
  events(id: string, n: number): Promise<unknown[]>;
  delete(id: string): Promise<void>;
  deleteAll(): Promise<void>;
}

export class MemoryStore implements RecStore {
  readonly persistent = false;
  private heads = new Map<string, TakeHeader>();
  private audio = new Map<string, Int16Array[]>();
  private ev = new Map<string, unknown[][]>();
  async putHeader(h: TakeHeader): Promise<void> {
    this.heads.set(h.id, { ...h });
  }
  async append(h: TakeHeader, audio: Int16Array | null, events: unknown[] | null): Promise<void> {
    if (audio) (this.audio.get(h.id) ?? this.audio.set(h.id, []).get(h.id)!).push(audio);
    if (events) (this.ev.get(h.id) ?? this.ev.set(h.id, []).get(h.id)!).push(events);
    this.heads.set(h.id, { ...h });
  }
  async list(): Promise<TakeHeader[]> {
    return [...this.heads.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
  async get(id: string): Promise<TakeHeader | null> {
    return this.heads.get(id) ?? null;
  }
  async eachAudio(id: string, n: number, fn: (c: Int16Array) => void | Promise<void>): Promise<void> {
    for (const c of (this.audio.get(id) ?? []).slice(0, n)) await fn(c);
  }
  async events(id: string, n: number): Promise<unknown[]> {
    return (this.ev.get(id) ?? []).slice(0, n).flat();
  }
  async delete(id: string): Promise<void> {
    this.heads.delete(id);
    this.audio.delete(id);
    this.ev.delete(id);
  }
  async deleteAll(): Promise<void> {
    this.heads.clear();
    this.audio.clear();
    this.ev.clear();
  }
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
const done = (tx: IDBTransaction) =>
  new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error ?? new Error('transaction aborted'));
  });

export class IdbStore implements RecStore {
  readonly persistent = true;
  private db: IDBDatabase;
  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static async open(name = 'song-pitcher-recordings'): Promise<IdbStore> {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('takes', { keyPath: 'id' });
      db.createObjectStore('audio'); // key [id, n]: ArrayBuffer of 16-bit samples
      db.createObjectStore('events'); // key [id, n]: array of events
    };
    return new IdbStore(await req(r));
  }

  async putHeader(h: TakeHeader): Promise<void> {
    const tx = this.db.transaction('takes', 'readwrite');
    tx.objectStore('takes').put(h);
    await done(tx);
  }

  async append(h: TakeHeader, audio: Int16Array | null, events: unknown[] | null): Promise<void> {
    const tx = this.db.transaction(['takes', 'audio', 'events'], 'readwrite');
    if (audio) tx.objectStore('audio').put(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength), [h.id, h.audioChunks - 1]);
    if (events) tx.objectStore('events').put(events, [h.id, h.eventChunks - 1]);
    tx.objectStore('takes').put(h);
    await done(tx);
  }

  async list(): Promise<TakeHeader[]> {
    const tx = this.db.transaction('takes', 'readonly');
    const all = (await req(tx.objectStore('takes').getAll())) as TakeHeader[];
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(id: string): Promise<TakeHeader | null> {
    const tx = this.db.transaction('takes', 'readonly');
    return ((await req(tx.objectStore('takes').get(id))) as TakeHeader | undefined) ?? null;
  }

  async eachAudio(id: string, n: number, fn: (c: Int16Array) => void | Promise<void>): Promise<void> {
    // (a few chunks per transaction: a transaction must not wait on the caller)
    for (let k = 0; k < n; k += 30) {
      const tx = this.db.transaction('audio', 'readonly');
      const bufs = (await req(tx.objectStore('audio').getAll(IDBKeyRange.bound([id, k], [id, Math.min(n, k + 30) - 1])))) as ArrayBuffer[];
      for (const b of bufs) await fn(new Int16Array(b));
    }
  }

  async events(id: string, n: number): Promise<unknown[]> {
    if (n <= 0) return [];
    const tx = this.db.transaction('events', 'readonly');
    const parts = (await req(tx.objectStore('events').getAll(IDBKeyRange.bound([id, 0], [id, n - 1])))) as unknown[][];
    return parts.flat();
  }

  async delete(id: string): Promise<void> {
    const tx = this.db.transaction(['takes', 'audio', 'events'], 'readwrite');
    tx.objectStore('takes').delete(id);
    const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
    tx.objectStore('audio').delete(range);
    tx.objectStore('events').delete(range);
    await done(tx);
  }

  async deleteAll(): Promise<void> {
    const tx = this.db.transaction(['takes', 'audio', 'events'], 'readwrite');
    for (const s of ['takes', 'audio', 'events']) tx.objectStore(s).clear();
    await done(tx);
  }
}

let opened: Promise<RecStore> | null = null;
/** The recordings store: IndexedDB when it opens, memory otherwise. */
export function recStore(): Promise<RecStore> {
  opened ??= (async () => {
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no IndexedDB');
      return await IdbStore.open();
    } catch {
      return new MemoryStore();
    }
  })();
  return opened;
}
