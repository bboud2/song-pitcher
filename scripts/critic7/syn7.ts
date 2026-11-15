// Seventh review: synthesis (ported unchanged).
// Critic-7 synthesis. Methods (declared honestly):
//  guitar: lumped mass-spring chain (two polarisations, bending springs, Kirchhoff-Carrier tension modulation computed from
//          the instantaneous chain length), excited by a UNILATERAL CONTACT plectrum/finger that pushes the string and lets go
//          (stick -> slip), right-hand/left-hand damping as time-varying local losses; bridge force -> body resonators +
//          sympathetic open-string resonators. (A lumped chain is a discrete cousin of a finite-difference string; what is new
//          here is the contact excitation, the geometric nonlinearity and the hand-damping gestures.)
//  voice : self-oscillating source (Hopf normal-form oscillator whose amplitude grows out of noise when "lung pressure" rises and
//          collapses when it falls; waveshaped into a glottal flow), cascade formant resonators, flow-gated aspiration.
//  room  : modal synthesis of a shoebox (every eigenmode below ~1.3 kHz as a damped cosine, mode shapes at source/mic) +
//          velvet-noise tail above the crossover.
export const SR = 48000;
export const db2a = (d: number) => Math.pow(10, d / 20);
export const a2db = (a: number) => 20 * Math.log10(Math.max(a, 1e-12));
export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export function rng(seed: number) { let s = (Math.imul(seed | 0, 2246822519) ^ 0x9e3779b9) >>> 0 || 7; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function gauss(r: () => number) { const u = Math.max(1e-12, r()); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
export function fft(re: Float64Array, im: Float64Array, inv = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = (inv ? 2 : -2) * Math.PI / len; const wr = Math.cos(ang), wi = Math.sin(ang); const h = len >> 1;
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < h; k++) { const a = i + k, b = a + h; const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr; re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
/** RBJ biquad */
export class BQ { b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0; x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  constructor(type: 'lp' | 'hp' | 'bp' | 'pk', f: number, q: number, gainDb = 0, sr = SR) { const w = 2 * Math.PI * Math.min(f, sr * 0.49) / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q); let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; } else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; } else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; } else { const A = Math.pow(10, gainDb / 40); b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; }
  s(x: number) { const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2; this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y; } }
export function normPeak(x: Float32Array, peak = 1): Float32Array { let m = 0; for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i])); if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m; return x; }

