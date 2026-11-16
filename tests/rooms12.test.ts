// Round-12 behaviour tests through the eleventh review's rig (scripts/critic11/e1.ts). The first
// two pin defects of the round-11 build (1b6c086), whose figures are in the comments; the last
// pins honest early starters, which must stay passing first try. The rig runs in a child process.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const dir = new URL('../scripts/critic11/', import.meta.url).pathname;
const trials = (re: string): { res: string }[] => {
  const env = { ...process.env };
  delete env.BUILD_DIR;
  const r = spawnSync(process.execPath, ['e1.ts', re], { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  return `${r.stdout}`.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).filter((d) => d.res !== 'setup-failed');
};

describe('sounds that were already there when the singing step opened', () => {
  it('a quiet string ringing in sympathy at the target pitch does not pass the singing step', () => {
    const r = trials('^A4b sympathetic string same octave -28$');
    expect(r.length).toBe(21);
    expect(r.filter((d) => d.res === 'ADVANCED').length).toBe(0); // round 11: 15/21
  }, 600_000);

  it('a wrong note (a semitone sharp) sung over the reference echo does not pass', () => {
    const r = trials('^A6 wrong 1 over ref tail spk-8$');
    expect(r.length).toBe(21);
    expect(r.filter((d) => d.res === 'ADVANCED').length).toBe(0); // round 11: 6/21
  }, 600_000);

  it('a singer who starts early, before the step opens, still passes first try', () => {
    const r = trials('^H4 early (-1.3|-0.05) lvl-34 hold3 fade0$');
    expect(r.length).toBe(42);
    expect(r.filter((d) => d.res === 'first').length).toBe(42);
  }, 600_000);
});
