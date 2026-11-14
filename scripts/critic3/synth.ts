// Ported from the third external review (independent synthesis and session rig), kept as a permanent test.
// Critic-3 independent synthesis: modal guitar, glottal-pulse voice, speech-ish babble, rooms.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const db2a = (d: number) => Math.pow(10, d / 20);
export const m2f = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const OPEN = [40, 45, 50, 55, 59, 64];

/** string index (0 = low E) for a pitch in open position; alt = use the next lower string */
export function stringFor(midi: number, alt = false): { s: number; fret: number } {
  let s = 0;
  for (let i = 0; i < 6; i++) if (OPEN[i] <= midi) s = i;
  if (alt && s > 0) s--;
  return { s, fret: midi - OPEN[s] };
}

export interface GOpts {
  sr: number;
  seed?: number;
  peakDb?: number; // peak level dBFS at the mic
  cents?: number; // static detune
  alt?: boolean; // play on the next lower string
  hard?: number; // 0 soft .. 1 hard (pitch glide, brightness)
  bright?: number; // pluck near bridge / capo-like (0..1)
  body?: 'acoustic' | 'electric';
  buzz?: number; // fret buzz amount 0..1
  thump?: boolean;
  decayMul?: number;
  noPick?: boolean; // hammer-on-like soft start
  glideFrom?: number; // cents: pitch starts here and settles in ~glideMs (late fretting)
  glideMs?: number;
}

/** Modal plucked string: inharmonic partials, two polarisations, per-partial decay, pick noise, body thump. */
export function gtr(midi: number, dur: number, o: GOpts): Float32Array {
  const sr = o.sr;
  const r = rng((o.seed ?? 1) * 7919 + midi * 31);
  const n = Math.floor(dur * sr);
  const out = new Float32Array(n);
  const { s, fret } = stringFor(midi, o.alt);
  const hard = o.hard ?? 0.5;
  const electric = o.body === 'electric';
  const f0 = m2f(midi) * Math.pow(2, (o.cents ?? 0) / 1200);
  // inharmonicity B per string (wound low, plain high), larger when fretted
  const B = [0.00006, 0.00008, 0.00012, 0.00022, 0.00009, 0.00005][s] * (1 + 0.12 * fret);
  const p = Math.max(0.05, (o.bright ? 0.18 - 0.11 * o.bright : 0.16 + 0.06 * r()) ); // pluck position
  // base decay dB/s by string, faster when fretted on plain strings
  const d0 = ([5.5, 6, 7, 9, 11, 13][s] + 0.8 * fret + 2 * r()) * (electric ? 0.6 : 1) * (o.decayMul ?? 1);
  const dn = (electric ? 0.02 : 0.05) * (1 + (o.bright ? -0.6 * o.bright : 0)); // extra dB/s per n^2
  const tilt = 6 + 10 * hard + (o.bright ? 14 * o.bright : 0) + (electric ? 6 : 0);
  const glideC = 4 + 14 * hard * hard; // cents sharp at the pluck, settling
  const glideTau = 0.12;
  const nyq = sr * 0.45;
  const env = new Float32Array(n);
  // pitch track
  const gf = o.glideFrom ?? 0;
  const gT = (o.glideMs ?? 150) / 1000;
  for (let k = 1; k <= 40; k++) {
    const fk = k * f0 * Math.sqrt(1 + B * k * k);
    if (fk > nyq) break;
    let a = Math.abs(Math.sin(k * Math.PI * p)) / k * Math.exp(-k / tilt);
    // body / radiation: weak fundamental below ~110 Hz on acoustic, much weaker lows on unplugged electric
    const fl = electric ? 400 : 110;
    a *= 1 / Math.sqrt(1 + Math.pow(fl / fk, electric ? 2 : 3));
    // body resonances (acoustic)
    if (!electric) a *= 1 + 1.2 * Math.exp(-Math.pow((fk - 200) / 40, 2)) + 0.8 * Math.exp(-Math.pow((fk - 105) / 15, 2));
    if (a < 1e-4) continue;
    const dec = d0 + dn * k * k;
    for (let pol = 0; pol < 2; pol++) {
      const det = pol === 0 ? 1 : 1 + (0.0004 + 0.0006 * r()) * (r() < 0.5 ? -1 : 1);
      const amp = a * (pol === 0 ? 1 : 0.25 + 0.3 * r());
      const decP = dec * (pol === 0 ? 1 : 0.6 + 0.3 * r());
      let ph = 2 * Math.PI * r();
      const w0 = (2 * Math.PI * fk * det) / sr;
      const kdec = Math.pow(10, -decP / 20 / sr);
      let e = amp;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let c = glideC * Math.exp(-t / glideTau);
        if (gf) c += gf * Math.max(0, 1 - t / gT);
        ph += w0 * (1 + c * 0.00057779); // 2^(c/1200) ~ 1 + c*ln2/1200
        out[i] += e * Math.sin(ph);
        e *= kdec;
      }
    }
  }
  // attack ramp
  const at = Math.floor((o.noPick ? 0.03 : 0.003) * sr);
  for (let i = 0; i < at && i < n; i++) out[i] *= i / at;
  let pk = 0;
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i]));
  const g = db2a(o.peakDb ?? -20) / (pk || 1);
  for (let i = 0; i < n; i++) out[i] *= g;
  const A = db2a(o.peakDb ?? -20);
  if (!o.noPick) {
    // pick/nail noise: 8 ms band-limited burst
    let z1 = 0, z2 = 0;
    const len = Math.floor(0.008 * sr);
    for (let i = 0; i < len && i < n; i++) {
      const w = r() * 2 - 1;
      z1 += 0.5 * (w - z1); z2 += 0.15 * (z1 - z2);
      out[i] += A * (0.25 + 0.5 * hard) * (z1 - z2) * 2 * (1 - i / len);
    }
    // body thump (Helmholtz ~100 Hz), acoustic only
    if (!electric && o.thump !== false) {
      const ft = 98 + 8 * r();
      for (let i = 0; i < Math.floor(0.12 * sr) && i < n; i++) out[i] += A * (0.1 + 0.2 * hard) * Math.exp(-i / (0.025 * sr)) * Math.sin((2 * Math.PI * ft * i) / sr);
    }
  }
  if (o.buzz) {
    // string slapping the fret once per period: jittered impulses, bandpassed, dying in ~0.3 s
    let ph = 0, z1 = 0, z2 = 0;
    for (let i = 0; i < n; i++) {
      ph += f0 / sr;
      let x = 0;
      if (ph >= 1) { ph -= 1; x = (0.6 + 0.8 * r()); }
      z1 += 0.6 * (x - z1); z2 += 0.2 * (z1 - z2);
      out[i] += A * o.buzz * 2.5 * (z1 - z2) * Math.exp(-i / (0.25 * sr));
    }
  }
  void env;
  return out;
}

