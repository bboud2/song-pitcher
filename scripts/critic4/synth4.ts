// Ported from the fourth external review (read-only original), kept as a permanent test.
// Critic-4 synthesis: time-domain digital waveguide guitar (stiff string, pick position, two
// polarisations, body resonators), source-filter voice (Rosenberg pulse + formants + jitter/
// shimmer/vibrato/scoop/breath), speech-like babble, pink room noise. Independent of both
// existing synths (which are additive/modal).
export function rng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
export const db2a = (d: number) => Math.pow(10, d / 20);
export const m2f = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const f2m = (f: number) => 69 + 12 * Math.log2(f / 440);
export const OPEN = [40, 45, 50, 55, 59, 64];
export function stringFor(midi: number, alt = false): { s: number; fret: number } {
  let s = 0;
  for (let i = 0; i < 6; i++) if (OPEN[i] <= midi) s = i;
  if (alt && s > 0 && midi - OPEN[s - 1] <= 9) s--;
  return { s, fret: midi - OPEN[s] };
}

/** precise frequency of the strongest spectral line near f (DTFT search, Hann window) */
export function lineFreq(x: Float32Array, sr: number, f: number, from = 0.25, to = 0.9, span = 0.04): number {
  const a = Math.floor(from * sr), b = Math.min(x.length, Math.floor(to * sr));
  const N = b - a;
  const mag = (ff: number) => {
    let re = 0, im = 0; const w = (2 * Math.PI * ff) / sr;
    for (let i = 0; i < N; i += 2) { const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); re += h * x[a + i] * Math.cos(w * i); im += h * x[a + i] * Math.sin(w * i); }
    return re * re + im * im;
  };
  let best = f, bm = -1;
  for (let k = -40; k <= 40; k++) { const ff = f * (1 + (span * k) / 40); const m = mag(ff); if (m > bm) { bm = m; best = ff; } }
  let lo = best * (1 - span / 40), hi = best * (1 + span / 40);
  for (let it = 0; it < 30; it++) { const m1 = lo + (hi - lo) * 0.382, m2 = lo + (hi - lo) * 0.618; if (mag(m1) > mag(m2)) hi = m2; else lo = m1; }
  return (lo + hi) / 2;
}

export interface WOpts {
  sr: number; seed?: number;
  cents?: number;        // detune of the string/fret
  peakDb?: number;       // peak level at the mic
  pick?: number;         // pick position, fraction of the string (0.07 bridge .. 0.35 neck)
  hard?: number;         // 0 flesh .. 1 hard pick
  kind?: 'steel' | 'nylon' | 'electric';
  attackMs?: number;     // extra excitation smear (thumb / slow finger)
  decay?: number;        // dB/s of the fundamental (default by string)
  stiff?: number;        // 0..1 dispersion amount
  pol2?: number;         // amplitude of second polarisation (0..1)
  beatCents?: number;    // its detune
  glide?: number;        // cents sharp at the attack (tension), settling with tau 80 ms
  track?: (t: number) => number; // extra cents vs time (bend / slide / hammer-on / vibrato)
  bumps?: { t: number; amp: number }[]; // extra small excitations (hammer-on impact)
  noBody?: boolean;
  string?: number;       // force the string index (for decay/stiffness defaults)
}

const calCache = new Map<string, number>();

