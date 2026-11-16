// Practice-session state machine. Pure TypeScript, no DOM, no audio.
//
// Inputs:  start(t), listenDone(t), pitch(frame), replay(), skip(t)   (t = audio clock seconds)
// Output:  view() — a plain snapshot the UI renders.
//
// Flow per note:  listen → sing → play → [phrase review at phrase ends] → next note … → done
// The app plays audio only in 'listen' phases and feeds mic frames only in sing/play/review,
// so the reference tone can never be heard by the matcher.
import { guitarConfig, pathForPhase, singConfig, type AnalysisPath } from './engine.ts';
import { NoteMatcher, type MatchState, type PitchFrame } from './matcher.ts';
import { rmsToDb } from './pitch.ts';
import type { Settings } from './settings.ts';
import { phraseEndingAt, transpose, type Phrase, type Song } from './songs.ts';

export type Phase = 'listen' | 'sing' | 'play' | 'review' | 'done';
export type ListenKind = 'note' | 'phrase';

export interface NoteStats {
  index: number;
  midi: number;
  skipped: boolean;
  /** Attempts = wrong notes held + the successful one. null = step not done. */
  singAttempts: number | null;
  singCents: number | null;
  singMs: number | null;
  playAttempts: number | null;
  playCents: number | null;
  /** Time to find the note on guitar, from the start of the play step. */
  playMs: number | null;
}

export interface ReviewStats {
  phraseIndex: number;
  mistakes: number;
  ms: number | null;
  skipped: boolean;
}

export interface SessionView {
  phase: Phase;
  /** Phase to return to after a 'listen' completes. */
  next: Phase;
  listenKind: ListenKind;
  index: number;
  total: number;
  targetMidi: number;
  /** Notes to play during a 'listen' phase (one note, or the phrase for review). */
  listenNotes: { midi: number; beats: number }[];
  match: MatchState | null;
  /** Phrase review: notes, and how many have been played correctly so far. */
  review: { phrase: Phrase; notes: number[]; pos: number } | null;
  stats: NoteStats[];
  reviews: ReviewStats[];
  startIndex: number;
}

export interface SyncState {
  phase: Phase;
  next: Phase;
  listenKind: ListenKind;
  index: number;
  pos: number;
  sungMidi: number | null;
  stepStart: number;
  /** the step had already begun (a replay of its reference is in progress) */
  begun: boolean;
}

export class Session {
  readonly song: Song;
  readonly tonicMidi: number;
  settings: Settings;
  startIndex = 0;
  readonly midis: number[];

  private phase: Phase = 'listen';
  private next: Phase = 'sing';
  private listenKind: ListenKind = 'note';
  private index = 0;
  private matcher: NoteMatcher | null = null;
  private stepStart = 0;
  private attemptCarry = 0;
  private reviewPos = 0;
  private reviewStart = 0;
  private reviewMistakes = 0;
  private started = false;
  /** Pitch heard when the singing step was accepted (cleared when a new note starts). */
  private sungMidi: number | undefined;
  /** Frames of the current step (last 1.2 s). */
  private recent: PitchFrame[] = [];
  /** level just before the latest reference (see listenDone) */
  private preDb: number | undefined = undefined;
  /** Match state of the most recent accept (for logging). */
  lastAccepted: MatchState | null = null;
  private stats: NoteStats[];
  private reviews: ReviewStats[] = [];

  constructor(song: Song, tonicMidi: number, settings: Settings) {
    this.song = song;
    this.tonicMidi = tonicMidi;
    this.settings = { ...settings };
    if (this.settings.skipSing && this.settings.skipGuitar) this.settings.skipGuitar = false;
    this.midis = transpose(song, tonicMidi);
    this.stats = this.midis.map((midi, index) => ({
      index, midi, skipped: false, singAttempts: null, singCents: null, singMs: null,
      playAttempts: null, playCents: null, playMs: null,
    }));
  }

