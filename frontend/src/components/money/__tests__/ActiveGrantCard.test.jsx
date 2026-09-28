// frontend/src/components/money/__tests__/ActiveGrantCard.test.jsx
// P1 G5: the persistent "Active grant" card — remaining + countdown from a mocked allowance,
// fail-soft unavailable, hidden without a grant, and Revoke wired to the owner's handler.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { ActiveGrantCard } from '../ActiveGrantCard.jsx'
import { MyMoneyRoute } from '../MyMoneyRoute.jsx'
import { loadActiveGrant, toActiveGrantView } from '../../../money/activeGrant.js'
import { buildMyMoneyModel } from '../../../money/myMoneyModel.js'

expect.extend(axeMatchers)
afterEach(cleanup)

const OWNER = 'GOWNER'
const ROUTER = 'CROUTER'
const TOKEN = 'CTOKEN'
const NOW_MS = 1_700_000_000_000

const RECEIPT = {
  expiryLedger: 5000,
  confirmedLedger: 1000,
  confirmedAt: 1_700_000_000,
  allowanceBudgets: [{ token: TOKEN, units: '5000000000', decimals: 7 }],
}

// Full loader round-trip off injected mocks: a 500 USDC allowance at ledger 2000 against a
// receipt expiring at 5000 → known view the card renders below.
async function knownGrant() {
  return loadActiveGrant({
    owner: OWNER,
    router: ROUTER,
    token: TOKEN,
    nowMs: NOW_MS,
    deps: {
      readAllowance: async () => ({ amount: 5_000_000_000n }),
      getLatestLedger: async () => 2000,
      loadReceipt: () => RECEIPT,
    },
  })
}

describe('ActiveGrantCard — remaining + countdown from a mocked allowance', () => {
  it('renders the exact remainder, the ledger countdown, and an estimasi date', async () => {
    const grant = await knownGrant()
    expect(grant.state).toBe('known')
    const { container } = render(<ActiveGrantCard grant={grant} onRevoke={vi.fn()} />)
    expect(screen.getByText('Remaining: 500 USDC')).toBeTruthy()
    // 3000 ledgers left at 5s = 15000s ≈ 4 hr; the wall-clock side stays labeled an estimate.
    expect(screen.getByText(/Expires in 3000 ledgers/)).toBeTruthy()
    expect(screen.getByText(/4 hr/)).toBeTruthy()
    expect(screen.getByText(/estimasi/)).toBeTruthy()
    expect(screen.getByText(/15 Nov 2023/)).toBeTruthy()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('says Expires: Unavailable when the grant has no receipt, keeping the remainder', () => {
    const grant = toActiveGrantView({ amount: 5_000_000_000n, nowMs: NOW_MS })
    render(<ActiveGrantCard grant={grant} onRevoke={vi.fn()} />)
    expect(screen.getByText('Remaining: 500 USDC')).toBeTruthy()
    expect(screen.getByText('Expires: Unavailable')).toBeTruthy()
    expect(screen.queryByText(/estimasi/)).toBeNull()
  })
})

describe('ActiveGrantCard — fail-soft, never a fake number', () => {
  it('an RPC failure renders Unavailable rows, no balance, no crash', async () => {
    const grant = await loadActiveGrant({
      owner: OWNER,
      router: ROUTER,
      token: TOKEN,
      deps: {
        readAllowance: async () => {
          throw new Error('rpc down')
        },
        getLatestLedger: async () => 2000,
        loadReceipt: () => RECEIPT,
      },
    })
    expect(grant).toEqual({ state: 'unavailable' })
    const { container } = render(<ActiveGrantCard grant={grant} onRevoke={vi.fn()} />)
    expect(screen.getByText('Remaining: Unavailable')).toBeTruthy()
    expect(screen.getByText('Expires: Unavailable')).toBeTruthy()
    expect(screen.getByRole('status')).toBeTruthy()
    expect(container.textContent).not.toMatch(/500/)
    // The kill switch is never removed for an unread balance — only warned about.
    expect(screen.getByRole('button', { name: 'Revoke grant' })).toBeTruthy()
  })
})

describe('ActiveGrantCard — no active grant renders nothing', () => {
  it.each([
    ['null', null],
    ['none', { state: 'none' }],
  ])('grant=%s renders no DOM', (_label, grant) => {
    const { container } = render(<ActiveGrantCard grant={grant} onRevoke={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })

  it('a confirmed zero allowance hides the card end to end', async () => {
    const grant = await loadActiveGrant({
      owner: OWNER,
      router: ROUTER,
      token: TOKEN,
      deps: {
        readAllowance: async () => ({ amount: 0n }),
        getLatestLedger: async () => 2000,
        loadReceipt: () => null,
      },
    })
    const { container } = render(<ActiveGrantCard grant={grant} onRevoke={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('ActiveGrantCard — Revoke calls the owner handler with no fabricated args', () => {
  it('one click fires onRevoke once; the app controller owns the real revokeGrant call', async () => {
    const grant = await knownGrant()
    const onRevoke = vi.fn()
    render(<ActiveGrantCard grant={grant} onRevoke={onRevoke} />)
    fireEvent.click(screen.getByRole('button', { name: 'Revoke grant' }))
    expect(onRevoke).toHaveBeenCalledTimes(1)
  })

  it('pending disables the button with honest copy and surfaces the mapped error', async () => {
    const grant = await knownGrant()
    render(
      <ActiveGrantCard
        grant={grant}
        onRevoke={vi.fn()}
        revokePending
        revokeError="The wallet refused the signature."
      />
    )
    const button = screen.getByRole('button', { name: 'Revoking…' })
    expect(button.disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toMatch(/refused/)
  })
})

describe('ActiveGrantCard — route placement', () => {
  function headings() {
    return [...document.querySelectorAll('h2')].map((el) => el.textContent)
  }

  it('sits directly after Your money when a grant is active', async () => {
    const grant = await knownGrant()
    render(<MyMoneyRoute model={buildMyMoneyModel({ owner: OWNER })} agents={[]} grant={grant} />)
    expect(headings()).toEqual([
      'Your money',
      'Active grant',
      'Live yield',
      'Your position',
      'Your agent team',
      'Vault protection',
      'How your money is working',
      'Technical details',
      'Recover a Base account',
    ])
  })

  it('closes ranks with Live yield next when no grant prop is passed', () => {
    render(<MyMoneyRoute model={buildMyMoneyModel({ owner: OWNER })} agents={[]} />)
    expect(headings()).toEqual([
      'Your money',
      'Live yield',
      'Your position',
      'Your agent team',
      'Vault protection',
      'How your money is working',
      'Technical details',
      'Recover a Base account',
    ])
  })
})
