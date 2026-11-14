// Ported from the third external review (independent synthesis and session rig), kept as a permanent test.
// Honest-student behaviour scripts over the critic-3 rig.
import { Rig, type RigOpts } from './rig.ts';
import { breath, gtr, rng, speech, squeak, stringFor, throatClear, voice, OPEN, type GOpts } from './synth.ts';

export type GVar = 'plain' | 'squeak' | 'lateFretOpen' | 'glideIn' | 'double' | 'adjacent' | 'buzz' | 'alt' | 'soft' | 'hard' | 'bright';
export type SVar = 'plain' | 'slide' | 'restart' | 'throat' | 'okayUm' | 'breathIn' | 'scoopWobble';
export interface Style {
  name: string;
  g?: Partial<GOpts>;
  stringCents?: number[]; // per-string detune
  gVars?: GVar[]; // rotated per note
  sVars?: SVar[];
  female?: boolean;
  octaveShift?: number; // sing this many octaves away from the comfortable fold (still any octave)
  intonSd?: number; vib?: number; vPeak?: number; breathy?: number;
  ring?: boolean; // previous guitar notes keep ringing (default true)
  hunt?: (idx: number, target: number, r: () => number) => number[]; // wrong offsets first
  huntGap?: number;
  idle?: 'talk' | 'humTarget' | 'humOctaveBelow' | 'none';
  pause?: number; // pause between sing accept and pluck
  react?: number;
  reviewIOI?: number;
  noReview?: boolean;
  maxNotes?: number;
  verbose?: boolean;
}
export interface Res {
  name: string; total: number; clean: number; stuckSing: number; stuckPlay: number; accidental: { idx: number; phase: string; why: string }[];
  wrongOctFifth: number; extraPlucks: number; notesNeedingExtraPluck: number; extraBreaths: number; notesNeedingExtraBreath: number;
  singTta: number[]; playTta: number[]; reviews: number; reviewFirstTry: number; reviewGivenUp: number; reviewAccidental: number; minutes: number;
  hints: Record<string, number>;
}

const cache = new Map<string, Float32Array>();
const memo = (k: string, f: () => Float32Array) => { let b = cache.get(k); if (!b) cache.set(k, (b = f())); return b; };
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(6.283 * r());

