// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import _Withdraw from './Withdraw.jsx'

const signAndSubmitUnwind = vi.fn()
const reserveUnwind = vi.fn()
const postUnwindAttach = vi.fn()
const pollUnwindStatus = vi.fn()

vi.mock('../base/withdrawBatch.js', () => ({
  signAndSubmitUnwind: (...args) => signAndSubmitUnwind(...args),
}))
vi.mock('../base/relayerClient.js', () => ({
  reserveUnwind: (...args) => reserveUnwind(...args),
  postUnwindAttach: (...args) => postUnwindAttach(...args),
  pollUnwindStatus: (...args) => pollUnwindStatus(...args),
}))

afterEach(cleanup)

describe('Withdraw legacy deployment fence', () => {
  it('keeps historical balances visible but renders a safe notice and inert CTA', () => {
    render(
      <_Withdraw
        positions={[
          {
            pool: '0xlegacy',
            poolName: 'Historical Base vault',
            assets: 2_000_000n,
            minAssets: 1_990_000n,
          },
        ]}
        idleUsdc={500_000n}
        stellarRecipient="GOWNER"
      />
    )

    expect(screen.getByText('Historical Base vault')).toBeTruthy()
    expect(screen.getByTestId('base-withdraw-total').textContent).toMatch('2.50')
    expect(screen.getByRole('status').textContent).toMatch(/temporarily unavailable/i)
    const button = screen.getByRole('button', { name: /base unavailable/i })
    expect(button.disabled).toBe(true)

    fireEvent.click(button)
    expect(signAndSubmitUnwind).not.toHaveBeenCalled()
    expect(reserveUnwind).not.toHaveBeenCalled()
    expect(postUnwindAttach).not.toHaveBeenCalled()
    expect(pollUnwindStatus).not.toHaveBeenCalled()
  })
})
