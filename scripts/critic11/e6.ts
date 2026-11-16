// @ts-nocheck (ported review tooling, kept as written)
// Eleventh review (ported unchanged except for where it finds the build).
// "X Y X": the note two steps back was this step's target, on another string, left ringing. Nobody sings.
import { Rig, MIDIS, plainNote } from './rig11.ts';
const tally: Record<string, number[]> = {}; const ex: string[] = [];
for (const kind of ['steel', 'electric', 'nylon']) for (const sustain of [1, 2]) for (const gDb of [-8, -18]) for (const room of ['lounge', 'kitchen', 'hall']) for (const i of [3, 28, 59]) {
  const seed = i + room.length; const rig = new Rig({ room, spk: -14, seed }); rig.begin(i - 2);
  if (!plainNote(rig, seed, { kind, sustain }, gDb) || !plainNote(rig, seed + 1, { kind, sustain }, gDb)) { ex.push(`setup failed ${kind} ${room} ${i}`); continue; }
  rig.until('sing', 8); const open = rig.t; rig.run(open + 7, () => rig.phase() !== 'sing'); const adv = rig.phase() !== 'sing';
  const k = `${kind} sustain x${sustain} pluck ${gDb} dB`; tally[k] ??= [0, 0]; tally[k][1]++; if (adv) { tally[k][0]++; if (ex.length < 12) ex.push(`ADV ${k} ${room} note ${i} at +${(rig.t - open).toFixed(2)} s`); }
  tally.all ??= [0, 0]; tally.all[1]++; if (adv) tally.all[0]++;
  const h = rig.hints.join(','); tally['hint:' + (h || 'none')] ??= [0, 0]; tally['hint:' + (h || 'none')][0]++;
}
console.log(process.env.BUILD_DIR!.split('/').pop(), 'sing step passed with nobody singing (older same-pitch string still ringing):'); for (const [k, v] of Object.entries(tally)) console.log(`  ${k}: ${v[0]}${v[1] ? '/' + v[1] : ''}`); console.log(ex.join('\n'));
