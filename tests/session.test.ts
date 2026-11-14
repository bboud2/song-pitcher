import { describe, expect, it } from 'vitest';
import type { PitchFrame } from '../src/core/matcher.ts';
import { midiToFreq } from '../src/core/music.ts';
import { Session, summarize } from '../src/core/session.ts';
import { DEFAULT_SETTINGS, normalizeSettings, updateSetting, type Settings } from '../src/core/settings.ts';
import { STAR_SPANGLED_BANNER as SSB } from '../src/core/songs.ts';

/**
 * Synthetic detector output every 20 ms:
 *  sing()  — a sustained tone at a steady level (a voice)
 *  pluck() — a level jump then a free exponential decay (~15 dB/s), steady pitch (a string)
 *  quiet() — silence
 */
class Clock {
  t = 0;
  private frame(s: Session, f: Omit<PitchFrame, 't'>): boolean {
    this.t += 0.02;
    return s.pitch({ t: this.t, ...f });
  }
  quiet(s: Session, ms: number): boolean {
    let adv = false;
    for (let k = 0; k < Math.round(ms / 20); k++) adv = this.frame(s, { freq: 0, clarity: 0, rms: 0.0001 }) || adv;
    return adv;
  }
  sing(s: Session, midi: number, ms: number, opts: { cents?: number; rms?: number } = {}): boolean {
    let adv = false;
    for (let k = 0; k < Math.round(ms / 20); k++) {
      adv = this.frame(s, { freq: midiToFreq(midi + (opts.cents ?? 0) / 100), clarity: 0.97, rms: opts.rms ?? 0.1 }) || adv;
    }
    return adv;
  }
  pluck(s: Session, midi: number, ms: number, opts: { cents?: number; peak?: number } = {}): boolean {
    let adv = false;
    for (let k = 0; k < Math.round(ms / 20); k++) {
      const rms = (opts.peak ?? 0.2) * Math.pow(10, (-15 * k * 0.02) / 20);
      adv = this.frame(s, { freq: midiToFreq(midi + (opts.cents ?? 0) / 100), clarity: 0.97, rms }) || adv;
    }
    return adv;
  }
}

const make = (over: Partial<Settings> = {}) => new Session(SSB, 48, { ...DEFAULT_SETTINGS, ...over });

