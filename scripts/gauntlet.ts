// Pitch-engine gauntlet: synthesizes fixtures, runs them through the exact detector + matcher
// pipeline the app uses, prints a metrics table and exits non-zero if targets are missed.
//
//   npm run gauntlet            (add -- --verbose for per-fixture lines)
import { analyzeBuffer, guitarConfig, runMatcher, singConfig } from '../src/core/engine.ts';
import { NoteMatcher, type MatchConfig } from '../src/core/matcher.ts';
import { noteName } from '../src/core/music.ts';
import { SR, addNoise, concat, mixInto, noise, pluck, silence, voice } from './fixtures.ts';

const verbose = process.argv.includes('--verbose');
const LEAD = 0.3; // seconds of silence (or noise) before the note onset
const GUITAR_LOW = 40; // E2
const GUITAR_HIGH = 76; // E5
const VOICE_LOW = 40; // E2
const VOICE_HIGH = 69; // A4
const VOWELS = ['ah', 'ee', 'oo', 'eh'] as const;

interface Fixture {
  group: string;
  name: string;
  samples: Float32Array;
  onset: number; // s
  truthMidi: number | null;
  cfg: MatchConfig;
  expectAccept: boolean;
}

/** Onset time varies per note so onsets fall at different phases of the analysis hop. */
const lead = (m: number) => LEAD + ((m * 7) % 20) / 1000;

function guitarNote(m: number, noisy: boolean): Float32Array {
  const L = lead(m);
  const x = concat(silence(L), pluck(m, 1.6), silence(0.2));
  return noisy ? addNoise(x, 20, 1000 + m, Math.floor(L * SR), Math.floor((L + 1.0) * SR)) : x;
}

function voiceNote(m: number, noisy: boolean): Float32Array {
  const L = lead(m);
  const x = concat(silence(L), voice(m, 2.0, { vowel: VOWELS[m % VOWELS.length] }), silence(0.2));
  return noisy ? addNoise(x, 20, 2000 + m, Math.floor(L * SR), Math.floor((L + 2.0) * SR)) : x;
}

const fixtures: Fixture[] = [];

// ---- Positives ----
for (let m = GUITAR_LOW; m <= GUITAR_HIGH; m++) {
  for (const noisy of [false, true]) {
    fixtures.push({
      group: noisy ? 'guitar +noise 20dB' : 'guitar clean', name: `pluck ${noteName(m)}`,
      samples: guitarNote(m, noisy), onset: lead(m), truthMidi: m, cfg: guitarConfig(m), expectAccept: true,
    });
  }
}
for (let m = VOICE_LOW; m <= VOICE_HIGH; m++) {
  for (const noisy of [false, true]) {
    const samples = voiceNote(m, noisy);
    fixtures.push({
      group: noisy ? 'voice +noise 20dB (±50)' : 'voice clean (±50)', name: `voice ${noteName(m)}`,
      samples, onset: lead(m), truthMidi: m, cfg: singConfig(m, 50, false), expectAccept: true,
    });
    fixtures.push({
      group: 'voice strict ±25, any noise', name: `voice ${noteName(m)}${noisy ? ' noisy' : ''}`,
      samples, onset: lead(m), truthMidi: m, cfg: singConfig(m, 25, false), expectAccept: true,
    });
    fixtures.push({
      group: 'voice exact-octave ±50', name: `voice ${noteName(m)}${noisy ? ' noisy' : ''}`,
      samples, onset: lead(m), truthMidi: m, cfg: singConfig(m, 50, true), expectAccept: true,
    });
  }
}

