import './style.css';
import { StablePitch, type PitchFrame } from './core/matcher.ts';
import { RoomCheck } from './core/roomcheck.ts';
import { GUITAR_TOLERANCE_CENTS } from './core/engine.ts';
import { KEY_NAMES, OPEN_STRINGS, degreeLabel, mod, nearestNote, noteName, solfege } from './core/music.ts';
import { Session, summarize, type SessionView } from './core/session.ts';
import { DEFAULT_SETTINGS, updateSetting, type Settings, type SingTolerance } from './core/settings.ts';
import { SONGS, placeTonic, songById, songRange, transpose, validTonics, type Song } from './core/songs.ts';
import { AudioEngine, WakeLock, renderToneOffline } from './ui/audio.ts';
import { button, h, icon } from './ui/dom.ts';
import { createMeter } from './ui/meter.ts';
import { load, save, type Stored } from './ui/storage.ts';

type Screen = 'home' | 'tuner' | 'session' | 'summary';

const app = document.getElementById('app')!;
const store: Stored = load();
const audio = new AudioEngine();
const wake = new WakeLock();

let screen: Screen = 'home';
let session: Session | null = null;
let listenToken = 0;
let listenRunning = false;
let settingsOpen = false;
let pendingResume: number | null = null;

function persist(): void {
  save(store);
}

function currentSong(): Song {
  return songById(store.songId);
}

function currentTonic(): number {
  const song = currentSong();
  const valid = validTonics(song, store.keyPc);
  if (store.tonicMidi !== null && valid.includes(store.tonicMidi)) return store.tonicMidi;
  return placeTonic(song, store.keyPc);
}

function setScreen(s: Screen): void {
  screen = s;
  document.body.dataset.screen = s;
  render();
}

function render(): void {
  app.replaceChildren();
  if (screen === 'home') app.append(homeScreen());
  else if (screen === 'tuner') app.append(tunerScreen());
  else if (screen === 'session') app.append(sessionScreen());
  else if (screen === 'summary') app.append(summaryScreen());
  if (settingsOpen) app.append(settingsPanel());
}

// ---------------------------------------------------------------- Home

function homeScreen(): HTMLElement {
  const song = currentSong();
  const tonic = currentTonic();
  const midis = transpose(song, tonic);
  const { min, max } = songRange(song);
  const valid = validTonics(song, store.keyPc);

  const keyGrid = h('div', { class: 'key-grid', attrs: { role: 'radiogroup', 'aria-label': 'Key' } });
  KEY_NAMES.forEach((name, pc) => {
    keyGrid.append(
      button(name, () => {
        store.keyPc = pc;
        store.tonicMidi = null;
        persist();
        render();
      }, 'key-btn', { role: 'radio', 'aria-checked': pc === store.keyPc ? 'true' : 'false', 'data-key': pc }),
    );
  });

  const octaveRow =
    valid.length > 1
      ? h('div', { class: 'octave-row' },
          ...valid.map((t) =>
            button(`${noteName(t + min, store.keyPc)}–${noteName(t + max, store.keyPc)}`, () => {
              store.tonicMidi = t;
              persist();
              render();
            }, 'chip', { 'aria-pressed': t === tonic ? 'true' : 'false' }),
          ))
      : null;

  const resume = store.resume && store.resume.songId === song.id && store.resume.tonicMidi === tonic && store.resume.index > 0
    ? store.resume.index
    : null;

  const last = store.history.length ? store.history[store.history.length - 1] : null;

  const songList = h('div', { class: 'song-list', attrs: { role: 'radiogroup', 'aria-label': 'Song' } },
    ...SONGS.map((s) =>
      button(h('span', {}, h('strong', { text: s.title }), h('small', { text: `${s.notes.length} notes · ${s.phrases.length} phrases` })), () => {
        store.songId = s.id;
        persist();
        render();
      }, 'song-btn', { role: 'radio', 'aria-checked': s.id === song.id ? 'true' : 'false' }),
    ),
  );

  return h('main', { class: 'screen home', attrs: { 'data-testid': 'home' } },
    h('header', { class: 'brand' },
      h('div', {},
        h('h1', { text: 'Song Pitcher' }),
        h('p', { class: 'muted', text: 'Learn melodies by ear — listen, sing, then find it on guitar.' }),
      ),
      button(icon('gear', 26), () => openSettings(), 'icon-btn', { 'aria-label': 'Settings', 'data-testid': 'open-settings' }),
    ),
    h('section', { class: 'card' }, h('h2', { text: 'Song' }), songList),
    h('section', { class: 'card' },
      h('h2', { text: 'Key' }),
      keyGrid,
      octaveRow,
      h('p', { class: 'range-line', attrs: { 'data-testid': 'range' } },
        `Range ${noteName(tonic + min, store.keyPc)}–${noteName(tonic + max, store.keyPc)}${firstNoteHint(midis[0] - tonic, midis[0])}`),
    ),
    h('div', { class: `actions sticky-actions${resume !== null ? ' two' : ''}` },
      button(h('span', {}, icon('mic', 24), ' Start'), () => void startFlow(null), 'btn primary big', { 'data-testid': 'start' }),
      resume !== null
        ? button(`Resume note ${resume + 1}`, () => void startFlow(resume), 'btn secondary', { 'data-testid': 'resume' })
        : null,
    ),
    last
      ? h('p', { class: 'muted small center' },
          `Last time: ${last.notesDone} notes${last.avgPlayMs !== null ? `, ${(last.avgPlayMs / 1000).toFixed(1)} s avg to find` : ''}${last.completed ? ' · finished' : ''}`)
      : null,
  );
}

