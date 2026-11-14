// Ported from the fourth external review (read-only original), kept as a permanent test.
// Sing step in isolation (fresh analyzer, voice path, default settings unless noted).
import { StreamAnalyzer, singConfig, FRAME_SIZE } from '../../src/core/engine.ts';
import { NoteMatcher } from '../../src/core/matcher.ts';
import { wg, voice, babble, pinkGen, db2a } from './synth4.ts';
const sr = 48000; const hop = 960; const TARGETS = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67];
type Part = { buf: Float32Array; at: number };
function run(target: number, parts: Part[], dur: number, opts: { from?: number; strict?: boolean; carry?: number; tol?: number } = {}) {
  const len = Math.floor(dur * sr); const x = new Float32Array(len); const p = pinkGen(target + 1); const a = db2a(-62);
  for (const q of parts) { const o = Math.floor(q.at * sr); for (let i = 0; i < q.buf.length && o + i < len; i++) x[o + i] += q.buf[i]; }
  for (let i = 0; i < len; i++) x[i] += a * p();
  const sa = new StreamAnalyzer(sr); const m = new NoteMatcher({ ...singConfig(target, opts.tol ?? 50, false, opts.strict), carryMidi: opts.carry }); const hints = new Set<string>();
  for (let n = 0; n + hop <= len; n += hop) { sa.push(x.subarray(n, n + hop)); const t = (n + hop) / sr; if (n + hop < FRAME_SIZE || t < (opts.from ?? 0.3)) continue; const s = m.push(sa.frame('voice', t)); if (s.hint) hints.add(s.hint); if (s.accepted) return { acc: t, hints }; }
  return { acc: null, hints };
}
const fold = (m: number) => { while (m >= 55) m -= 12; while (m < 43) m += 12; return m; };
function table(name: string, expect: 'accept' | 'reject', f: (t: number) => { parts: Part[]; dur: number; opts?: Parameters<typeof run>[3]; t0?: number }) {
  let acc = 0, n = 0; const lat: number[] = []; const H: Record<string, number> = {};
  for (const t of TARGETS) { const s = f(t); n++; const r = run(t, s.parts, s.dur, s.opts); if (r.acc !== null) { acc++; lat.push((r.acc - (s.t0 ?? 0.8)) * 1000); } for (const h of r.hints) H[h] = (H[h] ?? 0) + 1; }
  lat.sort((a, b) => a - b);
  const ok = expect === 'accept' ? acc === n : acc === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${expect === 'accept' ? 'P' : 'N'} ${name.padEnd(70)} accepted ${acc}/${n}${lat.length ? ` med ${lat[lat.length >> 1].toFixed(0)} ms` : ''} ${JSON.stringify(H)}`);
}
const P = 0.8;
table('honest: plain sung note 2 s', 'accept', (t) => ({ parts: [{ buf: voice(fold(t), 2, { sr, seed: t }), at: P }], dur: 3.2 }));
for (const d of [0.35, 0.5, 0.65, 0.8]) table(`honest: short "la" ${d} s`, 'accept', (t) => ({ parts: [{ buf: voice(fold(t), d, { sr, seed: t, attackMs: 30, releaseMs: 50 }), at: P }], dur: 2.5 }));
table('honest: untrained wobble (drift ×5, jitter 1.5 %), 20 c flat', 'accept', (t) => ({ parts: [{ buf: voice(fold(t), 2.5, { sr, seed: t, drift: 25, jitter: 0.015, cents: -20 }), at: P }], dur: 3.6 }));
table('honest: wide vibrato ±70 c 5.8 Hz', 'accept', (t) => ({ parts: [{ buf: voice(fold(t), 2.5, { sr, seed: t, vibCents: 70, vibHz: 5.8 }), at: P }], dur: 3.6 }));
table('honest: slow vibrato ±50 c 3.5 Hz (wobble)', 'accept', (t) => ({ parts: [{ buf: voice(fold(t), 3, { sr, seed: t, vibCents: 50, vibHz: 3.5, vibOnset: 0.1 }), at: P }], dur: 4 }));
table('honest: starts 90 c flat, corrects over 0.9 s, holds 1.5 s', 'accept', (t) => ({ parts: [{ buf: voice(fold(t), 2.6, { sr, seed: t, scoop: -90, scoopMs: 900 }), at: P }], dur: 3.8 }));
table('honest: breathy quiet female (-40 dBFS, breath 0.5, oq 0.8)', 'accept', (t) => ({ parts: [{ buf: voice(fold(t) + 12, 2.5, { sr, seed: t, female: true, levelDb: -40, breath: 0.5, oq: 0.8, breathOnsetMs: 100 }), at: P }], dur: 3.6 }));
table('honest: fading singer (-8 dB/s)', 'accept', (t) => ({ parts: [{ buf: voice(fold(t), 2.5, { sr, seed: t, amp: (x) => Math.pow(10, (-8 * x) / 20) }), at: P }], dur: 3.6 }));
table('honest: sings over the previous guitar note still ringing (same pitch, repeated note)', 'accept', (t) => ({ parts: [{ buf: wg(t, 6, { sr, seed: t }), at: 0.1 }, { buf: voice(fold(t), 2.5, { sr, seed: t, jitter: 0.002, drift: 0.5, shimmer: 0.01 }), at: 2.2 }], dur: 5, opts: { from: 1.6, carry: t }, t0: 2.2 }));
table('honest: same, voice in the guitar\'s own octave and 15 c flat of the string', 'accept', (t) => ({ parts: [{ buf: wg(t, 6, { sr, seed: t }), at: 0.1 }, { buf: voice(t, 2.5, { sr, seed: t, female: t > 59, cents: -15 }), at: 2.2 }], dur: 5, opts: { from: 1.6, carry: t }, t0: 2.2 }));
table('WRONG: glissando through the target (300 c/s)', 'reject', (t) => ({ parts: [{ buf: voice(fold(t), 2.5, { sr, seed: t, track: (x) => -350 + 300 * x }), at: P }], dur: 3.6 }));
table('WRONG: sung a semitone flat (-100 c)', 'reject', (t) => ({ parts: [{ buf: voice(fold(t) - 1, 2.5, { sr, seed: t }), at: P }], dur: 3.6 }));
table('WRONG: sung 65 c sharp', 'reject', (t) => ({ parts: [{ buf: voice(fold(t), 2.5, { sr, seed: t, cents: 65 }), at: P }], dur: 3.6 }));
table('WRONG: sung a fifth above', 'reject', (t) => ({ parts: [{ buf: voice(fold(t + 7), 2.5, { sr, seed: t }), at: P }], dur: 3.6 }));
table('GUITAR instead of voice: target plucked during the sing step (default)', 'reject', (t) => ({ parts: [{ buf: wg(t, 3, { sr, seed: t }), at: P }], dur: 3.6 }));
table('GUITAR instead of voice: target plucked during the sing step (strict check on)', 'reject', (t) => ({ parts: [{ buf: wg(t, 3, { sr, seed: t }), at: P }], dur: 3.6, opts: { strict: true } }));
table('previous note (= target) still ringing, nobody sings', 'reject', (t) => ({ parts: [{ buf: wg(t, 7, { sr, seed: t }), at: 0.1 }], dur: 6, opts: { from: 1.6, carry: t } }));
table('previous note (= target) ringing, long sustain 2 dB/s', 'reject', (t) => ({ parts: [{ buf: wg(t, 9, { sr, seed: t, decay: 2, pol2: 0.8, beatCents: 3 }), at: 0.1 }], dur: 8, opts: { from: 1.6, carry: t } }));
table('OLDER note at the target pitch (two notes back) still ringing, previous note different', 'reject', (t) => ({ parts: [{ buf: wg(t, 9, { sr, seed: t, decay: 3 }), at: 0.1 }], dur: 8, opts: { from: 3.0, carry: t + 2 } }));
table('OLDER note an octave below the target still ringing (open bass string)', 'reject', (t) => ({ parts: [{ buf: wg(t - 12, 9, { sr, seed: t, decay: 3, string: 0 }), at: 0.1 }], dur: 8, opts: { from: 3.0, carry: t + 2 } }));
{ let fa = 0; const mins = (TARGETS.length * 30) / 60; for (const t of TARGETS) { for (let k = 0; k < 3; k++) { const b = babble(10, { sr, seed: t * 3 + k, female: k === 1, levelDb: -30 }); const r = run(t, [{ buf: b, at: 0.2 }], 10.2); if (r.acc !== null) fa++; } } console.log(`     N TV/talk only (babble -30 dBFS), 10 s windows: sing step falsely passed in ${fa}/${TARGETS.length * 3} windows (${(fa / mins).toFixed(2)} per minute of talk)`); }
