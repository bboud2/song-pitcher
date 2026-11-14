// Ported from the fourth external review (read-only original), kept as a permanent test.
// Poorly fretted / short / muted notes in the guitar step (default settings), fresh matcher, quiet room.
import { StreamAnalyzer, guitarConfig, FRAME_SIZE } from '../../src/core/engine.ts';
import { NoteMatcher } from '../../src/core/matcher.ts';
import { wg, pinkGen, db2a, type WOpts } from './synth4.ts';
const sr = 48000; const hop = 960; const TARGETS = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67];
function run(target: number, buf: Float32Array, humGuard = true) {
  const len = Math.floor(3.2 * sr); const x = new Float32Array(len); const p = pinkGen(target + 3); const a = db2a(-62);
  x.set(buf.subarray(0, Math.min(buf.length, len - Math.floor(0.8 * sr))), Math.floor(0.8 * sr)); for (let i = 0; i < len; i++) x[i] += a * p();
  const sa = new StreamAnalyzer(sr); const m = new NoteMatcher({ ...guitarConfig(target), needPluck: humGuard }); const hints = new Set<string>();
  for (let n = 0; n + hop <= len; n += hop) { sa.push(x.subarray(n, n + hop)); const t = (n + hop) / sr; if (n + hop < FRAME_SIZE || t < 0.3) continue; const s = m.push(sa.frame('guitar', t)); if (s.hint) hints.add(s.hint); if (s.accepted) return { acc: (t - 0.8) * 1000, hints }; }
  return { acc: null, hints };
}
function row(name: string, mk: (t: number) => Float32Array) {
  let a = 0, b = 0; const la: number[] = [], lb: number[] = []; const H: Record<string, number> = {};
  for (const t of TARGETS) { const buf = mk(t); const r = run(t, buf); if (r.acc !== null) { a++; la.push(r.acc); } for (const h of r.hints) H[h] = (H[h] ?? 0) + 1; const r2 = run(t, buf, false); if (r2.acc !== null) { b++; lb.push(r2.acc); } }
  const med = (x: number[]) => (x.length ? [...x].sort((p, q) => p - q)[x.length >> 1].toFixed(0) : '-');
  console.log(`${name.padEnd(58)} default ${a}/12 (med ${med(la)} ms)   hum guard off ${b}/12 (med ${med(lb)} ms)   hints ${JSON.stringify(H)}`);
}
const cut = (b: Float32Array, at: number, fade = 0.03) => { const o = Float32Array.from(b); const s = Math.floor(at * sr), f = Math.floor(fade * sr); for (let i = s; i < o.length; i++) o[i] *= Math.max(0, 1 - (i - s) / f); return o; };
const G = (t: number, o: Partial<WOpts> = {}) => wg(t, 2.4, { sr, seed: t, ...o });
row('normal pluck', (t) => G(t));
for (const d of [30, 60, 100]) row(`poorly fretted, dies at ${d} dB/s`, (t) => G(t, { decay: d }));
for (const at of [0.12, 0.18, 0.25, 0.35, 0.5]) row(`staccato: string damped ${at * 1000} ms after the pluck`, (t) => cut(G(t), at));
row('very soft (-44 dBFS peak, 18 dB above room)', (t) => G(t, { peakDb: -44, hard: 0.1 }));
row('soft thumb, slow 30 ms attack, -36 dBFS', (t) => G(t, { peakDb: -36, hard: 0, attackMs: 30, pick: 0.3 }));
row('fret buzz-like bright bridge pick', (t) => G(t, { hard: 1, pick: 0.06 }));
row('nylon, flesh, -30 dBFS', (t) => G(t, { kind: 'nylon', hard: 0.1, peakDb: -30 }));
row('two unison strings 8 c apart (12-string / fretted+open)', (t) => { const a = G(t), b = G(t, { cents: 8, seed: t + 9 }); for (let i = 0; i < a.length; i++) a[i] += b[i]; return a; });
row('two unison strings 25 c apart (badly tuned course)', (t) => { const a = G(t), b = G(t, { cents: 25, seed: t + 9 }); for (let i = 0; i < a.length; i++) a[i] += b[i]; return a; });
row('strong second polarisation, 5 Hz beat', (t) => G(t, { pol2: 1, beatCents: 1200 * Math.log2(1 + 5 / (440 * Math.pow(2, (t - 69) / 12))) }));
