// frontend/viteConfigEnv.test.js — regression coverage for two dev-server-only defects found in
// verification: (1) SOROBAN_AGENT_ALLOWLIST was missing from the manual env-passthrough list, so
// the F11 exit-leg-2 relay allowlist (frontend/api/stellar-relay.js's AGENT_ALLOWLIST()) never
// reached `vite dev` even when set in .env.local; (2) the dev server's default fs.allow boundary
// 403s frontend/src/stellar/vaultReads.js's cross-package import of keeper/src/apr.js. Both are
// config-shape assertions — they don't boot a real server, but they pin the exact facts that
// caused each bug (a missing `if (env.X) ...` line; a missing repo-root entry in fs.allow).
// NOTE: deliberately NOT named vite.config.test.js — vitest's default exclude glob
// `**/{...,vite,...}.config.*` matches "vite.config.test.js" too (the trailing `*` swallows
// ".test.js"), which silently drops the file from every run with no error.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const FAKE_ALLOWLIST = 'CFAKEAGENTALLOWLISTVALUEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'

vi.mock('vite', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, loadEnv: () => ({ SOROBAN_AGENT_ALLOWLIST: FAKE_ALLOWLIST }) }
})

describe('vite.config.js dev-server env passthrough + fs boundary', () => {
  beforeEach(() => {
    delete process.env.SOROBAN_AGENT_ALLOWLIST
  })

  it('threads SOROBAN_AGENT_ALLOWLIST from loadEnv into process.env for the dev server', async () => {
    const configFn = (await import('./vite.config.js')).default
    configFn({ mode: 'test' })
    expect(process.env.SOROBAN_AGENT_ALLOWLIST).toBe(FAKE_ALLOWLIST)
  })

  it('widens server.fs.allow to the repo root so keeper/src/apr.js is servable under vite dev', async () => {
    const configFn = (await import('./vite.config.js')).default
    const config = configFn({ mode: 'test' })
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    expect(config.server.fs.allow).toContain(repoRoot)
  })
})
