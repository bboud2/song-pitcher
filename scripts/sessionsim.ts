// Session simulations: drive the real Session state machine (and the same streaming front end the
// app uses) with simulated students, to check that singing cannot pass the guitar step and
// playing cannot pass the singing step.
//
//   honest      — sings the note, pauses, then plucks it
//   voice-only  — never touches the guitar (sings / hums every prompt, incl. phrase review)
//   guitar-only — never sings (plucks every prompt)
import { FRAME_SIZE, HOP_MS, StreamAnalyzer } from '../src/core/engine.ts';
import { Session } from '../src/core/session.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings.ts';
import { STAR_SPANGLED_BANNER } from '../src/core/songs.ts';
import { guitar, silence, voice, whiteNoise, type VoiceOpts } from './fixtures2.ts';
import { pluck as ksPluck, voice as v1voice } from './fixtures.ts';

const SR = 48000;
let simOverrides: Partial<Settings> = {};
/** Settings applied on top of every simulated session (e.g. the strict instrument check). */
export function setSimSettings(o: Partial<Settings>): void {
  simOverrides = o;
}
const FLOOR = 0.0018; // about -55 dBFS room noise

type Src = 'voice' | 'guitar' | 'silence';

class Rig {
  s: Session;
  t = 0;
  sa = new StreamAnalyzer(SR);
  hop = Math.round((HOP_MS / 1000) * SR);
  samples = 0;
  log: { index: number; phase: string; src: Src }[] = [];
  constructor(settings: Settings) {
    this.s = new Session(STAR_SPANGLED_BANNER, 48, { ...settings, ...simOverrides });
    this.s.start(0);
  }
  feed(buf: Float32Array, src: Src): void {
    for (let i = 0; i + this.hop <= buf.length; i += this.hop) {
      this.sa.push(buf.subarray(i, i + this.hop));
      this.samples += this.hop;
      this.t = this.samples / SR;
      if (this.samples < FRAME_SIZE) continue;
      const v = this.s.view();
      if (v.phase === 'done') return;
      if (v.phase === 'listen') {
        // The reference tone plays here in the app; the mic is ignored. Model it as instantaneous.
        this.s.listenDone(this.t);
        continue;
      }
      const f = this.sa.frame(this.s.listeningPath(), this.t);
      if (this.s.pitch(f)) this.log.push({ index: v.index, phase: v.phase, src });
    }
  }
}

const cache = new Map<string, Float32Array>();
function memo(key: string, mk: () => Float32Array): Float32Array {
  let b = cache.get(key);
  if (!b) cache.set(key, (b = mk()));
  return b;
}
const quiet = (d: number) => memo(`q${d}`, () => whiteNoise(silence(d, SR), FLOOR, 5));

export interface SimRow {
  name: string;
  notes: number;
  passedSing: { voice: number; guitar: number };
  passedPlay: { voice: number; guitar: number };
  passedReview: { voice: number; guitar: number };
  finished: boolean;
  reached: number;
  medianFindMs: number | null;
  medianSingMs: number | null;
}

