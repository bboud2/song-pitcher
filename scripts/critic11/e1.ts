// @ts-nocheck (ported review tooling, kept as written)
// Eleventh review (ported unchanged except for where it finds the build).
// Sing-step single trials: honest (H*) and accidental (A*) cases. One JSON line per trial.
// usage: BUILD_DIR=... node e1.ts <caseFilterRegex> > out.jsonl
import { Rig, MIDIS, plainNote, man, woman, child, guitar, talk, bump, SR } from './rig11.ts';
const filt = new RegExp(process.argv[2] ?? '.');
const IDX = [3, 13, 21, 44, 52, 68, 92];           // 13, 21, 52 are repeated notes
const REP = [13, 21, 38, 52, 55, 76, 80];
const ROOMS3 = ['lounge', 'hall', 'bath'];
interface Case { name: string; kind: 'H' | 'A'; idx?: number[]; rooms?: string[]; prev?: 'cold' | 'ring' | 'damp'; env?: any; g?: any; gDb?: number; act: (rig: Rig, tg: number, open: number, ref: number, seed: number) => { on?: number; end?: number } | void; wait?: number; retry?: boolean }
const cases: Case[] = [];
const H = (name: string, act: Case['act'], extra: Partial<Case> = {}) => cases.push({ name, kind: 'H', act, ...extra });
const A = (name: string, act: Case['act'], extra: Partial<Case> = {}) => cases.push({ name, kind: 'A', act, ...extra });
const sing = (o: any, dt: number, db: number, oct: (m: number) => number = man) => (rig: Rig, tg: number, open: number, ref: number, seed: number) => { rig.sing({ midi: oct(tg), seed, ...o }, open + dt, db); return { on: open + dt, end: open + dt + o.dur }; };

// ---- honest
for (const fade of [12, 16, 22, 30]) for (const dur of [0.8, 1.2]) H(`H1 fade${fade} dur${dur}`, sing({ dur, fade }, 0.4, -22));
for (const dur of [0.6, 0.8, 1.0]) H(`H2 child la dur${dur} fade10`, sing({ dur, fade: 10, on: 'la', child: true }, 0.5, -26, child));
for (const dur of [0.7, 1.0]) H(`H3 breathy ha dur${dur} fade6`, sing({ dur, fade: 6, on: 'ha', breathy: 0.8, vowel: 'oo' }, 0.5, -28));
for (const dt of [-1.3, -0.5, -0.05]) for (const db of [-20, -28, -34]) H(`H4 early ${dt} lvl${db} hold3 fade0`, sing({ dur: 3.2, fade: 0 }, dt, db));
for (const dt of [-0.9, -0.3]) for (const fade of [5, 9, 13]) H(`H4b early ${dt} lvl-24 fade${fade} hold3`, sing({ dur: 3.2, fade }, dt, -24));
for (const fade of [8, 11, 14]) H(`H4c early -0.5 dur1.5 fade${fade}`, sing({ dur: 1.5, fade }, -0.5, -22));
for (const db of [-34, -38]) for (const prev of ['ring', 'damp'] as const) H(`H5 quiet ${db} after loud pluck(-6) ${prev}`, sing({ dur: 2.5 }, 0.5, db), { prev, gDb: -6 });
for (const db of [-34, -38]) H(`H5r quiet ${db} after loud pluck(-6) ring REPEATED`, sing({ dur: 2.5 }, 0.5, db), { gDb: -6, idx: REP });
for (const dt of [0.3, 0.7]) H(`H6 live rooms normal +${dt}`, sing({ dur: 2.5 }, dt, -24), { rooms: ['stair', 'bath', 'church'] });
H('H6b live rooms quiet -32 loud spk -6', sing({ dur: 2.5 }, 0.4, -32), { rooms: ['stair', 'bath', 'church'], env: { spk: -6 } });
H('H7 octave up (woman)', sing({ dur: 2.5, woman: true }, 0.5, -24, woman));
H('H7 two octaves up (child, low targets)', sing({ dur: 2.5, child: true, vowel: 'ee' }, 0.5, -24, (m) => (m <= 55 ? m + 24 : m + 12)));
H('H7 octave down (bass)', sing({ dur: 2.5, vowel: 'oh' }, 0.5, -24, (m) => (m >= 55 ? m - 12 : m)));
for (const dur of [0.4, 0.6, 0.8]) H(`H8 start +0.05 dur${dur}`, sing({ dur }, 0.05, -22));
H('H9 vibrato 70c 6Hz', sing({ dur: 2.5, vibC: 70, vibHz: 6 }, 0.5, -24));
H('H9 scoop 250c/150ms', sing({ dur: 2.5, scoopC: 250, scoopMs: 150 }, 0.5, -24));
H('H9 hard da onset', sing({ dur: 2.5, on: 'da' }, 0.5, -22));
H('H9 hum mm quiet -32', sing({ dur: 2.5, on: 'hm', vowel: 'mm' }, 0.5, -32));
H('H10 agc phone normal', sing({ dur: 2.5 }, 0.5, -26), { env: { agc: true } });
H('H10 agc phone early -0.6', sing({ dur: 3 }, -0.6, -26), { env: { agc: true } });
H('H11 soft start over ringing REPEATED (rise 250ms, -30)', sing({ dur: 2.5, riseMs: 250 }, 0.4, -30), { idx: REP });
H('H11 early -0.5 over ringing REPEATED -26', sing({ dur: 3 }, -0.5, -26), { idx: REP });
H('H11 early -0.5 over ringing REPEATED -26 long-sustain guitar', sing({ dur: 3 }, -0.5, -26), { idx: REP, g: { sustain: 2 } });