/** finger squeak / slide noise: swept narrow-band noise */
export function squeak(dur: number, sr: number, peakDb: number, seed = 3): Float32Array {
  const r = rng(seed); const n = Math.floor(dur * sr); const out = new Float32Array(n);
  let y1 = 0, y2 = 0;
  for (let i = 0; i < n; i++) {
    const fc = 1800 + 1800 * (i / n);
    const w = (2 * Math.PI * fc) / sr; const rr = 0.985;
    const x = r() * 2 - 1;
    const y = x + 2 * rr * Math.cos(w) * y1 - rr * rr * y2;
    y2 = y1; y1 = y;
    out[i] = y * Math.sin((Math.PI * i) / n);
  }
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i]));
  const g = db2a(peakDb) / pk; for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

export interface VOpts {
  sr: number; seed?: number; peakDb?: number;
  vowel?: 'a' | 'o' | 'u' | 'e' | 'i' | 'm';
  female?: boolean;
  /** pitch in fractional MIDI as a function of time */
  pitch: (t: number) => number;
  /** amplitude 0..1 as a function of time (default: 60 ms attack, 80 ms release) */
  amp?: (t: number) => number;
  breathy?: number; // 0..1
  jitter?: number; // fraction
  /** vowel as a function of time (speech) */
  vowelAt?: (t: number) => 'a' | 'o' | 'u' | 'e' | 'i' | 'm';
  rough?: number; // 0..1 sub-harmonic roughness (throat clear / fry)
}
const FORM: Record<string, number[][]> = {
  a: [[730, 90], [1090, 110], [2440, 140], [3400, 200]],
  o: [[570, 80], [840, 100], [2410, 140], [3300, 200]],
  u: [[300, 70], [870, 100], [2240, 140], [3300, 200]],
  e: [[530, 80], [1840, 110], [2480, 140], [3400, 200]],
  i: [[270, 60], [2290, 110], [3010, 150], [3600, 200]],
  m: [[250, 60], [1100, 300], [2300, 400], [3300, 500]],
};
/** Rosenberg glottal pulse train through 4 formant resonators + aspiration noise. */
export function voice(dur: number, o: VOpts): Float32Array {
  const sr = o.sr; const n = Math.floor(dur * sr); const out = new Float32Array(n);
  const r = rng((o.seed ?? 5) * 104729);
  const src = new Float32Array(n);
  let ph = 0; let jit = 1; let shim = 1; let cyc = 0;
  const jitter = o.jitter ?? 0.008;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = m2f(o.pitch(t)) * jit;
    ph += f / sr;
    if (ph >= 1) {
      ph -= 1; cyc++;
      jit = 1 + jitter * (r() * 2 - 1);
      shim = 1 + 0.06 * (r() * 2 - 1);
      if (o.rough && r() < o.rough) shim *= (cyc % 2 ? 0.35 : 1.3);
    }
    // Rosenberg: open phase 0..0.6 (rise 0.4, fall 0.2), closed after
    let gflow: number;
    if (ph < 0.4) gflow = 0.5 * (1 - Math.cos((Math.PI * ph) / 0.4));
    else if (ph < 0.6) gflow = Math.cos((Math.PI * (ph - 0.4)) / 0.4);
    else gflow = 0;
    const d = (gflow - prev) * shim; prev = gflow; // derivative (radiation)
    const asp = (o.breathy ?? 0.1) * 0.02 * (r() * 2 - 1) * (ph < 0.6 ? 1 : 0.3);
    src[i] = d + asp;
  }
  // formants (parallel resonators, vowel can change over time in 10 ms blocks)
  const scale = o.female ? 1.17 : 1;
  const st = [0, 0, 0, 0, 0, 0, 0, 0];
  const blk = Math.floor(0.01 * sr);
  let cf = FORM[o.vowel ?? 'a'].map((x) => [...x]);
  for (let b = 0; b < n; b += blk) {
    const vw = o.vowelAt ? o.vowelAt(b / sr) : (o.vowel ?? 'a');
    const tgt = FORM[vw];
    for (let k = 0; k < 4; k++) { cf[k][0] += 0.25 * (tgt[k][0] - cf[k][0]); cf[k][1] += 0.25 * (tgt[k][1] - cf[k][1]); }
    for (let k = 0; k < 4; k++) {
      const fc = cf[k][0] * scale; const bw = cf[k][1];
      const rr = Math.exp((-Math.PI * bw) / sr); const w = (2 * Math.PI * fc) / sr;
      const a1 = 2 * rr * Math.cos(w); const a2 = -rr * rr; const g = (1 - rr) * [1, 0.5, 0.25, 0.12][k] * (vw === 'm' && k > 0 ? 0.15 : 1);
      let y1 = st[2 * k], y2 = st[2 * k + 1];
      for (let i = b; i < Math.min(n, b + blk); i++) {
        const y = g * src[i] + a1 * y1 + a2 * y2; y2 = y1; y1 = y; out[i] += y;
      }
      st[2 * k] = y1; st[2 * k + 1] = y2;
    }
  }
  const amp = o.amp ?? ((t: number) => Math.min(1, t / 0.06) * Math.min(1, Math.max(0, (dur - t) / 0.08)));
  let pk = 0;
  for (let i = 0; i < n; i++) { out[i] *= amp(i / sr); pk = Math.max(pk, Math.abs(out[i])); }
  const g = db2a(o.peakDb ?? -18) / (pk || 1);
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

