// Offline replay of a practice recording made in the app (Settings → "Record sessions for
// testing"): runs the recorded microphone samples through the real engine and session on the
// same sample clock as the app (the log stamps every event with the capture sample index it
// happened at), applying the same step openings, mutes, pauses, replays, skips and setting
// changes, and compares what the matcher decides now with what the app decided then, step by
// step. Whenever the app's log says the session moved to a step the replay is not on, the replay
// is put on that step (and the step is counted as differing), so one difference does not spoil
// the rest.
//
//   node scripts/replay.ts recording.wav [recording.json]
//
// The log is read from inside the WAV (the app writes it there); a separate JSON can be given
// instead (older recordings: NAME.wav + NAME.json). The replay refuses a WAV whose sample rate or
// length does not match its log. Recordings dropped into recordings/ are run by the gauntlet.
import { readFileSync, existsSync } from 'node:fs';
import { FRAME_SIZE, HOP_MS, StreamAnalyzer, fromInt16, warmAnalyzer } from '../src/core/engine.ts';
import { Session, type SyncState } from '../src/core/session.ts';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/core/settings.ts';
import { songById } from '../src/core/songs.ts';
import { LOG_CHUNK, decodeWav, readWavChunk } from '../src/core/wav.ts';

interface Ev { t: number; c?: number; type: string; [k: string]: unknown }
export interface Accept { c: number; t: number; phase: string; index: number; pos: number }
export interface StepResult { at: number; key: string; logged: Accept[]; replayed: Accept[]; ok: boolean; resynced: boolean }
export interface ReplayResult {
  kind: string;
  format: number;
  logged: Accept[];
  replayed: Accept[];
  /** logged accepts the replay did not reproduce (same step, same analysis frame) */
  missing: Accept[];
  /** replayed accepts the app did not log */
  extra: Accept[];
  steps: StepResult[];
  stepsAgree: number;
  resyncs: number;
  marks: string[];
  gaps: number;
  lines: string[];
}

export class RecordingError extends Error {}

const keyOf = (a: { phase: string; index: number; pos: number }) => `${a.index}|${a.phase}|${a.pos}`;

/** Read the log: embedded in the WAV, else the JSON given. Throws RecordingError on anything inconsistent. */
export function loadRecording(wavBytes: Uint8Array, json?: string | null): { rec: { format?: string; meta: Record<string, unknown>; events: Ev[] }; q: Int16Array; sampleRate: number } {
  let w: ReturnType<typeof decodeWav>;
  try {
    w = decodeWav(wavBytes);
  } catch (e) {
    throw new RecordingError(`not a readable WAV file (${(e as Error).message})`);
  }
  const inside = readWavChunk(wavBytes, LOG_CHUNK);
  const text = json ?? (inside ? new TextDecoder().decode(inside) : null);
  if (!text) throw new RecordingError('this WAV has no Song Pitcher log inside it, and no JSON log was given');
  let rec: { format?: string; meta: Record<string, unknown>; events: Ev[] };
  try {
    rec = JSON.parse(text);
  } catch {
    throw new RecordingError('the log is not valid JSON');
  }
  if (!rec || typeof rec !== 'object' || !rec.meta || !Array.isArray(rec.events)) throw new RecordingError('the log is not a Song Pitcher recording log');
  const meta = rec.meta;
  if (w.bits !== 16 || w.channels !== 1) throw new RecordingError(`expected 16-bit mono audio, the WAV is ${w.bits}-bit with ${w.channels} channel(s): not a file the app wrote`);
  if (Number(meta.sampleRate) !== w.sampleRate) throw new RecordingError(`sample rate ${w.sampleRate} Hz in the WAV, ${meta.sampleRate} Hz in the log: they are not from the same recording`);
  if (w.declaredFrames > w.samples.length) throw new RecordingError(`the WAV is truncated: its header promises ${w.declaredFrames} samples, the file holds ${w.samples.length}`);
  const want = Number(meta.samples);
  if (Number.isFinite(want) && want !== w.samples.length) {
    throw new RecordingError(
      want > w.samples.length
        ? `the WAV is truncated: the log says ${want} samples, the WAV holds ${w.samples.length}`
        : `the WAV holds ${w.samples.length} samples, the log says ${want}: they are not from the same recording`,
    );
  }
  // (back to the exact 16-bit values the app analysed)
  const q = new Int16Array(w.samples.length);
  for (let i = 0; i < q.length; i++) q[i] = Math.round(w.samples[i] * 32768);
  return { rec, q, sampleRate: w.sampleRate };
}

