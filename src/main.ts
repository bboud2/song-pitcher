import './style.css';
import { StablePitch, type PitchFrame } from './core/matcher.ts';
import { RoomCheck } from './core/roomcheck.ts';
import { OctaveSlipFilter, TuneWatch } from './core/tunewatch.ts';
import { GUITAR_TOLERANCE_CENTS } from './core/engine.ts';
import { KEY_NAMES, OPEN_STRINGS, degreeLabel, mod, nearestNote, noteName, solfege } from './core/music.ts';
import { Session, summarize, type SessionView } from './core/session.ts';
import { DEFAULT_SETTINGS, updateSetting, type Settings, type SingTolerance } from './core/settings.ts';
import { SONGS, placeTonic, songById, songRange, transpose, validTonics, type Song } from './core/songs.ts';
import { AudioEngine, WakeLock, renderToneOffline } from './ui/audio.ts';
import { button, h, icon } from './ui/dom.ts';
import { createMeter } from './ui/meter.ts';
import { Recorder, RECORD_MAX_SEC, saveTake, takeName } from './ui/recorder.ts';
import { MemoryStore, recStore, type RecStore, type TakeHeader } from './ui/recstore.ts';
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
  if (settingsOpen) {
    app.append(settingsPanel());
    if (settingsFocus) {
      document.querySelector(`[data-testid="${settingsFocus}"]`)?.scrollIntoView({ block: 'start' });
      settingsFocus = null;
    }
  }
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
    unsavedBanner(),
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
    // out-of-tune strings, judged on plucked strings only (two plucks must agree)
    const watch = new TuneWatch();
    const slips = new OctaveSlipFilter();
    let offOpenNote: { name: string; t: number } | null = null;
    audio.listen((f) => {
      const db = 20 * Math.log10(Math.max(f.rms, 1e-6));
      peakDb = Math.max(db, peakDb - 1.5);
      level.style.width = `${Math.max(0, Math.min(100, ((peakDb + 80) / 70) * 100))}%`;
      let m = stable.push(f);
      watch.push(f.t, m, db, f.attacks ?? [], f.tiltDb ?? null);
      // Mains hum (50/60 Hz and its low harmonics) is not a note: never show it or count it as heard,
      // unless a string was just plucked (a D string 35 c sharp sits right on 150 Hz).
      if (m !== null && isMainsHum(440 * Math.pow(2, (m - 69) / 12)) && !watch.plucking(f.t)) m = null;
      m = slips.push(m);
      // (a strum of several strings has no single pitch, but its attack is plainly heard)
      const strum = m === null && (f.attacks ?? []).some((a) => a.band === 'full' && a.riseDb >= 12 && f.t - a.t < 1.5) && db >= peakDb - 20;
      if (m !== null || strum) heardFrames++;
      room.frame(f.t, db, m !== null || strum);
      if (++n % 10 === 0) {
        const sp = audio.spectrumDb();
        if (sp) room.spectrum(sp.db, sp.sampleRate, sp.fftSize);
        const v = room.verdict();
        // (the most important point only: a stack of advice would run under the Begin button)
        // (a string well out of tune comes first: on a string 40-50 c sharp the fret below sounds
        // close to the right note, and nothing in the session could tell)
        const tuneWarn = watch.message();
        // (a note no open string plays — a fretted note, or a string a semitone or more off — gets
        // no "Good" from the room check: it is not yet a string in tune)
        const offOpen = offOpenNote !== null && f.t - offOpenNote.t < 1.5 ? offOpenNote.name : null;
        const roomMsg = offOpen && v.level !== 'warn' ? `That is ${offOpen}, not an open string — pluck an open string to tune it.` : v.messages[0] ?? '';
        const msg = tuneWarn ?? roomMsg;
        if (advice.textContent !== msg) advice.textContent = msg;
        advice.dataset.level = tuneWarn ? 'warn' : offOpen && v.level !== 'warn' ? 'info' : v.level;
        advice.dataset.tune = tuneWarn ? 'off' : '';
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
      // (the tuner tunes open strings: a centred needle on a note no open string plays would read
      // as "in tune" for a string that may be a semitone off)
      if (OPEN_STRINGS.includes(nn.midi)) {
        meter.set(nn.cents, 5);
        offOpenNote = null;
      } else {
        meter.set(null, 5, { idle: 'Not an open-string note' });
        // (only after a pluck: a sung note is a fine mic check on any pitch)
        offOpenNote = watch.plucking(f.t) ? { name: noteName(nn.midi), t: f.t } : null;
      }
      for (const st of strings.children) (st as HTMLElement).dataset.on = String(Number((st as HTMLElement).dataset.midi) === nn.midi);
    }, () => 'guitar', ['voice']);
  }

  const check = audio.ready && !micError ? soundCheckBlock() : null;
  return h('main', { class: 'screen tuner', attrs: { 'data-testid': 'tuner' } },
    h('header', { class: 'topbar' },
      button(icon('back', 26), () => { audio.stopListening(); setScreen('home'); }, 'icon-btn', { 'aria-label': 'Back' }),
      h('h1', { text: 'Mic check & tuner' }),
      check ? check.startBtn : h('span', { class: 'icon-btn-spacer' }),
    ),
    recActive ? null : unsavedBanner(),
    h('section', { class: 'card tuner-card' },
      noteEl, hzEl, meter.el,
      h('div', { class: 'level', attrs: { 'aria-label': 'Input level' } }, level),
      strings,
      // (which string is which on the guitar itself: the row runs from the thickest to the thinnest)
      h('div', { class: 'strings-key', attrs: { 'data-testid': 'strings-key' } }, h('span', { text: '◀ thickest string' }), h('span', { text: 'thinnest ▶' })),
    ),
    micError
      ? h('div', { class: 'error', attrs: { role: 'alert', 'data-testid': 'mic-error' } }, micError, button('Try again', () => void enableMic(), 'btn secondary'))
      : !audio.ready
        ? h('p', { class: 'muted center' }, 'Waiting for microphone permission…')
        : h('div', { class: 'tuner-help' },
            advice,
            h('p', { class: 'muted center' }, 'The note name should follow you. Phone on a stand, about 50 cm from the guitar.'),
          ),
    check ? check.box : null,
    h('div', { class: 'actions sticky-actions' }, begin, skipCheck),
  );
}

