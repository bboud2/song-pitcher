// Realistic student sequences through the real Session + StreamAnalyzer, with real listen durations
// (mic frames dropped during the reference tone, as in the app) and overlapping (ringing) sounds.
import { FRAME_SIZE, HOP_MS, StreamAnalyzer } from '../src/core/engine.ts';
import { Session, type SessionView } from '../src/core/session.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings.ts';
import { STAR_SPANGLED_BANNER } from '../src/core/songs.ts';
import * as S from './fixtures3.ts';

const SR = 48000; const HOP = Math.round((HOP_MS / 1000) * SR);
interface Ev { buf: Float32Array; start: number; stop: number | null; label: string; midi: number; gain: number }
interface Adv { t: number; index: number; phase: string; reviewPos: number; labels: string[]; lastPluck: { midi: number; t: number } | null; target: number }
export interface RigOpts { settings?: Partial<Settings>; agc?: number; humDb?: number; fanDb?: number; tonic?: number; maxNotes?: number }
export class Rig {
  s: Session; sa = new StreamAnalyzer(SR); n = 0; evs: Ev[] = []; log: Adv[] = []; listenLeft = 0; lastPhase = ''; lastKey = '';
  lastPluck: { midi: number; t: number } | null = null; r = S.rng(4242); o: RigOpts;
  private gDb = 10; private e = 0; private fanB = 0;
  constructor(o: RigOpts = {}) { this.o = o; this.s = new Session(STAR_SPANGLED_BANNER, o.tonic ?? 48, { ...DEFAULT_SETTINGS, ...(o.settings ?? {}) }); this.s.start(0); this.enterListen(true); }
  get t() { return this.n / SR; }
  play(buf: Float32Array, label: string, midi: number, gain = 1) { this.evs.push({ buf, start: this.n, stop: null, label, midi, gain }); if (label.startsWith('guitar')) this.lastPluck = { midi, t: this.t }; }
  stop(pred: (e: Ev) => boolean, fadeMs = 60) { for (const e of this.evs) if (e.stop === null && pred(e)) e.stop = this.n + Math.floor((fadeMs / 1000) * SR); }
  active(label: string) { return this.evs.some((e) => e.label.startsWith(label) && this.n < e.start + e.buf.length && (e.stop === null || this.n < e.stop)); }
  private enterListen(first: boolean) {
    const v = this.s.view();
    const dur = v.listenKind === 'phrase' ? v.listenNotes.reduce((a, x) => a + Math.max(0.12, (x.beats * 60) / 84), 0) : 0.9;
    this.listenLeft = (first ? 0.3 : 0.7) + 0.06 + dur + 0.35 + 0.3;
  }
  /** advance one hop; returns the view */
  step(): SessionView {
    const x = new Float32Array(HOP);
    this.evs = this.evs.filter((e) => this.n < e.start + e.buf.length && (e.stop === null || this.n < e.stop));
    for (const e of this.evs) {
      const off = this.n - e.start;
      for (let i = 0; i < HOP && off + i < e.buf.length; i++) {
        let g = e.gain; if (e.stop !== null) { const left = e.stop - (this.n + i); g *= left <= 0 ? 0 : Math.min(1, left / (0.06 * SR)); }
        x[i] += g * e.buf[off + i];
      }
    }
    const a = S.db2a(-62) * Math.sqrt(3);
    for (let i = 0; i < HOP; i++) x[i] += a * (this.r() * 2 - 1);
    if (this.o.humDb !== undefined) { const h = S.db2a(this.o.humDb) * 1.2; for (let i = 0; i < HOP; i++) { const tt = (this.n + i) / SR; x[i] += h * (Math.sin(6.283185 * 60 * tt) + 0.5 * Math.sin(6.283185 * 120 * tt + 1) + 0.7 * Math.sin(6.283185 * 180 * tt + 2)) / 1.1; } }
    if (this.o.fanDb !== undefined) { const f = S.db2a(this.o.fanDb) * 14; for (let i = 0; i < HOP; i++) { this.fanB = 0.995 * this.fanB + 0.05 * (this.r() * 2 - 1); x[i] += f * this.fanB * 0.2; } }
    if (this.o.agc) {
      const k = Math.exp(-1 / (0.03 * SR));
      for (let i = 0; i < HOP; i++) {
        this.e = k * this.e + (1 - k) * x[i] * x[i]; const lvl = 10 * Math.log10(Math.max(this.e, 1e-12)) + this.gDb;
        if (lvl > -20) this.gDb -= 40 / SR; else if (lvl > -65) this.gDb += this.o.agc / SR;
        this.gDb = Math.max(-10, Math.min(30, this.gDb)); x[i] = Math.max(-1, Math.min(1, x[i] * S.db2a(this.gDb)));
      }
    }
    this.sa.push(x); this.n += HOP;
    let v = this.s.view();
    if (v.phase === 'done' || this.n < FRAME_SIZE) return v;
    if (v.phase === 'listen') {
      this.listenLeft -= HOP / SR;
      if (this.listenLeft <= 0) { this.s.listenDone(this.t); v = this.s.view(); }
      return v;
    }
    const before = v;
    if (this.s.pitch(this.sa.frame(this.s.listeningPath(), this.t))) {
      const labels = [...new Set(this.evs.filter((e) => this.n - e.start > 0.05 * SR).map((e) => e.label))];
      this.log.push({ t: this.t, index: before.index, phase: before.phase, reviewPos: before.review?.pos ?? -1, labels, lastPluck: this.lastPluck, target: before.targetMidi });
      v = this.s.view();
      if (v.phase === 'listen') this.enterListen(false);
    }
    return v;
  }
  run(sec: number, until?: (v: SessionView) => boolean): SessionView { let v = this.s.view(); const end = this.n + sec * SR; while (this.n < end) { v = this.step(); if (v.phase === 'done' || (until && until(v))) break; } return v; }
  skip() { this.s.skip(); if (this.s.view().phase === 'listen') this.enterListen(false); }
}