describe('session state machine', () => {
  it('starts in listen and ignores mic input until the reference finished', () => {
    const s = make();
    const c = new Clock();
    s.start();
    expect(s.view().phase).toBe('listen');
    expect(s.view().targetMidi).toBe(55); // G3
    expect(c.sing(s, 55, 2000)).toBe(false); // would be a pass, but we're listening
    expect(s.view().phase).toBe('listen');
    s.listenDone(c.t);
    expect(s.view().phase).toBe('sing');
    expect(s.listeningPath()).toBe('voice');
  });

  it('sing passes in any octave after ~500 ms, then play needs a pluck in the exact octave', () => {
    const s = make();
    const c = new Clock();
    s.start();
    s.listenDone(c.t);
    expect(c.sing(s, 55 + 12, 300)).toBe(false); // G4 — right pitch class, not held long enough
    expect(c.sing(s, 55 + 12, 400)).toBe(true);
    expect(s.view().phase).toBe('play');
    expect(s.listeningPath()).toBe('guitar');
    c.quiet(s, 200);
    expect(c.pluck(s, 67, 1200)).toBe(false); // right note, wrong octave
    c.quiet(s, 200);
    expect(c.pluck(s, 56, 1000)).toBe(false); // semitone off
    c.quiet(s, 200);
    expect(c.pluck(s, 55, 600)).toBe(true);
    const v = s.view();
    expect(v.phase).toBe('listen');
    expect(v.index).toBe(1);
    expect(v.stats[0].singAttempts).toBe(1);
    expect(v.stats[0].playAttempts).toBe(3); // G4 and G#3 plucked = two wrong attempts, then the pass
    expect(v.stats[0].playMs).toBeGreaterThan(2500);
    expect(v.stats[0].playCents).toBeCloseTo(0, 3);
  });

  it('the tail of the sung answer never passes the guitar step; a new pluck does', () => {
    const s = make();
    const c = new Clock();
    s.start();
    s.listenDone(0);
    c.quiet(s, 200);
    expect(c.sing(s, 55, 800)).toBe(true);
    // the voice keeps going into the guitar step, then fades out: no attack, no pass
    expect(c.sing(s, 55, 900)).toBe(false);
    for (let k = 0; k < 20; k++) {
      c.t += 0.02;
      expect(s.pitch({ t: c.t, freq: midiToFreq(55), clarity: 0.95, rms: 0.1 * Math.pow(0.85, k) })).toBe(false);
    }
    // (says why: still singing, or — once the voice has died away — only a note still sounding)
    expect(['noAttack', 'ringing']).toContain(s.view().match?.hint);
    c.quiet(s, 300);
    expect(c.pluck(s, 55, 400)).toBe(true);
  });

  it('a guitar note still ringing from the previous step does not pass the next singing step', () => {
    const s = make({ phraseReview: false });
    const c = new Clock();
    s.start();
    // advance to note 13 ("What so" = G3 G3: indices 12 and 13 are both G3)
    for (let i = 0; i < 13; i++) {
      s.listenDone(c.t);
      c.quiet(s, 100);
      c.sing(s, s.view().targetMidi, 700);
      c.quiet(s, 100);
      c.pluck(s, s.view().targetMidi, 400);
    }
    expect(s.view().index).toBe(13);
    expect(s.view().targetMidi).toBe(55);
    s.listenDone(c.t);
    // the G3 just plucked is still ringing (decaying ~15 dB/s) when the singing step opens
    for (let k = 0; k < 60; k++) {
      c.t += 0.02;
      expect(s.pitch({ t: c.t, freq: midiToFreq(55), clarity: 0.97, rms: 0.05 * Math.pow(10, (-15 * k * 0.02) / 20) })).toBe(false);
    }
    expect(s.view().match?.hint).toBe('carryOver');
    c.quiet(s, 150);
    expect(c.sing(s, 55, 700)).toBe(true);
  });

  it('strict instrument check: a pluck never passes the singing step, a sung note never passes the guitar step', () => {
    const s = make({ strictCheck: true });
    const c = new Clock();
    s.start();
    s.listenDone(0);
    c.quiet(s, 200);
    expect(c.pluck(s, 55, 2000)).toBe(false);
    c.quiet(s, 200);
    expect(c.sing(s, 55, 800)).toBe(true);
    c.quiet(s, 300);
    expect(c.sing(s, 55, 1500)).toBe(false);
    c.quiet(s, 300);
    expect(c.pluck(s, 55, 500)).toBe(true);
  });

  it('respects the singing tolerance setting', () => {
    for (const [tol, cents, pass] of [[50, 40, true], [35, 40, false], [25, 20, true], [25, 30, false]] as const) {
      const s = make({ singTolerance: tol });
      const c = new Clock();
      s.start();
      s.listenDone(0);
      c.quiet(s, 100);
      expect(c.sing(s, 55, 1500, { cents })).toBe(pass);
    }
  });

  it('a tolerance change applies to the singing step in progress', () => {
    const s = make({ singTolerance: 25 });
    const c = new Clock();
    s.start();
    s.listenDone(0);
    c.quiet(s, 100);
    expect(c.sing(s, 55, 1000, { cents: 40 })).toBe(false);
    s.setSettings({ ...DEFAULT_SETTINGS, singTolerance: 50 });
    expect(c.sing(s, 55, 1000, { cents: 40 })).toBe(true);
  });

  it('require-exact-octave makes singing octave-sensitive', () => {
    const s = make({ singExactOctave: true });
    const c = new Clock();
    s.start();
    s.listenDone(0);
    expect(c.sing(s, 67, 1500)).toBe(false);
    c.quiet(s, 200);
    expect(c.sing(s, 55, 1000)).toBe(true);
  });

  it('rejects silence and low-clarity frames', () => {
    const s = make();
    const c = new Clock();
    s.start();
    s.listenDone(0);
    expect(c.quiet(s, 3000)).toBe(false);
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
    expect(c.sing(s, 55, 800)).toBe(true);
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
    c.sing(s, 58, 700); // wrong note held: 1 attempt
    s.replay();
    expect(s.view().phase).toBe('listen');
    expect(s.view().next).toBe('sing');
    expect(c.sing(s, 55, 1000)).toBe(false); // mic ignored during replay
    s.listenDone(c.t);
    expect(s.view().phase).toBe('sing');
    expect(c.sing(s, 55, 700)).toBe(true);
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
      c.quiet(s, 100);
      expect(c.pluck(s, phrase[i], 400)).toBe(true);
    }
    let v = s.view();
    expect(v.phase).toBe('review');
    expect(v.review?.notes).toEqual(phrase);
    expect(v.review?.pos).toBe(0);
    expect(c.pluck(s, 60, 500, { peak: 0.05 })).toBe(false); // last note still ringing: no fresh attack, wrong note anyway
    c.quiet(s, 100);
    expect(c.pluck(s, 52, 500)).toBe(false); // out of order
    for (let k = 0; k < 6; k++) {
      c.quiet(s, 100);
      expect(c.pluck(s, phrase[k], 400)).toBe(true);
      if (k < 5) expect(s.view().review?.pos).toBe(k + 1);
    }
    v = s.view();
    expect(v.phase).toBe('listen');
    expect(v.index).toBe(6);
    expect(v.reviews).toHaveLength(1);
    expect(v.reviews[0].mistakes).toBe(1); // only the out-of-order E3; the ringing C4 is not a slip
  });

  it('phrase review accepts let-ring playing at the written tempo (order and pitch only)', () => {
    const s = make({ skipSing: true });
    const c = new Clock();
    s.start();
    for (let i = 0; i < 6; i++) {
      s.listenDone(c.t);
      c.quiet(s, 100);
      c.pluck(s, s.view().targetMidi, 400);
    }
    expect(s.view().phase).toBe('review');
    // 16th-note fast: each note 180 ms, no gaps (the previous note keeps ringing, quieter)
    for (const m of [55, 52, 48, 52, 55, 60]) c.pluck(s, m, 180);
    expect(s.view().phase).toBe('listen');
    expect(s.view().index).toBe(6);
  });

  it('the review itself can be skipped', () => {
    const s = make({ skipSing: true });
    const c = new Clock();
    s.start();
    for (let i = 0; i < 6; i++) {
      s.listenDone(c.t);
      c.quiet(s, 100);
      c.pluck(s, s.view().targetMidi, 400);
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
      c.quiet(s, 100);
      c.pluck(s, s.view().targetMidi, 400);
    }
    s.listenDone(c.t);
    expect(s.view().targetMidi).toBe(55);
    c.quiet(s, 100);
    expect(c.pluck(s, 55, 400)).toBe(true);
    expect(s.view().index).toBe(13);
    s.listenDone(c.t);
    expect(s.view().targetMidi).toBe(55);
    // still ringing (and decaying) — must not pass
    for (let k = 0; k < 40; k++) {
      c.t += 0.02;
      expect(s.pitch({ t: c.t, freq: midiToFreq(55), clarity: 0.97, rms: 0.05 * Math.pow(0.97, k) })).toBe(false);
    }
    // new pluck: level jumps
    expect(c.pluck(s, 55, 400)).toBe(true);
  });

  it('skip button only when allowed; completes to done with a summary', () => {
    const locked = make({ allowSkip: false });
    locked.start();
    expect(locked.skip()).toBe(false);

    const s = make({ phraseReview: true });
    const c = new Clock();
    s.start();
    s.listenDone(0);
    c.sing(s, 55, 800);
    c.quiet(s, 100);
    c.pluck(s, 55, 400);
    let guard = 0;
    while (s.view().phase !== 'done' && guard++ < 1000) s.skip();
    const v = s.view();
    expect(v.phase).toBe('done');
    expect(v.stats.filter((x) => x.skipped)).toHaveLength(SSB.notes.length - 1);
    expect(v.reviews).toHaveLength(0); // skipped notes don't trigger a review
    const sum = summarize(v);
    expect(sum.notesDone).toBe(1);
    expect(sum.notesSkipped).toBe(SSB.notes.length - 1);
    expect(sum.totalAttempts).toBe(2);
  });

  it('restores earlier per-note results when resuming', () => {
    const a = make();
    const c = new Clock();
    a.start();
    a.listenDone(0);
    c.sing(a, 55, 800);
    c.quiet(a, 100);
    c.pluck(a, 55, 400);
    const saved = a.view();
    const b = make();
    b.restore({ stats: saved.stats, reviews: saved.reviews });
    b.start(1);
    expect(b.view().stats[0].playAttempts).toBe(1);
    expect(summarize(b.view()).notesDone).toBe(1);
  });
});
