// Tenth review (ported unchanged except for where it finds the build).
// @ts-nocheck (ported review tooling, kept as written)
// E4: tuner, offline: the tuner screen's frame loop (src/main.ts tunerScreen) with own audio.
import { SR, BQ, db2a, gauss, rng, guitar, voice, roomIR, convolve, G_LEAD, V_LEAD } from './syn10.ts';
// (ported: BUILD_DIR still selects another checkout; by default this repository, whose tuner shows the needle for open-string notes only)
const BUILD = process.env.BUILD_DIR ?? new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); const isB = !BUILD.endsWith('/A');
const E = await import(`${BUILD}/src/core/engine.ts`); const TW = await import(`${BUILD}/src/core/tunewatch.ts`); const M = await import(`${BUILD}/src/core/matcher.ts`); const MU = await import(`${BUILD}/src/core/music.ts`);
const HOP = 960; const OPEN: number[] = MU.OPEN_STRINGS;
export interface Ev { buf: Float32Array; at: number; db: number; cut?: number }
export function runTuner(evs: Ev[], sec: number, o: { room?: string; agc?: boolean; seed?: number; floor?: number } = {}) {
  const n = Math.floor(sec * SR); const x = new Float32Array(n); const ir = roomIR(o.room ?? 'living', 0);
  for (const e of evs) { let b = ir ? convolve(e.buf, ir) : e.buf; const s = Math.round(e.at * SR); const g = db2a(e.db); const cut = e.cut !== undefined ? Math.round(e.cut * SR) : Infinity; for (let i = 0; i < b.length && s + i < n; i++) { const p = s + i; let gg = g; if (p > cut) { const u = (p - cut) / (0.015 * SR); if (u >= 1) break; gg *= 1 - u; } x[p] += gg * b[i]; } }
  const r = rng((o.seed ?? 1) + 5); let p1 = 0, p2 = 0; const hp = new BQ('hp', 110, 0.707); const fl = db2a(o.floor ?? -62); let env = 0, G = 1;
  for (let i = 0; i < n; i++) { const w = gauss(r); p1 += 0.01 * (w - p1); p2 += 0.12 * (w - p2); let v = hp.s(x[i] + fl * (6 * p1 + 1.6 * p2 + 0.5 * w)); if (o.agc) { const a = Math.abs(v); env += (a > env ? 1 - Math.exp(-1 / (0.004 * SR)) : 1 - Math.exp(-1 / (0.2 * SR))) * (a - env); const lv = 20 * Math.log10(env + 1e-9); if (lv > -52) { const want = Math.max(db2a(-12), Math.min(db2a(26), db2a(-18 - lv))); G += (want < G ? 1 - Math.exp(-1 / (0.025 * SR)) : 1 - Math.exp(-1 / (0.7 * SR))) * (want - G); } v *= G; } x[i] = Math.max(-1, Math.min(1, v)); }
  const sa = new E.StreamAnalyzer(SR); const stable = new M.StablePitch(); const watch = new TW.TuneWatch(); const slips = new TW.OctaveSlipFilter();
  const trace: { t: number; note: string | null; cents: number | null; needle: boolean; msg: string | null }[] = [];
  for (let s = 0; s + HOP <= n; s += HOP) {
    sa.push(x.subarray(s, s + HOP)); if (s + HOP < E.FRAME_SIZE) continue; const t = (s + HOP) / SR;
    const f = sa.frame('guitar', t); sa.frame('voice', t); const db = 20 * Math.log10(Math.max(f.rms, 1e-6));
    let m = stable.push(f); watch.push(f.t, m, db, f.attacks ?? [], f.tiltDb ?? null); m = slips.push(m);
    let note = null, cents = null, needle = false;
    if (m !== null) { const nn = MU.nearestNote(440 * Math.pow(2, (m - 69) / 12)); note = MU.noteName(nn.midi); cents = nn.cents; needle = isB ? OPEN.includes(nn.midi) : true; }
    trace.push({ t, note, cents, needle, msg: watch.message() });
  }
  return { trace, watch };
}
export const classify = (msg: string | null, open: number, cents: number) => {
  if (!msg) return 'none'; const name = MU.noteName(open);
  if (msg.startsWith('That is')) return msg.includes(`open ${name} string`) && msg.includes(cents > 0 ? 'sharp' : 'flat') ? 'neutral-right' : 'neutral-other';
  const dir = cents > 0 ? 'sharp' : 'flat'; return msg.includes(`${name} string`) && msg.includes(dir) ? 'warn-right' : 'warn-WRONG';
};
if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2]; const agc = process.argv.includes('agc'); const room = process.argv.find((a) => a.startsWith('room='))?.slice(5) ?? 'living';
  const count = (xs: string[]) => { const c: Record<string, number> = {}; for (const x of xs) c[x] = (c[x] ?? 0) + 1; return JSON.stringify(c); };
  if (mode === 'open') {
    for (const c of [0, 10, -10, 20, -20, 30, -30, 40, -40, 50, -50, 75, -75, 100, -100, 125, -125, 150, -150, 200, -200]) {
      const out: string[] = []; const det: string[] = [];
      for (const o of OPEN) for (const style of ['pick', 'finger']) for (const sd of [1]) {
        const mk = (k: number) => guitar({ midi: o, cents: c + (k ? 3 : -2), open: true, style: style as any, seed: sd * 10 + k, dur: 3 });
        const { trace } = runTuner([{ buf: mk(0), at: 0.8, db: -14, cut: 3.8 }, { buf: mk(1), at: 3.8, db: -15, cut: 6.8 }, { buf: mk(2), at: 6.8, db: -13 }], 10.5, { room, agc, seed: sd + o });
        const msg = trace[trace.length - 1].msg; const k = classify(msg, o, c || 1); out.push(k); if (k.includes('WRONG') || k === 'neutral-other') det.push(`${MU.noteName(o)}:${msg}`);
      }
      console.log(`${String(c).padStart(5)} c  (n=${out.length}) ${count(out)} ${det.slice(0, 2).join(' | ')}`);
    }
  }
  if (mode === 'fretted') {
    for (const sharp of [0, 20, 35]) { const out: string[] = []; const ex: string[] = [];
      for (let s = 0; s < 6; s++) for (let fr = 1; fr <= 4; fr++) { const m = OPEN[s] + fr; if (OPEN.includes(m)) continue;
        const mk = (k: number) => guitar({ midi: m, cents: sharp + k * 3, seed: s * 10 + fr + k, dur: 3 });
        const { trace } = runTuner([{ buf: mk(0), at: 0.8, db: -14, cut: 3.8 }, { buf: mk(1), at: 3.8, db: -15 }], 7.5, { room, agc, seed: m });
        const msg = trace[trace.length - 1].msg; out.push(!msg ? 'none' : msg.startsWith('That is') ? 'neutral' : 'WARN'); if (msg && ex.length < 3) ex.push(msg); }
      console.log(`fretted twice, ${sharp} c sharp (n=${out.length}) ${count(out)}\n   e.g. ${ex.join('\n        ')}`); }
  }
  if (mode === 'sung') { const out: string[] = []; const ex: string[] = [];
    for (const m of [45, 47, 48, 50, 52, 54, 55, 57, 59, 60, 62, 64]) for (const c of [0, 40]) for (const on of ['normal', 'd'] as const) {
      const mk = (k: number) => voice({ midi: m, cents: c, dur: 1.8, onset: on, seed: m + k });
      const { trace } = runTuner([{ buf: mk(0), at: 0.8, db: -20 }, { buf: mk(1), at: 3.8, db: -20 }], 7.5, { room, agc, seed: m });
      const msg = trace[trace.length - 1].msg; out.push(!msg ? 'none' : msg.startsWith('That is') ? 'neutral' : 'WARN'); if (msg && ex.length < 4) ex.push(`${m}+${c} ${on}: ${msg}`); }
    console.log(`sung twice (n=${out.length}) ${count(out)}\n   ${ex.join('\n   ')}`); }
  if (mode === 'noodle') { // the song's first 24 notes played at the tuner screen, one per 1.2 s
    const SONG = (await import(`${BUILD}/src/core/songs.ts`)).STAR_SPANGLED_BANNER; const ms: number[] = SONG.notes.slice(0, 40).map((q: any) => 48 + q.offset);
    const evs = ms.map((m, k) => ({ buf: guitar({ midi: m, seed: k, dur: 3, cents: 5 }), at: 0.8 + 1.2 * k, db: -14, cut: 0.8 + 1.2 * (k + 1) }));
    const { trace } = runTuner(evs, 0.8 + 1.2 * ms.length + 2, { room, agc }); let shown = 0, last = ''; const seen = new Set<string>(); let hid = 0, tot = 0;
    for (const q of trace) { if (q.msg) { shown++; seen.add(q.msg); } if (q.note) { tot++; if (!q.needle) hid++; } }
    console.log(`noodle (40 song notes): a message on show for ${(shown * 0.02).toFixed(1)} s of ${(trace.length * 0.02).toFixed(1)} s; needle hidden ${hid}/${tot} pitched frames; messages:\n   ${[...seen].join('\n   ')}`); }
  if (mode === 'tuneup') { // A string 100 c flat, brought up 12 c per pluck, one pluck every 2 s
    for (const [o, from] of [[45, -100], [40, -150], [64, 110], [55, -60]] as [number, number][]) {
      const steps: number[] = []; for (let c = from; Math.abs(c) > 6; c += from < 0 ? 12 : -12) steps.push(c); steps.push(0, 0);
      const evs = steps.map((c, k) => ({ buf: guitar({ midi: o, cents: c, open: true, seed: k, dur: 3 }), at: 0.8 + 2 * k, db: -14, cut: 0.8 + 2 * (k + 1) }));
      const { trace } = runTuner(evs, 0.8 + 2 * steps.length + 1, { room, agc });
      console.log(`--- ${MU.noteName(o)} string from ${from} c`);
      steps.forEach((c, k) => { const fr = trace.filter((q) => q.t > 0.8 + 2 * k + 0.5 && q.t < 0.8 + 2 * k + 1.95); const withNote = fr.filter((q) => q.note); const q = withNote[withNote.length >> 1]; console.log(`  pluck ${String(c).padStart(5)} c: shows ${q?.note ?? '-'} ${q ? (q.needle ? 'needle ' + q.cents!.toFixed(0) + ' c' : 'NO NEEDLE "Not an open-string note"') : ''}  | advice: ${fr[fr.length - 1]?.msg ?? '(none)'}`); });
    }
  }
}
