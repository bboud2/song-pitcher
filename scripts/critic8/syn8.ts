// Eighth review (ported unchanged).
// Critic-8 synthesis (own). Methods:
//  guitar: modal (additive) string — stiff-string partials, pluck-point spectrum, finger-width roll-off, two polarisations
//          (beating + two-stage decay), tension glide, freq-dependent loss, body-mode filter + independent body "thump",
//          pick click / finger rub noise, optional fret buzz (hard-limit against the fret), string squeak, dead strings.
//  voice : Rosenberg glottal pulse train (jitter, shimmer, drift, scoop, vibrato, optional creaky onset with period doubling),
//          cascade formant resonators with consonant-vowel transitions, aspiration noise.
//  room  : streaming 8-line feedback delay network + early taps (in rig8).
export let SR = Number(process.env.SR ?? 48000);
export const db2a = (d: number) => Math.pow(10, d / 20);
export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export function rng(seed: number) { let s = (seed * 2654435761) >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
export function gauss(r: () => number) { return Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r()); }
export class BQ { b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0; x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  constructor(type: 'lp' | 'hp' | 'bp' | 'pk', f: number, q: number, gainDb = 0) { const w = 2 * Math.PI * Math.min(f, SR * 0.45) / SR, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q); let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; } else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; } else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; } else { const A = Math.pow(10, gainDb / 40); b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; }
  s(x: number) { const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2; this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y; } }
export function norm(x: Float32Array, peak = 1) { let m = 0; for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i])); if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m; return x; }

