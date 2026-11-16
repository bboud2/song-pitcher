// @ts-nocheck (ported review tooling, kept as written)
// Eleventh review (ported unchanged except for where it finds the build).
// Full 101-note sessions with an honest student. usage: BUILD_DIR=.. node e3.ts <profile> [maxNotes]
import { Rig, MIDIS, SONG, man, woman, child, rng, med } from './rig11.ts';
const P: Record<string, any> = {
  P1: { room: 'lounge', spk: -14, oct: man, v: {}, vDb: -24, g: { kind: 'steel', touch: 'pick' }, gDb: -14, ring: true },
  P2: { room: 'hall', spk: -10, oct: woman, v: { woman: true, vowel: 'oh', on: 'la' }, vDb: -26, g: { kind: 'steel', touch: 'finger' }, gDb: -17, ring: false },
  P3: { room: 'bath', spk: -8, oct: man, v: { vowel: 'oo' }, vDb: -32, g: { kind: 'nylon', touch: 'thumb' }, gDb: -18, ring: true },
  P4: { room: 'bedroom', spk: -14, agc: true, oct: child, v: { child: true, on: 'la', fade: 8 }, vDb: -24, maxHold: 1.0, g: { kind: 'steel', touch: 'pick' }, gDb: -9, ring: true },
  P5: { room: 'stair', spk: -12, oct: (m) => (m >= 55 ? m - 12 : m), v: { vowel: 'oh' }, vDb: -22, g: { kind: 'electric', touch: 'pick' }, gDb: -14, ring: true },
  P6: { room: 'kitchen', spk: -12, oct: man, v: { on: 'ha', fade: 4 }, vDb: -26, early: 0.4, g: { kind: 'steel', touch: 'finger' }, gDb: -22, ring: true },
  P7: { room: 'dead', spk: -20, floor: -50, oct: woman, v: { woman: true, vibC: 45, vowel: 'ee' }, vDb: -22, g: { kind: 'nylon', touch: 'finger' }, gDb: -16, ring: false },
  P8: { room: 'church', spk: -6, oct: man, v: { on: 'da' }, vDb: -22, g: { kind: 'steel', touch: 'pick' }, gDb: -12, ring: true },
};
const name = process.argv[2]; const p = P[name]; const maxNotes = +(process.argv[3] ?? 101);
const r = rng(name.charCodeAt(1) * 13); const U = (a: number, b: number) => a + (b - a) * r();
const rig = new Rig({ room: p.room, spk: p.spk, agc: p.agc, floor: p.floor, seed: name.charCodeAt(1) });
rig.begin(0);
const st = { sing: { n: 0, first: 0, stuck: 0, lat: [] as number[] }, play: { n: 0, first: 0, stuck: 0, lat: [] as number[] }, review: { n: 0, first: 0, stuck: 0, lat: [] as number[] } };
const acc: string[] = []; const notes: string[] = []; let nAdv = 0;
// any advance before the student's sound for that step = accidental
function watch(expectOn: number, label: string) { for (; nAdv < rig.advs.length; nAdv++) { const a = rig.advs[nAdv]; if (a.t < expectOn + 0.04) acc.push(`${label} ${a.phase}${a.index}${a.pos >= 0 ? '.' + a.pos : ''} adv@${(a.t - expectOn).toFixed(2)} reason=${a.reason}`); } }
let lastSing: any = null; let pre: any = null;
if (p.early) rig.onRef = (ref, open) => { const i = rig.idx(); const start = open - p.early * r(); const hold = p.maxHold ?? 3.2; pre = { start, hold, ev: rig.sing({ midi: p.oct(MIDIS[i]), dur: hold + 0.5, seed: i * 3 + 1, ...p.v }, start, p.vDb + U(-2, 2)) }; };
while (rig.phase() !== 'done' && rig.idx() < maxNotes) {
  const i = rig.idx(); const tg = MIDIS[i];
  rig.run(rig.t + 12, () => rig.phase() !== 'listen');
  if (rig.phase() === 'sing') {
    const open = rig.openT; let done = false; st.sing.n++;
    for (let k = 1; k <= 3 && !done; k++) {
      let start: number, hold: number, ev: any;
      if (k === 1 && pre) { ({ start, hold, ev } = pre); pre = null; start = Math.max(start, open); }
      else { start = k === 1 ? open + U(0.25, 0.9) : rig.t + U(0.8, 1.2); hold = p.maxHold ?? 3.2; ev = rig.sing({ midi: p.oct(tg), dur: hold, seed: i * 3 + k, ...p.v }, start, p.vDb + U(-2, 2)); }
      rig.run(start, () => rig.phase() !== 'sing'); watch(start, 'pre-voice');
      rig.run(start + hold + 0.4, () => rig.phase() !== 'sing');
      if (rig.phase() !== 'sing') { done = true; nAdv = rig.advs.length; st.sing.lat.push(1000 * (rig.t - start)); if (k === 1) st.sing.first++; else notes.push(`sing ${i} (midi ${tg}) accepted on try ${k}; hints ${rig.hints.join(',')}`); rig.stop(ev, rig.t + U(0.1, 0.35), 90); lastSing = ev; }
      else notes.push(`sing ${i} try ${k} refused; hints ${rig.hints.join(',')}`);
    }
    if (!done) { st.sing.stuck++; notes.push(`STUCK sing ${i} (midi ${tg})`); rig.s.skip(); rig.stage = 'delay'; rig.left = 0.3; nAdv = rig.advs.length; continue; }
  }
  if (rig.phase() === 'play' && rig.idx() === i) {
    let done = false; st.play.n++;
    for (let k = 1; k <= 3 && !done; k++) {
      const on = rig.t + (k === 1 ? U(0.7, 1.3) : U(0.5, 0.9));
      rig.run(on, () => rig.phase() !== 'play' || rig.idx() !== i); watch(on, 'pre-pluck');
      if (rig.phase() !== 'play' || rig.idx() !== i) { done = true; break; }
      rig.pluck({ midi: tg, cents: Math.round(U(-8, 12)), seed: i * 5 + k, ...p.g }, on, p.gDb + U(-3, 3));
      rig.run(on + 2.6, () => rig.phase() !== 'play' || rig.idx() !== i);
      if (rig.phase() !== 'play' || rig.idx() !== i) { done = true; nAdv = rig.advs.length; st.play.lat.push(1000 * (rig.t - on)); if (k === 1) st.play.first++; else notes.push(`play ${i} (midi ${tg}) accepted on try ${k}; hints ${rig.hints.join(',')}`); }
      else notes.push(`play ${i} try ${k} refused; hints ${rig.hints.join(',')}`);
    }
    if (!done) { st.play.stuck++; notes.push(`STUCK play ${i} (midi ${tg})`); rig.s.skip(); rig.stage = 'delay'; rig.left = 0.3; nAdv = rig.advs.length; continue; }
    if (!p.ring && rig.phase() !== 'review') rig.damp(rig.t + U(0.2, 0.5));
  }
  if (rig.phase() === 'review') {
    const ph = rig.s.view().review.phrase; let last = rig.t + U(0.9, 1.5) - 10; let stuck = false;
    for (let k = ph.start; k <= ph.end && !stuck; k++) {
      const pos = k - ph.start; const gap = k === ph.start ? 0 : Math.max(0.42, SONG.notes[k - 1].beats * 60 / SONG.bpm * 1.4);
      let ok = false; st.review.n++;
      for (let a = 1; a <= 3 && !ok; a++) {
        const on = Math.max(rig.t + (k === ph.start && a === 1 ? U(0.9, 1.5) : 0.05), last + gap);
        const still = () => rig.phase() === 'review' && rig.s.view().review?.pos === pos && rig.idx() === i;
        rig.run(on, () => !still()); watch(on, 'pre-pluck(review)');
        if (!still()) { ok = true; break; }
        rig.pluck({ midi: MIDIS[k], cents: Math.round(U(-8, 12)), seed: k * 5 + a + 50, ...p.g }, on, p.gDb + U(-3, 3)); last = on;
        rig.run(on + Math.max(1.2, gap), () => !still());
        if (!still()) { ok = true; nAdv = rig.advs.length; st.review.lat.push(1000 * (rig.t - on)); if (a === 1) st.review.first++; else notes.push(`review ${i}.${pos} (midi ${MIDIS[k]}${k > ph.start && MIDIS[k] === MIDIS[k - 1] ? ' REPEAT' : ''}) on try ${a}; hints ${rig.hints.join(',')}`); }
        else notes.push(`review ${i}.${pos} (midi ${MIDIS[k]}${k > ph.start && MIDIS[k] === MIDIS[k - 1] ? ' REPEAT' : ''}) try ${a} refused; hints ${rig.hints.join(',')}`);
      }
      if (!ok) { stuck = true; st.review.stuck++; notes.push(`STUCK review ${i}.${pos}`); rig.s.skip(); rig.stage = 'delay'; rig.left = 0.3; nAdv = rig.advs.length; }
    }
    if (!p.ring) rig.damp(rig.t + 0.3);
  }
}
const oct = rig.advs.filter((a) => a.det !== null && a.phase !== 'sing' && Math.abs(a.det - a.target) > 0.6).length;
const f = (s: any) => `${s.first}/${s.n} first, ${s.stuck} stuck, lat med ${Math.round(med(s.lat))} p90 ${Math.round(med(s.lat, 0.9))}`;
console.log(JSON.stringify({ profile: name, build: process.env.BUILD_DIR!.split('/').pop(), reached: rig.idx(), audioMin: +(rig.t / 60).toFixed(1), sing: f(st.sing), play: f(st.play), review: f(st.review), accidental: acc, wrongPitchAccepts: oct, notes }, null, 1));
