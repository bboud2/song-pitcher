// Song data stored relative to the tonic, so any song plays in any key. No DOM.
import { GUITAR_HIGH_MIDI, GUITAR_LOW_MIDI, mod } from './music.ts';

export interface SongNote {
  /** Semitones above the song's reference tonic (the "low do"). May be negative. */
  offset: number;
  /** Duration in beats (quarter note = 1). */
  beats: number;
}

export interface Phrase {
  /** Index of the first note of the phrase. */
  start: number;
  /** Index of the last note of the phrase (inclusive). */
  end: number;
  lyric: string;
}

export interface Song {
  id: string;
  title: string;
  /** Default key (tonic pitch class, 0 = C). */
  defaultKeyPc: number;
  /** Default tonic MIDI note in the default key (e.g. 48 = C3). */
  defaultTonicMidi: number;
  /** Tempo for phrase playback, quarter notes per minute. */
  bpm: number;
  notes: SongNote[];
  phrases: Phrase[];
}

const DEGREE_SEMITONES: Record<string, number> = {
  '1': 0, '#1': 1, 'b2': 1, '2': 2, '#2': 3, 'b3': 3, '3': 4, '4': 5, '#4': 6, 'b5': 6,
  '5': 7, '#5': 8, 'b6': 8, '6': 9, '#6': 10, 'b7': 10, '7': 11,
};

/**
 * Parse a compact melody string: tokens "degree[octave marks]:beats", e.g. "5,:0.75 1:1 1':2".
 * A trailing ' raises an octave, a trailing , lowers one.
 */
export function parseMelody(src: string): SongNote[] {
  return src
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const [deg, beatsStr] = tok.split(':');
      const m = /^([#b]?\d)([',]*)$/.exec(deg);
      if (!m || !(m[1] in DEGREE_SEMITONES)) throw new Error(`bad degree token: ${tok}`);
      let offset = DEGREE_SEMITONES[m[1]];
      for (const ch of m[2]) offset += ch === "'" ? 12 : -12;
      const beats = Number(beatsStr);
      if (!(beats > 0)) throw new Error(`bad beats in token: ${tok}`);
      return { offset, beats };
    });
}

function buildSong(
  meta: Omit<Song, 'notes' | 'phrases'>,
  phrases: { lyric: string; melody: string }[],
): Song {
  const notes: SongNote[] = [];
  const outPhrases: Phrase[] = [];
  for (const p of phrases) {
    const ns = parseMelody(p.melody);
    outPhrases.push({ start: notes.length, end: notes.length + ns.length - 1, lyric: p.lyric });
    notes.push(...ns);
  }
  return { ...meta, notes, phrases: outPhrases };
}

/**
 * "The Star-Spangled Banner" (melody: John Stafford Smith; words: Francis Scott Key, 1814). Public domain.
 * Degrees are relative to the low tonic ("1" = do). In C it spans C3 (do) to G4 (high sol).
 * 3/4 time; beats in quarter notes. Phrase boundaries split each line in half for phrase review.
 *
 * Checked against four independent ABC transcriptions (community transcriptions, not an
 * authoritative edition — none was reachable from the build environment):
 *   - github.com/avnerdorman/abc-solfege-tool songs/Anachreon_in_Heaven_3V-D-32-2.abc
 *     (fife part, transcribed by John Chambers from ancients.sudburymuster.org fyf02F.pdf)
 *   - github.com/abdulhaim/abc_karaoke_project sample-abc/star_spangled_banner.abc (with lyrics)
 *   - github.com/syntithenai/abc2book abcresources/jc/abc_tune_jc_201217968.abc
 *   - github.com/tljameswade/comp504 HW06/src/songs/star_spangled.abc
 * All four agree on every pitch below. Where all four agreed on a rhythm it was corrected:
 * "at the" (twilight's / gallantly) and "does that" are straight eighths, and "banner yet wave"
 * is 2'(1) 4' 3' 2' 1' (eighths) | 1'(1) 7(1) — 101 notes in all.
 * "that our flag" is the same figure as "at the twilight's" and is written the same way
 * (straight eighths; the sources split on it).
 * Still disputed (sources split 2–2; left as is, please check by ear): "What so" / "O'er the
 * ramparts" (straight vs dotted eighths), "And the rockets'", "O'er the land", "and the home"
 * (same question).
 */