// Harder guitar cases: out-of-tune strings (within the ±40 cent slack), quiet plucks, a new
// note plucked while the previous note is still ringing, and a dull (thumb/neck pickup) tone.
for (let m = GUITAR_LOW; m <= GUITAR_HIGH; m++) {
  const L = lead(m);
  const cents = m % 2 ? 22 : -22;
  fixtures.push({
    group: 'guitar detuned ±22c', name: `pluck ${noteName(m)} ${cents}c`,
    samples: addNoise(concat(silence(L), pluck(m, 1.6, { cents }), silence(0.2)), 30, 3000 + m),
    onset: L, truthMidi: m, cfg: guitarConfig(m), expectAccept: true,
  });
  fixtures.push({
    group: 'guitar quiet (-36 dBFS peak)', name: `pluck ${noteName(m)}`,
    samples: addNoise(concat(silence(L), pluck(m, 1.6, { amp: 0.016, seed: m + 5 }), silence(0.2)), 25, 4000 + m, Math.floor(L * SR), Math.floor((L + 1) * SR)),
    onset: L, truthMidi: m, cfg: guitarConfig(m), expectAccept: true,
  });
  fixtures.push({
    group: 'guitar dull tone', name: `pluck ${noteName(m)}`,
    samples: concat(silence(L), pluck(m, 1.6, { brightness: 0.25, pickPos: 0.45, seed: m + 9 }), silence(0.2)),
    onset: L, truthMidi: m, cfg: guitarConfig(m), expectAccept: true,
  });
  // Previous note (a 3rd away) still ringing at -6 dB when the target is plucked.
  const prevM = m + (m % 3 === 0 ? -4 : 3);
  if (prevM >= GUITAR_LOW && prevM <= GUITAR_HIGH) {
    const prev = pluck(prevM, 0.6 + 1.6 + 0.2, { amp: 0.25, seed: prevM + 77 });
    const x = concat(silence(0.3), silence(0.6 + L), pluck(m, 1.6), silence(0.2));
    mixInto(x, prev, Math.floor(0.3 * SR));
    fixtures.push({
      group: 'guitar over ringing prev note', name: `pluck ${noteName(m)} over ${noteName(prevM)}`,
      samples: x, onset: 0.9 + L, truthMidi: m, cfg: guitarConfig(m), expectAccept: true,
    });
  }
}

// ---- Negatives ----
const negTargets = [40, 45, 52, 57, 64, 69, 76];
for (const t of negTargets) {
  fixtures.push({ group: 'NEG silence', name: `silence → guitar ${noteName(t)}`, samples: concat(silence(2), noise(0.01, 0)), onset: 0, truthMidi: null, cfg: guitarConfig(t), expectAccept: false });
  fixtures.push({ group: 'NEG silence', name: `near-silence → sing ${noteName(t)}`, samples: noise(2, 3e-5, t), onset: 0, truthMidi: null, cfg: singConfig(t, 50, false), expectAccept: false });
  for (const lvl of [0.005, 0.03, 0.15]) {
    fixtures.push({ group: 'NEG noise only', name: `noise ${lvl} → guitar ${noteName(t)}`, samples: noise(2, lvl, t * 13 + Math.round(lvl * 1000)), onset: 0, truthMidi: null, cfg: guitarConfig(t), expectAccept: false });
    fixtures.push({ group: 'NEG noise only', name: `noise ${lvl} → sing ${noteName(t)}`, samples: noise(2, lvl, t * 17 + Math.round(lvl * 1000)), onset: 0, truthMidi: null, cfg: singConfig(t, 50, false), expectAccept: false });
  }
}
for (let m = GUITAR_LOW; m <= GUITAR_HIGH; m++) {
  for (const noisy of [false, true]) {
    const x = guitarNote(m, noisy);
    for (const d of [-1, 1]) {
      const t = m + d;
      if (t < GUITAR_LOW || t > GUITAR_HIGH) continue;
      fixtures.push({ group: 'NEG guitar semitone off', name: `pluck ${noteName(m)} → target ${noteName(t)}${noisy ? ' noisy' : ''}`, samples: x, onset: lead(m), truthMidi: m, cfg: guitarConfig(t), expectAccept: false });
    }
    {
      const t = m + (m % 2 ? 1 : -1);
      if (t >= GUITAR_LOW && t <= GUITAR_HIGH) {
        const off = m % 2 ? -55 : 55; // played 55 cents away from the target: outside the ±40 slack
        const L = lead(m);
        const y = concat(silence(L), pluck(t, 1.6, { cents: off, seed: m + 31 }), silence(0.2));
        fixtures.push({ group: 'NEG guitar 55 cents out', name: `pluck ${noteName(t)}${off > 0 ? '+' : ''}${off}c → target ${noteName(t)}${noisy ? ' noisy' : ''}`, samples: noisy ? addNoise(y, 20, 5000 + m) : y, onset: L, truthMidi: null, cfg: guitarConfig(t), expectAccept: false });
      }
    }
    for (const d of [-12, 12]) {
      const t = m + d;
      if (t < GUITAR_LOW || t > GUITAR_HIGH) continue;
      fixtures.push({ group: 'NEG guitar wrong octave', name: `pluck ${noteName(m)} → target ${noteName(t)}${noisy ? ' noisy' : ''}`, samples: x, onset: lead(m), truthMidi: m, cfg: guitarConfig(t), expectAccept: false });
    }
  }
}
for (let m = VOICE_LOW; m <= VOICE_HIGH; m++) {
  for (const noisy of [false, true]) {
    const x = voiceNote(m, noisy);
    for (const d of [-1, 1]) {
      fixtures.push({ group: 'NEG voice semitone off', name: `voice ${noteName(m)} → sing ${noteName(m + d)}${noisy ? ' noisy' : ''}`, samples: x, onset: lead(m), truthMidi: m, cfg: singConfig(m + d, 50, false), expectAccept: false });
    }
    fixtures.push({ group: 'NEG voice semitone off (±25)', name: `voice ${noteName(m)} → sing ${noteName(m + 1)}${noisy ? ' noisy' : ''}`, samples: x, onset: LEAD, truthMidi: m, cfg: singConfig(m + 1, 25, false), expectAccept: false });
    fixtures.push({ group: 'NEG voice wrong octave (exact-octave on)', name: `voice ${noteName(m)} → sing ${noteName(m + 12)}${noisy ? ' noisy' : ''}`, samples: x, onset: lead(m), truthMidi: m, cfg: singConfig(m + 12, 50, true), expectAccept: false });
  }
}

