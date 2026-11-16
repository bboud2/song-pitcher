// Tenth review (ported unchanged except for where it finds the build).
// @ts-nocheck (ported review tooling, kept as written)
// E6: staccato / palm-muted plucks in the guitar step (the "30 dB under peak" rule now only after 0.4 s)
import { Rig, MIDIS, manMidi } from './rig10.ts';
const PITCHES = [...new Set(MIDIS)].sort((a, b) => a - b);
for (const [beh, cut, style] of [['stacc80', 0.08, 'pick'], ['stacc150', 0.15, 'pick'], ['stacc250', 0.25, 'finger'], ['wrongStacc', 0.12, 'pick']] as [string, number, string][]) for (const room of ['dry', 'living', 'garage']) for (const m of PITCHES) for (const rep of [0, 1]) {
  const i = MIDIS.indexOf(m); const seed = m * 13 + room.length + rep * 41; const rig = new Rig({ room, seed, spkDb: -14, settings: { phraseReview: false } });
  rig.begin(i); rig.run(rig.t + 8, () => rig.phase() === 'sing'); const at = rig.t + 0.5; const ev = rig.sing({ midi: manMidi(m), dur: 2.2, seed }, at, -24); rig.run(at + 2.2, () => rig.phase() !== 'sing'); if (rig.phase() === 'sing') { console.log(JSON.stringify({ beh, room, m, setupFail: true })); continue; }
  rig.stop(ev, rig.t + 0.2, 80); const idx = () => rig.s.view().index; const res: any = { beh, room, m, first: false, lat: null, stuck: false, bad: false };
  const a = rig.t + 0.9; const g = rig.pluck({ midi: m + (beh === 'wrongStacc' ? 12 : 0), seed, style: style as any }, a, -14); rig.stop(g, a + cut, 30); rig.run(a + 2, () => idx() !== i);
  if (beh === 'wrongStacc') res.bad = idx() !== i; else if (idx() !== i) { res.first = true; res.lat = Math.round((rig.t - a) * 1000); } else { res.hints = [...rig.hints]; const a2 = rig.t + 0.3; rig.pluck({ midi: m, seed: seed + 1 }, a2, -12); rig.run(a2 + 2.5, () => idx() !== i); res.stuck = idx() === i; }
  console.log(JSON.stringify(res));
}