export const OPEN = [40, 45, 50, 55, 59, 64];
export function stringFor(midi: number) { let s = 0; for (let i = 0; i < 6; i++) if (OPEN[i] <= midi) s = i; return { s, fret: midi - OPEN[s] }; }
export type GKind = 'dread' | 'nylon' | 'parlor' | 'dead' | 'electric';
export interface GOpts { midi: number; cents?: number; dur?: number; seed?: number; string?: number; kind?: GKind; pluck?: 'pick' | 'finger' | 'thumb' | 'nail'; hard?: number; buzz?: number; squeak?: boolean; thump?: number; }
const KIND = {
  //        B per string (open)                         T60 fund per string             hfLoss  body modes [f,q,g]                                             bodyMix thump
  dread:  { B: [8e-5, 6e-5, 9e-5, 2.0e-4, 1.2e-4, 6e-5], t60: [8, 7.5, 6.5, 5, 4, 3.2], hf: 1.0, body: [[102, 12, 1.2], [198, 18, 1.0], [245, 22, 0.5], [390, 25, 0.6], [520, 25, 0.4]], mix: 1.0, thump: 0.35 },
  nylon:  { B: [3.5e-5, 3e-5, 4.5e-5, 6e-5, 4e-5, 2.8e-5], t60: [5.5, 5, 4.2, 3.0, 2.4, 2.0], hf: 2.6, body: [[92, 10, 1.4], [185, 16, 1.2], [230, 20, 0.5], [410, 22, 0.5]], mix: 1.1, thump: 0.5 },
  parlor: { B: [9e-5, 7e-5, 1.0e-4, 2.3e-4, 1.3e-4, 7e-5], t60: [6, 5.5, 5, 4, 3.2, 2.6], hf: 1.3, body: [[128, 10, 0.9], [236, 16, 1.3], [300, 18, 0.7], [470, 22, 0.7], [640, 22, 0.5]], mix: 1.0, thump: 0.3 },
  dead:   { B: [1.4e-4, 1.1e-4, 1.5e-4, 3e-4, 1.6e-4, 8e-5], t60: [3.5, 3.2, 3, 3.2, 2.8, 2.4], hf: 5.5, body: [[108, 9, 1.2], [205, 12, 1.0], [260, 15, 0.6], [400, 18, 0.5]], mix: 1.0, thump: 0.45 },
  electric: { B: [6e-5, 5e-5, 7e-5, 3e-5, 2e-5, 1.5e-5], t60: [11, 10, 9, 8, 7, 6], hf: 0.7, body: [[310, 6, 0.25], [780, 5, 0.3]], mix: 0.25, thump: 0.05 },
} as const;
/** returns dry radiated note, peak 1 */
export function guitar(o: GOpts): Float32Array {
  const kind = KIND[o.kind ?? 'dread']; const r = rng((o.seed ?? 1) * 7717 + o.midi * 97 + 3); const st = o.string ?? stringFor(o.midi).s; const fret = o.midi - OPEN[st];
  const dur = o.dur ?? 3; const n = Math.round(dur * SR); const pl = o.pluck ?? 'pick'; const hard = o.hard ?? 0.5;
  const f0 = mtof(o.midi + (o.cents ?? 0) / 100); const B = kind.B[st] * Math.pow(2, fret / 6) * (0.85 + 0.3 * r());
  const SUS = Number(process.env.SUS ?? 1); const t60 = SUS * kind.t60[st] * (fret > 0 ? 0.6 : 1) * (0.8 + 0.4 * r()); const s0 = 6.91 / t60; const hf = kind.hf / SUS * (fret > 0 ? 1.5 : 1) * (0.8 + 0.4 * r());
  const pos = 0.09 + 0.16 * r(); // pluck point from the bridge
  const width = { pick: 0.0012, nail: 0.003, finger: 0.011, thumb: 0.017 }[pl] / (0.648 * Math.pow(2, -fret / 12)); // contact width / string length
  const tAtk = { pick: 0.0008, nail: 0.002, finger: 0.006, thumb: 0.009 }[pl]; const lead = 0.01 + { pick: 0.004, nail: 0.006, finger: 0.02, thumb: 0.03 }[pl];
  const glide = (0.0015 + 0.012 * hard * hard) * (o.kind === 'nylon' ? 1.6 : 1); const gTau = 0.12 + 0.1 * r(); // tension glide (fraction of f0), decays with the amplitude
  const det = (1 + 4 * r()) * (r() < 0.5 ? -1 : 1) / 1200 * Math.LN2; const beat = 0.25 + 0.35 * r();
  const x = new Float32Array(n); const K = Math.min(60, Math.floor(0.42 * SR / f0)); const n0 = Math.round(lead * SR);
  // glide phase warp: phase_k(t) = 2π f_k ( t + glide*gTau*(1-exp(-t/gTau)) )
  const warp = new Float64Array(n - n0); for (let i = 0; i < warp.length; i++) { const t = i / SR; warp[i] = t + glide * gTau * (1 - Math.exp(-t / gTau)); }
  for (let k = 1; k <= K; k++) {
    const fk = k * f0 * Math.sqrt(1 + B * k * k); if (fk > 0.45 * SR) break;
    let a = Math.sin(k * Math.PI * pos) / k; const wq = k * Math.PI * width; a *= wq > 1e-6 ? Math.sin(wq) / wq : 1; a *= 1 / (1 + Math.pow(fk / (2500 + 9000 * hard), 2)); a *= (0.8 + 0.4 * r());
    if (Math.abs(a) < 1e-5) continue;
    const sig = s0 + hf * 2.2e-6 * fk * fk + 0.02 * hf * Math.sqrt(fk); const sig2 = sig * 0.5; const w = 2 * Math.PI * fk; const ph1 = 2 * Math.PI * r() * 0.15, ph2 = 2 * Math.PI * r();
    const w2 = w * (1 + det); const d1 = Math.exp(-sig / SR), d2 = Math.exp(-sig2 / SR); let e1 = a, e2 = a * beat;
    for (let i = 0; i < warp.length; i++) { const t = warp[i]; x[n0 + i] += e1 * Math.sin(w * t + ph1) + e2 * Math.sin(w2 * t + ph2); e1 *= d1; e2 *= d2; if (e1 + e2 < 1e-6) break; }
  }
  // finite attack (the string leaves the pick/finger over tAtk)
  const na = Math.max(1, Math.round(tAtk * SR)); for (let i = 0; i < na && n0 + i < n; i++) x[n0 + i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / na);
  // fret buzz: the string hits the next fret while its amplitude is large — clip asymmetrically for the first part of the note
  if (o.buzz) { let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(x[i])); const lim = m * (1 - 0.75 * o.buzz); for (let i = 0; i < n; i++) if (x[i] > lim) x[i] = lim + 0.15 * (x[i] - lim) + 0.03 * m * gauss(r) * (x[i] - lim) / m; }
  // radiation: differentiate, body modes
  const body = kind.body.map(([f, q, g]) => ({ bq: new BQ('bp', f * (0.95 + 0.1 * r()), q), g: g * (0.7 + 0.6 * r()) })); const hp = new BQ('hp', 70, 0.7); const y = new Float32Array(n); let prev = 0;
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(x[i]));
  // excitation transients: pick click (band noise 2–6 kHz, ~4 ms) or finger rub (low-passed noise ~25 ms before release), body thump (impulse into body modes)
  const clickBP = new BQ('bp', pl === 'pick' ? 3800 : 1500, 1.2); const thumpAmt = (o.thump ?? 1) * kind.thump * (0.5 + hard) * pk * 14;
  for (let i = 0; i < n; i++) {
    let v = x[i]; const tt = (i - n0) / SR;
    if (pl === 'pick' || pl === 'nail') { if (tt > -0.003 && tt < 0.004) v += pk * 0.25 * hard * clickBP.s(gauss(r)); } else if (tt > -lead + 0.004 && tt < 0.002) v += pk * 0.05 * clickBP.s(gauss(r));
    const d = (v - prev) * 5 + 0.1 * v; prev = v; let out = kind.mix * 0.5 * d + (1 - kind.mix) * d * 0.5; const drive = d + (i === n0 ? thumpAmt : 0);
    for (const b of body) out += kind.mix * b.g * 2.0 * b.bq.s(drive);
    y[i] = hp.s(out);
  }
  if (o.squeak) { const q = new BQ('bp', 2600 + 1500 * r(), 6); const ns = Math.round(0.09 * SR); for (let i = 0; i < ns && i < n0 + ns; i++) { const idx = Math.max(0, n0 - ns - Math.round(0.03 * SR)) + i; if (idx < n) y[idx] += 0.18 * q.s(gauss(r)) * Math.sin(Math.PI * i / ns) * (1 + 0.5 * Math.sin(2 * Math.PI * 90 * i / SR)); } }
  return norm(y);
}
export const GLEAD = (pl?: string) => 0.01 + ({ pick: 0.004, nail: 0.006, finger: 0.02, thumb: 0.03 } as any)[pl ?? 'pick'];

