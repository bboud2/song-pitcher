// Pitch-engine gauntlet: synthesizes fixtures with three independent synthesis models plus the
// reviews' ported conditions, runs them through the exact front end + detector + matcher +
// session the app uses, prints tables and exits non-zero if ANY target is missed (including the
// documented known failures, which are listed separately but still count).
//
//   npm run gauntlet:quick          (≈1 min: a subset of notes/cases, short student runs)
//   npm run gauntlet                (full; runs in parallel worker processes)
//   flags: --only=<text>  --jobs=<n>  --verbose
//
// Kinds: P must accept (≥ 98 %), N must never accept, I informational (documented trade-offs and
// deliberate gaming), S simulated student session with explicit expectations.
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { allJobs, type GroupResult, type Job } from './gauntlet-cases.ts';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const verbose = args.includes('--verbose');
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const shardArg = args.find((a) => a.startsWith('--shard='))?.slice(8);
const nJobs = Number(args.find((a) => a.startsWith('--jobs='))?.slice(7) ?? Math.min(4, cpus().length));

/** Cases known to fail today. They still print FAIL and still fail the run; this only explains them. */
const KNOWN_FAILING: Record<string, string> = {
  'guitar P add detuned +35c':
    'a string 35 c flat/sharp reads +41..+54 c on low notes (the synthetic partials are stretched); the ±50 c window is kept so a wrong fret never passes — the tuner screen shows the string is out of tune',
  'guitar P add quiet -34dBFS + 60Hz hum -40dBFS': 'display only: the live note readout shows an octave/fifth for a few frames on one note; acceptance is right',
  'guitar P over ringing previous note +12 st': 'display only: the live note readout shows the ringing octave for a few frames on one note; acceptance is right',
  'guitar3 P open string ringing sympathetically (-12 dB)':
    'fixture puts the sympathetic string at its own fundamental an octave below the played note; a real open string driven by a note an octave up vibrates at that note (its 2nd harmonic), which the "sympathetic partial at f" row covers and passes',
  'guitar3 N open string ringing sympathetically (-12 dB) — accepted as the wrong octave or a fifth':
    'same fixture: a sound with a steady octave-below component from the attack onwards is, to the detector, the lower note',
  'guitar3 P quiet: -46 dBFS peak': 'the note is only ~16 dB above the room floor and dies in ~0.3 s; a second, harder pluck passes',
  'guitar3 P TV speech -40 dBFS rms': 'a voice talking over the attack at about the guitar\'s level can make the mixture read as a common sub-harmonic; the student re-plucks',
  'guitar3 N TV speech -40 dBFS rms — accepted as the wrong octave or a fifth': 'the TV voice itself lands on the octave/fifth of the target for a syllable (speech false accept, not the student\'s playing); strict check reduces it',
  'guitar3 P TV speech -30 dBFS rms': 'TV louder than the decaying guitar: see -40 row',
  'guitar3 N TV speech -30 dBFS rms — accepted as the wrong octave or a fifth': 'the TV voice itself lands on the octave/fifth of the target (speech false accept, see speech rows)',
  'voice3 N falsetto (near sine, breathy) — exact-octave mode accepted the wrong octave': 'opt-in exact-octave mode only: a near-sine falsetto at D4 reads an octave low; default mode is octave-free',
  'voice3 N vocal fry 50% — exact-octave mode accepted the wrong octave': 'opt-in exact-octave mode only: with fry the waveform really repeats every two periods; correcting it (periodicity at half the period ≥ 0.8) caused octave-up misreads on clean voices, so it was left out',
  'voice3 N vocal fry 85% — exact-octave mode accepted the wrong octave': 'as vocal fry 50%',
  'voice3 P vocal fry 85%': 'G2/A2 with heavy fry read below the 60 Hz voice floor',
  'voice3 P low bass octave down (-12)': 'G1/A1 (49/55 Hz) are below the 60 Hz voice floor (raising it lets mains hum through)',
  'voice3 P hum 50 Hz -30 dBFS': 'very loud hum (the mic check warns about it); low notes near the hum harmonics are missed',
  'voice3 P TV speech -30 dBFS rms': 'TV as loud as the singer',
  'voice3 P metronome click 120 bpm -20 dBFS': 'one of 36: a loud click lands inside the hold; singing on passes',
  'speech female speech 170-300Hz [strict]: false accepts per minute per target (target ≤ 0.5 guitar step)': 'strict check is 0.56/min vs 0.5 target',
  'student C1s same, strict instrument check on': 'a short "hm" that dies away looks like a free decay; strict check does not catch it (deliberate gaming, lowest priority)',
};

function selected(): Job[] {
  return allJobs().filter((j) => (!quick || j.quick) && (!only || j.name.includes(only)));
}

/** Deterministic cost-balanced assignment of jobs to shards. */
function assign(jobs: Job[], k: number): Job[][] {
  const shards: { load: number; jobs: Job[] }[] = Array.from({ length: k }, () => ({ load: 0, jobs: [] }));
  const order = jobs.map((j, i) => ({ j, i })).sort((a, b) => b.j.cost - a.j.cost || a.i - b.i);
  for (const { j } of order) {
    const s = shards.reduce((a, b) => (b.load < a.load ? b : a));
    s.jobs.push(j);
    s.load += j.cost;
  }
  return shards.map((s) => s.jobs);
}

