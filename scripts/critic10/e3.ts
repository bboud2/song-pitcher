// Tenth review (ported unchanged except for where it finds the build).
// @ts-nocheck (ported review tooling, kept as written)
// E3: phrase review, repeated notes. Start at the phrase's last note, play it honestly, then the review.
import { Rig, MIDIS, SONG, manMidi, honestNote, stringFor } from './rig10.ts';
const ROOMS = (process.argv[2] ?? 'dry,living,garage').split(',');
const BEH = (process.argv[3] ?? '').split(',').filter(Boolean);
const PH = SONG.phrases.filter((p: any) => { for (let i = p.start + 1; i <= p.end; i++) if (MIDIS[i] === MIDIS[i - 1]) return true; return MIDIS[p.start] === MIDIS[p.end]; });
type St = { style?: string; db: number; gap?: number; other?: boolean; none?: boolean; prevDb?: number };
const B: Record<string, St> = {
  same: { db: -14 }, soft8: { db: -22 }, soft12: { db: -26 }, finger: { style: 'finger', db: -16 }, thumb: { style: 'thumb', db: -16 },
  quick: { db: -14, gap: 0.12 }, quickSoft: { db: -20, gap: 0.12 }, otherString: { db: -14, other: true }, otherStringSoft: { db: -20, other: true }, hammer: { style: 'hammer', db: -20 },
  loudThenSoft: { db: -24, prevDb: -8 }, fingerAll: { style: 'finger', db: -18, prevDb: -18 }, none: { db: 0, none: true },
};
for (const beh of BEH.length ? BEH : Object.keys(B)) for (const room of ROOMS) for (const p of PH) for (const rep of [0, 1]) {
  const st = B[beh]; const seed = p.start * 5 + room.length + rep * 100;
  const rig = new Rig({ room, seed, spkDb: -14 });
  rig.begin(p.end); if (!honestNote(rig, seed) || rig.phase() !== 'review') { console.log(JSON.stringify({ beh, room, p: p.start, setupFail: true, ph: rig.phase() })); continue; }
  let nextAt = rig.t + 0.8; const n = p.end - p.start + 1; let fail = false;
  for (let k = 0; k < n && !fail; k++) {
    const m = MIDIS[p.start + k]; const prev = k > 0 ? MIDIS[p.start + k - 1] : MIDIS[p.end]; const isRep = m === prev; const nextRep = k + 1 < n && MIDIS[p.start + k + 1] === m;
    const pos = () => (rig.phase() === 'review' && rig.s.view().index === p.end ? rig.s.view().review.pos : 99);
    const res: any = { beh, room, p: p.start, k, m, rep: isRep, first: false, lat: null, stuck: false, bad: false };
    if (isRep && st.none) { rig.run(rig.t + 5, () => pos() !== k); res.bad = pos() !== k; if (res.bad) res.badAfter = Math.round((rig.t - nextAt + 0.6) * 1000); nextAt = rig.t + 0.3; if (res.bad) { console.log(JSON.stringify(res)); nextAt = rig.t + 0.5; continue; } }
    let at = isRep && st.gap !== undefined ? Math.max(rig.t + 0.02, nextAt - 0.45 + st.gap) : nextAt;
    const o: any = { midi: m, seed: seed + k, style: isRep && !st.none ? (st.style ?? 'pick') : beh === 'fingerAll' ? 'finger' : 'pick' };
    const db = isRep && !st.none ? st.db : nextRep && st.prevDb !== undefined ? st.prevDb : -14;
    rig.pluck(o, at, db, isRep && st.other ? stringFor(m) + 10 : undefined);
    rig.run(at + 1.6, () => pos() !== k);
    if (pos() !== k) { res.first = !(isRep && st.none); res.lat = Math.round((rig.t - at) * 1000); }
    else { let ok = false; for (let q = 0; q < 2 && !ok; q++) { at = rig.t + 0.3; rig.pluck({ midi: m, seed: seed + k + 50 + q }, at, -12); rig.run(at + 1.6, () => pos() !== k); ok = pos() !== k; } res.stuck = !ok; res.hints = [...rig.hints]; if (!ok) fail = true; }
    console.log(JSON.stringify(res)); nextAt = rig.t + 0.45;
  }
}
