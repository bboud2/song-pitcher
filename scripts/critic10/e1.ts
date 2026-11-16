// Tenth review (ported unchanged except for where it finds the build).
// @ts-nocheck (ported review tooling, kept as written)
// E1: does the reference-pitch guard hold up an honest singer? One sing step per trial, fresh start at note i.
import { Rig, MIDIS, manMidi, womanMidi } from './rig10.ts';
const ROOMS = (process.argv[2] ?? 'living,garage,tiled').split(',');
const BEH = (process.argv[3] ?? '').split(',').filter(Boolean);
const PITCHES = [...new Set(MIDIS)].sort((a, b) => a - b); // 11 distinct
const idxOf = (m: number) => MIDIS.indexOf(m);
type Plan = { on: number; o: any; db: number }; // on = onset relative to open (negative = before the step opens)
const B: Record<string, (m: number, sd: number, refStart: number, open: number) => Plan> = {
  normal: (m, sd) => ({ on: 0.5, o: { midi: manMidi(m), dur: 1.6, seed: sd }, db: -24 }),
  none: (m, sd) => ({ on: 99, o: { midi: manMidi(m), dur: 0.3, seed: sd }, db: -90 }),
  along: (m, sd, rs, op) => ({ on: rs + 0.45 - op, o: { midi: manMidi(m), dur: op + 1.5 - (rs + 0.45), seed: sd }, db: -24 }),
  atRefEnd: (m, sd, rs, op) => ({ on: rs + 0.9 - op, o: { midi: manMidi(m), dur: op + 1.5 - (rs + 0.9), seed: sd }, db: -24 }),
  preOpen: (m, sd) => ({ on: -0.15, o: { midi: manMidi(m), dur: 1.7, seed: sd }, db: -24 }),
  fade6: (m, sd) => ({ on: 0.4, o: { midi: manMidi(m), dur: 1.3, fade: 6, seed: sd }, db: -22 }),
  atRefEndFade3: (m, sd, rs, op) => ({ on: rs + 0.9 - op, o: { midi: manMidi(m), dur: op + 1.5 - (rs + 0.9), fade: 3, seed: sd }, db: -20 }),
  atRefEndFade5: (m, sd, rs, op) => ({ on: rs + 0.9 - op, o: { midi: manMidi(m), dur: op + 1.5 - (rs + 0.9), fade: 5, seed: sd }, db: -20 }),
  preOpenFade4: (m, sd) => ({ on: -0.15, o: { midi: manMidi(m), dur: 1.5, fade: 4, seed: sd }, db: -20 }),
  preOpenFade8: (m, sd) => ({ on: -0.15, o: { midi: manMidi(m), dur: 1.2, fade: 8, seed: sd }, db: -18 }),
  child: (m, sd) => ({ on: 0.35, o: { midi: womanMidi(m) + (womanMidi(m) < 60 ? 12 : 0), dur: 0.6, female: true, vowel: 'o', seed: sd }, db: -22 }),
  childPreOpen: (m, sd) => ({ on: -0.1, o: { midi: womanMidi(m) + (womanMidi(m) < 60 ? 12 : 0), dur: 0.8, female: true, vowel: 'o', seed: sd }, db: -22 }),
  quiet: (m, sd) => ({ on: 0.5, o: { midi: manMidi(m), dur: 1.6, vowel: 'u', seed: sd }, db: -40 }),
  woman: (m, sd) => ({ on: 0.5, o: { midi: womanMidi(m), dur: 1.6, female: true, vowel: 'a', seed: sd }, db: -24 }),
  softOnTail: (m, sd) => ({ on: 0.02, o: { midi: manMidi(m), dur: 1.8, onset: 'soft', rise: 0.3, vowel: 'u', scoop: 0, seed: sd }, db: -34 }),
  softOnTailFade3: (m, sd) => ({ on: 0.02, o: { midi: manMidi(m), dur: 1.8, onset: 'soft', rise: 0.2, vowel: 'u', scoop: 0, fade: 3, seed: sd }, db: -30 }),
  wrong2_05: (m, sd) => ({ on: 0.5, o: { midi: manMidi(m) + 2, dur: 1.6, seed: sd }, db: -24, wrong: true } as any),
  wrong2_10: (m, sd) => ({ on: 1.0, o: { midi: manMidi(m) + 2, dur: 1.6, seed: sd }, db: -24, wrong: true } as any),
  wrong3_02: (m, sd) => ({ on: 0.2, o: { midi: manMidi(m) - 3, dur: 1.6, seed: sd }, db: -24, wrong: true } as any),
  wrong5_15: (m, sd) => ({ on: 1.5, o: { midi: manMidi(m) + 5, dur: 1.6, seed: sd }, db: -24, wrong: true } as any),
  atRefEndLong: (m, sd, rs, op) => ({ on: rs + 0.9 - op, o: { midi: manMidi(m), dur: op + 4 - (rs + 0.9), fade: 2.5, seed: sd }, db: -20 }),
  hum: (m, sd) => ({ on: 0.3, o: { midi: manMidi(m), dur: 1.6, onset: 'm', vowel: 'm', seed: sd }, db: -30 }),
};
const SPK: [string, number, boolean][] = [['own', -12, true], ['ext', -20, false]];
for (const beh of BEH.length ? BEH : Object.keys(B)) for (const room of ROOMS) for (const [sn, sdb, near] of SPK) for (const m of PITCHES) {
  const i = idxOf(m); const seed = m * 3 + room.length + (near ? 0 : 50);
  const rig = new Rig({ room, seed, spkDb: sdb, spkNear: near });
  let plan: Plan | null = null; let onT = 0;
  rig.onRef = (rs, op) => { plan = B[beh](m, seed, rs, op); onT = op + plan.on; if (plan.db > -80) rig.sing(plan.o, onT, plan.db); };
  rig.begin(i);
  rig.run(rig.t + 8, () => rig.phase() === 'sing'); const open = rig.openT; const endT = onT + plan!.o.dur;
  const lim = beh === 'none' ? open + 4 : endT + 0.4;
  rig.run(lim, () => rig.phase() !== 'sing');
  let res: any = { beh, room, spk: sn, m, first: false, pre: false, lat: null, stuck: false, hints: [...rig.hints] };
  if ((plan as any).wrong) { res.bad = rig.phase() !== 'sing'; if (res.bad) res.badAfter = Math.round((rig.advs[rig.advs.length - 1].t - onT) * 1000); }
  else if (rig.phase() !== 'sing') { const at = rig.advs[rig.advs.length - 1].t; if (at < onT + 0.06) res.pre = true; else { res.first = true; res.lat = Math.round((at - Math.max(onT, open)) * 1000); } }
  else if (beh !== 'none') {
    // retry twice with a plain note
    let ok = false; for (let k = 0; k < 2 && !ok; k++) { const at = rig.t + 0.8; rig.sing({ midi: manMidi(m), dur: 1.6, seed: seed + 7 + k }, at, -24); rig.run(at + 2.2, () => rig.phase() !== 'sing'); ok = rig.phase() !== 'sing'; }
    res.stuck = !ok; res.hints = [...new Set([...res.hints, ...rig.hints])];
  }
  console.log(JSON.stringify(res));
}
