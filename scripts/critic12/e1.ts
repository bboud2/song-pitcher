// @ts-nocheck (ported review tooling, kept as written)
// Twelfth review (ported unchanged except for where it finds the build; it writes to ./out of the
// directory it is run from).
// E1: honest singers at the edges of the "has anything new started" guard. 25 notes each (0..24).
import { Rig, honest, fmt, MAN, WOMAN, CHILD, BASS, U, MIDIS } from './rig.ts';
import { appendFileSync } from 'node:fs';
const B = process.env.BUILD_DIR!.slice(-1); const only = process.argv[2] ? new RegExp(process.argv[2]) : null; const rooms = (process.argv[3] ?? 'living,hallway').split(',');
const REFLEN = 0.9 + 0.65 + 0.02; // ref start -> step open
const glide = (rig, i, tg, ref, r, vo) => { if (i === 0) return null; const prev = MAN(MIDIS[i - 1]), cur = MAN(tg); const t0 = ref.a - 0.45; const g0 = ref.a + U(r, 0.25, 0.5) - t0; const dur = ref.b + 2.4 - t0; const o = { midi: prev, dur, vowel: 'm', riseMs: 120, scoop: 0, traj: [[0, prev], [g0, prev], [g0 + 0.25, cur], [dur, cur]], seed: 77 + i }; return { ev: rig.sing(o, t0, -27, false), onset: t0 + g0 + 0.25, dur: dur - g0 - 0.25 + (t0 + g0 + 0.25 - (t0 + g0 + 0.25)) }; };
const C: Record<string, [any, any]> = {
  base: [{ ref: -18 }, {}],
  softSlow_fan: [{ ref: -18, beds: [['fan', -46]] }, { vDb: -33, v: { riseMs: 900, cons: '', scoop: 10 }, spread: 1 }],
  softSlow_quiet: [{ ref: -18 }, { vDb: -36, v: { riseMs: 1200, cons: '', scoop: 10 }, spread: 1 }],
  startInFirst250: [{ ref: -18 }, { singDelay: (r) => -REFLEN + U(r, 0.02, 0.24), hold: 4.2 }],
  startExactlyWith: [{ ref: -18 }, { singDelay: () => -REFLEN, hold: 4.2 }],
  startDuringRef: [{ ref: -18 }, { singDelay: (r) => -REFLEN + U(r, 0.3, 0.9), hold: 4 }],
  startDuringRef_soft: [{ ref: -18 }, { singDelay: (r) => -REFLEN + U(r, 0.3, 0.9), hold: 4, v: { riseMs: 400, cons: '' } }],
  startInTail: [{ ref: -18 }, { singDelay: (r) => U(r, -0.6, -0.05), hold: 3.2 }],
  glideFromPrev: [{ ref: -18 }, { singEv: glide }],
  quiet_vs_loudRef_late: [{ ref: -8 }, { vDb: -38, spread: 1 }],
  quiet_vs_loudRef_during: [{ ref: -8 }, { vDb: -36, spread: 1, singDelay: (r) => -REFLEN + U(r, 0.3, 0.9), hold: 4 }],
  quiet_vs_loudRef_with: [{ ref: -8 }, { vDb: -36, spread: 1, singDelay: (r) => -REFLEN + U(r, 0.0, 0.24), hold: 4.2 }],
  mid_vs_loudRef_during_soft: [{ ref: -10 }, { vDb: -30, spread: 1, singDelay: (r) => -REFLEN + U(r, 0.3, 0.9), hold: 4, v: { riseMs: 400, cons: '' } }],
  noisy_fan: [{ ref: -18, beds: [['fan', -40]] }, { vDb: -27 }],
  noisy_traffic: [{ ref: -18, beds: [['traffic', -36]] }, { vDb: -27 }],
  noisy_tv: [{ ref: -18, beds: [['tv', -38]] }, { vDb: -25 }],
  woman: [{ ref: -18 }, { oct: WOMAN, v: { sex: 'f' } }],
  child: [{ ref: -18 }, { oct: CHILD, v: { sex: 'c' } }],
  bass: [{ ref: -18 }, { oct: BASS }],
  headphones: [{ ref: null }, {}],
  headphones_early: [{ ref: null }, { singDelay: (r) => -REFLEN + U(r, 0.2, 1.2), hold: 4 }],
  lowVolume: [{ ref: -42 }, {}],
  lowVolume_early: [{ ref: -42 }, { singDelay: (r) => -REFLEN + U(r, 0.2, 1.2), hold: 4 }],
  agcSlow: [{ ref: -14, agc: 'slow' }, {}],
  agcFast: [{ ref: -14, agc: 'fast' }, {}],
  agcFast_during: [{ ref: -14, agc: 'fast' }, { singDelay: (r) => -REFLEN + U(r, 0.3, 0.9), hold: 4 }],
  agcSlow_softSlow: [{ ref: -14, agc: 'slow' }, { vDb: -32, v: { riseMs: 800, cons: '' } }],
  latency150: [{ ref: -18, lat: 0.15 }, {}],
  latency150_during: [{ ref: -18, lat: 0.15 }, { singDelay: (r) => -REFLEN + U(r, 0.3, 0.9), hold: 4 }],
  fadeEarly: [{ ref: -18 }, { singDelay: (r) => U(r, -0.9, -0.2), hold: 3.6, v: { fade: 6 } }],
  fadeEarlyFast: [{ ref: -18 }, { singDelay: (r) => U(r, -0.9, -0.2), hold: 3.6, v: { fade: 12 } }],
};
for (const [name, [env, st]] of Object.entries(C)) {
  if (only && !only.test(name)) continue;
  for (const room of rooms) {
    const rig = new Rig({ room, seed: 5, ...env }); rig.begin();
    const res = honest(rig, { seed: 4, ...st }, 0, 24);
    const line = { build: B, name, room, sing: [res.sing.first, res.sing.n, res.sing.stuck], singLat: [Math.round(1000 * (res.sing.lat.sort((a, b) => a - b)[res.sing.lat.length >> 1] ?? NaN))], play: [res.play.first, res.play.n, res.play.stuck], rev: [res.rev.first, res.rev.n, res.rev.stuck], acc: res.acc.map((a) => `${a.phase}@${a.index}.${a.pos}`), stuckAt: res.stuckAt, hints: res.hints };
    console.log(JSON.stringify(line)); appendFileSync(`out/e1_${B}.jsonl`, JSON.stringify(line) + '\n');
  }
}
