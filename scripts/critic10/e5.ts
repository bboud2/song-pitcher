// Tenth review (ported unchanged except for where it finds the build).
// @ts-nocheck (ported review tooling, kept as written)
// E5: items the builder left alone — did they get worse? One note per trial; sing honestly unless the probe is about singing.
import { Rig, MIDIS, manMidi, speech } from './rig10.ts';
const ROOMS = (process.argv[2] ?? 'dry,living,garage').split(','); const BEH = (process.argv[3] ?? '').split(',').filter(Boolean);
const PITCHES = [...new Set(MIDIS)].sort((a, b) => a - b);
const P: Record<string, any> = {
  // sing-step probes
  singCons_d: { sing: { onset: 'd' } }, singCons_t: { sing: { onset: 't' } }, singCons_l: { sing: { onset: 'l' } },
  singTalk: { singTalk: true },
  // play-step probes (after an honest sung note)
  pluck: { g: {}, db: -14 }, pluckQuiet34: { g: {}, db: -34 }, pluckQuiet40: { g: { style: 'finger' }, db: -40 }, pluckThumbQuiet: { g: { style: 'thumb' }, db: -30 },
  sustain: { g: { sustain: 3, pos: 0.3 }, db: -14 }, whileSinging: { g: {}, db: -14, keepSinging: true },
  playTalk: { playTalk: true }, playHum: { playHum: true }, playWrong1: { g: {}, db: -14, off: 1 }, playWrongM1: { g: {}, db: -14, off: -1 }, playOct: { g: {}, db: -14, off: 12 },
  // repeated note in the play step: the previous note still ringing, a softer pluck of the same string
};
for (const beh of BEH.length ? BEH : Object.keys(P)) for (const room of ROOMS) for (const m of PITCHES) for (const rep of [0, 1]) {
  const pr = P[beh]; const i = MIDIS.indexOf(m); const seed = m * 11 + room.length + rep * 37; const rig = new Rig({ room, seed, spkDb: -14, settings: { phraseReview: false } });
  rig.begin(i); rig.run(rig.t + 8, () => rig.phase() === 'sing'); const res: any = { beh, room, m, first: false, lat: null, stuck: false, bad: false };
  if (pr.singTalk) { const at = rig.t + 0.3; rig.raw('talk' + seed, () => speech(7, seed, rep === 1), at, -22); rig.run(at + 6, () => rig.phase() !== 'sing'); res.bad = rig.phase() !== 'sing'; console.log(JSON.stringify(res)); continue; }
  const at = rig.t + 0.5; const ev = rig.sing({ midi: manMidi(m), dur: pr.keepSinging ? 5 : 2.2, seed, ...(pr.sing ?? {}) }, at, -24); rig.run(at + 2.2, () => rig.phase() !== 'sing');
  if (pr.sing) { if (rig.phase() !== 'sing') { res.first = true; res.lat = Math.round((rig.t - at) * 1000); } else { const a2 = rig.t + 0.8; rig.sing({ midi: manMidi(m), dur: 1.6, seed: seed + 1 }, a2, -24); rig.run(a2 + 2.2, () => rig.phase() !== 'sing'); res.stuck = rig.phase() === 'sing'; res.hints = [...rig.hints]; } console.log(JSON.stringify(res)); continue; }
  if (rig.phase() === 'sing') { console.log(JSON.stringify({ beh, room, m, setupFail: true })); continue; }
  if (!pr.keepSinging) rig.stop(ev, rig.t + 0.2, 80);
  const idx = () => rig.s.view().index;
  if (pr.playTalk || pr.playHum) { const a = rig.t + 0.8; if (pr.playTalk) rig.raw('talk' + seed, () => speech(7, seed + 3, rep === 1), a, -22); else for (let k = 0; k < 4; k++) rig.sing({ midi: manMidi(m), dur: 0.5 + 0.3 * k, onset: 'm', vowel: 'm', fade: 6, seed: seed + k }, a + 1.4 * k, -26); rig.run(a + 6, () => idx() !== i); res.bad = idx() !== i; console.log(JSON.stringify(res)); continue; }
  const a = rig.t + (pr.keepSinging ? 0.5 : 0.9); rig.pluck({ midi: m + (pr.off ?? 0), seed, ...pr.g }, a, pr.db); rig.run(a + 2.5, () => idx() !== i);
  if (pr.off) { res.bad = idx() !== i; console.log(JSON.stringify(res)); continue; }
  if (idx() !== i) { res.first = true; res.lat = Math.round((rig.t - a) * 1000); }
  else { let ok = false; res.hints = [...rig.hints]; for (let k = 0; k < 2 && !ok; k++) { const a2 = rig.t + 0.3; rig.pluck({ midi: m, seed: seed + 5 + k, ...pr.g }, a2, pr.db + 4 * (k + 1)); rig.run(a2 + 2.5, () => idx() !== i); ok = idx() !== i; } res.stuck = !ok; }
  console.log(JSON.stringify(res));
}
