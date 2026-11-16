// Round-11 honest fixtures through the tenth review's rig (scripts/critic10, via
// scripts/fixtures11/honest.ts). Each pins a singer the round-10 build (59f3f12) refused as
// carry-over; the round-10 figures are in the comments (the round-9 build passed them all).
// The rig runs in a child process (it selects the build by path).
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const dir = new URL('../scripts/fixtures11/', import.meta.url).pathname;
const run = (args: string[]): { first: number; n: number } => {
  const env = { ...process.env };
  delete env.BUILD_DIR;
  const r = spawnSync(process.execPath, ['honest.ts', ...args], { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  const m = /first (\d+)\/(\d+)/.exec(`${r.stdout}${r.stderr}`);
  if (!m) throw new Error(`no result: ${r.stdout}${r.stderr}`);
  return { first: Number(m[1]), n: Number(m[2]) };
};

describe('honest singers who start early or fade are not refused as carry-over', () => {
  // round 10: dry 0/22, 0/22, 0/22; living 15/22, 0/22, 0/22
  for (const fade of [3, 5, 8]) {
    for (const room of ['dry', 'living']) {
      it(`singing along with the reference, fading ${fade} dB/s, ${room} room: passes first try`, () => {
        const r = run(['along', String(fade), room]);
        expect(r.n).toBe(22);
        expect(r.first).toBe(22);
      }, 600_000);
    }
  }
  // round 10: dry 0/18, living 14/18
  for (const room of ['dry', 'living']) {
    it(`repeated note, singing begun 0.2 s early over the ringing string, ${room} room: passes first try`, () => {
      const r = run(['early', room]);
      expect(r.n).toBe(18);
      expect(r.first).toBe(18);
    }, 600_000);
  }
});