// ---------------------------------------------------------------- Session

// ---------------------------------------------------------------- Practice recorder

/**
 * Guided sound-check recording: a script of the sounds the app has to tell apart, each step naming
 * an open string (so the recording is of known notes). A beep and a large step number mark each
 * change of step.
 */
const SOUND_CHECK: { sec: number; text: string }[] = [
  { sec: 8, text: 'Stay quiet: let the phone hear the room.' },
  { sec: 22, text: 'Pluck each open string once, from the low E string to the high E string, letting each ring.' },
  { sec: 10, text: 'Pluck the open G string, then sing that note and hold it.' },
  { sec: 12, text: 'Pluck the open G string, then sing that note and pluck it again while still singing.' },
  { sec: 8, text: 'Pluck the open D string, then hum its note briefly and let the hum die away. Do not pluck again.' },
  { sec: 8, text: 'Pluck the open A string, then hum its note steadily for 2 seconds.' },
  { sec: 8, text: 'Pluck the open B string three times, stopping it at once with your palm each time.' },
  { sec: 9, text: 'Pluck the open high E string once and let it ring in silence for 4 seconds.' },
];
const SOUND_CHECK_SEC = SOUND_CHECK.reduce((a, x) => a + x.sec, 0);

/**
 * The sound check: started from the ● button in the mic-check header (never under the Begin
 * buttons); while it runs, its step takes the place of the help text and Begin is hidden.
 */
