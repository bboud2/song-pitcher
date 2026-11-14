// Ported from the fourth external review (read-only original), kept as a permanent test.
// Late fretting (beginner): the pick hits the string before the finger is down: open-string pitch first, then the fretted target.
import { StreamAnalyzer, guitarConfig, FRAME_SIZE } from '../../src/core/engine.ts';
import { NoteMatcher } from '../../src/core/matcher.ts';
import { wg, pinkGen, db2a, stringFor } from './synth4.ts';
const sr = 48000; const hop = 960; const P = 0.8;
const TARGETS = [48, 50, 52, 53, 57, 60, 62, 65, 67]; // all fretted notes of the song range (frets 1-3)
function run(target: number, buf: Float32Array, replAt?: number, repl?: Float32Array) {
  const len = Math.floor((P + 3.2) * sr); const x = new Float32Array(len); const p = pinkGen(target); const a = db2a(-62);
  x.set(buf.subarray(0, Math.min(buf.length, replAt ? Math.floor(replAt * sr) : buf.length)), Math.floor(P * sr));
  if (repl && replAt) for (let i = 0; i < repl.length && Math.floor((P + replAt) * sr) + i < len; i++) x[Math.floor((P + replAt) * sr) + i] += repl[i];
  for (let i = 0; i < len; i++) x[i] += a * p();
  const sa = new StreamAnalyzer(sr); const m = new NoteMatcher(guitarConfig(target)); const hints = new Set<string>();
  for (let n = 0; n + hop <= len; n += hop) { sa.push(x.subarray(n, n + hop)); const t = (n + hop) / sr; if (n + hop < FRAME_SIZE || t < 0.3) continue; const s = m.push(sa.frame('guitar', t)); if (s.hint) hints.add(s.hint); if (s.accepted) return { acc: t - P, hints }; }
  return { acc: null, hints };
}
for (const late of [0, 30, 60, 90, 120, 150, 200]) {
  let first = 0, second = 0, n = 0; const lat: number[] = []; const H: Record<string, number> = {};
  for (const t of TARGETS) { const fret = stringFor(t).fret; if (fret < 1) continue; n++;
    const b = wg(t, 3, { sr, seed: t, glide: 0, track: (x) => (x < late / 1000 ? -100 * fret : x < late / 1000 + 0.008 ? -100 * fret * (1 - (x - late / 1000) / 0.008) : 0), bumps: late ? [{ t: late / 1000, amp: 0.12 }] : [] });
    const r = run(t, b); if (r.acc !== null) { first++; lat.push(r.acc * 1000); } else { const r2 = run(t, b, 1.6, wg(t, 1.6, { sr, seed: t + 1 })); if (r2.acc !== null && r2.acc > 1.6) second++; } for (const h of r.hints) H[h] = (H[h] ?? 0) + 1; }
  lat.sort((a, b) => a - b);
  console.log(`finger lands ${String(late).padStart(3)} ms after the pick: first pluck accepted ${first}/${n}${lat.length ? ` (median ${lat[lat.length >> 1].toFixed(0)} ms)` : ''}, of the rest a clean re-pluck at 1.6 s accepted ${second}/${n - first}; hints ${JSON.stringify(H)}`);
}
