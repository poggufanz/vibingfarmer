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
import _Withdraw from './Withdraw.jsx'

vi.mock('../base/deploymentFacts.js', async () => {
  const { HARDENED_BASE_DEPLOYMENT_FIXTURE } = await import('../base/hardenedDeployment.fixture.js')
  return { RECORDED_BASE_DEPLOYMENT: HARDENED_BASE_DEPLOYMENT_FIXTURE }
})

const signAndSubmitUnwind = vi.fn()
const reserveUnwind = vi.fn()
const postUnwindAttach = vi.fn()
const pollUnwindStatus = vi.fn()
const JOB_ID = '55'.repeat(16)
const USER_OP_HASH = `0x${'33'.repeat(32)}`
const UNWIND_TX_HASH = `0x${'77'.repeat(32)}`
const MINT_TX_HASH = '88'.repeat(32)

vi.mock('../base/withdrawBatch.js', () => ({
  signAndSubmitUnwind: (...a) => signAndSubmitUnwind(...a),
}))
vi.mock('../base/relayerClient.js', () => ({
  reserveUnwind: (...a) => reserveUnwind(...a),
  postUnwindAttach: (...a) => postUnwindAttach(...a),
  pollUnwindStatus: (...a) => pollUnwindStatus(...a),
}))

const baseProps = {
  ownerKernelAccount: { address: '0x0000000000000000000000000000000000000aa1' },
  publicClient: {},
  positions: [
    {
      pool: '0xAAAA',
      poolName: 'Aave v3 USDC',
      shares: 100n,
      assets: 2_000_000n,
      minAssets: 1_990_000n,
    },
    {
      pool: '0xBBBB',
      poolName: 'Moonwell USDC',
      shares: 200n,
      assets: 3_000_000n,
      minAssets: 2_985_000n,
    },
  ],
  idleUsdc: 500_000n,
  stellarRecipient: 'GCXMZCDVYTAANBRASUGWS5GDKRGSQWNM5XHVB4JI7PXECZYKBG5OTTRK',
  onClose: vi.fn(),
  onDone: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  // burned/exited/skipped come only from strict per-UserOperation Swept evidence.
  signAndSubmitUnwind.mockImplementation(async ({ onSubmitted }) => {
    await onSubmitted(USER_OP_HASH)
    return {
      userOpHash: USER_OP_HASH,
      unwindTxHash: UNWIND_TX_HASH,
      burned: 5_500_000n,
      exited: 2,
      skipped: 0,
      evidenceStatus: 'verified',
    }
  })
  reserveUnwind.mockResolvedValue({ jobId: JOB_ID, status: 'awaiting_burn' })
  postUnwindAttach.mockResolvedValue({
    jobId: JOB_ID,
    status: 'relay_pending',
    unwindTxHash: UNWIND_TX_HASH,
  })
  pollUnwindStatus.mockResolvedValue({
    jobId: JOB_ID,
    status: 'done',
    unwindTxHash: UNWIND_TX_HASH,
    mintTxHash: MINT_TX_HASH,
  })
})

afterEach(() => {
  cleanup() // @testing-library/react v16 does not auto-clean; unmount between tests
})