// ------------------------------------------------------------------ guitar
export const OPEN = [40, 45, 50, 55, 59, 64];
/** open-position fingering: highest string whose open note is <= midi */
export function stringFor(midi: number): { s: number; fret: number } { let s = 0; for (let i = 0; i < 6; i++) if (OPEN[i] <= midi) s = i; return { s, fret: midi - OPEN[s] }; }
export type Pluck = 'pick' | 'softpick' | 'nail' | 'finger' | 'thumb';
export interface GOpts {
  midi: number; cents?: number; dur?: number; seed?: number; string?: number;
  kind?: 'steel' | 'nylon'; pluck?: Pluck; hard?: number; /** 0..1 pluck strength (tension glide, brightness) */
  pos?: number; /** pluck point, fraction of the sounding length from the bridge */
  vib?: { cents: number; hz: number; start?: number }; /** left-hand vibrato */
  palm?: boolean; /** palm mute: flesh on the string at the bridge */
  stopAt?: number; stopKind?: 'lift' | 'hand'; /** note ended by lifting the fretting finger / laying the hand on */
  detune2?: number; /** cents between the two polarisations (beating); default small random */
  beat?: number; /** second-polarisation strength 0..1 */
  sym?: boolean; body?: number; noSym?: boolean;
}
const B_STEEL = [9e-5, 7e-5, 1.0e-4, 2.2e-4, 1.3e-4, 7e-5], B_NYLON = [4e-5, 3.5e-5, 5e-5, 7e-5, 4.5e-5, 3e-5];
const FIRD = (() => { const n = 95; const h = new Float64Array(n); let s = 0; for (let i = 0; i < n; i++) { const k = i - (n - 1) / 2; const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1)); h[i] = (k === 0 ? 1 : Math.sin(Math.PI * k * 0.21) / (Math.PI * k * 0.21)) * w; s += h[i]; } for (let i = 0; i < n; i++) h[i] /= s; return h; })(); // cutoff ~0.105 fs_os (for OS=4: 20 kHz)
const BODY: [number, number, number][] = [[98, 14, 1.0], [192, 22, 1.3], [236, 28, 0.6], [368, 30, 0.8], [432, 35, 0.5], [545, 30, 0.45], [690, 28, 0.35]];
/** returns the note as the bridge radiates it (main) and the other open strings ringing in sympathy (sym); peak of main = 1 */
export function guitar(o: GOpts): { main: Float32Array; sym: Float32Array } {
  const r = rng((o.seed ?? 1) * 7919 + o.midi * 131); const st = o.string ?? stringFor(o.midi).s; const fret = o.midi - OPEN[st];
  const kind = o.kind ?? 'steel'; const pl = o.pluck ?? 'pick'; const hard = o.hard ?? 0.5; const dur = o.dur ?? 3;
  const f0 = mtof(o.midi + (o.cents ?? 0) / 100); const OS = 2; const fs = SR * OS; const dt = 1 / fs;
  const B = (kind === 'steel' ? B_STEEL : B_NYLON)[st] * Math.pow(2, fret / 6) * (0.8 + 0.4 * r());
  // number of masses: as many as explicit integration allows
  let M = Math.floor(fs / (2 * f0)); while (4 * M * f0 * Math.sqrt(1 + 0.4053 * B * M * M) > 1.55 * fs) M--;
  const K0 = (2 * M * f0) * (2 * M * f0); const kap = K0 * B * (M / Math.PI) * (M / Math.PI);
  // losses: sigma(theta) = s0 + s1 theta^2 ; steel rings longer and brighter than nylon; fretted notes lose more (finger pad)
  const t60f = (kind === 'steel' ? [9, 8, 7, 5.5, 4.5, 3.6] : [6, 5.5, 4.5, 3.2, 2.6, 2.2])[st] * (fret > 0 ? 0.62 : 1) * (0.8 + 0.4 * r());
  const s0b = 6.91 / t60f; const sHf = (kind === 'steel' ? 9 : 22) * (fret > 0 ? 1.4 : 1) * (0.8 + 0.4 * r()); const thHf = Math.PI * 3000 / (M * f0); const s1 = Math.max(0, sHf - s0b) / (thHf * thHf);
  // polarisations: y (normal to the top: louder, dies faster), z (parallel: quieter, rings longer), slightly different tuning
  const det = o.detune2 ?? (1.5 + 5 * r()) * (r() < 0.5 ? -1 : 1); const Kz = Math.pow(2, 2 * det / 1200); const beat = o.beat ?? (0.25 + 0.3 * r());
  const y = new Float64Array(M + 3), vy = new Float64Array(M + 3), z = new Float64Array(M + 3), vz = new Float64Array(M + 3); // index 1..N+... (0,1 and M+1,M+2 are fixed ends/ghosts): masses at 2..M
  // plectrum
  const pos = o.pos ?? (0.1 + 0.14 * r()); const j0 = 1 + Math.max(2, Math.min(M - 2, Math.round((1 - pos) * M)));
  const mmPer = 648 * Math.pow(2, -fret / 12) / M; const wmm = { pick: 1.2, softpick: 2.5, nail: 2.0, finger: 9, thumb: 14 }[pl]; const hw = Math.max(0, Math.round(wmm / mmPer / 2));
  const wts: number[] = []; for (let k = -hw; k <= hw; k++) wts.push(0.5 + 0.5 * Math.cos(Math.PI * k / (hw + 1))); const wsum = wts.reduce((a, b) => a + b, 0);
  const tPush = { pick: 0.006 + 0.006 * r(), softpick: 0.012 + 0.01 * r(), nail: 0.012 + 0.012 * r(), finger: 0.03 + 0.03 * r(), thumb: 0.04 + 0.04 * r() }[pl];
  const tRel = { pick: 0.00012, softpick: 0.0005, nail: 0.0004, finger: 0.0022 + 0.002 * r(), thumb: 0.004 + 0.003 * r() }[pl];
  const kp = 0.6 * K0 / wsum; const ang = (pl === 'thumb' ? 0.5 : 0.25) + 0.5 * r(); const cy = Math.cos(ang), cz = Math.sin(ang);
  const gam = 0.002 + 0.02 * hard * hard; // fractional tension rise at full pluck displacement
  const sl0 = 1 / (pos * M) ; const S0 = sl0 * sl0 * pos * M + (1 / ((1 - pos) * M)) ** 2 * (1 - pos) * M; // sum of squared slopes of the static triangle at unit displacement
  const lead = 0.004; const nOut = Math.round(dur * SR); const out = new Float32Array(nOut); const total = nOut * OS + FIRD.length;
  const raw = new Float32Array(total);
  const vib = o.vib; const palmN = o.palm ? Math.max(3, Math.round(0.07 * M)) : 0; const palmS = o.palm ? 260 * (0.7 + 0.6 * r()) : 0;
  let eng = 1; let released = false; let relT = 0; let tens = 1; let handS = 0;
  const touchN = Math.round(tPush * fs); const leadN = Math.round(lead * fs);
  for (let n = 0; n < total; n++) {
    const t = n * dt;
    // plectrum position: at rest during lead, then pushes to 1 over tPush, then lets go
    let P = 0; let ke = 0;
    if (n >= leadN && eng > 0) { const u = (n - leadN) / touchN; P = Math.min(1, u); if (u >= 1 && !released) { released = true; relT = t; } if (released) eng = Math.max(0, 1 - (t - relT) / tRel); ke = kp * eng; }
    let Kc = K0 * tens; if (vib && t > (vib.start ?? 0.25)) Kc *= Math.pow(2, 2 * vib.cents * Math.sin(2 * Math.PI * vib.hz * (t - (vib.start ?? 0.25))) * Math.min(1, (t - (vib.start ?? 0.25)) / 0.3) / 1200);
    if (o.stopAt !== undefined && t > o.stopAt + lead) handS = Math.min(o.stopKind === 'hand' ? 220 : 45, handS + (o.stopKind === 'hand' ? 220 : 45) * dt / 0.02);
    const s0 = s0b + handS; let ss = 0;
    // forces from positions (symplectic Euler: velocities first)
    for (let i = 2; i <= M; i++) {
      const d2 = y[i + 1] - 2 * y[i] + y[i - 1]; const d4 = y[i + 2] - 4 * y[i + 1] + 6 * y[i] - 4 * y[i - 1] + y[i - 2]; const dv = vy[i + 1] - 2 * vy[i] + vy[i - 1];
      let a = Kc * d2 - kap * d4 - 2 * s0 * vy[i] + 2 * s1 * dv;
      const e2 = z[i + 1] - 2 * z[i] + z[i - 1]; const e4 = z[i + 2] - 4 * z[i + 1] + 6 * z[i] - 4 * z[i - 1] + z[i - 2]; const ev = vz[i + 1] - 2 * vz[i] + vz[i - 1];
      let b = Kc * Kz * e2 - kap * e4 - 2 * s0 * 0.55 * vz[i] + 2 * s1 * ev;
      if (i > M - palmN) { a -= 2 * palmS * vy[i]; b -= 2 * palmS * vz[i]; }
      vy[i] += a * dt; vz[i] += b * dt; const sy = y[i] - y[i - 1], sz = z[i] - z[i - 1]; ss += sy * sy + sz * sz;
    }
    if (ke > 0) for (let k = -hw; k <= hw; k++) { const i = j0 + k; if (i < 2 || i > M) continue; const w = wts[k + hw]; vy[i] += ke * w * (P * cy - y[i]) * dt; vz[i] += ke * w * (P * cz - z[i]) * dt; if (pl === 'finger' || pl === 'thumb') { vy[i] -= 2 * 400 * eng * vy[i] * dt; vz[i] -= 2 * 400 * eng * vz[i] * dt; } }
    // bridge coupling of the two polarisations (the bridge is not rigid)
    const cpl = 0.01 * K0; vy[M] += cpl * z[M] * dt; vz[M] += cpl * y[M] * dt;
    for (let i = 2; i <= M; i++) { y[i] += vy[i] * dt; z[i] += vz[i] * dt; }
    y[0] = -y[2]; z[0] = -z[2]; y[M + 2] = -y[M]; z[M + 2] = -z[M]; // simply supported ends (ghost points); 1 and M+1 are the fixed ends
    tens = 1 + gam * ss / S0;
    raw[n] = (y[M] + beat * z[M]) * M; // bridge force ~ slope at the bridge
  }
  // decimate
  for (let i = 0; i < nOut; i++) { let s = 0; const b = i * OS; for (let k = 0; k < FIRD.length; k++) s += FIRD[k] * raw[b + k]; out[i] = s; }
  // radiation: force -> sound pressure rises ~6 dB/oct at low f (differentiate, leaky), body modes, air/top resonances
  const main = new Float32Array(nOut); const body = BODY.map(([f, q, g]) => ({ bq: new BQ('bp', f * (0.94 + 0.12 * r()), q), g: g * (o.body ?? 1) * (0.6 + 0.8 * r()) }));
  const hi: { bq: BQ; g: number }[] = []; for (let i = 0; i < 28; i++) hi.push({ bq: new BQ('bp', 800 * Math.pow(6, r()), 18 + 30 * r()), g: 0.3 * (r() < 0.5 ? -1 : 1) * (0.4 + r()) });
  const hp = new BQ('hp', 75, 0.7); let prev = 0;
  for (let i = 0; i < nOut; i++) { const x = out[i]; const d = (x - prev) * 6 + 0.12 * x; prev = x; let v = 0.5 * d; for (const b of body) v += b.g * b.bq.s(d) * 2.2; for (const b of hi) v += b.g * b.bq.s(d); main[i] = hp.s(v); }
  normPeak(main);
  // sympathetic open strings: resonators at the harmonics of the other open strings, driven by the bridge signal
  const sym = new Float32Array(nOut);
  if (!o.noSym) { const res: BQ[] = []; for (let s = 0; s < 6; s++) { if (s === st) continue; const fo = mtof(OPEN[s] + (r() - 0.5) * 0.06); for (let h = 1; h <= 6; h++) { const f = fo * h * Math.sqrt(1 + 8e-5 * h * h); if (f < 3000) res.push(new BQ('bp', f, f * (kind === 'steel' ? 1.6 : 1.0) / (1 + 0.15 * h))); } }
    for (let i = 0; i < nOut; i++) { let v = 0; const x = main[i]; for (const b of res) v += b.s(x); sym[i] = v * 0.05; } }
  return { main, sym };
}

