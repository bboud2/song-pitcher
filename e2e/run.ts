// End-to-end test: real app in Chromium with phone emulation and a fake microphone fed from
// generated WAV files. Also writes phone-size screenshots of every main screen to screenshots/.
//
//   npm run e2e          (builds, serves dist/ with vite preview, runs both devices)
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
const SHOTS = join(ROOT, 'screenshots');
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
  const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'pipe' });
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

  await page.click('[data-testid="end"]');
  await page.waitForSelector('[data-testid="summary"]');
  const rows = await page.$$eval('.stats-table tbody tr', (trs: Element[]) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)));
  check(rows.length >= 7 && rows.slice(0, 7).every((r: (string | null)[]) => r[4] !== '–' && r[2] !== '–'), `${tag} summary lists sing/play attempts for the 7 completed notes`);
  console.log(`${tag} summary rows (#, note, sing tries, sing ¢, play tries, find, play ¢):`, JSON.stringify(rows.slice(0, 8)));
  const log = await page.evaluate(() => (window as unknown as { __songPitcherLog: unknown[] }).__songPitcherLog);
  console.log(`${tag} accept log:`, JSON.stringify(log));
  await shot(page, device.slug, '7-summary');
  const resume = await page.evaluate(() => JSON.parse(localStorage.getItem('songPitcher.v1') ?? '{}').resume);
  check(resume?.index === 7, `${tag} resume point saved at note 8 (got ${JSON.stringify(resume)})`);

  // Layout sanity: no horizontal overflow on any screen we visited last; check home too.
  await page.click('[data-testid="home-btn"]');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!overflow, `${tag} no horizontal overflow`);
  check(errors.length === 0, `${tag} no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
}

async function wrongRun(device: { name: string; slug: string }, wav: string): Promise<void> {
  const browser = await launch(wav);
  const ctx = await browser.newContext({ ...pw.devices[device.name] });
  await ctx.grantPermissions(['microphone'], { origin: URL });
  const page = await ctx.newPage();
  const tag = `[${device.name} wrong notes]`;
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.click('[data-testid="start"]');
  await page.waitForSelector('[data-testid="begin"]:not([disabled])', { timeout: 10000 });
  await page.click('[data-testid="begin"]');
  // The whole wrong-notes file (≈55 s) loops; give it 45 s — longer than the correct run needs for 6 notes.
  const advanced = await waitSession(page, `index > 0`, 45000);
  const phase = await attr(page, 'data-phase');
  check(!advanced, `${tag} never advanced past note 1 in 45 s (ended in phase '${phase}')`);
  await browser.close();
}

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const { correct, wrong } = buildWavs(OUT);
  console.log('WAVs:', correct, wrong);
  if (!process.argv.includes('--no-build')) execSync('npx vite build', { cwd: ROOT, stdio: 'inherit' });
  const server = await startServer();
  const only = process.argv.find((a) => a.startsWith('--device='))?.split('=')[1];
  try {
    const devs = DEVICES.filter((d) => !only || d.slug === only);
    await Promise.all(devs.map((d) => correctRun(d, correct)));
    if (!process.argv.includes('--skip-wrong')) await Promise.all(devs.map((d) => wrongRun(d, wrong)));
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
