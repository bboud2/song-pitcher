// In-session pitch bias check. A detector that has listened to a whole realistic session (the
// student's voice, let-ring notes, pauses) must read a new pluck exactly as a fresh detector does.
// Isolated-note tests always start fresh and cannot see state the detector learns along the way
// (round 3's noise tracker learned the student's own notes and read every later pluck sharp).
//
//   node scripts/bias.ts            prints the table (both synths, E2..E5, three levels)
import { FRAME_SIZE, HOP_MS, StreamAnalyzer } from '../src/core/engine.ts';
import type { PitchDetector } from '../src/core/pitch.ts';
import * as S3 from './fixtures3.ts';
import { gtr } from './critic3/synth.ts';
import { Rig as CriticRig } from './critic3/rig.ts';
import { student as criticStudent } from './critic3/student.ts';

const SR = 48000;
export const BIAS_NOTES = [40, 45, 52, 57, 64, 69, 76];
export const BIAS_LEVELS = [-14, -26, -38];

type Snap = { label: string; det: PitchDetector };

/** Deep copy of a detector's learned state (scratch buffers may be shared). */
function cloneDetector(d: PitchDetector): PitchDetector {
  const c = Object.assign(Object.create(Object.getPrototypeOf(d)), d) as Record<string, unknown>;
  for (const [k, v] of Object.entries(c)) {
    if (k === 'noise' || k === 'smooth') c[k] = v ? Float64Array.from(v as Float64Array) : v;
    if (k === 'history') c[k] = (v as { t: number; p: Float64Array }[]).map((e) => ({ t: e.t, p: e.p }));
  }
  return c as unknown as PitchDetector;
}

/** Run the critic's honest let-ring session and snapshot the guitar detector at a few notes. */
export function sessionSnapshots(maxNotes = 61, at = [2, 10, 30, 60]): Snap[] {
  const snaps: Snap[] = [];
  const orig = CriticRig.prototype.step;
  CriticRig.prototype.step = function (this: CriticRig) {
    const r = orig.call(this);
    const det = (this.sa as unknown as { det: Record<string, PitchDetector> }).det.guitar;
    if (r.phase === 'play' && at.includes(r.index) && !snaps.some((s) => s.label === `note ${r.index + 1}`)) {
      snaps.push({ label: `note ${r.index + 1}`, det: cloneDetector(det) });
    }
    return r;
  };
  try {
    criticStudent({ name: 'bias session', noReview: true, maxNotes });
  } finally {
    CriticRig.prototype.step = orig;
  }
  return snaps;
}

/** Median cents error of the guitar-path reading 60–200 ms after the pluck. */
export function readCents(note: Float32Array, midi: number, state: PitchDetector | null): number | null {
  const sa = new StreamAnalyzer(SR);
  const hop = Math.round((HOP_MS / 1000) * SR);
  const r = S3.rng(5);
  const pre = SR * 1;
  const x = new Float32Array(pre + note.length);
  for (let i = 0; i < x.length; i++) x[i] = S3.db2a(-62) * Math.sqrt(3) * (r() * 2 - 1);
  for (let i = 0; i < note.length; i++) x[pre + i] += note[i];
  const out: number[] = [];
  const t0 = pre / SR;
  for (let s = 0; s + hop <= x.length; s += hop) {
    sa.push(x.subarray(s, s + hop));
    const t = (s + hop) / SR;
    if (s + hop < FRAME_SIZE) continue;
    if (state && Math.abs(t - (t0 - 0.1)) < hop / SR / 2) {
      // swap in the learned state, re-timed to now
      const d = cloneDetector(state) as unknown as Record<string, unknown>;
      const shift = t - ((d.lastT as number | null) ?? t);
      d.lastT = t - HOP_MS / 1000;
      d.history = (d.history as { t: number; p: Float64Array }[]).map((e) => ({ t: e.t + shift, p: e.p }));
      (sa as unknown as { det: Record<string, unknown> }).det.guitar = d;
    }
    const f = sa.frame('guitar', t);
    if (t > t0 + 0.06 && t < t0 + 0.2 && f.freq > 0) out.push(1200 * Math.log2(f.freq / (440 * Math.pow(2, (midi - 69) / 12))));
  }
  out.sort((a, b) => a - b);
  return out.length ? out[out.length >> 1] : null;
}

export interface BiasRow { synth: string; midi: number; level: number; fresh: number | null; state: (number | null)[]; worst: number }

export function biasTable(snaps: Snap[], notes = BIAS_NOTES, levels = BIAS_LEVELS): BiasRow[] {
  const rows: BiasRow[] = [];
  const synths: [string, (m: number, lv: number) => Float32Array][] = [
    ['ks (own)', (m, lv) => S3.ks(m, 1.0, { sr: SR, seed: m, decayDbS: 10, cents: 0, peak: S3.db2a(lv) })],
    ['modal (review)', (m, lv) => gtr(m, 1.0, { sr: SR, seed: m, cents: 0, peakDb: lv })],
  ];
  for (const [name, mk] of synths) {
    for (const lv of levels) {
      for (const m of notes) {
        const b = mk(m, lv);
        const fresh = readCents(b, m, null);
        const st = snaps.map((s) => readCents(b, m, s.det));
        const worst = Math.max(0, ...st.map((c) => (c === null || fresh === null ? 0 : Math.abs(c - fresh))));
        rows.push({ synth: name, midi: m, level: lv, fresh, state: st, worst });
      }
    }
  }
  return rows;
}

if (process.argv[1]?.endsWith('bias.ts')) {
  const snaps = sessionSnapshots();
  const f = (c: number | null) => (c === null ? '   -' : `${c >= 0 ? '+' : ''}${c.toFixed(1)}`.padStart(6));
  console.log(`cents read 60–200 ms after the pluck: fresh detector vs. detector state after ${snaps.map((s) => s.label).join(', ')} of an honest let-ring session`);
  console.log(`${'synth'.padEnd(15)} ${'note'.padEnd(5)} level   fresh | ${snaps.map((s) => s.label.padStart(8)).join(' ')} | worst |Δ|`);
  for (const r of biasTable(snaps)) console.log(`${r.synth.padEnd(15)} ${String(r.midi).padEnd(5)} ${String(r.level).padStart(4)}  ${f(r.fresh)} | ${r.state.map((c) => f(c).padStart(8)).join(' ')} | ${r.worst.toFixed(1)}`);
}
