// @ts-nocheck (ported review tooling, kept as written)
// Eleventh review (ported unchanged except for where it finds the build).
// Critic-11 synthesis, written from scratch: waveguide (Karplus-Strong) guitar, glottal-pulse +
// formant-resonator voice, three-band decaying-noise rooms, the app's reference tone via a phone speaker.
export const SR = 48000;
export function rng(seed: number) { let s = (seed * 1597334677 + 12345) >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
export function gs(r: () => number) { let u = r(); if (u < 1e-12) u = 1e-12; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
export const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);
export const amp = (d: number) => 10 ** (d / 20);

export class Bq {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0; x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  constructor(kind: string, f: number, q: number, g = 0) {
    const w = 2 * Math.PI * f / SR, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q), A = 10 ** (g / 40); let b0, b1, b2, a0, a1, a2;
    switch (kind) {
      case 'lp': b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
      case 'hp': b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
      case 'bp': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
      default: b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  p(x: number) { const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2; this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y; }
  run(x: Float32Array) { const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = this.p(x[i]); return y; }
}
function norm(y: Float32Array, upto = y.length) { let pk = 1e-9; for (let i = 0; i < Math.min(upto, y.length); i++) pk = Math.max(pk, Math.abs(y[i])); for (let i = 0; i < y.length; i++) y[i] /= pk; return y; }

// ---------------- guitar: plucked-string waveguide
export interface G { midi: number; cents?: number; kind?: 'steel' | 'nylon' | 'electric'; touch?: 'pick' | 'finger' | 'thumb'; sustain?: number; dur?: number; seed?: number; }
const OPENS = [40, 45, 50, 55, 59, 64];
export const stringOf = (m: number) => { let s = 0; for (let i = 0; i < 6; i++) if (OPENS[i] <= m) s = i; return s; };
export function guitar(o: G): Float32Array {
  const r = rng((o.seed ?? 1) * 31 + o.midi * 101 + 7); const kind = o.kind ?? 'steel', touch = o.touch ?? 'pick';
  const f0 = hz(o.midi + (o.cents ?? 0) / 100); const dur = o.dur ?? 5; const n = Math.floor(dur * SR); const y = new Float32Array(n);
  const open = OPENS.includes(o.midi);
  // decay: T60 by string and kind
  let t60 = (kind === 'nylon' ? 3.2 : kind === 'electric' ? 9 : 5.2) * Math.sqrt(130 / f0) * (open ? 1.15 : 0.8) * (o.sustain ?? 1); t60 = Math.max(1.6, Math.min(14, t60));
  const lpA = kind === 'nylon' ? 0.42 : kind === 'electric' ? 0.2 : 0.3; // loop one-pole: brightness loss
  const g = 10 ** (-3 / (f0 * t60));
  const D = SR / f0 - lpA / (1 - lpA) * 1.0 - 0.0; const N = Math.floor(D - 0.5); const frac = D - N; const C = (1 - frac) / (1 + frac);
  const line = new Float32Array(N); let wp = 0, lp = 0, apx = 0, apy = 0;
  // excitation: filtered noise shaped by pluck point; injected over the touch's ramp
  const pos = 0.1 + 0.12 * r(); const pd = Math.max(1, Math.round(N * pos));
  const ramp = touch === 'pick' ? 0.0005 : touch === 'finger' ? 0.006 : 0.022; const exN = N + Math.floor(ramp * SR);
  const exLp = new Bq('lp', touch === 'pick' ? (kind === 'nylon' ? 3500 : 6500) : touch === 'finger' ? 2400 : 1100, 0.7);
  const raw = new Float32Array(exN + pd); for (let i = 0; i < N; i++) raw[i] = gs(r);
  const ex = new Float32Array(exN); for (let i = 0; i < exN; i++) { const v = exLp.p(raw[i] - (i >= pd ? raw[i - pd] : 0)); ex[i] = v; }
  if (ramp > 0.001) { // smear the excitation in time: a soft, slow attack
    const L = Math.floor(ramp * SR); const sm = new Float32Array(exN); let acc = 0; for (let i = 0; i < exN; i++) { acc += ex[i] - (i >= L ? ex[i - L] : 0); sm[i] = acc / L; } ex.set(sm);
  }
  for (let i = 0; i < n; i++) {
    const out = line[wp];
    lp = (1 - lpA) * out + lpA * lp;
    const ap = C * lp + apx - C * apy; apx = lp; apy = ap;
    line[wp] = g * ap + (i < exN ? ex[i] : 0);
    wp++; if (wp >= N) wp = 0;
    y[i] = out;
  }
  // body: two low resonances + air; electric: pickup comb-ish lowpass, no body
  let z: Float32Array;
  if (kind === 'electric') z = new Bq('lp', 3200, 1.1).run(y);
  else { const b1 = new Bq('pk', kind === 'nylon' ? 95 : 110, 3, 7), b2 = new Bq('pk', kind === 'nylon' ? 190 : 215, 4, 5), b3 = new Bq('pk', 430, 3, 3); z = b3.run(b2.run(b1.run(y))); }
  norm(z, SR / 2);
  // contact noise
  if (touch === 'pick') { const h = new Bq('hp', 2800, 0.7); for (let i = 0; i < 0.01 * SR; i++) z[i] += 0.5 * h.p(gs(r)) * Math.exp(-i / (0.002 * SR)); }
  if (touch !== 'pick' && kind !== 'electric') { for (let i = 0; i < 0.08 * SR; i++) { const t = i / SR; z[i] += 0.22 * Math.exp(-t / 0.02) * Math.sin(2 * Math.PI * 105 * t); } }
  return z;
}

// ---------------- voice: glottal pulses through formant resonators
const VOW: Record<string, number[][]> = {
  ah: [[700, 110], [1150, 120], [2600, 170], [3400, 250]], oo: [[320, 70], [800, 90], [2300, 150], [3300, 250]],
  ee: [[280, 60], [2200, 140], [2950, 180], [3600, 250]], oh: [[480, 80], [880, 100], [2500, 160], [3400, 250]], mm: [[250, 60], [1000, 400], [2300, 400], [3300, 500]],
};
export interface V { midi: number; cents?: number; dur: number; vowel?: string; on?: 'smooth' | 'hard' | 'la' | 'da' | 'ha' | 'hm'; riseMs?: number; fade?: number; scoopC?: number; scoopMs?: number; vibC?: number; vibHz?: number; child?: boolean; woman?: boolean; breathy?: number; seed?: number; relMs?: number }
export function voice(o: V): Float32Array {
  const r = rng((o.seed ?? 1) * 977 + o.midi * 13 + Math.round(o.dur * 50));
  const n = Math.floor((o.dur + 0.3) * SR); const src = new Float32Array(n);
  const on = o.on ?? 'smooth'; const rise = (o.riseMs ?? { smooth: 90, hard: 25, la: 45, da: 20, ha: 110, hm: 70 }[on]) / 1000; const rel = (o.relMs ?? 90) / 1000;
  const sc = o.child ? 1.3 : o.woman ? 1.16 : 1; const m0 = o.midi + (o.cents ?? 0) / 100;
  const scoop = o.scoopC ?? 30 + 50 * r(), scoopT = (o.scoopMs ?? 60) / 1000, vib = o.vibC ?? 10 + 12 * r(), vhz = o.vibHz ?? 5 + r();
  const oq = 0.55 + 0.1 * r() + 0.15 * (o.breathy ?? 0); let ph = 0, jit = 0, drift = 0, shim = 1, env = 0;
  const tilt = new Bq('lp', o.breathy ? 1400 : 2600, 0.6); const nz = new Bq('bp', 2500, 0.7);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (i % 64 === 0) { jit += 0.3 * (gs(r) * 5 - jit); drift += 0.004 * (gs(r) * 10 - drift); shim += 0.2 * (1 + gs(r) * 0.05 - shim); }
    const c = -scoop * Math.exp(-t / scoopT) + (t > 0.2 ? vib * Math.min(1, (t - 0.2) / 0.35) * Math.sin(2 * Math.PI * vhz * t) : 0) + jit + drift;
    const f = hz(m0 + c / 100); ph += f / SR; if (ph >= 1) ph -= 1;
    // Rosenberg-type flow derivative
    let gl; if (ph < oq * 0.7) { const u = ph / (oq * 0.7); gl = Math.sin(Math.PI * u) * 0.5 * Math.PI / (oq * 0.7) * 0.15; } else if (ph < oq) { const u = (ph - oq * 0.7) / (oq * 0.3); gl = -Math.sin(Math.PI * u * 0.5 + Math.PI / 2 * 0) * 1.2 - 0.0; gl = -1.6 * Math.sin(Math.PI * u); } else gl = 0;
    const target = t < o.dur ? Math.min(1, t / rise) : Math.max(0, 1 - (t - o.dur) / rel);
    env = target * target * (3 - 2 * target) * amp(-(o.fade ?? 0) * Math.max(0, t - rise));
    const asp = (0.04 + 0.25 * (o.breathy ?? 0)) * nz.p(gs(r)) * (0.4 + 0.6 * (ph < oq ? 1 : 0.3));
    src[i] = env * shim * (tilt.p(gl) + asp);
  }
  // formants: parallel resonators, consonant colour at the start
  const F = VOW[o.vowel ?? 'ah']; const y = new Float32Array(n);
  // cascade of two-pole resonators (unity gain at DC, as a vocal tract has)
  y.set(src);
  for (let k = 0; k < 4; k++) { const fc = Math.min(F[k][0] * sc, 0.45 * SR), bw = F[k][1] * sc; const Cc = -Math.exp(-2 * Math.PI * bw / SR), Bc = 2 * Math.exp(-Math.PI * bw / SR) * Math.cos(2 * Math.PI * fc / SR), Ac = 1 - Bc - Cc; let y1 = 0, y2 = 0; for (let i = 0; i < n; i++) { const v = Ac * y[i] + Bc * y1 + Cc * y2; y2 = y1; y1 = v; y[i] = v; } }
  if (on === 'la' || on === 'hm') { // nasal/lateral start: dull for the first 60-90 ms
    const cd = on === 'hm' ? 0.09 : 0.055; const d = new Bq('lp', 500, 0.7); for (let i = 0; i < n; i++) { const t = i / SR; const dull = d.p(y[i]); const mix = Math.min(1, Math.max(0, (t - cd) / 0.025)); y[i] = mix * y[i] + (1 - mix) * dull * 1.3; }
  }
  norm(y);
  if (on === 'da' || on === 'hard') { const h = new Bq('hp', 1700, 0.7); const gb = on === 'da' ? 0.2 : 0.08; for (let i = 0; i < 0.012 * SR; i++) y[i] += gb * h.p(gs(r)) * Math.exp(-i / (0.004 * SR)); }
  if (on === 'ha') { const h = new Bq('bp', 1800, 0.6); for (let i = 0; i < 0.12 * SR; i++) { const t = i / SR; y[i] += 0.12 * h.p(gs(r)) * Math.sin(Math.PI * t / 0.12); } }
  return y;
}

// ---------------- talking
export function talk(sec: number, seed: number, woman = false): Float32Array {
  const r = rng(seed * 7 + 3); const y = new Float32Array(Math.floor(sec * SR)); let t = 0.15; const base = woman ? 56 : 44;
  const vs = ['ah', 'oo', 'ee', 'oh'], os = ['smooth', 'hard', 'la', 'da', 'ha', 'hm'];
  while (t < sec - 0.4) {
    let m = base + 5 * r(); const k = 2 + Math.floor(6 * r());
    for (let w = 0; w < k && t < sec - 0.35; w++) { const d = 0.08 + 0.18 * r(); m += (r() - 0.6) * 2.5; const v = voice({ midi: Math.floor(m), cents: (m - Math.floor(m)) * 100, dur: d, vowel: vs[Math.floor(4 * r())], on: os[Math.floor(6 * r())] as any, scoopC: (r() - 0.4) * 300, vibC: 0, riseMs: 20 + 30 * r(), relMs: 40, seed: Math.floor(1e5 * r()), woman }); const g = amp(-7 * r()); const s = Math.floor(t * SR); for (let i = 0; i < v.length && s + i < y.length; i++) y[s + i] += g * v[i]; t += d + (r() < 0.3 ? 0.04 + 0.1 * r() : 0); }
    t += 0.2 + 0.8 * r();
  }
  return y;
}

// ---------------- bumps
export function bump(kind: 'knock' | 'page' | 'breath' | 'cough' | 'chair', seed = 1): Float32Array {
  const r = rng(seed * 53 + kind.length); const n = Math.floor(0.7 * SR); const y = new Float32Array(n);
  if (kind === 'knock') { for (let i = 0; i < n; i++) { const t = i / SR; y[i] = Math.exp(-t / 0.03) * (Math.sin(2 * Math.PI * 140 * t) + 0.6 * Math.sin(2 * Math.PI * 310 * t + 1) + 0.3 * Math.sin(2 * Math.PI * 720 * t)) + (t < 0.004 ? 0.6 * gs(r) : 0); } }
  else if (kind === 'page') { const h = new Bq('hp', 2500, 0.6); for (let i = 0; i < n; i++) { const t = i / SR; y[i] = h.p(gs(r)) * (t < 0.35 ? Math.sin(Math.PI * t / 0.35) ** 2 * (0.5 + 0.5 * Math.abs(Math.sin(40 * t))) : 0); } }
  else if (kind === 'breath') { const b = new Bq('bp', 900, 0.5); for (let i = 0; i < n; i++) { const t = i / SR; y[i] = b.p(gs(r)) * (t < 0.6 ? Math.sin(Math.PI * t / 0.6) ** 2 : 0); } }
  else if (kind === 'cough') { const b = new Bq('bp', 600, 0.6); for (let i = 0; i < n; i++) { const t = i / SR; y[i] = b.p(gs(r)) * (Math.exp(-t / 0.05) + 0.6 * (t > 0.18 ? Math.exp(-(t - 0.18) / 0.06) : 0)); } }
  else { const b = new Bq('bp', 380, 4); for (let i = 0; i < n; i++) { const t = i / SR; y[i] = b.p(gs(r)) * (t < 0.3 ? Math.sin(Math.PI * t / 0.3) : 0) * (1 + 0.5 * Math.sin(2 * Math.PI * 9 * t)); } }
  return norm(y);
}

// ---------------- the app's reference tone (src/ui/audio.ts scheduleTone/makeToneWave) through a phone loudspeaker
export function refTone(midi: number, dur: number, speaker: 'phone' | 'tablet' | 'flat' = 'phone'): Float32Array {
  const H = [1, 0.42, 0.22, 0.12, 0.07, 0.04, 0.025, 0.015]; const f = hz(midi); const n = Math.floor((dur + 0.4) * SR); let y = new Float32Array(n);
  const pk = 0.34, su = 0.22, hold = Math.max(0.19, dur - 0.05);
  for (let i = 0; i < n; i++) { const t = i / SR; let e; if (t < 0.015) e = 0.0001 + (pk - 0.0001) * t / 0.015; else if (t < 0.18) e = pk * (su / pk) ** ((t - 0.015) / 0.165); else if (t < hold) e = su; else if (t < dur + 0.3) e = su * (0.0001 / su) ** ((t - hold) / (dur + 0.3 - hold)); else e = 0; let s = 0; for (let k = 0; k < 8; k++) s += H[k] * Math.sin(2 * Math.PI * (k + 1) * f * t); y[i] = e * s; }
  y = new Bq('lp', Math.min(6000, 9 * f), 0.4).run(y);
  if (speaker === 'phone') { y = new Bq('hp', 480, 0.9).run(new Bq('hp', 350, 0.7).run(y)); y = new Bq('pk', 900, 2, 6).run(y); y = new Bq('pk', 3000, 1.5, 3).run(y); }
  if (speaker === 'tablet') { y = new Bq('hp', 220, 0.8).run(new Bq('hp', 160, 0.7).run(y)); }
  return norm(y);
}

// ---------------- rooms
function fft(re: Float64Array, im: Float64Array, inv: boolean) { const n = re.length; for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } } for (let L = 2; L <= n; L <<= 1) { const a = (inv ? -2 : 2) * Math.PI / L, wr = Math.cos(a), wi = Math.sin(a); for (let i = 0; i < n; i += L) { let cr = 1, ci = 0; for (let k = 0; k < L / 2; k++) { const p = i + k, q = p + L / 2; const vr = re[q] * cr - im[q] * ci, vi = re[q] * ci + im[q] * cr; re[q] = re[p] - vr; im[q] = im[p] - vi; re[p] += vr; im[p] += vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } } if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; } }
export function conv(x: Float32Array, ir: Float32Array): Float32Array { const L = x.length + ir.length - 1; let n = 1; while (n < L) n <<= 1; const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n); ar.set(x); br.set(ir); fft(ar, ai, false); fft(br, bi, false); for (let i = 0; i < n; i++) { const t = ar[i] * br[i] - ai[i] * bi[i]; ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = t; } fft(ar, ai, true); const y = new Float32Array(L); for (let i = 0; i < L; i++) y[i] = ar[i]; return y; }
/** rt = mid-band RT60 (s); drr = direct-to-reverberant energy (dB) for a source at 50 cm. rt 0 = anechoic. */
export interface Room { rt: number; drr: number }
export const ROOMS: Record<string, Room> = {
  dead: { rt: 0, drr: 99 }, bedroom: { rt: 0.35, drr: 9 }, lounge: { rt: 0.6, drr: 5 }, kitchen: { rt: 0.9, drr: 2 }, hall: { rt: 1.2, drr: 0 },
  stair: { rt: 1.6, drr: -2 }, bath: { rt: 2.0, drr: -4 }, church: { rt: 2.5, drr: -6 },
};
const irs = new Map<string, Float32Array | null>();
export function roomIR(name: string, variant: number, nearDb = 0): Float32Array | null {
  const key = `${name}/${variant}/${nearDb}`; if (irs.has(key)) return irs.get(key)!;
  const R = ROOMS[name]; if (!R.rt) { irs.set(key, null); return null; }
  const r = rng(4409 + variant * 17 + Math.round(R.rt * 100)); const n = Math.floor(Math.min(3.4, R.rt * 1.4 + 0.1) * SR); const ir = new Float32Array(n);
  const lo = new Bq('lp', 400, 0.7), mi = new Bq('bp', 1000, 0.5), hi = new Bq('hp', 2800, 0.7); const d0 = Math.floor(0.008 * SR);
  for (let i = d0; i < n; i++) { const t = (i - d0) / SR; const w = gs(r); const on = Math.min(1, t / 0.03); ir[i] = on * (lo.p(w) * Math.exp(-6.908 * t / (R.rt * 1.15)) + mi.p(w) * Math.exp(-6.908 * t / R.rt) + 0.7 * hi.p(w) * Math.exp(-6.908 * t / (R.rt * 0.5))); }
  let e = 0; for (let i = 0; i < n; i++) e += ir[i] * ir[i]; const g = Math.sqrt(10 ** (-(R.drr + nearDb) / 10) / e); for (let i = 0; i < n; i++) ir[i] *= g;
  for (let k = 0; k < 5; k++) { const d = Math.floor((0.002 + 0.02 * r()) * SR); ir[d] += (r() < 0.5 ? -1 : 1) * (0.15 + 0.3 * r()) * amp(-nearDb / 2); }
  ir[0] += 1; irs.set(key, ir); return ir;
}
