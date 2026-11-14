// Ported from the fifth external review (read-only original), kept as a permanent test.
// First-pluck acceptance of a correct, in-tune pluck (guitar step only, skip-sing) by pluck style x room x phone chain.
import { Rig, SONG, med, type Env } from './rig5.ts';
const midis: number[] = SONG.notes.map((q: any) => 48 + q.offset);
const uniq = [...new Set(midis)].sort((a, b) => a - b);
export const ROOMS5: [string, Env][] = [
  ['anechoic', { room: null }], ['0.3 m, DRR +8, RT .35', { room: { drr: 8, rt: 0.35 } }], ['0.5 m, DRR +4, RT .4', { room: { drr: 4, rt: 0.4 } }], ['1 m, DRR 0, RT .45', { room: { drr: 0, rt: 0.45 } }], ['1 m bedroom, DRR 0, RT .25', { room: { drr: 0, rt: 0.25 } }], ['2 m, DRR -5, RT .55', { room: { drr: -5, rt: 0.55 } }],
  ['0.5 m + hp150 lp7k NS', { room: { drr: 4, rt: 0.4 }, hpHz: 150, lpHz: 7000, ns: true }], ['0.5 m + lp3.4k', { room: { drr: 4, rt: 0.4 }, lpHz: 3400 }], ['0.5 m + AGC', { room: { drr: 4, rt: 0.4 }, agc: { downDbS: 80, upDbS: 4, target: -18, max: 18 } }], ['0.5 m + comp 3:1 5ms', { room: { drr: 4, rt: 0.4 }, comp: { thDb: -30, ratio: 3, attMs: 5 } }],
  ['ISM shoebox 0.3 m a=.3', { room: { ism: 0.3 } }], ['ISM shoebox 0.6 m a=.3', { room: { ism: 0.6 } }], ['ISM shoebox 1 m a=.3', { room: { ism: 1 } }], ['ISM shoebox 1 m a=.5 (soft)', { room: { ism: 1, alpha: 0.5 } }],
  ['ISM 0.6 m a=.15 (live)', { room: { ism: 0.6, alpha: 0.15 } }], ['ISM 1 m a=.15 (live)', { room: { ism: 1, alpha: 0.15 } }], ['ISM 1 m a=.2', { room: { ism: 1, alpha: 0.2 } }], ['ISM 2 m a=.2', { room: { ism: 2, alpha: 0.2 } }],
  ['anechoic + lp3.4k', { room: null, lpHz: 3400 }], ['anechoic + NS', { room: null, ns: true }],
];

export const STYLES5: [string, any][] = [['pick steel', {}], ['finger steel', { pluck: 'finger' }], ['thumb steel', { pluck: 'thumb' }], ['finger nylon', { pluck: 'finger', kind: 'nylon' }], ['thumb nylon', { pluck: 'thumb', kind: 'nylon' }]];
export interface PluckRow { room: string; style: string; first: number; any: number; n: number; lat: number; missed: number[] }
/** First-pluck acceptance of a correct, in-tune pluck (guitar step only) for one room and one style. */
export function pluckRoom(ri: number, si: number): PluckRow {
  const [rn, env] = ROOMS5[ri]; const [sn, g] = STYLES5[si];
  let first = 0, any = 0, n = 0; const lat: number[] = []; const miss: number[] = [];
  for (const tg of uniq) for (let s = 0; s < 2; s++) {
    const rig = new Rig({ ...env, seed: 40 + s + ri, settings: { skipSing: true, phraseReview: false } });
    rig.begin(midis.indexOf(tg)); rig.run(20, (q: any) => q.phase === 'play'); rig.run(0.6); n++;
    let ok = false, k = 0; for (; k < 4 && !ok; k++) { const ev = rig.pluck({ midi: tg, seed: tg * 3 + s + k, ...g }, -14 - 4 * s); ok = rig.run(2.2, (q: any) => q.phase !== 'play').phase !== 'play'; if (ok && k === 0) lat.push((rig.t - ev.onset) * 1000); }
    if (ok && k === 1) first++; else miss.push(tg); if (ok) any++;
  }
  return { room: rn, style: sn, first, any, n, lat: med(lat), missed: [...new Set(miss)] };
}
if (process.argv[1]?.endsWith('pluckroom5.ts')) {
  const sel = process.env.ROOMS ? process.env.ROOMS.split(',').map(Number) : ROOMS5.map((_, i) => i);
  for (const ri of sel) for (let si = 0; si < STYLES5.length; si++) { const r = pluckRoom(ri, si); console.log(`${r.room.padEnd(26)} ${r.style.padEnd(13)} first ${String(r.first).padStart(2)}/${r.n}  within4 ${String(r.any).padStart(2)}/${r.n}  lat ${r.lat.toFixed(0)}  missed: ${r.missed.join(',')}`); }
}
