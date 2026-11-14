// End-to-end test: real app in Chromium with phone emulation and a fake microphone fed from
// generated WAV files. Also writes phone-size screenshots of every main screen to e2e/out/screenshots/
// (git-ignored); pass --refresh-screenshots to write them to the tracked screenshots/ folder instead.
//
//   npm run e2e          (builds, serves dist/ with vite preview, runs both devices)
//   flags: --device=iphone13|pixel7  --no-build  --skip-negatives  --refresh-screenshots
//
// Uses the globally installed `playwright` package and its bundled Chromium.
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { buildWavs } from './wavs.ts';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadPlaywright(): any {
  try {
    return require('playwright');
  } catch {
    const root = execSync('npm root -g').toString().trim();
    return require(join(root, 'playwright'));
  }
}
const pw = loadPlaywright();

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'e2e', 'out');
const SHOTS = process.argv.includes('--refresh-screenshots') ? join(ROOT, 'screenshots') : join(ROOT, 'e2e', 'out', 'screenshots');
const PORT = 4179;
const URL = `http://localhost:${PORT}/`;
const DEVICES: { name: string; slug: string }[] = [
  { name: 'iPhone 13', slug: 'iphone13' },
  { name: 'Pixel 7', slug: 'pixel7' },
];

let failures = 0;
const results: string[] = [];
function check(cond: boolean, msg: string): void {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
}

async function startServer(): Promise<ChildProcess> {
  const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host'], { cwd: ROOT, stdio: 'pipe' });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(URL);
      if (r.ok) return p;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  p.kill();
  throw new Error('preview server did not start');
}

