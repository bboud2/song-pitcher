import { describe, expect, it } from 'vitest';
import type { PitchFrame } from '../src/core/matcher.ts';
import { midiToFreq } from '../src/core/music.ts';
import { Session, summarize } from '../src/core/session.ts';
import { DEFAULT_SETTINGS, normalizeSettings, updateSetting, type Settings } from '../src/core/settings.ts';
import { STAR_SPANGLED_BANNER as SSB } from '../src/core/songs.ts';

/** Synthetic detector output: a steady tone (or silence when midi is null) every 20 ms. */
class Clock {
  t = 0;
  feed(s: Session, midi: number | null, ms: number, opts: { cents?: number; rms?: number } = {}): boolean {
    let advanced = false;
    const end = this.t + ms / 1000;
    while (this.t < end - 1e-9) {
      this.t += 0.02;
      const f: PitchFrame = midi === null
        ? { t: this.t, freq: 0, clarity: 0, rms: 0.0001 }
        : { t: this.t, freq: midiToFreq(midi + (opts.cents ?? 0) / 100), clarity: 0.97, rms: opts.rms ?? 0.1 };
      if (s.pitch(f)) advanced = true;
    }
    return advanced;
  }
  wait(ms: number) { this.t += ms / 1000; }
}

const make = (over: Partial<Settings> = {}) => new Session(SSB, 48, { ...DEFAULT_SETTINGS, ...over });