  /** Begin at a note (default the first); enters 'listen'. */
  start(fromIndex = 0): void {
    this.started = true;
    this.startIndex = Math.max(0, Math.min(fromIndex, this.midis.length - 1));
    this.beginNote(this.startIndex);
  }

  /** Change difficulty mid-session. A tolerance / octave change applies to the step in progress at once. */
  setSettings(s: Settings): void {
    const prev = this.settings;
    this.settings = { ...s };
    if (this.settings.skipSing && this.settings.skipGuitar) this.settings.skipGuitar = false;
    const matchingChanged =
      prev.singTolerance !== this.settings.singTolerance || prev.singExactOctave !== this.settings.singExactOctave || prev.strictCheck !== this.settings.strictCheck;
    if (matchingChanged && (this.phase === 'sing' || this.phase === 'play') && this.matcher) {
      this.attemptCarry += this.matcher.current.wrongAttempts;
      this.makeStepMatcher();
      // Re-feed the last second of this step so the new matcher continues where the old one was.
      for (const f of this.recent) this.matcher.push(f);
    }
  }

  /** Which analysis path the app should feed: the voice path while singing, the guitar path otherwise. */
  listeningPath(): AnalysisPath {
    return pathForPhase(this.phase);
  }

  /** Restore per-note results from an earlier, interrupted session (resume). */
  restore(prior: { stats?: NoteStats[]; reviews?: ReviewStats[] }): void {
    if (prior.stats) {
      for (const p of prior.stats) {
        if (p && p.index >= 0 && p.index < this.stats.length && p.midi === this.stats[p.index].midi) this.stats[p.index] = { ...p };
      }
    }
    if (prior.reviews) this.reviews = prior.reviews.map((r) => ({ ...r }));
  }

  private firstStep(): Phase {
    return this.settings.skipSing ? 'play' : 'sing';
  }

  private beginNote(i: number): void {
    this.index = i;
    if (i >= this.midis.length) {
      this.phase = 'done';
      this.matcher = null;
      return;
    }
    this.phase = 'listen';
    this.listenKind = 'note';
    this.next = this.firstStep();
    this.matcher = null;
    this.sungMidi = undefined;
    this.attemptCarry = 0;
  }

  /** The reference audio for the current 'listen' phase finished playing (and its tail decayed). */
  listenDone(t: number): void {
    if (this.phase !== 'listen') return;
    // (how loud it was just before the reference: what a string left ringing decays from)
    const last = this.recent.slice(-10);
    this.preDb = last.length ? Math.max(...last.map((f) => rmsToDb(f.cleanRms ?? f.rms))) : undefined;
    this.recent = [];
    this.phase = this.next;
    if (this.phase === 'review') {
      this.startReviewMatcher();
      return;
    }
    // Returning from a replay keeps the original start time; a fresh step starts now.
    if (this.matcher === null) this.stepStart = t;
    this.makeStepMatcher();
  }

  private makeStepMatcher(): void {
    const target = this.midis[this.index];
    const cfg =
      this.phase === 'sing'
        ? singConfig(target, this.settings.singTolerance, this.settings.singExactOctave, this.settings.strictCheck)
        : guitarConfig(target, this.settings.strictCheck);
    const prev = this.index > 0 ? this.midis[this.index - 1] : undefined;
    // A still-sounding previous note is not counted as a wrong attempt; in the singing step the
    // guitar note of the previous step, still ringing, must not pass (carry-over guard).
    this.matcher = new NoteMatcher({
      ...cfg,
      ignoreMidi: prev,
      carryMidi: this.phase === 'sing' ? prev : undefined,
      refMidi: this.phase === 'sing' ? target : undefined,
      preDb: this.phase === 'sing' ? this.preDb : undefined,
      voiceMidi: this.phase === 'play' ? this.sungMidi : undefined,
    });
  }

  private reviewPhrase(): Phrase | undefined {
    return phraseEndingAt(this.song, this.index);
  }

