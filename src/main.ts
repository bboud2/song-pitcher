import './style.css';
import { StablePitch } from './core/matcher.ts';
import { GUITAR_TOLERANCE_CENTS } from './core/engine.ts';
import { KEY_NAMES, OPEN_STRINGS, degreeLabel, mod, nearestNote, noteName, solfege } from './core/music.ts';
import { Session, summarize, type SessionView } from './core/session.ts';
import { DEFAULT_SETTINGS, updateSetting, type Settings, type SingTolerance } from './core/settings.ts';
import { SONGS, placeTonic, songById, songRange, transpose, validTonics, type Song } from './core/songs.ts';
import { AudioEngine, WakeLock } from './ui/audio.ts';
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
        `Range ${noteName(tonic + min, store.keyPc)}–${noteName(tonic + max, store.keyPc)} · first note ${noteName(midis[0], store.keyPc)}`),
    ),
    h('div', { class: 'actions' },
      button(h('span', {}, icon('mic', 24), ' Start'), () => void startFlow(null), 'btn primary big', { 'data-testid': 'start' }),
      resume !== null
        ? button(`Resume at note ${resume + 1}`, () => void startFlow(resume), 'btn secondary', { 'data-testid': 'resume' })
        : null,
    ),
    last
      ? h('p', { class: 'muted small center' },
          `Last time: ${last.notesDone} notes${last.avgPlayMs !== null ? `, ${(last.avgPlayMs / 1000).toFixed(1)} s avg to find` : ''}${last.completed ? ' · finished' : ''}`)
      : null,
  );
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
      name === 'NotAllowedError'
        ? 'Microphone permission was denied. Allow mic access for this site in your browser settings, then tap Try again.'
        : name === 'NotFoundError'
          ? 'No microphone found.'
          : `Could not start the microphone (${(e as Error)?.message ?? e}).`;
  }
  if (screen === 'tuner') render();
}

// ---------------------------------------------------------------- Tuner / mic check

function tunerScreen(): HTMLElement {
  const noteEl = h('div', { class: 'tuner-note placeholder', attrs: { 'data-testid': 'tuner-note' }, text: '– –' });
  const hzEl = h('div', { class: 'tuner-hz muted', text: 'Play an open string or sing' });
  const meter = createMeter();
  const level = h('div', { class: 'level-fill' });
  const strings = h('div', { class: 'strings' },
    ...OPEN_STRINGS.map((m) => h('span', { class: 'string', attrs: { 'data-midi': m }, text: noteName(m) })));
  const stable = new StablePitch();
  meter.set(null, 10, { idle: audio.ready ? 'Listening…' : 'Microphone off' });

  if (audio.ready) {
    let peakDb = -100;
    audio.listen((f) => {
      const db = 20 * Math.log10(Math.max(f.rms, 1e-6));
      peakDb = Math.max(db, peakDb - 1.5);
      level.style.width = `${Math.max(0, Math.min(100, ((peakDb + 70) / 60) * 100))}%`;
      const m = stable.push(f);
      if (m === null) {
        meter.set(null, 10, { idle: 'Listening…' });
        return;
      }
      const n = nearestNote(440 * Math.pow(2, (m - 69) / 12));
      noteEl.textContent = noteName(n.midi);
      noteEl.classList.remove('placeholder');
      hzEl.textContent = `${(440 * Math.pow(2, (m - 69) / 12)).toFixed(1)} Hz`;
      meter.set(n.cents, 5);
      for (const s of strings.children) (s as HTMLElement).dataset.on = String(Number((s as HTMLElement).dataset.midi) === n.midi);
    });
  }

  const begin = button(pendingResume !== null ? `Begin at note ${pendingResume + 1}` : 'Begin practice', () => beginSession(), 'btn primary big', { 'data-testid': 'begin' });
  if (!audio.ready) begin.disabled = true;

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
      ? h('div', { class: 'error', attrs: { role: 'alert' } }, micError, button('Try again', () => void enableMic(), 'btn secondary'))
      : !audio.ready
        ? h('p', { class: 'muted center' }, 'Waiting for microphone permission…')
        : h('p', { class: 'muted center small' }, 'Strum or pluck: the note name should follow you. Tune each string until the needle sits in the middle. Put the phone ~1 m away on a stand.'),
    h('div', { class: 'actions' }, begin),
  );
}

