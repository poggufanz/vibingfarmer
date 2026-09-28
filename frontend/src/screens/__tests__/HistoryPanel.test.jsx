// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import HistoryPanel from '../HistoryPanel.jsx'

vi.mock('../../history/history.js', () => ({
  getTransactions: vi.fn(() => []),
  getStrategies: vi.fn(() => []),
  getReasoningLog: vi.fn(() => []),
  clearAllHistory: vi.fn(),
}))

vi.mock('../../base/baseHistory.js', () => ({
  fetchBaseHistory: vi.fn(() => Promise.resolve([])),
}))

const fetchUnifiedActivityMock = vi.fn(async () => ({
  rows: [],
  sources: {},
  partial: false,
  loading: false,
}))
vi.mock('../../history/unifiedHistory.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, fetchUnifiedActivity: (...a) => fetchUnifiedActivityMock(...a) }
})

vi.mock('../../wallet/baseBinding.js', () => ({
  readBaseOwner: vi.fn(() => null),
}))

const CHECKED_AT = '2026-08-11T00:00:00.000Z'
const AMOUNT = Object.freeze({ token: 'USDC', units: '1234500', decimals: 6 })
const BASE_COPY = 'Base Sepolia proxy. Custody only. No protocol yield.'
const TAB_IDS = ['transactions', 'base', 'strategies', 'reasoning', 'all']

const factFor = (state, overrides = {}) => ({
  state,
  value: ['error', 'unavailable', 'empty', 'loading'].includes(state) ? null : AMOUNT,
  source: state === 'unavailable' ? null : 'history fixture',
  checkedAt: state === 'unavailable' ? null : CHECKED_AT,
  staleAfterMs: 120000,
  ...overrides,
})

const localRow = Object.freeze({
  id: 'stellar-row-1',
  txHash: 'GABC1234567890',
  vaultName: 'Autofarm Vault',
  protocol: 'Blend Capital v2',
  amount: AMOUNT,
  timestamp: 1786406400000,
  network: 'stellar-testnet',
})

const baseRow = Object.freeze({
  id: 'base-row-1',
  hash: '0xbase123',
  action: 'in',
  timestamp: 1786406400000,
  amount: AMOUNT,
  asset: 'USDC',
  network: 'Base Sepolia',
  venue: 'Base Sepolia proxy',
  truth: BASE_COPY,
  verified: true,
})

const readResult = (state, overrides = {}) => ({
  fact: factFor(state),
  facts: {
    transactions: factFor(state, { source: 'local-device' }),
    base: factFor(state, { source: 'base-indexer' }),
    strategies: factFor(state, { source: 'local-device' }),
    reasoning: factFor(state, { source: 'local-device' }),
  },
  transactions: state === 'current' || state === 'stale' ? [localRow] : [],
  baseRows: state === 'current' || state === 'stale' ? [baseRow] : [],
  strategies: [],
  reasoning: [],
  baseAccount: '0xbase-account',
  ...overrides,
})

const renderHistory = (historyRead) =>
  render(
    <MemoryRouter initialEntries={['/history']}>
      <HistoryPanel connectedAddress="GOWNER" historyRead={historyRead} />
    </MemoryRouter>
  )