function wgCore(f0: number, n: number, sr: number, exc: Float32Array, decay: number, damp: number, apC: number, nAp: number, track: Float32Array | null, scale: number): Float32Array {
  const D0 = (sr / f0) * scale;
  const size = 4096; const mask = size - 1;
  const buf = new Float32Array(size);
  const out = new Float32Array(n);
  const w = (2 * Math.PI * f0) / sr;
  const hmag = (1 - damp) / Math.sqrt(1 + damp * damp - 2 * damp * Math.cos(w));
  const rho = Math.min(0.99995, Math.pow(10, -decay / (20 * f0)) / hmag);
  let lp = 0; const ax = new Float64Array(nAp), ay = new Float64Array(nAp);
  let wp = 0;
  for (let i = 0; i < n; i++) {
    const d = track ? D0 * Math.pow(2, -track[i] / 1200) : D0;
    const rp = wp - d; const ip = Math.floor(rp); const fr = rp - ip;
    // 4-point Lagrange
    const xm1 = buf[(ip - 1) & mask], x0 = buf[ip & mask], x1 = buf[(ip + 1) & mask], x2 = buf[(ip + 2) & mask];
    const y = x0 + fr * (-xm1 / 3 - x0 / 2 + x1 - x2 / 6 + fr * ((xm1 + x1) / 2 - x0 + fr * ((x2 - xm1) / 6 + (x0 - x1) / 2)));
    lp = (1 - damp) * y + damp * lp;
    let v = lp;
    for (let k = 0; k < nAp; k++) { const o = apC * v + ax[k] - apC * ay[k]; ax[k] = v; ay[k] = o; v = o; }
    buf[wp & mask] = (i < exc.length ? exc[i] : 0) + rho * v;
    out[i] = y;
    wp++;
  }
  return out;
}

function biquadBP(x: Float32Array, sr: number, f: number, q: number, g: number, out: Float32Array): void {
  const w = (2 * Math.PI * f) / sr, al = Math.sin(w) / (2 * q), a0 = 1 + al;
  const b0 = al / a0, b2 = -al / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const y = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = y; out[i] += g * y; }
}
export function hp2(x: Float32Array, sr: number, f: number): Float32Array {
  const w = (2 * Math.PI * f) / sr, q = 0.707, al = Math.sin(w) / (2 * q), cw = Math.cos(w), a0 = 1 + al;
  const b0 = (1 + cw) / 2 / a0, b1 = -(1 + cw) / a0, a1 = (-2 * cw) / a0, a2 = (1 - al) / a0;
  const o = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const y = b0 * x[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = y; o[i] = y; }
  return o;
}