/** breath / "h" / "s" noise */
export function breath(dur: number, sr: number, peakDb: number, seed = 7, fc = 1500): Float32Array {
  const r = rng(seed); const n = Math.floor(dur * sr); const out = new Float32Array(n);
  let y1 = 0, y2 = 0; const w = (2 * Math.PI * fc) / sr; const rr = 0.9;
  let pk = 0;
  for (let i = 0; i < n; i++) {
    const y = (r() * 2 - 1) + 2 * rr * Math.cos(w) * y1 - rr * rr * y2; y2 = y1; y1 = y;
    out[i] = y * Math.pow(Math.sin((Math.PI * i) / n), 0.7); pk = Math.max(pk, Math.abs(out[i]));
  }
  const g = db2a(peakDb) / pk; for (let i = 0; i < n; i++) out[i] *= g; return out;
}

/** Speech-like utterance: syllables with gliding pitch, changing vowels, consonant noise gaps. */
export function speech(dur: number, o: { sr: number; seed: number; female?: boolean; peakDb?: number; centerMidi?: number; um?: boolean }): Float32Array {
  const sr = o.sr; const r = rng(o.seed * 2654435761);
  const center = o.centerMidi ?? (o.female ? 56 : 45); // G#3 / A2
  const syl: { t0: number; t1: number; p0: number; p1: number; v: 'a' | 'o' | 'u' | 'e' | 'i' | 'm' }[] = [];
  let t = 0.05 + 0.1 * r();
  let decl = 2;
  while (t < dur - 0.15) {
    const isUm = o.um && r() < 0.25;
    const len = isUm ? 0.35 + 0.5 * r() : 0.09 + 0.2 * r();
    const p0 = center + decl + (r() * 2 - 1) * 4;
    const p1 = isUm ? p0 - 0.3 * r() : p0 + (r() * 2 - 1) * 3.5;
    const v = isUm ? (r() < 0.5 ? 'm' : 'a') : (['a', 'o', 'u', 'e', 'i'] as const)[Math.floor(r() * 5)];
    syl.push({ t0: t, t1: Math.min(dur - 0.05, t + len), p0, p1, v });
    t += len + (r() < 0.2 ? 0.25 + 0.5 * r() : 0.03 + 0.08 * r());
    decl -= 0.5; if (r() < 0.2) decl = 2;
  }
  const find = (tt: number) => syl.find((s) => tt >= s.t0 && tt < s.t1);
  let last = syl[0];
  const x = voice(dur, {
    sr, seed: o.seed, female: o.female, peakDb: o.peakDb ?? -24, jitter: 0.015, breathy: 0.25,
    pitch: (tt) => { const s = find(tt) ?? last; last = s; const u = Math.min(1, Math.max(0, (tt - s.t0) / (s.t1 - s.t0))); return s.p0 + (s.p1 - s.p0) * u; },
    vowelAt: (tt) => (find(tt) ?? last).v,
    amp: (tt) => { const s = find(tt); if (!s) return 0; return Math.min(1, (tt - s.t0) / 0.025) * Math.min(1, (s.t1 - tt) / 0.04); },
  });
  // consonant noise at syllable starts
  for (const s of syl) if (r() < 0.5) {
    const b = breath(0.04 + 0.05 * r(), sr, (o.peakDb ?? -24) - 8, Math.floor(r() * 1e6), 2500 + 3000 * r());
    const at = Math.max(0, Math.floor((s.t0 - 0.04) * sr));
    for (let i = 0; i < b.length && at + i < x.length; i++) x[at + i] += b[i];
  }
  return x;
}

