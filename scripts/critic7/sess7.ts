// Seventh review: honest full sessions (ported unchanged; the build argument is ignored — this repository is run).
// Honest full sessions. usage: node sess7.ts <build r6|r7> <style> [seed] [maxNotes]
import { Rig, load, envFor, sungMidi, med, pct, rng, stringFor, type Env, type Adv } from './rig7.ts';
import type { GOpts, VOpts } from './syn7.ts';
export interface Style {
  room: string; env?: Env; female?: boolean; g?: (midi: number, r: () => number) => Partial<GOpts>; gLevel?: [number, number];
  v?: (midi: number, r: () => number) => Partial<VOpts>; vLevel?: [number, number];
  think?: [number, number]; hold?: [number, number]; /** how long the voice goes on after the sing step is accepted */
  gap?: [number, number]; /** pluck this long after the voice stops (negative: while still singing) */
  ring?: boolean; reviewIOI?: [number, number]; cents?: [number, number];
}
const u = (r: () => number, [a, b]: [number, number]) => a + (b - a) * r();
export const STYLES: Record<string, Style> = {
  // steel-string, pick, baritone, ordinary living room
  A: { room: 'living', g: () => ({ kind: 'steel', pluck: 'pick' }), v: () => ({ vowel: 'a' }) },
  // classical guitar, fingers, female voice, small bedroom
  B: { room: 'bedroom', female: true, g: (_m, r) => ({ kind: 'nylon', pluck: r() < 0.5 ? 'finger' : 'thumb' }), v: () => ({ vowel: 'o', vib: 20 }), gLevel: [-20, -12] },
  // soft player with a strong voice, plucks as the voice ends, live room
  C: { room: 'live', g: () => ({ kind: 'steel', pluck: 'softpick', hard: 0.2 }), gLevel: [-24, -18], v: () => ({ vowel: 'a', vib: 25, onset: 'hard' }), vLevel: [-14, -9], gap: [-0.1, 0.35], hold: [0.2, 0.9] },
  // bare room, phone on a shelf, strings left ringing
  D: { room: 'bare', g: () => ({ kind: 'steel', pluck: 'pick', hard: 0.7 }), v: () => ({ vowel: 'e' }), ring: true },
  // dry, phone that compresses (voice-call style dynamics left on)
  E: { room: 'dry', env: { comp: { thr: -30, ratio: 4, attMs: 5, relMs: 250, makeup: 12 } }, g: () => ({ kind: 'steel', pluck: 'pick' }), v: () => ({ vowel: 'a' }) },
  // living room with a fan
  F: { room: 'living', env: { fanDb: -40 }, g: () => ({ kind: 'nylon', pluck: 'nail' }), v: () => ({ vowel: 'o' }) },
  // thin, pressed voice on a phone that rolls off the bass; finger plucks
  G: { room: 'bedroom', env: { hpHz: 240 }, g: () => ({ kind: 'steel', pluck: 'finger' }), v: () => ({ vowel: 'e', press: 0.95, breath: 0.06 }), vLevel: [-32, -26] },
  // wide vibrato singer, fretting-hand vibrato, live room
  H: { room: 'live', g: (m, r) => ({ kind: 'steel', pluck: 'pick', vib: stringFor(m).fret > 0 ? { cents: 12 + 10 * r(), hz: 5 + r() } : undefined }), v: () => ({ vowel: 'a', vib: 45, vibDelay: 0.2, am: 1.6 }), hold: [0.3, 1.2] },
  // quick student: plucks while still singing the answer
  I: { room: 'living', g: () => ({ kind: 'steel', pluck: 'pick' }), v: () => ({ vowel: 'a' }), gap: [-0.4, -0.05], hold: [0.5, 0.9] },
};
export interface Res { name: string; notes: number; playSteps: number; firstPluck: number; replucks: number; playStuck: number; singSteps: number; singFirst: number; singStuck: number; revNotes: number; revFirst: number; revStuck: number; bad: Adv[]; lat: number[]; singLat: number[]; revLat: number[]; hints: Record<string, number>; simSec: number; stuckAt: string[]; noPluck: number }
export async function honest(build: string, name: string, seed = 1, maxNotes = 0, from = 0, settings: Record<string, unknown> = {}): Promise<Res> {
  const st = STYLES[name]; const m = await load(build); const rig = new Rig(m, { ...envFor(st.room, st.env), seed: seed * 13 + 5, settings }); const r = rng(seed * 7 + 1);
  const res: Res = { name: `${build} ${name}(${st.room}) s${seed}`, notes: 0, playSteps: 0, firstPluck: 0, replucks: 0, playStuck: 0, singSteps: 0, singFirst: 0, singStuck: 0, revNotes: 0, revFirst: 0, revStuck: 0, bad: [], lat: [], singLat: [], revLat: [], hints: {}, simSec: 0, stuckAt: [], noPluck: 0 };
  const gopts = (midi: number): GOpts => { const k = Math.floor(r() * 2); const rr = rng(midi * 31 + k + seed * 977); return { midi, seed: midi * 31 + k + (seed % 3) * 1000, dur: 3, cents: Math.round(u(rr, st.cents ?? [-6, 10])), ...(st.g ? st.g(midi, rr) : {}) }; };
  const doPluck = (midi: number) => rig.pluck(gopts(midi), u(r, st.gLevel ?? [-18, -10]), r() * 0.02);
  rig.begin(from);
  let voiceEv: any = null; let voiceStopAt = Infinity;
  const tick = (sec: number, until?: (v: any) => boolean) => { const end = rig.t + sec; let v = rig.s.view(); while (rig.t < end) { if (voiceEv && rig.t >= voiceStopAt) { rig.stop(voiceEv, 70); voiceEv = null; voiceStopAt = Infinity; } v = rig.step(); if (v.phase === 'done' || (until && until(v))) break; } return v; };
  for (;;) {
    let v = tick(60, (q) => q.phase !== 'listen');
    if (v.phase === 'done') break;
    const idx = v.index; const target = v.targetMidi;
    if (maxNotes && idx - from >= maxNotes) break;
    if (v.phase === 'sing') {
      res.singSteps++;
      v = tick(u(r, st.think ?? [0.4, 1.0]), (q) => q.phase !== 'sing'); let ok = v.phase !== 'sing';
      for (let a = 0; a < 3 && !ok; a++) {
        const sm = sungMidi(target, st.female);
        const vo: VOpts = { midi: sm, dur: 6, female: st.female, seed: idx * 13 + a + seed * 101, scoop: 40 * r(), ...(st.v ? st.v(sm, r) : {}) };
        voiceEv = rig.sing(vo, u(r, st.vLevel ?? [-26, -18]), r() * 0.02); voiceStopAt = Infinity;
        v = tick(4.5, (q) => q.phase !== 'sing');
        if (v.phase !== 'sing') { ok = true; if (a === 0) res.singFirst++; break; }
        rig.stop(voiceEv, 70); voiceEv = null; v = tick(0.9, (q) => q.phase !== 'sing'); if (v.phase !== 'sing') ok = true;
      }
      if (!ok) { res.singStuck++; res.stuckAt.push(`sing#${idx + 1}`); rig.skip(); continue; }
      if (voiceEv) voiceStopAt = rig.t + u(r, st.hold ?? [0.05, 0.5]);
    }
    v = rig.s.view();
    if (v.phase === 'play' && v.index === idx) {
      res.playSteps++; const inPlay = (q: any) => q.phase === 'play';
      const gap = u(r, st.gap ?? [0.3, 1.2]);
      v = tick(Math.max(0.02, (voiceStopAt === Infinity ? 0 : voiceStopAt - rig.t) + gap), (q) => !inPlay(q));
      let ok = !inPlay(v); let k = 0;
      for (; k < 5 && !ok; k++) { doPluck(target); v = tick(2.5, (q) => !inPlay(q)); if (!inPlay(v)) ok = true; }
      if (ok && k === 1) res.firstPluck++;
      if (ok && k === 0) res.noPluck++;
      if (ok && k > 1) res.replucks += k - 1;
      if (!ok) { res.playStuck++; res.stuckAt.push(`play#${idx + 1}(${target})`); rig.skip(); continue; }
    }
    v = rig.s.view();
    if (v.phase === 'listen' && v.listenKind === 'phrase') { if (!st.ring) rig.damp(); v = tick(60, (q) => q.phase !== 'listen'); }
    if (v.phase === 'review' && v.index === idx) {
      const inRev = (q: any) => q.phase === 'review' && q.index === idx;
      v = tick(u(r, [0.5, 1.0]), (q) => !inRev(q));
      let stuck = false;
      while (inRev(v) && !stuck) {
        const pos = v.review.pos; const tgt = v.targetMidi; res.revNotes++; const same = (q: any) => inRev(q) && q.review.pos === pos;
        let k = 0; let ok = false;
        for (; k < 5 && !ok; k++) { doPluck(tgt); v = tick(2.5, (q) => !same(q)); ok = !same(v); }
        if (ok && k === 1) res.revFirst++;
        if (!ok) { res.revStuck++; res.stuckAt.push(`review#${idx + 1}pos${pos}(${tgt})`); rig.skip(); stuck = true; break; }
        if (inRev(v)) { const p2 = v.review.pos; v = tick(u(r, st.reviewIOI ?? [0.4, 0.7]), (q) => !(inRev(q) && q.review.pos === p2)); }
      }
    }
    if (!st.ring) rig.damp();
    res.notes++;
  }
  for (const a of rig.log) { if (!a.legit) res.bad.push(a); else if (a.lat !== undefined) (a.phase === 'play' ? res.lat : a.phase === 'sing' ? res.singLat : res.revLat).push(a.lat); }
  res.hints = rig.hints; res.simSec = rig.t; return res;
}
export function line(r: Res): string {
  return `${r.name.padEnd(22)} play ${r.firstPluck}/${r.playSteps - r.noPluck} first (${r.noPluck} adv w/o pluck), +${r.replucks} repl, ${r.playStuck} stuck | sing ${r.singFirst}/${r.singSteps}, ${r.singStuck} stuck | review ${r.revFirst}/${r.revNotes}, ${r.revStuck} stuck | BAD ${r.bad.length} (sing ${r.bad.filter((b) => b.phase === 'sing').length} play ${r.bad.filter((b) => b.phase === 'play').length} rev ${r.bad.filter((b) => b.phase === 'review').length}) | play lat med ${med(r.lat).toFixed(0)} p90 ${pct(r.lat, 0.9).toFixed(0)} max ${Math.max(...r.lat).toFixed(0)}; rev med ${med(r.revLat).toFixed(0)}; sing med ${med(r.singLat).toFixed(0)} | ${(r.simSec / 60).toFixed(1)} min`;
}
if (process.argv[1]?.endsWith('sess7.ts')) {
  const [build, name, seed, maxN] = process.argv.slice(2); const t0 = Date.now();
  const settings = process.env.SETTINGS ? JSON.parse(process.env.SETTINGS) : {};
  const r = await honest(build, name, Number(seed ?? 1), Number(maxN ?? 0), Number(process.env.FROM ?? 0), settings);
  console.log(line(r)); for (const b of r.bad.slice(0, 12)) console.log(`   BAD note ${b.index + 1} ${b.phase}${b.pos >= 0 ? ' pos ' + b.pos : ''} target ${b.target}: ${b.why}`);
  console.log('   stuck:', r.stuckAt.join(' ') || '-', '| hints', JSON.stringify(r.hints), `| wall ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log('JSON ' + JSON.stringify({ name: r.name, fp: r.firstPluck, ps: r.playSteps - r.noPluck, np: r.noPluck, repl: r.replucks, pstuck: r.playStuck, sf: r.singFirst, ss: r.singSteps, sstuck: r.singStuck, rf: r.revFirst, rn: r.revNotes, rstuck: r.revStuck, bad: r.bad.length, badSing: r.bad.filter((b) => b.phase === 'sing').length, badPlay: r.bad.filter((b) => b.phase === 'play').length, badRev: r.bad.filter((b) => b.phase === 'review').length, lat: r.lat.map((x) => Math.round(x)), revLat: r.revLat.map((x) => Math.round(x)) }));
}