/** The first note is part of the exercise: reveal it only as far as the hint settings allow. */
function firstNoteHint(offset: number, midi: number): string {
  if (store.settings.showNoteName) return ` · first note ${noteName(midi, store.keyPc)}`;
  if (store.settings.showDegree) return ` · first note ${degreeLabel(offset)} (${solfege(offset)})`;
  return '';
}

/** Start button: open the mic from inside the tap (gesture), then show the tuner check. */
async function startFlow(resumeAt: number | null): Promise<void> {
  pendingResume = resumeAt;
  setScreen('tuner');
  await enableMic();
}

let micError: string | null = null;

async function enableMic(): Promise<void> {
  micError = null;
  try {
    await audio.init();
  } catch (e) {
    const name = (e as Error)?.name ?? '';
    micError =
      name === 'InsecureContextError'
        ? 'The microphone only works when this page is opened over a secure connection (an https:// address, or localhost). Open the https:// link to this app instead.'
        : name === 'NotAllowedError'
        ? 'Microphone permission was denied. Allow mic access for this site in your browser settings, then tap Try again.'
        : name === 'NotFoundError'
          ? 'No microphone found.'
          : `Could not start the microphone (${(e as Error)?.message ?? e}).`;
  }
  if (screen === 'tuner') render();
}

// ---------------------------------------------------------------- Tuner / mic check

let tunerHeard = false;

/** Within 1 Hz of k·50 or k·60 Hz (k = 1..3): an electrical hum line, not a sung or played note (open D, 146.8 Hz, is 3 Hz from 150). */
function isMainsHum(hz: number): boolean {
  return [50, 60].some((b) => [1, 2, 3].some((k) => Math.abs(hz - b * k) <= 1));
}

