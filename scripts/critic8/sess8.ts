// Eighth review (ported unchanged).
// @ts-nocheck (ported review tooling, kept as written)
// Critic-8 honest sessions. usage: BUILD_DIR=... node sess8.ts <style> [seed] [maxNotes] [from]
import { Rig, med, pct, rng, stringFor, type Env, type Adv } from './rig8.ts';
import type { GOpts, VOpts } from './syn8.ts';
type R = () => number;
export interface Style {
  env: Env; voiceKind: 'male' | 'female' | 'child';
  g: (midi: number, r: R) => Partial<GOpts>; gLevel?: [number, number]; v: (midi: number, r: R) => Partial<VOpts>; vLevel?: [number, number];
  think?: [number, number]; hold?: [number, number]; gap?: [number, number]; ring?: boolean; cents?: [number, number]; reviewIOI?: [number, number];
  hunt?: number; /** probability of plucking wrong notes before the right one */ singWrong?: number; /** probability of first singing a wrong pitch */
  stac?: number; /** damp each plucked note after this many seconds */ replGap?: number;
}
const u = (r: R, [a, b]: [number, number]) => a + (b - a) * r();
export const STYLES: Record<string, Style> = {
  // 1 dreadnought, pick, bedroom, good phone, man singing "la"
  s1: { env: { room: 'bed', phone: 'pixel', spk: -22 }, voiceKind: 'male', g: () => ({ kind: 'dread', pluck: 'pick' }), v: () => ({ vowel: 'a', cons: 'l' }) },
  // 2 classical guitar, thumb, living room with the phone on the table, iPhone with voice processing, woman humming
  s2: { env: { room: 'table', phone: 'iphoneVP', spk: -20 }, voiceKind: 'female', g: (_m, r) => ({ kind: 'nylon', pluck: r() < 0.6 ? 'thumb' : 'finger' }), gLevel: [-22, -14], v: () => ({ vowel: 'm', tract: 1.17, oq: 0.65 }), vLevel: [-28, -20] },
  // 3 small parlor guitar, fingers, kitchen, budget phone, child "doo"
  s3: { env: { room: 'kitchen', phone: 'budget', spk: -16 }, voiceKind: 'child', g: () => ({ kind: 'parlor', pluck: 'finger' }), v: () => ({ vowel: 'u', cons: 'd', tract: 1.35, oq: 0.7, tilt: 3 }), vLevel: [-22, -14] },
  // 4 old dead strings, pick, bedroom, earbuds' hands-free mic, breathy falsetto-ish man on "oo"
  s4: { env: { room: 'bed', phone: 'airpods', spk: null }, voiceKind: 'male', g: (m) => ({ kind: 'dead', pluck: 'pick', buzz: stringFor(m).fret > 0 ? 0.25 : 0 }), v: () => ({ vowel: 'u', tilt: 7, breath: 0.12, oq: 0.75 }), vLevel: [-26, -18] },
  // 5 unplugged electric, dry room, hum on the line
  s5: { env: { room: 'dry', phone: 'hum', spk: -24 }, voiceKind: 'male', g: () => ({ kind: 'electric', pluck: 'pick', hard: 0.4 }), gLevel: [-30, -24], v: () => ({ vowel: 'o', cons: 'n' }) },
  // 6 hunter: finds the note by trial and error, lets strings ring, living room
  s6: { env: { room: 'table', phone: 'pixel', spk: -22 }, voiceKind: 'male', g: () => ({ kind: 'dread', pluck: 'pick' }), v: () => ({ vowel: 'a' }), hunt: 0.6, ring: true, singWrong: 0.3 },
  // 7 quick student: plucks while still singing; nylon, nail, woman "la", vibrato
  s7: { env: { room: 'bed', phone: 'tablet', spk: -22 }, voiceKind: 'female', g: () => ({ kind: 'nylon', pluck: 'nail' }), v: () => ({ vowel: 'a', cons: 'l', tract: 1.17, vib: 30 }), gap: [-0.5, -0.05], hold: [0.6, 1.0] },
  // 8 creaky-onset voice, squeaks and buzz, TV on in the background, kitchen
  s8: { env: { room: 'kitchen', phone: 'pixel', spk: -20, tvDb: -36 }, voiceKind: 'male', g: (m, r) => ({ kind: 'dread', pluck: 'pick', hard: 0.8, squeak: stringFor(m).fret > 0 && r() < 0.5, buzz: r() < 0.3 ? 0.3 : 0 }), v: () => ({ vowel: 'e', creak: 0.18, scoop: 80, scoopMs: 250 }) },
  s8a: { env: { room: 'kitchen', phone: 'pixel', spk: -20 }, voiceKind: 'male', g: (m, r) => ({ kind: 'dread', pluck: 'pick', hard: 0.8, squeak: stringFor(m).fret > 0 && r() < 0.5, buzz: r() < 0.3 ? 0.3 : 0 }), v: () => ({ vowel: 'e', creak: 0.18, scoop: 80, scoopMs: 250 }) },
  s8b: { env: { room: 'kitchen', phone: 'pixel', spk: -20, tvDb: -36 }, voiceKind: 'male', g: () => ({ kind: 'dread', pluck: 'pick', hard: 0.8 }), v: () => ({ vowel: 'e' }) },
  s8c: { env: { room: 'bed', phone: 'pixel', spk: -20, tvDb: -36 }, voiceKind: 'male', g: () => ({ kind: 'dread', pluck: 'pick', hard: 0.8 }), v: () => ({ vowel: 'e', creak: 0.18, scoop: 80, scoopMs: 250 }) },
  s8d: { env: { room: 'bed', phone: 'pixel', spk: -20, tvDb: -30, tvFemale: true }, voiceKind: 'female', g: () => ({ kind: 'dread', pluck: 'pick' }), v: () => ({ vowel: 'a', tract: 1.17 }) },
  // 9 bathroom echo, staccato player (damps each note after 0.3 s), sharp-fretting beginner
  s9: { env: { room: 'bath', phone: 'pixel', spk: -18 }, voiceKind: 'male', g: () => ({ kind: 'parlor', pluck: 'pick' }), v: () => ({ vowel: 'o' }), stac: 0.3, cents: [0, 28] },
  // 10 soft thumb on a nylon guitar far from a noisy budget phone, quiet shy voice
  s10: { env: { room: 'table', phone: 'budget', spk: -20 }, voiceKind: 'female', g: () => ({ kind: 'nylon', pluck: 'thumb', hard: 0.2 }), gLevel: [-30, -24], v: () => ({ vowel: 'o', tract: 1.17, breath: 0.1, atkMs: 150 }), vLevel: [-34, -28] },
};
export interface Res { name: string; notes: number; playSteps: number; firstPluck: number; replucks: number; playStuck: number; singSteps: number; singFirst: number; singStuck: number; revNotes: number; revFirst: number; revStuck: number; bad: Adv[]; lat: number[]; singLat: number[]; revLat: number[]; hints: Record<string, number>; simSec: number; stuckAt: string[]; noPluck: number; wrongPlucks: number; wrongSung: number }
export function sungMidi(target: number, k: string) { if (k === 'male') return target > 60 ? target - 12 : target; if (k === 'female') return target < 57 ? target + 12 : target; return target < 62 ? target + 12 : target; }
export function honest(name: string, seed = 1, maxNotes = 0, from = 0): Res {
  const st = STYLES[name]; const rig = new Rig({ ...st.env, seed: seed * 17 + 3 }); const r = rng(seed * 11 + 5);
  const res: Res = { name: `${name} s${seed}`, notes: 0, playSteps: 0, firstPluck: 0, replucks: 0, playStuck: 0, singSteps: 0, singFirst: 0, singStuck: 0, revNotes: 0, revFirst: 0, revStuck: 0, bad: [], lat: [], singLat: [], revLat: [], hints: {}, simSec: 0, stuckAt: [], noPluck: 0, wrongPlucks: 0, wrongSung: 0 };
  const gopts = (midi: number): GOpts => { const k = Math.floor(r() * 3); const rr = rng(midi * 37 + k + seed * 911); return { midi, seed: midi * 37 + k + (seed % 4) * 1000, dur: 3, cents: Math.round(u(rr, st.cents ?? [-8, 12])), ...st.g(midi, rr) }; };
  let lastPl: any = null; let stacAt = Infinity;
  const doPluck = (midi: number, ok = true) => { lastPl = rig.pluck(gopts(midi), u(r, st.gLevel ?? [-18, -10]), r() * 0.02, ok); if (st.stac) stacAt = rig.t + st.stac + 0.03; };
  rig.begin(from);
  if (process.env.TRACE) { const [ti, tp] = process.env.TRACE.split(':'); const f2m = (f: number) => 69 + 12 * Math.log2(f / 440); const orig = rig.s.pitch.bind(rig.s); rig.s.pitch = (fr: any) => { const b = rig.s.view(); const a = orig(fr); if (b.index === Number(ti) - 1 && b.phase === tp) { const m = rig.s.view().match; console.log(`${fr.t.toFixed(2)} ${fr.freq > 0 ? f2m(fr.freq).toFixed(2) : '--'} cl ${fr.clarity.toFixed(2)} rms ${(20 * Math.log10(fr.rms + 1e-9)).toFixed(0)} voices ${rig.voices.filter((q) => q.t0 < fr.t && fr.t < q.t1 + 0.3).map((q) => q.midi.toFixed(1)).join(',')} ring ${rig.ringing().join(',')} ${m?.hint ?? ''} ${a ? 'ACCEPT ' + JSON.stringify(rig.s.lastAccepted, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v) : ''}`); } return a; }; }
  let voiceEv: any = null; let voiceStopAt = Infinity;
  const tick = (sec: number, until?: (v: any) => boolean) => { const end = rig.t + sec; let v = rig.s.view(); while (rig.t < end) { if (voiceEv && rig.t >= voiceStopAt) { rig.stop(voiceEv, 70); voiceEv = null; voiceStopAt = Infinity; } if (rig.t >= stacAt) { rig.stop(lastPl, 40); stacAt = Infinity; } v = rig.step(); if (v.phase === 'done' || (until && until(v))) break; } return v; };
  for (;;) {
    let v = tick(60, (q) => q.phase !== 'listen');
    if (v.phase === 'done') break;
    const idx = v.index; const target = v.targetMidi;
    if (maxNotes && idx - from >= maxNotes) break;
    if (v.phase === 'sing') {
      res.singSteps++;
      v = tick(u(r, st.think ?? [0.4, 1.0]), (q) => q.phase !== 'sing'); let ok = v.phase !== 'sing';
      const sm = sungMidi(target, st.voiceKind);
      if (!ok && st.singWrong && r() < st.singWrong) { // tries a wrong pitch first, hears it is wrong, stops
        const off = [-4, -3, -2, 2, 3, 4, 5, -5][Math.floor(r() * 8)]; res.wrongSung++;
        voiceEv = rig.sing({ midi: sm + off, dur: 1.2, seed: idx * 7 + seed, ...st.v(sm + off, r) }, u(r, st.vLevel ?? [-26, -18])); v = tick(1.6, (q) => q.phase !== 'sing'); voiceEv = null; ok = v.phase !== 'sing'; if (!ok) v = tick(0.4, (q) => q.phase !== 'sing');
      }
      for (let a = 0; a < 3 && !ok; a++) {
        const vo: VOpts = { midi: sm, dur: 6, seed: idx * 13 + a + seed * 101, scoop: 50 * r(), cents: Math.round(30 * (r() - 0.5)), ...st.v(sm, r) };
        voiceEv = rig.sing(vo, u(r, st.vLevel ?? [-26, -18]), r() * 0.02); voiceStopAt = Infinity;
        v = tick(4.5, (q) => q.phase !== 'sing');
        if (v.phase !== 'sing') { ok = true; if (a === 0) res.singFirst++; break; }
        rig.stop(voiceEv, 70); voiceEv = null; v = tick(0.9, (q) => q.phase !== 'sing'); if (v.phase !== 'sing') ok = true;
      }
      if (!ok) { res.singStuck++; res.stuckAt.push(`sing#${idx + 1}(${target}->${sm})`); rig.skip(); continue; }
      if (voiceEv) voiceStopAt = rig.t + u(r, st.hold ?? [0.05, 0.5]);
    }
    v = rig.s.view();
    if (v.phase === 'play' && v.index === idx) {
      res.playSteps++; const inPlay = (q: any) => q.phase === 'play';
      const gap = u(r, st.gap ?? [0.3, 1.2]);
      v = tick(Math.max(0.02, (voiceStopAt === Infinity ? 0 : voiceStopAt - rig.t) + gap), (q) => !inPlay(q));
      let ok = !inPlay(v); let k = 0;
      if (!ok && st.hunt && r() < st.hunt) { const nW = 1 + Math.floor(r() * 3); let last = 0;
        for (let w = 0; w < nW && !ok; w++) { let off = 0; for (let tries = 0; tries < 20; tries++) { off = [-2, -1, 1, 2, 5, -5, 7, -7, 12, -12, 3, -3][Math.floor(r() * 12)]; if (target + off >= 40 && target + off <= 72 && off !== last) break; } last = off; res.wrongPlucks++; doPluck(target + off, false); v = tick(u(r, [0.6, 1.3]), (q) => !inPlay(q)); ok = !inPlay(v); }
        if (ok) k = -1; }
      for (; k >= 0 && k < 5 && !ok; k++) { doPluck(target); v = tick(st.replGap ?? 2.5, (q) => !inPlay(q)); if (!inPlay(v)) ok = true; }
      if (ok && k === 1) res.firstPluck++;
      if (ok && k === 0) res.noPluck++;
      if (ok && k > 1) { res.replucks += k - 1; res.stuckAt.push(`repl#${idx + 1}(${target})x${k - 1}`); }
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
  return `${r.name.padEnd(8)} play ${r.firstPluck}/${r.playSteps - r.noPluck} first (${r.noPluck} adv w/o right pluck), +${r.replucks} repl, ${r.playStuck} stuck | sing ${r.singFirst}/${r.singSteps}, ${r.singStuck} stuck | review ${r.revFirst}/${r.revNotes}, ${r.revStuck} stuck | BAD ${r.bad.length} (sing ${r.bad.filter((b) => b.phase === 'sing').length} play ${r.bad.filter((b) => b.phase === 'play').length} rev ${r.bad.filter((b) => b.phase === 'review').length}) of wrongPl ${r.wrongPlucks} wrongSung ${r.wrongSung} | play lat med ${med(r.lat).toFixed(0)} p90 ${pct(r.lat, 0.9).toFixed(0)} max ${Math.max(...r.lat).toFixed(0)}; rev med ${med(r.revLat).toFixed(0)} p90 ${pct(r.revLat, 0.9).toFixed(0)}; sing med ${med(r.singLat).toFixed(0)} p90 ${pct(r.singLat, 0.9).toFixed(0)} | ${(r.simSec / 60).toFixed(1)} min`;
}
if (process.argv[1]?.endsWith('sess8.ts')) {
  const [name, seed, maxN, from] = process.argv.slice(2); const t0 = Date.now();
  const r = honest(name, Number(seed ?? 1), Number(maxN ?? 0), Number(from ?? 0));
  console.log(line(r)); for (const b of r.bad.slice(0, 15)) console.log(`   BAD note ${b.index + 1} ${b.phase}${b.pos >= 0 ? ' pos ' + b.pos : ''} target ${b.target}: ${b.why}`);
  console.log('   stuck:', r.stuckAt.join(' ') || '-', '| hints', JSON.stringify(r.hints), `| wall ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log('JSON ' + JSON.stringify({ name: r.name, fp: r.firstPluck, ps: r.playSteps - r.noPluck, np: r.noPluck, repl: r.replucks, pstuck: r.playStuck, sf: r.singFirst, ss: r.singSteps, sstuck: r.singStuck, rf: r.revFirst, rn: r.revNotes, rstuck: r.revStuck, badSing: r.bad.filter((b) => b.phase === 'sing').length, badPlay: r.bad.filter((b) => b.phase === 'play').length, badRev: r.bad.filter((b) => b.phase === 'review').length, wp: r.wrongPlucks, ws: r.wrongSung, lat: r.lat.map((x) => Math.round(x)), revLat: r.revLat.map((x) => Math.round(x)), singLat: r.singLat.map((x) => Math.round(x)) }));
}