// ---- accidental (nobody sings the right note)
const none = () => {};
for (const spk of [-6, -14]) for (const speaker of ['phone', 'tablet']) A(`A1 ref tail alone spk${spk} ${speaker}`, none, { rooms: ['lounge', 'kitchen', 'hall', 'stair', 'bath', 'church'], prev: 'damp', env: { spk, speaker } });
A('A1c ref tail alone spk-6 cold start', none, { rooms: ['lounge', 'kitchen', 'hall', 'stair', 'bath', 'church'], prev: 'cold', env: { spk: -6 } });
A('A1d ref tail alone spk-6 agc', none, { rooms: ['kitchen', 'hall', 'stair', 'bath'], prev: 'damp', env: { spk: -6, agc: true } });
for (const g of [{}, { sustain: 2 }, { kind: 'electric' }, { kind: 'nylon' }]) for (const gDb of [-8, -20]) A(`A2 string ringing only ${JSON.stringify(g)} ${gDb}`, none, { idx: REP, g, gDb });
A('A2b string ringing only agc', none, { idx: REP, env: { agc: true } });
for (const kind of ['knock', 'page', 'breath', 'cough', 'chair']) for (const dt of [0.7, 2]) for (const db of [-24]) A(`A3 ringing + ${kind} @${dt} ${db}`, (rig, tg, open, ref, seed) => { rig.raw(`b${kind}${seed}`, () => bump(kind as any, seed), open + dt, db); }, { idx: REP, rooms: ['lounge', 'hall'] });
for (const kind of ['knock', 'breath', 'cough']) A(`A3b ref tail + ${kind} @0.6 -20 spk-6`, (rig, tg, open, ref, seed) => { rig.raw(`b${kind}${seed}`, () => bump(kind as any, seed), open + 0.6, -20); }, { rooms: ['hall', 'stair', 'bath'], prev: 'damp', env: { spk: -6 } });
for (const db of [-36, -28]) A(`A4 sympathetic string (pc of target, 8ve up) ${db}`, (rig, tg, open, ref, seed) => { rig.add(rig.wet(`sy${tg}`, () => guitar({ midi: tg + 12, touch: 'thumb', sustain: 2.5, dur: 9 }), 0), ref - 2.2, db, 'x'); }, { idx: [4, 7, 9, 17, 22, 32, 44] });
for (const db of [-36, -28]) A(`A4b sympathetic string same octave ${db}`, (rig, tg, open, ref, seed) => { rig.add(rig.wet(`sy${tg}s`, () => guitar({ midi: tg, touch: 'thumb', sustain: 2.5, dur: 9 }), 0), ref - 2.2, db, 'x'); }, { idx: [4, 7, 9, 17, 22, 32, 44] });
for (const stopAt of [-0.3, 0, 0.15, 0.3, 0.45]) for (const db of [-30, -36]) A(`A5 hum with ref, stop @${stopAt} ${db}`, (rig, tg, open, ref, seed) => { const d = open + stopAt - (ref + 0.2); rig.sing({ midi: man(tg), dur: d, on: 'hm', vowel: 'mm', relMs: 150, seed }, ref + 0.2, db); });
for (const off of [-3, -2, -1, 1, 2, 4]) A(`A6 wrong ${off} over ref tail spk-8`, (rig, tg, open, ref, seed) => { rig.sing({ midi: man(tg) + off, dur: 2.5, seed }, open + 0.4, -24); }, { rooms: ['hall', 'bath', 'church'], prev: 'damp', env: { spk: -8 } });
for (const off of [-2, -1, 1, 2]) A(`A6b wrong ${off} sung early(-0.6) over ref tail spk-8`, (rig, tg, open, ref, seed) => { rig.sing({ midi: man(tg) + off, dur: 3, seed }, open - 0.6, -24); }, { rooms: ['hall', 'bath', 'church'], prev: 'damp', env: { spk: -8 } });
for (const off of [-3, -2, -1, 1, 2, 4]) A(`A7 wrong ${off} over ringing REPEATED`, (rig, tg, open, ref, seed) => { rig.sing({ midi: man(tg) + off, dur: 2.5, seed }, open + 0.4, -26); }, { idx: REP });
A('A7b wrong -1 quiet(-34) over ringing REPEATED loud pluck', (rig, tg, open, ref, seed) => { rig.sing({ midi: man(tg) - 1, dur: 2.5, seed }, open + 0.4, -34); }, { idx: REP, gDb: -8 });
for (const w of [false, true]) A(`A8 talking over ringing REPEATED ${w ? 'woman' : 'man'}`, (rig, tg, open, ref, seed) => { rig.raw(`tk${seed}${w}`, () => talk(6, seed, w), open + 0.2, -24); }, { idx: REP });
A('A8b talking over ref tail spk-8', (rig, tg, open, ref, seed) => { rig.raw(`tk${seed}`, () => talk(6, seed), open + 0.2, -24); }, { rooms: ['hall', 'bath'], prev: 'damp', env: { spk: -8 } });
A('A9 talking only (damped)', (rig, tg, open, ref, seed) => { rig.raw(`tk${seed}`, () => talk(6, seed, seed % 2 === 0), open + 0.2, -22); }, { prev: 'damp' });