// ---------------------------------------------------------------- Session

function beginSession(): void {
  audio.stopListening();
  const song = currentSong();
  const tonic = currentTonic();
  session = new Session(song, tonic, store.settings);
  session.start(pendingResume ?? 0);
  pendingResume = null;
  void wake.acquire();
  audio.listen(onFrame);
  setScreen('session');
  runListen(400);
}

let lastKey = '';
/** Recent accept events, for debugging and the end-to-end test (window.__songPitcherLog). */
const eventLog: { t: number; index: number; phase: string; target: number; detected: number | null; cents: number | null }[] = [];
(window as unknown as { __songPitcherLog: typeof eventLog }).__songPitcherLog = eventLog;
let updateSession: ((v: SessionView) => void) | null = null;

function onFrame(f: { t: number; freq: number; clarity: number; rms: number }): void {
  if (!session || screen !== 'session') return;
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
    store.resume = { songId: session.song.id, tonicMidi: session.tonicMidi, index: v.phase === 'done' ? 0 : v.index };
    persist();
  }
  if (v.phase === 'done') {
    finishSession(true);
    return;
  }
  refresh(v);
  if (v.phase === 'listen') runListen(advanced ? 700 : 0);
}

function refresh(v: SessionView): void {
  const key = `${v.phase}|${v.next}|${v.index}|${v.review?.pos ?? -1}|${v.listenKind}`;
  if (key !== lastKey) {
    lastKey = key;
    render();
  } else {
    updateSession?.(v);
  }
}

/** Play the reference for the current 'listen' phase; the mic is ignored until it has decayed. */
function runListen(delayMs = 0): void {
  if (!session || listenRunning) return;
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
        ? cur.listenNotes.map((n) => ({ midi: n.midi, sec: Math.max(0.28, (n.beats * 60) / song.bpm) }))
        : [{ midi: cur.targetMidi, sec: 0.9 }];
    await audio.play(notes);
    listenRunning = false;
    if (token !== listenToken || !session) return;
    session.listenDone(audio.now());
    refresh(session.view());
  }, delayMs);
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

function finishSession(completed: boolean): void {
  cancelListen();
  audio.stopListening();
  void wake.release();
  if (session) {
    const v = session.view();
    const sum = summarize(v);
    store.history.push({
      date: new Date().toISOString(), songId: session.song.id, tonicMidi: session.tonicMidi,
      notesDone: sum.notesDone, notesSkipped: sum.notesSkipped, avgPlayMs: sum.avgPlayMs, avgSingCents: sum.avgSingCents, completed,
    });
    store.history = store.history.slice(-30);
    if (completed) store.resume = null;
    persist();
  }
  setScreen('summary');
}

