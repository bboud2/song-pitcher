// Ninth review (ported unchanged).
// @ts-nocheck (ported review tooling, kept as written)
// Critic-9 synthesis. Own models, written from scratch:
//  - guitar: stiff-string modal synthesis (inharmonic partials, pluck-position comb, pick-width low-pass,
//    frequency-dependent damping, two polarisations per partial => two-stage decay and beating,
//    attack pitch glide from tension modulation), radiated through a body magnitude response
//    (air + top resonances, low-frequency radiation roll-off), plus body thump and pick/nail click.
//  - voice: harmonic source with spectral tilt through cascade formants evaluated at the moving
//    harmonic frequencies (so vibrato gives real formant AM), jitter/shimmer/drift, scoops, breath noise,
//    consonant onsets, creak.
//  - speech: syllable stream with moving f0 and moving formants, fricatives, stops, fillers.
//  - rooms: stochastic impulse responses (band-dependent decay noise + discrete early reflections + low modes),
//    applied by FFT convolution per event.
export const SR = Number(process.env.SR ?? 48000);
export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const db2a = (d: number) => Math.pow(10, d / 20);
export function rng(seed: number) { let a = (seed * 2654435761) >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

export class BQ {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0; z1 = 0; z2 = 0;
  constructor(type: 'lp' | 'hp' | 'bp' | 'pk', f: number, q: number, gainDb = 0, sr = SR) {
    const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q); let b0, b1, b2, a0, a1, a2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else { const A = Math.pow(10, gainDb / 40); b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  s(x: number) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
  run(x: Float32Array) { const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = this.s(x[i]); return y; }
}

// ------------------------------------------------------------------ guitar
export const OPEN = [40, 45, 50, 55, 59, 64];
export function stringFor(midi: number): { s: number; fret: number } { let s = 0; for (let i = 0; i < 6; i++) if (OPEN[i] <= midi) s = i; return { s, fret: midi - OPEN[s] }; }
export interface GKind {
  /** T60 of the fundamental of an open low string / open high string (s), interpolated by string */
  t60: [number, number];
  /** extra damping with frequency: T60 at partial f = t60 / (1 + (f/fd)^2) */
  fd: number;
  /** inharmonicity B of the low E and of the high E string */
  B: [number, number];
  /** body: radiation high-pass corner (Hz), order (1 or 2), and resonances [Hz, Q, dB] */
  hp: number; hpOrder: number; res: [number, number, number][];
  /** thump level relative to the note (linear), and its modes */
  thump: number;
  /** wound strings (0-3) brightness: spectral slope exponent on partial amplitude */
  slope: number;
  fretLoss: number; // T60 multiplier for fretted notes
}
export const GUITARS: Record<string, GKind> = {
  // full-size steel-string flat-top, newish strings: long sustain
  jumbo: { t60: [11, 5.5], fd: 1600, B: [0.00012, 0.00004], hp: 85, hpOrder: 1, res: [[98, 9, 8], [196, 7, 6], [390, 4, 3], [2600, 2, 3]], thump: 0.25, slope: 1.0, fretLoss: 0.7 },
  // 3/4-size travel guitar: little radiation under 150 Hz => weak fundamentals on the low strings
  travel: { t60: [6.5, 3.5], fd: 1400, B: [0.00016, 0.00005], hp: 165, hpOrder: 2, res: [[128, 8, 5], [245, 6, 7], [520, 4, 4], [3100, 2, 4]], thump: 0.3, slope: 1.05, fretLoss: 0.65 },
  // classical, nylon: darker, shorter, fat fundamentals
  classical: { t60: [5, 3], fd: 900, B: [0.00006, 0.00003], hp: 80, hpOrder: 1, res: [[92, 10, 9], [210, 7, 6], [420, 4, 2]], thump: 0.4, slope: 1.25, fretLoss: 0.7 },
  // year-old corroded strings on a cheap plywood dreadnought: dull, uneven
  rusty: { t60: [4.0, 2.4], fd: 700, B: [0.0002, 0.00007], hp: 110, hpOrder: 2, res: [[112, 6, 6], [230, 5, 5], [900, 3, -4]], thump: 0.35, slope: 1.4, fretLoss: 0.7 },
  // solid-body electric, unplugged: no body air mode, thin, very long sustain, quiet
  solid: { t60: [16, 9], fd: 2200, B: [0.00009, 0.00003], hp: 320, hpOrder: 1, res: [[1800, 2, 6], [3500, 2, 5]], thump: 0.05, slope: 0.85, fretLoss: 0.85 },
  // 12-fret small-body with phosphor strings, bright, strong second partial
  om: { t60: [9, 4.5], fd: 1800, B: [0.00011, 0.00004], hp: 105, hpOrder: 2, res: [[108, 9, 7], [215, 8, 8], [440, 5, 4], [2900, 2, 5]], thump: 0.2, slope: 0.9, fretLoss: 0.75 },
};
export interface GOpts {
  midi: number; cents?: number; kind?: keyof typeof GUITARS | string; string?: number; dur?: number; seed?: number;
  /** pluck style */ pluck?: 'pick' | 'thumb' | 'finger' | 'nail';
  /** 0..1 how hard */ hard?: number;
  /** pluck point as a fraction of the string length from the bridge (default by style) */ pos?: number;
  /** fret buzz amount 0..1 */ buzz?: number;
  /** palm mute: multiplies decay time (e.g. 0.08) */ mute?: number;
}
export const GLEAD = 0.004; // seconds of silence before the pluck in every buffer
export function guitar(o: GOpts): Float32Array {
  const k = GUITARS[o.kind ?? 'jumbo']; const r = rng((o.seed ?? 1) * 7919 + Math.round(o.midi * 13));
  const dur = o.dur ?? 4; const n = Math.round(dur * SR); const y = new Float32Array(n);
  const sf = o.string !== undefined ? { s: o.string, fret: o.midi - OPEN[o.string] } : stringFor(o.midi);
  const f0 = mtof(o.midi + (o.cents ?? 0) / 100);
  const sFrac = sf.s / 5; const hard = o.hard ?? 0.55; const style = o.pluck ?? 'pick';
  let t60 = (k.t60[0] + (k.t60[1] - k.t60[0]) * sFrac) * (sf.fret > 0 ? k.fretLoss * Math.pow(0.985, sf.fret) : 1) * (0.85 + 0.3 * r()); if (o.mute) t60 *= o.mute;
  const B = (k.B[0] * Math.pow(k.B[1] / k.B[0], sFrac)) * Math.pow(2, sf.fret / 6); // shorter vibrating length => more stiffness
  const pos = o.pos ?? (style === 'thumb' ? 0.22 : style === 'finger' ? 0.17 : style === 'nail' ? 0.12 : 0.13) * (0.85 + 0.3 * r());
  // exciter width => low-pass corner
  const fc = (style === 'thumb' ? 1400 : style === 'finger' ? 2200 : style === 'nail' ? 4500 : 5500) * (0.6 + 0.8 * hard);
  const glide = (0.001 + 0.005 * hard * hard) * (sf.s <= 2 ? 1.3 : 0.8); const gtau = 0.07 + 0.05 * r(); // up to ~15 c sharp at the attack
  const bodyMag = (f: number) => { let m = 1; const x = f / k.hp; m *= k.hpOrder === 2 ? (x * x) / Math.sqrt(1 + x * x * x * x) : x / Math.sqrt(1 + x * x); for (const [fr, q, g] of k.res) { const d = (f - fr) / (fr / q); m *= 1 + (db2a(g) - 1) / (1 + d * d * 4); } return m; };
  const lead = Math.round(GLEAD * SR); const twoPi = 2 * Math.PI;
  const maxPart = Math.min(60, Math.floor(Math.min(9000, SR * 0.42) / f0));
  // per-string character: random +-3 dB per partial (fixed by seed) — real strings are uneven
  let norm = 0;
  for (let p = 1; p <= maxPart; p++) {
    const stretch = Math.sqrt(1 + B * p * p); const fp = p * f0 * stretch;
    if (fp > SR * 0.45) break;
    let a = Math.abs(Math.sin(Math.PI * p * pos)) / Math.pow(p, k.slope) / (1 + Math.pow(fp / fc, 2));
    a *= db2a(6 * (r() - 0.5)) * bodyMag(fp);
    if (a < 1e-5) { r(); r(); r(); continue; }
    const T = t60 / (1 + Math.pow(fp / k.fd, 2)); const sig = 6.908 / T;
    // two polarisations: the one coupled to the top decays fast and is loud, the other slow and quieter
    const mix = 0.25 + 0.3 * r(); const det = (0.15 + 0.5 * r()) * (r() < 0.5 ? -1 : 1); const ph1 = twoPi * r(), ph2 = twoPi * r();
    const sig2 = sig * 0.45; const len = Math.min(n - lead, Math.round((9.2 / sig2) * SR));
    norm += a;
    for (let i = 0; i < len; i++) {
      const t = i / SR; const tw = t + glide * gtau * (1 - Math.exp(-t / gtau));
      y[lead + i] += a * ((1 - mix) * Math.exp(-sig * t) * Math.sin(twoPi * fp * tw + ph1) + mix * Math.exp(-sig2 * t) * Math.sin(twoPi * (fp + det) * tw + ph2));
    }
  }
  const sc = 1 / Math.max(norm, 1e-6);
  for (let i = 0; i < n; i++) y[i] *= sc * 2.2;
  // fret buzz: the string slaps the fret while its amplitude is large => bursts of bright partials at the period
  if (o.buzz) { const per = SR / f0; const bz = new BQ('bp', 2800, 0.8); for (let i = 0; i < Math.min(n - lead, 0.5 * SR); i++) { const ph = (i % per) / per; const e = Math.exp(-i / (0.18 * SR)); y[lead + i] += o.buzz * 0.5 * e * bz.s(ph < 0.08 ? gauss(r) : 0); } }
  // attack: pick/nail click (bright noise, few ms) and body thump (air/top modes ringing ~40 ms)
  const click = (style === 'pick' ? 0.5 : style === 'nail' ? 0.35 : style === 'finger' ? 0.1 : 0.06) * (0.4 + hard);
  const cb = new BQ('bp', style === 'pick' ? 3800 : 2400, 0.7);
  for (let i = 0; i < 0.012 * SR; i++) y[lead + i] += click * cb.s(gauss(r)) * Math.exp(-i / (0.0025 * SR));
  const th = k.thump * (0.4 + hard) * (style === 'thumb' ? 1.6 : 1);
  for (const [fr, , g] of k.res.slice(0, 2)) { const tau = 0.035; const ph = twoPi * r(); for (let i = 0; i < 0.25 * SR && lead + i < n; i++) { const t = i / SR; y[lead + i] += th * 0.3 * db2a(g - 6) * Math.exp(-t / tau) * Math.sin(twoPi * fr * t + ph) * Math.min(1, t / 0.002); } }
  // smooth start of the string tone over ~1 ms (finite release of the string)
  for (let i = 0; i < 0.0012 * SR; i++) y[lead + i] *= i / (0.0012 * SR);
  for (let i = 0; i < 0.03 * SR; i++) y[n - 1 - i] *= i / (0.03 * SR);
  return y;
}

// ------------------------------------------------------------------ voice
const VOW: Record<string, [number, number][]> = {
  a: [[730, 90], [1090, 110], [2440, 170], [3400, 250]],
  i: [[280, 60], [2250, 120], [2950, 200], [3600, 250]],
  u: [[310, 70], [870, 100], [2240, 170], [3300, 250]],
  o: [[500, 80], [880, 100], [2500, 170], [3400, 250]],
  e: [[530, 70], [1840, 120], [2480, 180], [3500, 250]],
  er: [[490, 80], [1350, 110], [1690, 150], [3300, 250]],
  m: [[250, 60], [1100, 300], [2200, 400], [3300, 500]],
};
function formantMag(f: number, F: [number, number][], nasal: number): number { let m = 1; for (const [fr, bw] of F) { const d = (fr * fr - f * f); m *= (fr * fr) / Math.sqrt(d * d + bw * bw * f * f); } if (nasal) m *= 1 / (1 + Math.pow(f / 600, 2) * nasal * 6); return m; }
export interface VOpts {
  midi: number; cents?: number; dur: number; seed?: number; vowel?: string; tract?: number; /** vocal-tract scale: 1 man, 1.17 woman, 1.35 child */
  tilt?: number; /** extra source tilt dB/oct (breathy = more) */ vib?: number; /** vibrato +-cents */ vibHz?: number;
  drift?: number; /** slow random pitch wander, cents */ scoop?: number; /** start this many cents off and slide in */ scoopMs?: number;
  breath?: number; atkMs?: number; relMs?: number; cons?: 'l' | 'n' | 'd' | 't' | 'h' | '';
  creak?: number; /** seconds of creaky (period-doubled) onset */ fall?: number; /** cents the pitch sags over the note */
  jitter?: number;
}
export const VLEAD = 0.01;
/** general harmonic voice engine: f0(t) in Hz, formants(t), amplitude(t) (0..1); returns buffer */
function voiceEngine(n: number, f0: (t: number) => number, form: (t: number) => { F: [number, number][]; nasal: number }, amp: (t: number) => number, o: { tilt: number; breath: number; jitter: number; seed: number; sub?: (t: number) => number }): Float32Array {
  const y = new Float32Array(n); const r = rng(o.seed); const BL = Math.round(0.004 * SR);
  let phase = 0; let jit = 0; let shim = 1; const nz = new BQ('bp', 2500, 0.6); const nz2 = new BQ('hp', 900, 0.7);
  let prevA: Float32Array | null = null; let curA = new Float32Array(80); let prevSub = 0;
  for (let b0 = 0; b0 < n; b0 += BL) {
    const t = b0 / SR; const f = f0(t); const fm = form(t); const A = amp(t);
    jit += 0.3 * (gauss(r) * o.jitter - jit); shim += 0.2 * (1 + 0.04 * gauss(r) - shim);
    const fj = f * (1 + jit); const H = Math.min(79, Math.floor(Math.min(6500, SR * 0.4) / fj));
    const nextA = new Float32Array(80);
    for (let h = 1; h <= H; h++) { const fh = h * fj; nextA[h] = A * shim * Math.pow(h, -(1 + o.tilt / 6)) * formantMag(fh, fm.F, fm.nasal) * (1 / (1 + Math.pow(fh / 5000, 4))); }
    if (!prevA) prevA = nextA; curA = nextA;
    const sub = o.sub ? o.sub(t) : 0;
    const dphi = 2 * Math.PI * fj / SR; const end = Math.min(n, b0 + BL);
    for (let i = b0; i < end; i++) {
      const w = (i - b0) / BL; phase += dphi; let s = 0;
      for (let h = 1; h <= H; h++) { const a = prevA[h] + (curA[h] - prevA[h]) * w; if (a > 1e-7) s += a * Math.sin(h * phase); }
      const sb = prevSub + (sub - prevSub) * w;
      if (sb > 0) { // creak: period doubling => amplitude modulation at f0/2
        s *= 1 - sb * 0.5 * (1 + Math.sin(phase / 2));
      }
      if (o.breath) { const g = 0.6 + 0.4 * Math.sin(phase); s += o.breath * A * 0.5 * g * nz2.s(nz.s(gauss(r))); }
      y[i] = s;
    }
    prevA = curA; prevSub = sub;
    if (phase > 1e6) phase -= 2 * Math.PI * Math.floor(phase / (2 * Math.PI) / 2) * 2;
  }
  return y;
}
const scaleF = (F: [number, number][], k: number): [number, number][] => F.map(([f, b]) => [f * k, b * k]);
export function voice(o: VOpts): Float32Array {
  const lead = Math.round(VLEAD * SR); const rel = (o.relMs ?? 90) / 1000; const n = Math.round((o.dur + rel) * SR) + lead; const r = rng((o.seed ?? 1) * 104729 + Math.round(o.midi * 7));
  const tract = o.tract ?? 1; const vow = o.vowel ?? 'a'; const F = scaleF(VOW[vow], tract); const Fm = scaleF(VOW.m, tract);
  const base = o.midi + (o.cents ?? 0) / 100; const vib = o.vib ?? 12; const vibHz = o.vibHz ?? 5.3; const atk = (o.atkMs ?? 60) / 1000;
  // slow drift: sum of two slow sines with random phase
  const d1 = 2 * Math.PI * r(), d2 = 2 * Math.PI * r(), dr = o.drift ?? 8; const scoop = o.scoop ?? 0; const sms = (o.scoopMs ?? 180) / 1000;
  const consMs = o.cons === 'l' || o.cons === 'n' ? 0.07 : 0; const vibPh = 2 * Math.PI * r();
  const f0 = (t: number) => { const vd = Math.min(1, Math.max(0, (t - 0.25) / 0.3)); const c = vib * vd * Math.sin(2 * Math.PI * vibHz * t + vibPh) + dr * (0.6 * Math.sin(2 * Math.PI * 0.7 * t + d1) + 0.4 * Math.sin(2 * Math.PI * 1.9 * t + d2)) - scoop * Math.exp(-t / (sms / 2.5)) - (o.fall ?? 0) * Math.max(0, t / o.dur); return mtof(base + c / 100); };
  const form = (t: number) => { if (vow === 'm') return { F: Fm, nasal: 1 }; if (t < consMs) return { F: Fm, nasal: 0.8 }; if (t < consMs + 0.03) { const w = (t - consMs) / 0.03; return { F: F.map(([f, b], i) => [Fm[i][0] + (f - Fm[i][0]) * w, b] as [number, number]), nasal: 0.8 * (1 - w) }; } return { F, nasal: 0 }; };
  const amp = (t: number) => { let a = Math.min(1, t / atk); if (t < consMs) a *= 0.5; if (t > o.dur) a *= Math.max(0, 1 - (t - o.dur) / rel); if (o.cons === 'd' || o.cons === 't') a *= t < 0.015 ? 0 : 1; return a; };
  const body = voiceEngine(n - lead, f0, form, amp, { tilt: o.tilt ?? 0, breath: o.breath ?? 0.02, jitter: o.jitter ?? 0.004, seed: (o.seed ?? 1) + 5, sub: o.creak ? (t) => (t < o.creak! ? 1 : Math.max(0, 1 - (t - o.creak!) / 0.05)) : undefined });
  const y = new Float32Array(n); let pk = 0; for (let i = 0; i < body.length; i++) pk = Math.max(pk, Math.abs(body[i]));
  for (let i = 0; i < body.length; i++) y[lead + i] = body[i] / (pk + 1e-9);
  if (o.cons === 'd' || o.cons === 't' || o.cons === 'h') { const bp = new BQ('bp', o.cons === 'h' ? 1500 : 3500, 0.7); const L = (o.cons === 'h' ? 0.08 : o.cons === 't' ? 0.03 : 0.012) * SR; for (let i = 0; i < L; i++) y[lead + i] += 0.25 * bp.s(gauss(r)) * Math.sin(Math.PI * i / L); }
  return y;
}

/** speech-like stream: syllables with moving pitch and formants, fricatives/stops, pauses, fillers. Peak ~1. */
export function speech(dur: number, seed: number, o: { female?: boolean; fillers?: number; monotone?: number } = {}): Float32Array {
  const r = rng(seed * 31 + 9); const n = Math.round(dur * SR); const y = new Float32Array(n); const tract = o.female ? 1.17 : 1; const mean = o.female ? 57 : 45; // A3 / A2
  const vs = ['a', 'i', 'u', 'o', 'e', 'er']; let t = 0.1 + 0.3 * r(); let phrasePos = 0; let phraseLen = 4 + Math.floor(7 * r());
  const place = (buf: Float32Array, at: number, g: number) => { const s = Math.round(at * SR); for (let i = 0; i < buf.length && s + i < n; i++) y[s + i] += g * buf[i]; };
  while (t < dur - 0.5) {
    const filler = r() < (o.fillers ?? 0.06); const sd = filler ? 0.45 + 0.5 * r() : 0.09 + 0.16 * r();
    const decl = -3 * (phrasePos / phraseLen); const acc = r() < 0.3 ? 2 + 4 * r() : 0; const p0 = mean + decl + (r() - 0.5) * 4 * (o.monotone ? 1 - o.monotone : 1) + acc; const p1 = filler ? p0 - 0.3 + 0.4 * r() : p0 + (r() - 0.6) * 5 * (o.monotone ? 1 - o.monotone : 1);
    const va = scaleF(VOW[vs[Math.floor(r() * vs.length)]], tract), vb = filler ? va : scaleF(VOW[vs[Math.floor(r() * vs.length)]], tract);
    // consonant
    const ct = r();
    if (ct < 0.3) { const L = Math.round((0.05 + 0.07 * r()) * SR); const bp = new BQ('bp', 3500 + 3500 * r(), 1.2); const c = new Float32Array(L); for (let i = 0; i < L; i++) c[i] = bp.s(gauss(r)) * Math.sin(Math.PI * i / L); place(c, t, 0.12 + 0.1 * r()); t += L / SR; }
    else if (ct < 0.55) { t += 0.03 + 0.04 * r(); const L = Math.round(0.012 * SR); const bp = new BQ('bp', 1500 + 3000 * r(), 0.8); const c = new Float32Array(L); for (let i = 0; i < L; i++) c[i] = bp.s(gauss(r)) * Math.exp(-i / (0.004 * SR)); place(c, t, 0.3); }
    const m = Math.round(sd * SR); const loud = 0.5 + 0.5 * r();
    const sy = voiceEngine(m, (tt) => mtof(p0 + (p1 - p0) * (tt / sd)), (tt) => { const w = Math.min(1, tt / (sd * 0.7)); return { F: va.map(([f, b], i) => [f + (vb[i][0] - f) * w, b] as [number, number]), nasal: 0 }; }, (tt) => Math.min(1, tt / 0.02) * Math.min(1, (sd - tt) / 0.03), { tilt: 1, breath: 0.03, jitter: 0.008, seed: seed * 1000 + Math.round(t * 100) });
    let pk = 0; for (let i = 0; i < m; i++) pk = Math.max(pk, Math.abs(sy[i])); place(sy, t, loud / (pk + 1e-9)); t += sd;
    phrasePos++; if (phrasePos >= phraseLen) { t += 0.3 + 0.7 * r(); phrasePos = 0; phraseLen = 4 + Math.floor(7 * r()); } else t += 0.01 + 0.05 * r();
  }
  return y;
}
/** small-speaker band-limit (TV / laptop) */
export function smallSpeaker(x: Float32Array): Float32Array { return new BQ('lp', 6000, 0.7).run(new BQ('hp', 220, 0.8).run(new BQ('hp', 180, 0.7).run(x))); }
/** music bed: slow pad chords + plucked synth melody, for a TV programme with music */
export function musicBed(dur: number, seed: number): Float32Array {
  const r = rng(seed * 77 + 1); const n = Math.round(dur * SR); const y = new Float32Array(n); const chords = [[48, 55, 64], [53, 57, 60], [55, 59, 62], [45, 52, 60]]; let t = 0;
  while (t < dur) { const ch = chords[Math.floor(r() * 4)]; const L = 2.2; for (const m of ch) { const f = mtof(m); const ph = 6.28 * r(); for (let i = Math.round(t * SR); i < Math.min(n, (t + L) * SR); i++) { const tt = i / SR - t; const e = Math.min(1, tt / 0.3) * Math.min(1, (L - tt) / 0.3); y[i] += 0.12 * e * (Math.sin(6.2832 * f * tt + ph) + 0.4 * Math.sin(6.2832 * 2.003 * f * tt) + 0.2 * Math.sin(6.2832 * 3 * f * tt)); } }
    for (let k = 0; k < 4; k++) { const m = 60 + [0, 2, 4, 5, 7, 9, 11, 12][Math.floor(r() * 8)]; const f = mtof(m); const s = t + k * L / 4; for (let i = Math.round(s * SR); i < Math.min(n, (s + 0.5) * SR); i++) { const tt = i / SR - s; y[i] += 0.25 * Math.exp(-tt / 0.15) * (Math.sin(6.2832 * f * tt) + 0.5 * Math.sin(6.2832 * 2 * f * tt)); } } t += L; }
  return y;
}
/** the app's reference tone (same harmonic recipe and envelope as scheduleTone) */
export function refTone(midi: number, dur: number): Float32Array {
  const f = mtof(midi); const rel = 0.3; const n = Math.round((dur + rel + 0.05) * SR); const y = new Float32Array(n); const hs = [1, 0.42, 0.22, 0.12, 0.07, 0.04, 0.025, 0.015]; const fc = Math.min(6000, f * 9);
  for (let i = 0; i < n; i++) { const t = i / SR; let e: number; if (t < 0.015) e = 0.34 * t / 0.015; else if (t < 0.18) e = 0.34 * Math.pow(0.22 / 0.34, (t - 0.015) / 0.165); else if (t < Math.max(0.19, dur - 0.05)) e = 0.22; else e = 0.22 * Math.pow(0.0001 / 0.22, Math.min(1, (t - Math.max(0.19, dur - 0.05)) / (rel + 0.05))); let s = 0; for (let h = 0; h < hs.length; h++) s += hs[h] / Math.sqrt(1 + Math.pow((h + 1) * f / fc, 2) / 0.16 * 0.16) * Math.sin(6.2832 * (h + 1) * f * t); y[i] = e * s / 0.34; }
  return y;
}
/** household transients: 'knock' (table), 'door', 'cough', 'chair' (scrape), 'clap', 'keys' */
export function noiseEvent(kind: string, seed: number): Float32Array {
  const r = rng(seed * 13 + 3); const n = Math.round(0.7 * SR); const y = new Float32Array(n);
  if (kind === 'knock' || kind === 'door') { const fs = kind === 'knock' ? [95 + 60 * r(), 210 + 100 * r(), 480 + 200 * r()] : [55 + 20 * r(), 120 + 40 * r(), 260]; fs.forEach((f, k) => { for (let i = 0; i < n; i++) { const t = i / SR; y[i] += [1, 0.5, 0.3][k] * Math.exp(-t / (kind === 'knock' ? 0.05 : 0.12) * (1 + k)) * Math.sin(6.2832 * f * t); } }); const bp = new BQ('bp', 2500, 0.6); for (let i = 0; i < 0.01 * SR; i++) y[i] += 0.6 * bp.s(gauss(r)) * Math.exp(-i / (0.002 * SR)); }
  else if (kind === 'clap' || kind === 'keys') { const bp = new BQ('bp', kind === 'clap' ? 1800 : 6000, kind === 'clap' ? 0.8 : 2); for (let i = 0; i < n; i++) { const t = i / SR; y[i] = bp.s(gauss(r)) * (kind === 'clap' ? Math.exp(-t / 0.02) : Math.exp(-((t * 9) % 1) / 0.15) * Math.exp(-t / 0.3)); } }
  else if (kind === 'cough') { const F = VOW.er; for (let i = 0; i < n; i++) { const t = i / SR; y[i] = gauss(r) * (Math.exp(-t / 0.06) + 0.5 * Math.exp(-Math.pow((t - 0.25) / 0.05, 2))); } let z = y; for (const [f, b] of F.slice(0, 3)) { const q = new BQ('pk', f, f / b / 2, 12); z = q.run(z); } const lp = new BQ('lp', 4000, 0.7); const o = lp.run(z); let pk = 0; for (const v of o) pk = Math.max(pk, Math.abs(v)); for (let i = 0; i < n; i++) y[i] = o[i] / pk; }
  else { const bp = new BQ('bp', 700 + 600 * r(), 3); for (let i = 0; i < n; i++) { const t = i / SR; y[i] = bp.s(gauss(r)) * 3 * Math.min(1, t / 0.05) * Math.min(1, (0.7 - t) / 0.1) * (0.6 + 0.4 * Math.sin(6.2832 * 23 * t)); } }
  return y;
}

// ------------------------------------------------------------------ FFT + rooms
function fft(re: Float64Array, im: Float64Array, inv: boolean) { const n = re.length; for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = (inv ? -2 : 2) * Math.PI / len; const wr = Math.cos(ang), wi = Math.sin(ang); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const ur = re[i + k], ui = im[i + k]; const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr; re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; } }
export function convolve(x: Float32Array, h: Float32Array): Float32Array { const L = x.length + h.length; let n = 1; while (n < L) n <<= 1; const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n); ar.set(x); br.set(h); fft(ar, ai, false); fft(br, bi, false); for (let i = 0; i < n; i++) { const r = ar[i] * br[i] - ai[i] * bi[i]; ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = r; } fft(ar, ai, true); const y = new Float32Array(L); for (let i = 0; i < L; i++) y[i] = ar[i]; return y; }
export interface RoomSpec { /** RT60 at low / mid / high (s) */ rt: [number, number, number]; /** direct-to-reverberant: reverb level relative to direct (linear) */ wet: number; /** early reflections [ms, gain] */ early: [number, number][]; /** room modes [Hz, T60 s, gain] */ modes?: [number, number, number][]; }
export const ROOMS: Record<string, RoomSpec | null> = {
  none: null,
  // small study, shelves and a rug, phone on the desk 40 cm from the guitar (desk bounce at 0.7 ms)
  study: { rt: [0.45, 0.32, 0.22], wet: 0.18, early: [[0.7, 0.6], [3.3, 0.3], [6.8, 0.25], [12.4, 0.2]], modes: [[43, 0.5, 0.02], [61, 0.45, 0.02]] },
  // open-plan lounge, hard floor, phone on the sofa arm 1 m away
  lounge: { rt: [0.9, 0.7, 0.45], wet: 0.4, early: [[2.1, 0.45], [5.9, 0.4], [10.3, 0.35], [19.1, 0.3], [27.7, 0.2]], modes: [[37, 0.9, 0.03], [52, 0.8, 0.03], [74, 0.7, 0.02]] },
  // bare concrete garage: long low-frequency decay, 1.5 m
  garage: { rt: [2.2, 1.4, 0.7], wet: 0.8, early: [[3.0, 0.6], [4.6, 0.55], [8.2, 0.5], [13.9, 0.45], [22.0, 0.4]], modes: [[58, 1.6, 0.06], [87, 1.4, 0.05], [116, 1.2, 0.05], [143, 1.1, 0.04]] },
  // tiled shower room: very live, bright, strong modes in the guitar's low range
  shower: { rt: [1.3, 1.6, 1.2], wet: 1.0, early: [[1.9, 0.7], [3.1, 0.65], [5.2, 0.6], [7.7, 0.5], [11.0, 0.45]], modes: [[96, 1.3, 0.08], [124, 1.3, 0.07], [171, 1.2, 0.07], [205, 1.1, 0.05]] },
  // bedroom, phone lying on the duvet (absorbent, almost no early reflections), 60 cm
  duvet: { rt: [0.3, 0.22, 0.15], wet: 0.08, early: [[4.4, 0.15], [9.0, 0.12]] },
};
const irCache = new Map<string, Float32Array>();
export function roomIR(name: string, variant: number): Float32Array | null {
  const spec = ROOMS[name]; if (!spec) return null; const key = name + variant + ':' + SR; const c = irCache.get(key); if (c) return c;
  const r = rng(name.length * 1000 + name.charCodeAt(0) + variant * 17); const L = Math.round(Math.max(...spec.rt) * 1.1 * SR); const h = new Float32Array(L);
  // three bands of decaying noise
  const bands: [BQ[], number][] = [[[new BQ('lp', 300, 0.7), new BQ('lp', 300, 0.7)], spec.rt[0]], [[new BQ('hp', 300, 0.7), new BQ('lp', 2500, 0.7)], spec.rt[1]], [[new BQ('hp', 2500, 0.7), new BQ('hp', 2500, 0.7)], spec.rt[2]]];
  const start = Math.round(0.012 * SR);
  for (const [fs, rt] of bands) { for (let i = start; i < L; i++) { let v = gauss(r); for (const f of fs) v = f.s(v); const t = (i - start) / SR; h[i] += v * Math.exp(-6.908 * t / rt) * Math.min(1, t / 0.01 + 0.2); } }
  let e = 0; for (let i = 0; i < L; i++) e += h[i] * h[i]; const sc = spec.wet / Math.sqrt(e);
  for (let i = 0; i < L; i++) h[i] *= sc;
  h[0] += 1;
  for (const [ms, g] of spec.early) { const d = Math.round((ms * (0.9 + 0.2 * r())) / 1000 * SR); h[d] += g * (r() < 0.3 ? -1 : 1); }
  for (const [f, t60, g] of spec.modes ?? []) { const ph = 6.28 * r(); const mc = g * 20 / ((t60 / 6.908) * SR); for (let i = 0; i < L; i++) { const t = i / SR; h[i] += mc * Math.exp(-6.908 * t / t60) * Math.sin(6.2832 * f * t + ph); } }
  irCache.set(key, h); return h;
}
