// @vitest-environment jsdom
// This project has no global jsdom environment (see vite.config.js); every
// screen test file needs this pragma or `render()` throws "document is not
// defined". The brief's verbatim test code omitted it. Added per precedent
// (Tasks 4/5/8): fix the test minimally, preserve intent, document why.
//
// Two more brief-side bugs fixed the same way:
// - No jest-dom in this repo (see WithdrawModal.test.jsx's precedent comment),
//   so `toBeInTheDocument`/`toHaveTextContent`/`toBeDisabled` all throw
//   "Invalid Chai property". Replaced with plain DOM checks (.textContent,
//   .disabled, .toBeTruthy()/.toBeNull()).
// - @testing-library/react v16 does not auto-clean between tests; without
//   afterEach(cleanup) the second test onward sees leftover DOM from the
//   previous render and getByText/getByRole match multiple elements.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import Withdraw from './Withdraw.jsx'

const signAndSubmitUnwind = vi.fn()
const postUnwind = vi.fn()
const pollFarmStatus = vi.fn()

vi.mock('../base/withdrawBatch.js', () => ({
  signAndSubmitUnwind: (...a) => signAndSubmitUnwind(...a),
}))
vi.mock('../base/relayerClient.js', () => ({
  postUnwind: (...a) => postUnwind(...a),
  pollFarmStatus: (...a) => pollFarmStatus(...a),
}))

const baseProps = {
  ownerKernelAccount: { address: '0xOWNER' },
  publicClient: {},
  positions: [
    { pool: '0xAAAA', poolName: 'Aave v3 USDC', shares: 100n, assets: 2_000_000n, minAssets: 1_990_000n },
    { pool: '0xBBBB', poolName: 'Moonwell USDC', shares: 200n, assets: 3_000_000n, minAssets: 2_985_000n },
  ],
  idleUsdc: 500_000n,
  stellarRecipient: 'GRECIPIENTOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO',
  onClose: vi.fn(),
  onDone: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  // burned/exited/skipped come from signAndSubmitUnwind (it decodes the sweeper's `Swept`
  // event) - NOT from pollFarmStatus. The relayer's real job record (runUnwindJob in
  // relayer/src/httpRouter.mjs) is only ever { status, steps }; it has no such fields, so the
  // pollFarmStatus mock below is intentionally bare to match production shape.
  signAndSubmitUnwind.mockResolvedValue({
    unwindTxHash: '0xUNWIND',
    burned: 5_500_000n,
    exited: 2,
    skipped: 0,
  })
  postUnwind.mockResolvedValue({ jobId: 'job-1' })
  pollFarmStatus.mockResolvedValue({ status: 'done' })
})

afterEach(() => {
  cleanup() // @testing-library/react v16 does not auto-clean; unmount between tests
})

describe('Withdraw (Base full exit)', () => {
  it('shows the total across every position PLUS idle USDC, not the slippage floor', () => {
    render(<Withdraw {...baseProps} />)
    // 2.00 + 3.00 + 0.50 = 5.50, never 5.4775 (the floors) and never one pool alone.
    expect(screen.getByTestId('base-withdraw-total').textContent).toMatch('5.50')
  })

  it('lists every pool and the idle balance before the signature', () => {
    render(<Withdraw {...baseProps} />)
    expect(screen.getByText('Aave v3 USDC')).toBeTruthy()
    expect(screen.getByText('Moonwell USDC')).toBeTruthy()
    expect(screen.getByText(/idle usdc/i)).toBeTruthy()
  })

  it('hides the idle row when there is none', () => {
    render(<Withdraw {...baseProps} idleUsdc={0n} />)
    expect(screen.queryByText(/idle usdc/i)).toBeNull()
  })

  it('uses a short CTA label that cannot wrap', () => {
    render(<Withdraw {...baseProps} />)
    expect(screen.getByRole('button', { name: 'Withdraw all' })).toBeTruthy()
  })

  it('one tap signs the batch, hands it to the relayer, and polls to done', async () => {
    render(<Withdraw {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() => expect(baseProps.onDone).toHaveBeenCalled())
    expect(signAndSubmitUnwind).toHaveBeenCalledWith(
      expect.objectContaining({ positions: baseProps.positions, idleUsdc: 500_000n })
    )
    expect(postUnwind).toHaveBeenCalledWith({
      unwindTxHash: '0xUNWIND',
      stellarRecipient: baseProps.stellarRecipient,
    })
  })

  it('reports a partial exit honestly instead of claiming plain success', async () => {
    // Shape guard: skipped is driven ONLY through signAndSubmitUnwind's return. pollFarmStatus
    // stays the bare relayer shape (see beforeEach) - if the partial banner ever starts reading
    // from pollFarmStatus again, this test stops proving anything and the total is a lie again.
    signAndSubmitUnwind.mockResolvedValue({
      unwindTxHash: '0xUNWIND',
      burned: 2_500_000n,
      exited: 1,
      skipped: 1,
    })
    render(<Withdraw {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() => expect(screen.getByTestId('base-withdraw-partial')).toBeTruthy())
    const partial = screen.getByTestId('base-withdraw-partial')
    expect(partial.textContent).toMatch(/1 pool/i)
    expect(partial.textContent).toMatch(/still on Base/i)
  })

  it('disables the button when there is nothing at all to withdraw', () => {
    render(<Withdraw {...baseProps} positions={[]} idleUsdc={0n} />)
    const btn = screen.getByRole('button', { name: /nothing to withdraw/i })
    expect(btn.disabled).toBe(true)
  })

  it('a hookData failure never reaches the relayer and shows a clear error', async () => {
    signAndSubmitUnwind.mockRejectedValue(new Error('hookData version must be 0, but received 1'))
    render(<Withdraw {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(postUnwind).not.toHaveBeenCalled()
  })

  it('contains no em-dash or en-dash in any rendered text', () => {
    const { container } = render(<Withdraw {...baseProps} />)
    expect(container.textContent).not.toMatch(/[—–]/)
  })
})