// ---- Run ----
interface GroupStats {
  n: number;
  accepted: number;
  expectAccept: boolean;
  times: number[];
  octaveErrFixtures: number;
  octaveErrFrames: number;
  stableFrames: number;
  failures: string[];
  early: number;
}
const groups = new Map<string, GroupStats>();

/** Octave-error scan: run a never-accepting matcher over the whole fixture and inspect trusted pitches. */
function octaveScan(f: Fixture): { frames: number; errs: number } {
  if (f.truthMidi === null) return { frames: 0, errs: 0 };
  const m = new NoteMatcher({ ...f.cfg, holdMs: Infinity });
  let frames = 0;
  let errs = 0;
  analyzeBuffer(f.samples, SR, (fr) => {
    const s = m.push(fr);
    if (s.stable && s.detectedMidi !== null) {
      frames++;
      const diff = Math.abs(s.detectedMidi - f.truthMidi!);
      for (const iv of [12, 19, 24, 7]) if (Math.abs(diff - iv) < 0.5) errs++;
    }
  });
  return { frames, errs };
}

const t0 = Date.now();
for (const f of fixtures) {
  let g = groups.get(f.group);
  if (!g) {
    g = { n: 0, accepted: 0, expectAccept: f.expectAccept, times: [], octaveErrFixtures: 0, octaveErrFrames: 0, stableFrames: 0, failures: [], early: 0 };
    groups.set(f.group, g);
  }
  g.n++;
  const { acceptedAt } = runMatcher(f.samples, SR, f.cfg);
  const early = acceptedAt !== null && acceptedAt < f.onset;
  const ok = (acceptedAt !== null) === f.expectAccept && !early;
  if (early) g.early++;
  if (acceptedAt !== null && !early) {
    g.accepted++;
    g.times.push((acceptedAt - f.onset) * 1000);
  }
  if (!ok) g.failures.push(early ? `${f.name} (accepted BEFORE onset)` : f.name);
  if (f.expectAccept) {
    const o = octaveScan(f);
    g.stableFrames += o.frames;
    g.octaveErrFrames += o.errs;
    if (o.errs > 0) {
      g.octaveErrFixtures++;
      g.failures.push(`${f.name} (octave error frames: ${o.errs})`);
    }
  }
  if (verbose) console.log(`${ok ? 'ok  ' : 'FAIL'} ${f.group.padEnd(34)} ${f.name.padEnd(36)} ${acceptedAt === null ? 'no accept' : `accept @ ${((acceptedAt - f.onset) * 1000).toFixed(0)} ms`}`);
}

