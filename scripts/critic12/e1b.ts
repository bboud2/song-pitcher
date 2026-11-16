// @ts-nocheck (ported review tooling, kept as written)
// Twelfth review (ported unchanged except for where it finds the build; it writes to ./out of the
// directory it is run from).
// E1b: sing-along singers (start during the reference, hold steady) by how far under the reference they are.
import { Rig, honest, MAN, U, med } from './rig.ts';
import { appendFileSync } from 'node:fs';
const B = process.env.BUILD_DIR!.slice(-1); const REFLEN = 1.57;
const rooms = (process.argv[2] ?? 'dry,carpet,living').split(',');
for (const room of rooms) for (const [ref, vDb] of [[-10, -20], [-10, -28], [-10, -34], [-10, -40], [-20, -40], [-20, -46], [-30, -46]]) for (const when of ['along', 'with']) {
  const rig = new Rig({ room, seed: 5, ref }); rig.begin();
  const res = honest(rig, { seed: 4, vDb, spread: 1, hold: 4.2, noPlay: true, v: { cons: '', riseMs: 120 }, singDelay: when === 'along' ? (r) => -REFLEN + U(r, 0.3, 0.9) : (r) => -REFLEN + U(r, 0, 0.24) }, 0, 19);
  const late = res.sing.lat.filter((x) => x > 1.0).length;
  const line = { build: B, room, ref, vDb, when, first: res.sing.first, n: res.sing.n, stuck: res.sing.stuck, heldOver1s: late, med: Math.round(1000 * med(res.sing.lat)), max: Math.round(1000 * Math.max(...res.sing.lat)), hints: res.hints };
  console.log(JSON.stringify(line)); appendFileSync(`out/e1b_${B}.jsonl`, JSON.stringify(line) + '\n');
}
