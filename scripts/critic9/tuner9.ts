// Ninth review's tuner probes (ported; the tilt is passed as main.ts now passes it).
// @ts-nocheck (ported review tooling, kept as written)
// Critic-9 tuner probes: TuneWatch + StablePitch + OctaveSlipFilter wired as main.ts tunerScreen wires them.
import { Rig, E, M, SR, HOP } from './rig9.ts';
import { GUITARS } from './syn9.ts';
const BUILD9 = process.env.BUILD_DIR ?? new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const TW = await import(`${BUILD9}/src/core/tunewatch.ts`);
const OPEN = [40, 45, 50, 55, 59, 64]; const NAMES = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];
const isHum = (hz: number) => [50, 60].some((b) => [1, 2, 3].some((k) => Math.abs(hz - b * k) <= 1));
type Evt = { midi: number; cents: number; at: number; string: number };
function run(evts: Evt[], sec: number, env: any, g: any = {}, lvl = -14) {
  const rig: any = new Rig({ room: 'study', phone: 'flagship', ...env }); const sa = new E.StreamAnalyzer(SR); const stable = new M.StablePitch(); const watch = new TW.TuneWatch(); const slips = new TW.OctaveSlipFilter();
  const msgs: string[] = []; let last = ''; const pend = [...evts].sort((a, b) => a.at - b.at); const names: Record<string, number> = {}; const centsShown: number[] = [];
  for (let i = 0; i < 60; i++) { const x = rig.render(); rig.n += HOP; sa.push(x); }
  const t0 = rig.t;
  while (rig.t - t0 < sec) {
    while (pend.length && pend[0].at <= rig.t - t0) { const e = pend.shift()!; rig.pluck({ midi: e.midi, cents: e.cents, string: e.string, seed: Math.round(e.at * 10) + e.midi, dur: 3.5, ...g }, lvl + (g.kind === 'solid' ? -10 : 0)); }
    const x = rig.render(); rig.n += HOP; sa.push(x); const f = sa.frame('guitar', rig.t); sa.frame('voice', rig.t);
    const db = 20 * Math.log10(Math.max(f.rms, 1e-6)); let m = stable.push(f); watch.push(f.t, m, db, f.attacks ?? [], f.tiltDb ?? null); /* (port: wired as main.ts wires it now — with the spectral tilt) */
    if (m !== null && isHum(440 * Math.pow(2, (m - 69) / 12)) && !watch.plucking(f.t)) m = null; m = slips.push(m);
    if (m !== null) { const k = String(Math.round(m)); names[k] = (names[k] ?? 0) + 1; centsShown.push((m - Math.round(m)) * 100); }
    const msg = watch.message() ?? ''; if (msg !== last) { msgs.push(`${(rig.t - t0).toFixed(1)}s:${msg || '(cleared)'}`); last = msg; }
  }
  const top = Object.entries(names).sort((a, b) => b[1] - a[1])[0]?.[0];
  return { msgs, final: last, names, top: top ? Number(top) : null, measured: watch.measured };
}
const guitars = [{ kind: 'jumbo', pluck: 'pick' }, { kind: 'travel', pluck: 'finger' }, { kind: 'classical', pluck: 'thumb' }, { kind: 'rusty', pluck: 'pick' }];
const envs = [{ room: 'study', phone: 'flagship' }, { room: 'lounge', phone: 'cheap' }, { room: 'duvet', phone: 'webrtc' }];
const each = <T>(f: (s: number, g: any, env: any) => T) => { const out: { s: number; kind: string; r: T }[] = []; for (const g of guitars) for (const env of envs) for (let s = 0; s < 6; s++) out.push({ s, kind: g.kind, r: f(s, g, env) }); return out; };
const line = (label: string, rs: { s: number; kind: string; ok: boolean }[]) => { const bad: Record<string, number> = {}; for (const x of rs) if (!x.ok) { bad[NAMES[x.s]] = (bad[NAMES[x.s]] ?? 0) + 1; bad[x.kind] = (bad[x.kind] ?? 0) + 1; } console.log(`${label.padEnd(88)} ${rs.filter((x) => x.ok).length}/${rs.length}  ${Object.entries(bad).map(([k, v]) => k + ':' + v).join(' ')}`); };
const plucks = (s: number, c: number, n: number, midi = OPEN[s]) => Array.from({ length: n }, (_, k) => ({ midi, cents: c + (k % 2 ? 2 : -1), at: 0.3 + 2.4 * k, string: s })) as Evt[];
const which = process.argv[2] ?? 'all'; const list = process.argv.slice(3).map(Number);
if (which === 'intune') for (const c of list.length ? list : [0, 10, -10, 18, -18]) line(`open string ${c} c, 3 plucks -> no warning at any time`, each((s, g, env) => run(plucks(s, c, 3), 7.6, env, g)).map((x) => ({ ...x, ok: x.r.msgs.length === 0 })));
if (which === 'off') for (const c of list.length ? list : [35, -35, 50, -50, 75, -75, 90, -90, 105, -105, 120, -120, 150, -150]) {
  const rs = each((s, g, env) => run(plucks(s, c, 3), 7.6, env, g));
  line(`open string ${c} c off, 3 plucks -> warned, right string and direction`, rs.map((x) => ({ ...x, ok: x.r.final.includes(NAMES[x.s]) && x.r.final.includes(c > 0 ? 'sharp' : 'flat') })));
  line(`     ... a warning naming the wrong string or direction was NOT shown`, rs.map((x) => ({ ...x, ok: !x.r.msgs.some((m) => !m.includes('(cleared)') && !(m.includes(NAMES[x.s]) && m.includes(c > 0 ? 'sharp' : 'flat'))) })));
  line(`     ... the tuner's note display named the string's own note most of the time`, rs.map((x) => ({ ...x, ok: x.r.top === OPEN[x.s] })));
}
if (which === 'fret') for (const c of list.length ? list : [0, 10, 15, 20, 25, 30]) line(`fretted notes (frets 1 and 3 of a string, twice each) ${c} c sharp -> no warning`, each((s, g, env) => run([1, 3].flatMap((fr, k) => [0, 1].map((j) => ({ midi: OPEN[s] + fr, cents: c + j * 2, at: 0.3 + (k * 2 + j) * 2.4, string: s }))) as Evt[], 10.2, env, g)).map((x) => ({ ...x, ok: x.r.msgs.length === 0 })));
if (which === 'show') for (const c of [-90, 90, -120]) { let l = `display for a string ${c} c off (note name shown most): `; for (let s = 0; s < 6; s++) { const r = run(plucks(s, c, 2), 6, envs[0], guitars[0]); l += `${NAMES[s]}->${r.top} `; } console.log(l); }
if (which === 'env') for (const c of list.length ? list : [50]) for (const env of envs) { let ok = 0, n = 0, meas = 0; for (const g of guitars) for (let s = 0; s < 6; s++) { const r = run(plucks(s, c, 3), 7.6, env, g); n++; meas += r.measured.length; if (r.final.includes(NAMES[s])) ok++; } console.log(`open string ${c} c off, ${env.room}/${env.phone}: warned ${ok}/${n}, plucks measured ${meas}/${n * 3}`); }