describe('HistoryPanel', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it.each(['loading', 'empty', 'error', 'unavailable', 'stale', 'current'])(
    'renders the %s envelope without fabricating money or status claims',
    (state) => {
      renderHistory(readResult(state))

      expect(screen.getByRole('heading', { level: 1, name: 'History' })).toBeTruthy()
      expect(screen.getByRole('tablist')).toBeTruthy()
      expect(screen.getAllByRole('tab')).toHaveLength(5)
      expect(screen.getAllByRole('tabpanel', { hidden: true })).toHaveLength(5)
      expect(screen.queryByText(/^Confirmed$/)).toBeNull()
      expect(screen.queryByText(/^Fee-bump$/)).toBeNull()
      expect(screen.queryByText(/^0\.00/)).toBeNull()
      if (state !== 'current' && state !== 'stale') {
        expect(screen.queryByText(/1\.2345 USDC/)).toBeNull()
      }
      expect(document.querySelector(`[data-fact-state="${state}"]`)).toBeTruthy()
      expect(screen.getAllByText(/Source|Checked at/).length).toBeGreaterThan(0)
    }
  )

  it('keeps Base provenance exact and renders canonical amounts only', () => {
    renderHistory(readResult('current'))

    fireEvent.click(screen.getByRole('tab', { name: /Base/ }))

    expect(screen.getAllByText('Base Sepolia').length).toBeGreaterThan(0)
    expect(screen.getAllByText(BASE_COPY).length).toBeGreaterThan(0)
    expect(screen.getAllByText('1.2345 USDC').length).toBeGreaterThan(0)
    expect(screen.queryByText(/^Confirmed$/)).toBeNull()
    expect(screen.queryByText(/^Fee-bump$/)).toBeNull()
    expect(screen.queryByText(/^0\.00/)).toBeNull()
  })

  it('renders production scalar USDC fields at the row boundary without floating conversion', () => {
    const localScalarRow = {
      id: 'stellar-scalar-1',
      txHash: 'GSCALAR1234567890',
      vaultName: 'Autofarm Vault',
      protocol: 'Blend Capital v2',
      amountUsdc: '12.340000',
      timestamp: 1786406400000,
      network: 'stellar-testnet',
      verified: true,
    }
    const baseScalarRow = {
      id: 'base-scalar-1',
      hash: '0xscalar123',
      action: 'in',
      timestamp: 1786406400000,
      amount: 21.5,
      symbol: 'USDC',
      direction: 'in',
      network: 'Base Sepolia',
      verified: true,
    }
    const strategyScalarRow = {
      id: 'strategy-scalar-1',
      amountUsdc: '7.500000',
      riskLevel: 'Balanced',
      numVaults: 1,
      timestamp: 1786406400000,
    }

    renderHistory(
      readResult('current', {
        transactions: [localScalarRow],
        baseRows: [baseScalarRow],
        strategies: [strategyScalarRow],
      })
    )

    expect(screen.getAllByText('12.34 USDC').length).toBeGreaterThan(0)
    expect(screen.queryByText(/^0(?:\.0+)? USDC$/)).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /Base/ }))
    expect(screen.getAllByText('21.5 USDC').length).toBeGreaterThan(0)
    expect(screen.queryByText(/^0(?:\.0+)? USDC$/)).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /Strategies/ }))
    expect(screen.getAllByText('7.5 USDC').length).toBeGreaterThan(0)
    expect(screen.queryByText(/^0(?:\.0+)? USDC$/)).toBeNull()
  })

  it('keeps an unverified row network unavailable instead of claiming a settled route', () => {
    renderHistory(readResult('current'))

    expect(screen.getAllByText('Unknown network').length).toBeGreaterThan(0)
    expect(screen.queryByText('Stellar testnet')).toBeNull()
    expect(screen.getAllByText('Unknown venue').length).toBeGreaterThan(0)
  })

  it('uses exact linked tab and panel ids with one roving tab stop', () => {
    renderHistory(readResult('empty'))

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.id)).toEqual(TAB_IDS.map((id) => `history-tab-${id}`))
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1, -1])

    tabs.forEach((tab, index) => {
      const panel = document.getElementById(tab.getAttribute('aria-controls'))
      expect(tab.getAttribute('aria-controls')).toBe(`history-panel-${TAB_IDS[index]}`)
      expect(tab.getAttribute('aria-selected')).toBe(index === 0 ? 'true' : 'false')
      expect(panel).toBeTruthy()
      expect(panel.getAttribute('aria-labelledby')).toBe(tab.id)
      expect(panel.tabIndex).toBe(0)
    })
  })

  it('wraps and activates with arrows, Home/End, Enter, and Space', () => {
    renderHistory(readResult('empty'))

    const tabs = screen.getAllByRole('tab')
    tabs[0].focus()
    fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' })
    expect(tabs[4].getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs[4])

    fireEvent.keyDown(tabs[4], { key: 'Home' })
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs[0])

    fireEvent.keyDown(tabs[0], { key: 'End' })
    expect(tabs[4].getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs[4])

    tabs[1].focus()
    fireEvent.keyDown(tabs[1], { key: 'Enter' })
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tabs[1], { key: ' ' })
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
  })

  it('keeps no-account and null-amount Base rows explicit', () => {
    renderHistory(
      readResult('empty', {
        baseAccount: null,
        baseRows: [
          {
            ...baseRow,
            amount: null,
          },
        ],
      })
    )

    fireEvent.click(screen.getByRole('tab', { name: /Base/ }))
    expect(screen.getAllByText(/Unavailable|connect a Base passkey/i).length).toBeGreaterThan(0)
    expect(screen.getByText('Unknown network')).toBeTruthy()
    expect(screen.getByText('Unknown venue')).toBeTruthy()
    expect(screen.queryByText(BASE_COPY)).toBeNull()
    expect(screen.queryByText(/^0\.00/)).toBeNull()
    expect(screen.queryByText(/^Confirmed$/)).toBeNull()
    expect(screen.queryByText(/^Fee-bump$/)).toBeNull()
  })

  it('keeps the default reader path when no fixture envelope is injected', () => {
    render(
      <MemoryRouter initialEntries={['/history']}>
        <HistoryPanel connectedAddress="GOWNER" />
      </MemoryRouter>
    )

    expect(screen.getByRole('heading', { level: 1, name: 'History' })).toBeTruthy()
    expect(screen.getByRole('tablist')).toBeTruthy()
    expect(screen.getAllByText('Unknown network').length).toBeGreaterThan(0)
    expect(screen.queryByText('Stellar testnet')).toBeNull()
  })
})