describe('session state machine', () => {
  it('starts in listen and ignores mic input until the reference finished', () => {
    const s = make();
    const c = new Clock();
    s.start();
    expect(s.view().phase).toBe('listen');
    expect(s.view().targetMidi).toBe(55); // G3
    expect(c.feed(s, 55, 2000)).toBe(false); // would be a pass, but we're listening
    expect(s.view().phase).toBe('listen');
    s.listenDone(c.t);
    expect(s.view().phase).toBe('sing');
  });

  it('sing passes in any octave after ~500 ms hold, then play needs the exact octave', () => {
    const s = make();
    const c = new Clock();
    s.start();
    s.listenDone(c.t);
    expect(c.feed(s, 55 + 12, 300)).toBe(false); // G4 — right pitch class, not held long enough
    expect(c.feed(s, 55 + 12, 400)).toBe(true);
    expect(s.view().phase).toBe('play');
    expect(c.feed(s, 67, 1500)).toBe(false); // guitar in the wrong octave never passes
    expect(c.feed(s, 56, 1000)).toBe(false); // semitone off
    c.feed(s, null, 200);
    expect(c.feed(s, 55, 300)).toBe(true);
    const v = s.view();
    expect(v.phase).toBe('listen');
    expect(v.index).toBe(1);
    expect(v.stats[0].singAttempts).toBe(1);
    expect(v.stats[0].playAttempts).toBe(3); // G4 and G#3 held = two wrong attempts, then the pass
    expect(v.stats[0].playMs).toBeGreaterThan(2500);
    expect(v.stats[0].playCents).toBeCloseTo(0, 3);
  });

  it('respects the singing tolerance setting', () => {
    for (const [tol, cents, pass] of [[50, 40, true], [35, 40, false], [25, 20, true], [25, 30, false]] as const) {
      const s = make({ singTolerance: tol });
      const c = new Clock();
      s.start();
      s.listenDone(0);
      expect(c.feed(s, 55, 1500, { cents })).toBe(pass);
    }
  });

  it('require-exact-octave makes singing octave-sensitive', () => {
    const s = make({ singExactOctave: true });
    const c = new Clock();
    s.start();
    s.listenDone(0);
    expect(c.feed(s, 67, 1500)).toBe(false);
    expect(c.feed(s, 55, 1000)).toBe(true);
  });

  it('rejects silence and low-clarity frames', () => {
    const s = make();
    const c = new Clock();
    s.start();
    s.listenDone(0);
    expect(c.feed(s, null, 3000)).toBe(false);
    for (let i = 0; i < 100; i++) expect(s.pitch({ t: 3 + i * 0.02, freq: midiToFreq(55), clarity: 0.5, rms: 0.1 })).toBe(false);
  });

  it('skip-singing goes straight to play; skip-guitar finishes after singing', () => {
    let s = make({ skipSing: true });
    s.start();
    s.listenDone(0);
    expect(s.view().phase).toBe('play');
    s = make({ skipGuitar: true });
    const c = new Clock();
    s.start();
    s.listenDone(0);
    expect(s.view().phase).toBe('sing');
    expect(c.feed(s, 55, 800)).toBe(true);
    expect(s.view().index).toBe(1);
    expect(s.view().phase).toBe('listen');
  });

  it('cannot skip both steps', () => {
    expect(normalizeSettings({ skipSing: true, skipGuitar: true }).skipGuitar).toBe(false);
    const s1 = updateSetting(DEFAULT_SETTINGS, 'skipSing', true);
    expect(updateSetting(s1, 'skipGuitar', true)).toMatchObject({ skipGuitar: true, skipSing: false });
    expect(normalizeSettings({ singTolerance: 10, showDegree: 'yes' })).toEqual(DEFAULT_SETTINGS);
  });

  it('replay returns to the same step and keeps the step timer', () => {
    const s = make();
    const c = new Clock();
    s.start();
    s.listenDone(0);
    c.feed(s, 58, 600); // wrong note held: 1 attempt
    s.replay();
    expect(s.view().phase).toBe('listen');
    expect(s.view().next).toBe('sing');
    expect(c.feed(s, 55, 1000)).toBe(false); // mic ignored during replay
    s.listenDone(c.t);
    expect(s.view().phase).toBe('sing');
    expect(c.feed(s, 55, 700)).toBe(true);
    expect(s.view().stats[0].singAttempts).toBe(2);
    expect(s.view().stats[0].singMs).toBeGreaterThan(2000);
  });

  it('runs phrase review at the phrase boundary, in order, then continues', () => {
    const s = make({ skipSing: true });
    const c = new Clock();
    s.start();
    const phrase = [55, 52, 48, 52, 55, 60];
    for (let i = 0; i < 6; i++) {
      expect(s.view().index).toBe(i);
      s.listenDone(c.t);
      c.feed(s, null, 100);
      expect(c.feed(s, phrase[i], 400)).toBe(true);
    }
    let v = s.view();
    expect(v.phase).toBe('review');
    expect(v.review?.notes).toEqual(phrase);
    expect(v.review?.pos).toBe(0);
    expect(c.feed(s, 60, 500)).toBe(false); // last note still ringing: no fresh attack, wrong note anyway
    c.feed(s, null, 100);
    expect(c.feed(s, 52, 400)).toBe(false); // out of order
    for (let k = 0; k < 6; k++) {
      c.feed(s, null, 100);
      expect(c.feed(s, phrase[k], 400)).toBe(true);
      if (k < 5) expect(s.view().review?.pos).toBe(k + 1);
    }
    v = s.view();
    expect(v.phase).toBe('listen');
    expect(v.index).toBe(6);
    expect(v.reviews).toHaveLength(1);
    expect(v.reviews[0].mistakes).toBe(1); // only the out-of-order E3; the ringing C4 is not a slip
  });

  it('the review itself can be skipped', () => {
    const s = make({ skipSing: true });
    const c = new Clock();
    s.start();
    for (let i = 0; i < 6; i++) {
      s.listenDone(c.t);
      c.feed(s, null, 100);
      c.feed(s, s.view().targetMidi, 400);
    }
    expect(s.view().phase).toBe('review');
    s.replay();
    expect(s.view()).toMatchObject({ phase: 'listen', listenKind: 'phrase', next: 'review' });
    expect(s.view().listenNotes.map((n) => n.midi)).toEqual([55, 52, 48, 52, 55, 60]);
    expect(s.skip()).toBe(true);
    expect(s.view().index).toBe(6);
    expect(s.view().reviews).toEqual([{ phraseIndex: 0, mistakes: 0, ms: null, skipped: true }]);
  });

  it('a repeated note needs a fresh attack, so a ringing note cannot pass the next step', () => {
    const s = make({ skipSing: true, phraseReview: false });
    const c = new Clock();
    s.start();
    // advance to note 12 ("What so" = G3 G3, indices 12 and 13)
    for (let i = 0; i < 12; i++) {
      s.listenDone(c.t);
      c.feed(s, null, 100);
      c.feed(s, s.view().targetMidi, 400);
    }
    s.listenDone(c.t);
    expect(s.view().targetMidi).toBe(55);
    c.feed(s, null, 100);
    expect(c.feed(s, 55, 300, { rms: 0.2 })).toBe(true);
    expect(s.view().index).toBe(13);
    s.listenDone(c.t);
    expect(s.view().targetMidi).toBe(55);
    // still ringing (and decaying) — must not pass
    for (let k = 0; k < 40; k++) expect(c.feed(s, 55, 20, { rms: 0.15 * Math.pow(0.97, k) })).toBe(false);
    // new pluck: level jumps
    expect(c.feed(s, 55, 300, { rms: 0.3 })).toBe(true);
  });

  it('skip button only when allowed; completes to done with a summary', () => {
    const locked = make({ allowSkip: false });
    locked.start();
    expect(locked.skip()).toBe(false);

    const s = make({ phraseReview: true });
    const c = new Clock();
    s.start();
    s.listenDone(0);
    c.feed(s, 55, 800);
    c.feed(s, null, 100);
    c.feed(s, 55, 300);
    let guard = 0;
    while (s.view().phase !== 'done' && guard++ < 1000) s.skip();
    const v = s.view();
    expect(v.phase).toBe('done');
    expect(v.stats.filter((x) => x.skipped)).toHaveLength(99);
    expect(v.reviews).toHaveLength(0); // skipped notes don't trigger a review
    const sum = summarize(v);
    expect(sum.notesDone).toBe(1);
    expect(sum.notesSkipped).toBe(99);
    expect(sum.totalAttempts).toBe(2);
  });
});
