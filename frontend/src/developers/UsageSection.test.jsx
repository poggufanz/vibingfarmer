// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import UsageSection from './UsageSection.jsx'

const TODAY = new Date().toISOString().slice(0, 10)

vi.mock('./portalClient.js', () => ({
  listKeys: vi.fn(async () => [
    { id: 'k1', key_hint: 'vf_test_aa…', enabled: 1, rate_limit: 60 },
    { id: 'k2', key_hint: 'vf_live_bb…', enabled: 1, rate_limit: 120 },
  ]),
  getUsage: vi.fn(async () => ({
    usage: [
      { key_id: 'k1', day: TODAY, endpoint: 'GET /prices', count: 12 },
      { key_id: 'k2', day: TODAY, endpoint: 'POST /scan', count: 3 },
      { key_id: 'k1', day: '2026-07-01', endpoint: 'POST /strategy', count: 5 },
    ],
    cap: 5000,
    sinceDay: '2026-06-11',
  })),
}))

afterEach(cleanup)

const SESSION = { jwt: 'JWT', address: 'GAAA' }

const readFor = (state) => ({
  fact: {
    state,
    value: null,
    source: 'Portal API',
    checkedAt: '2026-08-11T00:00:00.000Z',
    staleAfterMs: 120000,
  },
  facts: {
    usage: {
      state,
      value: null,
      source: 'Portal API',
      checkedAt: '2026-08-11T00:00:00.000Z',
      staleAfterMs: 120000,
    },
    cap: {
      state,
      value: { token: 'requests', units: '5000', decimals: 0 },
      source: 'Portal API',
      checkedAt: '2026-08-11T00:00:00.000Z',
      staleAfterMs: 120000,
    },
  },
  keys: [
    { id: 'k1', key_hint: 'vf_test_aa…', enabled: 1, rate_limit: 60 },
    { id: 'k2', key_hint: 'vf_live_bb…', enabled: 1, rate_limit: 120 },
  ],
  usage: [
    { key_id: 'k1', day: TODAY, endpoint: 'GET /prices', count: 12 },
    { key_id: 'k2', day: TODAY, endpoint: 'POST /scan', count: 3 },
  ],
  cap: 5000,
  sinceDay: '2026-06-11',
})

describe('UsageSection', () => {
  it('renders today total vs cap and daily rows', async () => {
    render(<UsageSection session={SESSION} />)
    await waitFor(() => expect(screen.getByText('GET /prices')).toBeTruthy())
    expect(screen.getByText('15')).toBeTruthy() // today total 12+3
    expect(screen.getAllByText(/5,?000/).length).toBeGreaterThan(0) // cap
    expect(screen.getByText('POST /strategy')).toBeTruthy() // history row
  })

  it('filters rows by key', async () => {
    render(<UsageSection session={SESSION} />)
    await waitFor(() => expect(screen.getByText('POST /scan')).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: 'vf_test_aa…' }))
    expect(screen.queryByText('POST /scan')).toBeNull()
    expect(screen.getByText('GET /prices')).toBeTruthy()
  })

  it.each(['loading', 'current', 'stale', 'empty', 'partial', 'error', 'unavailable'])(
    'renders Foundation evidence for a %s portal read',
    (state) => {
      render(<UsageSection session={SESSION} developersRead={readFor(state)} />)

      expect(screen.getByRole('heading', { level: 1 }).hasAttribute('data-route-heading')).toBe(
        true
      )
      expect(document.querySelector(`[data-fact-state="${state}"]`)).toBeTruthy()
      expect(screen.getByText('Technical details')).toBeTruthy()
      expect(screen.getAllByText(/Portal API|Unavailable/).length).toBeGreaterThan(0)
      expect(screen.getAllByText(/Checked at:/i).length).toBeGreaterThan(0)
      expect(
        screen.getAllByText(/Refresh|Wait|Review|Retry|source confirmed/i).length
      ).toBeGreaterThan(0)
    }
  )

  it('keeps the daily cap at the canonical amount boundary', () => {
    render(<UsageSection session={SESSION} developersRead={readFor('current')} />)

    expect(screen.getByText('5,000 requests')).toBeTruthy()
  })

  it.each(['loading', 'error', 'unavailable', 'empty'])(
    'does not fabricate numeric metrics for a %s read',
    (state) => {
      render(<UsageSection session={SESSION} developersRead={readFor(state)} />)

      expect(screen.queryByText('Requests today')).toBeNull()
      expect(screen.queryByText('Daily cap')).toBeNull()
      expect(screen.queryByText('Active keys')).toBeNull()
      expect(screen.queryByText('Requests/minute limit')).toBeNull()
      expect(screen.queryByText('5,000 requests')).toBeNull()
      expect(screen.queryByText(/^60$/)).toBeNull()
      expect(screen.getAllByText(/Checking|Error|Unavailable|Empty/).length).toBeGreaterThan(0)
    }
  )
})