function tally(name: string, rig: Rig): SimRow {
  const c = (phase: string, src: Src) => rig.log.filter((l) => l.phase === phase && l.src === src).length;
  const v = rig.s.view();
  const find = v.stats.map((s) => s.playMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const sing = v.stats.map((s) => s.singMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
  return {
    name,
    notes: v.total,
    passedSing: { voice: c('sing', 'voice'), guitar: c('sing', 'guitar') },
    passedPlay: { voice: c('play', 'voice'), guitar: c('play', 'guitar') },
    passedReview: { voice: c('review', 'voice'), guitar: c('review', 'guitar') },
    finished: v.phase === 'done',
    reached: Math.min(v.index + 1, v.total),
    medianFindMs: find.length ? find[find.length >> 1] : null,
    medianSingMs: sing.length ? sing[sing.length >> 1] : null,
  };
}

function sung(midi: number, dur: number, o: Partial<VoiceOpts> = {}): Float32Array {
  return memo(`v${midi}:${dur}:${JSON.stringify(o)}`, () => whiteNoise(voice(midi, dur, { sr: SR, seed: midi, vowel: 'a', vibCents: 15, ...o }), FLOOR, midi));
}
function plucked(midi: number, dur: number, model: 'additive' | 'ks' = 'additive'): Float32Array {
  return memo(`g${midi}:${dur}:${model}`, () =>
    whiteNoise(model === 'ks' ? ksPluck(midi, dur, { sr: SR, amp: 0.4 }) : guitar(midi, dur, { sr: SR, seed: midi }), FLOOR, midi),
  );
}

/** Honest student: sing (D s), pause, pluck. */
export function honest(D: number, octave = 0, vo: Partial<VoiceOpts> = {}, model: 'additive' | 'ks' = 'additive', review = false): SimRow {
  const rig = new Rig({ ...DEFAULT_SETTINGS, phraseReview: review });
  let guard = 0;
  while (rig.s.view().phase !== 'done' && guard++ < 800) {
    const v = rig.s.view();
    rig.feed(quiet(0.3), 'silence');
    const cur = rig.s.view();
    if (cur.phase === 'review') {
      for (const m of cur.review!.notes.slice(cur.review!.pos)) {
        rig.feed(plucked(m, 0.7, model), 'guitar');
      }
      continue;
    }
    const idx = cur.index;
    if (cur.phase === 'sing') {
      rig.feed(sung(cur.targetMidi + octave, D, vo), 'voice');
      rig.feed(quiet(0.5), 'silence');
    }
    if (rig.s.view().index === idx && rig.s.view().phase === 'play') rig.feed(plucked(cur.targetMidi, 1.2, model), 'guitar');
    void v;
  }
  const oct = octave === 0 ? 'written octave' : octave > 0 ? 'octave up' : 'octave down';
  const extra = Object.keys(vo).length ? ' ' + JSON.stringify(vo) : '';
  return tally(`honest: sing ${D}s (${oct}${extra}), pause, pluck [${model}]${review ? ' +review' : ''}`, rig);
}

/** Voice-only student: sings (or hums) whatever is asked, never plays. */
export function voiceOnly(octave: number, D: number, vo: Partial<VoiceOpts> = {}): SimRow {
  const rig = new Rig({ ...DEFAULT_SETTINGS });
  let guard = 0;
  while (rig.s.view().phase !== 'done' && guard++ < 400) {
    rig.feed(quiet(0.3), 'silence');
    const v = rig.s.view();
    if (v.phase === 'done') break;
    rig.feed(sung(v.targetMidi + octave, v.phase === 'review' ? 0.6 : D, vo), 'voice');
  }
  const extra = Object.keys(vo).length ? ' ' + JSON.stringify(vo) : '';
  return tally(`voice-only: ${octave === 0 ? 'written octave' : `${octave > 0 ? '+' : ''}${octave} st`}, ${D}s notes${extra}`, rig);
}

/** Guitar-only student: plucks whatever is asked, never sings. */
export function guitarOnly(model: 'additive' | 'ks' = 'additive', octave = 0): SimRow {
  const rig = new Rig({ ...DEFAULT_SETTINGS, phraseReview: false });
  let guard = 0;
  while (rig.s.view().phase !== 'done' && guard++ < 300) {
    rig.feed(quiet(0.3), 'silence');
    if (rig.s.view().phase === 'done') break;
    rig.feed(plucked(rig.s.view().targetMidi + octave, 1.6, model), 'guitar');
  }
  return tally(`guitar-only: one 1.6 s pluck per prompt [${model}]${octave ? ` ${octave > 0 ? '+' : ''}${octave} st` : ''}`, rig);
}

/** Guitar-only student who keeps re-plucking the note every 0.6 s (tremolo-ish), never sings. */
export function guitarOnlyRepeated(model: 'additive' | 'ks' = 'ks'): SimRow {
  const rig = new Rig({ ...DEFAULT_SETTINGS, phraseReview: false });
  let guard = 0;
  while (rig.s.view().phase !== 'done' && guard++ < 200) {
    const m = rig.s.view().targetMidi;
    for (let k = 0; k < 4; k++) rig.feed(plucked(m, 0.6, model), 'guitar');
    rig.feed(quiet(0.2), 'silence');
  }
  return tally(`guitar-only: re-plucks every 0.6 s, never sings [${model}]`, rig);
}

export function runAllSims(): { rows: SimRow[]; problems: string[] } {
  const rows: SimRow[] = [
    honest(0.8),
    honest(1.5),
    honest(1.5, 0, { vibCents: 0 }),
    honest(1.5, 0, { vibCents: 100, vibRate: 5 }),
    honest(1.5, 12),
    honest(1.5, 0, { vowel: 'hum' }),
    honest(1.2, 0, {}, 'ks', true),
    voiceOnly(0, 1.2),
    voiceOnly(0, 1.2, { vibCents: 0 }),
    voiceOnly(0, 1.2, { vowel: 'hum' }),
    voiceOnly(12, 1.2),
    voiceOnly(-12, 1.2, { vibCents: 0, vowel: 'o' }),
    guitarOnly('additive'),
    guitarOnly('ks'),
    guitarOnlyRepeated('ks'),
    guitarOnlyRepeated('additive'),
  ];
  const problems: string[] = [];
  for (const r of rows) {
    if (r.name.startsWith('voice-only')) {
      if (r.passedPlay.voice > 0) problems.push(`${r.name}: voice passed ${r.passedPlay.voice} guitar steps (target 0)`);
      if (r.passedReview.voice > 0) problems.push(`${r.name}: voice passed ${r.passedReview.voice} review notes (target 0)`);
    }
    if (r.name.startsWith('guitar-only') && r.passedSing.guitar > 0) problems.push(`${r.name}: guitar passed ${r.passedSing.guitar} sing steps (target 0)`);
    if (r.name.startsWith('honest')) {
      if (r.passedPlay.voice > 0) problems.push(`${r.name}: voice passed ${r.passedPlay.voice} guitar steps (target 0)`);
      if (!r.finished) problems.push(`${r.name}: honest student did not finish (stuck at note ${r.reached})`);
      if (r.passedSing.voice < r.notes) problems.push(`${r.name}: only ${r.passedSing.voice}/${r.notes} sing steps passed by the voice`);
      if (r.passedPlay.guitar < r.notes) problems.push(`${r.name}: only ${r.passedPlay.guitar}/${r.notes} guitar steps passed by the pluck`);
    }
  }
  return { rows, problems };
}

export function printSims(rows: SimRow[]): void {
  const head = ['simulated student', 'sing passed by voice/guitar', 'guitar passed by voice/guitar', 'review notes by voice/guitar', 'finished', 'median find ms', 'median sing ms'];
  const body = rows.map((r) => [
    r.name,
    `${r.passedSing.voice}/${r.passedSing.guitar}`,
    `${r.passedPlay.voice}/${r.passedPlay.guitar}`,
    `${r.passedReview.voice}/${r.passedReview.guitar}`,
    r.finished ? 'yes' : `no (note ${r.reached})`,
    r.medianFindMs === null ? '-' : r.medianFindMs.toFixed(0),
    r.medianSingMs === null ? '-' : r.medianSingMs.toFixed(0),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (c: string[]) => c.map((x, i) => (i === 0 ? x.padEnd(w[i]) : x.padStart(w[i]))).join('  ');
  console.log(line(head));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const b of body) console.log(line(b));
}

// Use the other voice model too, so the simulations are not tuned to one synthesizer.
export function v1(midi: number, dur: number): Float32Array {
  return v1voice(midi, dur, { sr: SR });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const t0 = Date.now();
  const { rows, problems } = runAllSims();
  printSims(rows);
  console.log(`\n${problems.length ? 'Problems:\n  ' + problems.join('\n  ') : 'All session-simulation targets met.'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