const PHASE_TEXT: Record<string, { label: string; hint: string }> = {
  listen: { label: 'Listen', hint: 'Listen to the note…' },
  sing: { label: 'Sing', hint: 'Sing it back — any octave' },
  play: { label: 'Play', hint: 'Find it on guitar — this exact octave' },
  review: { label: 'Phrase review', hint: 'Play the phrase on guitar, in order' },
};

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
    tl.degree ? h('div', { class: 'target-degree', text: tl.degree }) : null,
    !tl.name && !tl.degree ? h('div', { class: 'target-name hidden-note', text: '?' }) : null,
  );

  const showMeter =
    v.phase !== 'listen' && ((effPhase === 'sing' && settings.meterSing) || ((effPhase === 'play' || effPhase === 'review') && settings.meterGuitar));
  const meter = createMeter();
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
    progress.style.width = `${Math.round((m?.progress ?? 0) * 100)}%`;
    if (cur.phase === 'listen') {
      status.textContent = cur.listenKind === 'phrase' ? 'Playing the phrase…' : 'Playing the note…';
      return;
    }
    if (showMeter) {
      let label: string | undefined;
      if (m?.detectedMidi != null && settings.showNoteName) label = `You: ${noteName(Math.round(m.detectedMidi), keyPc)}`;
      meter.set(m?.cents ?? null, tol, { label, idle: effPhase === 'sing' ? 'Sing now…' : 'Play now…' });
    }
    status.textContent = !m?.voiced && !m?.stable ? (effPhase === 'sing' ? 'Listening for your voice…' : 'Listening for the guitar…') : m.inTolerance ? 'Hold it…' : 'Listening…';
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

  const replayLabel = effPhase === 'review' ? 'Hear phrase' : 'Hear again';
  const replayBtn = button(h('span', {}, icon('speaker', 24), ` ${replayLabel}`), () => {
    if (!session) return;
    session.replay();
    refresh(session.view());
    runListen(0);
  }, 'btn secondary big', { 'data-testid': 'replay' });
  if (v.phase === 'listen') replayBtn.disabled = true;

  const skipBtn = settings.allowSkip
    ? button(h('span', {}, icon('skip', 22), effPhase === 'review' ? ' Skip review' : ' Skip note'), () => {
        if (!session) return;
        cancelListen();
        session.skip();
        const nv = session.view();
        if (nv.phase === 'done') return finishSession(true);
        refresh(nv);
        runListen(300);
      }, 'btn ghost big', { 'data-testid': 'skip' })
    : null;

  const el = h('main', {
    class: `screen session phase-${phaseKey}`,
    attrs: { 'data-testid': 'session', 'data-phase': v.phase, 'data-next': v.next, 'data-index': v.index, 'data-review-pos': v.review?.pos ?? '' },
  },
    topbar, bar,
    h('section', { class: 'stage' },
      h('div', { class: 'phase-pill', attrs: { 'data-testid': 'phase' }, text: pt.label }),
      h('p', { class: 'hint', text: v.phase === 'listen' ? (v.listenKind === 'phrase' ? 'Listen to the phrase…' : pt.hint) : PHASE_TEXT[effPhase].hint }),
      v.phase === 'listen' ? h('div', { class: 'listen-anim', attrs: { 'aria-hidden': 'true' } }, h('span'), h('span'), h('span'), h('span'), h('span')) : null,
      v.phase === 'listen' ? status : null,
      effPhase === 'review' ? null : target,
      reviewRow,
      v.phase !== 'listen' && showMeter ? meter.el : null,
      v.phase !== 'listen' ? hold : null,
      v.phase !== 'listen' && !showMeter ? status : null,
    ),
    h('div', { class: 'controls' }, replayBtn, skipBtn),
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
  const rows = v.stats.slice(v.startIndex, done ? v.stats.length : v.index + 1);

  const table = h('table', { class: 'stats-table' },
    h('thead', {}, h('tr', {}, ...['#', 'Note', 'Sing tries', 'Sing ¢', 'Play tries', 'Find', 'Play ¢'].map((t) => h('th', { text: t })))),
    h('tbody', {},
      ...rows.map((r) =>
        h('tr', { attrs: { 'data-skipped': r.skipped } },
          h('td', { text: String(r.index + 1) }),
          h('td', { text: noteName(r.midi, keyPc) }),
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
      h('h1', { text: done ? 'Song complete!' : 'Session summary' }),
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
      button('Practice again', () => { pendingResume = done ? null : v.index; setScreen('tuner'); void enableMic(); }, 'btn primary big', { 'data-testid': 'again' }),
      button('Home', () => { session = null; setScreen('home'); }, 'btn secondary big', { 'data-testid': 'home-btn' }),
    ),
  );
}

// ---------------------------------------------------------------- Settings

function openSettings(): void {
  settingsOpen = true;
  render();
}

function closeSettings(): void {
  settingsOpen = false;
  lastKey = '';
  render();
}

function settingsPanel(): HTMLElement {
  const s = store.settings;
  const set = <K extends keyof Settings>(k: K, val: Settings[K]) => {
    store.settings = updateSetting(store.settings, k, val);
    session?.setSettings(store.settings);
    persist();
    render();
  };
  const toggle = (k: keyof Settings, label: string, sub?: string) =>
    h('label', { class: 'toggle-row' },
      h('span', { class: 'toggle-text' }, h('span', { text: label }), sub ? h('small', { class: 'muted', text: sub }) : null),
      h('input', {
        attrs: { type: 'checkbox', role: 'switch', checked: s[k] === true, 'data-setting': k },
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
      toggle('phraseReview', 'Phrase review', 'play each phrase back in order'),
      toggle('allowSkip', 'Allow “Skip note” button'),
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
