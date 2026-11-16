// Round-13 honest fixtures through the twelfth review's rig (scripts/critic12, via
// scripts/fixtures13/singalong.ts): a singer who starts with the reference tone, 30 dB under it at
// the microphone, and holds the note. The round-12 build (74cd03b) refused them for as long as they
// held (figures in the comments); 1b6c086 passed them all.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const dir = new URL('../scripts/fixtures13/', import.meta.url).pathname;
const run = (args: string[]) => {
  const env = { ...process.env };
  delete env.BUILD_DIR;
  const r = spawnSync(process.execPath, ['singalong.ts', ...args], { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  const m = /first (\d+)\/(\d+) stuck (\d+)/.exec(`${r.stdout}${r.stderr}`);
  if (!m) throw new Error(`no result: ${r.stdout}${r.stderr}`);
  return { first: Number(m[1]), n: Number(m[2]), stuck: Number(m[3]) };
};

describe('a quiet singer who sings along with the reference and holds the note', () => {
  for (const [room, ref, voice, was] of [['dry', -10, -40, '0/20'], ['living', -10, -34, '14/20'], ['carpet', -10, -40, '15/20'], ['kitchen', -10, -40, '14/20']] as const) {
    it(`${room} room, reference ${ref} dBFS, voice ${voice} dBFS: every step passes first try (round 12: ${was})`, () => {
      const r = run([room, String(ref), String(voice)]);
      expect(r.n).toBe(20);
      expect(r.stuck).toBe(0);
      expect(r.first).toBe(20);
    }, 600_000);
  }
});