// ------------------------------------------------------------------ voice
export interface VOpts {
  midi: number; dur: number; seed?: number; female?: boolean; vowel?: 'a' | 'o' | 'u' | 'e' | 'i' | 'm';
  onset?: 'soft' | 'normal' | 'hard' | 'h' | 'n'; scoop?: number; /** cents flat at the start */
  vib?: number; vibHz?: number; vibDelay?: number; drift?: number; jitter?: number; breath?: number;
  press?: number; /** 0 = breathy/flow (strong fundamental) .. 1 = pressed/thin (weak fundamental, bright) */
  fadeDbS?: number; /** level falls by this many dB/s over the note (dying hum) */
  bw?: number; /** formant bandwidth multiplier */ rel?: number; /** release time s */ contour?: (t: number) => number; /** extra semitones */ am?: number; /** level wobble with vibrato dB */
}
const VOW: Record<string, [number, number, number][]> = {
  a: [[730, 90, 1], [1090, 100, 0.7], [2440, 140, 0.35], [3400, 200, 0.2], [4400, 260, 0.1]],
  o: [[540, 80, 1], [840, 90, 0.55], [2410, 140, 0.18], [3300, 200, 0.1], [4300, 260, 0.05]],
  u: [[320, 70, 1], [820, 90, 0.3], [2240, 140, 0.1], [3300, 200, 0.05], [4300, 260, 0.03]],
  e: [[520, 80, 1], [1840, 110, 0.5], [2480, 150, 0.3], [3400, 200, 0.15], [4400, 260, 0.07]],
  i: [[290, 60, 1], [2250, 110, 0.4], [3010, 160, 0.3], [3500, 200, 0.12], [4400, 260, 0.06]],
  m: [[250, 70, 1], [1050, 200, 0.06], [2200, 250, 0.03], [3200, 300, 0.01], [4300, 300, 0.005]],
};
export const VOICE_LEAD = 0.03;
export function voice(o: VOpts): Float32Array {
  const r = rng((o.seed ?? 1) * 104729 + Math.round(o.midi * 10)); const n = Math.round((o.dur + VOICE_LEAD + 0.4) * SR); const out = new Float32Array(n);
  const vw = VOW[o.vowel ?? 'a']; const fsc = o.female ? 1.16 : 1; const press = o.press ?? 0.4;
  // cascade of two-pole formant resonators (unity gain at DC, as a vocal tract has), fed by the flow derivative
  const F = vw.map(([f, bw]) => { const fc = f * fsc * (0.96 + 0.08 * r()); const b = bw * (o.bw ?? 1) * (0.85 + 0.3 * r()) * (o.vowel === 'm' && f > 500 ? 2.5 : 1); const C = -Math.exp(-2 * Math.PI * b / SR); const Bc = 2 * Math.exp(-Math.PI * b / SR) * Math.cos(2 * Math.PI * fc / SR); return { A: 1 - Bc - C, B: Bc, C, y1: 0, y2: 0 }; });
  const asp = new BQ('bp', 2200 * fsc, 0.8); const tiltLp = new BQ('lp', 1200 + 3000 * press, 0.6); const nasal = o.vowel === 'm' ? new BQ('lp', 700, 0.7) : null;
  const onT = { soft: 0.22, normal: 0.09, hard: 0.035, h: 0.12, n: 0.1 }[o.onset ?? 'normal'] * (0.8 + 0.4 * r()); const rel = o.rel ?? 0.09;
  const vibHz = o.vibHz ?? (5 + r()); const vibC = o.vib ?? 12; const vibDelay = o.vibDelay ?? 0.35; const jit = o.jitter ?? 0.006; const drift = o.drift ?? 8;
  let x = 1e-3, yv = 0; let ph = 0; let w1 = 0; let prevU = 0; const lam = 120; // radial rate
  const t0 = VOICE_LEAD; const tEnd = t0 + o.dur; let dr = 0; let jn = 0;
  const oq = -0.35 + 0.6 * press; let gl = 0; const gk = 1 - Math.exp(-2 * Math.PI * (120 + 700 * press) / SR); // glottal spectral tilt // waveshaper threshold: higher = shorter open phase = brighter, weaker fundamental
  for (let i = 0; i < n; i++) {
    const t = i / SR; const tt = t - t0;
    // lung pressure -> bifurcation parameter
    let mu = tt < 0 ? -1 : tt < onT ? -1 + 2 * (tt / onT) : 1; if (o.onset === 'hard' && tt >= 0 && tt < 0.08) mu = 1.6 - 0.6 * (tt / 0.08);
    if (t > tEnd) mu = -0.25 * 0.09 / rel;
    const lvl = o.fadeDbS ? db2a(-o.fadeDbS * Math.max(0, tt)) : 1;
    // pitch
    dr += 0.0004 * (gauss(r) - 0.02 * dr); jn = 0.9 * jn + 0.1 * gauss(r);
    let st = o.midi + (o.scoop ? -o.scoop / 100 * Math.exp(-Math.max(0, tt) / 0.07) : 0) + drift / 100 * Math.tanh(dr) + (o.contour ? o.contour(Math.max(0, tt)) : 0);
    const vibOn = Math.max(0, Math.min(1, (tt - vibDelay) / 0.4)); const vs = Math.sin(2 * Math.PI * vibHz * tt + 0.3 * Math.sin(2 * Math.PI * 0.7 * tt)); st += vibC / 100 * vibOn * vs;
    const w = 2 * Math.PI * mtof(st) * (1 + jit * jn) / SR;
    // Hopf oscillator: exact rotation + radial relaxation toward sqrt(mu), noise keeps it alive below threshold
    const c = Math.cos(w), s = Math.sin(w); const nx = x * c - yv * s, ny = x * s + yv * c; const r2 = nx * nx + ny * ny; const g = 1 + lam * (mu - r2) / SR;
    x = nx * g + 2e-4 * gauss(r); yv = ny * g + 2e-4 * gauss(r); ph += w;
    const rad = Math.sqrt(x * x + yv * yv) + 1e-9;
    // glottal flow: skewed (second-harmonic term from the limit cycle) and clipped below (closed phase)
    const sk = x + 0.32 * (2 * x * yv) / rad; let u = sk - oq * rad; u = u > 0 ? u * Math.sqrt(u / (rad * (1 - oq) + 1e-9)) : 0;
    const am = 1 + (o.am ?? 1.0) * 0.115 * vibOn * vs; // level follows the vibrato
    const du = (u - prevU) * am * lvl; prevU = u;
    const br = (o.breath ?? 0.03) * (0.3 * rad + 2 * u) * asp.s(gauss(r)) * lvl + (o.onset === 'h' && tt > -0.02 && tt < 0.07 ? 0.02 * asp.s(gauss(r)) : 0);
    gl += gk * (du - gl); let e = tiltLp.s(gl) * 8 + br; if (o.onset === 'n' && tt < 0.06) e *= 0.35;
    let v = e; for (const f of F) { const y = f.A * v + f.B * f.y1 + f.C * f.y2; f.y2 = f.y1; f.y1 = y; v = y; } if (nasal) v = nasal.s(v);
    w1 = v; out[i] = v; void w1;
  }
  return normPeak(out);
}
/** the app's reference tone through a small phone loudspeaker */
export function refTone(midi: number, dur: number, speakerHp = 450): Float32Array {
  const n = Math.round((dur + 0.4) * SR); const y = new Float32Array(n); const f = mtof(midi); const H = [1, 0.42, 0.22, 0.12, 0.07, 0.04, 0.025, 0.015]; const hp = new BQ('hp', speakerHp, 0.8); const lp = new BQ('lp', Math.min(6000, f * 9), 0.4);
  for (let i = 0; i < n; i++) { const t = i / SR; let e = t < 0.015 ? 0.34 * t / 0.015 : t < 0.18 ? 0.34 * Math.pow(0.22 / 0.34, (t - 0.015) / 0.165) : t < dur - 0.05 ? 0.22 : 0.22 * Math.pow(0.0001 / 0.22, Math.min(1, (t - (dur - 0.05)) / 0.35)); let v = 0; for (let h = 0; h < H.length; h++) v += H[h] * Math.sin(2 * Math.PI * f * (h + 1) * t); v = lp.s(v) * e; v = Math.tanh(v * 1.5) / 1.5; y[i] = hp.s(v); }
  return y;
}
export function thump(seed: number): Float32Array { const r = rng(seed); const n = Math.round(0.3 * SR); const y = new Float32Array(n); const f = 70 + 80 * r(); const bp = new BQ('bp', 1500 + 2000 * r(), 0.7); for (let i = 0; i < n; i++) { const t = i / SR; y[i] = Math.exp(-t / 0.04) * Math.sin(2 * Math.PI * f * t) + 0.6 * Math.exp(-t / 0.006) * bp.s(gauss(r)); } return normPeak(y); }