  private startReviewMatcher(): void {
    const p = this.reviewPhrase()!;
    const target = this.midis[p.start + this.reviewPos];
    const prev = this.reviewPos > 0 ? this.midis[p.start + this.reviewPos - 1] : this.midis[this.index];
    // The plucked-note model always needs a fresh attack, so the previous (still ringing) note
    // cannot pass a repeated note; it is also not counted as a slip.
    this.matcher = new NoteMatcher({ ...guitarConfig(target, this.settings.strictCheck, true), ignoreMidi: prev });
    // context: the previous review note's frames (so the next note's attack or pitch change is
    // seen at once), but nothing in them can count for this note
    this.matcher.prime(this.recent.slice(-15));
  }

  /** Replay the reference (note, or phrase during review). Pauses listening. */
  replay(): void {
    if (this.phase === 'done' || this.phase === 'listen') return;
    const wrong = this.matcher?.current.wrongAttempts ?? 0;
    if (this.phase === 'review') this.reviewMistakes += wrong;
    else this.attemptCarry += wrong;
    this.next = this.phase;
    this.listenKind = this.phase === 'review' ? 'phrase' : 'note';
    this.phase = 'listen';
    // this.matcher stays non-null as a marker that the step already started; it is rebuilt on return.
  }

  /** Feed one analysed mic frame. Returns true if the session advanced. */
  pitch(f: PitchFrame): boolean {
    if (!this.started || !this.matcher || (this.phase !== 'sing' && this.phase !== 'play' && this.phase !== 'review')) {
      return false;
    }
    this.recent.push(f);
    while (this.recent.length && this.recent[0].t < f.t - 1.2) this.recent.shift();
    const s = this.matcher.push(f);
    if (!s.accepted) return false;
    this.lastAccepted = s;
    const at = s.acceptedAt ?? f.t;
    const st = this.stats[this.index];

    if (this.phase === 'review') {
      this.reviewMistakes += s.wrongAttempts;
      const p = this.reviewPhrase()!;
      this.reviewPos++;
      if (p.start + this.reviewPos > p.end) {
        this.reviews.push({ phraseIndex: this.song.phrases.indexOf(p), mistakes: this.reviewMistakes, ms: (at - this.reviewStart) * 1000, skipped: false });
        this.beginNote(this.index + 1);
      } else {
        this.startReviewMatcher();
      }
      return true;
    }

    const attempts = this.attemptCarry + s.wrongAttempts + 1;
    if (this.phase === 'sing') {
      st.singAttempts = attempts;
      st.singCents = s.meanAbsCents;
      st.singMs = (at - this.stepStart) * 1000;
      if (this.settings.skipGuitar) {
        this.finishNote(at);
      } else {
        this.phase = 'play';
        this.recent = [];
        this.stepStart = at;
        this.attemptCarry = 0;
        // the pitch just sung (its tail must not pass the guitar step)
        this.sungMidi = s.detectedMidi ?? undefined;
        this.makeStepMatcher();
      }
      return true;
    }
    // play
    st.playAttempts = attempts;
    st.playCents = s.meanAbsCents;
    st.playMs = (at - this.stepStart) * 1000;
    this.finishNote(at);
    return true;
  }

  private finishNote(t: number): void {
    const p = this.reviewPhrase();
    if (p && this.settings.phraseReview && !this.settings.skipGuitar && p.end > p.start) {
      this.phase = 'review';
      this.next = 'review';
      this.reviewPos = 0;
      this.reviewMistakes = 0;
      this.reviewStart = t;
      this.attemptCarry = 0;
      this.startReviewMatcher();
      return;
    }
    this.beginNote(this.index + 1);
  }

  /** Where the session is, for a recording's log (and for the replay to resynchronise to). */
  syncState(): SyncState {
    return { phase: this.phase, next: this.next, listenKind: this.listenKind, index: this.index, pos: this.reviewPos, sungMidi: this.sungMidi ?? null, stepStart: this.stepStart, begun: this.matcher !== null };
  }