async function launch(wav: string) {
  const opts = {
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  };
  try {
    return await pw.chromium.launch(opts);
  } catch {
    return await pw.chromium.launch({ ...opts, executablePath: '/opt/pw-browsers/chromium' });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Page = any;

async function attr(page: Page, name: string): Promise<string | null> {
  return page.evaluate((n: string) => document.querySelector('[data-testid="session"]')?.getAttribute(n) ?? null, name);
}

/** Wait until the session root matches a predicate on (phase, index, reviewPos). */
async function waitSession(page: Page, pred: string, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForFunction(
      (p: string) => {
        const el = document.querySelector('[data-testid="session"]');
        if (!el) return false;
        const phase = el.getAttribute('data-phase');
        const index = Number(el.getAttribute('data-index'));
        const reviewPos = el.getAttribute('data-review-pos');
        return new Function('phase', 'index', 'reviewPos', `return (${p});`)(phase, index, reviewPos);
      },
      pred,
      { timeout: timeoutMs, polling: 50 },
    );
    return true;
  } catch {
    return false;
  }
}

async function shot(page: Page, slug: string, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${slug}-${name}.png`) });
}

async function correctRun(device: { name: string; slug: string }, wav: string): Promise<void> {
  const browser = await launch(wav);
  const ctx = await browser.newContext({ ...pw.devices[device.name] });
  await ctx.grantPermissions(['microphone'], { origin: URL });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('console', (m: { type(): string; text(): string }) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const tag = `[${device.name}]`;
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('[data-testid="home"]');
  check((await page.textContent('[data-testid="range"]'))?.includes('C3–G4') ?? false, `${tag} default key C shows range C3–G4`);
  // Key picker: F should place F3–C5, then back to C
  await page.click('[data-key="5"]');
  check((await page.textContent('[data-testid="range"]'))?.includes('F3–C5') ?? false, `${tag} key F places melody F3–C5`);
  await page.click('[data-key="0"]');
  await shot(page, device.slug, '1-home');

  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings"]');
  await shot(page, device.slug, '8-settings');
  // persisted setting round-trip
  await page.click('[data-tol="35"]');
  await page.click('[data-tol="50"]');
  const stored = await page.evaluate(() => localStorage.getItem('songPitcher.v1'));
  check(!!stored && stored.includes('"singTolerance":50'), `${tag} settings persisted to localStorage`);
  await page.click('[data-testid="close-settings"]');

  await page.click('[data-testid="start"]');
  await page.waitForSelector('[data-testid="tuner"]');
  await page.waitForSelector('[data-testid="begin"]:not([disabled])', { timeout: 10000 });
  // Let the tuner hear something (lead-in is silence; wait for the first sung note) for the screenshot.
  const heard = await page.waitForSelector('[data-testid="tuner-note"]:not(.placeholder)', { timeout: 10000 }).then(() => true, () => false);
  check(heard, `${tag} tuner shows a detected note from the mic (${heard ? await page.textContent('[data-testid="tuner-note"]') : 'none'})`);
  await page.waitForTimeout(300);
  await shot(page, device.slug, '2-tuner');

  // Every 20 ms hop must be analysed (the attack tracker needs every sample): an AudioWorklet in
  // Chromium, with the timer fallbacks only for browsers without one.
  const mode = await page.evaluate(() => (window as unknown as { __songPitcherCapture: string }).__songPitcherCapture);
  check(mode === 'worklet', `${tag} microphone read by the AudioWorklet (got ${mode})`);
  await page.click('[data-testid="begin"]');
  await page.waitForSelector('[data-testid="session"]');
  check(await waitSession(page, `phase === 'listen' && index === 0`, 3000), `${tag} session starts in listen on note 1 (${elapsed()})`);
  await shot(page, device.slug, '3-listen');
  check(await waitSession(page, `phase === 'sing' && index === 0`, 8000), `${tag} reference finished → sing step (${elapsed()})`);
  await page.waitForTimeout(250);
  await shot(page, device.slug, '4-sing');
  let playShot = false;
  for (let i = 0; i < 6; i++) {
    const okSing = await waitSession(page, `index > ${i} || (index === ${i} && phase === 'play')`, 40000);
    check(okSing, `${tag} note ${i + 1}: sung note accepted (${elapsed()})`);
    if (!playShot && (await attr(page, 'data-phase')) === 'play') {
      await page.waitForTimeout(150);
      await shot(page, device.slug, '5-play');
      playShot = true;
    }
    const okPlay = await waitSession(page, i < 5 ? `index > ${i}` : `index > 5 || phase === 'review'`, 40000);
    check(okPlay, `${tag} note ${i + 1}: guitar note accepted → advanced (${elapsed()})`);
  }
  check(await waitSession(page, `phase === 'review' && index === 5`, 5000), `${tag} phrase review starts after note 6 (${elapsed()})`);
  await page.waitForTimeout(100);
  await shot(page, device.slug, '6-review');
  check(await waitSession(page, `phase === 'review' && Number(reviewPos) >= 3`, 40000), `${tag} review progresses in order (pos ≥ 3) (${elapsed()})`);
  check(await waitSession(page, `index === 6`, 40000), `${tag} review complete → note 7 (${elapsed()})`);
  check(await waitSession(page, `index === 7`, 45000), `${tag} note 7 sung + played → note 8 (${elapsed()})`);

  // Settings overlay pauses the session: note 8's sung segment plays while the panel is open.
  await page.click('[data-testid="open-settings"]');
  const pausedAt = await attr(page, 'data-phase');
  await page.waitForTimeout(5000);
  const stillIdx = await attr(page, 'data-index');
  const stillPhase = await attr(page, 'data-phase');
  check(stillIdx === '7' && (stillPhase === 'sing' || stillPhase === 'listen'), `${tag} session paused behind settings for 5 s (phase ${pausedAt} → ${stillPhase}, note ${Number(stillIdx) + 1})`);
  await page.click('[data-testid="close-settings"]');

  await page.click('[data-testid="end"]');
  await page.waitForSelector('[data-testid="summary"]');
  const rows = await page.$$eval('.stats-table tbody tr', (trs: Element[]) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)));
  check(rows.length === 7 && rows.every((r: (string | null)[]) => r[4] !== '–' && r[2] !== '–'), `${tag} summary lists exactly the 7 completed notes (not the unfinished 8th), with sing/play attempts`);
  const playFinds = rows.map((r: (string | null)[]) => parseFloat(r[5] ?? '0'));
  // The sung note (0–2.6 s of each segment) is in the guitar's octave; the guitar step must wait for the pluck.
  check(playFinds.every((x: number) => x >= 0.5), `${tag} no guitar step passed by the voice (find times ${playFinds.join(', ')} s)`);
  console.log(`${tag} summary rows (#, note, sing tries, sing ¢, play tries, find, play ¢):`, JSON.stringify(rows.slice(0, 8)));
  const log = await page.evaluate(() => (window as unknown as { __songPitcherLog: unknown[] }).__songPitcherLog);
  console.log(`${tag} accept log:`, JSON.stringify(log));
  await shot(page, device.slug, '7-summary');
  const resume = await page.evaluate(() => JSON.parse(localStorage.getItem('songPitcher.v1') ?? '{}').resume);
  check(resume?.index === 7 && Array.isArray(resume?.stats), `${tag} resume point saved at note 8 with per-note results (index ${resume?.index}, ${resume?.stats?.filter((x: { playAttempts: number | null }) => x.playAttempts !== null).length} notes with results)`);

  // Layout sanity: no horizontal overflow on any screen we visited last; check home too.
  await page.click('[data-testid="home-btn"]');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!overflow, `${tag} no horizontal overflow`);
  check(errors.length === 0, `${tag} no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
}

async function negativeRun(device: { name: string; slug: string }, wav: string, label: string, expectPhase: string, settings?: object): Promise<void> {
  const browser = await launch(wav);
  const ctx = await browser.newContext({ ...pw.devices[device.name] });
  await ctx.grantPermissions(['microphone'], { origin: URL });
  const page = await ctx.newPage();
  const tag = `[${device.name} ${label}]`;
  await page.goto(URL);
  await page.evaluate((st?: object) => {
    localStorage.clear();
    if (st) localStorage.setItem('songPitcher.v1', JSON.stringify({ settings: st }));
  }, settings);
  await page.reload();
  await page.click('[data-testid="start"]');
  await page.waitForSelector('[data-testid="begin"]:not([disabled])', { timeout: 12000 });
  await page.click('[data-testid="begin"]');
  // The file (≈55 s) loops; 45 s is far longer than the correct run needs for 6 notes.
  const advanced = await waitSession(page, `index > 0`, 45000);
  const phase = await attr(page, 'data-phase');
  check(!advanced, `${tag} never advanced past note 1 in 45 s (ended in phase '${phase}')`);
  check(expectPhase.split('|').includes(phase ?? ''), `${tag} stuck in the expected step: ${expectPhase} (got ${phase})`);
  await browser.close();
}

/** On plain http from a non-localhost address the page must explain that the mic needs https. */
/** The reference tone (rendered offline with the app's own code) must be steady during its sustain. */
async function toneRun(): Promise<void> {
  const browser = await pw.chromium.launch({ headless: true }).catch(() => pw.chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' }));
  const page = await browser.newPage();
  await page.goto(URL);
  for (const midi of [40, 48, 55, 60, 67, 76]) {
    const r = await page.evaluate(async (m: number) => {
      const x: Float32Array = await (window as unknown as { __songPitcherRenderTone: (m: number) => Promise<Float32Array> }).__songPitcherRenderTone(m);
      const sr = 48000;
      const lv: number[] = [];
      // 50 ms RMS windows over the sustain (0.3 s .. 0.85 s after the start)
      for (let t = 0.3; t + 0.05 <= 0.85; t += 0.05) {
        let e = 0;
        for (let i = Math.floor(t * sr); i < Math.floor((t + 0.05) * sr); i++) e += x[i] * x[i];
        lv.push(10 * Math.log10(e / (0.05 * sr)));
      }
      return { swing: Math.max(...lv) - Math.min(...lv), level: Math.max(...lv) };
    }, midi);
    check(r.swing < 1, `[tone] reference note midi ${midi}: sustain level swing ${r.swing.toFixed(2)} dB (level ${r.level.toFixed(1)} dBFS)`);
  }
  await browser.close();
}

async function insecureRun(): Promise<void> {
  const { networkInterfaces } = await import('node:os');
  const ip = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  if (!ip) {
    check(true, '[insecure origin] skipped: no non-loopback IPv4 address');
    return;
  }
  const browser = await pw.chromium.launch({ headless: true }).catch(() => pw.chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' }));
  const page = await (await browser.newContext({ ...pw.devices['iPhone 13'] })).newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(`http://${ip}:${PORT}/`);
  await page.click('[data-testid="start"]');
  const msg = await page.waitForSelector('[data-testid="mic-error"]', { timeout: 5000 }).then((e: { textContent(): Promise<string> }) => e.textContent(), () => '');
  check(/https/.test(msg) && !/undefined|getUserMedia/.test(msg), `[insecure origin http://${ip}] plain explanation shown: "${msg.slice(0, 90)}…"`);
  await page.screenshot({ path: join(SHOTS, 'iphone13-9-insecure-http.png') });
  check(errors.length === 0, `[insecure origin] no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
}

/** Extra layouts: tiny phone, landscape, tall phone; degree-only and hidden hints. */
async function layoutRun(wav: string): Promise<void> {
  const browser = await launch(wav);
  for (const [name, vp] of [['se-320x568', { width: 320, height: 568 }], ['se2-375x667', { width: 375, height: 667 }], ['landscape-844x390', { width: 844, height: 390 }], ['tall-430x932', { width: 430, height: 932 }]] as const) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await ctx.grantPermissions(['microphone'], { origin: URL });
    const page = await ctx.newPage();
    await page.goto(URL);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.click('[data-key="7"]'); // G: shows an octave row
    const startVisible = await page.$eval('[data-testid="start"]', (b: Element) => { const r = b.getBoundingClientRect(); return r.bottom <= window.innerHeight + 1 && r.top >= 0; });
    check(startVisible, `[layout ${name}] Start button visible without scrolling (key G with octave row)`);
    await page.screenshot({ path: join(SHOTS, `layout-${name}-home.png`) });
    // The mic check: its advice and help text must sit above the Begin button, before and after
    // a note is heard (no text hidden behind the sticky buttons).
    const clear = () => page.evaluate(() => {
      const actions = document.querySelector('.tuner .sticky-actions')!.getBoundingClientRect();
      const texts = [...document.querySelectorAll('.tuner-help > *')].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0);
      return texts.every((r) => r.bottom <= actions.top + 12);
    });
    await page.click('[data-testid="start"]');
    await page.waitForSelector('[data-testid="tuner"]');
    await page.waitForTimeout(400);
    if (!name.startsWith('landscape')) check(await clear(), `[layout ${name}] mic check text above the Begin button before a note is heard`);
    await page.screenshot({ path: join(SHOTS, `layout-${name}-tuner-before.png`) });
    await page.waitForSelector('[data-testid="begin"]:not([disabled])', { timeout: 12000 });
    await page.waitForTimeout(600);
    if (!name.startsWith('landscape')) check(await clear(), `[layout ${name}] mic check text above the Begin button after a note`);
    await page.screenshot({ path: join(SHOTS, `layout-${name}-tuner.png`) });
    await page.click('[data-testid="begin"]');
    await waitSession(page, `phase === 'sing'`, 10000);
    if (name.startsWith('se')) {
      await page.click('[data-testid="open-settings"]');
      const inside = await page.evaluate(() => [...document.querySelectorAll('.seg')].every((b) => { const r = b.getBoundingClientRect(); const row = b.closest('.toggle-row')!.getBoundingClientRect(); return r.right <= row.right + 0.5 && r.left >= row.left - 0.5; }));
      check(inside, `[layout ${name}] settings: tolerance buttons inside their card`);
      await page.screenshot({ path: join(SHOTS, `layout-${name}-settings.png`) });
      await page.click('[data-testid="close-settings"]');
      await waitSession(page, `phase === 'sing' || phase === 'listen'`, 10000);
    }
    const fits = await page.evaluate(() => {
      const c = document.querySelector('.controls')!.getBoundingClientRect();
      return c.bottom <= window.innerHeight + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1;
    });
    check(fits, `[layout ${name}] session controls on screen, no horizontal scroll`);
    await page.screenshot({ path: join(SHOTS, `layout-${name}-sing.png`) });
    await ctx.close();
  }
  // Hidden-hint modes on iPhone 13 size.
  for (const [mode, settings] of [['degree-only', { showNoteName: false, showDegree: true }], ['no-hints', { showNoteName: false, showDegree: false, meterSing: false, meterGuitar: false }]] as const) {
    const ctx = await browser.newContext({ ...pw.devices['iPhone 13'] });
    await ctx.grantPermissions(['microphone'], { origin: URL });
    const page = await ctx.newPage();
    await page.goto(URL);
    await page.evaluate((st: object) => localStorage.setItem('songPitcher.v1', JSON.stringify({ settings: { ...st } })), settings);
    await page.reload();
    const range = (await page.textContent('[data-testid="range"]')) ?? '';
    check(!/G3$|first note G3/.test(range), `[${mode}] home does not name the first note ("${range}")`);
    await page.click('[data-testid="start"]');
    await page.waitForSelector('[data-testid="begin"]:not([disabled])', { timeout: 12000 });
    await page.click('[data-testid="begin"]');
    await waitSession(page, `phase === 'sing'`, 10000);
    await page.screenshot({ path: join(SHOTS, `iphone13-${mode}-sing.png`) });
    const tgt = (await page.textContent('[data-testid="target"]')) ?? '';
    check(!/G3/.test(tgt), `[${mode}] target does not show the note name ("${tgt}")`);
    await page.click('[data-testid="end"]');
    await page.waitForSelector('[data-testid="summary"]');
    const body = (await page.textContent('[data-testid="summary"]')) ?? '';
    check(!/G3/.test(body), `[${mode}] ending early does not reveal the unfinished note`);
    await ctx.close();
  }
  await browser.close();
}

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const { correct, wrong, voiceOnly, guitarOnly } = buildWavs(OUT);
  console.log('WAVs:', correct, wrong, voiceOnly, guitarOnly);
  if (!process.argv.includes('--no-build')) execSync('npx vite build', { cwd: ROOT, stdio: 'inherit' });
  const server = await startServer();
  const only = process.argv.find((a) => a.startsWith('--device='))?.split('=')[1];
  try {
    const devs = DEVICES.filter((d) => !only || d.slug === only);
    await Promise.all(devs.map((d) => correctRun(d, correct)));
    if (!process.argv.includes('--skip-negatives')) {
      // Wrong notes: never past note 1. (By default the singing step accepts any octave and does not
      // check the instrument, so the G4 pluck in the file can pass note 1's singing step; the guitar
      // step must still hold. With the strict check on it must stay in the singing step.)
      await Promise.all(devs.map((d) => negativeRun(d, wrong, 'wrong notes', 'sing|play')));
      await Promise.all(devs.map((d) => negativeRun(d, wrong, 'wrong notes, strict check', 'sing', { strictCheck: true })));
      // Singing in the guitar step / plucking in the singing step is caught with the default
      // settings (the attack shape tells a pluck from a voice; a string still ringing after a pluck
      // does not pass the singing step).
      // Sings every note in the guitar's octave and never plays: must get stuck in the guitar step.
      await Promise.all(devs.map((d) => negativeRun(d, voiceOnly, 'voice only, no guitar', 'play')));
      // Plucks every note and never sings: must get stuck in the singing step.
      await Promise.all(devs.map((d) => negativeRun(d, guitarOnly, 'guitar only, no singing', 'sing')));
      await Promise.all(devs.map((d) => negativeRun(d, voiceOnly, 'voice only, no guitar, strict check', 'play', { strictCheck: true })));
      await Promise.all(devs.map((d) => negativeRun(d, guitarOnly, 'guitar only, no singing, strict check', 'sing', { strictCheck: true })));
    }
    await toneRun();
    await insecureRun();
    await layoutRun(correct);
  } finally {
    server.kill();
  }
  console.log(`\nE2E: ${results.filter((r) => r.startsWith('PASS')).length} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
