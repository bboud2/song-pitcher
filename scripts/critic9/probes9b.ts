// Ninth review (ported unchanged).
// @ts-nocheck (ported review tooling, kept as written)
// Critic-9 probes, part 2. usage: BUILD_DIR=... node probes9b.ts <probe>
import { Rig, SR, rng, med, pct, speech, SONG, type Env } from './rig9.ts';
import { GUITARS, type GOpts, type VOpts } from './syn9.ts';
const which = process.argv[2];
const ENVS: Env[] = [
  { room: 'study', phone: 'flagship', spk: -20 }, { room: 'lounge', phone: 'cheap', spk: -18 }, { room: 'garage', phone: 'midrange', spk: -18 },
  { room: 'duvet', phone: 'webrtc', spk: -20 }, { room: 'shower', phone: 'oldtab', spk: -18 }, { room: 'none', phone: 'hum50', spk: -22 }, { room: 'study', phone: 'bt', spk: null },
];
const TARGETS = [48, 52, 54, 55, 57, 59, 60, 62, 64, 65, 67];
const idxOf = (m: number) => SONG.notes.findIndex((n: any) => 48 + n.offset === m);
const envName = (e: Env) => `${e.room}/${e.phone}${e.bg ? '+' + e.bg.kind + e.bg.db : ''}`;
const row = (label: string, k: number, n: number, extra = '') => console.log(`${label.padEnd(70)} ${k}/${n} ${extra}`);
function atSing(env: Env, target: number, seed: number, settings: any = {}): Rig { const rig = new Rig({ ...env, seed, settings: { phraseReview: false, ...settings } }); rig.begin(idxOf(target)); rig.run(30, (v) => v.phase === 'sing'); return rig; }
const VK: [string, Partial<VOpts>, (t: number) => number][] = [['man', {}, (t) => (t > 60 ? t - 12 : t)], ['woman', { tract: 1.17 }, (t) => (t < 57 ? t + 12 : t)], ['child', { tract: 1.35, tilt: 2 }, (t) => (t < 62 ? t + 12 : t)]];
// honest sung notes by onset consonant and vowel: passed within the note (1.5 s hold) / needed a 3 s hold / never
if (which === 'singhonest') {
  const envs = [ENVS[0], ENVS[1], ENVS[3]];
  for (const cons of ['', 'l', 'n', 'd', 't', 'h'] as const) for (const vowel of ['a', 'u', 'i', 'm']) {
    if (vowel === 'm' && cons !== '') continue;
    let tot = 0, ok15 = 0, ok3 = 0; const lat: number[] = []; const hints: Record<string, number> = {};
    for (const [, vo, f] of VK) for (const [ei, env] of envs.entries()) for (const target of [48, 55, 59, 60, 64, 67]) {
      for (const hold of [1.5, 3.2]) {
        const rig = atSing(env, target, 91 + ei); rig.run(0.6); rig.sing({ midi: f(target), dur: hold, seed: target + ei, vowel, cons, cents: 5, ...vo } as VOpts, -20);
        const v = rig.run(hold + 0.4, (q) => q.phase !== 'sing');
        if (hold === 1.5) { tot++; if (v.phase !== 'sing') { ok15++; lat.push(rig.log[0].lat ?? NaN); } else for (const [k, n] of Object.entries(rig.hints)) hints[k] = (hints[k] ?? 0) + n; } else if (v.phase !== 'sing') ok3++;
      }
    }
    row(`honest sung "${cons}${vowel}", 1.5 s: passed`, ok15, tot, `(3.2 s hold: ${ok3}/${tot}) lat med ${med(lat).toFixed(0)} p90 ${pct(lat, 0.9).toFixed(0)} ${JSON.stringify(hints)}`);
  }
}
// nobody sings: does the reference tone's own reverberation pass the singing step?
if (which === 'ownref') {
  for (const room of ['study', 'lounge', 'garage', 'shower']) for (const spk of [-12, -18, -26]) for (const phone of ['flagship', 'cheap']) {
    let tot = 0, bad = 0; const dets: string[] = [];
    for (const target of TARGETS) for (const seed of [1, 2]) { const rig = atSing({ room, phone, spk }, target, 100 + seed); const v = rig.run(4, (q) => q.phase !== 'sing'); tot++; if (v.phase !== 'sing') { bad++; if (dets.length < 4) dets.push(`${target}->${rig.log[0].det?.toFixed(1)}@${(rig.log[0].t - rig.stepT + (rig.log[0].t - rig.log[0].t)).toFixed(1)}`); } }
    row(`sing step, silence after the reference; ${room}, speaker ${spk} dBFS at the mic, ${phone}: passed`, bad, tot, dets.join(' '));
  }
}
// repeated note: previous string (same pitch) still ringing, honest singer sings the right note, stops 0.3 s after the flash, never plucks
if (which === 'repeat') {
  for (const kind of ['jumbo', 'travel', 'classical', 'solid']) for (const bg of [undefined, { kind: 'tv' as const, db: -34 }]) {
    let tot = 0, singEarly = 0, playNoPluck = 0, singAlone = 0; const sl: number[] = [];
    for (const [ei, env] of ENVS.slice(0, 5).entries()) for (const idx of [13, 21, 49, 50, 54, 59, 70, 76, 77, 78, 83, 85]) for (const [vn, vo, f] of VK.slice(0, 2)) {
      if (SONG.notes[idx].offset !== SONG.notes[idx - 1].offset) continue;
      const rig = new Rig({ ...env, bg, seed: 111 + ei + idx, settings: { skipSing: true, phraseReview: false } }); rig.begin(idx - 1); rig.run(30, (v) => v.phase === 'play');
      rig.s.setSettings({ ...rig.s.settings, skipSing: false }); rig.run(0.4);
      const prev = rig.s.view().targetMidi; rig.pluck({ midi: prev, kind, pluck: 'pick', dur: 8, seed: idx }, kind === 'solid' ? -24 : -12);
      let v = rig.run(4, (q) => q.index === idx); if (v.index !== idx) continue; v = rig.run(30, (q) => q.phase !== 'listen'); if (v.phase !== 'sing') continue;
      rig.log.length = 0; v = rig.run(0.7, (q) => q.phase !== 'sing');
      if (v.phase !== 'sing') { tot++; singAlone++; continue; }
      const target = v.targetMidi; const t0 = rig.t; const ev = rig.sing({ midi: f(target), dur: 2.5, seed: idx, ...vo } as VOpts, -20);
      v = rig.run(2.8, (q) => q.phase !== 'sing'); tot++; if (v.phase === 'sing') continue; sl.push((rig.t - t0) * 1000); if (rig.t - t0 < 0.3) singEarly++;
      rig.run(0.3); rig.stop(ev, 70); v = rig.run(2.5, (q) => q.phase !== 'play'); if (v.phase !== 'play' || v.index !== idx) playNoPluck++; void vn;
    }
    row(`repeated note, ${kind}${bg ? ' + TV' : ''}: string alone passed sing / sing passed <300 ms after voice onset / then guitar step passed with no pluck`, playNoPluck, tot, `alone ${singAlone}/${tot}, early ${singEarly}/${tot}, sing lat med ${med(sl).toFixed(0)}`);
  }
}