describe('HistoryPanel yield evidence', () => {
  beforeEach(() => cleanup())

  it('shows APY only for evidenced transaction rows', () => {
    renderHistory(
      readResult('current', {
        transactions: [
          { ...localRow, id: 'legacy', apy: 4.8 },
          { ...localRow, id: 'live', txHash: 'GLIVE', apy: 6.2, yieldEvidence: 'live-venue' },
        ],
      })
    )

    expect(screen.getByText(/6.2% APY/)).toBeTruthy()
    expect(screen.queryByText(/4.8% APY/)).toBeNull()
  })

  it('labels non-live strategy yield unavailable and hides unproven APY', () => {
    renderHistory(
      readResult('current', {
        strategies: [
          {
            id: 'legacy-strategy',
            amountUsdc: '10',
            riskLevel: 'low',
            numVaults: 1,
            blendedApy: 4.8,
            vaultDataSource: 'fallback',
          },
        ],
      })
    )

    fireEvent.click(screen.getAllByRole('tab', { name: /Strategies/ }).at(-1))
    expect(screen.getByText(/Yield unavailable/)).toBeTruthy()
    expect(screen.queryByText(/4.8% blended APY/)).toBeNull()
  })

  it('hides unproven reasoning APY while preserving evidenced reasoning APY', () => {
    renderHistory(
      readResult('current', {
        reasoning: [
          { id: 'legacy-reasoning', vaultName: 'Legacy', expectedApy: 4.8 },
          {
            id: 'live-reasoning',
            vaultName: 'Live',
            expectedApy: 6.2,
            yieldEvidence: 'live-venue',
          },
        ],
      })
    )

    fireEvent.click(screen.getAllByRole('tab', { name: /AI reasoning/ }).at(-1))
    expect(screen.getByText(/6.2% APY/)).toBeTruthy()
    expect(screen.queryByText(/4.8% APY/)).toBeNull()
  })

  it('does not render APY for blank values even when marked live', () => {
    renderHistory(
      readResult('current', {
        transactions: [{ ...localRow, apy: '   ', yieldEvidence: 'live-venue' }],
        strategies: [
          {
            id: 'blank-strategy',
            amountUsdc: '10',
            riskLevel: 'low',
            numVaults: 1,
            blendedApy: '',
            yieldEvidence: 'live-venue',
            vaultDataSource: 'fallback',
          },
        ],
        reasoning: [
          {
            id: 'blank-reasoning',
            vaultName: 'Blank',
            expectedApy: '\t',
            yieldEvidence: 'live-venue',
          },
        ],
      })
    )

    expect(document.body.textContent).not.toContain('% APY')
    fireEvent.click(screen.getAllByRole('tab', { name: /Strategies/ }).at(-1))
    expect(screen.queryByText(/blended APY/)).toBeNull()
    fireEvent.click(screen.getAllByRole('tab', { name: /AI reasoning/ }).at(-1))
    expect(document.body.textContent).not.toContain('% APY')
  })
})