const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) + '%' : '-');
const quant = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
};
const ms = (v: number) => (Number.isFinite(v) ? v.toFixed(0) : '-');

const header = ['group', 'n', 'correct-accept', 'false-accept', 'octave-err', 'tta median', 'tta p90', 'tta max'];
const rows: string[][] = [];
let failed = false;
const problems: string[] = [];
for (const [name, g] of groups) {
  const ca = g.expectAccept ? pct(g.accepted, g.n) : '-';
  const fa = g.expectAccept ? (g.early ? `${g.early} early` : '-') : `${g.accepted}/${g.n}`;
  const oe = g.expectAccept ? `${g.octaveErrFixtures}/${g.n}` : '-';
  const med = quant(g.times, 0.5);
  rows.push([name, String(g.n), ca, fa, oe, g.expectAccept ? ms(med) : '-', g.expectAccept ? ms(quant(g.times, 0.9)) : '-', g.expectAccept ? ms(Math.max(...g.times)) : '-']);
  if (g.expectAccept && g.accepted / g.n < 0.98) problems.push(`${name}: correct-accept ${pct(g.accepted, g.n)} < 98%`);
  if (!g.expectAccept && g.accepted > 0) problems.push(`${name}: ${g.accepted} false accepts`);
  if (g.early > 0) problems.push(`${name}: ${g.early} accepted before the note onset`);
  if (g.octaveErrFixtures > 0) problems.push(`${name}: ${g.octaveErrFixtures} fixtures with octave errors`);
  if (name.startsWith('guitar') && med > 400) problems.push(`${name}: median time-to-accept ${ms(med)} ms > 400 ms`);
  if (g.failures.length && (problems.length || verbose)) {
    for (const f of g.failures.slice(0, 12)) problems.push(`   - ${name}: ${f}`);
  }
}

// Totals
const pos = [...groups.values()].filter((g) => g.expectAccept);
const neg = [...groups.values()].filter((g) => !g.expectAccept);
const totPos = pos.reduce((a, g) => a + g.n, 0);
const totAcc = pos.reduce((a, g) => a + g.accepted, 0);
const totNeg = neg.reduce((a, g) => a + g.n, 0);
const totFa = neg.reduce((a, g) => a + g.accepted, 0) + pos.reduce((a, g) => a + g.early, 0);
const totOe = pos.reduce((a, g) => a + g.octaveErrFixtures, 0);
const guitarTimes = [...groups].filter(([k, g]) => g.expectAccept && k.startsWith('guitar')).flatMap(([, g]) => g.times);
rows.push(['ALL positives / negatives', `${totPos}/${totNeg}`, pct(totAcc, totPos), `${totFa}/${totNeg}`, `${totOe}/${totPos}`, '', '', '']);
rows.push(['guitar overall time-to-accept', String(guitarTimes.length), '', '', '', ms(quant(guitarTimes, 0.5)), ms(quant(guitarTimes, 0.9)), ms(Math.max(...guitarTimes))]);

const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
console.log(`\nPitch-engine gauntlet (${fixtures.length} fixture runs, ${SR} Hz, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
console.log('time-to-accept (tta) is ms after note onset; octave-err = fixtures with any trusted frame an octave/twelfth off\n');
console.log(line(header));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const r of rows) console.log(line(r));

const guitarMed = quant(guitarTimes, 0.5);
console.log('\nTargets: correct-accept ≥ 98% per positive group, 0 false accepts, 0 octave errors, guitar median tta ≤ 400 ms');
if (guitarMed > 400) problems.push(`guitar overall median tta ${ms(guitarMed)} ms > 400 ms`);
failed = problems.some((p) => !p.startsWith('   '));
if (problems.length) {
  console.log('\nIssues:');
  for (const p of problems) console.log('  ' + p);
}
console.log(failed ? '\nGAUNTLET: FAIL' : '\nGAUNTLET: PASS');
process.exit(failed ? 1 : 0);
