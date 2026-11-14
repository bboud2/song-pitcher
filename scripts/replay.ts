// Offline replay of a practice recording made in the app (Settings → "Record this session for
// testing"): runs the raw microphone audio through the real engine and session, applying the
// same step openings, mutes, pauses, replays and skips the app logged, and compares what the
// matcher decides now with what the app decided then.
//
//   node scripts/replay.ts recording.wav [recording.json]
//
// (the JSON defaults to the WAV's name with .json). Recordings dropped into recordings/ are run
// by the gauntlet automatically.
import { readFileSync } from 'node:fs';
import { FRAME_SIZE, HOP_MS, StreamAnalyzer } from '../src/core/engine.ts';
import { Session } from '../src/core/session.ts';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/core/settings.ts';
import { songById } from '../src/core/songs.ts';
import { decodeWav } from '../src/core/wav.ts';

interface Ev { t: number; type: string; [k: string]: unknown }
export interface Accept { t: number; phase: string; index: number; pos: number }
export interface ReplayResult {
  kind: string;
  logged: Accept[];
  replayed: Accept[];
  /** logged accepts the replay did not reproduce (same step, within 0.25 s) */
  missing: Accept[];
  /** replayed accepts the app did not log */
  extra: Accept[];
  lines: string[];
}

export function replayRecording(wavBytes: Uint8Array, json: string): ReplayResult {
  const rec = JSON.parse(json) as { meta: Record<string, unknown>; events: Ev[] };
  const { sampleRate, samples } = decodeWav(wavBytes);
  const meta = rec.meta;
  const events = [...rec.events].sort((a, b) => a.t - b.t);
  const kind = String(meta.kind ?? 'session');
  const t0 = Number(meta.t0 ?? 0);
  const logged: Accept[] = events.filter((e) => e.type === 'accept').map((e) => ({ t: e.t, phase: String(e.phase), index: Number(e.index), pos: Number(e.pos ?? -1) }));
  const lines: string[] = [];
  if (kind !== 'session') return { kind, logged, replayed: [], missing: [], extra: [], lines: ['(sound check recording: nothing to replay against)'] };

  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...(meta.settings as object) });
  const song = songById(String(meta.songId ?? 'star-spangled-banner'));
  const session = new Session(song, Number(meta.tonicMidi ?? song.defaultTonicMidi), settings);
  const startEv = events.find((e) => e.type === 'start');
  const mutes = events.filter((e) => e.type === 'mute').map((e) => ({ from: Number(e.from), to: Number(e.to) }));
  const actions = events.filter((e) => ['start', 'listenDone', 'replay', 'skip', 'pause', 'resume', 'end'].includes(e.type));
  let ai = 0;
  let started = false;
  let ended = false;
  let paused = false;
  let wasMuted = false;
  const sa = new StreamAnalyzer(sampleRate);
  const hop = Math.round((HOP_MS / 1000) * sampleRate);
  const replayed: Accept[] = [];
  let fed = 0;
  for (let off = 0; off + hop <= samples.length && !ended; off += hop) {
    sa.push(samples.subarray(off, off + hop));
    fed += hop;
    const t = t0 + fed / sampleRate;
    // the app's actions up to this moment
    while (ai < actions.length && actions[ai].t <= t + 1e-6) {
      const a = actions[ai++];
      if (a.type === 'start') {
        session.start(Number(a.startIndex ?? startEv?.startIndex ?? 0));
        started = true;
      } else if (a.type === 'listenDone') session.listenDone(a.t);
      else if (a.type === 'replay') session.replay();
      else if (a.type === 'skip') session.skip();
      else if (a.type === 'pause') paused = true;
      else if (a.type === 'resume') {
        paused = false;
        if (a.settings) session.setSettings(normalizeSettings(a.settings));
      } else if (a.type === 'end') ended = true;
    }
    if (fed < FRAME_SIZE || !started || ended) continue;
    // (frames are dropped while the app's own reference tone plays, and its attacks forgotten)
    if (mutes.some((m) => t >= m.from - 1e-6 && t < m.to - 1e-6)) {
      wasMuted = true;
      continue;
    }
    if (wasMuted) {
      sa.attacks.clear();
      wasMuted = false;
    }
    if (paused) continue;
    const before = session.view();
    const f = sa.frame(session.listeningPath(), t);
    if (session.pitch(f)) replayed.push({ t, phase: before.phase, index: before.index, pos: before.review?.pos ?? -1 });
  }

  const same = (a: Accept, b: Accept) => a.phase === b.phase && a.index === b.index && a.pos === b.pos && Math.abs(a.t - b.t) <= 0.25;
  const missing = logged.filter((a) => !replayed.some((b) => same(a, b)));
  const extra = replayed.filter((b) => !logged.some((a) => same(a, b)));
  const steps = [...new Set([...logged, ...replayed].map((a) => `${a.index}|${a.phase}|${a.pos}`))];
  for (const k of steps) {
    const [index, phase, pos] = k.split('|');
    const l = logged.find((a) => `${a.index}|${a.phase}|${a.pos}` === k);
    const r = replayed.find((a) => `${a.index}|${a.phase}|${a.pos}` === k);
    const ok = l && r && same(l, r);
    lines.push(`note ${Number(index) + 1} ${phase}${pos !== '-1' ? ` pos ${pos}` : ''}: app ${l ? `accepted at ${(l.t - t0).toFixed(2)} s` : '—'}, replay ${r ? `accepted at ${(r.t - t0).toFixed(2)} s` : '—'}${ok ? '' : '   <-- differs'}`);
  }
  return { kind, logged, replayed, missing, extra, lines };
}

if (process.argv[1]?.endsWith('replay.ts')) {
  const wav = process.argv[2];
  if (!wav) {
    console.error('usage: node scripts/replay.ts recording.wav [recording.json]');
    process.exit(2);
  }
  const jsonPath = process.argv[3] ?? wav.replace(/\.wav$/i, '.json');
  const r = replayRecording(new Uint8Array(readFileSync(wav)), readFileSync(jsonPath, 'utf8'));
  for (const l of r.lines) console.log(l);
  console.log(`\n${r.kind}: app accepted ${r.logged.length}, replay accepted ${r.replayed.length}; not reproduced ${r.missing.length}, extra ${r.extra.length}`);
  process.exit(r.missing.length || r.extra.length ? 1 : 0);
}