function tunerScreen(): HTMLElement {
  const noteEl = h('div', { class: 'tuner-note placeholder', attrs: { 'data-testid': 'tuner-note' }, text: '– –' });
  const hzEl = h('div', { class: 'tuner-hz muted', text: 'Play an open string or sing' });
  const meter = createMeter(50);
  const level = h('div', { class: 'level-fill' });
  const advice = h('p', { class: 'advice', attrs: { 'data-testid': 'tuner-advice', 'aria-live': 'polite' } });
  const strings = h('div', { class: 'strings' },
    ...OPEN_STRINGS.map((m) => h('span', { class: 'string', attrs: { 'data-midi': m }, text: noteName(m) })));
  const stable = new StablePitch();
  meter.set(null, 5, { idle: audio.ready ? 'Listening…' : 'Microphone off' });

  const begin = button(pendingResume !== null ? `Begin at note ${pendingResume + 1}` : 'Begin practice', () => beginSession(), 'btn primary big', { 'data-testid': 'begin' });
  const skipCheck = button('Skip the check', () => beginSession(), 'btn ghost', { 'data-testid': 'skip-check' });
  const setReady = () => {
    begin.disabled = !audio.ready || !tunerHeard;
    skipCheck.hidden = !audio.ready || tunerHeard;
  };
  setReady();

  if (audio.ready) {
    let peakDb = -100;
    let heardFrames = 0;
    let n = 0;
    const room = new RoomCheck();
    audio.listen((f) => {
      const db = 20 * Math.log10(Math.max(f.rms, 1e-6));
      peakDb = Math.max(db, peakDb - 1.5);
      level.style.width = `${Math.max(0, Math.min(100, ((peakDb + 80) / 70) * 100))}%`;
      let m = stable.push(f);
      // Mains hum (50/60 Hz and its low harmonics) is not a note: never show it or count it as heard.
      if (m !== null && isMainsHum(440 * Math.pow(2, (m - 69) / 12))) m = null;
      // (a strum of several strings has no single pitch, but its attack is plainly heard)
      const strum = m === null && (f.attacks ?? []).some((a) => a.band === 'full' && a.riseDb >= 12 && f.t - a.t < 1.5) && db >= peakDb - 20;
      if (m !== null || strum) heardFrames++;
      room.frame(f.t, db, m !== null || strum);
      if (++n % 10 === 0) {
        const sp = audio.spectrumDb();
        if (sp) room.spectrum(sp.db, sp.sampleRate, sp.fftSize);
        const v = room.verdict();
        // (the most important point only: a stack of advice would run under the Begin button)
        const msg = v.messages[0] ?? '';
        if (advice.textContent !== msg) advice.textContent = msg;
        advice.dataset.level = v.level;
        advice.dataset.margin = v.marginDb === null ? '' : String(Math.round(v.marginDb));
        advice.dataset.hum = v.hum === null ? '' : String(v.hum);
      }
      // Begin needs one heard note; a bad room only warns (an honest student is never blocked).
      if (!tunerHeard && heardFrames >= 8) {
        tunerHeard = true;
        setReady();
      }
      if (m === null) {
        meter.set(null, 5, { idle: 'Listening…' });
        return;
      }
      const hz = 440 * Math.pow(2, (m - 69) / 12);
      const nn = nearestNote(hz);
      noteEl.textContent = noteName(nn.midi);
      noteEl.classList.remove('placeholder');
      hzEl.textContent = `${hz.toFixed(1)} Hz`;
      meter.set(nn.cents, 5);
      for (const st of strings.children) (st as HTMLElement).dataset.on = String(Number((st as HTMLElement).dataset.midi) === nn.midi);
    }, () => 'guitar', ['voice']);
  }

  return h('main', { class: 'screen tuner', attrs: { 'data-testid': 'tuner' } },
    h('header', { class: 'topbar' },
      button(icon('back', 26), () => { audio.stopListening(); setScreen('home'); }, 'icon-btn', { 'aria-label': 'Back' }),
      h('h1', { text: 'Mic check & tuner' }),
      h('span', { class: 'icon-btn-spacer' }),
    ),
    h('section', { class: 'card tuner-card' },
      noteEl, hzEl, meter.el,
      h('div', { class: 'level', attrs: { 'aria-label': 'Input level' } }, level),
      strings,
    ),
    micError
      ? h('div', { class: 'error', attrs: { role: 'alert', 'data-testid': 'mic-error' } }, micError, button('Try again', () => void enableMic(), 'btn secondary'))
      : !audio.ready
        ? h('p', { class: 'muted center' }, 'Waiting for microphone permission…')
        : h('div', { class: 'tuner-help' },
            advice,
            h('p', { class: 'muted center' }, 'The note name should follow you. Put the phone on a stand about 50 cm from the guitar.'),
          ),
    h('div', { class: 'actions sticky-actions' }, begin, skipCheck),
  );
}

// ---------------------------------------------------------------- Session

function beginSession(): void {
  audio.stopListening();
  const song = currentSong();
  const tonic = currentTonic();
  session = new Session(song, tonic, store.settings);
  const r = store.resume;
  if (pendingResume !== null && r && r.songId === song.id && r.tonicMidi === tonic) session.restore({ stats: r.stats, reviews: r.reviews });
  session.start(pendingResume ?? 0);
  pendingResume = null;
  void wake.acquire();
  const sess = session;
  audio.listen(onFrame, () => sess.listeningPath());
  setScreen('session');
  if (store.settings.playKeyAtStart) {
    // Key context: the tonic chord (do–mi–sol–do, then together) before the first note.
    void playKey().then(() => runListen(300));
  } else runListen(400);
}

let lastKey = '';
/** Recent accept events, for debugging and the end-to-end test (window.__songPitcherLog). */
const eventLog: { t: number; index: number; phase: string; target: number; detected: number | null; cents: number | null }[] = [];
(window as unknown as { __songPitcherLog: typeof eventLog }).__songPitcherLog = eventLog;
(window as unknown as { __songPitcherRenderTone: typeof renderToneOffline }).__songPitcherRenderTone = renderToneOffline;
/** How the microphone is being read (worklet / script / poll), for the end-to-end test. */
Object.defineProperty(window, '__songPitcherCapture', { get: () => audio.captureMode });
let updateSession: ((v: SessionView) => void) | null = null;