/** throat clear: two rough, low, noisy bursts */
export function throatClear(sr: number, peakDb: number, seed = 11): Float32Array {
  const a = voice(0.28, { sr, seed, peakDb, pitch: (t) => 38 + 5 * Math.sin(40 * t), jitter: 0.12, rough: 0.6, breathy: 0.9, vowel: 'e' });
  const b = voice(0.22, { sr, seed: seed + 1, peakDb: peakDb - 3, pitch: (t) => 40 - 6 * t, jitter: 0.1, rough: 0.5, breathy: 0.9, vowel: 'a' });
  const out = new Float32Array(Math.floor(0.62 * sr));
  out.set(a, 0); out.set(b, Math.floor(0.38 * sr));
  return out;
}

/** TV: speech of alternating speakers plus bursts of pitched music (steady synth/piano-like tones). */
export function tv(dur: number, sr: number, seed: number): Float32Array {
  const r = rng(seed); const out = new Float32Array(Math.floor(dur * sr));
  let t = 0;
  while (t < dur) {
    const seg = Math.min(dur - t, 2 + 3 * r());
    if (r() < 0.6) {
      const s = speech(seg, { sr, seed: Math.floor(r() * 1e6), female: r() < 0.5, peakDb: -20 });
      out.set(s.subarray(0, Math.min(s.length, out.length - Math.floor(t * sr))), Math.floor(t * sr));
    } else {
      // jingle: notes 0.2-0.5 s, harmonic tones with decay, diatonic around C4
      let tt = 0; const scale = [0, 2, 4, 5, 7, 9, 11, 12];
      while (tt < seg - 0.3) {
        const m = 55 + scale[Math.floor(r() * 8)] + (r() < 0.3 ? 12 : 0); const d = 0.2 + 0.35 * r();
        const f = m2f(m); const at = Math.floor((t + tt) * sr);
        for (let i = 0; i < d * sr && at + i < out.length; i++) {
          const e = Math.min(1, i / (0.005 * sr)) * Math.exp(-i / (0.25 * sr));
          const ph = (2 * Math.PI * f * i) / sr;
          out[at + i] += 0.06 * e * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph) + 0.1 * Math.sin(4 * ph));
        }
        tt += d;
      }
    }
    t += seg;
  }
  return out;
}

export function rmsDb(x: Float32Array, a = 0, b = x.length): number {
  let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / Math.max(1, b - a) + 1e-20);
}
export function scaleToRms(x: Float32Array, db: number): Float32Array {
  const g = db2a(db - rmsDb(x)); for (let i = 0; i < x.length; i++) x[i] *= g; return x;
}