function soundCheckBlock(): { box: HTMLElement; startBtn: HTMLButtonElement } {
  const box = h('section', { class: 'soundcheck', attrs: { 'data-testid': 'soundcheck' } });
  const startBtn = button(icon('rec', 24), () => run(), 'icon-btn rec-btn', { 'aria-label': `Sound check recording (${SOUND_CHECK_SEC} s)`, title: `Sound check recording (${SOUND_CHECK_SEC} s)`, 'data-testid': 'soundcheck-start' }) as HTMLButtonElement;
  const idle = () => {
    document.querySelector('.screen.tuner')?.classList.remove('checking');
    startBtn.disabled = false;
    box.replaceChildren();
  };
  const run = () => {
    if (recActive) return;
    startBtn.disabled = true;
    const r = startRecorder('soundcheck', { script: SOUND_CHECK });
    if (!r) return;
    // (the Begin buttons go away while the check runs: nothing covers the step or Stop)
    document.querySelector('.screen.tuner')?.classList.add('checking');
    const num = h('div', { class: 'soundcheck-num', attrs: { 'data-testid': 'soundcheck-num' } });
    const step = h('p', { class: 'soundcheck-step', attrs: { 'data-testid': 'soundcheck-step' } });
    const count = h('p', { class: 'soundcheck-count muted' });
    const stop = button('Stop', () => finish(), 'btn secondary', { 'data-testid': 'soundcheck-stop' });
    box.replaceChildren(num, step, count, stop);
    box.scrollIntoView({ block: 'start' });
    const t0 = performance.now();
    let k = -1;
    const timer = window.setInterval(() => {
      const el = (performance.now() - t0) / 1000;
      let acc = 0;
      let i = 0;
      while (i < SOUND_CHECK.length && el >= acc + SOUND_CHECK[i].sec) acc += SOUND_CHECK[i++].sec;
      if (i >= SOUND_CHECK.length || !box.isConnected) return finish();
      if (i !== k) {
        k = i;
        num.textContent = `${i + 1} / ${SOUND_CHECK.length}`;
        step.textContent = SOUND_CHECK[i].text;
        recLogTo(r, 'prompt', { step: i, text: SOUND_CHECK[i].text });
        // a short high beep (its sound is in the recording; the log says when)
        void audio.play([{ midi: 96, sec: 0.08 }]);
      }
      count.textContent = `${Math.ceil(acc + SOUND_CHECK[i].sec - el)} s left in this step · recording ${Math.round(r.seconds)} s`;
    }, 200);
    const finish = () => {
      clearInterval(timer);
      recLogTo(r, 'end', {});
      void stopRecorder();
      if (box.isConnected) idle();
    };
  };
  idle();
  return { box, startBtn };
}

/** The recording being made (session or sound check). */
let rec: Recorder | null = null;
let recActive = false;
let recNotice = '';
/** recordings in this browser (newest first), as last listed */
let takes: TakeHeader[] = [];
let storeRef: RecStore | null = null;
/** what the last save did, shown where it was asked for */
let saveMsg: { id: string; text: string; ok: boolean; at: number } | null = null;

async function loadTakes(): Promise<void> {
  storeRef ??= await recStore();
  const all = await storeRef.list();
  // a take left open by a reload or crash is finished as it is
  for (const t of all) if (t.open && t.id !== rec?.head.id) {
    t.open = false;
    await storeRef.putHeader(t);
  }
  takes = all;
}
void loadTakes().then(() => render());

const unsavedTakes = () => takes.filter((t) => !t.saved && t.samples > 0 && t.id !== (recActive ? rec?.head.id : ''));

