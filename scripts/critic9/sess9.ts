// Ninth review (ported unchanged).
// @ts-nocheck (ported review tooling, kept as written)
// Critic-9 honest sessions. usage: BUILD_DIR=... node sess9.ts <style> [seed] [maxNotes] [from]
import { Rig, med, pct, rng, stringFor, type Env, type Adv } from './rig9.ts';
import type { GOpts, VOpts } from './syn9.ts';
type R = () => number;
export interface Style {
  env: Env; voiceKind: 'male' | 'female' | 'child' | 'bass';
  g: (midi: number, r: R) => Partial<GOpts>; gLevel?: [number, number]; v: (midi: number, r: R) => Partial<VOpts>; vLevel?: [number, number];
  think?: [number, number]; hold?: [number, number]; gap?: [number, number]; ring?: boolean; cents?: [number, number]; ioi?: [number, number];
  hunt?: number; singWrong?: number; stac?: number; holdOn?: boolean; gdur?: number;
}
const u = (r: R, [a, b]: [number, number]) => a + (b - a) * r();
export const STYLES: Record<string, Style> = {
  a1: { env: { room: 'study', phone: 'flagship', spk: -20 }, voiceKind: 'male', g: () => ({ kind: 'jumbo', pluck: 'pick' }), v: () => ({ vowel: 'a', cons: 'l' }), ring: true, gdur: 6 },
  a2: { env: { room: 'lounge', phone: 'cheap', spk: -16 }, voiceKind: 'child', g: () => ({ kind: 'travel', pluck: 'finger' }), v: () => ({ vowel: 'u', cons: 'd', tract: 1.35, tilt: 2 }), vLevel: [-22, -15] },
  a3: { env: { room: 'duvet', phone: 'webrtc', spk: -20 }, voiceKind: 'female', g: (_m, r) => ({ kind: 'classical', pluck: r() < 0.5 ? 'thumb' : 'finger', hard: 0.35 }), gLevel: [-24, -16], v: () => ({ vowel: 'm', tract: 1.17 }), vLevel: [-30, -22] },
  a4: { env: { room: 'study', phone: 'bt', spk: null }, voiceKind: 'male', g: (m, r) => ({ kind: 'rusty', pluck: 'pick', buzz: stringFor(m).fret > 0 && r() < 0.4 ? 0.3 : 0 }), v: () => ({ vowel: 'u', tilt: 6, breath: 0.15 }), vLevel: [-26, -18] },
  a5: { env: { room: 'none', phone: 'hum50', spk: -24 }, voiceKind: 'male', g: () => ({ kind: 'solid', pluck: 'pick', hard: 0.45 }), gLevel: [-32, -26], v: () => ({ vowel: 'o', cons: 'n' }), ring: true, gdur: 6 },
  a6: { env: { room: 'garage', phone: 'midrange', spk: -18 }, voiceKind: 'female', g: () => ({ kind: 'om', pluck: 'nail' }), v: () => ({ vowel: 'a', cons: 'l', tract: 1.17, vib: 35, vibHz: 5.8 }), gap: [-0.5, -0.05], hold: [0.7, 1.1], holdOn: true, ring: true },
  a7: { env: { room: 'shower', phone: 'flagship', spk: -18 }, voiceKind: 'male', g: () => ({ kind: 'jumbo', pluck: 'pick', hard: 0.85 }), v: () => ({ vowel: 'e', scoop: 90, scoopMs: 260, creak: 0.12 }), stac: 0.3, cents: [0, 28] },
  a8: { env: { room: 'lounge', phone: 'flagship', spk: -20, bg: { kind: 'tv', db: -34 } }, voiceKind: 'male', g: () => ({ kind: 'travel', pluck: 'pick' }), v: () => ({ vowel: 'a' }) },
  a9: { env: { room: 'lounge', phone: 'oldtab', spk: -20, bg: { kind: 'tvmusic', db: -38, female: true } }, voiceKind: 'female', g: () => ({ kind: 'classical', pluck: 'finger' }), v: () => ({ vowel: 'o', tract: 1.17 }) },
  a10: { env: { room: 'lounge', phone: 'midrange', spk: -22 }, voiceKind: 'male', g: () => ({ kind: 'jumbo', pluck: 'pick' }), v: () => ({ vowel: 'a' }), hunt: 0.6, ring: true, singWrong: 0.3, gdur: 6 },
  a11: { env: { room: 'study', phone: 'cheap', spk: -22 }, voiceKind: 'female', g: () => ({ kind: 'om', pluck: 'thumb', hard: 0.2 }), gLevel: [-36, -28], v: () => ({ vowel: 'o', tract: 1.17, breath: 0.12, atkMs: 160 }), vLevel: [-36, -30] },
  a12: { env: { room: 'study', phone: 'flagship', spk: -20, bg: { kind: 'talk', db: -30 } }, voiceKind: 'male', g: () => ({ kind: 'rusty', pluck: 'pick' }), v: () => ({ vowel: 'a' }) },
  // bass voice an octave below everything, palm-muted short notes on a nylon guitar
  a13: { env: { room: 'study', phone: 'midrange', spk: -20 }, voiceKind: 'bass', g: () => ({ kind: 'classical', pluck: 'thumb', mute: 0.12 }), v: () => ({ vowel: 'o', tilt: 2, fall: 25 }) },
  // long-sustain flat-top in a quiet dead room, very soft finger plucks, strings ring on, long thinking pauses
  a14: { env: { room: 'duvet', phone: 'flagship', spk: -24 }, voiceKind: 'female', g: () => ({ kind: 'jumbo', pluck: 'finger', hard: 0.15 }), gLevel: [-40, -32], v: () => ({ vowel: 'i', tract: 1.17 }), ring: true, think: [1.0, 2.5], gdur: 6 },
};
export interface Res { name: string; notes: number; playSteps: number; firstPluck: number; replucks: number; playStuck: number; singSteps: number; singFirst: number; singStuck: number; revNotes: number; revFirst: number; revStuck: number; bad: Adv[]; lat: number[]; singLat: number[]; revLat: number[]; hints: Record<string, number>; simSec: number; stuckAt: string[]; wrongPlucks: number; wrongSung: number; lowAcc: number }
export function sungMidi(target: number, k: string) { if (k === 'male') return target > 60 ? target - 12 : target; if (k === 'bass') return target - 12; if (k === 'female') return target < 57 ? target + 12 : target; return target < 62 ? target + 12 : target; }
export function honest(name: string, seed = 1, maxNotes = 0, from = 0, over: Partial<Style> & { envOver?: Partial<Env> } = {}): Res {
  const st = { ...STYLES[name], ...over }; const rig = new Rig({ ...st.env, ...(over.envOver ?? {}), seed: seed * 19 + 1 }); const r = rng(seed * 13 + 7);
  const res: Res = { name: `${name} s${seed}`, notes: 0, playSteps: 0, firstPluck: 0, replucks: 0, playStuck: 0, singSteps: 0, singFirst: 0, singStuck: 0, revNotes: 0, revFirst: 0, revStuck: 0, bad: [], lat: [], singLat: [], revLat: [], hints: {}, simSec: 0, stuckAt: [], wrongPlucks: 0, wrongSung: 0, lowAcc: 0 };
  const gopts = (midi: number): GOpts => { const k = Math.floor(r() * 3); const rr = rng(midi * 41 + k + seed * 977); return { midi, seed: midi * 41 + k + (seed % 5) * 1000, dur: st.gdur ?? 4, cents: Math.round(u(rr, st.cents ?? [-7, 11])), ...st.g(midi, rr) }; };
  let lastPl: any = null; let stacAt = Infinity; let voiceEv: any = null; let voiceStopAt = Infinity;
  const doPluck = (midi: number, ok = true) => { lastPl = rig.pluck(gopts(midi), u(r, st.gLevel ?? [-18, -10]), r() * 0.02, ok); if (st.stac) stacAt = rig.t + st.stac + 0.03; };
  const each = () => { if (voiceEv && rig.t >= voiceStopAt) { rig.stop(voiceEv, 70); voiceEv = null; voiceStopAt = Infinity; } if (rig.t >= stacAt) { rig.stop(lastPl, 40); stacAt = Infinity; } };
  const tick = (sec: number, until?: (v: any) => boolean) => rig.run(sec, until, each);
  if (process.env.TRACE) { const [ti, tp] = process.env.TRACE.split(':'); const f2m = (f: number) => 69 + 12 * Math.log2(f / 440); rig.onFrame = (fr: any, b: any, adv: boolean) => { if (b.index === Number(ti) - 1 && (tp === '*' || b.phase === tp)) { const m = rig.s.view().match; console.log(`${fr.t.toFixed(2)} ${b.phase} ${fr.freq > 0 ? f2m(fr.freq).toFixed(2) : '--'} cl ${fr.clarity.toFixed(2)} rms ${(20 * Math.log10(fr.rms + 1e-9)).toFixed(0)} up ${(fr.upClarity ?? 0).toFixed(2)} voices ${rig.voices.filter((q) => q.t0 < fr.t && fr.t < q.t1 + 0.3).map((q) => q.midi.toFixed(1)).join(',')} ring ${rig.ringing().join(',')} pl ${rig.plucks.filter((q) => fr.t - q.t < 3 && q.t <= fr.t).map((q) => q.midi + '@' + (fr.t - q.t).toFixed(2)).join(',')} ${m?.hint ?? ''} ${adv ? 'ACCEPT ' + JSON.stringify(rig.s.lastAccepted, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v) : ''}`); } }; }
  rig.begin(from);
  for (;;) {
    let v = tick(60, (q) => q.phase !== 'listen');
    if (v.phase === 'done') break;
    const idx = v.index; const target = v.targetMidi;
    if (maxNotes && idx - from >= maxNotes) break;
    if (v.phase === 'sing') {
      res.singSteps++;
      v = tick(u(r, st.think ?? [0.4, 1.2]), (q) => q.phase !== 'sing'); let ok = v.phase !== 'sing';
      for (let a = 0; a < 4 && !ok; a++) {
        const sm = sungMidi(target, st.voiceKind); const hold = u(r, st.hold ?? [1.0, 1.8]);
        if (a === 0 && st.singWrong && r() < st.singWrong) { // first a wrong pitch, then correct it
          const off = [-3, -2, 2, 3, 4][Math.floor(r() * 5)]; const ev = rig.sing({ midi: sm + off, dur: 0.9, seed: seed * 7 + idx, ...st.v(target, r) } as VOpts, u(r, st.vLevel ?? [-24, -16]), 0, true); res.wrongSung++;
          voiceEv = ev; voiceStopAt = rig.t + 0.9; v = tick(1.3, (q) => q.phase !== 'sing'); if (v.phase !== 'sing') { ok = true; break; }
        }
        const vo: VOpts = { midi: sm, dur: hold, seed: seed * 7 + idx * 3 + a, cents: Math.round(u(r, [-18, 18])), ...st.v(target, r) } as VOpts;
        voiceEv = rig.sing(vo, u(r, st.vLevel ?? [-24, -16])); voiceStopAt = Infinity;
        v = tick(hold + 0.6, (q) => { if (q.phase !== 'sing' && voiceStopAt === Infinity && !st.holdOn) voiceStopAt = rig.t + 0.2 + 0.15 * r(); return q.phase !== 'sing'; });
        if (v.phase !== 'sing') { ok = true; if (a === 0) res.singFirst++; }
      }
      if (!ok) { res.singStuck++; res.stuckAt.push(`sing#${idx + 1}(${target})`); rig.skip(); v = rig.s.view(); if (v.phase !== 'play' || v.index !== idx) continue; }
      if (rig.s.view().phase === 'done') break;
    }
    v = rig.s.view();
    if (v.phase === 'play' && v.index === idx) {
      res.playSteps++;
      const gap = u(r, st.gap ?? [0.35, 0.9]);
      if (gap > 0) tick(gap); else if (voiceEv) voiceStopAt = Math.max(rig.t + 0.05, Math.min(voiceStopAt, rig.t - gap + 0.3));
      if (!st.ring) rig.damp(60);
      let ok = rig.s.view().phase !== 'play' || rig.s.view().index !== idx; // (accepted before any pluck = false accept, logged by the rig)
      const moved = (q: any) => q.phase !== 'play' || q.index !== idx;
      if (!ok && st.hunt && r() < st.hunt) { const nw = 1 + Math.floor(r() * 3); for (let k = 0; k < nw && !ok; k++) { const off = [-12, -7, -5, -2, -1, 1, 2, 5, 7, 12][Math.floor(r() * 10)]; let wm = target + off; if (wm < 40 || wm > 76) wm = target - off; res.wrongPlucks++; doPluck(wm, false); v = tick(u(r, [0.6, 1.1]), moved); ok = moved(v); } }
      for (let a = 0; a < 5 && !ok; a++) {
        doPluck(target); v = tick(u(r, [1.6, 2.4]), moved);
        if (moved(v)) { ok = true; if (a === 0) res.firstPluck++; else { res.replucks += a; if (process.env.MISS) console.log(`MISS play #${idx + 1} target ${target} tries ${a + 1} ringing ${rig.ringing().join(',')}`); } }
      }
      if (!ok) { res.playStuck++; res.stuckAt.push(`play#${idx + 1}(${target})`); rig.skip(); }
    }
    v = rig.s.view();
    if (v.phase === 'review') {
      if (!st.ring) rig.damp(60);
      tick(u(r, [0.8, 1.6]), (q) => q.phase !== 'review');
      let guard = 0;
      while (rig.s.view().phase === 'review' && guard++ < 40) {
        const q0 = rig.s.view(); const pos = q0.review.pos; const m = q0.review.notes[pos]; res.revNotes++; let ok = false;
        const movedR = (q: any) => q.phase !== 'review' || q.review.pos !== pos;
        for (let a = 0; a < 4 && !ok; a++) { doPluck(m); const ioi = u(r, st.ioi ?? [0.45, 0.8]); const t0 = rig.t; v = tick(a === 0 ? 1.3 : 1.6, movedR); if (movedR(v)) { ok = true; if (a === 0) res.revFirst++; else if (process.env.MISS) console.log(`MISS rev #${idx + 1}.${pos} target ${m} tries ${a + 1} prev ${pos > 0 ? q0.review.notes[pos - 1] : '-'}`); const rest = ioi - (rig.t - t0); if (rest > 0 && rig.s.view().phase === 'review') tick(rest); } }
        if (!ok) { res.revStuck++; res.stuckAt.push(`rev#${idx + 1}.${pos}(${m})`); rig.skip(); break; }
      }
    }
  }
  res.notes = rig.s.view().index - from; res.bad = rig.log.filter((l) => !l.legit); res.hints = rig.hints; res.simSec = rig.t;
  res.lat = rig.log.filter((l) => l.legit && l.phase === 'play').map((l) => l.lat!); res.singLat = rig.log.filter((l) => l.legit && l.phase === 'sing').map((l) => l.lat!); res.revLat = rig.log.filter((l) => l.legit && l.phase === 'review').map((l) => l.lat!);
  return res;
}
export function show(x: Res): string {
  const L = [...x.lat, ...x.revLat];
  return `${x.name.padEnd(10)} sing1st ${x.singFirst}/${x.singSteps} stuck ${x.singStuck} | play1st ${x.firstPluck}/${x.playSteps} stuck ${x.playStuck} | rev1st ${x.revFirst}/${x.revNotes} stuck ${x.revStuck} | bad ${x.bad.length} | guitar lat med ${med(L).toFixed(0)} p90 ${pct(L, 0.9).toFixed(0)} | sing lat med ${med(x.singLat).toFixed(0)} p90 ${pct(x.singLat, 0.9).toFixed(0)}${x.wrongPlucks ? ` | wrong plucks ${x.wrongPlucks} wrong sung ${x.wrongSung}` : ''}`
    + (x.stuckAt.length ? `\n    stuck: ${x.stuckAt.join(' ')}` : '') + x.bad.map((b) => `\n    BAD #${b.index + 1} ${b.phase}${b.pos >= 0 ? '.' + b.pos : ''} t=${b.t.toFixed(2)} target ${b.target} det ${b.det?.toFixed?.(2)} ${b.reason ?? ''}: ${b.why}`).join('');
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const [name, seed, max, from] = process.argv.slice(2); const t0 = Date.now();
  const x = honest(name, Number(seed ?? 1), Number(max ?? 0), Number(from ?? 0));
  console.log(show(x) + `   [${((Date.now() - t0) / 1000).toFixed(0)} s wall, ${x.simSec.toFixed(0)} s audio]`);
  if (process.env.HINTS) console.log(JSON.stringify(x.hints));
}