describe('Withdraw (Base full exit)', () => {
  it('shows the total across every position PLUS idle USDC, not the slippage floor', () => {
    render(<_Withdraw {...baseProps} />)
    // 2.00 + 3.00 + 0.50 = 5.50, never 5.4775 (the floors) and never one pool alone.
    expect(screen.getByTestId('base-withdraw-total').textContent).toMatch('5.50')
  })

  it('lists every pool and the idle balance before the signature', () => {
    render(<_Withdraw {...baseProps} />)
    expect(screen.getByText('Aave v3 USDC')).toBeTruthy()
    expect(screen.getByText('Moonwell USDC')).toBeTruthy()
    expect(screen.getByText(/idle usdc/i)).toBeTruthy()
  })

  it('hides the idle row when there is none', () => {
    render(<_Withdraw {...baseProps} idleUsdc={0n} />)
    expect(screen.queryByText(/idle usdc/i)).toBeNull()
  })

  it('uses a short CTA label that cannot wrap', () => {
    render(<_Withdraw {...baseProps} />)
    expect(screen.getByRole('button', { name: 'Withdraw all' })).toBeTruthy()
  })

  it('one tap reserves before passkey signing, attaches exact hashes, and polls to done', async () => {
    const order = []
    reserveUnwind.mockImplementation(async () => {
      order.push('reserve')
      return { jobId: JOB_ID, status: 'awaiting_burn' }
    })
    signAndSubmitUnwind.mockImplementation(async ({ onSubmitted }) => {
      order.push('sign')
      await onSubmitted(USER_OP_HASH)
      order.push('checkpoint')
      return {
        userOpHash: USER_OP_HASH,
        unwindTxHash: UNWIND_TX_HASH,
        burned: 5_500_000n,
        exited: 2n,
        skipped: 0n,
        evidenceStatus: 'verified',
      }
    })
    postUnwindAttach.mockImplementation(async () => {
      order.push('attach')
      return { jobId: JOB_ID, status: 'relay_pending', unwindTxHash: UNWIND_TX_HASH }
    })
    pollUnwindStatus.mockImplementation(async () => {
      order.push('poll')
      return {
        jobId: JOB_ID,
        status: 'done',
        unwindTxHash: UNWIND_TX_HASH,
        mintTxHash: MINT_TX_HASH,
      }
    })
    render(<_Withdraw {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() => expect(baseProps.onDone).toHaveBeenCalled())
    expect(order).toEqual(['reserve', 'sign', 'checkpoint', 'attach', 'poll'])
    expect(reserveUnwind).toHaveBeenCalledWith({
      kernelAddress: baseProps.ownerKernelAccount.address,
      recipientHint: baseProps.stellarRecipient,
    })
    expect(signAndSubmitUnwind).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        positions: baseProps.positions,
        idleUsdc: 500_000n,
        deadline: expect.any(BigInt),
        onSubmitted: expect.any(Function),
      })
    )
    expect(postUnwindAttach).toHaveBeenCalledWith({
      jobId: JOB_ID,
      userOpHash: USER_OP_HASH,
      unwindTxHash: UNWIND_TX_HASH,
    })
    expect(pollUnwindStatus).toHaveBeenCalledWith({ jobId: JOB_ID })
  })

  it('offers exactly the 5/10/15-minute authorization windows and defaults to 10 minutes', () => {
    render(<_Withdraw {...baseProps} />)
    const select = screen.getByLabelText(/authorization expires/i)

    expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
      ['5', '5 minutes'],
      ['10', '10 minutes'],
      ['15', '15 minutes'],
    ])
    expect(select.value).toBe('10')
  })

  it.each([5, 10, 15])(
    'encodes the owner-selected %i-minute authorization window as an exact absolute deadline',
    async (minutes) => {
      const nowMs = 2_000_000_000_000
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs)
      render(<_Withdraw {...baseProps} />)
      fireEvent.change(screen.getByLabelText(/authorization expires/i), {
        target: { value: String(minutes) },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
      await waitFor(() => expect(signAndSubmitUnwind).toHaveBeenCalled())
      expect(signAndSubmitUnwind).toHaveBeenCalledWith(
        expect.objectContaining({
          nowSeconds: 2_000_000_000n,
          deadline: 2_000_000_000n + BigInt(minutes * 60),
        })
      )
      nowSpy.mockRestore()
    }
  )

  it('keeps job-only unwind status fail-closed instead of borrowing mandate authority', async () => {
    pollUnwindStatus.mockRejectedValue(new Error('unwind capability unavailable'))
    render(<_Withdraw {...baseProps} mandateId={'11'.repeat(16)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())

    expect(pollUnwindStatus).toHaveBeenCalledWith({ jobId: JOB_ID })
    expect(pollUnwindStatus.mock.calls[0][0]).not.toHaveProperty('mandateId')
    expect(baseProps.onDone).not.toHaveBeenCalled()
  })

  it('reports a partial exit honestly instead of claiming plain success', async () => {
    // Shape guard: skipped is driven only through signAndSubmitUnwind's strict evidence result.
    signAndSubmitUnwind.mockImplementation(async ({ onSubmitted }) => {
      await onSubmitted(USER_OP_HASH)
      return {
        userOpHash: USER_OP_HASH,
        unwindTxHash: UNWIND_TX_HASH,
        burned: 2_500_000n,
        exited: 1,
        skipped: 1,
        evidenceStatus: 'verified',
      }
    })
    render(<_Withdraw {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() => expect(screen.getByTestId('base-withdraw-partial')).toBeTruthy())
    const partial = screen.getByTestId('base-withdraw-partial')
    expect(partial.textContent).toMatch(/1 pool/i)
    expect(partial.textContent).toMatch(/still on Base/i)
  })

  it('disables the button when there is nothing at all to withdraw', () => {
    render(<_Withdraw {...baseProps} positions={[]} idleUsdc={0n} />)
    const btn = screen.getByRole('button', { name: /nothing to withdraw/i })
    expect(btn.disabled).toBe(true)
  })

  it('a hookData failure never reaches the relayer and shows a clear error', async () => {
    signAndSubmitUnwind.mockRejectedValue(new Error('hookData version must be 0, but received 1'))
    render(<_Withdraw {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(postUnwindAttach).not.toHaveBeenCalled()
  })

  it('never auto-attaches a landed burn whose frontend Swept decode needs reconciliation', async () => {
    signAndSubmitUnwind.mockImplementation(async ({ onSubmitted }) => {
      await onSubmitted(USER_OP_HASH)
      return {
        userOpHash: USER_OP_HASH,
        unwindTxHash: UNWIND_TX_HASH,
        burned: null,
        exited: null,
        skipped: null,
        evidenceStatus: 'needs_reconcile',
      }
    })
    render(<_Withdraw {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))

    await waitFor(() => expect(screen.getByTestId('base-withdraw-reconcile')).toBeTruthy())
    expect(reserveUnwind).toHaveBeenCalledTimes(1)
    expect(signAndSubmitUnwind).toHaveBeenCalledTimes(1)
    expect(postUnwindAttach).not.toHaveBeenCalled()
    expect(pollUnwindStatus).not.toHaveBeenCalled()
    expect(baseProps.onDone).not.toHaveBeenCalled()
    const close = screen.getByRole('button', { name: 'Close' })
    fireEvent.click(close)
    expect(baseProps.onClose).toHaveBeenCalledTimes(1)
    expect(reserveUnwind).toHaveBeenCalledTimes(1)
    expect(signAndSubmitUnwind).toHaveBeenCalledTimes(1)
  })

  it('a reservation failure occurs before any passkey ceremony or Base send', async () => {
    reserveUnwind.mockRejectedValue(new Error('reservation unavailable'))
    render(<_Withdraw {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(reserveUnwind).toHaveBeenCalledTimes(1)
    expect(signAndSubmitUnwind).not.toHaveBeenCalled()
    expect(postUnwindAttach).not.toHaveBeenCalled()
  })

  it('a submitted-but-checkpoint-failed result exposes no resend retry path', async () => {
    signAndSubmitUnwind.mockImplementation(async ({ onSubmitted }) => {
      await onSubmitted(USER_OP_HASH)
      throw Object.assign(new Error('checkpoint failed'), {
        code: 'submitted-but-checkpoint-failed',
        userOpHash: USER_OP_HASH,
      })
    })
    render(<_Withdraw {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() => expect(screen.getByTestId('base-withdraw-reconcile')).toBeTruthy())

    expect(screen.queryByRole('button', { name: /retry withdraw/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(reserveUnwind).toHaveBeenCalledTimes(1)
    expect(signAndSubmitUnwind).toHaveBeenCalledTimes(1)
    expect(postUnwindAttach).not.toHaveBeenCalled()
  })

  it('an unknown submission result is close-only and never reserves or signs again', async () => {
    signAndSubmitUnwind.mockRejectedValue(
      Object.assign(new Error('unwind submission status is unknown'), {
        code: 'submission_unknown',
      })
    )
    render(<_Withdraw {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))

    await waitFor(() => expect(screen.getByTestId('base-withdraw-reconcile')).toBeTruthy())
    expect(screen.getByTestId('base-withdraw-reconcile').textContent).toMatch(
      /may have been submitted/i
    )
    expect(screen.queryByRole('button', { name: /retry withdraw/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(baseProps.onClose).toHaveBeenCalledTimes(1)
    expect(reserveUnwind).toHaveBeenCalledTimes(1)
    expect(signAndSubmitUnwind).toHaveBeenCalledTimes(1)
    expect(postUnwindAttach).not.toHaveBeenCalled()
    expect(pollUnwindStatus).not.toHaveBeenCalled()
  })

  it('a pre-submit passkey rejection leaves only an expirable reservation and no attach', async () => {
    signAndSubmitUnwind.mockRejectedValue(new Error('user rejected passkey'))
    render(<_Withdraw {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(reserveUnwind).toHaveBeenCalledTimes(1)
    expect(signAndSubmitUnwind).toHaveBeenCalledTimes(1)
    expect(postUnwindAttach).not.toHaveBeenCalled()
    expect(pollUnwindStatus).not.toHaveBeenCalled()
  })

  it('an attach timeout retries attach/status only and never reserves or signs a second UserOperation', async () => {
    postUnwindAttach.mockRejectedValueOnce(new Error('attach timeout')).mockResolvedValueOnce({
      jobId: JOB_ID,
      status: 'relay_pending',
      unwindTxHash: UNWIND_TX_HASH,
    })
    render(<_Withdraw {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    await waitFor(() => expect(baseProps.onDone).toHaveBeenCalled())
    expect(reserveUnwind).toHaveBeenCalledTimes(1)
    expect(signAndSubmitUnwind).toHaveBeenCalledTimes(1)
    expect(postUnwindAttach).toHaveBeenCalledTimes(2)
    expect(pollUnwindStatus).toHaveBeenCalledTimes(1)
  })

  it('a status timeout retries status only and never re-attaches or re-signs', async () => {
    pollUnwindStatus.mockRejectedValueOnce(new Error('status timeout')).mockResolvedValueOnce({
      jobId: JOB_ID,
      status: 'done',
      unwindTxHash: UNWIND_TX_HASH,
      mintTxHash: MINT_TX_HASH,
    })
    render(<_Withdraw {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    await waitFor(() => expect(baseProps.onDone).toHaveBeenCalled())
    expect(reserveUnwind).toHaveBeenCalledTimes(1)
    expect(signAndSubmitUnwind).toHaveBeenCalledTimes(1)
    expect(postUnwindAttach).toHaveBeenCalledTimes(1)
    expect(pollUnwindStatus).toHaveBeenCalledTimes(2)
  })

  it.each(['blocked', 'uncertain', 'expired'])(
    'renders terminal %s honestly without onDone or a resend action',
    async (terminal) => {
      pollUnwindStatus.mockResolvedValue({ jobId: JOB_ID, status: terminal })
      render(<_Withdraw {...baseProps} />)
      fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
      await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())

      expect(screen.getByRole('alert').textContent).toMatch(new RegExp(terminal, 'i'))
      expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
      expect(baseProps.onDone).not.toHaveBeenCalled()
      expect(reserveUnwind).toHaveBeenCalledTimes(1)
      expect(signAndSubmitUnwind).toHaveBeenCalledTimes(1)
    }
  )

  it('contains no em-dash or en-dash in any rendered text', () => {
    const { container } = render(<_Withdraw {...baseProps} />)
    expect(container.textContent).not.toMatch(/[—–]/)
  })
})
