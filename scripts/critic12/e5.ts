// @ts-nocheck (ported review tooling, kept as written)
// Twelfth review (ported unchanged except for where it finds the build; it writes to ./out of the
// directory it is run from).
// E5: wrong notes must not pass. E4: review / play steps with nobody playing.
import { Rig, honest, MIDIS, MAN, U, rng, bump, speech, voice } from './rig.ts';
import { appendFileSync } from 'node:fs';
const B = process.env.BUILD_DIR!.slice(-1); const mode = process.argv[2] ?? 'all';
const out = (o: any) => { console.log(JSON.stringify(o)); appendFileSync(`out/e5_${B}.jsonl`, JSON.stringify(o) + '\n'); };
const IDX = [1, 6, 14, 22, 40]; const ROOMS2 = ['living', 'bathroom'];
if (mode === 'all' || mode === 'sing') {
  for (const d of [-2, -1, 1, 2, 5, 7]) { let n = 0, pass = 0; const where: string[] = [];
    for (const room of ROOMS2) for (const i of IDX) { const rig = new Rig({ room, ref: -12, seed: i, from: i }); rig.begin(); let ref: any = null; rig.onRef = (a, b) => (ref = { a, b }); rig.run(rig.t + 8, () => ref !== null);
      rig.sing({ midi: MAN(MIDIS[i]) + d, dur: 2.6, seed: 50 + i + d, vowel: 'a' }, ref.b + 0.4, -24); n++; rig.run(ref.b + 3.6, () => rig.phase() === 'play'); if (rig.phase() === 'play') { pass++; where.push(`${room}@${i}`); } }
    out({ build: B, test: 'sing wrong semitone', d, pass, n, where }); }
  // right note but a quarter-tone and 70 c off (tolerance 50): must not pass; 40 c must
  for (const c of [-70, 70, -40, 40]) { let n = 0, pass = 0;
    for (const room of ROOMS2) for (const i of IDX) { const rig = new Rig({ room, ref: -12, seed: i, from: i }); rig.begin(); let ref: any = null; rig.onRef = (a, b) => (ref = { a, b }); rig.run(rig.t + 8, () => ref !== null);
      rig.sing({ midi: MAN(MIDIS[i]), cents: c, dur: 2.6, seed: 50 + i, vowel: 'o', vib: 6, scoop: 0 }, ref.b + 0.4, -24); n++; rig.run(ref.b + 3.6, () => rig.phase() === 'play'); if (rig.phase() === 'play') pass++; }
    out({ build: B, test: 'sing off by cents', c, pass, n }); }
}
if (mode === 'all' || mode === 'play') {
  for (const d of [-12, -2, -1, 1, 2, 7, 12]) { let n = 0, pass = 0; const where: string[] = []; const hints: Record<string, number> = {};
    for (const room of ROOMS2) for (const i of IDX) { const rig = new Rig({ room, ref: -16, seed: i, from: i }); rig.begin(); honest(rig, { seed: 3, noPlay: true }, i, i); if (rig.phase() !== 'play') continue;
      const m = MIDIS[i] + d; if (m < 40 || m > 76) continue; rig.hintLog = []; rig.expect = null; const k0 = rig.advs.length;
      rig.pluck({ midi: m, seed: 70 + i + d }, rig.t + 0.8, -14); n++; rig.run(rig.t + 3.6, () => rig.advs.length > k0); if (rig.advs.length > k0) { pass++; where.push(`${room}@${i}`); }
      for (const h of new Set(rig.hintLog.map((x) => x.hint))) hints[h] = (hints[h] ?? 0) + 1; }
    out({ build: B, test: 'play wrong note', d, pass, n, where, hints }); }
  for (const c of [-70, 70, 30, -30]) { let n = 0, pass = 0;
    for (const room of ROOMS2) for (const i of IDX) { const rig = new Rig({ room, ref: -16, seed: i, from: i }); rig.begin(); honest(rig, { seed: 3, noPlay: true }, i, i); if (rig.phase() !== 'play') continue; const k0 = rig.advs.length;
      rig.pluck({ midi: MIDIS[i], cents: c, seed: 70 + i }, rig.t + 0.8, -14); n++; rig.run(rig.t + 3.6, () => rig.advs.length > k0); if (rig.advs.length > k0) pass++; }
    out({ build: B, test: 'play off by cents', c, pass, n }); }
}
if (mode === 'all' || mode === 'idle') {
  // play step: sing accepted, then nobody plucks for 15 s (voice keeps going 1 s / talk / tv / knock)
  const W: Record<string, (rig: Rig, i: number, r: any) => void> = {
    nothing: () => {}, keepSinging3s: (rig, i) => { rig.sing({ midi: MAN(MIDIS[i]), dur: 3, seed: 5 }, rig.t + 0.6, -24); },
    talk: (rig, i) => { rig.noise('talk' + i, () => speech(12, i), rig.t + 0.5, -22, 1); }, knock: (rig, i, r) => { rig.noise('kn' + i, () => bump('knock', i), rig.t + U(r, 0.5, 2), -14); rig.noise('th' + i, () => bump('thump', i), rig.t + U(r, 3, 5), -16, 2); },
    cough_chair: (rig, i, r) => { rig.noise('co' + i, () => bump('cough', i), rig.t + U(r, 0.5, 2), -16); rig.noise('ch' + i, () => bump('chair', i), rig.t + U(r, 3, 5), -18); },
  };
  const PH = [5, 11, 17, 24, 30];
  for (const [w, fn] of Object.entries(W)) { let n = 0, pass = 0, rn = 0, radv = 0; const where: string[] = [];
    for (const room of ['living', 'kitchen', 'bathroom', 'stairwell']) for (const i of PH) { const r = rng(i * 7 + room.length);
      { const rig = new Rig({ room, ref: -16, seed: i, from: i, beds: w === 'tv' ? [['tv', -30]] : [] }); rig.begin(); honest(rig, { seed: 3, noPlay: true }, i, i); if (rig.phase() === 'play') { const k0 = rig.advs.length; rig.expect = null; fn(rig, i, r); n++; rig.run(rig.t + 14, () => rig.advs.length > k0); if (rig.advs.length > k0) { pass++; where.push(`play:${room}@${i}`); } } }
      { const rig = new Rig({ room, ref: -16, seed: i, from: i }); rig.begin(); honest(rig, { seed: 3, noReview: true }, i, i); if (rig.phase() === 'review') { const k0 = rig.advs.length; rig.expect = null; fn(rig, i, r); rn++; rig.run(rig.t + 14); const k = rig.advs.length - k0; radv += k; if (k) where.push(`review:${room}@${i}x${k}`); } }
    }
    out({ build: B, test: 'nobody plays', what: w, playPass: pass, playN: n, reviewAdvances: radv, reviewTrials: rn, where }); }
}