// ------------------------------------------------------------------ room (modal + velvet tail)
export interface RoomP { L: [number, number, number]; rt: number; /** RT60 mid-band */ rtLow?: number; /** RT60 multiplier at 100 Hz */ src: [number, number, number]; mic: [number, number, number]; seed?: number; fx?: number }
export function roomIR(p: RoomP): Float32Array {
  const c = 343; const [Lx, Ly, Lz] = p.L; const V = Lx * Ly * Lz; const fx = p.fx ?? 1300; const r = rng(p.seed ?? 3);
  const d = Math.hypot(p.src[0] - p.mic[0], p.src[1] - p.mic[1], p.src[2] - p.mic[2]);
  const len = Math.round(Math.min(2.2, p.rt * 1.5 * (p.rtLow ?? 1.3)) * SR); const h = new Float64Array(len);
  const W = (f: number) => f < 0.75 * fx ? 1 : f > fx ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * (f - 0.75 * fx) / (0.25 * fx));
  // modal part
  const nxm = Math.ceil(2 * fx * Lx / c), nym = Math.ceil(2 * fx * Ly / c), nzm = Math.ceil(2 * fx * Lz / c);
  for (let nx = 0; nx <= nxm; nx++) for (let ny = 0; ny <= nym; ny++) for (let nz = 0; nz <= nzm; nz++) {
    if (nx + ny + nz === 0) continue; const f = (c / 2) * Math.sqrt((nx / Lx) ** 2 + (ny / Ly) ** 2 + (nz / Lz) ** 2); if (f > fx) continue;
    const eps = (nx ? 2 : 1) * (ny ? 2 : 1) * (nz ? 2 : 1); const zeros = (nx ? 0 : 1) + (ny ? 0 : 1) + (nz ? 0 : 1);
    const psi = Math.cos(nx * Math.PI * p.src[0] / Lx) * Math.cos(ny * Math.PI * p.src[1] / Ly) * Math.cos(nz * Math.PI * p.src[2] / Lz) * Math.cos(nx * Math.PI * p.mic[0] / Lx) * Math.cos(ny * Math.PI * p.mic[1] / Ly) * Math.cos(nz * Math.PI * p.mic[2] / Lz);
    // axial modes ring longest, oblique shortest; low frequencies ring longer
    const t60 = p.rt * (1 + ((p.rtLow ?? 1.3) - 1) * Math.exp(-f / 250)) * (zeros === 2 ? 1.35 : zeros === 1 ? 1.12 : 0.95) * (0.85 + 0.3 * r());
    const del = 6.91 / t60; const w = 2 * Math.PI * f; const A = (c * c / V) * eps * psi * W(f) / w / SR; // G(t) = c^2/V sum eps psi sin(wt)/w ; per-sample impulse = /SR ... (see scale below)
    const wd = w / SR; const dec = Math.exp(-del / SR); let e = 1; const k2 = 2 * Math.cos(wd); let s1 = 0, s0 = Math.sin(wd); // sin recursion
    const nmax = Math.min(len, Math.round(t60 * 1.3 * SR));
    for (let i = 1; i < nmax; i++) { e *= dec; h[i] += A * e * s0; const s2 = k2 * s0 - s1; s1 = s0; s0 = s2; }
  }
  // free-field direct in the same units: delta(t - d/c) / (4 pi d)  -> one sample of height SR/(4 pi d) ; our modal sum above was divided by SR, so use 1/(4 pi d)
  // (the modal series integrates a delta source; dividing by SR makes it the response to a unit SAMPLE)
  for (let i = 0; i < len; i++) h[i] *= 4 * Math.PI * d; // normalise so the direct sound has unit gain
  // high band: direct + velvet-noise tail with the diffuse-field level for this room and distance
  const hf = new Float64Array(len); const dn = Math.round(d / c * SR); hf[dn] = 1;
  const dc = 0.057 * Math.sqrt(V / p.rt); const revE = (d / dc) * (d / dc); // reverberant/direct energy
  const dens = 2000; const tau = p.rt * 0.85 / 6.91; let e = 0; const tmp = new Float64Array(len); const start = dn + Math.round(0.003 * SR);
  for (let i = start; i < len; i++) if (r() < dens / SR) { const a = (r() < 0.5 ? -1 : 1) * Math.exp(-(i - start) / SR / tau); tmp[i] = a; e += a * a; }
  const lp = new BQ('lp', 5000, 0.6); const g = Math.sqrt(revE / e); for (let i = start; i < len; i++) hf[i] += lp.s(tmp[i]) * g + 0 * tmp[i];
  // complementary crossover on the high band (zero phase, FFT)
  let nf = 1; while (nf < len * 2) nf <<= 1; const re = new Float64Array(nf), im = new Float64Array(nf); re.set(hf); fft(re, im);
  for (let k = 0; k <= nf / 2; k++) { const f = k * SR / nf; const m = 1 - W(f); re[k] *= m; im[k] *= m; if (k > 0 && k < nf / 2) { re[nf - k] = re[k]; im[nf - k] = -im[k]; } }
  fft(re, im, true);
  const out = new Float32Array(len); for (let i = 0; i < len; i++) out[i] = h[i] + re[i];
  // remove the common propagation delay (keep 1 ms)
  const cut = Math.max(0, dn - 48); return out.subarray(cut);
}
/** convolve a dry signal with an impulse response (FFT), output length = x.length + tail */
export function wet(x: Float32Array, ir: Float32Array | null, tail = 1.0): Float32Array {
  if (!ir) return x; const n = x.length + Math.min(ir.length, Math.round(tail * SR)); let nf = 1; while (nf < x.length + ir.length) nf <<= 1;
  const ar = new Float64Array(nf), ai = new Float64Array(nf), br = new Float64Array(nf), bi = new Float64Array(nf); ar.set(x); br.set(ir); fft(ar, ai); fft(br, bi);
  for (let k = 0; k < nf; k++) { const t = ar[k] * br[k] - ai[k] * bi[k]; ai[k] = ar[k] * bi[k] + ai[k] * br[k]; ar[k] = t; } fft(ar, ai, true);
  const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = ar[i]; return out;
}
export function writeWav(path: string, x: Float32Array, fs: typeof import('node:fs'), sr = SR) { const b = Buffer.alloc(44 + 2 * x.length); b.write('RIFF', 0); b.writeUInt32LE(36 + 2 * x.length, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(2 * x.length, 40); for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + 2 * i); fs.writeFileSync(path, b); }