function onFrame(f: PitchFrame): void {
  // Paused while the settings panel is open (nothing is accepted behind it).
  if (!session || screen !== 'session' || settingsOpen || keyPlaying) return;
  const before = session.view();
  const advanced = session.pitch(f);
  if (advanced) {
    const m = session.lastAccepted;
    eventLog.push({ t: +f.t.toFixed(3), index: before.index, phase: before.phase, target: before.targetMidi, detected: m?.detectedMidi ?? null, cents: m?.cents ?? null });
    if (eventLog.length > 200) eventLog.shift();
  }
  const v = session.view();
  if (advanced) {
    flash();
    store.resume = { songId: session.song.id, tonicMidi: session.tonicMidi, index: v.phase === 'done' ? 0 : v.index, stats: v.stats, reviews: v.reviews };
    persist();
  }
  if (v.phase === 'done') {
    finishSession(true);
    return;
  }
  refresh(v);
  if (v.phase === 'listen') runListen(advanced ? 700 : 0);
}

function refresh(v: SessionView, force = false): void {
  const key = `${v.phase}|${v.next}|${v.index}|${v.review?.pos ?? -1}|${v.listenKind}`;
  if (key !== lastKey || force) {
    lastKey = key;
    render();
  } else {
    updateSession?.(v);
  }
}

/** Play the reference for the current 'listen' phase; the mic is ignored until it has decayed. */
function runListen(delayMs = 0): void {
  if (!session || listenRunning || settingsOpen || keyPlaying) return;
  const v = session.view();
  if (v.phase !== 'listen') return;
  listenRunning = true;
  const token = ++listenToken;
  const song = session.song;
  window.setTimeout(async () => {
    if (token !== listenToken || !session) {
      listenRunning = false;
      return;
    }
    const cur = session.view();
    const notes =
      cur.listenKind === 'phrase'
        ? cur.listenNotes.map((n) => ({ midi: n.midi, sec: Math.max(0.12, (n.beats * 60) / song.bpm) }))
        : [{ midi: cur.targetMidi, sec: 0.9 }];
    const chips = cur.listenKind === 'phrase' ? [...document.querySelectorAll<HTMLElement>('.review-chip')] : [];
    await audio.play(notes, (i) => chips.forEach((c, k) => c.classList.toggle('playing', k === i)));
    chips.forEach((c) => c.classList.remove('playing'));
    listenRunning = false;
    if (token !== listenToken || !session) return;
    session.listenDone(audio.now());
    refresh(session.view());
  }, delayMs);
}

let keyPlaying = false;

/** Play the key: do–mi–sol–do' arpeggio then the chord, in the song's octave. Mic is ignored meanwhile. */
async function playKey(): Promise<void> {
  if (!session || keyPlaying) return;
  cancelListen();
  keyPlaying = true;
  if (session) refresh(session.view(), true);
  const t = session.tonicMidi;
  await audio.play([{ midi: t, sec: 0.32 }, { midi: t + 4, sec: 0.32 }, { midi: t + 7, sec: 0.32 }, { midi: t + 12, sec: 0.4 }, { midi: [t, t + 4, t + 7, t + 12], sec: 1.0 }]);
  keyPlaying = false;
  if (!session) return;
  // Mid-step the chord would overwrite the student's memory of the target: replay it.
  const v = session.view();
  if (v.phase === 'sing' || v.phase === 'play' || v.phase === 'review') {
    session.replay();
    refresh(session.view(), true);
    runListen(250);
  } else refresh(v, true);
}

function cancelListen(): void {
  listenToken++;
  listenRunning = false;
  audio.stopPlayback();
}

let flashTimer = 0;
function flash(): void {
  document.body.classList.remove('flash');
  void document.body.offsetWidth;
  document.body.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => document.body.classList.remove('flash'), 650);
}

function finishSession(reachedEnd: boolean): void {
  cancelListen();
  audio.stopListening();
  void wake.release();
  if (session) {
    const v = session.view();
    const sum = summarize(v);
    store.history.push({
      date: new Date().toISOString(), songId: session.song.id, tonicMidi: session.tonicMidi,
      notesDone: sum.notesDone, notesSkipped: sum.notesSkipped, avgPlayMs: sum.avgPlayMs, avgSingCents: sum.avgSingCents,
      // "Completed" means the end was reached with at least one note actually found.
      completed: reachedEnd && sum.notesDone > 0,
    });
    store.history = store.history.slice(-30);
    if (reachedEnd) store.resume = null;
    persist();
  }
  setScreen('summary');
}