export function student(st: Style, ro: RigOpts = {}): Res {
  const rig = new Rig({ ...ro, settings: { ...(ro.settings ?? {}), ...(st.noReview ? { phraseReview: false } : {}) } });
  const sr = rig.sr; const r = rng(1234 + (ro.seed ?? 0));
  const res: Res = { name: st.name, total: 0, clean: 0, stuckSing: 0, stuckPlay: 0, accidental: [], wrongOctFifth: 0, extraPlucks: 0, notesNeedingExtraPluck: 0, extraBreaths: 0, notesNeedingExtraBreath: 0, singTta: [], playTta: [], reviews: 0, reviewFirstTry: 0, reviewGivenUp: 0, reviewAccidental: 0, minutes: 0, hints: {} };
  const max = st.maxNotes ?? 101;
  const lo = st.female ? 55 : 43; // comfortable range G3.. / G2..
  const fold = (m: number) => { while (m >= lo + 12) m -= 12; while (m < lo) m += 12; return m + 12 * (st.octaveShift ?? 0); };
  let logPos = 0;
  const noteHint = () => { const h = rig.s.view().match?.hint; if (h) res.hints[`${rig.s.view().phase}:${h}`] = (res.hints[`${rig.s.view().phase}:${h}`] ?? 0) + 1; };
  const runH = (sec: number, until?: (v: ReturnType<Rig['step']>) => boolean) => rig.run(sec, (v) => { noteHint(); return !!until && until(v); });

  const gbuf = (midi: number, variant: GVar, k: number): { buf: Float32Array; string: number } => {
    const alt = variant === 'alt';
    const { s, fret } = stringFor(midi, alt);
    const cents = (st.stringCents?.[s] ?? 0) + (fret > 0 ? 4 : 0);
    const base: GOpts = { sr, seed: midi + 17 * k, cents, alt, peakDb: -20, hard: 0.5, ...(st.g ?? {}) };
    if (variant === 'soft') { base.peakDb = (st.g?.peakDb ?? -20) - 18; base.hard = 0.1; }
    if (variant === 'hard') { base.peakDb = Math.min(-3, (st.g?.peakDb ?? -20) + 14); base.hard = 1; }
    if (variant === 'bright') base.bright = 1;
    if (variant === 'buzz') base.buzz = 0.6;
    if (variant === 'glideIn') { base.glideFrom = -45; base.glideMs = 160; }
    const key = `${midi}:${variant}:${k % 3}:${JSON.stringify(base)}`;
    return {
      string: s,
      buf: memo(key, () => {
        const main = gtr(midi, 3.5, base);
        if (variant === 'squeak') { const q = squeak(0.14, sr, (base.peakDb ?? -20) - 16, midi); const out = new Float32Array(main.length + Math.floor(0.25 * sr)); out.set(q, 0); out.set(main, Math.floor(0.25 * sr)); return out; }
        if (variant === 'lateFretOpen' && fret > 0) {
          // the string sounds open/half-damped for ~110 ms before the finger lands, then the fretted pitch (no new pick)
          const pre = gtr(OPEN[s], 0.5, { ...base, cents: st.stringCents?.[s] ?? 0, peakDb: (base.peakDb ?? -20) - 6, decayMul: 6 });
          const post = gtr(midi, 3.5, { ...base, noPick: true, peakDb: (base.peakDb ?? -20) - 3 });
          const d = Math.floor(0.11 * sr); const out = new Float32Array(post.length + d);
          for (let i = 0; i < pre.length; i++) out[i] += pre[i] * (i < d ? 1 : Math.max(0, 1 - (i - d) / (0.015 * sr)));
          for (let i = 0; i < post.length; i++) out[d + i] += post[i];
          return out;
        }
        if (variant === 'double') { const first = gtr(midi, 0.2, { ...base, peakDb: (base.peakDb ?? -20) - 10, hard: 0.2, seed: 99 + midi }); const d = Math.floor(0.11 * sr); const out = new Float32Array(main.length + d); for (let i = 0; i < d; i++) out[i] = first[i]; out.set(main, d); return out; }
        if (variant === 'adjacent') { const adj = OPEN[Math.min(5, s + 1)]; const a = gtr(adj, 3.5, { ...base, cents: st.stringCents?.[Math.min(5, s + 1)] ?? 0, peakDb: (base.peakDb ?? -20) - 9, seed: 5 + midi }); const d = Math.floor(0.02 * sr); const out = Float32Array.from(main); for (let i = 0; i + d < out.length; i++) out[i + d] += a[i]; return out; }
        return main;
      }),
    };
  };
  const pluck = (midi: number, variant: GVar, k: number, tag = 'guitar') => {
    const { buf, string } = gbuf(midi, variant, k);
    if (st.ring === false) rig.stop((e) => e.tag.startsWith('guitar'), 30);
    rig.play(buf, tag, midi, string);
    const lead = variant === 'squeak' ? 0.25 : variant === 'lateFretOpen' || variant === 'double' ? 0.11 : 0;
    rig.lastPluck = { midi, t: rig.t + lead };
    return lead;
  };
  const sing = (target: number, variant: SVar, k: number): number => {
    // returns total duration started; sets rig.voice at the moment the real note starts
    const m = fold(target); const cents = gauss(r) * (st.intonSd ?? 12);
    const vib = st.vib ?? 18; const vw = (['a', 'o', 'u', 'e', 'm'] as const)[(target + k) % 5];
    const dur = 2.6; let pre = 0;
    if (variant === 'throat') { rig.play(throatClear(sr, (st.vPeak ?? -18) - 2, k + target), 'throat', -1); runH(0.9, (v) => v.phase !== 'sing'); }
    if (variant === 'okayUm') { rig.play(speech(1.3, { sr, seed: 31 * target + k, female: st.female, peakDb: (st.vPeak ?? -18) - 4, um: true }), 'speech', -1); runH(1.5, (v) => v.phase !== 'sing'); }
    if (variant === 'breathIn') { rig.play(breath(0.5, sr, (st.vPeak ?? -18) - 14, k + 3), 'breath', -1); runH(0.55, (v) => v.phase !== 'sing'); }
    if (rig.s.view().phase !== 'sing') return 0;
    let pitch = (t: number) => m + cents / 100 + (vib / 100) * Math.sin(2 * Math.PI * 5.3 * t) * Math.min(1, t / 0.4);
    let amp: ((t: number) => number) | undefined;
    if (variant === 'slide') { const from = -2.5 - 2 * r(); const T = 0.35 + 0.2 * r(); pitch = (t) => m + cents / 100 + from * Math.max(0, 1 - t / T) ** 2 + (vib / 100) * Math.sin(2 * Math.PI * 5.3 * t) * Math.min(1, Math.max(0, t - T) / 0.3); pre = T * 0.6; }
    if (variant === 'restart') { amp = (t) => (t < 0.3 ? Math.min(1, t / 0.05) * Math.min(1, (0.3 - t) / 0.05) : t < 0.5 ? 0 : Math.min(1, (t - 0.5) / 0.06) * Math.min(1, (dur - t) / 0.08)); const p0 = pitch; pitch = (t) => p0(t) + (t < 0.3 ? -0.7 : 0); pre = 0.5; }
    if (variant === 'scoopWobble') { const p0 = pitch; pitch = (t) => p0(t) + 0.5 * Math.exp(-t / 0.25) * Math.sin(2 * Math.PI * 3 * t); }
    rig.play(voice(dur, { sr, seed: target * 13 + k, female: st.female, peakDb: st.vPeak ?? -18, vowel: vw, pitch, amp, breathy: st.breathy ?? 0.15 }), 'voice', m);
    rig.voice = { midi: m, t0: rig.t + pre };
    return dur;
  };

  let v = rig.s.view(); let guard = 0;
  const collect = () => {
    for (; logPos < rig.log.length; logPos++) {
      const a = rig.log[logPos];
      if (!a.legit) {
        if (a.phase === 'review') res.reviewAccidental++;
        res.accidental.push({ idx: a.index, phase: a.phase, why: a.why });
        if (/WRONG NOTE [+-](12|7|5|19|24) /.test(a.why)) res.wrongOctFifth++;
        if (st.verbose) console.log(`   ACCIDENTAL note ${a.index + 1} ${a.phase}: ${a.why}`);
      } else if (a.tta !== undefined) (a.phase === 'sing' ? res.singTta : a.phase === 'play' ? res.playTta : []).push(a.tta);
    }
  };
  while (v.phase !== 'done' && v.index < max && guard++ < 6000) {
    if (v.phase === 'listen') { v = rig.run(40, (x) => x.phase !== 'listen'); continue; }
    const idx = v.index; const target = v.targetMidi;
    let noteClean = true;
    if (v.phase === 'sing') {
      rig.voice = null; rig.rightPluckT = null; rig.lastPluck = null;
      let breaths = 0; let ok = false;
      const sv = st.sVars ? st.sVars[idx % st.sVars.length] : 'plain';
      while (breaths < 6 && !ok) {
        breaths++;
        v = runH(breaths === 1 ? (st.react ?? 0.4) + 0.3 * r() : 0.7, (x) => x.phase !== 'sing');
        if (v.phase !== 'sing') break;
        const d = sing(target, breaths <= 2 ? sv : 'plain', breaths);
        if (rig.s.view().phase !== 'sing') break;
        v = runH(d - 0.1, (x) => x.phase !== 'sing');
        if (v.phase !== 'sing') { ok = true; break; }
        rig.stop((e) => e.tag === 'voice', 80); rig.voice = null;
      }
      collect();
      const mine = rig.log.filter((a) => a.index === idx && a.phase === 'sing');
      if (!mine.length) { res.stuckSing++; noteClean = false; rig.stop((e) => e.tag !== 'guitar'); rig.skip(); v = rig.s.view(); res.total++; if (st.verbose) console.log(`   STUCK sing note ${idx + 1} (midi ${target})`); continue; }
      if (!mine[0].legit) noteClean = false;
      if (breaths > 1) { res.extraBreaths += breaths - 1; res.notesNeedingExtraBreath++; if (st.verbose) console.log(`   note ${idx + 1} (midi ${target}) needed ${breaths} breaths`); }
      // keep singing a little after the accept
      runH(0.2 + 0.3 * r(), (x) => x.index !== idx);
      rig.stop((e) => e.tag === 'voice', 90);
      v = rig.s.view();
    }
    if (v.phase === 'play' && v.index === idx) {
      const still = (x: ReturnType<Rig['step']>) => x.phase === 'play' && x.index === idx;
      v = runH(st.pause ?? 0.6, (x) => !still(x));
      rig.voice = null;
      // idle sounds while hunting
      if (still(v) && st.idle && st.idle !== 'none') {
        if (st.idle === 'talk') { rig.play(speech(1.6, { sr, seed: 77 * idx + 5, female: st.female, peakDb: (st.vPeak ?? -18) - 4, um: true }), 'speech', -1); v = runH(1.8, (x) => !still(x)); }
        else {
          const hm = st.idle === 'humTarget' ? fold(target) : fold(target) - 12;
          for (let k = 0; k < 2 && still(v); k++) {
            const hd = 0.5 + 0.4 * r();
            rig.play(voice(hd, { sr, seed: idx * 3 + k, female: st.female, peakDb: (st.vPeak ?? -18) - 8, vowel: 'm', pitch: () => hm + 0.1 * gauss(r), amp: (t) => Math.min(1, t / 0.04) * Math.min(1, (hd - t) / 0.15) }), 'hum', hm);
            rig.voice = { midi: hm, t0: rig.t };
            v = runH(hd + 0.35, (x) => !still(x));
          }
          rig.voice = null;
        }
      }
      const wrongs = still(v) && st.hunt ? st.hunt(idx, target, r) : [];
      for (const w of wrongs) {
        if (!still(v)) break;
        pluck(target + w, 'plain', idx);
        v = runH(st.huntGap ?? 0.8, (x) => !still(x));
      }
      let plucks = 0;
      const gv = st.gVars ? st.gVars[idx % st.gVars.length] : 'plain';
      while (still(v) && plucks < 5) {
        plucks++;
        const lead = pluck(target, plucks <= 2 ? gv : 'plain', idx + plucks);
        rig.rightPluckT = rig.t + lead;
        v = runH(2.0, (x) => !still(x));
        if (still(v) && st.verbose) console.log(`   note ${idx + 1} (midi ${target}, ${gv}) pluck ${plucks} not accepted; hint ${v.match?.hint ?? '-'} cents ${v.match?.cents?.toFixed(0) ?? '-'}`);
      }
      collect();
      const mine = rig.log.filter((a) => a.index === idx && a.phase === 'play');
      if (!mine.length) { res.stuckPlay++; noteClean = false; rig.skip(); v = rig.s.view(); res.total++; if (st.verbose) console.log(`   STUCK play note ${idx + 1} (midi ${target}, ${gv})`); continue; }
      if (!mine[0].legit) noteClean = false;
      if (plucks > 1) { res.extraPlucks += plucks - 1; res.notesNeedingExtraPluck++; }
      v = rig.s.view();
    }
    res.total++; if (noteClean) res.clean++;
    if (v.phase === 'review') {
      res.reviews++;
      const ph = v.review!; let tries = 0; let ok = false;
      while (tries < 4 && !ok && rig.s.view().phase === 'review') {
        tries++;
        rig.run(tries === 1 ? 1.0 : 1.3);
        const from = rig.s.view().review?.pos ?? 0;
        for (let k = from; k < ph.notes.length; k++) {
          pluck(ph.notes[k], 'plain', k + tries);
          const pos0 = rig.s.view().review?.pos;
          v = runH(st.reviewIOI ?? 0.6, (x) => x.phase !== 'review');
          if (v.phase !== 'review') break;
          if (st.verbose && v.review!.pos === pos0) { const mm = (rig.s as any).matcher; console.log(`   review "${ph.phrase.lyric}" try ${tries}: note ${k + 1}/${ph.notes.length} midi ${ph.notes[k]} (prev ${k > 0 ? ph.notes[k - 1] : '-'}) not accepted within the gap; app expects pos ${pos0! + 1} midi ${v.targetMidi}; hint ${v.match?.hint ?? '-'} cand id ${mm?.cand?.identity?.toFixed(2) ?? '-'} done ${mm?.cand?.done}`); }
        }
        v = runH(1.5, (x) => x.phase !== 'review');
        ok = v.phase !== 'review';
      }
      collect();
      if (ok) { if (tries === 1) res.reviewFirstTry++; } else { res.reviewGivenUp++; rig.skip(); if (st.verbose) console.log(`   review "${ph.phrase.lyric}" given up`); }
      v = rig.s.view();
    }
  }
  collect();
  res.minutes = rig.t / 60;
  return res;
}

