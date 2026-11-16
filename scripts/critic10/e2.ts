// Tenth review (ported unchanged except for where it finds the build).
// @ts-nocheck (ported review tooling, kept as written)
// E2: repeated note, sing step, the previous note's string left ringing. Start at i-1, play it honestly, then test step i.
import { Rig, MIDIS, manMidi, womanMidi, honestNote, speech, SR } from './rig10.ts';
const ROOMS = (process.argv[2] ?? 'dry,living,garage').split(',');
const BEH = (process.argv[3] ?? '').split(',').filter(Boolean);
const REP = MIDIS.map((m, i) => i).filter((i) => i > 0 && MIDIS[i] === MIDIS[i - 1]);
type Plan = { on: number; o?: any; db: number; kind: 'right' | 'wrong' | 'none' | 'talk' };
const B: Record<string, (m: number, sd: number) => Plan> = {
  none: () => ({ on: 99, db: 0, kind: 'none' }),
  wrongM2: (m, sd) => ({ on: 0.5, o: { midi: manMidi(m) + 2, dur: 1.8, seed: sd }, db: -24, kind: 'wrong' }),
  wrongm3: (m, sd) => ({ on: 0.5, o: { midi: manMidi(m) - 3, dur: 1.8, seed: sd }, db: -24, kind: 'wrong' }),
  wrongP4early: (m, sd) => ({ on: 0.1, o: { midi: manMidi(m) + 5, dur: 1.8, seed: sd }, db: -22, kind: 'wrong' }),
  wrongM2quiet: (m, sd) => ({ on: 0.4, o: { midi: manMidi(m) + 2, dur: 1.8, vowel: 'u', seed: sd }, db: -34, kind: 'wrong' }),
  talk: (m, sd) => ({ on: 0.2, db: -24, kind: 'talk' }),
  normal: (m, sd) => ({ on: 0.5, o: { midi: manMidi(m), dur: 1.6, seed: sd }, db: -24, kind: 'right' }),
  short: (m, sd) => ({ on: 0.4, o: { midi: manMidi(m), dur: 0.65, seed: sd }, db: -24, kind: 'right' }),
  early: (m, sd) => ({ on: -0.2, o: { midi: manMidi(m), dur: 1.8, seed: sd }, db: -24, kind: 'right' }),
  atOpen: (m, sd) => ({ on: 0.03, o: { midi: manMidi(m), dur: 1.6, seed: sd }, db: -24, kind: 'right' }),
  hardD: (m, sd) => ({ on: 0.5, o: { midi: manMidi(m), dur: 1.4, onset: 'd', seed: sd }, db: -22, kind: 'right' }),
  hardT: (m, sd) => ({ on: 0.5, o: { midi: manMidi(m), dur: 1.4, onset: 't', seed: sd }, db: -22, kind: 'right' }),
  quiet: (m, sd) => ({ on: 0.5, o: { midi: manMidi(m), dur: 1.6, vowel: 'u', seed: sd }, db: -36, kind: 'right' }),
  soft: (m, sd) => ({ on: 0.4, o: { midi: manMidi(m), dur: 1.8, onset: 'soft', rise: 0.25, vowel: 'o', seed: sd }, db: -28, kind: 'right' }),
  woman: (m, sd) => ({ on: 0.5, o: { midi: womanMidi(m), dur: 1.6, female: true, seed: sd }, db: -24, kind: 'right' }),
  fade5: (m, sd) => ({ on: 0.4, o: { midi: manMidi(m), dur: 1.3, fade: 5, seed: sd }, db: -22, kind: 'right' }),
  earlyLong: (m, sd) => ({ on: -0.2, o: { midi: manMidi(m), dur: 4.4, seed: sd }, db: -24, kind: 'right' }),
  softLong: (m, sd) => ({ on: 0.4, o: { midi: manMidi(m), dur: 4, onset: 'soft', rise: 0.25, vowel: 'o', seed: sd }, db: -28, kind: 'right' }),
  hardDLong: (m, sd) => ({ on: 0.5, o: { midi: manMidi(m), dur: 4, onset: 'd', seed: sd }, db: -22, kind: 'right' }),
  hum: (m, sd) => ({ on: 0.4, o: { midi: manMidi(m), dur: 1.6, onset: 'm', vowel: 'm', seed: sd }, db: -30, kind: 'right' }),
};
for (const beh of BEH.length ? BEH : Object.keys(B)) for (const room of ROOMS) for (const i of REP) for (const style of ['pick', 'finger']) {
  if (style === 'finger' && REP.indexOf(i) % 2) continue; // 21 repeats: all picked, every other one also fingerstyle
  const m = MIDIS[i]; const seed = i * 7 + room.length + (style === 'pick' ? 0 : 3);
  const rig = new Rig({ room, seed, spkDb: -14, settings: { phraseReview: false } });
  rig.begin(i - 1);
  // previous note: sing, then pluck with the given style, let it ring
  rig.run(rig.t + 6, () => rig.phase() === 'sing'); let ev = rig.sing({ midi: manMidi(m), dur: 2.5, seed }, rig.t + 0.5); rig.run(rig.t + 4, () => rig.phase() !== 'sing'); rig.stop(ev, rig.t + 0.25, 80);
  let prevOk = false; for (let k = 0; k < 3 && !prevOk; k++) { rig.pluck({ midi: m, seed: seed + k, style: style as any }, rig.t + 0.9, -13); rig.run(rig.t + 3, () => rig.s.view().index === i); prevOk = rig.s.view().index === i; }
  if (!prevOk) { console.log(JSON.stringify({ beh, room, i, m, style, setupFail: true })); continue; }
  let plan: Plan = B[beh](m, seed); let onT = 0;
  rig.onRef = (rs, op) => { onT = op + plan.on; if (plan.kind === 'talk') rig.raw('talk' + seed, () => speech(6, seed), onT, plan.db); else if (plan.o) rig.sing(plan.o, onT, plan.db); };
  rig.run(rig.t + 8, () => rig.phase() === 'sing'); const open = rig.openT;
  const endT = plan.kind === 'right' ? onT + plan.o.dur + 0.4 : open + 4.5;
  rig.run(endT, () => rig.phase() !== 'sing');
  const res: any = { beh, kind: plan.kind, room, i, m, style, first: false, pre: false, lat: null, stuck: false, bad: false, hints: [...rig.hints] };
  const passed = rig.phase() !== 'sing'; const at = passed ? rig.advs[rig.advs.length - 1].t : null;
  if (plan.kind !== 'right') { res.bad = passed; if (passed) res.badAfter = Math.round((at! - Math.max(open, plan.kind === 'none' ? open : onT)) * 1000); }
  else if (passed) { if (at! < onT + 0.06) res.pre = true; else { res.first = true; res.lat = Math.round((at! - Math.max(onT, open)) * 1000); } }
  else { let ok = false; for (let k = 0; k < 2 && !ok; k++) { const a = rig.t + 0.8; rig.sing({ midi: manMidi(m), dur: 1.6, seed: seed + 7 + k }, a, -24); rig.run(a + 2.2, () => rig.phase() !== 'sing'); ok = rig.phase() !== 'sing'; } res.stuck = !ok; res.hints = [...new Set([...res.hints, ...rig.hints])]; }
  console.log(JSON.stringify(res));
}
