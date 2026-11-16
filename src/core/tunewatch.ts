// Mic-check tuner: which open string is out of tune, judged only on plucked strings.
//
// A warning that a string is out of tune must not come from a sung note, a fretted note that
// happens to sit near an open string, or the first sharp instant of a hard pluck (a stiff string
// reads 10-18 c sharp at the attack). So: each pluck (a broadband attack followed by a decaying
// note) is measured on its settled part only; a string is reported only when two separate plucks
// agree that it is at least 30 c off; and the report goes away as soon as an in-tune pluck of that
// string is heard. A string 65-250 c off (nearer another note than its own) is named as "may be
// the X string, far out of tune".
import { OPEN_STRINGS, noteName } from './music.ts';

export interface TuneAttack { t: number; riseDb: number; band: string }

interface Pluck {
  t0: number;
  /** (open string, cents from it, level dB) per settled frame */
  readings: { open: number; cents: number; db: number; tilt: number | null }[];
}

export interface PluckResult { open: number; cents: number; t: number }

const SETTLE_SEC = 0.25;
const PLUCK_SEC = 2.5;
const WARN_CENTS = 30;
const IN_TUNE_CENTS = 20;
const AGREE_CENTS = 20;
const FAR_CENTS = 65;
const MAX_CENTS = 250;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

export class TuneWatch {
  private pluck: Pluck | null = null;
  private lastAttack = -Infinity;
  /** per open string: its last two measured plucks */
  private byString = new Map<number, PluckResult[]>();
  private warn: { open: number; cents: number } | null = null;
  /** every pluck measured (for tests) */
  readonly measured: PluckResult[] = [];

  /** A plucked string sounded within the last few seconds (its attack was seen). */
  plucking(t: number): boolean {
    return t - this.lastAttack < 4;
  }

  /**
   * One analysed frame: `midi` is the (fractional) stable pitch or null, `db` the level, `attacks`
   * the recent attack events.
   */
  push(t: number, midi: number | null, db: number, attacks: TuneAttack[] = [], tilt: number | null = null): void {
    // (the plain "that is X" line is about the note plucked twice: once other notes have been
    // heard for a second and a half in all — sung or played — it no longer applies)
    const said = this.neutral;
    if (said && midi !== null) {
      const dt = this.lastT === null ? 0 : Math.min(0.1, t - this.lastT);
      if (Math.abs(midi - said.note) > 0.6) this.otherFor += dt;
      if (this.otherFor >= 1.5) {
        this.neutral = null;
        this.otherFor = 0;
      }
    }
    this.lastT = t;
    const fresh = attacks.filter((a) => ((a.band === 'full' && a.riseDb >= 8) || (a.band === 'hf' && a.riseDb >= 12)) && a.t > this.lastAttack + 0.2 && t - a.t < 0.5);
    if (fresh.length) {
      this.finish();
      this.lastAttack = Math.max(...fresh.map((a) => a.t));
      this.pluck = { t0: this.lastAttack, readings: [] };
    }
    const p = this.pluck;
    if (!p) return;
    const age = t - p.t0;
    if (age > PLUCK_SEC) {
      this.finish();
      return;
    }
    if (age < SETTLE_SEC || midi === null) return;
    let best: { open: number; cents: number } | null = null;
    for (const o of OPEN_STRINGS) {
      const c = (midi - o) * 100;
      if (Math.abs(c) <= MAX_CENTS && (!best || Math.abs(c) < Math.abs(best.cents))) best = { open: o, cents: c };
    }
    // (a string whose fundamental is weak in this room or phone reads an octave high: fold it
    // back when the reading is near no open string itself)
    if (!best) {
      for (const o of OPEN_STRINGS) {
        for (const k of [12, -12]) {
          const c = (midi - k - o) * 100;
          if (Math.abs(c) <= MAX_CENTS && (!best || Math.abs(c) < Math.abs(best.cents))) best = { open: o, cents: c };
        }
      }
    }
    if (best) p.readings.push({ ...best, db, tilt });
    // (while a string already warned about is being tuned, the figure follows the pluck in hand —
    // the needle does — instead of waiting for this pluck to end: one steady reading of it is
    // enough, as the two plucks that raised the warning already showed it is a string)
    const w = this.warn;
    if (w && p.readings.length >= 12) {
      const rs = p.readings.slice(-12);
      if (rs.every((r) => r.open === w.open)) {
        const cs = rs.map((r) => r.cents).sort((a, b) => a - b);
        if (cs[9] - cs[2] <= 10) {
          const c = median(cs);
          if (Math.abs(c) < IN_TUNE_CENTS) this.warn = null;
          else if (Math.sign(c) === Math.sign(w.cents)) this.warn = { open: w.open, cents: c };
        }
      }
    }
  }

