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
  // (the two bins bracketing the exact frequency: at ~6 Hz per bin, ±1 bin around 50 Hz would
  // already include 60 Hz; the family with the most prominent harmonics in total wins)
  let bestScore = -Infinity;
  for (const base of [50, 60]) {
    let prom = -Infinity;
    let score = 0;
    for (const h of [1, 2, 3]) {
      const x = (base * h) / binHz;
      const bin = Math.floor(x);
      if (bin + 11 >= db.length || bin < 1) continue;
      const line = Math.max(db[bin], db[bin + 1]);
      const side: number[] = [];
      for (let k = 4; k <= 10; k++) {
        if (bin - k >= 1) side.push(db[bin - k]);
        side.push(db[bin + 1 + k]);
      }
      side.sort((a, b) => a - b);
      const p = line - side[side.length >> 1];
      prom = Math.max(prom, p);
      score += Math.max(0, p);
    }
    if (score > bestScore) {
      bestScore = score;
      best = { base, prominenceDb: prom };
    }
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
  /** levels of frames where a note was heard (last few seconds) */
  private notes: { t: number; db: number }[] = [];
  private humSeen = new Map<number, number>();
  private humFrames = 0;
  private hearing = false;
  private good = false;
  private lastNoteT = -Infinity;

  /** One analysed frame: time, raw level (dBFS) and whether a steady note is being heard. */
  frame(t: number, db: number, hearingNote: boolean): void {
    // The room is measured only while no note sounds — not during a note, and not in the 2 s
    // after one (its ring) — over the last 10 s.
    if (hearingNote) this.lastNoteT = t;
    if (!hearingNote && t - this.lastNoteT > 2) this.levels.push({ t, db });
    while (this.levels.length && this.levels[0].t < t - 10) this.levels.shift();
    // the loudest note of the last 20 s (a steady figure, not one that sinks while you watch)
    if (hearingNote) this.notes.push({ t, db });
    while (this.notes.length && this.notes[0].t < t - 20) this.notes.shift();
    this.hearing = hearingNote || t - this.lastNoteT < 2;
  }

  /**
   * A spectrum snapshot (call a few times per second). Only judged while no note is heard: a
   * plucked D string (146.8 Hz) sits right next to the 150 Hz hum line.
   */
  spectrum(db: Float32Array, sampleRate: number, fftSize: number): void {
    if (this.hearing) return;
    this.humFrames++;
    const h = findHumLine(db, sampleRate, fftSize);
    if (h) this.humSeen.set(h.base, (this.humSeen.get(h.base) ?? 0) + 1);
  }

  verdict(): RoomVerdict {
    const sorted = this.levels.map((l) => l.db).sort((a, b) => a - b);
    const floorDb = sorted.length >= 20 ? sorted[Math.floor(sorted.length * 0.1)] : null;
    const pluckDb = this.notes.length ? Math.max(...this.notes.map((n) => n.db)) : null;
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
    } else if (marginDb < (this.good ? 12 : 15)) {
      // (a little hysteresis so the verdict doesn't flicker around the threshold)
      this.good = false;
      level = 'warn';
      messages.push(`Your note is only ${Math.round(marginDb)} dB louder than the room. Put the phone closer (about 50 cm from the guitar) or play harder.`);
    } else if ((this.good = true) && messages.length === 0) {
      messages.push(`Good: your note is ${Math.round(marginDb)} dB above the room noise.`);
    }
    return { level, messages, floorDb, pluckDb, marginDb, hum };
  }
}
