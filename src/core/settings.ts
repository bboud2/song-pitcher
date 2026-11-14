// Difficulty settings: types, defaults and normalisation. No DOM (storage lives in src/ui/storage.ts).

export type SingTolerance = 50 | 35 | 25;

export interface Settings {
  showNoteName: boolean;
  showDegree: boolean;
  meterSing: boolean;
  meterGuitar: boolean;
  singTolerance: SingTolerance;
  singExactOctave: boolean;
  skipSing: boolean;
  skipGuitar: boolean;
  phraseReview: boolean;
  allowSkip: boolean;
  /** Play the tonic chord (key context) before the first note. */
  playKeyAtStart: boolean;
  /**
   * Strict instrument check: also judge the sound's envelope (a sung note must hold, a plucked
   * note must ring down freely). Off by default because it can reject honest students
   * (fading singers, compressed or long-sustain guitars).
   */
  strictCheck: boolean;
  /** Keep this session's raw microphone audio and the app's decisions on the device for testing. */
  recordSession: boolean;
}

/** Defaults are the easy end: all hints on, widest tolerance. */
export const DEFAULT_SETTINGS: Settings = {
  showNoteName: true,
  showDegree: true,
  meterSing: true,
  meterGuitar: true,
  singTolerance: 50,
  singExactOctave: false,
  skipSing: false,
  skipGuitar: false,
  phraseReview: true,
  allowSkip: true,
  playKeyAtStart: true,
  strictCheck: false,
  recordSession: false,
};

/** Merge unknown/partial input (e.g. from localStorage) into valid settings. */
export function normalizeSettings(input: unknown): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      if (k === 'singTolerance') continue;
      if (typeof o[k] === 'boolean') (s as unknown as Record<string, boolean>)[k] = o[k] as boolean;
    }
    if (o.singTolerance === 50 || o.singTolerance === 35 || o.singTolerance === 25) s.singTolerance = o.singTolerance;
  }
  // Skipping both steps would leave nothing to do; keep the guitar step.
  if (s.skipSing && s.skipGuitar) s.skipGuitar = false;
  return s;
}

/** Apply one change, keeping the "can't skip both steps" invariant. */
export function updateSetting<K extends keyof Settings>(s: Settings, key: K, value: Settings[K]): Settings {
  const next = { ...s, [key]: value };
  if (key === 'skipSing' && value === true) next.skipGuitar = false;
  if (key === 'skipGuitar' && value === true) next.skipSing = false;
  return normalizeSettings(next);
}
