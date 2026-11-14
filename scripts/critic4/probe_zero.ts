// Ported from the fourth external review (read-only original), kept as a permanent test.
// Does one digitally-silent frame (mic not yet delivering / gated mic) disable noise learning for good?
import { StreamAnalyzer } from '../../src/core/engine.ts';
import { pinkGen, db2a, rng } from './synth4.ts';
const sr = 48000; const hop = 960;
for (const [label, zeroAt, zeroLen] of [['no zeros', -1, 0], ['zeros for the first 0.2 s', 0, 0.2], ['zeros 0.1 s at t=3 s (gate/dropout)', 3, 0.1]] as const) {
  const sa = new StreamAnalyzer(sr); const p = pinkGen(3); const r = rng(5); let l1 = 0, l2 = 0; const out: string[] = [];
  for (let n = 0; n < 60 * sr; n += hop) {
    const x = new Float32Array(hop); const t = n / sr;
    const zero = zeroAt >= 0 && t >= zeroAt && t < zeroAt + zeroLen;
    if (!zero) for (let i = 0; i < hop; i++) { const w = r() * 2 - 1; l1 += 0.03 * (w - l1); l2 += 0.03 * (l1 - l2); x[i] = db2a(-62) * p() + db2a(-46) * (11 * l2 + 0.5 * Math.sin(2 * Math.PI * 118 * (n + i) / sr)); }
    sa.push(x); if (n < 2048) continue;
    const f = sa.frame('guitar', (n + hop) / sr);
    if ([1, 2, 5, 10, 30, 59].includes(Math.round(t * 50) / 50)) out.push(`t=${t.toFixed(0)}s raw ${(20 * Math.log10(f.rms + 1e-12)).toFixed(1)} clean ${(20 * Math.log10((f.cleanRms ?? 0) + 1e-12)).toFixed(1)}`);
  }
  console.log(label.padEnd(40), out.join(' | '));
}
