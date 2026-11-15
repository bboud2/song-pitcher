// Eighth review's tuner probes (ported).
// @ts-nocheck (ported review tooling, kept as written)
// Critic-8 tuner probes (build B's TuneWatch + StablePitch + OctaveSlipFilter, wired as main.ts wires them)
import { Rig, E, SR, HOP } from './rig8.ts';
const BUILD = process.env.BUILD_DIR ?? new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); const TW = await import(`${BUILD}/src/core/tunewatch.ts`); const M = await import(`${BUILD}/src/core/matcher.ts`);
const OPEN = [40, 45, 50, 55, 59, 64]; const NAMES = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];
const isHum = (hz: number) => [50, 60].some((b) => [1, 2, 3].some((k) => Math.abs(hz - b * k) <= 1));
type Evt = { kind: 'g' | 'v'; midi: number; cents: number; at: number; string?: number; dur?: number };
function run(evts: Evt[], sec: number, env: any, g: any = {}) {
  const rig: any = new Rig({ room: 'bed', phone: 'pixel', ...env }); const sa = new E.StreamAnalyzer(SR); const stable = new M.StablePitch(); const watch = new TW.TuneWatch(); const slips = new TW.OctaveSlipFilter();
  let shown = 0, frames = 0; const msgs: string[] = []; let last = ''; const pend = [...evts].sort((a, b) => a.at - b.at); const names: Record<string, number> = {};
  for (let i = 0; i < 60; i++) { const x = rig.render(); rig.n += HOP; sa.push(x); }
  const t0 = rig.t;
  while (rig.t - t0 < sec) {
    while (pend.length && pend[0].at <= rig.t - t0) { const e = pend.shift()!; if (e.kind === 'g') rig.pluck({ midi: e.midi, cents: e.cents, string: e.string, seed: Math.round(e.at * 10) + e.midi, dur: 3, ...g }, -14); else rig.sing({ midi: e.midi, cents: e.cents, dur: e.dur ?? 2, seed: e.midi, drift: 5 }, -20); }
    const x = rig.render(); rig.n += HOP; sa.push(x); const f = sa.frame('guitar', rig.t); sa.frame('voice', rig.t);
    const db = 20 * Math.log10(Math.max(f.rms, 1e-6)); let m = stable.push(f); watch.push(f.t, m, db, f.attacks ?? []);
    if (m !== null && isHum(440 * Math.pow(2, (m - 69) / 12)) && !watch.plucking(f.t)) m = null; m = slips.push(m);
    frames++; if (m !== null) { shown++; const k = String(Math.round(m)); names[k] = (names[k] ?? 0) + 1; }
    const msg = watch.message() ?? ''; if (msg !== last) { msgs.push(`${(rig.t - t0).toFixed(1)}s:${msg || '(cleared)'}`); last = msg; }
  }
  return { msgs, final: last, shown, frames, names, measured: watch.measured };
}
const guitars = [{ kind: 'dread', pluck: 'pick' }, { kind: 'nylon', pluck: 'thumb' }, { kind: 'parlor', pluck: 'finger' }, { kind: 'dead', pluck: 'pick' }]; const envs = [{ room: 'bed', phone: 'pixel' }, { room: 'kitchen', phone: 'budget' }, { room: 'table', phone: 'hum' }];
const tally = (label: string, f: (s: number, g: any, env: any) => boolean | null, detail = false) => { let ok = 0, n = 0; const bad: string[] = []; for (const g of guitars) for (const env of envs) for (let s = 0; s < 6; s++) { const r = f(s, g, env); if (r === null) continue; n++; if (r) ok++; else bad.push(`${NAMES[s]}/${g.kind}/${env.room}`); } console.log(`${label}: ${ok}/${n}${detail && bad.length ? '  failing: ' + bad.slice(0, 12).join(' ') : ''}`); };
const two = (s: number, c: number) => [{ kind: 'g', midi: OPEN[s], cents: c, at: 0.3, string: s }, { kind: 'g', midi: OPEN[s], cents: c + 3, at: 3.2, string: s }] as Evt[];
const which = process.argv[2] ?? 'all';
if (which === 'all' || which === 'intune') tally('in tune (+4 c), two plucks -> no warning', (s, g, env) => run(two(s, 4), 6.5, env, g).msgs.length === 0, true);
for (const c of [35, -35, 50, -50]) if (which === 'all' || which === 'off') tally(`string ${c} c off, two plucks -> warned, right string and direction`, (s, g, env) => { const r = run(two(s, c), 6.5, env, g); return r.final.includes(NAMES[s]) && r.final.includes(c > 0 ? 'sharp' : 'flat'); }, true);
for (const c of [80, -80, 150, -150, 220]) if (which === 'all' || which === 'far') tally(`string ${c} c off, two plucks -> "may be the X string, far out"`, (s, g, env) => { const r = run(two(s, c), 6.5, env, g); return r.final.includes('may be the ' + NAMES[s]); }, true);
if (which === 'all' || which === 'one') tally('one pluck 45 c sharp -> no warning yet', (s, g, env) => run([{ kind: 'g', midi: OPEN[s], cents: 45, at: 0.3, string: s }], 4, env, g).msgs.length === 0, true);
if (which === 'all' || which === 'clear') tally('40 c flat twice, then in tune -> warning cleared', (s, g, env) => { const r = run([...two(s, -40), { kind: 'g', midi: OPEN[s], cents: 2, at: 6.2, string: s }], 10, env, g); return r.msgs.length >= 2 && r.final === ''; }, true);
if (which === 'all' || which === 'sung') for (const c of [40, -40, 120]) tally(`sung twice ${c} c from an open string's pitch -> no warning`, (s, g, env) => { if (s === 0 && c < 0) return null; const m = OPEN[s] > 60 ? OPEN[s] - 12 : OPEN[s]; return run([{ kind: 'v', midi: m, cents: c, at: 0.3 }, { kind: 'v', midi: m, cents: c, at: 3.2 }], 6.5, env).msgs.length === 0; }, true);
if (which === 'all' || which === 'fret') for (const c of [0, 15, 25]) tally(`fretted note (fret 1 and fret 3 of each string) ${c} c sharp, twice each -> no warning`, (s, g, env) => { const r = run([1, 3].flatMap((fr, k) => [{ kind: 'g', midi: OPEN[s] + fr, cents: c, at: 0.3 + k * 5.6, string: s }, { kind: 'g', midi: OPEN[s] + fr, cents: c + 2, at: 3.0 + k * 5.6, string: s }] as Evt[]), 11.5, env, g); return r.msgs.length === 0; }, true);
if (which === 'all' || which === 'd150') for (const c of [30, 35, 40]) tally(`D string ${c} c sharp (~150 Hz): note shown on at least 40% of the first 2 s`, (s, g, env) => { if (s !== 2) return null; const r = run([{ kind: 'g', midi: 50, cents: c, at: 0.3, string: 2 }], 2.3, env, g); return r.shown / r.frames >= 0.4; }, true);
if (which === 'dbg') { const r = run(two(Number(process.argv[3]), Number(process.argv[4])), 6.5, envs[Number(process.argv[6] ?? 0)], guitars[Number(process.argv[5] ?? 0)]); console.log(JSON.stringify({ msgs: r.msgs, measured: r.measured, names: r.names, shown: r.shown, frames: r.frames })); }
const four = (s: number, c: number) => [0.3, 3.1, 5.9, 8.7].map((at, k) => ({ kind: 'g', midi: OPEN[s], cents: c + k, at, string: s })) as Evt[];
if (which === 'four') {
  tally('in tune (-3 c), four plucks -> no warning', (s, g, env) => run(four(s, -3), 12, env, g).msgs.length === 0, true);
  for (const c of [40, -40, 55, -55]) tally(`string ${c} c off, FOUR plucks -> warned, right string and direction`, (s, g, env) => { const r = run(four(s, c), 12, env, g); return r.final.includes(NAMES[s]) && r.final.includes(c > 0 ? 'sharp' : 'flat'); }, true);
  for (const c of [90, -90, 150, -150]) tally(`string ${c} c off, FOUR plucks -> "may be the X string, far out"`, (s, g, env) => { const r = run(four(s, c), 12, env, g); return r.final.includes('may be the ' + NAMES[s]); }, true);
  for (const c of [40, -55, 150]) tally(`string ${c} c off, FOUR plucks -> any wrong-string or wrong-direction warning shown at some point`, (s, g, env) => { const r = run(four(s, c), 12, env, g); return !r.msgs.some((m) => !m.includes('(cleared)') && !(m.includes(NAMES[s]) && m.includes(c > 0 ? 'sharp' : 'flat'))); }, true);
  tally('45 c flat x4, then in tune x2 -> warned, then cleared', (s, g, env) => { const r = run([...four(s, -45), { kind: 'g', midi: OPEN[s], cents: 2, at: 11.5, string: s }, { kind: 'g', midi: OPEN[s], cents: 1, at: 14.3, string: s }], 18, env, g); return r.msgs.length >= 2 && r.final === ''; }, true);
}