const cache = new Map<string, Float32Array>();
const memo = (k: string, f: () => Float32Array) => { let b = cache.get(k); if (!b) cache.set(k, (b = f())); return b; };
export interface Style {
  name: string;
  guitar?: Partial<S.KsOpts>; gPeak?: number;
  voice?: Partial<S.VoOpts>; vPeak?: number; vDur?: number;
  ring?: boolean; // let notes ring into the next
  react?: number; singLag?: number; pause?: number;
  pluckDuringSing?: boolean;
  wrongFirst?: number[]; wrongGap?: number; // semitone offsets plucked before the right note
  humWhileHunting?: boolean;
  noSing?: boolean; noGuitar?: boolean;
  reviewTempo?: number; reviewIOI?: number;
  intonSd?: number;
  noReview?: boolean; verbose?: boolean; ringOne?: boolean;
}
const fold = (m: number, lo = 45, hi = 62) => { while (m > hi) m -= 12; while (m < lo) m += 12; return m; };
function gnote(m: number, st: Style, variant = 0) { return memo(`g${m}:${variant}:${JSON.stringify(st.guitar ?? {})}:${st.gPeak}`, () => S.ks(m, 3.0, { sr: SR, seed: m * 3 + variant, decayDbS: 9 + (m % 5) * 2, cents: ((m * 7 + variant * 3) % 13) - 6, peak: st.gPeak ?? 0.2, ...(st.guitar ?? {}) })); }
function vnote(m: number, st: Style, variant = 0, cents = 0) {
  const vw = (['a', 'o', 'u', 'e', 'm'] as const)[(m + variant) % 5];
  const ex = st.voice?.semis;
  return memo(`v${m}:${variant}:${cents}:${JSON.stringify(st.voice ?? {})}:${st.vPeak}:${st.vDur}:${ex ? 'x' : ''}`, () => S.vo(m, st.vDur ?? 3.2, { sr: SR, seed: m * 5 + variant, vowel: vw, vibCents: 12 + (m % 4) * 6, peak: st.vPeak ?? 0.12, ...(st.voice ?? {}), semis: (t) => cents / 100 + (ex ? ex(t) : 0) }));
}
function gauss(r: () => number) { return Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(6.283 * r()); }