const PHASE_TEXT: Record<string, { label: string; hint: string }> = {
  listen: { label: 'Listen', hint: 'Listen to the note…' },
  sing: { label: 'Sing', hint: 'Sing it back' },
  play: { label: 'Play', hint: 'Find it on guitar — this exact octave' },
  review: { label: 'Phrase review', hint: 'Play the phrase in order — any speed, let it ring' },
};

function phaseHint(phase: string): string {
  if (phase === 'sing') return store.settings.singExactOctave ? 'Sing it back — in this octave' : 'Sing it back — any octave';
  return PHASE_TEXT[phase].hint;
}

/**
 * Plain-words reasons for "I hear the right pitch but I'm not accepting it". The octave hints
 * reveal pitch information, so they are only shown with the meter on.
 */
const HINT_TEXT: Record<string, Record<string, string>> = {
  sing: {
    moving: 'Settle on one steady note…',
    carryOver: 'That’s the guitar ringing — now sing it',
    tooShort: 'Hold the note a little longer (about half a second)',
    unclear: 'I can’t hear the pitch clearly — sing a bit louder',
    decaying: 'Strict check: that sounds like the guitar — sing it',
  },
  play: {
    voiceLike: 'That sounded like singing — pluck the string',
    singing: 'I can hear you singing — stop, then pluck the string',
    ringing: 'That’s a note still ringing — pluck again',
    outOfTune: 'Close — this string may be out of tune (check the tuner)',
    moving: 'Stop on the note (no sliding)',
    octaveHigh: 'Right note, one octave too high',
    octaveLow: 'Right note, one octave too low',
    sustained: 'Strict check: let the string ring freely after the pluck',
  },
};
HINT_TEXT.review = HINT_TEXT.play;
// Hints that only appear when the pitch is (nearly) right: hidden when the meter is off.
const PITCH_REVEALING_HINTS = new Set(['octaveHigh', 'octaveLow', 'ringing', 'outOfTune', 'carryOver']);

function targetLabel(midi: number, s: Settings, tonic: number, keyPc: number): { name: string | null; degree: string | null } {
  const off = midi - tonic;
  return {
    name: s.showNoteName ? noteName(midi, keyPc) : null,
    degree: s.showDegree ? `${degreeLabel(off)} · ${solfege(off)}` : null,
  };
}