  /** Measure the pluck in progress (if it holds a settled, decaying note) and update the warning. */
  private finish(): void {
    const p = this.pluck;
    this.pluck = null;
    if (!p || p.readings.length < 6) return;
    // one string throughout, a steady pitch, and a level that falls (a string, not a held voice)
    const open = median(p.readings.map((r) => r.open));
    const rs = p.readings.filter((r) => r.open === open);
    if (rs.length < 0.8 * p.readings.length) return;
    const cs = rs.map((r) => r.cents).sort((a, b) => a - b);
    const iqr = cs[Math.floor(cs.length * 0.75)] - cs[Math.floor(cs.length * 0.25)];
    if (iqr > 15) return;
    const k = Math.max(2, Math.floor(rs.length / 3));
    const head = median(rs.slice(0, k).map((r) => r.db));
    const tail = median(rs.slice(-k).map((r) => r.db));
    // (a phone's gain control can hold the level up: then the upper partials dying away against
    // the fundamental still show a string — a voice keeps its colour)
    const tl = rs.map((r) => r.tilt).filter((x): x is number => x !== null);
    const tiltDrop = tl.length >= 2 * k ? median(tl.slice(0, k)) - median(tl.slice(-k)) : 0;
    if (head - tail < 2 && tiltDrop < 3) return;
    // a fretted note sits on a semitone (give or take a sharp fret's 30 c): such a reading is not
    // reported as a string out of tune — but said plainly when two plucks agree on it (below)
    // (a reading below E2 can only be the low E string)
    const cents = median(cs);
    const offSemitone = Math.abs(cents - 100 * Math.round(cents / 100));
    if (Math.abs(cents) >= FAR_CENTS && offSemitone < 30 && !(open === OPEN_STRINGS[0] && cents < 0)) {
      const note = open + Math.round(cents / 100);
      const prev = this.offNote;
      this.offNote = { note, open, cents };
      if (prev && prev.note === note && prev.open === open) {
        this.neutral = { note, open, cents };
        this.otherFor = 0;
      }
      return;
    }
    this.offNote = null;
    this.neutral = null;
    const res = { open, cents, t: p.t0 };
    this.measured.push(res);
    const list = [...(this.byString.get(open) ?? []), res].slice(-2);
    this.byString.set(open, list);
    if (Math.abs(cents) < IN_TUNE_CENTS) {
      // an in-tune pluck of that string: forget what was said about it
      this.byString.set(open, [res]);
      if (this.warn?.open === open) this.warn = null;
      return;
    }
    if (list.length === 2) {
      const [a, b] = list;
      if (Math.abs(a.cents) >= WARN_CENTS && Math.abs(b.cents) >= WARN_CENTS && Math.sign(a.cents) === Math.sign(b.cents) && Math.abs(a.cents - b.cents) <= AGREE_CENTS) {
        // (the latest pluck's figure: the student may be tuning it)
        this.warn = { open, cents: b.cents };
      }
    }
  }

  /** two plucks in a row read the same note that is not an open string's (see finish) */
  private offNote: { note: number; open: number; cents: number } | null = null;
  private neutral: { note: number; open: number; cents: number } | null = null;
  /** how long other notes than the one named have been heard (see push) */
  private otherFor = 0;
  private lastT: number | null = null;

  /** The warning (or neutral note) to show, or null. */
  message(): string | null {
    const w = this.warn;
    if (!w && this.neutral) {
      const n = this.neutral;
      const steps = Math.round(n.cents / 100);
      const dist = Math.abs(steps) === 1 ? 'a semitone' : `${Math.abs(steps)} semitones`;
      return `That is ${noteName(n.note)}, not an open-string note. If it was your open ${noteName(n.open)} string, it is ${dist} ${steps > 0 ? 'sharp' : 'flat'}.`;
    }
    if (!w) return null;
    const name = noteName(w.open);
    const dir = w.cents > 0 ? 'sharp' : 'flat';
    const amount = Math.round(Math.abs(w.cents));
    if (Math.abs(w.cents) >= FAR_CENTS) return `This may be the ${name} string, far out of tune (about ${amount}¢ ${dir}): tune it before you begin.`;
    return `The ${name} string sounds about ${amount}¢ ${dir}: tune it before you begin, or the wrong fret may sound right.`;
  }

  /** the open string currently warned about */
  warned(): number | null {
    return this.warn?.open ?? null;
  }
}

/**
 * Note display without single-frame octave slips: a reading an octave (or octave and a fifth)
 * away from the note on show is shown only once the next frame confirms it.
 */
export class OctaveSlipFilter {
  private shown: number | null = null;
  private pending: number | null = null;

  push(m: number | null): number | null {
    if (m === null) {
      this.pending = null;
      return null;
    }
    if (this.shown !== null) {
      const d = m - this.shown;
      const slip = [12, 19, 24, -12, -19, -24].some((k) => Math.abs(d - k) < 0.6);
      if (slip) {
        if (this.pending !== null && Math.abs(m - this.pending) < 0.6) {
          this.pending = null;
          this.shown = m;
          return m;
        }
        this.pending = m;
        return this.shown;
      }
    }
    this.pending = null;
    this.shown = m;
    return m;
  }
}
