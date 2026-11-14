// Ported from the fourth external review (read-only original), kept as a permanent test.
// Default hum guard vs realistic hums/sung syllables at the target (exact octave), guitar step, fresh matcher.
import { StreamAnalyzer, guitarConfig, FRAME_SIZE } from '../../src/core/engine.ts';
import { NoteMatcher } from '../../src/core/matcher.ts';
import { voice, pinkGen, db2a, type VOpts } from './synth4.ts';
const sr = 48000; const hop = 960; const TARGETS = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67];
function run(target: number, buf: Float32Array, strict = false) {
  const len = Math.floor(3.4 * sr); const x = new Float32Array(len); const p = pinkGen(target + 7); const a = db2a(-62);
  x.set(buf.subarray(0, Math.min(buf.length, len - Math.floor(0.8 * sr))), Math.floor(0.8 * sr)); for (let i = 0; i < len; i++) x[i] += a * p();
  const sa = new StreamAnalyzer(sr); const m = new NoteMatcher(guitarConfig(target, strict)); 
  for (let n = 0; n + hop <= len; n += hop) { sa.push(x.subarray(n, n + hop)); const t = (n + hop) / sr; if (n + hop < FRAME_SIZE || t < 0.3) continue; if (m.push(sa.frame('guitar', t)).accepted) return true; }
  return false;
}
function row(name: string, o: (t: number, k: number) => Partial<VOpts>) {
  let acc = 0, accS = 0, n = 0;
  for (const t of TARGETS) for (let k = 0; k < 3; k++) { const b = voice(t, 1.5, { sr, seed: t * 5 + k, female: t >= 57, levelDb: -24, ...o(t, k) }); n++; if (run(t, b)) acc++; if (run(t, b, true)) accS++; }
  console.log(`${name.padEnd(64)} passes the guitar step ${acc}/${n} (default)   ${accS}/${n} (strict check)`);
}
row('flat hum "mm", soft 70 ms onset', () => ({ vowel: 'm' }));
for (const a of [0.5, 1, 2, 3, 5]) row(`hum "hm" with a ${a} dB onset accent (relaxes in 120 ms)`, () => ({ vowel: 'm', amp: (t) => 1 + (Math.pow(10, a / 20) - 1) * Math.exp(-t / 0.12) }));
row('hum fading out (-4 dB/s)', () => ({ vowel: 'm', amp: (t) => Math.pow(10, (-4 * t) / 20) }));
row('hum fading out (-10 dB/s)', () => ({ vowel: 'm', amp: (t) => Math.pow(10, (-10 * t) / 20) }));
row('sung "la" (25 ms onset, 3 dB accent)', () => ({ vowel: 'a', attackMs: 25, amp: (t) => 1 + 0.41 * Math.exp(-t / 0.1) }));
row('sung "doo" short 0.4 s', () => ({ vowel: 'u', attackMs: 20, amp: (t) => (t < 0.3 ? 1 + 0.3 * Math.exp(-t / 0.1) : Math.max(0, 1 - (t - 0.3) / 0.1)) }));
row('sung "ah" steady, plain 70 ms onset', () => ({ vowel: 'a' }));
row('whistle-like (oq 0.9, no breath) with 2 dB accent', () => ({ vowel: 'u', oq: 0.9, amp: (t) => 1 + 0.26 * Math.exp(-t / 0.12) }));