/** Waveguide plucked string. Returned buffer's fundamental is calibrated to midi+cents (±<1 c) once settled. */
export function wg(midi: number, dur: number, o: WOpts): Float32Array {
  const sr = o.sr; const n = Math.floor(dur * sr);
  const r = rng((o.seed ?? 1) * 131 + midi * 17 + 5);
  const kind = o.kind ?? 'steel';
  const s = o.string ?? stringFor(midi).s; const fret = midi - OPEN[s];
  const hard = o.hard ?? 0.5;
  const f0 = m2f(midi) * Math.pow(2, (o.cents ?? 0) / 1200);
  const L = sr / f0;
  const decay = o.decay ?? ([4.5, 5, 6, 8, 10, 12][s] + 0.7 * fret) * (kind === 'nylon' ? 1.8 : kind === 'electric' ? 0.45 : 1);
  const damp = kind === 'nylon' ? 0.55 : kind === 'electric' ? 0.2 : 0.32 - 0.12 * hard + (s < 3 ? 0.08 : 0);
  const stiff = o.stiff ?? (kind === 'nylon' ? 0.15 : s < 3 ? 0.45 : 0.6);
  const nAp = stiff > 0 ? Math.round(Math.max(2, Math.min(16, L / 36))) : 0; const apC = -(0.2 + 0.5 * stiff) * Math.max(0.25, Math.min(1, L / 150));
  // excitation: band-limited pulse minus its pick-position reflection, plus pick noise
  const pick = o.pick ?? 0.13 + 0.1 * r();
  const pw = Math.max(3, Math.round(sr / (900 + 5000 * hard * (kind === 'nylon' ? 0.4 : 1))));
  const sm = Math.round(((o.attackMs ?? 0) / 1000) * sr);
  const el = Math.ceil(L * pick) + pw + sm + 8 + Math.floor(0.006 * sr);
  let exc = new Float32Array(el);
  const dl = Math.round(L * pick);
  for (let i = 0; i < pw; i++) { const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / pw); exc[i] += h; exc[i + dl] -= h; }
  if (kind !== 'nylon') { let z = 0; const pn = Math.floor(0.004 * sr); for (let i = 0; i < pn; i++) { z += 0.4 * ((r() * 2 - 1) - z); exc[i] += 0.25 * hard * z * (1 - i / pn); } }
  if (sm > 1) { const e2 = new Float32Array(el); let acc = 0; for (let i = 0; i < el; i++) { acc += exc[i] - (i >= sm ? exc[i - sm] : 0); e2[i] = acc / sm; } exc = e2; }
  let track: Float32Array | null = null;
  const glide = o.glide ?? 3 + 12 * hard * hard;
  if (glide || o.track) { track = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / sr; track[i] = glide * Math.exp(-t / 0.08) + (o.track ? o.track(t) : 0); } }
  if (o.bumps) { const e2 = new Float32Array(n); e2.set(exc.subarray(0, Math.min(n, exc.length))); for (const b of o.bumps) { const at = Math.floor(b.t * sr); for (let i = 0; i < pw * 2 && at + i < n; i++) e2[at + i] += b.amp * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (pw * 2))); } exc = e2; }
  const key = `${f0.toFixed(3)}|${damp.toFixed(3)}|${apC.toFixed(3)}|${nAp}|${sr}`;
  let scale = calCache.get(key);
  if (scale === undefined) {
    scale = 1;
    const ce = new Float32Array(pw + dl + 2); for (let i = 0; i < pw; i++) { const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / pw); ce[i] += h; ce[i + dl] -= h; }
    for (let it = 0; it < 4; it++) { const y = wgCore(f0, Math.floor(1.0 * sr), sr, ce, 2, damp, apC, nAp, null, scale); const fm = lineFreq(y, sr, f0, 0.25, 0.9, it === 0 ? 0.12 : 0.03); scale *= fm / f0; }
    calCache.set(key, scale);
  }
  const y = wgCore(f0, n, sr, exc, decay, damp, apC, nAp, track, scale);
  const p2 = o.pol2 ?? 0.25 + 0.2 * r();
  if (p2 > 0) {
    const bc = o.beatCents ?? (0.5 + 1.5 * r()) * (r() < 0.5 ? -1 : 1);
    // (same calibration scale: the detune is tiny)
    const y2 = wgCore(f0 * Math.pow(2, bc / 1200), n, sr, exc, decay * (0.6 + 0.6 * r()), damp, apC, nAp, track, scale);
    for (let i = 0; i < n; i++) y[i] += p2 * y2[i];
  }
  let out = y;
  if (!o.noBody && kind !== 'electric') {
    out = Float32Array.from(y);
    const g = kind === 'nylon' ? 1.3 : 1;
    biquadBP(y, sr, 101, 18, 1.4 * g, out); biquadBP(y, sr, 204, 14, 1.2 * g, out); biquadBP(y, sr, 285, 12, 0.6, out); biquadBP(y, sr, 410, 9, 0.5, out);
    // body knock from the pluck itself
    const kn = new Float32Array(n); kn.set(exc.subarray(0, Math.min(n, exc.length)));
    biquadBP(kn, sr, 101, 12, (2 + 4 * hard) * (kind === 'nylon' ? 1.5 : 1), out); biquadBP(kn, sr, 204, 10, 1.5 + 2 * hard, out);
    out = hp2(out, sr, 75);
  } else if (kind === 'electric') {
    out = hp2(hp2(y, sr, 350), sr, 200); // unplugged solid body: thin, no lows
  }
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i]));
  const gg = db2a(o.peakDb ?? -20) / (pk || 1);
  for (let i = 0; i < n; i++) out[i] *= gg;
  return out;
}