const VOW: Record<string, [number, number][]> = { // [freq, bandwidth]
  a: [[730, 90], [1090, 110], [2440, 170], [3400, 250], [4500, 300]], e: [[530, 70], [1840, 100], [2480, 160], [3500, 250], [4500, 300]], i: [[290, 60], [2250, 100], [2900, 160], [3600, 250], [4500, 300]],
  o: [[500, 80], [870, 100], [2400, 170], [3350, 250], [4500, 300]], u: [[320, 70], [800, 100], [2240, 170], [3300, 250], [4500, 300]], m: [[250, 60], [1050, 300], [2300, 400], [3300, 400], [4500, 400]],
};
export interface VOpts { midi: number; dur: number; seed?: number; vowel?: string; cons?: 'l' | 'n' | 'd' | 'h' | null; tract?: number; /** formant scale: 1 male, 1.17 female, 1.35 child */
  oq?: number; tilt?: number; /** extra spectral tilt dB/oct (falsetto ~ 9) */ breath?: number; vib?: number; vibHz?: number; scoop?: number; /** cents below at onset */ scoopMs?: number;
  drift?: number; creak?: number; /** seconds of period-doubled onset */ cents?: number; atkMs?: number; fall?: number; /** cents the pitch sags over the note */ }
export const VLEAD = 0.03;
export function voice(o: VOpts): Float32Array {
  const r = rng((o.seed ?? 1) * 4099 + o.midi * 31 + 11); const n = Math.round((o.dur + 0.25) * SR); const src = new Float32Array(n);
  const oq = o.oq ?? 0.6; const al = 0.66; const f0c = mtof(o.midi + (o.cents ?? 0) / 100); const atk = (o.atkMs ?? 60) / 1000; const n0 = Math.round(VLEAD * SR);
  let ph = 0; let jit = 0; let shim = 1; let cyc = 0; let dr = 0; const drift = o.drift ?? 8; const lpDr = Math.exp(-1 / (0.35 * SR)); const scoopT = (o.scoopMs ?? 120) / 1000;
  const aspBP = new BQ('bp', 2500, 0.6); const tilt = o.tilt ?? 0; const tl = new BQ('lp', Math.max(300, 4000 / Math.pow(2, tilt / 3)), 0.6); const tl2 = new BQ('lp', Math.max(400, 2.2 * f0c), 0.7);
  let prevFlow = 0;
  for (let i = n0; i < n; i++) {
    const t = (i - n0) / SR; dr = dr * lpDr + (1 - lpDr) * gauss(r) * 30; // slow wander
    let c = dr * drift / 8 - (o.scoop ?? 0) * Math.exp(-t / (scoopT / 3)) - (o.fall ?? 0) * t / o.dur;
    if (o.vib) c += o.vib * Math.sin(2 * Math.PI * (o.vibHz ?? 5.5) * t) * Math.min(1, Math.max(0, (t - 0.25) / 0.3));
    const f = f0c * Math.pow(2, c / 1200) * (1 + jit); const creak = o.creak && t < o.creak;
    ph += (creak ? f : f) / SR; if (ph >= 1) { ph -= 1; cyc++; jit = 0.006 * gauss(r); shim = 1 + 0.04 * gauss(r); if (creak) shim *= cyc % 2 ? 1 : 0.35 + 0.2 * r(); }
    let flow = 0; if (ph < al * oq) flow = 0.5 * (1 - Math.cos(Math.PI * ph / (al * oq))); else if (ph < oq) flow = Math.cos(0.5 * Math.PI * (ph - al * oq) / ((1 - al) * oq));
    flow *= shim; let d = (flow - prevFlow) * SR / f0c * 0.25; prevFlow = flow;
    if (tilt > 0) { d = tl.s(d); if (tilt > 6) d = tl2.s(d); }
    const env = Math.min(1, t / atk) * Math.min(1, Math.max(0, (o.dur - t) / 0.09));
    const asp = (o.breath ?? 0.03) * aspBP.s(gauss(r)) * (0.4 + flow);
    src[i] = (d + asp) * env;
  }
  // vocal tract: cascade formants; consonant = formant targets + amplitude dip for the first ~70 ms
  const sc = o.tract ?? 1; const V = VOW[o.vowel ?? 'a']; const C = o.cons === 'l' ? [[360, 80], [1300, 150], [2700, 200], [3400, 250], [4500, 300]] : o.cons === 'n' || o.cons === 'd' ? [[280, 60], [1700, 250], [2600, 300], [3400, 300], [4500, 300]] : null;
  const out = new Float32Array(n); const st = V.map(() => [0, 0]); const cT = 0.07;
  for (let i = 0; i < n; i++) {
    const t = (i - n0) / SR; let v = src[i]; const mixC = C && t < cT + 0.04 ? Math.max(0, Math.min(1, (cT + 0.04 - t) / 0.04)) : 0;
    if (o.cons === 'h' && t < 0.08) v = v * (t / 0.08) + 0.12 * gauss(r) * Math.sin(Math.PI * Math.max(0, t) / 0.08);
    if (o.cons === 'd' && t < 0.03) v *= 0.05; else if (C && t < cT) v *= o.cons === 'l' ? 0.55 : 0.4;
    for (let k = 0; k < V.length; k++) {
      const F = (C ? V[k][0] + (C[k][0] - V[k][0]) * mixC : V[k][0]) * sc, Bw = (C ? V[k][1] + (C[k][1] - V[k][1]) * mixC : V[k][1]);
      const rr = Math.exp(-Math.PI * Bw / SR); const a1 = 2 * rr * Math.cos(2 * Math.PI * F / SR), a2 = -rr * rr; const g = 1 - a1 - a2; const y = g * v + a1 * st[k][0] + a2 * st[k][1]; st[k][1] = st[k][0]; st[k][0] = y; v = y;
    }
    out[i] = v;
  }
  if (o.vowel === 'm') { const lp = new BQ('lp', 900, 0.7); for (let i = 0; i < n; i++) out[i] = lp.s(out[i]); }
  return norm(out);
}
/** TV / talking: syllables with moving pitch and vowels, pauses; peak 1 */
export function speech(sec: number, seed: number, female = false): Float32Array {
  const r = rng(seed * 31 + 5); const out = new Float32Array(Math.round(sec * SR)); let t = 0.1; const vs = ['a', 'e', 'i', 'o', 'u']; let base = (female ? 54 : 43) + 4 * r();
  while (t < sec - 0.5) {
    const d = 0.12 + 0.25 * r(); const m = base + 5 * (r() - 0.5); const mf = Number(process.env.SPEECH_MINFALL ?? 0); const fall = mf ? (r() < 0.7 ? 1 : -1) * (mf + 300 * r()) : 150 * (r() - 0.3) * 2;
    const v = voice({ midi: Math.round(m), cents: 100 * (m - Math.round(m)), dur: d, seed: Math.floor(r() * 1e6), vowel: vs[Math.floor(r() * 5)], cons: (['l', 'n', 'd', 'h', null] as const)[Math.floor(r() * 5)], tract: female ? 1.17 : 1, fall, atkMs: 25, drift: 25, breath: 0.06 });
    const g = 0.5 + 0.5 * r(); const i0 = Math.round(t * SR); for (let i = 0; i < v.length && i0 + i < out.length; i++) out[i0 + i] += g * v[i];
    t += d + (r() < 0.2 ? 0.25 + 0.5 * r() : 0.02 + 0.05 * r()); if (r() < 0.15) base = (female ? 54 : 43) + 6 * r();
  }
  // small TV speaker
  const hp = new BQ('hp', 220, 0.7), lp = new BQ('lp', 5000, 0.7); for (let i = 0; i < out.length; i++) out[i] = lp.s(hp.s(out[i]));
  return norm(out);
}
/** the app's reference tone as a phone speaker would radiate it (soft e-piano-ish, small-speaker high-pass) */
export function refTone(midi: number, dur: number): Float32Array {
  const n = Math.round((dur + 0.4) * SR); const x = new Float32Array(n); const f = mtof(midi); const hp = new BQ('hp', 380, 0.7);
  for (let i = 0; i < n; i++) { const t = i / SR; const env = Math.min(1, t / 0.012) * Math.exp(-t * 1.2) * (t > dur ? Math.exp(-(t - dur) / 0.08) : 1); x[i] = hp.s(env * (Math.sin(2 * Math.PI * f * t) + 0.45 * Math.exp(-t * 3) * Math.sin(4 * Math.PI * f * t) + 0.2 * Math.exp(-t * 5) * Math.sin(6 * Math.PI * f * t) + 0.08 * Math.sin(8 * Math.PI * f * t))); }
  return norm(x);
}
/** knock on the guitar top / table: impulse into body modes */
export function knock(seed: number, kind: GKind = 'dread'): Float32Array {
  const r = rng(seed); const n = Math.round(0.6 * SR); const y = new Float32Array(n); const body = KIND[kind].body.map(([f, q, g]) => ({ bq: new BQ('bp', f * (0.95 + 0.1 * r()), q * 1.5), g })); const lp = new BQ('lp', 1800, 0.7);
  for (let i = 0; i < n; i++) { const d = i < 0.004 * SR ? gauss(r) * Math.sin(Math.PI * i / (0.004 * SR)) : 0; let v = 0.2 * lp.s(d); for (const b of body) v += b.g * b.bq.s(d); y[i] = v; }
  return norm(y);
}
