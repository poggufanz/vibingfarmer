import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

function importInFreshProcess(moduleUrl) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(moduleUrl.href)})`],
    {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    },
  );
}

describe('smoke CLI module import safety', () => {
  for (const filename of ['mint-mandate.mjs']) {
    it(`imports smoke/${filename} without running its live main function`, () => {
      const result = importInFreshProcess(new URL(`../../smoke/${filename}`, import.meta.url));

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });
  }
});