window.addEventListener('beforeunload', (e) => {
  if (recActive || unsavedTakes().length) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function recMeta(): Record<string, unknown> {
  return {
    userAgent: navigator.userAgent,
    captureMode: audio.captureMode,
    trackSettings: audio.trackSettings(),
    settings: { ...store.settings },
    songId: currentSong().id,
    tonicMidi: currentTonic(),
    clock: audio.clock(),
    storage: storeRef?.persistent ? 'indexeddb' : 'memory',
  };
}

function startRecorder(kind: 'session' | 'soundcheck', extra: Record<string, unknown> = {}, from?: number): Recorder | null {
  if (!audio.ctx) return null;
  storeRef ??= new MemoryStore();
  const r = new Recorder(storeRef, kind, audio.ctx.sampleRate, { ...recMeta(), ...extra }, takeName(kind, new Set(takes.map((t) => t.name))));
  rec = r;
  recActive = true;
  // (what the last save said was about an earlier take: not to be read as this one's)
  saveMsg = null;
  recNotice = '';
  // (the samples since `from` that the analysis already has: the warm-up of a session)
  const pre = audio.prerollSamples();
  const c0 = from ?? audio.received;
  if (c0 < audio.received) r.push(pre.samples.subarray(c0 - pre.cStart), c0);
  audio.tap = (x, c) => r.push(x, c);
  audio.onMute = (from, to) => recLogTo(r, 'mute', { from, to }, to);
  audio.onGap = (c, n) => recLogTo(r, 'gap', { n }, c);
  r.onFull = () => {
    recNotice = `Recording stopped at ${RECORD_MAX_SEC / 60} minutes; the session goes on.`;
    if (screen === 'session' && session) refresh(session.view(), true);
  };
  takes = [r.head, ...takes];
  return r;
}

async function stopRecorder(): Promise<void> {
  const r = rec;
  recActive = false;
  audio.tap = null;
  audio.onMute = null;
  audio.onGap = null;
  if (r) {
    await r.finish();
    await loadTakes();
    render();
  }
}

function recLogTo(r: Recorder, type: string, data: Record<string, unknown> = {}, c = audio.captured): void {
  r.log(c, audio.clockTime(c), type, data);
}

/** Log a session event on the recording (at the current capture index: after the last frame analysed). */
function recLog(type: string, data: Record<string, unknown> = {}, c = audio.captured): void {
  if (rec && recActive && rec.kind === 'session') recLogTo(rec, type, data, c);
}

const fmtSize = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`);
const fmtDur = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
const takeBytes = (t: TakeHeader) => 44 + t.samples * 2;

async function doSave(t: TakeHeader, what: 'wav' | 'log' = 'wav'): Promise<void> {
  if (!storeRef) return;
  saveMsg = { id: t.id, text: 'Preparing the file…', ok: true, at: Date.now() };
  render();
  const res = await saveTake(storeRef, t, what);
  if (res.status === 'shared' || res.status === 'downloaded') {
    if (what === 'wav') {
      t.saved = true;
      await storeRef.putHeader({ ...t, saved: true });
    }
    saveMsg = { id: t.id, at: Date.now(), ok: true, text: `${res.status === 'shared' ? 'Shared' : 'Downloaded'} ${res.files.join(', ')} (${fmtSize(res.bytes)}).${what === 'wav' ? ' The log is inside the WAV file.' : ''}` };
  } else if (res.status === 'cancelled') {
    saveMsg = { id: t.id, at: Date.now(), ok: false, text: 'Share cancelled: the recording was not saved. It is still in Settings → Recordings.' };
  } else {
    saveMsg = { id: t.id, at: Date.now(), ok: false, text: `Could not save: ${res.error ?? 'unknown error'}` };
  }
  await loadTakes();
  render();
}

function saveTakeButton(t: TakeHeader, label = 'Save'): HTMLElement {
  return button(label, () => void doSave(t), 'btn secondary', { 'data-testid': 'save-recording', 'data-take': t.name });
}

/** Banner while a recording in this browser has not been saved: Save, or see all recordings. */
function unsavedBanner(): HTMLElement | null {
  const u = unsavedTakes();
  if (!u.length) {
    // (after a save: say what was saved, until the next screen change)
    return saveMsg && saveMsg.at > Date.now() - 60_000
      ? h('div', { class: `rec-banner${saveMsg.ok ? ' done' : ''}`, attrs: { 'data-testid': 'saved-banner', role: 'status' } }, h('span', { attrs: { 'data-testid': 'save-msg' }, text: saveMsg.text }),
          h('span', { class: 'rec-banner-actions' }, button('Recordings', () => openSettings('recordings'), 'btn ghost', { 'data-testid': 'open-recordings' })))
      : null;
  }
  const t = u[0];
  // (what the last save did — for this take or another one — stays in view for a minute; it is
  // cleared when a new take starts, so it is never read as being about the new one)
  const msg = saveMsg && (saveMsg.id === t.id || saveMsg.at > Date.now() - 60_000) ? saveMsg : null;
  return h('div', { class: 'rec-banner', attrs: { 'data-testid': 'unsaved-banner', role: 'status' } },
    h('span', { text: u.length > 1 ? `${u.length} recordings not saved yet (newest ${fmtDur(t.samples / t.sampleRate)}).` : `Recording not saved yet (${t.kind === 'soundcheck' ? 'sound check, ' : ''}${fmtDur(t.samples / t.sampleRate)}).` }),
    msg ? h('span', { class: msg.ok ? 'small' : 'small warn-text', attrs: { 'data-testid': 'save-msg' }, text: msg.text }) : null,
    // (one Save button saves one take: with several unsaved, the list is where to save them)
    h('span', { class: 'rec-banner-actions' }, saveTakeButton(t, u.length > 1 ? 'Save newest' : 'Save'), button(u.length > 1 ? `All ${u.length} in Recordings` : 'Recordings', () => openSettings('recordings'), 'btn ghost', { 'data-testid': 'open-recordings' })),
  );
}

/** Settings → Recordings: every take in this browser, with Save, Save log and Delete. */
function recordingsSection(): HTMLElement {
  const list = takes.filter((t) => t.samples > 0 || t.open);
  const rows = list.map((t) => {
    const live = recActive && rec?.head.id === t.id;
    const msg = saveMsg && saveMsg.id === t.id ? saveMsg : null;
    const d = new Date(t.createdAt);
    return h('li', { class: 'take', attrs: { 'data-testid': 'take', 'data-take': t.name, 'data-saved': String(t.saved) } },
      h('div', { class: 'take-title', text: `${t.kind === 'soundcheck' ? 'Sound check' : 'Session'} · ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` }),
      h('div', { class: 'small muted', text: `${live ? 'recording now · ' : ''}${fmtDur(t.samples / t.sampleRate)} · ${fmtSize(takeBytes(t))} · capture: ${t.captureMode || '?'}${t.gaps ? ` · ${t.gaps} gap${t.gaps > 1 ? 's' : ''} in the audio` : ''}${t.full ? ' · stopped at the length cap' : ''} · ${t.saved ? 'saved' : 'not saved'}` }),
      h('div', { class: 'small muted take-name', text: `${t.name}.wav` }),
      msg ? h('div', { class: msg.ok ? 'small' : 'small warn-text', attrs: { 'data-testid': 'save-msg' }, text: msg.text }) : null,
      live ? null : h('div', { class: 'take-actions' },
        saveTakeButton(t),
        button('Save log separately', () => void doSave(t, 'log'), 'btn ghost small-btn', { 'data-testid': 'save-log' }),
        button('Delete', async () => {
          if (!t.saved && !confirm('This recording has not been saved. Delete it?')) return;
          await storeRef?.delete(t.id);
          await loadTakes();
          render();
        }, 'btn ghost small-btn', { 'data-testid': 'delete-take' }),
      ),
    );
  });
  return h('section', { class: 'recordings', attrs: { 'data-testid': 'recordings' } },
    h('h2', { class: 'section-title', text: 'Recordings' }),
    h('p', { class: 'small muted', text: storeRef?.persistent === false
      ? 'Recordings are kept in memory on this device only until you close the page (this browser does not allow storing them); nothing is sent anywhere.'
      : 'Recordings are stored in this browser on this device until you delete them; nothing is sent anywhere unless you save or share a file.' }),
    rows.length ? h('ul', { class: 'take-list' }, ...rows) : h('p', { class: 'small muted', attrs: { 'data-testid': 'no-takes' }, text: 'No recordings yet.' }),
    rows.length
      ? button('Delete all recordings', async () => {
          if (!confirm(`Delete all ${list.length} recordings from this browser?`)) return;
          for (const t of list) if (!(recActive && rec?.head.id === t.id)) await storeRef?.delete(t.id);
          await loadTakes();
          render();
        }, 'btn ghost', { 'data-testid': 'delete-all' })
      : null,
  );
}

/**
 * Mark button (recorded sessions): the red REC pill in the top bar — one tap logs a marker at
 * this moment (its sample index); a label can follow from a small panel that goes away by itself.
 */
let markTimer = 0;
let markCount = 0;
function markControl(): HTMLElement {
  // (past the length cap the audio is no longer kept, but marks and the log still are)
  const b = button(rec?.full ? '● Mark (log only)' : '● REC · Mark', () => {
    const id = ++markCount;
    recLog('mark', { id });
    document.querySelector('.mark-panel')?.remove();
    const panel = h('div', { class: 'mark-panel', attrs: { role: 'dialog', 'aria-label': 'What happened?', 'data-testid': 'mark-done' } },
      h('div', { class: 'small', text: `Marked (${id}). What happened? (optional)` }),
      h('div', { class: 'mark-labels' },
        ...['It advanced without me playing', 'It would not accept my note', 'Something else'].map((l) =>
          button(l, () => { recLog('markLabel', { id, label: l }); panel.remove(); }, 'btn ghost small-btn', { 'data-testid': 'mark-label' }))),
    );
    document.body.append(panel);
    clearTimeout(markTimer);
    markTimer = window.setTimeout(() => panel.remove(), 7000);
  }, 'rec-badge mark-btn', { 'data-testid': 'mark', 'aria-label': 'Recording: tap to mark this moment' });
  return b;
}

// Browser Back during a session ends it the way the ✕ button does (the take is kept and the
// summary offers it), instead of leaving the app.
window.addEventListener('popstate', () => {
  if (screen === 'session' && session) finishSession(false);
});

function beginSession(): void {
  try {
    history.pushState({ songPitcher: 'session' }, '');
  } catch {
    /* (some embedded browsers refuse) */
  }
  audio.stopListening();
  const song = currentSong();
  const tonic = currentTonic();
  session = new Session(song, tonic, store.settings);
  const r = store.resume;
  if (pendingResume !== null && r && r.songId === song.id && r.tonicMidi === tonic) session.restore({ stats: r.stats, reviews: r.reviews });
  const startIndex = pendingResume ?? 0;
  session.start(startIndex);
  pendingResume = null;
  void wake.acquire();
  const sess = session;
  setScreen('session');
  // The analysis starts afresh from the last few seconds of input, so a recording (which keeps
  // those seconds) can be replayed from exactly the same state; the first reference plays once
  // that is done (frames before it are not listened to).
  void audio.resetAnalysis().then((warm) => {
    if (session !== sess || screen !== 'session') return;
    if (store.settings.recordSession && !recActive) {
      startRecorder('session', { startIndex, warm }, warm.cWarm);
      recLog('start', { startIndex, sync: sess.syncState() });
      lastKey = '';
      refresh(sess.view());
    }
    audio.listen(onFrame, () => sess.listeningPath());
    if (store.settings.playKeyAtStart) {
      // Key context: the tonic chord (do–mi–sol–do, then together) before the first note.
      void playKey().then(() => runListen(300));
    } else runListen(400);
  });
}

let lastKey = '';
/** Recent accept events, for debugging and the end-to-end test (window.__songPitcherLog). */
const eventLog: { t: number; index: number; phase: string; target: number; detected: number | null; cents: number | null }[] = [];
(window as unknown as { __songPitcherLog: typeof eventLog }).__songPitcherLog = eventLog;
(window as unknown as { __songPitcherRenderTone: typeof renderToneOffline }).__songPitcherRenderTone = renderToneOffline;
/** How the microphone is being read (worklet / script / poll), for the end-to-end test. */
Object.defineProperty(window, '__songPitcherCapture', { get: () => audio.captureMode });
let updateSession: ((v: SessionView) => void) | null = null;
let lastRecHint: string | null = null;

function onFrame(f: PitchFrame): void {
  // Paused while the settings panel is open (nothing is accepted behind it).
  if (!session || screen !== 'session' || settingsOpen || keyPlaying) return;
  const before = session.view();
  const advanced = session.pitch(f);
  if (rec && recActive) {
    const m = session.view().match;
    const hint = m?.hint ?? null;
    if (hint !== lastRecHint) {
      recLog('hint', { phase: before.phase, index: before.index, hint });
      lastRecHint = hint;
    }
    if (advanced) {
      const a = session.lastAccepted;
      recLog('accept', { phase: before.phase, index: before.index, pos: before.review?.pos ?? -1, target: before.targetMidi, detected: a?.detectedMidi ?? null, cents: a?.cents ?? null, reason: a?.reason ?? null });
    }
  }
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
  if (key !== lastKey && session) recLog('step', { phase: v.phase, index: v.index, pos: v.review?.pos ?? -1, target: v.targetMidi, listenKind: v.listenKind, sync: session.syncState() });
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
    const tDone = audio.now();
    session.listenDone(tDone);
    recLog('listenDone', { index: session.view().index, tDone });
    refresh(session.view());
  }, delayMs);
}

let keyPlaying = false;

/** Play the key: do–mi–sol–do' arpeggio then the chord, in the song's octave. Mic is ignored meanwhile. */
async function playKey(): Promise<void> {
  if (!session || keyPlaying) return;
  cancelListen();
  keyPlaying = true;
  recLog('pause', { why: 'key' });
  if (session) refresh(session.view(), true);
  const t = session.tonicMidi;
  await audio.play([{ midi: t, sec: 0.32 }, { midi: t + 4, sec: 0.32 }, { midi: t + 7, sec: 0.32 }, { midi: t + 12, sec: 0.4 }, { midi: [t, t + 4, t + 7, t + 12], sec: 1.0 }]);
  keyPlaying = false;
  recLog('resume', { why: 'key' });
  if (!session) return;
  // Mid-step the chord would overwrite the student's memory of the target: replay it.
  const v = session.view();
  if (v.phase === 'sing' || v.phase === 'play' || v.phase === 'review') {
    recLog('replay');
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
  recLog('end', { reachedEnd });
  if (rec?.kind === 'session' && recActive) void stopRecorder();
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
    refEcho: 'That’s my note still echoing — now you sing it',
    stillSounding: 'That’s the last note still sounding — now you sing it',
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
    tooShort: 'Too short to hear — let the string ring',
    repeatSoft: 'Same note again — pluck it once more, a little firmer',
    octaveHigh: 'Right note, one octave too high',
    octaveLow: 'Right note, one octave too low',
    sustained: 'Strict check: let the string ring freely after the pluck',
  },
};
HINT_TEXT.review = HINT_TEXT.play;
// (for the end-to-end layout test: every hint the session can show)
(window as unknown as { __songPitcherHints: string[] }).__songPitcherHints = [...new Set([...Object.values(HINT_TEXT).flatMap((m) => Object.values(m)), 'Now play the whole phrase, from its first note…', 'Heard a note — still listening…'])];
// Hints that only appear when the pitch is (nearly) right: hidden when the meter is off.
const PITCH_REVEALING_HINTS = new Set(['octaveHigh', 'octaveLow', 'ringing', 'outOfTune', 'carryOver', 'refEcho', 'stillSounding', 'repeatSoft']);

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

  let heardRun = 0;
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
    if (cur.reviewBeat) {
      status.textContent = 'Now play the whole phrase, from its first note…';
      return;
    }
    if (showMeter) {
      // (in the singing step, the guitar note still ringing from before is not the student:
      // the meter waits for the voice instead of saying "too high" before anything was sung)
      const ringingOn = effPhase === 'sing' && (m?.hint === 'carryOver' || m?.hint === 'refEcho' || m?.hint === 'stillSounding');
      let label: string | undefined;
      if (!ringingOn && m?.detectedMidi != null && settings.showNoteName) label = `You: ${noteName(Math.round(m.detectedMidi), keyPc)}`;
      meter.set(ringingOn ? null : (m?.cents ?? null), tol, { label, idle: effPhase === 'sing' ? 'Sing now…' : 'Play now…', fretted: effPhase !== 'sing' });
    }
    let hintText = m?.hint ? HINT_TEXT[effPhase]?.[m.hint] : undefined;
    if (hintText && m?.hint && !showMeter && PITCH_REVEALING_HINTS.has(m.hint)) hintText = undefined;
    const listening = effPhase === 'sing' ? 'Listening for your voice…' : 'Listening for the guitar…';
    // (with the meter off, "heard something, still listening" — that the microphone hears the
    // student — without a word about its pitch or direction)
    // (a pitched sound, held for a few frames: not a knock or a click)
    heardRun = m?.voiced && m.stable && m.detectedMidi != null ? heardRun + 1 : 0;
    const heard = !showMeter && heardRun >= 4 ? 'Heard a note — still listening…' : null;
    status.textContent = hintText ?? heard ?? (!showMeter || (!m?.voiced && !m?.stable) ? listening : m.inTolerance ? (effPhase === 'sing' ? 'Hold it…' : 'Let it ring…') : 'Listening…');
  };

  const topbar = h('header', { class: 'topbar' },
    button(icon('close', 26), () => endSessionEarly(), 'icon-btn', { 'aria-label': 'End session', 'data-testid': 'end' }),
    h('div', { class: 'topbar-title' },
      h('div', { class: 'note-count', attrs: { 'data-testid': 'note-count' }, text: `Note ${v.index + 1} / ${v.total}` }),
      // (while recording, the Mark pill takes the lyric's line: the screen keeps its height)
      recActive && rec?.kind === 'session' ? null : h('div', { class: 'small muted lyric', text: phrase ? `“${phrase.lyric}”` : song.title }),
      recActive && rec?.kind === 'session' ? h('div', { attrs: { 'data-testid': 'rec-badge' } }, markControl()) : null,
    ),
    button(icon('gear', 26), () => openSettings(), 'icon-btn', { 'aria-label': 'Settings', 'data-testid': 'open-settings' }),
  );

  const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill', style: { width: `${(v.index / v.total) * 100}%` } }));

  const replayLabel = effPhase === 'review' ? 'Phrase' : 'Replay';
  const replayBtn = button(h('span', {}, icon('speaker', 24), ` ${replayLabel}`), () => {
    if (!session) return;
    recLog('replay');
    session.replay();
    refresh(session.view());
    runListen(0);
  }, 'btn secondary big', { 'data-testid': 'replay', 'aria-label': effPhase === 'review' ? 'Hear the phrase again' : 'Hear the note again' });
  if (v.phase === 'listen') replayBtn.disabled = true;

  const skipBtn = settings.allowSkip
    ? button(h('span', {}, icon('skip', 22), ' Skip'), () => {
        if (!session) return;
        cancelListen();
        recLog('skip');
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
    recNotice && rec?.kind === 'session' ? h('p', { class: 'small rec-notice', attrs: { 'data-testid': 'rec-notice', role: 'status' }, text: recNotice }) : null,
    h('section', { class: 'stage' },
      h('div', { class: 'phase-pill', attrs: { 'data-testid': 'phase' }, text: pt.label }),
      h('p', { class: 'hint', text: v.phase === 'listen' ? (v.listenKind === 'phrase' ? 'Listen to the phrase…' : pt.hint) : phaseHint(effPhase) }),
      v.phase === 'listen' ? h('div', { class: 'listen-anim', attrs: { 'aria-hidden': 'true' } }, h('span'), h('span'), h('span'), h('span'), h('span')) : null,
      v.phase === 'listen' ? status : null,
      effPhase === 'review' ? null : target,
      reviewRow,
      v.phase !== 'listen' && showMeter ? meter.el : null,
      v.phase !== 'listen' ? hold : null,
      // (always a status line, meter or not: never a blank while a sound is being refused)
      v.phase !== 'listen' ? status : null,
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
    unsavedBanner(),
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

let settingsFocus: string | null = null;
function openSettings(focus: string | null = null): void {
  settingsOpen = true;
  settingsFocus = focus;
  if (session && screen === 'session') recLog('pause', { why: 'settings' });
  // Pause: stop any reference tone; frames are ignored while the panel is open.
  if (session && screen === 'session') cancelListen();
  render();
}

function closeSettings(): void {
  settingsOpen = false;
  if (session && screen === 'session') recLog('resume', { why: 'settings', settings: { ...store.settings } });
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
    if (session && screen === 'session') recLog('settings', { settings: { ...store.settings } });
    persist();
    render();
  };
  const toggle = (k: keyof Settings, label: string, sub?: string, disabled = false, keepValue = false) =>
    h('label', { class: `toggle-row${disabled ? ' disabled' : ''}` },
      h('span', { class: 'toggle-text' }, h('span', { text: label }), sub ? h('small', { class: 'muted', text: sub }) : null),
      h('input', {
        attrs: { type: 'checkbox', role: 'switch', checked: s[k] === true && (!disabled || keepValue), disabled, 'data-setting': k },
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
      h('h2', { class: 'section-title', text: 'Sound' }),
      toggle('playKeyAtStart', 'Play the key at the start', 'do–mi–sol chord before the first note (also on the “Key” button)'),
      h('h2', { class: 'section-title', text: 'Testing' }),
      toggle('recordSession', 'Record sessions for testing',
        screen === 'session' ? 'Turn this on or off before a session starts (it cannot change during one).' : 'keeps the microphone audio and what the app decided, in this browser, until you delete it',
        screen === 'session', true),
      recordingsSection(),
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