for (const c of cases) {
  if (!filt.test(c.name)) continue;
  for (const room of c.rooms ?? ROOMS3) for (const i of c.idx ?? IDX) {
    const seed = i * 7 + room.length; const prev = c.prev ?? 'ring';
    const rig = new Rig({ room, spk: -14, seed, ...(c.env ?? {}) });
    const out: any = { case: c.name, kind: c.kind, room, i, tg: MIDIS[i] };
    if (prev === 'cold') rig.begin(i); else { rig.begin(i - 1); if (!plainNote(rig, seed, c.g ?? {}, c.gDb ?? -14, -24, prev === 'ring')) { out.res = 'setup-failed'; console.log(JSON.stringify(out)); continue; } }
    let open = 0, ref = 0, info: any = {};
    rig.onRef = (r, o) => { ref = r; open = o; info = c.act(rig, MIDIS[i], o, r, seed) ?? {}; rig.onRef = null; };
    rig.run(rig.t + 6, () => open > 0);
    const acc = () => rig.phase() !== 'sing' && rig.t > open;
    if (c.kind === 'A') {
      rig.run(open + 7, acc);
      out.res = rig.phase() === 'sing' ? 'held' : 'ADVANCED'; if (out.res === 'ADVANCED') { out.at = +(rig.t - open).toFixed(2); out.det = rig.advs.at(-1)?.det; }
      out.hints = rig.hints.join(',');
    } else {
      rig.run(Math.max(open, info.end) + 0.35, acc);
      const firstHints = rig.hints.join(',');
      if (rig.phase() !== 'sing') { out.res = 'first'; out.lat = Math.round(1000 * (rig.t - Math.max(info.on, open))); }
      else {
        out.res = 'stuck';
        for (let k = 2; k <= 3; k++) { const ev = rig.sing({ midi: man(MIDIS[i]), dur: 2.5, seed: seed + k }, rig.t + 1.0, -24); const on = rig.t + 1.0; rig.run(on + 2.9, acc); if (rig.phase() !== 'sing') { out.res = 'try' + k; out.lat = Math.round(1000 * (rig.t - on)); break; } }
      }
      out.hints = firstHints;
    }
    console.log(JSON.stringify(out));
  }
}
