// @ts-nocheck (ported review tooling, kept as written)
// Eleventh review (ported unchanged except for where it finds the build).
// Tuner core (TuneWatch + StablePitch as src/main.ts tunerScreen drives them). usage: BUILD_DIR=.. node e4.ts <test>
import { Rig, E, TW, SR, HOP, hz } from './rig11.ts';
const M = await import(`${process.env.BUILD_DIR}/src/core/matcher.ts`);
const OPEN = [40, 45, 50, 55, 59, 64]; const NAMES = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];
function mk(env: any = {}) { const rig = new Rig({ room: 'lounge', spk: null, ...env }); const watch = new TW.TuneWatch(); const stable = new M.StablePitch(); const msgs: { t: number; m: string | null }[] = []; let last: any = undefined;
  const run = (until: number) => { while (rig.t < until) { rig.sa.push(rig.render()); rig.n += HOP; if (rig.n < E.FRAME_SIZE) continue; rig.sa.frame('voice', rig.t); const f = rig.sa.frame('guitar', rig.t); const db = 20 * Math.log10(Math.max(f.rms, 1e-6)); const m = stable.push(f); watch.push(f.t, m, db, f.attacks ?? [], f.tiltDb ?? null); const msg = watch.message(); if (msg !== last) { msgs.push({ t: +rig.t.toFixed(2), m: msg }); last = msg; } } };
  return { rig, watch, run, msgs, msg: () => watch.message() }; }
const test = process.argv[2];
const tally: Record<string, [number, number]> = {}; const bump = (k: string, ok: boolean) => { tally[k] ??= [0, 0]; tally[k][1]++; if (ok) tally[k][0]++; };
const examples: string[] = [];
if (test === 'sung') {
  for (const midi of [48, 53, 57, 60, 62, 65]) for (const on of ['smooth', 'hard', 'da', 'la']) for (const fade of [0, 8]) { const x = mk(); for (let k = 0; k < 3; k++) x.rig.sing({ midi, dur: 1.2, on, fade, seed: k + 1 }, 1 + k * 2, -22); x.run(8); const any = x.msgs.some((q) => q.m); bump('sung note gets a message (want 0)', any); if (any) examples.push(`${midi} ${on} fade${fade}: ${x.msgs.find((q) => q.m)!.m}`); }
}
if (test === 'open' || test === 'openagc') {
  for (const kind of ['steel', 'nylon']) for (const touch of ['pick', 'finger', 'thumb']) for (const s of [0, 2, 5]) for (const cents of [-200, -100, -60, -45, -30, 0, 10, 30, 45, 60, 100, 200]) for (const lvl of [-16, -28]) {
    if (lvl === -28 && (kind !== 'steel' || touch === 'pick')) continue;
    const x = mk(test === 'openagc' ? { agc: true } : {}); for (let k = 0; k < 4; k++) x.rig.pluck({ midi: OPEN[s], cents, kind, touch, seed: k + 1, dur: 3 }, 1 + k * 2.2, lvl); x.run(1 + 3 * 2.2 + 1.5);
    const m = x.msg(); const key = `${kind} ${touch} lvl${lvl}`;
    if (Math.abs(cents) <= 10) { bump(`${key}: in-tune string, no message`, m === null); if (m) examples.push(`${key} ${NAMES[s]} ${cents}: ${m}`); }
    else { const dir = cents > 0 ? 'sharp' : 'flat'; const ok = m !== null && m.includes(dir) && (m.includes(NAMES[s] + ' string') || m.includes('open ' + NAMES[s])); const grp = Math.abs(cents) >= 100 ? '>=100c' : '30-60c'; bump(`${key}: ${grp} off string warned (right string+direction) after 3 plucks`, ok); if (!ok && examples.length < 60) examples.push(`${key} ${NAMES[s]} ${cents}: ${m}`); }
  }
}
if (test === 'fret') {
  for (const kind of ['steel', 'nylon']) for (const touch of ['pick', 'finger', 'thumb']) for (const midi of [48, 52, 53, 57, 60, 62, 65, 67]) { const x = mk(); for (let k = 0; k < 4; k++) x.rig.pluck({ midi, kind, touch, seed: k + 1, dur: 3 }, 1 + k * 2.2, -16); x.run(1 + 3 * 2.2 + 1.5); const m = x.msg(); bump(`${kind} ${touch}: fretted note said to be a non-open note (neutral), no out-of-tune warning`, m !== null && m.startsWith('That is')); bump(`${kind} ${touch}: fretted note wrongly warned as string out of tune (want 0)`, m !== null && !m.startsWith('That is')); if (!m || !m.startsWith('That is')) examples.push(`${kind} ${touch} ${midi}: ${m}`); }
}
if (test === 'tuneup') {
  for (const touch of ['pick', 'thumb']) for (const s of [1, 3, 5]) { const x = mk(); const seq = [-100, -100, -100, -80, -60, -45, -30, -15, -5, 0, 0]; const line: string[] = []; seq.forEach((c, k) => { x.rig.pluck({ midi: OPEN[s], cents: c, touch, seed: k + 1, dur: 3 }, 1 + k * 2, -16); x.run(1 + k * 2 + 1.9); line.push(`${c}c -> ${x.msg() ?? '(none)'}`); }); console.log(`--- ${touch} ${NAMES[s]}\n` + line.join('\n')); }
}
for (const [k, [a, b]] of Object.entries(tally)) console.log(`${k}: ${a}/${b}`);
console.log(examples.slice(0, 40).join('\n'));
