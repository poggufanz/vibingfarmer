// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ReplayPage from './ReplayPage.jsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const GROUND = Object.freeze({
  amountInUsdc: 1_000_000_000_000,
  chainId: 1,
  delay_15: '700059766102760211479',
  delay_150: '703583939852660558946',
  delay_2: '700875391021734441116',
  delay_50: '701826432701406659347',
  delay_600: '700017511103007510563',
  depegDate: '2023-03-11',
  signalBlock: 16_800_000,
})

const MC = Object.freeze({
  label: 'Historical replay — not a prediction',
  seed: 12_648_430,
  assumptions: {
    manualDelay: 'lognormal median 25min p95 2h (Monte Carlo)',
    agenticDelay: 'first block after signal (~12-24s) — deterministic, no MC',
    blocksPerMin: 5,
    iterations: 1000,
    groundTruthSource: 'frontend/public/data/replay-usdc-depeg.json',
  },
  manual: {
    p5: 700084341121469600000,
    p50: 702381467976903400000,
    p95: 703462366382381300000,
  },
  agentic: {
    deterministic: 700875391021734400000,
    basis: 'first block after signal (~12-24s)',
  },
  provenance: { signalBlock: 16_800_000, chainId: 1, depegDate: '2023-03-11' },
})

const CHECKED_AT = '2026-08-11T00:00:00.000Z'

const readFor = (state, overrides = {}) => ({
  fact: {
    state,
    value: null,
    source: state === 'unavailable' ? null : 'Static replay fixture',
    checkedAt: state === 'unavailable' ? null : CHECKED_AT,
    staleAfterMs: null,
  },
  ground: null,
  mc: null,
  error: null,
  ...overrides,
})

const renderReplay = (replayRead) =>
  render(
    <MemoryRouter initialEntries={['/replay']}>
      <ReplayPage replayRead={replayRead} />
    </MemoryRouter>
  )

describe('ReplayPage', () => {
  it('identifies the page as a static historical Ethereum replay, never a current Stellar read', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    )
    renderReplay(readFor('current', { ground: GROUND, mc: MC }))

    expect(screen.getByRole('heading', { level: 1, name: 'Historical Replay' })).toBeTruthy()
    expect(screen.getByText('Ethereum mainnet fork')).toBeTruthy()
    expect(screen.getByText('Static historical replay')).toBeTruthy()
    expect(screen.getByText('No wallet or RPC execution')).toBeTruthy()
    expect(screen.queryByText(/Stellar testnet|live yield/i)).toBeNull()
  })

  it('renders a loading notice while both historical payloads are being read', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    )
    renderReplay(readFor('loading'))

    expect(screen.getByRole('status').textContent).toMatch(/loading replay payloads/i)
    expect(screen.getByRole('main').getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByText('Outcome Range')).toBeNull()
  })

  it('renders both frozen payloads through the outcome and assumptions views', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    )
    renderReplay(readFor('current', { ground: GROUND, mc: MC }))

    expect(screen.getByText('Outcome Range')).toBeTruthy()
    expect(screen.getByText(/Swapping 100,000 USDC/)).toBeTruthy()
    expect(screen.getByText('Ground truth source')).toBeTruthy()
    expect(screen.getByText('Swarm Execution')).toBeTruthy()
    expect(screen.getByText('Human Reaction')).toBeTruthy()
    expect(screen.queryByText(/Stellar testnet|live yield/i)).toBeNull()
  })

  it('keeps a ground-only fixture visible with an explicit Monte Carlo notice', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    )
    renderReplay(readFor('partial', { ground: GROUND }))

    expect(screen.getByText(/Monte Carlo payload unavailable/i)).toBeTruthy()
    expect(screen.getByText(/Ground truth payload loaded/i)).toBeTruthy()
    expect(screen.queryByText('Outcome Range')).toBeNull()
  })

  it('keeps a Monte Carlo-only fixture visible with an explicit ground-truth notice', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    )
    renderReplay(readFor('partial', { mc: MC }))

    expect(screen.getByText(/Ground truth payload unavailable/i)).toBeTruthy()
    expect(screen.getByText(/Monte Carlo payload loaded/i)).toBeTruthy()
    expect(screen.queryByText('Outcome Range')).toBeNull()
  })

  it('renders stale frozen evidence and says it is stale instead of calling it current', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    )
    renderReplay(readFor('stale', { ground: GROUND, mc: MC }))

    expect(screen.getByText('Stale')).toBeTruthy()
    expect(screen.getByText('Outcome Range')).toBeTruthy()
    expect(screen.getByText(/last known value/i)).toBeTruthy()
    expect(screen.queryByText(/current Stellar|live yield/i)).toBeNull()
  })

  it('renders an empty notice when the read completes without replay payloads', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    )
    renderReplay(readFor('empty'))

    expect(screen.getByText(/No replay payloads available/i)).toBeTruthy()
    expect(screen.queryByText('Outcome Range')).toBeNull()
  })

  it('renders an explicit error notice when both payload reads fail', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    )
    renderReplay(readFor('error', { error: 'Replay data not found' }))

    expect(screen.getByText(/Replay data unavailable/i)).toBeTruthy()
    expect(screen.getByText(/Replay data not found/i)).toBeTruthy()
    expect(screen.queryByText('Outcome Range')).toBeNull()
  })

  it('renders an unavailable notice without a blank content area', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    )
    renderReplay(readFor('unavailable'))

    expect(screen.getByText(/Replay payload unavailable/i)).toBeTruthy()
    expect(screen.getByText(/do not execute|do not act/i)).toBeTruthy()
    expect(screen.queryByText('Outcome Range')).toBeNull()
  })
})

describe('ReplayPage geometry motion contract', () => {
  it('uses synchronous chart geometry and no layout transitions or GSAP tweens', () => {
    const jsx = readFileSync(
      resolve(globalThis.process.cwd(), 'src/components/ReplayPage.jsx'),
      'utf8'
    )
    const css = readFileSync(
      resolve(globalThis.process.cwd(), 'src/components/ReplayPage.css'),
      'utf8'
    )
    const source = `${jsx}\n${css}`

    expect(source).not.toMatch(/gsap|fromTo|\.to\(/i)
    expect(source).not.toMatch(/transition[^;]*(width|height|top|left)/i)
    expect(source).not.toMatch(/transition\s*:\s*[^;]*(width|height|top|left)/i)

    const transitions = [...css.matchAll(/transition\s*:\s*([^;]+)/gi)].map((match) => match[1])
    for (const transition of transitions) {
      if (transition.trim() === 'none') continue
      expect(transition).toMatch(
        /^(?:\s*(?:opacity|transform)\s+(?:120|220|320)ms\b[^,;]*(?:,|$))+$/i
      )
    }

    expect(jsx).toMatch(/style=\{\{\s*width:/)
    expect(jsx).toMatch(/style=\{\{\s*left:/)
  })
})
