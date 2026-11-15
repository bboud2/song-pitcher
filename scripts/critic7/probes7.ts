// Seventh review's single-step probes, ported (from its probe7.ts) as functions for the tests and
// the gauntlet: each brings a fresh rig to the guitar (or singing) step of a note and plays one
// kind of student behaviour into it.
import { Rig, load, envFor, sungMidi, med, pct, rng, stringFor, type Env } from './rig7.ts';
import type { GOpts, VOpts } from './syn7.ts';

const m = await load();
export const midis: number[] = m.SONG.notes.map((q: { offset: number }) => 48 + q.offset);
/** 20 note indices covering every distinct pitch of the song */
export const IDX: number[] = (() => {
  const seen = new Map<number, number[]>();
  midis.forEach((mm, i) => {
    const a = seen.get(mm) ?? [];
    a.push(i);
    seen.set(mm, a);
  });
  const out: number[] = [];
  for (const [, a] of [...seen].sort((x, y) => x[0] - y[0])) out.push(a[Math.floor(a.length / 2)]);
  let k = 3;
  while (out.length < 20) {
    if (!out.includes(k)) out.push(k);
    k += 9;
  }
  return out;
})();

interface Ctx { rig: Rig; idx: number; target: number; voiceEv: unknown; r: () => number }
const inPlay = (q: { phase: string }) => q.phase === 'play';

/** a fresh rig at the guitar step of note idx, the sung answer accepted and still sounding */
function toPlay(room: string, idx: number, env: Env, vo: Partial<VOpts> = {}, vLevel = -18, seed = 1): Ctx | null {
  const rig = new Rig(m, { ...envFor(room, env), seed: seed * 31 + idx, settings: { phraseReview: false } });
  const r = rng(seed * 17 + idx);
  rig.begin(idx);
  rig.run(30, (q) => q.phase !== 'listen');
  rig.run(0.4 + 0.4 * r());
  const target = midis[idx];
  const sm = sungMidi(target);
  let ev: unknown = null;
  for (let a = 0; a < 3; a++) {
    ev = rig.sing({ midi: sm, dur: 7, seed: idx * 13 + seed + a, scoop: 30 * r(), vowel: 'a', ...vo } as VOpts, vLevel, 0);
    const v = rig.run(4.5, (q) => q.phase !== 'sing');
    if (v.phase !== 'sing') break;
    rig.stop(ev as never);
    ev = null;
    rig.run(0.9);
  }
  if (rig.s.view().phase !== 'play') return null;
  return { rig, idx, target, voiceEv: ev, r };
}
const gbase = (midi: number, seed: number, extra: Partial<GOpts> = {}): GOpts => ({ midi, seed: midi * 7 + seed, dur: 3, cents: [-4, 3, 8][seed % 3], kind: 'steel', pluck: 'pick', ...extra });
function tryPlucks(c: Ctx, mk: (k: number) => void, max = 5): { k: number; lat: number } {
  let k = 0;
  let ok = false;
  for (; k < max && !ok; k++) {
    mk(k);
    const v = c.rig.run(2.5, (q) => !inPlay(q));
    ok = !inPlay(v);
  }
  const a = c.rig.log[c.rig.log.length - 1] as { lat?: number } | undefined;
  return { k: ok ? k : -1, lat: a?.lat ?? NaN };
}

/** Pluck `gapMs` after the sung answer stops (negative: while still singing), `ratioDb` relative to the voice. */
export function gapProbe(room: string, ratioDb: number, gapMs: number, idxs = IDX.filter((_, i) => i % 2 === 0)): { first: number; n: number } {
  let first = 0;
  let n = 0;
  for (const idx of idxs) {
    const c = toPlay(room, idx, {}, { vib: 18 } as Partial<VOpts>, -18, 3);
    if (!c) continue;
    const { rig } = c;
    n++;
    const hold = 0.6;
    const pluckAt = rig.t + hold + gapMs / 1000;
    const stopAt = rig.t + hold;
    let stopped = false;
    while (rig.t < Math.max(pluckAt, 0) && inPlay(rig.s.view())) {
      if (!stopped && rig.t >= stopAt) {
        rig.stop(c.voiceEv as never, 70);
        stopped = true;
      }
      rig.step();
    }
    if (!inPlay(rig.s.view())) continue;
    const res = tryPlucks(c, (k) => {
      rig.pluck(gbase(c.target, idx + k), -18 + ratioDb, 0);
      if (k === 0 && !stopped) {
        while (rig.t < stopAt && inPlay(rig.s.view())) rig.step();
        rig.stop(c.voiceEv as never, 70);
        stopped = true;
      }
    });
    if (res.k === 1) first++;
  }
  return { first, n };
}

export const OWN: Record<string, [Partial<VOpts>, number]> = {
  'held a vib25': [{ vowel: 'a', vib: 25 } as Partial<VOpts>, -18],
  'held o vib45 loud': [{ vowel: 'o', vib: 45, am: 1.6, vibDelay: 0.2 } as Partial<VOpts>, -12],
  'held e pressed': [{ vowel: 'e', press: 0.85, vib: 15 } as Partial<VOpts>, -20],
  'hard onset a': [{ vowel: 'a', onset: 'hard', vib: 30 } as Partial<VOpts>, -16],
};
/** The sung answer simply goes on (held, then stopped) into the guitar step: never a pluck. */
export function ownProbe(room: string, kind: string, idxs = [...IDX, ...IDX.map((i) => (i + 5) % 101)]): { adv: number; n: number } {
  const [vo, lvl] = OWN[kind];
  let adv = 0;
  let n = 0;
  for (const idx of idxs) {
    const c = toPlay(room, idx, {}, vo, lvl, 9);
    if (!c) continue;
    const { rig } = c;
    n++;
    const hold = 1.2 + 1.8 * c.r();
    let v = rig.run(hold, (q) => !inPlay(q));
    if (inPlay(v)) {
      rig.stop(c.voiceEv as never, 60 + 80 * c.r());
      v = rig.run(2.0, (q) => !inPlay(q));
    }
    if (!inPlay(v)) adv++;
  }
  return { adv, n };
}

