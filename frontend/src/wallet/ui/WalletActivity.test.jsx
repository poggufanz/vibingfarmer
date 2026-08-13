// frontend/src/wallet/ui/WalletActivity.test.jsx
// VF Wallet Task 10, Step 3 -- truthful Activity, account-agnostic. Wires WalletShell (account
// chip, "Stellar testnet" text, the beginner nav) around classic/HistoryScreen.jsx for the Stellar
// leg, plus a structurally-separate Base Sepolia leg (network badge, direction, amount, state,
// time, explorer link, proxy/custody wording) the extension can render whenever it is GIVEN real
// Base activity -- which it is not yet (see this file's own header for why `baseItems` defaults to
// null and popup.jsx never populates it today: the wallet extension has no live Base activity data
// source, only the main app's My Money surface does).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { WalletActivity } from './WalletActivity.jsx'

afterEach(cleanup)

const G_ACCOUNT = {
  kind: 'G',
  address: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXY',
}

describe('WalletActivity — shell wiring', () => {
  it('renders extra children after the activity content (e.g. an explorer link)', () => {
    render(
      <WalletActivity account={G_ACCOUNT} onNav={() => {}} items={[]}>
        <p data-testid="extra">extra link</p>
      </WalletActivity>
    )
    expect(screen.getByTestId('extra')).toBeTruthy()
  })

  it('renders exactly the Home/Activity/Settings nav with Activity current', () => {
    render(<WalletActivity account={G_ACCOUNT} onNav={() => {}} />)
    const bar = screen.getByRole('navigation')
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Home', 'Activity', 'Settings'])
    expect(within(bar).getByText('Activity').getAttribute('aria-current')).toBe('page')
  })

  it('fires onNav with the tapped tab id', () => {
    const onNav = vi.fn()
    render(<WalletActivity account={G_ACCOUNT} onNav={onNav} />)
    fireEvent.click(screen.getByText('Home'))
    expect(onNav).toHaveBeenCalledWith('home')
  })
})

describe('WalletActivity — Stellar leg (money-truth: unavailable vs genuinely empty)', () => {
  it('says unavailable, not empty, when history could not be read at all', () => {
    render(<WalletActivity account={G_ACCOUNT} onNav={() => {}} items={null} />)
    expect(screen.getByText(/unavailable/i)).toBeTruthy()
    expect(screen.queryByText(/no stellar activity yet/i)).toBeNull()
  })

  it('says no activity yet for a genuinely empty (successfully read) history', () => {
    render(<WalletActivity account={G_ACCOUNT} onNav={() => {}} items={[]} />)
    expect(screen.getByText(/no stellar activity yet/i)).toBeTruthy()
    expect(screen.queryByText(/unavailable/i)).toBeNull()
  })

  // VF Wallet Task 12, Part A2 -- the empty-state copy previously read as an unscoped, unqualified
  // "Activity" claim ("No activity yet...") on a surface that structurally cannot see Base
  // activity (see WalletActivity.jsx's own header). Both sentences must name Stellar explicitly.
  it('scopes the empty-state copy to Stellar explicitly, never an unqualified "Activity" claim', () => {
    render(<WalletActivity account={G_ACCOUNT} onNav={() => {}} items={[]} />)
    expect(screen.getByText(/no stellar activity yet/i)).toBeTruthy()
    expect(screen.getByText(/stellar transactions will appear here/i)).toBeTruthy()
  })

  it('renders a Stellar testnet row with direction, amount, confirmed state, time, and an explorer link', () => {
    render(
      <WalletActivity
        account={G_ACCOUNT}
        onNav={() => {}}
        items={[
          {
            id: 'op-1',
            direction: 'in',
            from: 'GFROMFROMFROMFROMFROMFROMFROMFROMFROMFROMFROMFROMFROM',
            to: G_ACCOUNT.address,
            asset: 'XLM',
            amount: '5.0000000',
            createdAt: '2026-07-20T00:00:00Z',
          },
        ]}
      />
    )
    // "Stellar testnet" appears twice by design: WalletShell's header trust anchor, and this
    // row's own network badge -- both are required, so assert at least two, not exactly one.
    expect(screen.getAllByText('Stellar testnet').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(/received xlm/i)).toBeTruthy()
    expect(screen.getByText(/\+5\.0000000/)).toBeTruthy()
    expect(screen.getByText(/confirmed/i)).toBeTruthy()
    expect(screen.getByText(/2026-07-20/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /view/i }).getAttribute('href')).toMatch(
      /stellar\.expert/
    )
  })
})

describe('WalletActivity — Base Sepolia leg (structural, proxy/custody wording preserved)', () => {
  it('renders nothing extra when no Base activity is supplied (the honest default today)', () => {
    render(<WalletActivity account={G_ACCOUNT} onNav={() => {}} items={[]} />)
    expect(screen.queryByText('Base Sepolia')).toBeNull()
  })

  it('does not render an unverified Base payload as activity', () => {
    render(
      <WalletActivity
        account={G_ACCOUNT}
        onNav={() => {}}
        items={[]}
        baseItems={{ verified: false, items: [{ id: 'unverified', asset: 'USDC' }] }}
      />
    )
    expect(screen.queryByTestId('base-activity')).toBeNull()
  })

  it('renders a Base row with its own network badge, direction, amount, and retains proxy/custody wording', () => {
    render(
      <WalletActivity
        account={G_ACCOUNT}
        onNav={() => {}}
        items={[]}
        baseItems={[
          {
            id: 'base-1',
            direction: 'in',
            asset: 'USDC',
            amount: '10.00',
            state: 'Confirmed',
            time: '2026-07-20',
            explorerUrl: 'https://sepolia.basescan.org/tx/0xabc',
          },
        ]}
      />
    )
    expect(screen.getByRole('heading', { name: 'Base Sepolia' })).toBeTruthy()
    expect(screen.getAllByText('Base Sepolia').length).toBeGreaterThanOrEqual(2) // section heading + row network badge
    expect(screen.getByText(/received usdc/i)).toBeTruthy()
    expect(screen.getByText(/\+10\.00/)).toBeTruthy()
    expect(screen.getByText(/custody-only/i)).toBeTruthy()
    expect(screen.getByText(/proxy/i)).toBeTruthy()
    expect(screen.getByText(/no yield/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /view/i }).getAttribute('href')).toBe(
      'https://sepolia.basescan.org/tx/0xabc'
    )
  })
})
