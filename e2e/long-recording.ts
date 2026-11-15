// Long recorder test (about 11 minutes): a full 101-note session through the real UI in a live
// (reverberant) room with the practice recorder on, saved from the summary as one WAV, then
// replayed offline: every step must agree with what the app decided.
//
//   npm run build && node e2e/long-recording.ts [room] [notes]
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { server, launch, page, audioSet, toSession, runSession, OUT, sleep } from './ui7driver.ts';
import { replayRecording } from '../scripts/replay.ts';

const [room = 'live', notesS = '101'] = process.argv.slice(2);
const srv = await server();
const browser = await launch();
let ok = false;
try {
  const P = await page(browser, 'iphone13', '', { recordSession: true });
  await toSession(P.p, audioSet(room));
  const S = await runSession(P.p, Number(notesS), 3, `long ${room}`);
  await P.p.waitForSelector('[data-testid="summary"]', { timeout: 20000 }).catch(() => {});
  if (!(await P.p.$('[data-testid="summary"]'))) {
    await P.p.click('[data-testid="end"]');
    await sleep(800);
  }
  const btn = '[data-testid="unsaved-banner"] [data-testid="save-recording"]';
  await P.p.waitForSelector(btn, { timeout: 10000 });
  mkdirSync(OUT, { recursive: true });
  const n0 = P.downloads.length;
  await P.p.click(btn);
  for (let i = 0; i < 300 && P.downloads.length === n0; i++) await sleep(100);
  const d = P.downloads[n0];
  const path = join(OUT, d.suggestedFilename());
  await d.saveAs(path);
  const r = replayRecording(new Uint8Array(readFileSync(path)));
  for (const l of r.lines) console.log('  ', l);
  console.log(`session: play ${S.first}/${S.play} first, ${S.stuck} stuck; sing ${S.singFirst}/${S.sing}; review ${S.revFirst}/${S.rev}`);
  console.log(`replay of ${path}: steps agreeing ${r.stepsAgree}/${r.steps.length}; app accepted ${r.logged.length}, replay ${r.replayed.length}; resynchronised ${r.resyncs}; ${r.gaps} gap(s) logged`);
  ok = r.steps.length > 0 && r.stepsAgree === r.steps.length && r.missing.length === 0 && r.extra.length === 0;
  console.log(ok ? 'PASS  long recording replays step for step' : 'FAIL  long recording does not replay step for step');
  if (P.errors.length) console.log('page errors:', P.errors.join('; '));
} finally {
  await browser.close();
  srv.kill();
}
process.exit(ok ? 0 : 1);
