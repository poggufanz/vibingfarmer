// frontend/src/components/money/__tests__/LiveYieldCard.test.jsx
// G2 follow-up: the production yield section — live APR line, PPS sparkline, trailing APYs,
// and honest unavailable states. Derivations come from the real ppsHistory module (already
// unit-tested itself); these tests pin RENDERING: what the owner sees for each state.
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { LiveYieldCard } from '../LiveYieldCard.jsx'

afterEach(cleanup)

// The lead readout (label + figure + age) is one <div> inside the readout <dl>.
const leadReadout = () => screen.getByText('Live supply APY').closest('div')

const NOW = 1_700_000_000_000
const DAY = 24 * 3600 * 1000
// 1.000 → 1.001 over exactly 7 days: CAGR = (1.001^(365/7) - 1) * 100 ≈ 5.35%.
const WEEK_SERIES = [
  { t: NOW - 7 * DAY, pps: '10000000' },
  { t: NOW, pps: '10010000' },
]
const WEEK_APY = ((1.001 ** (365 / 7) - 1) * 100).toFixed(2)

describe('LiveYieldCard — live APR plus sparkline and trailing APYs', () => {
  it('renders the live line with its read age, the sparkline, and both trailing APYs', () => {
    const { container } = render(
      <LiveYieldCard
        liveApr={{ state: 'live', aprPct: 4.16, asOf: NOW - 45_000 }}
        series={WEEK_SERIES}
        nowMs={NOW}
      />
    )
    expect(within(leadReadout()).getByText('4.16%')).toBeTruthy()
    expect(within(leadReadout()).getByText('Updated 45s ago')).toBeTruthy()
    const svg = container.querySelector('svg[role="img"]')
    expect(svg?.getAttribute('aria-label')).toMatch(/Price per share history, 2 samples/)
    const seven = screen.getByText('7 day trailing APY').closest('div')
    const thirty = screen.getByText('30 day trailing APY').closest('div')
    expect(within(seven).getByText(`${WEEK_APY}%`)).toBeTruthy()
    expect(within(thirty).getByText(`${WEEK_APY}%`)).toBeTruthy()
  })
})

describe('LiveYieldCard — fail-soft, never a fake number', () => {
  it('a failed APR read renders unavailable while history still shows', () => {
    render(
      <LiveYieldCard
        liveApr={{ state: 'unavailable', aprPct: null, asOf: null }}
        series={WEEK_SERIES}
        nowMs={NOW}
      />
    )
    expect(within(leadReadout()).getByText('Unavailable')).toBeTruthy()
    expect(within(leadReadout()).queryByText(/%/)).toBeNull()
    expect(within(leadReadout()).queryByText(/Updated/)).toBeNull()
    expect(screen.getByText('7 day trailing APY')).toBeTruthy()
  })

  it.each([
    ['empty', []],
    ['single-sample', [{ t: NOW, pps: '10000000' }]],
  ])('a %s series renders unavailable with no SVG curve', (_label, series) => {
    const { container } = render(
      <LiveYieldCard
        liveApr={{ state: 'live', aprPct: 4.16, asOf: NOW }}
        series={series}
        nowMs={NOW}
      />
    )
    expect(screen.getByText('Price history unavailable')).toBeTruthy()
    expect(container.querySelector('svg')).toBeNull()
    expect(screen.queryByText(/trailing APY/)).toBeNull()
  })

  it('defaults (no props) render unavailable, never NaN or a crash', () => {
    const { container } = render(<LiveYieldCard />)
    expect(within(leadReadout()).getByText('Unavailable')).toBeTruthy()
    expect(screen.getByText('Price history unavailable')).toBeTruthy()
    expect(container.textContent).not.toMatch(/NaN/)
  })
})

describe('LiveYieldCard — pre-read states stay quiet', () => {
  it('loading shows a checking line with no APY copy at all', () => {
    const { container } = render(
      <LiveYieldCard liveApr={null} series={[]} nowMs={NOW} collectionState="loading" />
    )
    expect(screen.getByText('Checking live yield…')).toBeTruthy()
    expect(container.textContent).not.toMatch(/APY/)
  })

  it('disconnected asks for a wallet', () => {
    render(<LiveYieldCard liveApr={null} series={[]} nowMs={NOW} collectionState="disconnected" />)
    expect(screen.getByText('Connect a wallet to see live yield.')).toBeTruthy()
  })
})
