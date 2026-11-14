// Small IIR filters shared by the stream analyser and the attack tracker. No DOM.

/** RBJ high-/low-pass biquad (same formulas as Web Audio's BiquadFilterNode). */
export class Biquad {
  private b0: number; private b1: number; private b2: number; private a1: number; private a2: number;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  constructor(sampleRate: number, fc: number, q: number, type: 'highpass' | 'lowpass' = 'highpass') {
    const w = (2 * Math.PI * fc) / sampleRate;
    const alpha = Math.sin(w) / (2 * q);
    const cw = Math.cos(w);
    const a0 = 1 + alpha;
    const k = type === 'highpass' ? 1 + cw : 1 - cw;
    this.b0 = k / 2 / a0;
    this.b1 = (type === 'highpass' ? -k : k) / a0;
    this.b2 = k / 2 / a0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  process(x: Float32Array, out: Float32Array = new Float32Array(x.length)): Float32Array {
    for (let i = 0; i < x.length; i++) {
      const y = this.b0 * x[i] + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x[i]; this.y2 = this.y1; this.y1 = y;
      out[i] = y;
    }
    return out;
  }
}