function sessionScreen(): HTMLElement {
  const s = session!;
  const v = s.view();
  const settings = store.settings;
  const song = s.song;
  const keyPc = mod(s.tonicMidi, 12);
  const phrase = song.phrases.find((p) => v.index >= p.start && v.index <= p.end);
  const effPhase = v.phase === 'listen' ? v.next : v.phase;
  const phaseKey = v.phase === 'listen' ? 'listen' : v.phase;
  const pt = PHASE_TEXT[phaseKey];

  const tl = targetLabel(v.targetMidi, settings, s.tonicMidi, keyPc);
  const target = h('div', { class: 'target', attrs: { 'data-testid': 'target' } },
    tl.name ? h('div', { class: 'target-name', text: tl.name }) : null,
    tl.degree ? h('div', { class: tl.name ? 'target-degree' : 'target-name target-degree-only', text: tl.degree }) : null,
    !tl.name && !tl.degree ? h('div', { class: 'target-name hidden-note', text: '?' }) : null,
  );

  const showMeter =
    v.phase !== 'listen' && ((effPhase === 'sing' && settings.meterSing) || ((effPhase === 'play' || effPhase === 'review') && settings.meterGuitar));
  const meter = createMeter(100);
  const tol = effPhase === 'sing' ? settings.singTolerance : GUITAR_TOLERANCE_CENTS;
  const progress = h('div', { class: 'hold-fill' });
  const hold = h('div', { class: 'hold', attrs: { 'aria-hidden': 'true' } }, progress);
  const status = h('div', { class: 'status', attrs: { 'data-testid': 'status', 'aria-live': 'polite' } });

  let reviewRow: HTMLElement | null = null;
  if (v.review) {
    reviewRow = h('div', { class: 'review-row', attrs: { 'data-testid': 'review-row' } },
      ...v.review.notes.map((m, k) => {
        const lab = targetLabel(m, settings, s.tonicMidi, keyPc);
        return h('span', {
          class: 'review-chip',
          attrs: { 'data-state': k < v.review!.pos ? 'done' : k === v.review!.pos ? 'current' : 'todo' },
          text: lab.name ?? (lab.degree ? degreeLabel(m - s.tonicMidi) : '•'),
        });
      }));
  }

  updateSession = (cur: SessionView) => {
    const m = cur.match;
    // With the meter off, nothing may reveal whether the pitch is right (no progress, neutral text).
    progress.style.width = showMeter ? `${Math.round((m?.progress ?? 0) * 100)}%` : '0%';
    if (keyPlaying) {
      status.textContent = 'Playing the key (do–mi–sol)…';
      if (showMeter) meter.note('Playing the key (do–mi–sol)…');
      return;
    }
    if (cur.phase === 'listen') {
      status.textContent = cur.listenKind === 'phrase' ? 'Playing the phrase…' : 'Playing the note…';
      return;
    }
    if (showMeter) {
      let label: string | undefined;
      if (m?.detectedMidi != null && settings.showNoteName) label = `You: ${noteName(Math.round(m.detectedMidi), keyPc)}`;
      meter.set(m?.cents ?? null, tol, { label, idle: effPhase === 'sing' ? 'Sing now…' : 'Play now…', fretted: effPhase !== 'sing' });
    }
    let hintText = m?.hint ? HINT_TEXT[effPhase]?.[m.hint] : undefined;
    if (hintText && m?.hint && !showMeter && PITCH_REVEALING_HINTS.has(m.hint)) hintText = undefined;
    const listening = effPhase === 'sing' ? 'Listening for your voice…' : 'Listening for the guitar…';
    status.textContent = hintText ?? (!showMeter || (!m?.voiced && !m?.stable) ? listening : m.inTolerance ? (effPhase === 'sing' ? 'Hold it…' : 'Let it ring…') : 'Listening…');
    if (showMeter && hintText) meter.note(hintText);
  };

  const topbar = h('header', { class: 'topbar' },
    button(icon('close', 26), () => endSessionEarly(), 'icon-btn', { 'aria-label': 'End session', 'data-testid': 'end' }),
    h('div', { class: 'topbar-title' },
      h('div', { class: 'note-count', attrs: { 'data-testid': 'note-count' }, text: `Note ${v.index + 1} / ${v.total}` }),
      h('div', { class: 'small muted lyric', text: phrase ? `“${phrase.lyric}”` : song.title }),
    ),
    button(icon('gear', 26), () => openSettings(), 'icon-btn', { 'aria-label': 'Settings', 'data-testid': 'open-settings' }),
  );

  const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill', style: { width: `${(v.index / v.total) * 100}%` } }));

  const replayLabel = effPhase === 'review' ? 'Phrase' : 'Replay';
  const replayBtn = button(h('span', {}, icon('speaker', 24), ` ${replayLabel}`), () => {
    if (!session) return;
    session.replay();
    refresh(session.view());
    runListen(0);
  }, 'btn secondary big', { 'data-testid': 'replay', 'aria-label': effPhase === 'review' ? 'Hear the phrase again' : 'Hear the note again' });
  if (v.phase === 'listen') replayBtn.disabled = true;

  const skipBtn = settings.allowSkip
    ? button(h('span', {}, icon('skip', 22), ' Skip'), () => {
        if (!session) return;
        cancelListen();
        session.skip();
        const nv = session.view();
        if (nv.phase === 'done') return finishSession(true);
        store.resume = { songId: session.song.id, tonicMidi: session.tonicMidi, index: nv.index, stats: nv.stats, reviews: nv.reviews };
        persist();
        refresh(nv);
        runListen(300);
      }, 'btn ghost big', { 'data-testid': 'skip', 'aria-label': effPhase === 'review' ? 'Skip the phrase review' : 'Skip this note' })
    : null;

  const keyBtn = button(h('span', {}, icon('key', 22), ' Key'), () => void playKey(), 'btn ghost big', { 'data-testid': 'key', 'aria-label': 'Hear the key (do–mi–sol)' });
  if (v.phase === 'listen') keyBtn.disabled = true;

  const el = h('main', {
    class: `screen session phase-${phaseKey}`,
    attrs: { 'data-testid': 'session', 'data-phase': v.phase, 'data-next': v.next, 'data-index': v.index, 'data-review-pos': v.review?.pos ?? '' },
  },
    topbar, bar,
    h('section', { class: 'stage' },
      h('div', { class: 'phase-pill', attrs: { 'data-testid': 'phase' }, text: pt.label }),
      h('p', { class: 'hint', text: v.phase === 'listen' ? (v.listenKind === 'phrase' ? 'Listen to the phrase…' : pt.hint) : phaseHint(effPhase) }),
      v.phase === 'listen' ? h('div', { class: 'listen-anim', attrs: { 'aria-hidden': 'true' } }, h('span'), h('span'), h('span'), h('span'), h('span')) : null,
      v.phase === 'listen' ? status : null,
      effPhase === 'review' ? null : target,
      reviewRow,
      v.phase !== 'listen' && showMeter ? meter.el : null,
      v.phase !== 'listen' ? hold : null,
      v.phase !== 'listen' && !showMeter ? status : null,
    ),
    h('div', { class: `controls${skipBtn ? ' three' : ''}` }, replayBtn, keyBtn, skipBtn),
  );
  updateSession(v);
  return el;
}

