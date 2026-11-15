// Round-9 behaviour tests through the eighth review's rig (streaming rooms, phone chains, several
// guitars). Each pins a defect of the round-8 build (4d26c63) — the expectations fail there
// (round-8 figures in the comments). The rig runs in a child process (it selects the build by path).
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const dir = new URL('../scripts/critic8/', import.meta.url).pathname;
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 });
  return `${r.stdout}${r.stderr}`;
};
const session = (style: string) => JSON.parse(/^JSON (.*)$/m.exec(run(['sess8.ts', style, '1']))![1]);

describe('eighth review rig (round 9 fixes)', () => {
  it('a weak fundamental read an octave high: parlor guitar, kitchen, budget phone — first-pluck rate', () => {
    const d = session('s3');
    expect(d.pstuck).toBe(0);
    expect(d.fp).toBeGreaterThanOrEqual(96); // round 8: 91/101, 17 re-plucks
  }, 600_000);

  it('quiet TV under the singer does not block the singing step (kitchen)', () => {
    const d = session('s8b');
    expect(d.sstuck).toBe(0); // round 8: 6 stuck
    expect(d.sf).toBeGreaterThanOrEqual(98); // round 8: 81/101
  }, 600_000);

  it('the octave below is not accepted: nylon guitar, kitchen, budget phone', () => {
    const out = run(['probes8.ts', 'wrong', 'kitchen', 'nylon', '-12', '0', 'budget']);
    const m = /accepted (\d+)\/(\d+)/.exec(out)!;
    expect(Number(m[1])).toBeLessThanOrEqual(3); // round 8: 8/42
  }, 600_000);
});
