// @ts-nocheck (ported review tooling, kept as written)
// Twelfth review (ported unchanged except for where it finds the build; it writes to ./out of the
// directory it is run from).
// A sing-along singer who simply keeps holding the note (10 s): how long until the step lets them through?
import { Rig, honest, MAN, U, med, MIDIS } from './rig.ts';
const B = process.env.BUILD_DIR!.slice(-1);
for (const [room, ref, vDb] of [['dry', -10, -32], ['living', -10, -38], ['dry', -20, -42]] as any) { const waits: number[] = []; let never = 0; const hints: Record<string, number> = {};
  for (const i of [0, 3, 6, 9, 14, 18, 22, 27]) { const rig = new Rig({ room, seed: i, ref, from: i }); rig.begin(); let r0: any = null; rig.onRef = (a, b) => (r0 = { a, b }); rig.run(rig.t + 8, () => r0 !== null);
    rig.sing({ midi: MAN(MIDIS[i]), dur: 12, seed: 30 + i, vowel: 'o', riseMs: 150 }, r0.a + 0.4, vDb); rig.expect = { phase: 'sing', index: i, pos: -1, from: r0.a }; rig.run(r0.b + 10.2, () => rig.phase() === 'play');
    if (rig.phase() === 'play') waits.push(rig.t - r0.b); else never++; for (const h of new Set(rig.hintLog.map((x) => x.hint))) hints[h] = (hints[h] ?? 0) + 1; }
  console.log(JSON.stringify({ build: B, room, ref, vDb, passedAfterSec: waits.map((x) => +x.toFixed(1)), neverIn10s: never, hints })); }