async function runShard(spec: string): Promise<void> {
  const [i, k] = spec.split('/').map(Number);
  const mine = assign(selected(), k)[i];
  for (const j of mine) {
    const t0 = Date.now();
    const order = allJobs().indexOf(j);
    const res = j.run(quick).map((r, k) => ({ ...r, order: order * 10 + k }));
    process.stdout.write(`__RESULT__${JSON.stringify({ job: j.name, ms: Date.now() - t0, res })}\n`);
  }
}

function q(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const jobs = selected();
  const k = Math.max(1, Math.min(nJobs, jobs.length));
  const results: GroupResult[] = [];
  const self = fileURLToPath(import.meta.url);
  await Promise.all(
    Array.from({ length: k }, (_, i) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [self, `--shard=${i}/${k}`, ...args.filter((a) => !a.startsWith('--jobs='))], { stdio: ['ignore', 'pipe', 'inherit'] });
        let buf = '';
        child.stdout.on('data', (d: Buffer) => {
          buf += d.toString();
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.startsWith('__RESULT__')) {
              const r = JSON.parse(line.slice(10)) as { job: string; ms: number; res: GroupResult[] };
              results.push(...r.res);
              if (verbose) console.error(`  done ${r.job} (${(r.ms / 1000).toFixed(1)} s)`);
            }
          }
        });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`shard ${i} exited ${code}`))));
      }),
    ),
  );
  // keep definition order
  results.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const failures: { name: string; why: string }[] = [];
  const rows: string[][] = [];
  const sims: string[] = [];
  for (const r of results) {
    if (r.kind === 'S' || (r.kind === 'I' && r.summary)) {
      const ok = r.kind === 'I' ? 'info' : r.ok ? 'ok' : 'FAIL';
      sims.push(`${ok.padEnd(4)}  ${r.name}\n        ${r.summary}`);
      if (r.kind === 'S' && !r.ok) failures.push({ name: r.name, why: r.fails.join('; ') });
      continue;
    }
    const pct = r.n ? `${((100 * r.acc) / r.n).toFixed(1)}%` : '-';
    rows.push([
      `${r.kind} ${r.name}`, String(r.n),
      r.kind === 'N' ? '-' : pct,
      r.kind === 'N' ? `${r.acc}/${r.n}` : '-',
      r.kind === 'N' ? '-' : `${r.oct}/${r.n}`,
      r.kind === 'N' || !r.tta.length ? '-' : q(r.tta, 0.5).toFixed(0),
      r.kind === 'N' || !r.tta.length ? '-' : q(r.tta, 0.9).toFixed(0),
    ]);
    if (r.kind === 'P' && r.n && r.acc / r.n < 0.98) failures.push({ name: r.name, why: `accept ${pct} < 98% — missed: ${r.fails.slice(0, 8).join(', ')}` });
    if (r.kind === 'N' && r.acc > 0) failures.push({ name: r.name, why: `${r.acc} false accepts: ${r.fails.slice(0, 6).join(', ')}` });
    if (r.kind === 'P' && r.oct > 0) failures.push({ name: r.name, why: `${r.oct} octave misreads` });
  }
  const head = ['case', 'n', 'accept', 'false-acc', 'oct-err', 'tta med', 'p90'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (c: string[]) => c.map((x, i) => (i === 0 ? x.padEnd(w[i]) : x.padStart(w[i]))).join('  ');
  console.log(`\nPitch-engine gauntlet${quick ? ' (QUICK subset)' : ''} — ${results.length} result rows from ${jobs.length} jobs on ${k} processes, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log('P must accept (≥98%), N must never accept, I informational. tta = ms after the note onset.\n');
  console.log(line(head));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(r));
  // guitar time-to-accept over plain plucks
  const plain = results.filter((r) => r.kind === 'P' && /^guitar (P ks clean|P add normal$|P add weak|guitar3 P base)/.test(r.name) || r.name === 'guitar3 P base pick, -14 dBFS peak');
  const tt = plain.flatMap((r) => r.tta);
  if (tt.length) {
    console.log(`\nGuitar time-to-accept, plain plucks: median ${q(tt, 0.5).toFixed(0)} ms, p90 ${q(tt, 0.9).toFixed(0)} ms (target median ≤ 400 ms)`);
    if (q(tt, 0.5) > 400) failures.push({ name: 'guitar median time-to-accept', why: `${q(tt, 0.5).toFixed(0)} ms > 400 ms` });
  }
  if (sims.length) {
    console.log('\nScenarios (speech, simulated students):');
    for (const s of sims) console.log('  ' + s);
  }
  const known = failures.filter((f) => KNOWN_FAILING[f.name]);
  const unknown = failures.filter((f) => !KNOWN_FAILING[f.name]);
  if (unknown.length) {
    console.log('\nTargets missed:');
    for (const f of unknown) console.log(`  ${f.name}: ${f.why}`);
  }
  if (known.length) {
    console.log('\nKnown failing (documented, still counted):');
    for (const f of known) console.log(`  ${f.name}: ${f.why}\n      why: ${KNOWN_FAILING[f.name]}`);
  }
  console.log(`\nGAUNTLET: ${failures.length ? `FAIL (${failures.length} target${failures.length > 1 ? 's' : ''} missed)` : 'PASS'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  process.exit(failures.length ? 1 : 0);
}

if (shardArg) {
  runShard(shardArg).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