export function student(st: Style, o: RigOpts = {}) {
  const rig = new Rig({ ...o, settings: { ...(o.settings ?? {}), ...(st.noReview ? { phraseReview: false } : {}) } }); const r = S.rng(99);
  const res = { notes: 0, skippedNotes: 0, singBreaths: [] as number[], singMs: [] as number[], plucks: [] as number[], playMs: [] as number[], singByGuitar: 0, playByVoice: 0, playWrongNote: 0, reviewFirstTry: 0, reviewTries: [] as number[], reviews: 0, reviewSkipped: 0, reviewByVoice: 0, sec: 0 };
  let v = rig.s.view(); let guard = 0;
  const max = o.maxNotes ?? 101;
  while (v.phase !== 'done' && v.index < max && guard++ < 5000) {
    if (v.phase === 'listen') { v = rig.run(30, (x) => x.phase !== 'listen'); continue; }
    const idx = v.index; const target = v.targetMidi;
    if (v.phase === 'sing') {
      const t0 = rig.t; let breaths = 0; let ok = false;
      while (breaths < 4 && !ok) {
        breaths++;
        rig.run(breaths === 1 ? (st.react ?? 0.35) : 0.5);
        if (rig.s.view().phase !== 'sing') { ok = true; break; }
        if (st.noSing) { rig.play(gnote(target, st, breaths), 'guitar', target); v = rig.run(st.guitar?.decayDbS && st.guitar.decayDbS < 6 ? 2.6 : 1.6, (x) => x.phase !== 'sing'); if (!st.ring) rig.stop((e) => e.label === 'guitar'); }
        else {
          const cents = Math.round(gauss(r) * (st.intonSd ?? 12));
          rig.play(vnote(fold(target), st, breaths, cents), 'voice', fold(target));
          v = rig.run((st.vDur ?? 3.2) - 0.1, (x) => x.phase !== 'sing');
        }
        if (v.phase !== 'sing') { ok = true; }
        else rig.stop((e) => e.label === 'voice');
      }
      if (!ok) { rig.stop(() => true); rig.skip(); res.skippedNotes++; v = rig.s.view(); continue; }
      res.singBreaths.push(breaths); res.singMs.push((rig.t - t0) * 1000);
      if (st.verbose && breaths > 1) console.log(`      note ${idx + 1} (midi ${target}, prev ${idx > 0 ? rig.s.midis[idx - 1] : '-'}) needed ${breaths} breaths`);
      const last = rig.log[rig.log.length - 1];
      if (last && last.phase === 'sing' && !last.labels.includes('voice')) res.singByGuitar++;
      // keep singing a little after the accept (people do not stop instantly)
      if (!st.noSing) { if (st.pluckDuringSing) { rig.run(0.15); rig.stop((e) => e.label === 'voice', 400); } else { rig.run(st.singLag ?? 0.25); rig.stop((e) => e.label === 'voice', 80); } }
      v = rig.s.view(); if (v.phase === 'sing') continue;
    }
    v = rig.s.view();
    if (v.phase === 'play' && v.index === idx) {
      let plucks = 0; let done = false;
      if (st.noGuitar) {
        // voice-only: keeps singing notes
        for (let k = 0; k < 4 && !done; k++) { rig.run(0.3); rig.play(vnote(target, st, k + 5, 0), 'voice', target); v = rig.run((st.vDur ?? 3.2) + 0.3, (x) => !(x.phase === 'play' && x.index === idx)); rig.stop((e) => e.label === 'voice'); done = !(v.phase === 'play' && v.index === idx); }
        if (done) { res.playByVoice++; res.notes++; } else { rig.stop(() => true); rig.skip(); res.skippedNotes++; }
        v = rig.s.view(); continue;
      }
      if (!st.pluckDuringSing) rig.run(st.pause ?? 0.5);
      if (st.humWhileHunting && rig.s.view().phase === 'play') {
        for (let k = 0; k < 2 && !done; k++) { rig.play(vnote(target, { ...st, vDur: 0.45, voice: { attack: 0.02, release: 0.12, env: (t) => S.db2a(-14 * t) } }, k, 0), 'voice', target); v = rig.run(0.8, (x) => !(x.phase === 'play' && x.index === idx)); done = !(v.phase === 'play' && v.index === idx); }
        if (done) { res.playByVoice++; res.notes++; rig.stop(() => true); v = rig.s.view(); continue; }
      }
      for (const w of st.wrongFirst ?? []) {
        if (!st.ring) rig.stop((e) => e.label === 'guitar');
        rig.play(gnote(target + w, st), 'guitar', target + w);
        v = rig.run(st.wrongGap ?? 0.8, (x) => !(x.phase === 'play' && x.index === idx));
        if (!(v.phase === 'play' && v.index === idx)) { done = true; res.playWrongNote++; if (st.verbose) { const L = rig.log[rig.log.length - 1]; console.log(`      WRONG pass: note ${idx + 1} target ${target} after pluck ${target + w} (t=${L.t.toFixed(2)}, pluck at ${L.lastPluck?.t.toFixed(2)}, sounding ${L.labels.join('+')})`); } break; }
      }
      while (!done && plucks < 6) {
        plucks++;
        if (!st.ring) rig.stop((e) => e.label === 'guitar', 30);
        rig.play(gnote(target, st, plucks), 'guitar', target);
        const tp = rig.t;
        v = rig.run(1.6, (x) => !(x.phase === 'play' && x.index === idx));
        if (!(v.phase === 'play' && v.index === idx)) { done = true; res.playMs.push((rig.t - tp) * 1000); }
        else if (st.verbose) console.log(`      note ${idx + 1} (midi ${target}, prev ${idx > 0 ? rig.s.midis[idx - 1] : '-'}) pluck ${plucks} at ${tp.toFixed(2)} not accepted; hint ${v.match?.hint ?? '-'}`);
      }
      if (st.pluckDuringSing) rig.stop((e) => e.label === 'voice', 80);
      if (!done) { rig.stop(() => true); rig.skip(); res.skippedNotes++; v = rig.s.view(); continue; }
      if (plucks > 0) res.plucks.push(plucks);
      res.notes++;
      v = rig.s.view();
    }
    if (v.phase === 'review') {
      res.reviews++;
      const ph = v.review!; let tries = 0; let ok = false;
      while (tries < 4 && !ok) {
        tries++;
        rig.run(tries === 1 ? 0.8 : 1.2);
        const notes = ph.notes;
        for (let k = 0; k < notes.length; k++) {
          const beats = STAR_SPANGLED_BANNER.notes[ph.phrase.start + k].beats;
          const ioi = st.reviewIOI ?? (beats * 60) / (84 * (st.reviewTempo ?? 1));
          if (!st.ring) rig.stop((e) => e.label.startsWith('guitar'), 30);
          else if (st.ringOne) { const gs = rig.evs.filter((e) => e.label === 'guitar' && e.stop === null); gs.slice(0, -1).forEach((e) => (e.stop = rig.n + 1440)); }
          if (st.noGuitar) rig.play(vnote(notes[k], { ...st, vDur: Math.max(0.3, ioi - 0.05), voice: { ...(st.voice ?? {}), attack: 0.02, release: 0.08 } }, k, 0), 'voice', notes[k]);
          else rig.play(gnote(notes[k], st, k), 'guitar', notes[k]);
          v = rig.run(ioi);
          if (v.phase !== 'review') break;
        }
        v = rig.run(1.2, (x) => x.phase !== 'review');
        ok = v.phase !== 'review';
        if (!ok && st.verbose) console.log(`      phrase "${ph.phrase.lyric}" try ${tries}: stalled at note ${v.review!.pos + 1}/${notes.length} (midis ${notes.join(' ')}; beats ${notes.map((_, k) => STAR_SPANGLED_BANNER.notes[ph.phrase.start + k].beats).join(' ')})`);
      }
      rig.stop(() => true);
      if (ok) { res.reviewTries.push(tries); if (tries === 1) res.reviewFirstTry++; if (st.noGuitar) res.reviewByVoice++; }
      else { rig.skip(); res.reviewSkipped++; }
      v = rig.s.view();
    }
  }
  res.sec = rig.t;
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : NaN);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  console.log(`${st.name}\n    notes done ${res.notes}/${Math.min(max, 101)}, given up (skipped) ${res.skippedNotes} | sing: breaths/note ${mean(res.singBreaths).toFixed(2)}, >1 breath on ${res.singBreaths.filter((b) => b > 1).length}, median ${med(res.singMs).toFixed(0)} ms, passed by GUITAR ${res.singByGuitar} | play: right-note plucks/note ${mean(res.plucks).toFixed(2)}, >1 pluck on ${res.plucks.filter((b) => b > 1).length}, median ${med(res.playMs).toFixed(0)} ms after pluck, passed by VOICE ${res.playByVoice}, passed on a WRONG pluck ${res.playWrongNote} | review: ${res.reviews} phrases, first try ${res.reviewFirstTry}, mean tries ${mean(res.reviewTries).toFixed(2)}, given up ${res.reviewSkipped}${st.noGuitar ? ', passed by VOICE ' + res.reviewByVoice : ''} | ${(res.sec / 60).toFixed(1)} min`);
  return res;
}
