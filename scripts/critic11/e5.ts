// @ts-nocheck (ported review tooling, kept as written)
// Eleventh review (ported unchanged except for where it finds the build).
// Phrase review of phrase 3 (G3 G3 E4 D4 C4 B3) and phrase 13 (G3 C4 C4 C4 B3 A3 A3 A3): tries needed per position.
import { Rig, MIDIS, SONG, plainNote, rng } from './rig11.ts';
const tot: Record<string, number[]> = {}; let stuck = 0, runs = 0, dbl = 0; const ex: string[] = [];
for (const end of [17, 80]) for (const room of ['lounge', 'kitchen', 'bath']) for (const [touch, kind, gDb] of [['finger', 'steel', -22], ['thumb', 'nylon', -18], ['pick', 'steel', -12]] as any) for (let seed = 1; seed <= 6; seed++) {
  const r = rng(seed * 17 + end); const rig = new Rig({ room, spk: -12, seed }); rig.begin(end); if (!plainNote(rig, seed, { kind, touch }, gDb)) { console.log('setup failed', end, room, touch, seed); continue; }
  if (rig.phase() !== 'review') { console.log('no review'); continue; } runs++;
  const ph = rig.s.view().review.phrase; let last = rig.t + 1.2 - 10; let st = false; const tries: number[] = [];
  for (let k = ph.start; k <= ph.end && !st; k++) { const pos = k - ph.start; const gap = k === ph.start ? 0 : Math.max(0.45, SONG.notes[k - 1].beats * 60 / SONG.bpm * 1.4); let ok = false; const still = () => rig.phase() === 'review' && rig.s.view().review?.pos === pos;
    for (let a = 1; a <= 8 && !ok; a++) { const on = Math.max(rig.t + (pos === 0 && a === 1 ? 1.2 : 0.05), last + gap); rig.run(on, () => !still()); if (!still()) { ok = true; tries.push(0); dbl++; ex.push(`double-count ${end} ${room} ${touch} seed${seed} pos${pos}`); break; }
      rig.pluck({ midi: MIDIS[k], cents: Math.round(-8 + 20 * r()), seed: k * 5 + a + seed * 100, kind, touch }, on, gDb - 3 + 6 * r()); last = on; rig.run(on + Math.max(1.2, gap), () => !still()); if (!still()) { ok = true; tries.push(a); } }
    if (!ok) { st = true; stuck++; ex.push(`STUCK (8 plucks refused) ${end} ${room} ${touch} seed${seed} pos${pos} midi ${MIDIS[k]} hints ${rig.hints.join(',')}`); } const key = `${touch}`; tot[key] ??= [0, 0, 0]; if (ok && tries.at(-1) === 1) tot[key][0]++; tot[key][1]++; if (ok && tries.at(-1)! > 2) { tot[key][2]++; ex.push(`${tries.at(-1)} plucks needed: ${end} ${room} ${touch} seed${seed} pos${pos} midi ${MIDIS[k]}`); } }
}
console.log(process.env.BUILD_DIR!.split('/').pop(), 'review runs', runs, 'stuck (8 plucks of one note refused)', stuck, 'notes passed with no pluck (double count)', dbl); for (const [k, v] of Object.entries(tot)) console.log(`  ${k}: first pluck ${v[0]}/${v[1]}, needed 3+ plucks ${v[2]}`); console.log(ex.slice(0, 30).join('\n'));
