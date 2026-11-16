// Round-11 honest fixtures, through the tenth review's rig (scripts/critic10): singers the
// round-10 build (59f3f12) refused as carry-over. One sing step per trial, a fresh start at the
// note; every distinct pitch of the song, the app's own speaker and an external one.
//   node honest.ts along <fade dB/s> <room>     sing along with the reference, fading; first-try count
//   node honest.ts early <room>                 repeated note, singing begun 0.2 s before the step
//                                               opens, over the previous note's string still ringing
// Prints one line: "first <k>/<n> lat med <ms> p90 <ms>". BUILD_DIR selects another checkout.
// @ts-nocheck (review-rig tooling)
import { Rig, MIDIS, manMidi } from '../critic10/rig10.ts';

const mode = process.argv[2];
const lat: number[] = [];
let first = 0, n = 0;
const sung = (rig: Rig) => rig.phase() !== 'sing';
if (mode === 'along') {
  const fade = Number(process.argv[3]);
  const room = process.argv[4];
  for (const m of [...new Set(MIDIS)].sort((a, b) => a - b)) for (const [sdb, near] of [[-12, true], [-20, false]] as [number, boolean][]) {
    const seed = m * 3 + room.length + (near ? 0 : 50);
    const rig = new Rig({ room, seed, spkDb: sdb, spkNear: near });
    let onT = 0;
    // (begins with the reference, 0.45 s in, and holds through the step's first 1.5 s, fading)
    rig.onRef = (rs, op) => { onT = rs + 0.45; rig.sing({ midi: manMidi(m), dur: op + 1.5 - onT, fade, seed }, onT, -20); };
    rig.begin(MIDIS.indexOf(m));
    rig.run(rig.t + 8, () => rig.phase() === 'sing');
    const open = rig.openT;
    rig.run(open + 1.9, () => sung(rig));
    n++;
    if (sung(rig)) { first++; lat.push(Math.round((rig.advs[rig.advs.length - 1].t - open) * 1000)); }
  }
} else if (mode === 'early') {
  const room = process.argv[3];
  const REP = MIDIS.map((m, i) => i).filter((i) => i > 0 && MIDIS[i] === MIDIS[i - 1]);
  for (const i of REP) {
    const m = MIDIS[i]; const seed = i * 7 + room.length;
    const rig = new Rig({ room, seed, spkDb: -14, settings: { phraseReview: false } });
    rig.begin(i - 1);
    // the previous note, sung then plucked and left ringing
    rig.run(rig.t + 6, () => rig.phase() === 'sing');
    const ev = rig.sing({ midi: manMidi(m), dur: 2.5, seed }, rig.t + 0.5);
    rig.run(rig.t + 4, () => rig.phase() !== 'sing');
    rig.stop(ev, rig.t + 0.25, 80);
    let ok = false;
    for (let k = 0; k < 3 && !ok; k++) { rig.pluck({ midi: m, seed: seed + k }, rig.t + 0.9, -13); rig.run(rig.t + 3, () => rig.s.view().index === i); ok = rig.s.view().index === i; }
    if (!ok) continue;
    let onT = 0;
    rig.onRef = (rs, op) => { onT = op - 0.2; rig.sing({ midi: manMidi(m), dur: 1.8, seed }, onT, -24); };
    rig.run(rig.t + 8, () => rig.phase() === 'sing');
    const open = rig.openT;
    rig.run(onT + 1.8 + 0.4, () => sung(rig));
    n++;
    if (sung(rig)) { first++; lat.push(Math.round((rig.advs[rig.advs.length - 1].t - open) * 1000)); }
  }
}
lat.sort((a, b) => a - b);
console.log(`first ${first}/${n} lat med ${lat[lat.length >> 1] ?? NaN} p90 ${lat[Math.min(lat.length - 1, Math.floor(0.9 * lat.length))] ?? NaN}`);
