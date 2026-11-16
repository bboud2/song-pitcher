// @ts-nocheck (ported review tooling, kept as written)
// Twelfth review (ported unchanged except for where it finds the build; it writes to ./out of the
// directory it is run from).
// E2: nobody sings. Does the sing step pass by itself? Each trial: session started at note i, the reference plays,
// then `what` happens, and nothing else for 30 s. Count passes of the sing step (and what hint is shown).
import { Rig, honest, MIDIS, U, rng, bump, guitar, voice, speech, lin, SR } from './rig.ts';
import { appendFileSync } from 'node:fs';
const B = process.env.BUILD_DIR!.slice(-1); const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
const ROOMSET = ['living', 'kitchen', 'hallway', 'bathroom', 'stairwell']; const IDX = [0, 5, 13, 21, 52]; const DUR = +(process.env.DUR ?? 12); // 13, 21, 37(=13), 52, 64 are repeated notes (same as the one before)
const REFLEN = 1.57;
type W = (rig: Rig, i: number, ref: { a: number; b: number }, r: () => number) => void;
const WHAT: Record<string, { env?: any; prevNote?: boolean; w?: W; rooms?: string[] }> = {
  nothing: {},
  nothing_loud: { env: { ref: -8 } },
  nothing_agcSlow: { env: { agc: 'slow', ref: -14 } },
  nothing_agcFast: { env: { agc: 'fast', ref: -14 } },
  nothing_lat150: { env: { lat: 0.15 } },
  nothing_lat250: { env: { lat: 0.25 } },
  nothing_tablet: { env: { speaker: 'tablet', ref: -14 } },
  knock_duringRef: { w: (rig, i, ref, r) => { rig.noise('knock' + i, () => bump('knock', i), ref.a + U(r, 0.3, 1.3), -14); } },
  cough_duringRef: { w: (rig, i, ref, r) => { rig.noise('cough' + i, () => bump('cough', i), ref.a + U(r, 0.3, 1.3), -16); } },
  page_duringRef: { w: (rig, i, ref, r) => { rig.noise('page' + i, () => bump('page', i), ref.a + U(r, 0.3, 1.3), -24); } },
  chair_duringRef: { w: (rig, i, ref, r) => { rig.noise('chair' + i, () => bump('chair', i), ref.a + U(r, 0.3, 1.3), -18); } },
  knock_earlyStep: { w: (rig, i, ref, r) => { rig.noise('knock' + i, () => bump('knock', i), ref.b + U(r, 0.02, 0.5), -14); } },
  cough_earlyStep: { w: (rig, i, ref, r) => { rig.noise('cough' + i, () => bump('cough', i), ref.b + U(r, 0.02, 0.5), -16); } },
  chair_earlyStep: { w: (rig, i, ref, r) => { rig.noise('chair' + i, () => bump('chair', i), ref.b + U(r, 0.02, 0.5), -18); } },
  breath_earlyStep: { w: (rig, i, ref, r) => { rig.noise('breath' + i, () => bump('breath', i), ref.b + U(r, 0.02, 0.5), -28); } },
  // the previous note really played and left ringing; nothing else
  prevRinging: { prevNote: true },
  prevRinging_thump: { prevNote: true, w: (rig, i, ref, r) => { rig.noise('thump' + i, () => bump('thump', i), ref.a + U(r, 0.2, 1.8), -20, 2); } },
  prevRinging_agc: { prevNote: true, env: { agc: 'slow', ref: -14 } },
  prevRinging_restrike: { prevNote: true, w: (rig, i, ref, r) => { rig.pluck({ midi: MIDIS[i - 1], seed: 400 + i, touch: 'finger' }, ref.a + U(r, 0.4, 1.4), -18); } },
  // a string ringing in sympathy with the reference: swells while it plays, then dies away slowly (no pluck)
  sympString: { w: (rig, i, ref, r) => { const m = MIDIS[i]; const g = guitar({ midi: m, seed: 300 + i, touch: 'thumb', dur: 6, sustain: 1.5 }); const L = Math.floor(0.5 * SR); for (let k = 0; k < L; k++) g[k] *= (k / L) ** 2; rig.add(g, ref.a + 0.15, U(r, -40, -32), 'x'); } },
  sympString_octave: { w: (rig, i, ref, r) => { const m = MIDIS[i] - 12 < 40 ? MIDIS[i] : MIDIS[i] - 12; const g = guitar({ midi: m, seed: 300 + i, touch: 'thumb', dur: 6, sustain: 1.5 }); const L = Math.floor(0.5 * SR); for (let k = 0; k < L; k++) g[k] *= (k / L) ** 2; rig.add(g, ref.a + 0.15, U(r, -40, -32), 'x'); } },
  // a quiet steady electronic tone at the target pitch that was there all along (a keyboard drone, a tuner app)
  steadyTone: { w: (rig, i, ref, r) => { const f = 440 * 2 ** ((MIDIS[i] - 69) / 12); const y = new Float32Array(SR * 16); for (let k = 0; k < y.length; k++) { const t = k / SR; y[k] = Math.min(1, t / 0.8) * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t) + 0.15 * Math.sin(6 * Math.PI * f * t)); } rig.add(y, ref.a - 1.5, U(r, -42, -34), 'x'); } },
  tv: { env: { beds: [['tv', -34]] } },
  tvLoud: { env: { beds: [['tv', -26]] } },
  talk: { env: { beds: [['talk', -30]] } },
  // somebody else plays the target note on another instrument (a pluck) during the step: not a voice
  otherGuitarTarget: { w: (rig, i, ref, r) => { rig.pluck({ midi: MIDIS[i], seed: 900 + i, type: 'nylon', touch: 'finger', str: 9 }, ref.b + U(r, 0.3, 1), -18); } },
};
for (const [name, c] of Object.entries(WHAT)) {
  if (only && !only.test(name)) continue;
  let n = 0, pass = 0; const hints: Record<string, number> = {}; const where: string[] = []; let withHint = 0;
  for (const room of c.rooms ?? ROOMSET) for (const i of IDX) {
    if (c.prevNote && i === 0) continue;
    const r = rng(i * 13 + room.length); const rig = new Rig({ room, seed: 3 + i, ref: -18, ...(c.env ?? {}), from: c.prevNote ? i - 1 : i }); rig.begin();
    let ref: any = null; rig.onRef = (a, b) => { ref = { a, b }; };
    if (c.prevNote) { honest(rig, { seed: 2 }, i - 1, i - 1); if (rig.idx() !== i) continue; ref = null; rig.onRef = (a, b) => { ref = { a, b }; }; rig.accidental = []; rig.hintLog = []; }
    rig.expect = null; rig.run(rig.t + 8, () => ref !== null); if (!ref) continue;
    c.w?.(rig, i, ref, r);
    n++; rig.run(ref.b + (name === 'nothing' ? 30 : DUR), () => rig.phase() === 'play' || rig.idx() !== i);
    const hs = new Set(rig.hintLog.filter((h) => h.phase === 'sing').map((h) => h.hint)); for (const h of hs) hints[h] = (hints[h] ?? 0) + 1; if (hs.size) withHint++;
    if (rig.phase() !== 'sing' || rig.idx() !== i) { pass++; where.push(`${room}@${i}+${(rig.t - ref.b).toFixed(1)}s`); }
  }
  const line = { build: B, name, pass, n, hints, where }; console.log(JSON.stringify(line)); appendFileSync(`out/e2_${B}.jsonl`, JSON.stringify(line) + '\n');
}
