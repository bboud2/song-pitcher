// Round-13 honest fixture through the twelfth review's rig (scripts/critic12): a singer who starts
// with the reference tone (0.3-0.9 s into it), well under it at the microphone, and simply holds
// the note — 20 sing steps (notes 0-19), as the review's e1b runs them. The round-12 build
// (74cd03b) held most of them back for as long as they sang.
//   node singalong.ts <room> <reference dBFS> <voice dBFS>   -> one line: "first <k>/<n> stuck <s> over1s <m>"
// BUILD_DIR selects another checkout.
// @ts-nocheck (review-rig tooling)
import { Rig, honest, U } from '../critic12/rig.ts';

const [room, ref, vDb] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];
const REFLEN = 1.57;
const rig = new Rig({ room, seed: 5, ref });
rig.begin();
const res = honest(rig, { seed: 4, vDb, spread: 1, hold: 4.2, noPlay: true, v: { cons: '', riseMs: 120 }, singDelay: (r) => -REFLEN + U(r, 0.3, 0.9) }, 0, 19);
console.log(`first ${res.sing.first}/${res.sing.n} stuck ${res.sing.stuck} over1s ${res.sing.lat.filter((x) => x > 1.0).length}`);
