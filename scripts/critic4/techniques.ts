// Ported from the fourth external review (read-only original), kept as a permanent test.
// Claim 2/3: wrong fret / technique tests, isolated matcher (fresh analyzer, 0.8 s of room first).
import { StreamAnalyzer, guitarConfig, FRAME_SIZE } from '../../src/core/engine.ts';
import { NoteMatcher } from '../../src/core/matcher.ts';
import { wg, sympathetic, pinkGen, db2a, stringFor, OPEN, type WOpts } from './synth4.ts';
const sr = 48000; const hop = 960;
const TARGETS = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67];
type Stim = { parts: { buf: Float32Array; at: number; stopAt?: number }[]; matchFrom?: number; pluckAt: number };
function run(target: number, st: Stim, review = false): { acc: number | null; hints: Set<string>; cents: number | null } {
  const len = Math.floor((st.pluckAt + 2.6) * sr); const x = new Float32Array(len); const p = pinkGen(target); const a = db2a(-62);
  for (const q of st.parts) { const o = Math.floor(q.at * sr); const stop = q.stopAt !== undefined ? Math.floor(q.stopAt * sr) : Infinity; for (let i = 0; i < q.buf.length && o + i < len; i++) { const g = o + i < stop ? 1 : Math.max(0, 1 - (o + i - stop) / (0.03 * sr)); x[o + i] += g * q.buf[i]; } }
  for (let i = 0; i < len; i++) x[i] += a * p();
  const sa = new StreamAnalyzer(sr); const m = new NoteMatcher(guitarConfig(target, false, review)); let acc: number | null = null; const hints = new Set<string>(); let cents: number | null = null;
  for (let n = 0; n + hop <= len; n += hop) { sa.push(x.subarray(n, n + hop)); const t = (n + hop) / sr; if (n + hop < FRAME_SIZE) continue; const f = sa.frame('guitar', t); if (t < (st.matchFrom ?? 0.3)) continue; const s = m.push(f); if (s.hint) hints.add(s.hint); if (s.accepted) { acc = t - st.pluckAt; cents = s.cents; break; } }
  return { acc, hints, cents };
}
const G = (m: number, o: Partial<WOpts> = {}, dur = 2.6) => wg(m, dur, { sr, seed: m, ...o });
const rows: string[] = [];
function table(name: string, expect: 'accept' | 'reject', mk: (t: number) => Stim | null) {
  let n = 0, acc = 0; const lat: number[] = []; const hints: Record<string, number> = {}; const bad: number[] = [];
  for (const t of TARGETS) { const st = mk(t); if (!st) continue; n++; const r = run(t, st); if (r.acc !== null) { acc++; lat.push(r.acc * 1000); } for (const h of r.hints) hints[h] = (hints[h] ?? 0) + 1; if ((r.acc !== null) !== (expect === 'accept')) bad.push(t); }
  lat.sort((a, b) => a - b);
  const ok = expect === 'accept' ? acc === n : acc === 0;
  rows.push(`${ok ? 'ok  ' : 'FAIL'} ${expect === 'accept' ? 'P' : 'N'} ${name.padEnd(62)} accepted ${acc}/${n}${lat.length ? ` med ${lat[lat.length >> 1].toFixed(0)} ms` : ''} hints ${JSON.stringify(hints)}${bad.length ? ` bad targets ${bad.join(',')}` : ''}`);
  console.log(rows[rows.length - 1]);
}
const P = 0.8;
// ---- honest
for (const hard of [0.15, 0.9]) for (const d of [0, 15, -15, 30, -30, 40, -40]) table(`right fret, string ${d >= 0 ? '+' : ''}${d} c, pick hardness ${hard}`, 'accept', (t) => ({ pluckAt: P, parts: [{ buf: G(t, { cents: d, hard }), at: P }] }));
table('hammer-on from fret below (pluck T-1, hammer T at 180 ms)', 'accept', (t) => stringFor(t).fret < 1 ? null : ({ pluckAt: P, parts: [{ buf: G(t, { track: (x) => (x < 0.18 ? -100 : 0), bumps: [{ t: 0.18, amp: 0.25 }], glide: 0 }), at: P }] }));
table('hammer-on from 2 frets below (at 180 ms)', 'accept', (t) => stringFor(t).fret < 2 ? null : ({ pluckAt: P, parts: [{ buf: G(t, { track: (x) => (x < 0.18 ? -200 : 0), bumps: [{ t: 0.18, amp: 0.25 }], glide: 0 }), at: P }] }));
table('pull-off from 2 frets above (at 200 ms)', 'accept', (t) => ({ pluckAt: P, parts: [{ buf: G(t, { track: (x) => (x < 0.2 ? 200 : 0), bumps: [{ t: 0.2, amp: 0.15 }], glide: 0 }), at: P }] }));
table('slide up from fret below over 90 ms starting at 150 ms', 'accept', (t) => stringFor(t).fret < 1 ? null : ({ pluckAt: P, parts: [{ buf: G(t, { track: (x) => (x < 0.15 ? -100 : x < 0.24 ? -100 + (100 * (x - 0.15)) / 0.09 : 0), glide: 0 }), at: P }] }));
table('bend up a semitone to the target over 350 ms, hold', 'accept', (t) => ({ pluckAt: P, parts: [{ buf: G(t, { track: (x) => (x < 0.1 ? -100 : x < 0.45 ? -100 + (100 * (x - 0.1)) / 0.35 : 0), glide: 0 }), at: P }] }));
table('finger vibrato ±15 c 5.5 Hz on the right fret', 'accept', (t) => ({ pluckAt: P, parts: [{ buf: G(t, { track: (x) => (x > 0.1 ? 15 * Math.sin(2 * Math.PI * 5.5 * x) : 0) }), at: P }] }));
table('finger vibrato ±30 c 5 Hz on the right fret', 'accept', (t) => ({ pluckAt: P, parts: [{ buf: G(t, { track: (x) => (x > 0.1 ? 30 * Math.sin(2 * Math.PI * 5 * x) : 0) }), at: P }] }));
table('pressing-hard sharpening: +25 c at pluck relaxing to +5 over 0.6 s', 'accept', (t) => ({ pluckAt: P, parts: [{ buf: G(t, { track: (x) => 5 + 20 * Math.exp(-x / 0.25) }), at: P }] }));
table('right note with the open string an octave/fifth below ringing sympathetically (physical coupling)', 'accept', (t) => { const b = G(t); const os = OPEN.find((o) => [12, 19, 24].includes(t - o)); if (os === undefined) return null; return { pluckAt: P, parts: [{ buf: b, at: P }, { buf: sympathetic(b, sr, os, 0, 0.02), at: P }] }; });
// ---- wrong: must not accept
for (const hard of [0.15, 0.9]) for (const d of [20, 30, 40, 45, 50]) {
  table(`WRONG fret below, string +${d} c (sounds ${d - 100} c), hardness ${hard}`, 'reject', (t) => stringFor(t).fret < 1 ? null : ({ pluckAt: P, parts: [{ buf: G(t - 1, { cents: d, hard, string: stringFor(t).s }), at: P }] }));
  table(`WRONG fret above, string -${d} c (sounds +${100 - d} c), hardness ${hard}`, 'reject', (t) => ({ pluckAt: P, parts: [{ buf: G(t + 1, { cents: -d, hard, string: stringFor(t).s }), at: P }] }));
}
table('WRONG: fret below, pressing hard (+35 c at pluck relaxing to +10)', 'reject', (t) => stringFor(t).fret < 1 ? null : ({ pluckAt: P, parts: [{ buf: G(t - 1, { track: (x) => 10 + 25 * Math.exp(-x / 0.3), string: stringFor(t).s }), at: P }] }));
table('WRONG: fret below with ±40 c vibrato', 'reject', (t) => ({ pluckAt: P, parts: [{ buf: G(t - 1, { track: (x) => (x > 0.1 ? 40 * Math.sin(2 * Math.PI * 5 * x) : 0) }), at: P }] }));
table('WRONG: slide passing through the target (T-2 → T+2 over 400 ms)', 'reject', (t) => ({ pluckAt: P, parts: [{ buf: G(t, { track: (x) => (x < 0.1 ? -200 : x < 0.5 ? -200 + (400 * (x - 0.1)) / 0.4 : 200), glide: 0 }), at: P }] }));
table('WRONG: slide T-1 → T+1 over 300 ms (lingers near T ~100 ms)', 'reject', (t) => ({ pluckAt: P, parts: [{ buf: G(t, { track: (x) => (x < 0.1 ? -100 : x < 0.4 ? -100 + (200 * (x - 0.1)) / 0.3 : 100), glide: 0 }), at: P }] }));
table('WRONG: bend from fret below that stops 55 c short of the target', 'reject', (t) => ({ pluckAt: P, parts: [{ buf: G(t, { track: (x) => (x < 0.1 ? -100 : x < 0.45 ? -100 + (45 * (x - 0.1)) / 0.35 : -55), glide: 0 }), at: P }] }));
table('WRONG: hammer-on T → T+1 after 120 ms', 'reject', (t) => ({ pluckAt: P, parts: [{ buf: G(t, { track: (x) => (x < 0.12 ? 0 : 100), bumps: [{ t: 0.12, amp: 0.25 }], glide: 0 }), at: P }] }));
for (const w of [-1, 1, -2, 2, 5, -5, 7, -7, 12, -12]) table(`WRONG ${w > 0 ? '+' : ''}${w} st plucked while the target pitch still rings on another string (-12 dB)`, 'reject', (t) => { if (t + w < 45 || t + w > 72) return null; const ring = G(t, { peakDb: -26, string: Math.max(0, stringFor(t).s - 1) }, 4); return { pluckAt: 1.6, matchFrom: 1.0, parts: [{ buf: ring, at: 0.4 }, { buf: G(t + w), at: 1.6 }] }; });
for (const w of [-12, -5, 7]) table(`WRONG ${w} st plucked, damped after 0.5 s, target pitch left ringing sympathetically on an open string`, 'reject', (t) => { if (!OPEN.includes(t) || t + w < 40) return null; const b = G(t + w); return { pluckAt: P, parts: [{ buf: b, at: P, stopAt: P + 0.5 }, { buf: sympathetic(b, sr, t, 0, 0.05), at: P }] }; });
for (const w of [12, -12, 7, -7, 19]) table(`WRONG octave/fifth ${w > 0 ? '+' : ''}${w} st alone`, 'reject', (t) => (t + w < 40 || t + w > 76 ? null : { pluckAt: P, parts: [{ buf: G(t + w), at: P }] }));
console.log('\nFAILS:\n' + rows.filter((r) => r.startsWith('FAIL')).join('\n'));
