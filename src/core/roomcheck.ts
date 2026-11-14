// Mic / room check logic for the tuner screen. Pure TypeScript, no DOM.
//
// Measures the room noise floor, looks for steady mains hum lines (50/60 Hz and harmonics) in a
// magnitude spectrum, and the level of a test pluck, then says concretely what to fix.

export interface HumLine {
  /** mains base frequency (50 or 60) */
  base: number;
  /** strongest line's prominence above the neighbouring spectrum (dB) */
  prominenceDb: number;
}

/**
 * Find a mains hum line in a dB magnitude spectrum (e.g. AnalyserNode.getFloatFrequencyData).
 * Looks at 50/60 Hz and their 2nd/3rd harmonics; returns the most prominent family, or null.
 */
export function findHumLine(db: Float32Array, sampleRate: number, fftSize: number): HumLine | null {
  const binHz = sampleRate / fftSize;
  let best: HumLine | null = null;
  for (const base of [50, 60]) {
    let prom = -Infinity;
    for (const h of [1, 2, 3]) {
      const bin = Math.round((base * h) / binHz);
      if (bin + 10 >= db.length) continue;
      const line = Math.max(db[bin - 1], db[bin], db[bin + 1]);
      const side: number[] = [];
      for (let k = 4; k <= 10; k++) side.push(db[bin - k], db[bin + k]);
      side.sort((a, b) => a - b);
      const floor = side[side.length >> 1];
      prom = Math.max(prom, line - floor);
    }
    if (!best || prom > best.prominenceDb) best = { base, prominenceDb: prom };
  }
  return best && best.prominenceDb >= 15 ? best : null;
}

export interface RoomVerdict {
  /** 'ok' | 'warn' — never blocks the student */
  level: 'ok' | 'warn' | 'info';
  messages: string[];
  floorDb: number | null;
  pluckDb: number | null;
  marginDb: number | null;
  hum: number | null;
}

/** Aggregates frame levels, detected notes and hum spectra over the mic check. */
export class RoomCheck {
  private levels: { t: number; db: number }[] = [];
  private notePeak = -Infinity;
  private humSeen = new Map<number, number>();
  private humFrames = 0;
  private firstT: number | null = null;

  /** One analysed frame: time, raw level (dBFS) and whether a steady note is being heard. */
  frame(t: number, db: number, hearingNote: boolean): void {
    this.firstT ??= t;
    this.levels.push({ t, db });
    while (this.levels.length && this.levels[0].t < t - 4) this.levels.shift();
    // the note peak decays slowly so an old loud note doesn't hide a later quiet one
    this.notePeak = Math.max(this.notePeak - 0.05, hearingNote ? db : -Infinity);
  }

  /** A spectrum snapshot (call a few times per second). */
  spectrum(db: Float32Array, sampleRate: number, fftSize: number): void {
    this.humFrames++;
    const h = findHumLine(db, sampleRate, fftSize);
    if (h) this.humSeen.set(h.base, (this.humSeen.get(h.base) ?? 0) + 1);
  }

  verdict(): RoomVerdict {
    const sorted = this.levels.map((l) => l.db).sort((a, b) => a - b);
    const floorDb = sorted.length >= 20 ? sorted[Math.floor(sorted.length * 0.1)] : null;
    const pluckDb = Number.isFinite(this.notePeak) ? this.notePeak : null;
    const marginDb = floorDb !== null && pluckDb !== null ? pluckDb - floorDb : null;
    // hum: a line present in most snapshots
    let hum: number | null = null;
    for (const [base, n] of this.humSeen) if (this.humFrames >= 5 && n >= 0.6 * this.humFrames) hum = base;
    const messages: string[] = [];
    let level: RoomVerdict['level'] = 'ok';
    if (hum !== null) {
      level = 'warn';
      messages.push(`Electrical hum at ${hum} Hz. Unplug the phone’s charger and move away from amplifiers, lamps, fridges or dimmer switches.`);
    }
    if (floorDb !== null && floorDb > -45) {
      level = 'warn';
      messages.push(`Background noise is high (${Math.round(floorDb)} dBFS): turn off fans, music or the TV, or move somewhere quieter.`);
    }
    if (marginDb === null) {
      if (level === 'ok') level = 'info';
      messages.push('Test: pluck an open string (or sing a note) so I can measure your level against the room.');
    } else if (marginDb < 15) {
      level = 'warn';
      messages.push(`Your note is only ${Math.round(marginDb)} dB louder than the room. Put the phone closer (about 50 cm from the guitar) or play harder.`);
    } else if (messages.length === 0) {
      messages.push(`Good: your note is ${Math.round(marginDb)} dB above the room noise.`);
    }
    return { level, messages, floorDb, pluckDb, marginDb, hum };
  }
}