export const STAR_SPANGLED_BANNER: Song = buildSong(
  { id: 'star-spangled-banner', title: 'The Star-Spangled Banner', defaultKeyPc: 0, defaultTonicMidi: 48, bpm: 84 },
  [
    { lyric: 'O say can you see', melody: "5:0.75 3:0.25 1:1 3:1 5:1 1':2" },
    { lyric: "by the dawn's early light", melody: "3':0.75 2':0.25 1':1 3:1 #4:1 5:2" },
    { lyric: 'What so proudly we hailed', melody: "5:0.5 5:0.5 3':1.5 2':0.5 1':1 7:2" },
    { lyric: "at the twilight's last gleaming?", melody: "6:0.5 7:0.5 1':1 1':1 5:1 3:1 1:1" },
    { lyric: 'Whose broad stripes and bright stars', melody: "5:0.75 3:0.25 1:1 3:1 5:1 1':2" },
    { lyric: 'through the perilous fight,', melody: "3':0.75 2':0.25 1':1 3:1 #4:1 5:2" },
    { lyric: "O'er the ramparts we watched", melody: "5:0.5 5:0.5 3':1.5 2':0.5 1':1 7:2" },
    { lyric: 'were so gallantly streaming?', melody: "6:0.5 7:0.5 1':1 1':1 5:1 3:1 1:1" },
    { lyric: "And the rockets' red glare,", melody: "3':0.5 3':0.5 3':1 4':1 5':1 5':2" },
    { lyric: 'the bombs bursting in air,', melody: "4':0.5 3':0.5 2':1 3':1 4':1 4':2" },
    { lyric: 'Gave proof through the night', melody: "4':1 3':1.5 2':0.5 1':1 7:2" },
    { lyric: 'that our flag was still there;', melody: "6:0.5 7:0.5 1':1 3:1 #4:1 5:2" },
    { lyric: 'O say does that star-spangled', melody: "5:1 1':1 1':1 1':0.5 7:0.5 6:1 6:1 6:1" },
    { lyric: 'banner yet wave', melody: "2':1 4':0.5 3':0.5 2':0.5 1':0.5 1':1 7:1" },
    { lyric: "O'er the land of the free", melody: "5:0.5 5:0.5 1':1.5 2':0.5 3':0.5 4':0.5 5':2" },
    { lyric: 'and the home of the brave?', melody: "1':0.5 2':0.5 3':1.5 4':0.5 2':1 1':3" },
  ],
);

export const SONGS: Song[] = [STAR_SPANGLED_BANNER];

export function songById(id: string): Song {
  return SONGS.find((s) => s.id === id) ?? SONGS[0];
}

export function songRange(song: Song): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const n of song.notes) {
    min = Math.min(min, n.offset);
    max = Math.max(max, n.offset);
  }
  return { min, max };
}

/**
 * Pick the tonic MIDI note for a key so the whole melody fits on guitar (E2..E5),
 * preferring the placement closest to the song's default register.
 */
export function placeTonic(
  song: Song,
  keyPc: number,
  low = GUITAR_LOW_MIDI,
  high = GUITAR_HIGH_MIDI,
): number {
  const { min, max } = songRange(song);
  const preferredCenter = song.defaultTonicMidi + (min + max) / 2;
  const candidates: number[] = [];
  for (let tonic = mod(keyPc, 12); tonic < 128; tonic += 12) {
    if (tonic + min >= low && tonic + max <= high) candidates.push(tonic);
  }
  if (candidates.length === 0) {
    // Melody wider than the range: choose the placement whose lowest note is closest above `low`.
    let t = mod(keyPc, 12);
    while (t + min < low) t += 12;
    return t;
  }
  let best = candidates[0];
  let bestDist = Infinity;
  for (const t of candidates) {
    const d = Math.abs(t + (min + max) / 2 - preferredCenter);
    if (d < bestDist - 1e-9) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}

/** Alternative tonic placements (octaves) that still fit in guitar range. */
export function validTonics(song: Song, keyPc: number): number[] {
  const { min, max } = songRange(song);
  const out: number[] = [];
  for (let t = mod(keyPc, 12); t < 128; t += 12) {
    if (t + min >= GUITAR_LOW_MIDI && t + max <= GUITAR_HIGH_MIDI) out.push(t);
  }
  return out;
}

/** Absolute MIDI notes for a song placed at a tonic. */
export function transpose(song: Song, tonicMidi: number): number[] {
  return song.notes.map((n) => tonicMidi + n.offset);
}

/** Phrase that ends at note index `i`, if any. */
export function phraseEndingAt(song: Song, i: number): Phrase | undefined {
  return song.phrases.find((p) => p.end === i);
}

export function phraseContaining(song: Song, i: number): Phrase | undefined {
  return song.phrases.find((p) => i >= p.start && i <= p.end);
}
