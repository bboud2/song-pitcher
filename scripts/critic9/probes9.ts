// Ninth review (ported unchanged).
// @ts-nocheck (ported review tooling, kept as written)
// Critic-9 probes. usage: BUILD_DIR=... node probes9.ts <probe> [args]
import { Rig, SR, rng, stringFor, med, pct, speech, type Env } from './rig9.ts';
import { GUITARS, type GOpts, type VOpts } from './syn9.ts';
const which = process.argv[2]; const arg = process.argv.slice(3);
const ENVS: Env[] = [
  { room: 'study', phone: 'flagship', spk: -20 }, { room: 'lounge', phone: 'cheap', spk: -18 }, { room: 'garage', phone: 'midrange', spk: -18 },
  { room: 'duvet', phone: 'webrtc', spk: -20 }, { room: 'shower', phone: 'oldtab', spk: -18 }, { room: 'none', phone: 'hum50', spk: -22 }, { room: 'study', phone: 'bt', spk: null },
];
const KINDS = Object.keys(GUITARS); const TARGETS = [48, 52, 54, 55, 57, 59, 60, 62, 64, 65, 67];
// song index of the first occurrence of each target midi
import { SONG } from './rig9.ts';
const idxOf = (m: number) => SONG.notes.findIndex((n: any) => 48 + n.offset === m);
const envName = (e: Env) => `${e.room}/${e.phone}${e.bg ? '+' + e.bg.kind + e.bg.db : ''}`;
/** rig at the guitar step of the first note with this target (singing step skipped by setting) */
function atPlay(env: Env, target: number, seed: number): Rig { const rig = new Rig({ ...env, seed, settings: { skipSing: true, phraseReview: false, ...(env.settings ?? {}) } }); rig.begin(idxOf(target)); rig.run(30, (v) => v.phase === 'play'); return rig; }
function atSing(env: Env, target: number, seed: number, settings: any = {}): Rig { const rig = new Rig({ ...env, seed, settings: { phraseReview: false, ...settings } }); rig.begin(idxOf(target)); rig.run(30, (v) => v.phase === 'sing'); return rig; }
const row = (label: string, k: number, n: number, extra = '') => console.log(`${label.padEnd(64)} ${k}/${n} ${extra}`);