/** Singing step only: every sung pitch of the song in one vowel, 3 takes each. */
export function singProbe(room: string, vowel: string, press: number): { first: number; n: number; stuck: number } {
  const firstIdx = new Map<number, number>();
  midis.forEach((mm, i) => {
    if (!firstIdx.has(mm)) firstIdx.set(mm, i);
  });
  let first = 0;
  let n = 0;
  let stuck = 0;
  for (const [mm, idx] of [...firstIdx].sort((a, b) => a[0] - b[0])) {
    const rig = new Rig(m, { ...envFor(room), seed: idx, settings: { phraseReview: false } });
    rig.begin(idx);
    rig.run(30, (q) => q.phase !== 'listen');
    rig.run(0.5);
    n++;
    let ok = false;
    for (let a = 0; a < 3 && !ok; a++) {
      const ev = rig.sing({ midi: sungMidi(mm), dur: 4.2, seed: idx * 3 + a * 7 + 1, vowel, press, scoop: 25 } as VOpts, -22, 0);
      const v = rig.run(4.4, (q) => q.phase !== 'sing');
      if (v.phase !== 'sing') {
        ok = true;
        if (a === 0) first++;
      } else {
        rig.stop(ev);
        rig.run(0.8);
      }
    }
    if (!ok) stuck++;
  }
  return { first, n, stuck };
}

/** The string of note i left ringing must not pass the singing step of note i+1 (same pitch class). */
export function carryProbe(room: string): { adv: number; n: number } {
  let adv = 0;
  let n = 0;
  for (let i = 0; i + 1 < midis.length; i++) {
    if ((midis[i] - midis[i + 1]) % 12 !== 0) continue;
    if (m.SONG.phrases.find((p: { end: number }) => p.end === i)) continue;
    for (const [pl, kind, lvl] of [['pick', 'steel', -10], ['finger', 'nylon', -14]] as const) {
      const c = toPlay(room, i, {}, {}, -20, 13);
      if (!c) continue;
      const { rig } = c;
      rig.run(0.3);
      rig.stop(c.voiceEv as never, 70);
      rig.run(0.6);
      const res = tryPlucks(c, (k) => rig.pluck(gbase(c.target, i + k, { pluck: pl, kind, dur: 6 }), lvl, 0));
      if (res.k < 0) continue;
      n++;
      let v = rig.run(30, (q) => q.phase !== 'listen');
      if (v.phase !== 'sing' || v.index !== i + 1) continue;
      v = rig.run(4.0, (q) => q.phase !== 'sing');
      if (v.phase !== 'sing') adv++;
    }
  }
  return { adv, n };
}

export const WRONG: Record<string, (t: number) => GOpts | null> = {
  'oct-': (t) => (t - 12 >= 40 ? gbase(t - 12, 1) : null),
  'fretBelow+45c': (t) => (stringFor(t).fret > 0 ? { ...gbase(t - 1, 6), cents: 45, string: stringFor(t).s } : null),
};
/** A wrong note in the guitar step (honest sing first, voice stopped), plucked twice. */
export function wrongProbe(room: string, kind: string): { acc: number; n: number } {
  const mk = WRONG[kind];
  let acc = 0;
  let n = 0;
  for (const idx of IDX) {
    const g0 = mk(midis[idx]);
    if (!g0) continue;
    for (const lvl of [-12, -22]) {
      const c = toPlay(room, idx, {}, {}, -20, 11);
      if (!c) continue;
      const { rig } = c;
      n++;
      rig.run(0.3);
      rig.stop(c.voiceEv as never, 70);
      rig.run(0.7, (q) => !inPlay(q));
      if (!inPlay(rig.s.view())) {
        n--;
        continue;
      }
      rig.pluck(g0, lvl, 0, false);
      let v = rig.run(2.0, (q) => !inPlay(q));
      if (inPlay(v)) {
        rig.pluck({ ...g0, seed: (g0.seed ?? 0) + 1 }, lvl + 3, 0, false);
        v = rig.run(2.0, (q) => !inPlay(q));
      }
      if (!inPlay(v)) acc++;
    }
  }
  return { acc, n };
}

export const STRING: Record<string, { g?: Partial<GOpts>; lvl?: number }> = {
  base: {},
  finger: { g: { pluck: 'finger' } },
  stacc180: { g: { stopAt: 0.18, stopKind: 'hand' } as Partial<GOpts> },
};
/** Honest plucks of one kind after the voice has stopped: first-pluck rate and latency. */
export function stringProbe(room: string, variant: string): { first: number; n: number; med: number; p90: number } {
  const va = STRING[variant];
  let first = 0;
  let n = 0;
  const lats: number[] = [];
  for (const idx of IDX) {
    const c = toPlay(room, idx, {}, {}, -20, 5);
    if (!c) continue;
    const { rig } = c;
    n++;
    rig.run(0.3);
    rig.stop(c.voiceEv as never, 70);
    rig.run(0.5 + 0.4 * c.r(), (q) => !inPlay(q));
    if (!inPlay(rig.s.view())) {
      n--;
      continue;
    }
    const res = tryPlucks(c, (k) => rig.pluck(gbase(c.target, idx + k, va.g ?? {}), va.lvl ?? -14, 0));
    if (res.k === 1) {
      first++;
      lats.push(res.lat);
    }
  }
  return { first, n, med: med(lats), p90: pct(lats, 0.9) };
}