export function fmt(r: Res): string {
  const q = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))].toFixed(0) : '-');
  const acc = r.accidental.filter((a) => a.phase !== 'review');
  return `${r.name}\n   clean ${r.clean}/${r.total} | stuck sing ${r.stuckSing}, stuck play ${r.stuckPlay} | accidental advances ${acc.length} (sing ${acc.filter((a) => a.phase === 'sing').length}, play ${acc.filter((a) => a.phase === 'play').length}; wrong oct/5th ${r.wrongOctFifth}) | extra plucks ${r.extraPlucks} on ${r.notesNeedingExtraPluck} notes | extra breaths ${r.extraBreaths} on ${r.notesNeedingExtraBreath} notes | sing tta med ${q(r.singTta, 0.5)} p90 ${q(r.singTta, 0.9)} ms | play tta med ${q(r.playTta, 0.5)} p90 ${q(r.playTta, 0.9)} ms | review ${r.reviewFirstTry}/${r.reviews} first try, given up ${r.reviewGivenUp}, accidental ${r.reviewAccidental} | ${r.minutes.toFixed(1)} min\n   hints seen (frames): ${JSON.stringify(r.hints)}${acc.length ? '\n   e.g. ' + acc.slice(0, 4).map((a) => `#${a.idx + 1} ${a.phase}: ${a.why}`).join('\n        ') : ''}`;
}