// ---- P1: wrong plucks (octave, neighbours) rung out for 4.5 s must not pass the guitar step
if (which === 'wrong') {
  const offs = arg.length ? arg.map(Number) : [-12, 12];
  for (const off of offs) {
    let tot = 0, bad = 0; const per: Record<string, [number, number]> = {}; const ex: string[] = [];
    for (const kind of KINDS) for (const [ei, env] of [ENVS[0], ENVS[1], ENVS[2], ENVS[3], ENVS[6]].entries()) for (const [ti, target] of TARGETS.entries()) {
      const wm = target + off; if (wm < 40 || wm > 76) continue;
      for (const style of [(ti + ei) % 2 ? 'pick' : 'thumb'] as const) {
        const rig = atPlay(env, target, 5 + ei); rig.run(0.4);
        rig.pluck({ midi: wm, kind, pluck: style, dur: 5, seed: target + ei, cents: 4, hard: style === 'pick' ? 0.6 : 0.4 }, kind === 'solid' ? -26 : -14, 0, false);
        const v = rig.run(4.6, (q) => q.phase !== 'play'); tot++; const key = `${kind}`; per[key] ??= [0, 0]; per[key][1]++;
        if (v.phase !== 'play') { bad++; per[key][0]++; if (ex.length < 6) ex.push(`${kind}/${style}/${envName(env)}/t${target} @${rig.log[0].lat === undefined ? ((rig.log[0].t - rig.plucks[0].t) * 1000).toFixed(0) : ''}ms det ${rig.log[0].det?.toFixed(2)}`); }
      }
    }
    row(`wrong pluck ${off > 0 ? '+' : ''}${off} st, rung 4.6 s: accepted`, bad, tot, Object.entries(per).map(([k, [b, n]]) => `${k} ${b}/${n}`).join(' ') + (ex.length ? '\n      e.g. ' + ex.join('; ') : ''));
  }
}
// ---- P2: honest plucks, quiet / short / hard: first-try accept
if (which === 'quiet') {
  const variants: [string, Partial<GOpts>, number][] = [
    ['normal -14', {}, -14], ['quiet -30', { hard: 0.3 }, -30], ['quiet -38', { hard: 0.25 }, -38], ['quiet -44', { hard: 0.2 }, -44], ['quiet -50', { hard: 0.2 }, -50],
    ['palm mute x0.10', { mute: 0.10 }, -16], ['palm mute x0.05', { mute: 0.05 }, -16], ['hard pick 1.0', { hard: 1, pluck: 'pick' }, -8], ['soft thumb', { hard: 0.1, pluck: 'thumb' }, -24], ['25 c sharp', { cents: 25 }, -14], ['35 c sharp', { cents: 35 }, -14], ['-20 c flat', { cents: -20 }, -14],
  ];
  const stacs: [string, number][] = [['staccato 0.12 s', 0.12], ['staccato 0.2 s', 0.2]];
  const envs = arg[0] ? [ENVS[Number(arg[0])]] : [ENVS[0], ENVS[1], ENVS[3], ENVS[6]];
  for (const [label, go, lvl] of [...variants, ...stacs.map(([l]) => [l, {}, -14] as [string, Partial<GOpts>, number])]) {
    let tot = 0, ok = 0; const lat: number[] = []; const fails: Record<string, number> = {}; let wrongAcc = 0;
    const stac = stacs.find(([l]) => l === label)?.[1];
    for (const kind of KINDS) for (const [ei, env] of envs.entries()) for (const target of [48, 52, 55, 59, 60, 64, 67]) {
      const rig = atPlay(env, target, 11 + ei); rig.run(0.5);
      const ev = rig.pluck({ midi: target, kind, pluck: 'pick', dur: 4, seed: target * 3 + ei, cents: 3, ...go }, lvl + (kind === 'solid' ? -8 : 0));
      let v = stac ? rig.run(stac, (q) => q.phase !== 'play') : rig.s.view(); if (stac && v.phase === 'play') rig.stop(ev, 35);
      v = rig.run(2.2, (q) => q.phase !== 'play'); tot++;
      if (v.phase !== 'play') { ok++; lat.push(rig.log[0].lat ?? NaN); } else { const k = `${kind}/${envName(env)}`; fails[k] = (fails[k] ?? 0) + 1; }
    }
    const top = Object.entries(fails).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k}:${n}`).join(' ');
    row(`honest pluck, ${label}: accepted first try`, ok, tot, `med ${med(lat).toFixed(0)} p90 ${pct(lat, 0.9).toFixed(0)} ms${top ? '  misses: ' + top : ''}`);
  }
}
// ---- P3: sing step, wrong notes / octaves
if (which === 'singwrong') {
  const voices: [string, Partial<VOpts>, number][] = [['man a', { vowel: 'a' }, 0], ['woman o', { vowel: 'o', tract: 1.17 }, 12], ['hum', { vowel: 'm' }, 0], ['man wide vib', { vowel: 'e', vib: 60 }, 0]];
  const envs: Env[] = [ENVS[0], ENVS[1], { room: 'lounge', phone: 'flagship', spk: -20, bg: { kind: 'tv', db: -34 } }, { room: 'study', phone: 'flagship', spk: -20, bg: { kind: 'talk', db: -28 } }];
  for (const off of [-2, -1, 1, 2, 5, 7]) {
    let tot = 0, bad = 0; const ex: string[] = [];
    for (const [vn, vo, sh] of voices) for (const [ei, env] of envs.entries()) for (const target of TARGETS) {
      const rig = atSing(env, target, 21 + ei); rig.run(0.5); let sm = target + sh + off; if (sm > 69) sm -= 12;
      rig.sing({ midi: sm, dur: 2.2, seed: target + ei, cents: 0, ...vo } as VOpts, -20);
      const v = rig.run(3.0, (q) => q.phase !== 'sing'); tot++; if (v.phase !== 'sing') { bad++; if (ex.length < 5) ex.push(`${vn}/${envName(env)}/t${target} det ${rig.log[0].det?.toFixed(2)}`); }
    }
    row(`sing step, sung ${off > 0 ? '+' : ''}${off} st off (2.2 s): passed`, bad, tot, ex.join('; '));
  }
  // exact-octave setting: octave-off singing must not pass, right octave must
  for (const off of [-12, 12, 0]) {
    let tot = 0, pass = 0;
    for (const [vn, vo] of voices) for (const [ei, env] of envs.entries()) for (const target of TARGETS) {
      const sm = target + off; if (sm < 40 || sm > 76) continue;
      const rig = atSing(env, target, 31 + ei, { singExactOctave: true }); rig.env.settings = { singExactOctave: true }; rig.run(0.5);
      rig.sing({ midi: sm, dur: 2.2, seed: target + ei, cents: 0, ...vo } as VOpts, -20);
      const v = rig.run(3.0, (q) => q.phase !== 'sing'); tot++; if (v.phase !== 'sing') pass++; void vn;
    }
    row(`exact-octave setting, sung ${off} st: passed (${off ? 'should be 0' : 'should be all'})`, pass, tot);
  }
  // any octave (default): sung an octave up / down / two up must pass
  for (const off of [-12, 12, 24]) {
    let tot = 0, pass = 0;
    for (const [, vo] of voices.slice(0, 3)) for (const [ei, env] of envs.entries()) for (const target of TARGETS) {
      const sm = target + off; if (sm < 38 || sm > 84) continue;
      const rig = atSing(env, target, 41 + ei); rig.run(0.5); rig.sing({ midi: sm, dur: 2.2, seed: target + ei, tract: sm > 62 ? 1.2 : 1, ...vo } as VOpts, -20);
      const v = rig.run(3.0, (q) => q.phase !== 'sing'); tot++; if (v.phase !== 'sing') pass++;
    }
    row(`any-octave (default), sung ${off} st: passed (should be all)`, pass, tot);
  }
  // glide through the target (siren, one octave over 3 s) must not pass
  { let tot = 0, bad = 0; for (const [ei, env] of envs.entries()) for (const target of TARGETS) { const rig = atSing(env, target, 51 + ei); rig.run(0.5); rig.sing({ midi: target - 6, dur: 3, scoop: -1200, scoopMs: 7000, vib: 0, drift: 0, seed: 3 } as VOpts, -20, 0, false); const v = rig.run(3.4, (q) => q.phase !== 'sing'); tot++; if (v.phase !== 'sing') bad++; } row('sing step, slow siren through the target: passed', bad, tot); }
}
// ---- P4/P5: nobody plays or sings. speech / TV / household noise only. Steps passed in `sec` seconds per trial.
if (which === 'idle') {
  const sec = 30;
  const sources: [string, (rig: Rig, seed: number) => void, Partial<Env>][] = [
    ['room tone only', () => {}, {}],
    ['talking nearby, man, -22 dB', (rig, s) => { rig.raw(`sp${s}m`, () => speech(sec + 2, s, {}), -22); }, {}],
    ['talking nearby, woman, -22 dB', (rig, s) => { rig.raw(`sp${s}f`, () => speech(sec + 2, s, { female: true }), -22); }, {}],
    ['talking with long fillers ("ummm"), man, -22 dB', (rig, s) => { rig.raw(`sp${s}u`, () => speech(sec + 2, s, { fillers: 0.3 }), -22); }, {}],
    ['TV speech -32 dB', () => {}, { bg: { kind: 'tv', db: -32 } }],
    ['TV with music -32 dB', () => {}, { bg: { kind: 'tvmusic', db: -32 } }],
    ['knocks, coughs, chair, keys, claps every 1.5 s', (rig, s) => { const r = rng(s); const ks = ['knock', 'cough', 'chair', 'keys', 'clap', 'door']; for (let t = 0.5; t < sec; t += 1.2 + 0.6 * r()) rig.add(rig.wet(`x${ks[Math.floor(r() * 6)]}${Math.floor(r() * 4)}`, () => new Float32Array(1), 2), 0, 'x', -1); }, {}],
  ];
  const envs = [ENVS[0], ENVS[1], ENVS[2], ENVS[3]];
  for (const phase of ['sing', 'play'] as const) for (const [label, start, eo] of sources) {
    let trials = 0, passedTrials = 0, steps = 0; const first: number[] = []; const reasons: Record<string, number> = {};
    for (const [ei, env] of envs.entries()) for (const target of [48, 55, 60, 64, 67]) {
      const e = { ...env, ...eo }; const rig = phase === 'play' ? atPlay(e, target, 61 + ei + target) : new Rig({ ...e, seed: 61 + ei + target, settings: { skipGuitar: true, phraseReview: false } });
      if (phase === 'sing') { rig.begin(idxOf(target)); rig.run(30, (v) => v.phase === 'sing'); }
      const t0 = rig.t;
      if (label.startsWith('knocks')) { const r = rng(ei * 7 + target); const ks = ['knock', 'cough', 'chair', 'keys', 'clap', 'door']; let t = 0.5; while (t < sec) { rig.add(rig.wet(`nz${Math.floor(r() * 6)}:${Math.floor(r() * 4)}`, () => noiseEv(ks, r), 2), -16 - 10 * r(), 'x', -1, -1, t); t += 1.2 + 0.6 * r(); } } else start(rig, ei * 100 + target);
      rig.run(sec); trials++; const n = rig.log.length; steps += n; if (n) { passedTrials++; first.push(rig.log[0].t - t0); for (const l of rig.log) reasons[l.reason ?? '?'] = (reasons[l.reason ?? '?'] ?? 0) + 1; }
    }
    row(`${phase} step, ${label}: trials with an advance in ${sec} s`, passedTrials, trials, `(${steps} steps passed in ${(trials * sec / 60).toFixed(0)} min; first after med ${med(first).toFixed(1)} s) ${JSON.stringify(reasons)}`);
  }
}
import { noiseEvent } from './syn9.ts';
function noiseEv(ks: string[], r: () => number) { return noiseEvent(ks[Math.floor(r() * ks.length)], Math.floor(r() * 1000)); }
// ---- P6: carry-over: previous guitar note ringing (long sustain) while the sing step is open; nobody sings / sings wrong
if (which === 'carry') {
  for (const mode of ['ring only', 'ring + wrong note sung (+2 st)', 'ring + talk', 'ring + right note sung (honest)'] as const) {
    let tot = 0, pass = 0; const lat: number[] = [];
    for (const kind of ['jumbo', 'solid', 'om', 'classical']) for (const [ei, env] of ENVS.slice(0, 5).entries()) for (const idx of [1, 3, 5, 12, 13, 20, 27, 37]) {
      // play note idx-1 honestly (skipSing off for target note): start at idx-1 with skipSing, pluck, then switch setting so that idx has a sing step
      const rig = new Rig({ ...env, seed: 71 + ei, settings: { skipSing: true, phraseReview: false } }); rig.begin(idx - 1); rig.run(30, (v) => v.phase === 'play');
      rig.s.setSettings({ ...rig.s.settings, skipSing: false }); rig.run(0.4);
      const prev = rig.s.view().targetMidi; rig.pluck({ midi: prev, kind, pluck: 'pick', dur: 8, seed: idx }, kind === 'solid' ? -24 : -12);
      let v = rig.run(4, (q) => q.index === idx); if (v.index !== idx) continue; v = rig.run(30, (q) => q.phase === 'sing'); if (v.phase !== 'sing') continue;
      const target = v.targetMidi; rig.log.length = 0; rig.run(0.5, (q) => q.phase !== 'sing');
      if (mode.includes('wrong')) rig.sing({ midi: target + 2 > 62 ? target + 2 - 12 : target + 2, dur: 2, seed: idx } as VOpts, -22, 0, false);
      if (mode.includes('talk')) rig.raw(`cs${idx}`, () => speech(5, idx, {}), -22);
      if (mode.includes('right')) rig.sing({ midi: target > 60 ? target - 12 : target, dur: 2, seed: idx } as VOpts, -22);
      v = rig.run(3.5, (q) => q.phase !== 'sing'); tot++; if (v.phase !== 'sing') { pass++; lat.push(rig.log[0].lat ?? NaN); }
    }
    row(`sing step with the previous string still ringing; ${mode}: passed`, pass, tot, mode.includes('right') ? `lat med ${med(lat).toFixed(0)} p90 ${pct(lat, 0.9).toFixed(0)}` : '');
  }
}
// ---- P7: after an honest sung note, the voice goes on (held / re-sung / talk) and no pluck: guitar step passed?
if (which === 'voiceplay') {
  for (const mode of ['holds the note 4 s', 'sings it again, staccato x4', 'hums it, dying away', 'talks'] as const) {
    let tot = 0, pass = 0;
    for (const [ei, env] of ENVS.slice(0, 5).entries()) for (const target of TARGETS) for (const vk of [0, 1]) {
      const rig = new Rig({ ...env, seed: 81 + ei, settings: { phraseReview: false } }); rig.begin(idxOf(target)); rig.run(30, (v) => v.phase === 'sing'); rig.run(0.5);
      const sm = vk ? (target < 57 ? target + 12 : target) : (target > 60 ? target - 12 : target); const vo: Partial<VOpts> = vk ? { tract: 1.17, vowel: 'o' } : { vowel: 'a' };
      const ev = rig.sing({ midi: sm, dur: mode.startsWith('holds') ? 5 : 1.2, seed: target, ...vo } as VOpts, -20);
      let v = rig.run(3, (q) => q.phase !== 'sing'); if (v.phase !== 'play') continue; rig.log.length = 0;
      if (mode.startsWith('sings')) { rig.run(0.5); rig.stop(ev); for (let k = 0; k < 4; k++) { rig.sing({ midi: sm, dur: 0.35, seed: target + k, atkMs: 15, relMs: 200, cons: 'd', ...vo } as VOpts, -18); rig.run(0.8, (q) => q.phase !== 'play'); } }
      else if (mode.startsWith('hums')) { rig.run(0.6); rig.stop(ev); rig.run(0.3); const h = rig.sing({ midi: sm, dur: 0.15, relMs: 1500, atkMs: 10, vowel: 'm', seed: target } as VOpts, -18); void h; rig.run(2.5, (q) => q.phase !== 'play'); }
      else if (mode === 'talks') { rig.run(0.3); rig.stop(ev); rig.raw(`vp${target}${vk}`, () => speech(8, target + vk, { female: !!vk }), -22); rig.run(8, (q) => q.phase !== 'play'); }
      else rig.run(4.2, (q) => q.phase !== 'play');
      tot++; if (rig.s.view().phase !== 'play' || rig.log.length) pass++;
    }
    row(`guitar step after an honest sung note, no pluck; singer ${mode}: passed`, pass, tot);
  }
}