function endSessionEarly(): void {
  if (!session) return;
  finishSession(false);
}

// ---------------------------------------------------------------- Summary

function fmt(n: number | null, digits = 0, unit = ''): string {
  return n === null ? '–' : `${n.toFixed(digits)}${unit}`;
}

function summaryScreen(): HTMLElement {
  const s = session;
  if (!s) {
    return h('main', { class: 'screen' }, button('Home', () => setScreen('home'), 'btn primary big'));
  }
  const v = s.view();
  const sum = summarize(v);
  const keyPc = mod(s.tonicMidi, 12);
  const done = v.phase === 'done';
  // Only notes that are finished (found or skipped): an unfinished note's name would give it away.
  const finished = (r: (typeof v.stats)[number]) => r.skipped || r.playAttempts !== null || (s.settings.skipGuitar && r.singAttempts !== null);
  const rows = v.stats.filter(finished);
  const allSkipped = sum.notesDone === 0;

  const table = h('table', { class: 'stats-table' },
    h('thead', {}, h('tr', {}, ...['#', 'Note', 'Sing tries', 'Sing ¢', 'Play tries', 'Find', 'Play ¢'].map((t) => h('th', { text: t })))),
    h('tbody', {},
      ...rows.map((r) =>
        h('tr', { attrs: { 'data-skipped': r.skipped } },
          h('td', { text: String(r.index + 1) }),
          // a skipped note was never found: with note names hidden, don't name it here either
          h('td', { text: r.skipped && !store.settings.showNoteName ? '?' : noteName(r.midi, keyPc) }),
          ...(r.skipped
            ? [h('td', { attrs: { colspan: 5 }, class: 'muted', text: 'skipped' })]
            : [
                h('td', { text: fmt(r.singAttempts) }),
                h('td', { text: fmt(r.singCents) }),
                h('td', { text: fmt(r.playAttempts) }),
                h('td', { text: r.playMs === null ? '–' : `${(r.playMs / 1000).toFixed(1)}s` }),
                h('td', { text: fmt(r.playCents) }),
              ]),
        ),
      ),
    ),
  );

  const tile = (label: string, value: string) => h('div', { class: 'tile' }, h('div', { class: 'tile-value', text: value }), h('div', { class: 'tile-label', text: label }));

  return h('main', { class: 'screen summary', attrs: { 'data-testid': 'summary' } },
    h('header', { class: 'topbar' },
      h('span', { class: 'icon-btn-spacer' }),
      h('h1', { attrs: { 'data-testid': 'summary-title' }, text: !done ? 'Session summary' : allSkipped ? 'End reached — every note skipped' : sum.notesSkipped > 0 ? `Song finished (${sum.notesSkipped} skipped)` : 'Song complete!' }),
      h('span', { class: 'icon-btn-spacer' }),
    ),
    h('p', { class: 'muted center' }, `${s.song.title} in ${KEY_NAMES[keyPc]}`),
    h('div', { class: 'tiles' },
      tile('notes found', `${sum.notesDone}`),
      tile('avg time to find', sum.avgPlayMs === null ? '–' : `${(sum.avgPlayMs / 1000).toFixed(1)} s`),
      tile('avg sung ¢ off', fmt(sum.avgSingCents, 0, '¢')),
      tile('avg played ¢ off', fmt(sum.avgPlayCents, 0, '¢')),
      tile('skipped', `${sum.notesSkipped}`),
      tile('phrase reviews', `${v.reviews.filter((r) => !r.skipped).length} · ${sum.reviewMistakes} slips`),
    ),
    h('section', { class: 'card table-card' }, h('h2', { text: 'Per note' }), h('div', { class: 'table-scroll' }, table)),
    h('div', { class: 'actions' },
      button(done ? 'Practice again' : `Continue from note ${v.index + 1}`, () => { pendingResume = done ? null : v.index; setScreen('tuner'); void enableMic(); }, 'btn primary big', { 'data-testid': 'again' }),
      button('Home', () => { session = null; setScreen('home'); }, 'btn secondary big', { 'data-testid': 'home-btn' }),
    ),
  );
}

