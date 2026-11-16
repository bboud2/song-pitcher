// @ts-nocheck (ported review tooling, kept as written)
// Twelfth review (ported unchanged except for where it finds the build; it writes to ./out of the
// directory it is run from).
// E3: full 101-note sessions.
import { Rig, honest, fmt, MAN, WOMAN, CHILD, BASS, U, med } from './rig.ts';
import { appendFileSync } from 'node:fs';
const B = process.env.BUILD_DIR!.slice(-1); const only = process.argv[2] ? new RegExp(process.argv[2]) : null; const TO = +(process.env.TO ?? 100);
const S: Record<string, [any, any]> = {
  s1_living_man_steelPick: [{ room: 'living', ref: -18 }, { oct: MAN }],
  s2_bare_woman_nylonFinger_agc: [{ room: 'bare', ref: -14, agc: 'slow' }, { oct: WOMAN, v: { sex: 'f' }, g: { type: 'nylon', touch: 'finger' }, gDb: -18 }],
  s3_bathroom_man_steelFinger_loudRef: [{ room: 'bathroom', ref: -10 }, { oct: MAN, g: { touch: 'finger' }, gDb: -16 }],
  s4_carpet_child_electric_fan: [{ room: 'carpet', ref: -20, beds: [['fan', -46]] }, { oct: CHILD, v: { sex: 'c' }, g: { type: 'electric' } }],
  s5_kitchen_bass_thumb_tv: [{ room: 'kitchen', ref: -18, beds: [['tv', -42]] }, { oct: BASS, vDb: -28, g: { touch: 'thumb' }, gDb: -18 }],
  s6_hallway_woman_agcFast_lat: [{ room: 'hallway', ref: -14, agc: 'fast', lat: 0.12 }, { oct: WOMAN, v: { sex: 'f' } }],
  s7_dry_headphones_nylonThumb: [{ room: 'dry', ref: null }, { oct: MAN, g: { type: 'nylon', touch: 'thumb' }, gDb: -18 }],
  s8_living_earlyStarter: [{ room: 'living', ref: -16 }, { oct: MAN, singDelay: (r) => U(r, -1.3, 0.3), hold: 3.6 }],
  s9_living_basscut_tvLoud: [{ room: 'living', ref: -18, micHp: 250, beds: [['tv', -32]] }, { oct: MAN }],
};
for (const [name, [env, st]] of Object.entries(S)) {
  if (only && !only.test(name)) continue;
  const rig = new Rig({ seed: +(process.env.SEED ?? 11), ...env }); rig.begin(); const t0 = Date.now();
  const res = honest(rig, { seed: +(process.env.SSEED ?? 6), ...st }, 0, TO);
  const q = (x: any) => ({ first: x.first, n: x.n, stuck: x.stuck, med: Math.round(1000 * med(x.lat)), p90: Math.round(1000 * med(x.lat, 0.9)) });
  const line = { build: B, name, sing: q(res.sing), play: q(res.play), rev: q(res.rev), acc: res.acc.map((a) => `${a.phase}@${a.index}.${a.pos}:${a.det?.toFixed?.(1)}/${a.target}`), stuckAt: res.stuckAt, hints: res.hints, done: rig.phase(), secs: Math.round((Date.now() - t0) / 1000) };
  console.log(JSON.stringify(line)); appendFileSync(`out/e3${process.env.SEED ? "x" : ""}_${B}.jsonl`, JSON.stringify(line) + '\n');
}
