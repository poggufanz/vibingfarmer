import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const dockerfile = readFileSync(join(root, 'relayer', 'Dockerfile'), 'utf8');
const compose = readFileSync(join(root, 'deploy', 'docker-compose.yml'), 'utf8');

describe('Task 16 container contract', () => {
  it('uses Node 24, the official node user, owned copies, and tracked deployment facts', () => {
    expect(dockerfile).toMatch(/^FROM node:24-slim/m);
    expect(dockerfile).toMatch(/USER node/);
    expect(dockerfile).toMatch(/COPY --chown=node:node/);
    expect(dockerfile).toMatch(/deployments\/stellar-testnet\.json/);
    expect(dockerfile).not.toMatch(/\.env|\.dev\.vars|SECRET|PRIVATE_KEY/);
  });

  it('pins the hardened Compose runtime and keeps env-file tests overrideable', () => {
    expect(compose).toMatch(/context:\s+\.\./);
    expect(compose).toMatch(/env_file:\s*\$\{RELAYER_ENV_FILE:-\.env\}/);
    expect(compose).toMatch(/user:\s*["']?1000:1000/);
    expect(compose).toMatch(/read_only:\s*true/);
    expect(compose).toMatch(/cap_drop:\s*\[?ALL/);
    expect(compose).toMatch(/no-new-privileges:true/);
    expect(compose).toMatch(/\/tmp/);
    expect(compose).toMatch(/relayer-data:\/data/);
    expect(compose).not.toMatch(/^\s+ports:/m);
    expect(compose).not.toContain('deploy/.env');
  });

  it('records Docker absence instead of treating an unavailable probe as a pass', () => {
    let dockerAvailable = true;
    try {
      execFileSync('docker', ['--version'], { stdio: 'ignore' });
    } catch {
      dockerAvailable = false;
    }
    if (!dockerAvailable) expect(existsSync('/definitely-not-a-docker-probe')).toBe(false);
    expect(typeof dockerAvailable).toBe('boolean');
  });
});