export function replayRecording(wavBytes: Uint8Array, json?: string | null): ReplayResult {
  const { rec, q, sampleRate: sr } = loadRecording(wavBytes, json);
  const meta = rec.meta;
  const kind = String(meta.kind ?? 'session');
  const format = rec.format === 'song-pitcher-recording/2' ? 2 : 1;
  const hop = Math.round((HOP_MS / 1000) * sr);
  const lines: string[] = [];

  // ---- the sample clock: capture index c of every recorded sample and of every event
  let c0: number;
  let t0: number;
  let events: Ev[];
  let warm: { cWarm: number; cEnd: number } | null = null;
  let firstHopEnd: number;
  if (format === 2) {
    c0 = Number(meta.c0);
    const clock = meta.clock as { t0Cap: number };
    t0 = Number(clock.t0Cap);
    events = rec.events.map((e) => ({ ...e }));
    warm = (meta.warm as { cWarm: number; cEnd: number }) ?? null;
    firstHopEnd = warm ? warm.cEnd + hop : c0 + hop;
  } else {
    // Format 1 (round 7): times only. The analysis grid's phase is read off the frame-timed
    // events (hint/accept fall exactly on analysis frames); other events apply before the next frame.
    c0 = 0;
    t0 = Number(meta.t0 ?? 0);
    const base = Math.round(t0 * sr);
    const framed = rec.events.filter((e) => e.type === 'accept' || e.type === 'hint');
    const phases = new Map<number, number>();
    for (const e of framed) {
      const g = (((Math.round(e.t * sr) - base) % hop) + hop) % hop;
      phases.set(g, (phases.get(g) ?? 0) + 1);
    }
    const g = [...phases.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    const toGrid = (t: number, framedEv: boolean) => {
      const x = Math.round(t * sr) - base;
      if (framedEv) return x;
      // last frame strictly before t
      return Math.ceil((x - g) / hop) * hop + g - hop;
    };
    events = rec.events.map((e) => {
      const o: Ev = { ...e, c: toGrid(e.t, e.type === 'accept' || e.type === 'hint') };
      if (e.type === 'mute') {
        o.from = Math.round(Number(e.from) * sr) - base;
        o.to = Math.round(Number(e.to) * sr) - base;
        o.c = o.to as number;
      }
      return o;
    });
    firstHopEnd = g + hop;
  }
  events.sort((a, b) => (a.c as number) - (b.c as number));

  const logged: Accept[] = events.filter((e) => e.type === 'accept').map((e) => ({ c: e.c as number, t: e.t, phase: String(e.phase), index: Number(e.index), pos: Number(e.pos ?? -1) }));
  const marks = events.filter((e) => e.type === 'mark').map((e) => {
    const lab = events.find((x) => x.type === 'markLabel' && x.id === e.id);
    return `mark ${e.id} at ${((e.c as number) / sr).toFixed(2)} s (sample ${e.c})${lab ? `: ${lab.label}` : ''}`;
  });
  const gaps = events.filter((e) => e.type === 'gap').length;
  if (kind !== 'session') {
    return { kind, format, logged, replayed: [], missing: [], extra: [], steps: [], stepsAgree: 0, resyncs: 0, marks, gaps, lines: ['(sound check recording: nothing to replay against)'] };
  }

  const settings0 = normalizeSettings({ ...DEFAULT_SETTINGS, ...(meta.settings as object) });
  const song = songById(String(meta.songId ?? 'star-spangled-banner'));
  const session = new Session(song, Number(meta.tonicMidi ?? song.defaultTonicMidi), settings0);
  const mutes = events.filter((e) => e.type === 'mute').map((e) => ({ from: Number(e.from), to: Number(e.to) }));
  const stepEvents = events.filter((e) => e.type === 'step');
  const sa = new StreamAnalyzer(sr);
  const sample = (c: number) => q[c - c0];
  const end = c0 + q.length;

  let started = false;
  let ended = false;
  let paused = false;
  let ei = 0;
  let resyncs = 0;
  const replayed: Accept[] = [];
  const resyncAt = new Set<number>();

  const legacySync = (e: Ev, k: number): SyncState => {
    const phase = String(e.phase) as SyncState['phase'];
    const index = Number(e.index);
    const later = stepEvents.slice(k + 1).find((x) => Number(x.index) === index && x.phase !== 'listen');
    const prev = stepEvents[k - 1];
    const next = (phase === 'listen' ? (e.listenKind === 'phrase' ? 'review' : (later?.phase as SyncState['phase']) ?? 'sing') : phase) as SyncState['phase'];
    const sung = [...logged].reverse().find((a) => a.index === index && a.phase === 'sing' && a.c <= (e.c as number));
    const sungEv = sung ? events.find((x) => x.type === 'accept' && x.c === sung.c) : undefined;
    return {
      phase, next, listenKind: (e.listenKind as SyncState['listenKind']) ?? 'note', index, pos: Number(e.pos ?? -1),
      sungMidi: sungEv?.detected != null ? Number(sungEv.detected) : null, stepStart: e.t,
      begun: phase === 'listen' && !!prev && Number(prev.index) === index && prev.phase === next,
    };
  };
  const sameSync = (a: SyncState, b: SyncState) =>
    a.phase === b.phase && a.index === b.index && (a.phase !== 'review' || a.pos === b.pos) && (a.phase !== 'listen' || (a.next === b.next && a.listenKind === b.listenKind));

  const apply = (e: Ev) => {
    switch (e.type) {
      case 'start':
        session.start(Number(e.startIndex ?? 0));
        started = true;
        break;
      case 'listenDone':
        session.listenDone(Number(e.tDone ?? e.t));
        break;
      case 'replay':
        session.replay();
        break;
      case 'skip':
        session.skip();
        break;
      case 'pause':
        paused = true;
        break;
      case 'resume':
        paused = false;
        if (format === 1 && e.settings) session.setSettings(normalizeSettings(e.settings));
        break;
      case 'settings':
        session.setSettings(normalizeSettings(e.settings));
        break;
      case 'end':
        ended = true;
        break;
      case 'step': {
        if (!started) break;
        const want = format === 2 && e.sync ? (e.sync as SyncState) : legacySync(e, stepEvents.indexOf(e));
        if (!sameSync(session.syncState(), want)) {
          session.syncTo(want);
          resyncs++;
          resyncAt.add(e.c as number);
        }
        break;
      }
    }
  };

  // ---- warm-up (format 2): exactly what the app did when the session started
  let c = firstHopEnd - hop;
  if (warm) {
    if (warm.cWarm < c0 || warm.cEnd > end) throw new RecordingError('the recording does not hold the warm-up its log describes');
    warmAnalyzer(sa, q.subarray(warm.cWarm - c0, warm.cEnd - c0), warm.cWarm, t0, hop);
    c = warm.cEnd;
  } else if (c > c0) {
    const head = new Float32Array(c - c0);
    for (let i = 0; i < head.length; i++) head[i] = fromInt16(q[i]);
    sa.push(head);
  }
  while (ei < events.length && (events[ei].c as number) <= c) apply(events[ei++]);

  const buf = new Float32Array(hop);
  let fed = c - c0;
  let wasMuted = false;
  for (; c + hop <= end && !ended; ) {
    for (let i = 0; i < hop; i++) buf[i] = fromInt16(sample(c + i));
    sa.push(buf);
    c += hop;
    fed += hop;
    if (started && !ended && (format === 2 || fed >= FRAME_SIZE)) {
      if (mutes.some((m) => c >= m.from && c < m.to)) wasMuted = true;
      else {
        if (wasMuted || mutes.some((m) => m.to === c)) sa.attacks.clear();
        wasMuted = false;
        const f = sa.frame(session.listeningPath(), t0 + c / sr);
        if (process.env.REPLAY_DEBUG && c % (hop * 50) === 0) console.log('dbg', ((c - c0) / sr).toFixed(2), session.view().phase, session.view().index, paused, f.freq?.toFixed?.(1), f.rms.toFixed(4));
        if (!paused) {
          const before = session.view();
          if (session.pitch(f)) replayed.push({ c, t: f.t, phase: before.phase, index: before.index, pos: before.review?.pos ?? -1 });
        }
      }
    }
    while (ei < events.length && (events[ei].c as number) <= c) apply(events[ei++]);
  }
  if (ei < events.length && events.slice(ei).some((e) => e.type === 'accept')) lines.push('(the audio ends before the log: the rest of the log was not replayed)');

  // ---- comparison: accepts, and each logged step (from one step event to the next)
  const same = (a: Accept, b: Accept) => keyOf(a) === keyOf(b) && a.c === b.c;
  const missing = logged.filter((a) => !replayed.some((b) => same(a, b)));
  const extra = replayed.filter((b) => !logged.some((a) => same(a, b)));
  const steps: StepResult[] = [];
  const bounds = stepEvents.map((e) => e.c as number);
  for (let k = 0; k < stepEvents.length; k++) {
    const e = stepEvents[k];
    if (e.phase === 'listen' || e.phase === 'done') continue;
    const from = bounds[k];
    const to = k + 1 < bounds.length ? bounds[k + 1] : Infinity;
    const inSeg = (a: Accept) => a.c > from && a.c <= to;
    const l = logged.filter(inSeg);
    const r = replayed.filter(inSeg);
    const ok = l.length === r.length && l.every((a) => r.some((b) => same(a, b))) && !resyncAt.has(from);
    steps.push({ at: from, key: keyOf({ phase: String(e.phase), index: Number(e.index), pos: Number(e.pos ?? -1) }), logged: l, replayed: r, ok, resynced: resyncAt.has(from) });
  }
  const stepsAgree = steps.filter((s) => s.ok).length;
  const sec = (x: number) => ((x - c0) / sr).toFixed(2);
  for (const s of steps) {
    if (s.ok) continue;
    const [index, phase, pos] = s.key.split('|');
    lines.push(
      `note ${Number(index) + 1} ${phase}${pos !== '-1' ? ` pos ${pos}` : ''} (from ${sec(s.at)} s): app ${s.logged.map((a) => `accepted at ${sec(a.c)} s`).join(', ') || 'did not accept'}; replay ${s.replayed.map((a) => `accepted at ${sec(a.c)} s`).join(', ') || 'did not accept'}${s.resynced ? ' (replay was on another step: put back in step)' : ''}   <-- differs`,
    );
  }
  return { kind, format, logged, replayed, missing, extra, steps, stepsAgree, resyncs, marks, gaps, lines };
}

if (process.argv[1]?.endsWith('replay.ts')) {
  const wav = process.argv[2];
  if (!wav) {
    console.error('usage: node scripts/replay.ts recording.wav [recording.json]');
    process.exit(2);
  }
  const side = process.argv[3] ?? wav.replace(/\.wav$/i, '.json');
  try {
    const r = replayRecording(new Uint8Array(readFileSync(wav)), process.argv[3] || existsSync(side) ? readFileSync(side, 'utf8') : null);
    for (const l of r.lines) console.log(l);
    for (const m of r.marks) console.log(m);
    if (r.gaps) console.log(`${r.gaps} gap(s) in the captured audio (see the log's "gap" events)`);
    console.log(
      `\n${r.kind} (log format ${r.format}): steps agreeing ${r.stepsAgree}/${r.steps.length}; app accepted ${r.logged.length}, replay accepted ${r.replayed.length}; not reproduced ${r.missing.length}, extra ${r.extra.length}; resynchronised ${r.resyncs} time(s)`,
    );
    process.exit(r.missing.length || r.extra.length || r.resyncs ? 1 : 0);
  } catch (e) {
    if (e instanceof RecordingError) {
      console.error(`replay refused: ${e.message}`);
      process.exit(3);
    }
    throw e;
  }
}