/** An open string driven sympathetically by `drive` (already rendered): swells then rings at its own partials. */
export function sympathetic(drive: Float32Array, sr: number, openMidi: number, cents: number, coupling: number): Float32Array {
  const f0 = m2f(openMidi) * Math.pow(2, cents / 1200);
  const exc = new Float32Array(drive.length); for (let i = 0; i < drive.length; i++) exc[i] = coupling * drive[i];
  const key = `${f0.toFixed(3)}|0.300|-0.400|4|${sr}`;
  let scale = calCache.get(key);
  if (scale === undefined) { scale = 1; const ce = new Float32Array(40); for (let i = 0; i < 20; i++) ce[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 20); for (let it = 0; it < 3; it++) { const y = wgCore(f0, sr, sr, ce, 2, 0.3, -0.4, 4, null, scale); scale *= lineFreq(y, sr, f0) / f0; } calCache.set(key, scale); }
  return wgCore(f0, drive.length, sr, exc, 3.5, 0.3, -0.4, 4, null, scale);
}

// ------------------------------------------------------------------ voice
export interface VOpts {
  sr: number; seed?: number; female?: boolean;
  vowel?: 'a' | 'o' | 'u' | 'i' | 'e' | 'm';
  cents?: number; levelDb?: number;
  vibHz?: number; vibCents?: number; vibOnset?: number;
  jitter?: number; shimmer?: number; drift?: number;
  scoop?: number; scoopMs?: number;       // start this many cents off, arrive in scoopMs
  breathOnsetMs?: number; breath?: number; // aspiration before voicing, and aspiration level 0..1
  attackMs?: number; releaseMs?: number;
  track?: (t: number) => number;           // extra cents
  amp?: (t: number) => number;             // extra gain
  oq?: number;                             // open quotient (0.4 pressed .. 0.8 breathy/falsetto)
}
const FORM: Record<string, [number, number][]> = {
  a: [[730, 90], [1090, 110], [2440, 170], [3400, 250]],
  o: [[570, 80], [840, 100], [2410, 170], [3300, 250]],
  u: [[300, 70], [870, 100], [2240, 170], [3300, 250]],
  i: [[270, 60], [2290, 120], [3010, 180], [3500, 250]],
  e: [[530, 80], [1840, 110], [2480, 170], [3400, 250]],
  m: [[250, 60], [1000, 300], [2200, 400], [3000, 500]],
};
export function voice(midi: number, dur: number, o: VOpts): Float32Array {
  const sr = o.sr; const n = Math.floor(dur * sr); const r = rng((o.seed ?? 3) * 977 + midi * 13);
  const f0 = m2f(midi) * Math.pow(2, (o.cents ?? 0) / 1200);
  const jit = o.jitter ?? 0.006, shim = o.shimmer ?? 0.05, drift = o.drift ?? 5;
  const vibHz = o.vibHz ?? 5.3, vibC = o.vibCents ?? 0, vibOn = o.vibOnset ?? 0.35;
  const oq = o.oq ?? 0.6; const tp = oq * 0.67, tn = oq * 0.33;
  const bOn = (o.breathOnsetMs ?? 0) / 1000; const br = o.breath ?? 0.05;
  const src = new Float32Array(n);
  let ph = r(), per = 1, amp = 1, dr = 0, prevG = 0, nz = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    dr += 0.0006 * ((r() * 2 - 1) * drift * 6 - dr); // slow wander, few cents
    let c = dr;
    if (vibC && t > bOn + vibOn) c += vibC * Math.min(1, (t - bOn - vibOn) / 0.25) * Math.sin(2 * Math.PI * vibHz * t);
    if (o.scoop) c += o.scoop * Math.max(0, 1 - (t - bOn) / ((o.scoopMs ?? 180) / 1000));
    if (o.track) c += o.track(t);
    ph += (f0 * Math.pow(2, c / 1200) * per) / sr;
    if (ph >= 1) { ph -= 1; per = 1 + jit * (r() * 2 - 1) * 1.7; amp = 1 + shim * (r() * 2 - 1) * 1.7; }
    const g = ph < tp ? 0.5 * (1 - Math.cos((Math.PI * ph) / tp)) : ph < tp + tn ? Math.cos(((ph - tp) / tn) * Math.PI * 0.5) : 0;
    const voiced = t >= bOn ? Math.min(1, (t - bOn) / ((o.attackMs ?? 70) / 1000)) : 0;
    const w = r() * 2 - 1; nz += 0.6 * (w - nz);
    const asp = (w - nz) * (br * (0.4 + 0.6 * g) * voiced + (t < bOn + 0.05 ? 0.35 * Math.min(1, t / 0.03) * (bOn > 0 ? 1 : 0) * (1 - voiced) : 0));
    src[i] = amp * voiced * (g - prevG) * 30 + 0.15 * asp;
    prevG = g;
  }
  const fm = FORM[o.vowel ?? 'a']; const sc = o.female ? 1.17 : 1;
  let x: Float32Array = src;
  for (const [f, bw] of fm) {
    const C = -Math.exp((-2 * Math.PI * bw) / sr), B = 2 * Math.exp((-Math.PI * bw) / sr) * Math.cos((2 * Math.PI * f * sc) / sr), A = 1 - B - C;
    const y = new Float32Array(n); let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) { const v = A * x[i] + B * y1 + C * y2; y2 = y1; y1 = v; y[i] = v; }
    x = y;
  }
  if (o.vowel === 'm') { let z = 0, z2 = 0; for (let i = 0; i < n; i++) { z += 0.08 * (x[i] - z); z2 += 0.08 * (z - z2); x[i] = z2; } }
  x = hp2(x, sr, 70);
  const rel = Math.floor(((o.releaseMs ?? 90) / 1000) * sr);
  let pk = 0; for (let i = Math.floor(n * 0.3); i < n * 0.8; i++) pk = Math.max(pk, Math.abs(x[i]));
  const g = db2a(o.levelDb ?? -18) / (pk || 1);
  for (let i = 0; i < n; i++) { const t = i / sr; x[i] *= g * (i > n - rel ? (n - i) / rel : 1) * (o.amp ? o.amp(t) : 1); }
  return x;
}