  /**
   * Replay tool: put the session where a recording's log says the app was (a fresh matcher for
   * that step). Used only when the replay has drifted from the app.
   */
  syncTo(s: SyncState): void {
    this.started = true;
    this.index = s.index;
    this.reviewPos = Math.max(0, s.pos);
    this.next = s.next;
    this.listenKind = s.listenKind;
    this.sungMidi = s.sungMidi ?? undefined;
    this.stepStart = s.stepStart;
    this.recent = [];
    this.attemptCarry = 0;
    this.phase = s.phase;
    this.matcher = null;
    if (s.phase === 'review') this.startReviewMatcher();
    else if (s.phase === 'sing' || s.phase === 'play') this.makeStepMatcher();
    else if (s.phase === 'listen' && s.begun) {
      // (a replay in progress: the step had begun)
      const ph = this.phase;
      this.phase = s.next;
      if (s.next === 'review') this.startReviewMatcher();
      else this.makeStepMatcher();
      this.phase = ph;
    }
  }

  /** Skip the current note (or the phrase review). Only when allowed by settings. */
  skip(): boolean {
    if (!this.settings.allowSkip || this.phase === 'done' || !this.started) return false;
    const inReview = this.phase === 'review' || (this.phase === 'listen' && this.next === 'review');
    if (inReview) {
      const p = this.reviewPhrase()!;
      this.reviews.push({ phraseIndex: this.song.phrases.indexOf(p), mistakes: this.reviewMistakes, ms: null, skipped: true });
      this.beginNote(this.index + 1);
      return true;
    }
    this.stats[this.index].skipped = true;
    this.beginNote(this.index + 1);
    return true;
  }

  view(): SessionView {
    const i = Math.min(this.index, this.midis.length - 1);
    const p = this.phase === 'review' || this.next === 'review' ? this.reviewPhrase() : undefined;
    const reviewNotes = p ? this.midis.slice(p.start, p.end + 1) : [];
    const listenNotes =
      this.phase === 'listen' && this.listenKind === 'phrase' && p
        ? reviewNotes.map((midi, k) => ({ midi, beats: this.song.notes[p.start + k].beats }))
        : [{ midi: this.midis[i], beats: 1 }];
    return {
      phase: this.phase,
      next: this.next,
      listenKind: this.listenKind,
      index: this.index,
      total: this.midis.length,
      targetMidi: this.phase === 'review' && p ? this.midis[p.start + this.reviewPos] : this.midis[i],
      listenNotes,
      match: this.phase === 'listen' ? null : (this.matcher?.current ?? null),
      review: p && (this.phase === 'review' || (this.phase === 'listen' && this.next === 'review'))
        ? { phrase: p, notes: reviewNotes, pos: this.reviewPos }
        : null,
      stats: this.stats.map((s) => ({ ...s })),
      reviews: this.reviews.map((r) => ({ ...r })),
      startIndex: this.startIndex,
    };
  }
}

export interface SessionSummary {
  notesDone: number;
  notesSkipped: number;
  avgSingCents: number | null;
  avgPlayCents: number | null;
  avgPlayMs: number | null;
  totalAttempts: number;
  reviewMistakes: number;
}

export function summarize(v: Pick<SessionView, 'stats' | 'reviews'>): SessionSummary {
  const done = v.stats.filter((s) => !s.skipped && (s.singAttempts !== null || s.playAttempts !== null));
  const avg = (xs: (number | null)[]) => {
    const ys = xs.filter((x): x is number => x !== null);
    return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
  };
  return {
    notesDone: done.length,
    notesSkipped: v.stats.filter((s) => s.skipped).length,
    avgSingCents: avg(done.map((s) => s.singCents)),
    avgPlayCents: avg(done.map((s) => s.playCents)),
    avgPlayMs: avg(done.map((s) => s.playMs)),
    totalAttempts: done.reduce((a, s) => a + (s.singAttempts ?? 0) + (s.playAttempts ?? 0), 0),
    reviewMistakes: v.reviews.reduce((a, r) => a + r.mistakes, 0),
  };
}
