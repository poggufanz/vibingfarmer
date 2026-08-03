// frontend/src/wallet/ui/classic/HomeScreen.test.jsx
// VF Wallet Task 10, Step 1/2 -- money-first Home. New file: this component previously had no
// dedicated test (its behavior was only exercised indirectly through popup.test.jsx). Restyled
// onto the Pocket Crew pc-* primitives (WalletShell.jsx is the shared style source); this test
// locks in the money-truth rules the recompose is for: an unreadable balance/price is never
// coerced to a zero or an ambiguous "N/A", and an unsupported action never renders as a button
// (fail closed -- no dead button, mirroring MM12/VFW9's Base stop-access precedent).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import HomeScreen from './HomeScreen.jsx'

afterEach(cleanup)

const G_ADDRESS = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXY'

describe('HomeScreen — portfolio total money-truth', () => {
  it('shows Unavailable, never N/A or a coerced $0.00, when the portfolio read failed entirely', () => {
    render(<HomeScreen publicKey={G_ADDRESS} portfolio={null} unfunded={false} />)
    expect(screen.getByText('Unavailable')).toBeTruthy()
    expect(screen.queryByText('N/A')).toBeNull()
    expect(screen.queryByText('$0.00')).toBeNull()
  })

  it('shows a confirmed $0.00 when the portfolio genuinely totals zero and every price resolved', () => {
    render(
      <HomeScreen
        publicKey={G_ADDRESS}
        portfolio={{ total: 0, complete: true, rows: [] }}
        unfunded={false}
      />
    )
    expect(screen.getByText('$0.00')).toBeTruthy()
  })

  it('marks an incomplete total as approximate, with an adjacent completeness note (never a bare confirmed figure)', () => {
    render(
      <HomeScreen
        publicKey={G_ADDRESS}
        portfolio={{
          total: 12.5,
          complete: false,
          rows: [{ asset: 'XLM', code: 'XLM', balance: '12.5000000', usd: null }],
        }}
        unfunded={false}
      />
    )
    expect(screen.getByText('~$12.50')).toBeTruthy()
    expect(screen.getByText(/some prices unavailable/i)).toBeTruthy()
  })

  it('shows an exact total with no approx marker when every price resolved', () => {
    render(
      <HomeScreen
        publicKey={G_ADDRESS}
        portfolio={{
          total: 41.25,
          complete: true,
          rows: [{ asset: 'XLM', code: 'XLM', balance: '10.0000000', usd: 40 }],
        }}
        unfunded={false}
      />
    )
    expect(screen.getByText('$41.25')).toBeTruthy()
    expect(screen.queryByText(/some prices unavailable/i)).toBeNull()
  })
})

describe('HomeScreen — asset rows: raw amount independent of price availability', () => {
  it('always shows the raw asset balance even when its price is unavailable', () => {
    render(
      <HomeScreen
        publicKey={G_ADDRESS}
        portfolio={{
          total: 0,
          complete: false,
          rows: [{ asset: 'XLM', code: 'XLM', balance: '12.5000000', usd: null }],
        }}
        unfunded={false}
      />
    )
    expect(screen.getByText('12.5000000')).toBeTruthy()
    // the row's own price cell says Unavailable, not N/A and not a coerced $0.00
    const row = screen.getByText('12.5000000').closest('li')
    expect(within(row).getByText('Unavailable')).toBeTruthy()
    expect(within(row).queryByText('N/A')).toBeNull()
    expect(within(row).queryByText('$0.00')).toBeNull()
  })

  it('shows a confirmed $0.00 row price only when the asset is genuinely worth zero and priced', () => {
    render(
      <HomeScreen
        publicKey={G_ADDRESS}
        portfolio={{
          total: 0,
          complete: true,
          rows: [{ asset: 'USDC:X', code: 'USDC', balance: '0.0000000', usd: 0 }],
        }}
        unfunded={false}
      />
    )
    const row = screen.getByText('0.0000000').closest('li')
    expect(within(row).getByText('$0.00')).toBeTruthy()
  })
})

describe('HomeScreen — action availability is model-specific (no dead buttons)', () => {
  it('does not render Add asset when the caller has no real add-asset support to offer', () => {
    render(
      <HomeScreen
        publicKey={G_ADDRESS}
        portfolio={null}
        unfunded={false}
        onSend={() => {}}
        onReceive={() => {}}
      />
    )
    expect(screen.queryByRole('button', { name: /add asset/i })).toBeNull()
  })

  it('renders Add asset and fires it exactly once per click when the caller supplies real support', () => {
    const onAddAsset = vi.fn()
    render(
      <HomeScreen publicKey={G_ADDRESS} portfolio={null} unfunded={false} onAddAsset={onAddAsset} />
    )
    fireEvent.click(screen.getByRole('button', { name: /add asset/i }))
    expect(onAddAsset).toHaveBeenCalledTimes(1)
  })

  it('does not render Get test USDC when the caller has no faucet path for this account', () => {
    render(<HomeScreen publicKey={G_ADDRESS} portfolio={null} unfunded={false} />)
    expect(screen.queryByRole('button', { name: /get test usdc/i })).toBeNull()
  })

  it('does not render a Fund banner when the account is already funded', () => {
    render(
      <HomeScreen
        publicKey={G_ADDRESS}
        portfolio={{ total: 0, complete: true, rows: [] }}
        unfunded={false}
      />
    )
    expect(screen.queryByText(/not funded yet/i)).toBeNull()
  })

  it('renders the Fund banner and fires onFund exactly once per click when unfunded', () => {
    const onFund = vi.fn()
    render(<HomeScreen publicKey={G_ADDRESS} portfolio={null} unfunded onFund={onFund} />)
    fireEvent.click(screen.getByRole('button', { name: /fund via friendbot/i }))
    expect(onFund).toHaveBeenCalledTimes(1)
  })

  it('always renders Send and Receive (every account kind Home is used for supports both)', () => {
    const onSend = vi.fn()
    const onReceive = vi.fn()
    render(
      <HomeScreen
        publicKey={G_ADDRESS}
        portfolio={null}
        unfunded={false}
        onSend={onSend}
        onReceive={onReceive}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^receive$/i }))
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onReceive).toHaveBeenCalledTimes(1)
  })
})

describe('HomeScreen — address + copy', () => {
  it('shows a shortened, technical-styled address, never the full string as prose', () => {
    render(<HomeScreen publicKey={G_ADDRESS} portfolio={null} unfunded={false} />)
    expect(screen.getByText(G_ADDRESS.slice(0, 6), { exact: false })).toBeTruthy()
    expect(screen.queryByText(G_ADDRESS)).toBeNull()
  })
})
