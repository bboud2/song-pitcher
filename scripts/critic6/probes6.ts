// Ported from the sixth external review (read-only original), kept as a permanent test.
// In-session probes: honest sing, then ONE thing is done in the guitar step; did the app advance?
import { Rig, sungMidi, type Env } from './rig6.ts';
import { rng, SR, OPEN, stringFor, thump, clap, type GOpts, type VOpts } from './syn6.ts';
export const R: Record<string, NonNullable<Env['room']> | null> = {
  anech: null, dry: { rt: 0.3, drrG: 10 }, living: { rt: 0.5, drrG: 2, taps: [[0.35, 0.8], [1.4, 0.55], [7.3, 0.45], [13.1, 0.35]] }, live: { rt: 0.8, drrG: -4, taps: [[1.7, 0.7], [5.9, 0.5], [17.3, 0.4]] }, bath: { rt: 1.3, drrG: -6, taps: [[0.9, 0.8], [3.1, 0.6], [9.7, 0.5]] },
};
type Act = (rig: Rig, target: number, r: () => number, k: number) => boolean | void; // return false = not applicable
export function probe(name: string, room: string, act: Act, opts: { n?: number; filter?: (m: number) => boolean; env?: Partial<Env>; wait?: number; female?: boolean; singFirst?: boolean } = {}) {
  const rig = new Rig({ seed: 7 + name.length, room: R[room], spk: { db: -10 }, settings: { phraseReview: false }, ...(opts.env ?? {}) }); const r = rng(name.length * 13 + room.length);
  let voiceEv: any = null; let stopAt = Infinity; let tried = 0, acc = 0; const lat: number[] = []; const hints: Record<string, number> = {}; let k = 0;
  const tick = (sec: number, until?: (v: any) => boolean) => { const end = rig.t + sec; let v = rig.s.view(); while (rig.t < end) { if (voiceEv && rig.t >= stopAt) { rig.stop(voiceEv, 60); voiceEv = null; stopAt = Infinity; } v = rig.step(); if (v.phase === 'done' || (until && until(v))) break; } return v; };
  rig.begin(0);
  for (;;) {
    let v = tick(60, (q) => q.phase !== 'listen'); if (v.phase === 'done' || tried >= (opts.n ?? 40)) break;
    const target = v.targetMidi; const idx = v.index;
    if (v.phase === 'sing') { tick(0.5); const sm = sungMidi(target, opts.female); voiceEv = rig.sing({ midi: sm, dur: 5, seed: idx, scoop: 20, female: opts.female }, -27); stopAt = Infinity; v = tick(5, (q) => q.phase !== 'sing'); if (v.phase === 'sing') { rig.stop(voiceEv); voiceEv = null; rig.skip(); continue; } stopAt = rig.t + 0.1 + 0.2 * r(); }
    v = tick(0.9 + 0.3 * r(), (q) => q.phase !== 'play' || q.index !== idx);
    if (v.phase !== 'play' || v.index !== idx) { continue; }
    if (opts.filter && !opts.filter(target)) { rig.skip(); continue; }
    const t0 = rig.t; const h0 = { ...rig.hints }; const ok = act(rig, target, r, k++); if (ok === false) { rig.skip(); continue; }
    tried++; v = tick(opts.wait ?? 3, (q) => q.phase !== 'play' || q.index !== idx);
    if (v.phase !== 'play' || v.index !== idx) { acc++; lat.push((rig.t - t0) * 1000); } else { for (const [kk, n] of Object.entries(rig.hints)) if (n > (h0[kk] ?? 0) && kk.startsWith('play:')) hints[kk] = (hints[kk] ?? 0) + 1; rig.damp(); rig.skip(); }
    rig.damp();
  }
  lat.sort((a, b) => a - b);
  console.log(`${name.padEnd(52)} ${room.padEnd(7)} ACCEPTED ${acc}/${tried}${lat.length ? ` (med ${lat[lat.length >> 1].toFixed(0)} ms)` : ''}  hints when refused: ${JSON.stringify(hints)}`);
  return { acc, tried };
}
export const g = (o: GOpts, lvl = -14) => (rig: Rig) => { rig.pluck({ dur: 3.2, ...o }, lvl, 0, false); };
export const SETS: Record<string, () => void> = {
  octave: () => {
    for (const room of ['anech', 'living', 'live']) {
      const lowOk = (m: number) => m - 12 >= 40;
      probe('octave LOW, pick', room, (rig, t, r) => g({ midi: t - 12, seed: 3 + Math.floor(r() * 5) })(rig), { filter: lowOk, n: 30 });
      probe('octave LOW, new strings hard pick at bridge', room, (rig, t, r) => g({ midi: t - 12, age: 'new', pluck: 'hardpick', beta: 0.04 + 0.03 * r(), seed: 4 }, -8)(rig), { filter: lowOk, n: 30 });
      probe('octave LOW, plucked at 12th-fret node (beta .5)', room, (rig, t, _r) => g({ midi: t - 12, beta: 0.5, seed: 5 })(rig), { filter: lowOk, n: 30 });
      probe('octave LOW, beta .25 (kills 4th, strong 2nd)', room, (rig, t, _r) => g({ midi: t - 12, beta: 0.25, pluck: 'nail', seed: 6 })(rig), { filter: lowOk, n: 30 });
      probe('octave LOW, thumb, heavy body', room, (rig, t, _r) => g({ midi: t - 12, pluck: 'thumb', body: 2.2, seed: 7 })(rig), { filter: lowOk, n: 30 });
      probe('octave LOW, weak fundamental (HP300 phone mic)', room, (rig, t, _r) => g({ midi: t - 12, pluck: 'pick', age: 'new', seed: 8 })(rig), { filter: lowOk, n: 30, env: { hpHz: 300 } });
      probe('octave LOW on lower string (fret 5+)', room, (rig, t, _r) => { const s = stringFor(t - 12).s; if (s === 0) return false; g({ midi: t - 12, string: s - 1, seed: 9 })(rig); }, { filter: lowOk, n: 30 });
      probe('octave HIGH, pick', room, (rig, t, _r) => g({ midi: t + 12, seed: 3 })(rig), { n: 30 });
      probe('octave HIGH, thumb soft', room, (rig, t, _r) => g({ midi: t + 12, pluck: 'thumb', seed: 4 }, -20)(rig), { n: 30 });
      probe('octave HIGH + open low octave string sympathetic', room, (rig, t, _r) => { rig.pluck({ midi: t + 12, seed: 5, dur: 3.2 }, -14, 0, false, true); }, { n: 30 });
    }
  },
  interval: () => {
    for (const room of ['anech', 'living']) {
      for (const iv of [7, -5, -7, 5, 4, -1, 1, 2, -2]) probe(`wrong note ${iv > 0 ? '+' : ''}${iv} st, pick`, room, (rig, t, r) => { if (t + iv < 40) return false; g({ midi: t + iv, seed: 3 + Math.floor(3 * r()) })(rig); }, { n: 25 });
      probe('two strings at once: target-fifth dyad (wrong louder)', room, (rig, t, _r) => { rig.pluck({ midi: t + 7, seed: 3, dur: 3.2 }, -12, 0, false); rig.pluck({ midi: t - 5 >= 40 ? t - 5 : t + 4, seed: 4, dur: 3.2 }, -16, Math.round(0.01 * SR), false); }, { n: 25 });
      probe('strum of all open strings', room, (rig, _t, _r) => { OPEN.forEach((m, i) => rig.pluck({ midi: m, seed: 3, dur: 3.2, pluck: 'pick' }, -16, Math.round(i * 0.012 * SR), false)); }, { n: 25, filter: (m) => !OPEN.includes(m) });
    }
  },
  sharp: () => {
    for (const room of ['anech', 'living']) for (const pl of ['pick', 'hardpick', 'finger'] as const) for (const c of [30, 40, 45, 50, 55]) {
      probe(`fret BELOW on string +${c} c, ${pl}`, room, (rig, t, r) => { if (t - 1 < 40) return false; g({ midi: t - 1, cents: c, pluck: pl, seed: 3 + Math.floor(3 * r()) }, pl === 'hardpick' ? -7 : -14)(rig); }, { n: 20 });
    }
    for (const room of ['anech', 'living']) for (const c of [-40, -50, -55]) probe(`fret ABOVE on string ${c} c, pick`, room, (rig, t, _r) => g({ midi: t + 1, cents: c, seed: 3 })(rig), { n: 20 });
    // honest: right fret, string sharp (should be accepted up to +45, said out of tune beyond)
    for (const room of ['living']) for (const pl of ['pick', 'hardpick'] as const) for (const c of [20, 30, 40, 50]) probe(`RIGHT fret, string +${c} c, ${pl} (honest)`, room, (rig, t, r) => { rig.pluck({ midi: t, cents: c, pluck: pl, seed: 3 + Math.floor(3 * r()), dur: 3.2 }, pl === 'hardpick' ? -7 : -14, 0, true); }, { n: 20 });
  },
  voice: () => {
    const V: Record<string, (m: number, r: () => number) => VOpts> = {
      'hm dying 0.3-0.9s': (m, r) => ({ midi: m, vowel: 'm', onset: 'soft', dur: 0.3 + 0.6 * r(), fadeDbS: 8 + 17 * r() }),
      'hm held 1.5 s': (m, _r) => ({ midi: m, vowel: 'm', onset: 'soft', dur: 1.5 }),
      'la short 0.25-0.65s': (m, r) => ({ midi: m, vowel: 'a', onset: 'l', dur: 0.25 + 0.4 * r(), fadeDbS: 10 * r(), release: 0.08 }),
      'doo short': (m, r) => ({ midi: m, vowel: 'u', onset: 'd', dur: 0.2 + 0.3 * r(), fadeDbS: 10, release: 0.1 }),
      'ah held 1.5 s vib': (m, _r) => ({ midi: m, vowel: 'a', onset: 'normal', dur: 1.5, vibCents: 25 }),
      'ah swell-fade (natural phrase end) 1 s': (m, _r) => ({ midi: m, vowel: 'a', onset: 'soft', dur: 1.0, envDb: (t) => -14 * t * t }),
    };
    for (const room of ['anech', 'dry', 'living', 'live', 'bath']) for (const [nm, f] of Object.entries(V)) probe(`VOICE only: ${nm}`, room, (rig, t, r, k) => { rig.sing({ ...f(sungMidi(t), r), seed: k * 7 + 1 }, -32 + 8 * r()); }, { n: 24 });
  },
  nsgate: () => {
    // browser ignores noiseSuppression:false -> floor is gated; does a HELD voice now look like a dying string?
    const ns = { creepDbS: 12, floorDb: -15, beta: 2.5 };
    for (const room of ['dry', 'living']) for (const [nm, o] of [['hm held 1.5 s', { vowel: 'm', onset: 'soft', dur: 1.5 }], ['ah held 1.5 s', { vowel: 'a', dur: 1.5 }], ['oo held 3 s', { vowel: 'u', dur: 3 }]] as [string, Partial<VOpts>][]) {
      probe(`NS on: VOICE only ${nm}`, room, (rig, t, _r, k) => { rig.sing({ midi: sungMidi(t), dur: 1, ...o, seed: k * 5 + 2 } as VOpts, -28); }, { n: 24, env: { ns }, wait: 4 });
      probe(`NS off: VOICE only ${nm}`, room, (rig, t, _r, k) => { rig.sing({ midi: sungMidi(t), dur: 1, ...o, seed: k * 5 + 2 } as VOpts, -28); }, { n: 24, wait: 4 });
      probe(`digital-silence floor (-120): VOICE only ${nm}`, room, (rig, t, _r, k) => { rig.sing({ midi: sungMidi(t), dur: 1, ...o, seed: k * 5 + 2 } as VOpts, -28); }, { n: 24, env: { floorDb: -120 }, wait: 4 });
    }
  },
  noise: () => {
    for (const room of ['living']) {
      probe('table thump only', room, (rig, _t, r) => { rig.noise(thump(Math.floor(r() * 1e5), 70 + 60 * r()), -10); }, { n: 25 });
      probe('clap only', room, (rig, _t, r) => { rig.noise(clap(Math.floor(r() * 1e5)), -12); }, { n: 25 });
      probe('previous note re-plucked & left ringing, then thump (target = same string ringing)', room, (rig, t, _r) => { rig.pluck({ midi: t, seed: 3, dur: 5, t60x: 1.8 }, -12, 0, true); rig.plucks.pop(); rig.run(0.0); }, { n: 1 });
    }
  },
};
if (process.argv[1]?.endsWith('probes6.ts')) for (const s of (process.env.SET ?? Object.keys(SETS).join(',')).split(',')) SETS[s]();