/** Speech-like babble: syllables with gliding pitch, changing vowels, pauses, fricative bursts. */
export function babble(dur: number, o: { sr: number; seed?: number; female?: boolean; levelDb?: number; baseMidi?: number }): Float32Array {
  const sr = o.sr; const n = Math.floor(dur * sr); const out = new Float32Array(n); const r = rng((o.seed ?? 9) * 31337);
  const base = o.baseMidi ?? (o.female ? 56 : 45);
  let t = 0.05; const vs = ['a', 'o', 'u', 'i', 'e', 'm'] as const;
  while (t < dur - 0.4) {
    const len = 0.11 + 0.2 * r(); const st = base + 5 * (r() - 0.4); const sl = (r() - 0.55) * 500; // cents over the syllable
    const v = voice(st, len, { sr, seed: Math.floor(r() * 1e6), female: o.female, vowel: vs[Math.floor(r() * 6)], levelDb: (o.levelDb ?? -24) - 6 * r(), attackMs: 25, releaseMs: 40, track: (tt) => (sl * tt) / len, jitter: 0.012, breath: 0.12 });
    const at = Math.floor(t * sr); for (let i = 0; i < v.length && at + i < n; i++) out[at + i] += v[i];
    if (r() < 0.35) { const fl = Math.floor(0.05 * sr); let z = 0; for (let i = 0; i < fl && at - fl + i < n; i++) { const w = r() * 2 - 1; z += 0.5 * (w - z); if (at - fl + i >= 0) out[at - fl + i] += db2a((o.levelDb ?? -24) - 14) * (w - z) * Math.sin((Math.PI * i) / fl); } }
    t += len + (r() < 0.2 ? 0.25 + 0.4 * r() : 0.02 + 0.08 * r());
  }
  return out;
}

/** pink-ish noise generator (Kellet) at a given rms dBFS */
export function pinkGen(seed: number): () => number {
  const r = rng(seed); let b0 = 0, b1 = 0, b2 = 0;
  return () => { const w = r() * 2 - 1; b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; return (b0 + b1 + b2 + w * 0.1848) * 0.62; };
}
