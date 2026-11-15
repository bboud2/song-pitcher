// Practice recorder (round 8): one sample clock, storage in chunks, a length cap that keeps the
// log going, one WAV file with the log inside, and a replay that refuses files that do not match.
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/ui/recstore.ts';
import { Recorder, takeName, takeWav } from '../src/ui/recorder.ts';
import { LOG_CHUNK, decodeWav, readWavChunk } from '../src/core/wav.ts';
import { loadRecording } from '../scripts/replay.ts';

const block = (n: number, v: number) => new Int16Array(n).fill(v);

describe('practice recorder', () => {
  it('stores what it is given, in order, and writes one WAV with the log inside', async () => {
    const store = new MemoryStore();
    const r = new Recorder(store, 'session', 48000, { captureMode: 'worklet' }, 'song-pitcher-session-20261115-101010');
    r.push(block(1000, 1), 5000);
    r.push(block(500, 2), 6000);
    r.log(5960, 0.1, 'step', { index: 0 });
    await r.finish();
    const [h] = await store.list();
    expect(h.samples).toBe(1500);
    expect(h.meta.c0).toBe(5000);
    expect(h.open).toBe(false);
    const bytes = new Uint8Array(await (await takeWav(store, h)).arrayBuffer());
    const w = decodeWav(bytes);
    expect(w.samples.length).toBe(1500);
    expect(Math.round(w.samples[999] * 32768)).toBe(1);
    expect(Math.round(w.samples[1000] * 32768)).toBe(2);
    const log = JSON.parse(new TextDecoder().decode(readWavChunk(bytes, LOG_CHUNK)!));
    expect(log.meta.samples).toBe(1500);
    expect(log.events[0]).toMatchObject({ c: 5960, type: 'step' });
    expect(loadRecording(bytes).q.length).toBe(1500);
  });

  it('stops keeping audio at the cap but goes on logging', async () => {
    const store = new MemoryStore();
    const r = new Recorder(store, 'session', 1000, {}, 'x', 2);
    let full = 0;
    r.onFull = () => full++;
    r.push(block(1500, 3), 0);
    r.push(block(1500, 3), 1500);
    r.log(2900, 2.9, 'accept', {});
    await r.finish();
    const [h] = await store.list();
    expect(h.samples).toBe(2000);
    expect(h.full).toBe(true);
    expect(full).toBe(1);
    expect(r.events.map((e) => e.type)).toEqual(['recordingFull', 'accept']);
  });

  it('gives every take a unique name, to the second', () => {
    const d = new Date(2026, 10, 15, 9, 8, 7);
    const a = takeName('session', new Set(), d);
    expect(a).toBe('song-pitcher-session-20261115-090807');
    expect(takeName('session', new Set([a]), d)).toBe(`${a}-2`);
  });

  it('the replay refuses a WAV that does not match its log', async () => {
    const store = new MemoryStore();
    const r = new Recorder(store, 'session', 48000, {}, 'y');
    r.push(block(4800, 5), 0);
    await r.finish();
    const [h] = await store.list();
    const bytes = new Uint8Array(await (await takeWav(store, h)).arrayBuffer());
    const log = JSON.parse(new TextDecoder().decode(readWavChunk(bytes, LOG_CHUNK)!));
    expect(() => loadRecording(bytes, JSON.stringify({ ...log, meta: { ...log.meta, sampleRate: 44100 } }))).toThrow(/sample rate/);
    expect(() => loadRecording(bytes, JSON.stringify({ ...log, meta: { ...log.meta, samples: 9600 } }))).toThrow(/truncated/);
    expect(() => loadRecording(bytes, JSON.stringify({ ...log, meta: { ...log.meta, samples: 100 } }))).toThrow(/not from the same recording/);
    expect(() => loadRecording(bytes.slice(0, 44 + 2000))).toThrow(/no Song Pitcher log|truncated/);
  });
});