// ---------------------------------------------------------------- Settings

function openSettings(): void {
  settingsOpen = true;
  // Pause: stop any reference tone; frames are ignored while the panel is open.
  if (session && screen === 'session') cancelListen();
  render();
}

function closeSettings(): void {
  settingsOpen = false;
  lastKey = '';
  render();
  // Resume: replay the reference if we were in (or interrupted) a listen phase.
  if (session && screen === 'session' && session.view().phase === 'listen') runListen(300);
}

function settingsPanel(): HTMLElement {
  const s = store.settings;
  const set = <K extends keyof Settings>(k: K, val: Settings[K]) => {
    store.settings = updateSetting(store.settings, k, val);
    session?.setSettings(store.settings);
    persist();
    render();
  };
  const toggle = (k: keyof Settings, label: string, sub?: string, disabled = false) =>
    h('label', { class: `toggle-row${disabled ? ' disabled' : ''}` },
      h('span', { class: 'toggle-text' }, h('span', { text: label }), sub ? h('small', { class: 'muted', text: sub }) : null),
      h('input', {
        attrs: { type: 'checkbox', role: 'switch', checked: s[k] === true && !disabled, disabled, 'data-setting': k },
        on: { change: (e) => set(k, (e.target as HTMLInputElement).checked as never) },
      }),
    );
  const tolSeg = h('div', { class: 'segmented', attrs: { role: 'radiogroup', 'aria-label': 'Singing tolerance' } },
    ...([50, 35, 25] as SingTolerance[]).map((t) =>
      button(`±${t}¢`, () => set('singTolerance', t), 'seg', { role: 'radio', 'aria-checked': s.singTolerance === t ? 'true' : 'false', 'data-tol': t }),
    ));

  return h('div', { class: 'overlay', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings', 'data-testid': 'settings' } },
    h('div', { class: 'panel' },
      h('header', { class: 'topbar' },
        h('span', { class: 'icon-btn-spacer' }),
        h('h1', { text: 'Settings' }),
        button(icon('check', 26), () => closeSettings(), 'icon-btn', { 'aria-label': 'Done', 'data-testid': 'close-settings' }),
      ),
      h('h2', { class: 'section-title', text: 'Hints' }),
      toggle('showNoteName', 'Show note name', 'e.g. G3'),
      toggle('showDegree', 'Show scale degree', 'e.g. 5 · sol'),
      toggle('meterSing', 'Pitch meter while singing'),
      toggle('meterGuitar', 'Pitch meter on guitar'),
      h('h2', { class: 'section-title', text: 'Singing' }),
      h('div', { class: 'toggle-row' }, h('span', { class: 'toggle-text' }, h('span', { text: 'Tolerance' }), h('small', { class: 'muted', text: 'how close counts as a match' })), tolSeg),
      toggle('singExactOctave', 'Require exact octave', 'off = any octave counts'),
      h('h2', { class: 'section-title', text: 'Steps' }),
      toggle('skipSing', 'Skip singing step'),
      toggle('skipGuitar', 'Skip guitar step'),
      toggle('phraseReview', 'Phrase review', s.skipGuitar ? 'needs the guitar step — off while “Skip guitar step” is on' : 'play each phrase back in order', s.skipGuitar),
      toggle('allowSkip', 'Allow “Skip note” button'),
      h('h2', { class: 'section-title', text: 'Checking' }),
      toggle('strictCheck', 'Strict instrument check', 'extra checks: a sung note must hold its level, a guitar note must start sharply and clearly ring down. Can reject fading singers, very sustained guitars and plucks in echoey rooms.'),
      h('h2', { class: 'section-title', text: 'Sound' }),
      toggle('playKeyAtStart', 'Play the key at the start', 'do–mi–sol chord before the first note (also on the “Key” button)'),
      h('div', { class: 'actions' },
        button('Reset to easy defaults', () => {
          store.settings = { ...DEFAULT_SETTINGS };
          session?.setSettings(store.settings);
          persist();
          render();
        }, 'btn ghost'),
        button('Done', () => closeSettings(), 'btn primary big'),
      ),
    ),
  );
}

// ---------------------------------------------------------------- boot

document.body.dataset.screen = screen;
render();
