// localStorage persistence for settings, song/key choice, resume point and session history.
import { normalizeSettings, type Settings } from '../core/settings.ts';

const KEY = 'songPitcher.v1';

export interface HistoryEntry {
  date: string;
  songId: string;
  tonicMidi: number;
  notesDone: number;
  notesSkipped: number;
  avgPlayMs: number | null;
  avgSingCents: number | null;
  completed: boolean;
}

export interface Stored {
  settings: Settings;
  songId: string;
  keyPc: number;
  tonicMidi: number | null;
  /** Where to resume an unfinished session. */
  resume: { songId: string; tonicMidi: number; index: number } | null;
  history: HistoryEntry[];
}

function defaults(): Stored {
  return { settings: normalizeSettings({}), songId: 'star-spangled-banner', keyPc: 0, tonicMidi: null, resume: null, history: [] };
}

export function load(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const o = JSON.parse(raw) as Partial<Stored>;
    const d = defaults();
    return {
      settings: normalizeSettings(o.settings),
      songId: typeof o.songId === 'string' ? o.songId : d.songId,
      keyPc: typeof o.keyPc === 'number' && o.keyPc >= 0 && o.keyPc < 12 ? Math.floor(o.keyPc) : d.keyPc,
      tonicMidi: typeof o.tonicMidi === 'number' ? o.tonicMidi : null,
      resume: o.resume && typeof o.resume.index === 'number' ? o.resume : null,
      history: Array.isArray(o.history) ? o.history.slice(-30) : [],
    };
  } catch {
    return defaults();
  }
}

export function save(s: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full or blocked (private mode): keep working without persistence */
  }
}