describe('HistoryPanel unified activity tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()
  })

  const unifiedRow = (over) => ({
    id: 'u1',
    time: 1786406400000,
    kind: 'deposit',
    label: 'Deposit',
    detail: 'Autofarm Vault · 5 USDC',
    hash: null,
    url: null,
    network: 'stellar',
    status: 'confirmed',
    source: 'local',
    ...over,
  })

  it('merges injected Stellar + Base rows newest-first on the All activity tab', () => {
    renderHistory(
      readResult('current', {
        transactions: [
          { ...localRow, id: 'stellar-old', txHash: 'HOLD9999', timestamp: 1786406400000 },
        ],
        baseRows: [{ ...baseRow, id: 'base-new', timestamp: 1786506400000 }],
      })
    )
    fireEvent.click(screen.getByRole('tab', { name: /All activity/ }))
    const unified = document.getElementById('history-panel-all')
    expect(unified.getAttribute('hidden')).toBeNull()
    // Newest first: the Base row (later timestamp) precedes the Stellar row.
    expect(unified.textContent.indexOf('0xbase12')).toBeLessThan(
      unified.textContent.indexOf('HOLD9999'.slice(0, 8))
    )
    // Hash rules: the Stellar row links via its source hash, the section names sources.
    expect(unified.querySelector('button[aria-label^="Open transaction"]')).toBeTruthy()
    expect(unified.textContent).toMatch(/Base indexer|this device/)
  })

  it('renders a hash-less row with no link and names no explorer URL', () => {
    fetchUnifiedActivityMock.mockResolvedValueOnce({
      rows: [unifiedRow({ id: 'nolink', hash: null, url: null, label: 'Agent deployed' })],
      sources: { grant: 'ok' },
      partial: false,
      loading: false,
    })
    render(
      <MemoryRouter initialEntries={['/history']}>
        <HistoryPanel connectedAddress="GOWNER" />
      </MemoryRouter>
    )
    fireEvent.click(screen.getByRole('tab', { name: /All activity/ }))
    return waitFor(() => {
      const unified = document.getElementById('history-panel-all')
      expect(unified.textContent).toMatch(/Agent deployed/)
      expect(unified.querySelector('a')).toBeNull()
      expect(unified.querySelector('button[aria-label^="Open transaction"]')).toBeNull()
      expect(unified.textContent).not.toMatch(/stellar\.expert|blockscout/)
    })
  })

  it('names unavailable sources instead of a false empty list', () => {
    fetchUnifiedActivityMock.mockResolvedValueOnce({
      rows: [],
      sources: { horizon: 'unavailable', base: 'unavailable', local: 'empty' },
      partial: true,
      loading: false,
    })
    render(
      <MemoryRouter initialEntries={['/history']}>
        <HistoryPanel connectedAddress="GOWNER" />
      </MemoryRouter>
    )
    fireEvent.click(screen.getByRole('tab', { name: /All activity/ }))
    return waitFor(() => {
      const unified = document.getElementById('history-panel-all')
      expect(unified.textContent).toMatch(/unavailable right now/)
      expect(unified.textContent).toMatch(/Horizon/)
      expect(unified.textContent).toMatch(/Base indexer/)
    })
  })

  it('links stellar rows to stellar.expert and base rows to blockscout, off row hashes only', () => {
    fetchUnifiedActivityMock.mockResolvedValueOnce({
      rows: [
        unifiedRow({
          id: 's1',
          hash: 'HSTELLAR1',
          url: 'https://stellar.expert/explorer/testnet/tx/HSTELLAR1',
          network: 'stellar',
          source: 'horizon',
        }),
        unifiedRow({
          id: 'b1',
          hash: '0xbase9',
          url: 'https://base-sepolia.blockscout.com/tx/0xbase9',
          network: 'base',
          label: 'Received',
          source: 'base',
        }),
      ],
      sources: { horizon: 'ok', base: 'ok' },
      partial: false,
      loading: false,
    })
    render(
      <MemoryRouter initialEntries={['/history']}>
        <HistoryPanel connectedAddress="GOWNER" />
      </MemoryRouter>
    )
    fireEvent.click(screen.getByRole('tab', { name: /All activity/ }))
    return waitFor(() => {
      const unified = document.getElementById('history-panel-all')
      const stellarBtn = unified.querySelector('button[aria-label^="Open transaction"]')
      expect(stellarBtn).toBeTruthy()
      const baseLink = unified.querySelector('a[href^="https://base-sepolia.blockscout.com/tx/"]')
      expect(baseLink).toBeTruthy()
      expect(baseLink.getAttribute('href')).toBe('https://base-sepolia.blockscout.com/tx/0xbase9')
    })
  })
})
