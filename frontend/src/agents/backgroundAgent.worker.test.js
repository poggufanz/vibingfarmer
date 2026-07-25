// frontend/src/agents/backgroundAgent.worker.test.js
// Pocket Crew "My money" Task 8: this worker used to match `vault.protocol` against a handful of
// Ethereum-mainnet DeFiLlama pools and, on a miss (which is EVERY real position — this product
// has no live Ethereum venue), fall back to a hardcoded per-protocol drawdown map to manufacture
// a DRAWDOWN_ALERT out of thin air. These tests pin the replacement: real facts or an honest
// 'unavailable', never a synthetic number, and no import/call of a transaction executor — the
// worker only ever detects + notifies (see its own header comment).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WORKER_PATH = fileURLToPath(new URL('./backgroundAgent.worker.js', import.meta.url))

async function loadWorker() {
  const posted = []
  const fakeSelf = {
    onmessage: null,
    postMessage: (msg) => posted.push(msg),
  }
  vi.stubGlobal('self', fakeSelf)
  vi.resetModules()
  await import('./backgroundAgent.worker.js')
  return { fakeSelf, posted }
}

async function flush() {
  // Two macrotask ticks — enough for the `await fetch(...)` + `await res.json()` chain inside
  // each monitor to resolve with the mocked fetch below.
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('backgroundAgent.worker', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('never imports or references a transaction executor — detects + notifies only', () => {
    const src = readFileSync(WORKER_PATH, 'utf8')
    expect(src).not.toMatch(/exitExecutor|runAutonomousExit|signAgentExitEntries|buildAgentExitTx/)
    expect(src).not.toMatch(/from ['"].*exit/i)
  })

  it('never hardcodes a per-protocol drawdown map', () => {
    const src = readFileSync(WORKER_PATH, 'utf8')
    expect(src.toLowerCase()).not.toMatch(/morpho-blue['"]:\s*-?\d/)
    expect(src.toLowerCase()).not.toMatch(/pendle['"]?:\s*-?\d/)
  })

  it('posts RISK_FACT with unavailable state — never a synthetic drawdown — when no real pool matches', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ data: [] }) }))
    const { fakeSelf, posted } = await loadWorker()
    fakeSelf.onmessage({
      data: {
        type: 'INIT',
        payload: {
          userAddress: 'GOWNER',
          activeVaults: [{ name: 'Autofarm', address: 'CVAULT', protocol: 'blend-usdc' }],
          thresholds: { riskMonitoring: false },
        },
      },
    })
    await flush()
    fakeSelf.onmessage({ data: { type: 'STOP' } })

    const facts = posted.filter((m) => m.type === 'RISK_FACT')
    expect(facts).toHaveLength(1)
    expect(facts[0].payload).toMatchObject({
      protocol: 'blend-usdc',
      state: 'unavailable',
      apy: null,
      tvlUsd: null,
      source: 'defillama',
    })
    expect(typeof facts[0].payload.checkedAt).toBe('number')
    expect(posted.some((m) => m.type === 'DRAWDOWN_ALERT')).toBe(false)
    expect(posted.some((m) => m.type === 'APY_DRIFT')).toBe(false)
    expect(posted.some((m) => m.type === 'REBALANCE_OPPORTUNITY')).toBe(false)
  })

  it('posts RISK_FACT with the real matched pool data, regardless of chain field', async () => {
    global.fetch = vi.fn(async () => ({
      json: async () => ({ data: [{ project: 'blend-usdc', chain: 'Stellar', apy: 7.5, tvlUsd: 4_000_000 }] }),
    }))
    const { fakeSelf, posted } = await loadWorker()
    fakeSelf.onmessage({
      data: {
        type: 'INIT',
        payload: {
          userAddress: 'GOWNER',
          activeVaults: [{ name: 'Autofarm', address: 'CVAULT', protocol: 'blend-usdc' }],
          thresholds: { riskMonitoring: false },
        },
      },
    })
    await flush()
    fakeSelf.onmessage({ data: { type: 'STOP' } })

    const facts = posted.filter((m) => m.type === 'RISK_FACT')
    expect(facts).toHaveLength(1)
    expect(facts[0].payload).toMatchObject({ state: 'known', apy: 7.5, tvlUsd: 4_000_000, source: 'defillama' })
  })

  it('posts MONITOR_ERROR, never throws, when the facts fetch fails', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network down')
    })
    const { fakeSelf, posted } = await loadWorker()
    expect(() =>
      fakeSelf.onmessage({
        data: {
          type: 'INIT',
          payload: {
            userAddress: 'GOWNER',
            activeVaults: [{ name: 'Autofarm', address: 'CVAULT', protocol: 'blend-usdc' }],
            thresholds: { riskMonitoring: false },
          },
        },
      })
    ).not.toThrow()
    await flush()
    fakeSelf.onmessage({ data: { type: 'STOP' } })

    expect(posted.some((m) => m.type === 'MONITOR_ERROR' && m.payload.monitor === 'facts')).toBe(true)
  })

  it('runRiskCheck still posts RISK_SCAN_RESULT with source + freshness for a real position', async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('yields.llama.fi')) return { json: async () => ({ data: [] }) }
      return { json: async () => ({ answer: 'no known issues', results: [{ title: 'T', url: 'https://x' }] }) }
    })
    const { fakeSelf, posted } = await loadWorker()
    fakeSelf.onmessage({
      data: {
        type: 'INIT',
        payload: {
          userAddress: 'GOWNER',
          activeVaults: [{ name: 'Autofarm', address: 'CVAULT', protocol: 'blend-usdc' }],
          thresholds: {},
        },
      },
    })
    await flush()
    fakeSelf.onmessage({ data: { type: 'STOP' } })

    const scans = posted.filter((m) => m.type === 'RISK_SCAN_RESULT')
    expect(scans).toHaveLength(1)
    expect(scans[0].payload.source).toBe('tavily')
    expect(typeof scans[0].payload.checkedAt).toBe('number')
  })

  it('STOP clears every interval that INIT started', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ data: [] }) }))
    const setSpy = vi.spyOn(global, 'setInterval')
    const clearSpy = vi.spyOn(global, 'clearInterval')
    const { fakeSelf } = await loadWorker()
    fakeSelf.onmessage({
      data: {
        type: 'INIT',
        payload: { userAddress: 'GOWNER', activeVaults: [], thresholds: {} },
      },
    })
    const startedCount = setSpy.mock.calls.length
    expect(startedCount).toBeGreaterThan(0)
    fakeSelf.onmessage({ data: { type: 'STOP' } })
    expect(clearSpy.mock.calls.length).toBe(startedCount)
  })
})
