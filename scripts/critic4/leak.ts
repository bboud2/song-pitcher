// Ported from the fourth external review (read-only original), kept as a permanent test.
// With meters off the UI still shows hints 'tooShort' (sing) and 'sustained' (guitar). Do they depend on the pitch being right?
import { StreamAnalyzer, guitarConfig, singConfig, FRAME_SIZE } from '../../src/core/engine.ts';
import { NoteMatcher } from '../../src/core/matcher.ts';
import { voice, pinkGen, db2a } from './synth4.ts';
const sr = 48000; const hop = 960;
function hints(cfg: ConstructorParameters<typeof NoteMatcher>[0], buf: Float32Array, path: 'voice' | 'guitar') {
  const len = Math.floor(3.5 * sr); const x = new Float32Array(len); const p = pinkGen(11); const a = db2a(-62); x.set(buf.subarray(0, Math.min(buf.length, len - sr)), Math.floor(0.8 * sr)); for (let i = 0; i < len; i++) x[i] += a * p();
  const sa = new StreamAnalyzer(sr); const m = new NoteMatcher(cfg); const H = new Set<string>();
  for (let n = 0; n + hop <= len; n += hop) { sa.push(x.subarray(n, n + hop)); const t = (n + hop) / sr; if (n + hop < FRAME_SIZE || t < 0.3) continue; const s = m.push(sa.frame(path, t)); if (s.hint) H.add(s.hint); if (s.accepted) H.add('ACCEPTED'); }
  return [...H].join(',') || '(none)';
}
let onS = 0, offS = 0, onH = 0, offH = 0; const N = 12;
for (let t = 48; t < 60; t++) {
  if (hints(singConfig(t, 50, false), voice(t - 0, 0.3, { sr, seed: t, attackMs: 25, releaseMs: 40 }), 'voice').includes('tooShort')) onS++;
  if (hints(singConfig(t, 50, false), voice(t + 3, 0.3, { sr, seed: t, attackMs: 25, releaseMs: 40 }), 'voice').includes('tooShort')) offS++;
  if (hints(guitarConfig(t), voice(t, 2, { sr, seed: t, vowel: 'm' }), 'guitar').includes('sustained')) onH++;
  if (hints(guitarConfig(t), voice(t + 3, 2, { sr, seed: t, vowel: 'm' }), 'guitar').includes('sustained')) offH++;
}
console.log(`sing step, 0.3 s note: hint "Hold the note a little longer" shown — on pitch ${onS}/${N}, 3 st off ${offS}/${N}`);
console.log(`guitar step, flat hum: hint "That sounded like humming" shown — on pitch ${onH}/${N}, 3 st off ${offH}/${N}`);
