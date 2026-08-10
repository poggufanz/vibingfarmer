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
const FAKE_RELAYER_ORIGIN = 'https://relayer-from-env.example'
const FAKE_PROXY_KEY = 'current-proxy-key-sentinel'
const FAKE_EXTENSION_ORIGINS = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const UNRELATED_SECRET = 'unrelated-secret-sentinel'

vi.mock('vite', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    loadEnv: () => ({
      SOROBAN_AGENT_ALLOWLIST: FAKE_ALLOWLIST,
      RELAYER_ORIGIN: FAKE_RELAYER_ORIGIN,
      RELAYER_PROXY_KEY: FAKE_PROXY_KEY,
      ALLOWED_EXTENSION_ORIGINS: FAKE_EXTENSION_ORIGINS,
      UNRELATED_SECRET_SENTINEL: UNRELATED_SECRET,
    }),
  }
})

describe('vite.config.js dev-server env passthrough + fs boundary', () => {
  beforeEach(() => {
    delete process.env.SOROBAN_AGENT_ALLOWLIST
    delete process.env.RELAYER_ORIGIN
    delete process.env.RELAYER_PROXY_KEY
    delete process.env.ALLOWED_EXTENSION_ORIGINS
    delete process.env.UNRELATED_SECRET_SENTINEL
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

  it('threads only named server values into process.env, never the unrelated secret or VITE aliases', async () => {
    const configFn = (await import('./vite.config.js')).default
    const config = configFn({ mode: 'test' })
    expect(process.env.RELAYER_ORIGIN).toBe(FAKE_RELAYER_ORIGIN)
    expect(process.env.RELAYER_PROXY_KEY).toBe(FAKE_PROXY_KEY)
    expect(process.env.ALLOWED_EXTENSION_ORIGINS).toBe(FAKE_EXTENSION_ORIGINS)
    expect(process.env.UNRELATED_SECRET_SENTINEL).toBeUndefined()
    expect(JSON.stringify(config.define)).not.toContain(FAKE_PROXY_KEY)
    expect(JSON.stringify(config.define)).not.toContain(FAKE_EXTENSION_ORIGINS)
    expect(JSON.stringify(config.define)).not.toContain('VITE_RELAYER')
    expect(JSON.stringify(config.define)).not.toContain('VITE_ALLOWED_EXTENSION')
  })

  it('mounts real vf-cross and explicit Agent Index unavailable middleware in both Vite hooks', async () => {
    const configFn = (await import('./vite.config.js')).default
    const config = configFn({ mode: 'test' })
    const { default: vfCross } = await import('./api/vf-cross.js')
    const { default: unavailable } = await import('./api/agent-index-vite-unavailable.js')
    for (const hookName of ['configureServer', 'configurePreviewServer']) {
      const registrations = []
      config.plugins[1][hookName]({
        middlewares: { use: (path, middleware) => registrations.push({ path, middleware }) },
      })
      expect(registrations.map(({ path }) => path)).toEqual(
        expect.arrayContaining(['/api/vf-cross', '/api/agent-index'])
      )
      const crossMiddleware = registrations.find(({ path }) => path === '/api/vf-cross').middleware
      expect(crossMiddleware).toEqual(expect.any(Function))
      expect(crossMiddleware).not.toBe(vfCross)
      const indexMiddleware = registrations.find(
        ({ path }) => path === '/api/agent-index'
      ).middleware
      expect(indexMiddleware).toEqual(expect.any(Function))
      expect(indexMiddleware).not.toBe(unavailable)
      const response = {
        statusCode: 200,
        headers: {},
        setHeader(key, value) {
          this.headers[key.toLowerCase()] = value
        },
        end(body) {
          this.body = body
        },
      }
      const next = vi.fn()
      indexMiddleware(
        { method: 'GET', url: '/api/agent-index?action=receipt-challenge' },
        response,
        next
      )
      expect(response.statusCode).toBe(503)
      expect(JSON.parse(response.body).error).toMatch(/^Agent index requires Pages\+D1/)
      expect(next).not.toHaveBeenCalled()
    }
  })

  it('lets only the mounted browser recovery module reach Vite transforms', async () => {
    const configFn = (await import('./vite.config.js')).default
    const config = configFn({ mode: 'test' })
    for (const hookName of ['configureServer', 'configurePreviewServer']) {
      const registrations = []
      config.plugins[1][hookName]({
        middlewares: { use: (path, middleware) => registrations.push({ path, middleware }) },
      })
      const indexMiddleware = registrations.find(
        ({ path }) => path === '/api/agent-index'
      ).middleware

      const recoveryNext = vi.fn()
      const recoveryResponse = {
        statusCode: 200,
        headers: {},
        setHeader() {},
        end() {},
      }
      indexMiddleware(
        { method: 'GET', url: '/recovery.js?v=dev-cache-key' },
        recoveryResponse,
        recoveryNext
      )
      expect(recoveryNext).toHaveBeenCalledOnce()
      expect(recoveryResponse.statusCode).toBe(200)

      for (const url of ['/recovery.js/extra', '/other.js', '/?action=receipt-challenge']) {
        const res = {
          statusCode: 200,
          headers: {},
          body: '',
          setHeader(key, value) {
            this.headers[key.toLowerCase()] = value
          },
          end(body = '') {
            this.body = body
          },
        }
        const next = vi.fn()
        indexMiddleware({ method: 'GET', url }, res, next)
        expect(res.statusCode).toBe(503)
        expect(res.headers['cache-control']).toBe('no-store')
        expect(JSON.parse(res.body).error).toMatch(/^Agent index requires Pages\+D1/)
        expect(next).not.toHaveBeenCalled()
      }

      const postNext = vi.fn()
      const postResponse = {
        statusCode: 200,
        headers: {},
        setHeader() {},
        end() {},
      }
      indexMiddleware(
        { method: 'POST', url: '/recovery.js?v=dev-cache-key' },
        postResponse,
        postNext
      )
      expect(postResponse.statusCode).toBe(503)
      expect(postNext).not.toHaveBeenCalled()
    }
  })
})
