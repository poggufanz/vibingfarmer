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
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import _Withdraw from './Withdraw.jsx'
import { BASE_CROSS_CHAIN_AVAILABLE } from '../base/config.js'

const here = path.dirname(fileURLToPath(import.meta.url))

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
      decimals: 6,
      minAssets: 1_990_000n,
    },
    {
      pool: '0xBBBB',
      poolName: 'Moonwell USDC',
      shares: 200n,
      assets: 3_000_000n,
      decimals: 6,
      minAssets: 2_985_000n,
    },
  ],
  idleUsdc: 500_000n,
  stellarRecipient: 'GCXMZCDVYTAANBRASUGWS5GDKRGSQWNM5XHVB4JI7PXECZYKBG5OTTRK',
  // The production default remains fail-closed. Tests that exercise the available Base surface
  // explicitly opt into the deterministic fixture seam rather than replacing deployment truth.
  baseCrossChainAvailable: true,
  onClose: vi.fn(),
  onDone: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
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
  it('defaults to the imported fail-closed deployment gate when no fixture override is provided', () => {
    expect(BASE_CROSS_CHAIN_AVAILABLE).toBe(false)
    render(<_Withdraw {...baseProps} baseCrossChainAvailable={undefined} />)

    const button = screen.getByRole('button', { name: 'Base unavailable' })
    expect(button.disabled).toBe(true)
    expect(screen.getByTestId('base-unavailable-notice')).toBeTruthy()

    fireEvent.click(button)
    expect(reserveUnwind).not.toHaveBeenCalled()
    expect(signAndSubmitUnwind).not.toHaveBeenCalled()
    expect(postUnwindAttach).not.toHaveBeenCalled()
    expect(pollUnwindStatus).not.toHaveBeenCalled()
  })

  it('uses an explicit false injection for unavailable labeling and an inert CTA', () => {
    const adapters = {
      reserveUnwind: vi.fn(),
      signAndSubmitUnwind: vi.fn(),
      postUnwindAttach: vi.fn(),
      pollUnwindStatus: vi.fn(),
    }
    render(<_Withdraw {...baseProps} baseCrossChainAvailable={false} withdrawAdapters={adapters} />)

    const button = screen.getByRole('button', { name: 'Base unavailable' })
    expect(button.disabled).toBe(true)
    expect(screen.getByTestId('base-unavailable-notice')).toBeTruthy()
    fireEvent.click(button)
    expect(adapters.reserveUnwind).not.toHaveBeenCalled()
    expect(adapters.signAndSubmitUnwind).not.toHaveBeenCalled()
  })

  it('uses an explicit true injection to start through deterministic adapters without signing or network clients', async () => {
    const adapters = {
      reserveUnwind: vi.fn(() => new Promise(() => {})),
      signAndSubmitUnwind: vi.fn(),
      postUnwindAttach: vi.fn(),
      pollUnwindStatus: vi.fn(),
    }
    render(<_Withdraw {...baseProps} baseCrossChainAvailable withdrawAdapters={adapters} />)

    const button = screen.getByRole('button', { name: 'Withdraw all' })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preparing...' })).toBeTruthy())
    expect(adapters.reserveUnwind).toHaveBeenCalledWith({
      kernelAddress: baseProps.ownerKernelAccount.address,
      recipientHint: baseProps.stellarRecipient,
    })
    expect(adapters.signAndSubmitUnwind).not.toHaveBeenCalled()
    expect(reserveUnwind).not.toHaveBeenCalled()
    expect(signAndSubmitUnwind).not.toHaveBeenCalled()
  })

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
    const route = screen.getByLabelText('Network route facts')
    expect(route.textContent).toMatch(/Custody: Unknown network/)
    expect(route.textContent).toMatch(/Transit: unknown/)
    expect(route.textContent).not.toMatch(/Transit: arrived/)
    expect(route.textContent).not.toMatch(/Arrived on Stellar testnet/)
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

  it('turns a real awaited localStorage checkpoint failure into submitted-but-checkpoint-failed and stays close-only', async () => {
    const nativeSetItem = Storage.prototype.setItem
    const checkpointFailure = new DOMException('quota exhausted', 'QuotaExceededError')
    const submitted = []
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (key, value) {
        if (
          String(key).startsWith('vf.cctpTransfer.v1:') &&
          String(value).includes('"state":"userop_submitted"')
        ) {
          throw checkpointFailure
        }
        return nativeSetItem.call(this, key, value)
      })
    signAndSubmitUnwind.mockImplementation(async ({ onSubmitted }) => {
      try {
        await onSubmitted(USER_OP_HASH)
      } catch {
        const typed = Object.assign(new Error('unwind was submitted but its checkpoint failed'), {
          code: 'submitted-but-checkpoint-failed',
          userOpHash: USER_OP_HASH,
        })
        submitted.push(typed)
        throw typed
      }
      throw new Error('receipt wait must not start after a failed checkpoint')
    })

    try {
      render(<_Withdraw {...baseProps} />)
      fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
      await waitFor(() => expect(screen.getByTestId('base-withdraw-reconcile')).toBeTruthy())

      expect(submitted).toEqual([
        expect.objectContaining({
          code: 'submitted-but-checkpoint-failed',
          userOpHash: USER_OP_HASH,
        }),
      ])
      const journalKey = Object.keys(window.localStorage).find((key) =>
        key.startsWith('vf.cctpTransfer.v1:')
      )
      expect(JSON.parse(window.localStorage.getItem(journalKey)).state).toBe('userop_submitting')
      expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
      expect(postUnwindAttach).not.toHaveBeenCalled()
      expect(pollUnwindStatus).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      expect(reserveUnwind).toHaveBeenCalledTimes(1)
      expect(signAndSubmitUnwind).toHaveBeenCalledTimes(1)
    } finally {
      setItem.mockRestore()
    }
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

  it('keeps a verified burn in transit while attach is pending', async () => {
    let resolveAttach
    postUnwindAttach.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAttach = resolve
        })
    )
    render(<_Withdraw {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() => expect(postUnwindAttach).toHaveBeenCalled())

    const route = screen.getByLabelText('Network route facts')
    expect(route.textContent).toMatch(/Custody: Unknown network/)
    expect(route.textContent).toMatch(/Transit: burning/)
    expect(route.textContent).not.toMatch(/Transit: none/)
    expect(route.textContent).not.toMatch(/Settled on Base Sepolia/)
    resolveAttach?.({ jobId: JOB_ID, status: 'relay_pending', unwindTxHash: UNWIND_TX_HASH })
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

  it('keeps a verified burn unknown when status polling errors and exposes retry', async () => {
    pollUnwindStatus.mockRejectedValueOnce(new Error('status timeout'))
    render(<_Withdraw {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry status' })).toBeTruthy())

    const route = screen.getByLabelText('Network route facts')
    expect(route.textContent).toMatch(/Custody: Unknown network/)
    expect(route.textContent).toMatch(/Transit: unknown/)
    expect(route.textContent).not.toMatch(/Transit: none/)
    expect(route.textContent).not.toMatch(/Settled on Base Sepolia/)
    fireEvent.click(screen.getByRole('button', { name: 'Retry status' }))
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

describe('Withdraw injected adapter boundary', () => {
  const evidence = {
    userOpHash: USER_OP_HASH,
    unwindTxHash: UNWIND_TX_HASH,
    burned: 5_500_000n,
    exited: 2,
    skipped: 0,
    evidenceStatus: 'verified',
  }

  const deferred = () => {
    let resolve
    const promise = new Promise((answer) => {
      resolve = answer
    })
    return { promise, resolve }
  }

  it('drives each real unwind stage through injected adapters without calling defaults', async () => {
    const reserveGate = deferred()
    const signGate = deferred()
    const attachGate = deferred()
    const pollGate = deferred()
    const order = []
    const adapters = {
      reserveUnwind: vi.fn(async () => {
        order.push('reserve')
        return reserveGate.promise
      }),
      signAndSubmitUnwind: vi.fn(async ({ onSubmitted }) => {
        order.push('sign')
        await signGate.promise
        await onSubmitted(USER_OP_HASH)
        return evidence
      }),
      postUnwindAttach: vi.fn(async () => {
        order.push('attach')
        await attachGate.promise
        return { jobId: JOB_ID, status: 'relay_pending', unwindTxHash: UNWIND_TX_HASH }
      }),
      pollUnwindStatus: vi.fn(async () => {
        order.push('poll')
        await pollGate.promise
        return {
          jobId: JOB_ID,
          status: 'done',
          unwindTxHash: UNWIND_TX_HASH,
          mintTxHash: MINT_TX_HASH,
        }
      }),
    }

    render(<_Withdraw {...baseProps} withdrawAdapters={adapters} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /preparing/i })).toBeTruthy())
    expect(order).toEqual(['reserve'])

    reserveGate.resolve({ jobId: JOB_ID, status: 'awaiting_burn' })
    await waitFor(() => expect(screen.getByRole('button', { name: /signing/i })).toBeTruthy())
    expect(order).toEqual(['reserve', 'sign'])

    signGate.resolve()
    await waitFor(() => expect(screen.getByRole('button', { name: /relaying/i })).toBeTruthy())
    expect(order).toEqual(['reserve', 'sign', 'attach'])

    attachGate.resolve()
    await waitFor(() => expect(screen.getByRole('button', { name: /bridging/i })).toBeTruthy())
    expect(order).toEqual(['reserve', 'sign', 'attach', 'poll'])

    pollGate.resolve()
    await waitFor(() => expect(baseProps.onDone).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
    expect(reserveUnwind).not.toHaveBeenCalled()
    expect(signAndSubmitUnwind).not.toHaveBeenCalled()
    expect(postUnwindAttach).not.toHaveBeenCalled()
    expect(pollUnwindStatus).not.toHaveBeenCalled()
  })

  it.each([
    ['failed', Object.assign(new Error('injected failure'), { code: 'relayer_unavailable' })],
    [
      'submission unknown',
      Object.assign(new Error('injected submission is unknown'), { code: 'submission_unknown' }),
    ],
  ])('renders injected %s without falling back to the imported clients', async (_label, error) => {
    const adapters = {
      reserveUnwind: vi.fn().mockResolvedValue({ jobId: JOB_ID, status: 'awaiting_burn' }),
      signAndSubmitUnwind: vi.fn().mockRejectedValue(error),
      postUnwindAttach: vi.fn(),
      pollUnwindStatus: vi.fn(),
    }

    render(<_Withdraw {...baseProps} withdrawAdapters={adapters} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() =>
      expect(
        error.code === 'submission_unknown'
          ? screen.getByTestId('base-withdraw-reconcile')
          : screen.getByRole('alert')
      ).toBeTruthy()
    )

    expect(adapters.reserveUnwind).toHaveBeenCalledTimes(1)
    expect(adapters.signAndSubmitUnwind).toHaveBeenCalledTimes(1)
    expect(adapters.postUnwindAttach).not.toHaveBeenCalled()
    expect(adapters.pollUnwindStatus).not.toHaveBeenCalled()
    expect(reserveUnwind).not.toHaveBeenCalled()
    expect(signAndSubmitUnwind).not.toHaveBeenCalled()
    expect(postUnwindAttach).not.toHaveBeenCalled()
    expect(pollUnwindStatus).not.toHaveBeenCalled()

    if (error.code === 'submission_unknown') {
      expect(screen.getByTestId('base-withdraw-reconcile').textContent).toMatch(
        /may have been submitted/i
      )
      expect(screen.queryByRole('button', { name: /retry withdraw/i })).toBeNull()
    }
  })

  it('keeps an injected relayer-running result pending without claiming completion', async () => {
    const adapters = {
      reserveUnwind: vi.fn().mockResolvedValue({ jobId: JOB_ID, status: 'awaiting_burn' }),
      signAndSubmitUnwind: vi.fn(async ({ onSubmitted }) => {
        await onSubmitted(USER_OP_HASH)
        return evidence
      }),
      postUnwindAttach: vi.fn().mockResolvedValue({
        jobId: JOB_ID,
        status: 'relay_pending',
        unwindTxHash: UNWIND_TX_HASH,
      }),
      pollUnwindStatus: vi.fn().mockResolvedValue({
        jobId: JOB_ID,
        status: 'relay_running',
        unwindTxHash: UNWIND_TX_HASH,
      }),
    }

    render(<_Withdraw {...baseProps} withdrawAdapters={adapters} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() =>
      expect(screen.getByText(/still settling\. the relayer is finishing/i)).toBeTruthy()
    )

    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    expect(baseProps.onDone).not.toHaveBeenCalled()
    expect(adapters.reserveUnwind).toHaveBeenCalledTimes(1)
    expect(adapters.signAndSubmitUnwind).toHaveBeenCalledTimes(1)
    expect(adapters.postUnwindAttach).toHaveBeenCalledTimes(1)
    expect(adapters.pollUnwindStatus).toHaveBeenCalledTimes(1)
    expect(reserveUnwind).not.toHaveBeenCalled()
    expect(signAndSubmitUnwind).not.toHaveBeenCalled()
    expect(postUnwindAttach).not.toHaveBeenCalled()
    expect(pollUnwindStatus).not.toHaveBeenCalled()
  })

  it('fails closed when the injected adapter contract is incomplete', () => {
    render(<_Withdraw {...baseProps} withdrawAdapters={{ reserveUnwind: vi.fn() }} />)

    const button = screen.getByRole('button', { name: 'Unavailable' })
    expect(button.disabled).toBe(true)
    expect(reserveUnwind).not.toHaveBeenCalled()
    expect(signAndSubmitUnwind).not.toHaveBeenCalled()
    expect(postUnwindAttach).not.toHaveBeenCalled()
    expect(pollUnwindStatus).not.toHaveBeenCalled()
  })
})

describe('Withdraw (Base full exit) — Task 6 evidence and handoff contract', () => {
  it('keeps the exact custody disclosure adjacent before any request starts', () => {
    const { container } = render(<_Withdraw {...baseProps} />)
    expect(screen.getByText('Base Sepolia proxy. Custody only. No protocol yield.')).toBeTruthy()
    expect(screen.getByText(/Destination: Stellar testnet/i)).toBeTruthy()
    expect(container.textContent).toMatch(/One passkey signature starts the unwind request/i)
    expect(container.textContent).not.toMatch(/money moved/i)
  })

  it('fails closed when a Base position supplies malformed precision metadata', () => {
    render(
      <_Withdraw
        {...baseProps}
        positions={[{ ...baseProps.positions[0], decimals: 7 }]}
        idleUsdc={0n}
      />
    )
    expect(screen.getByTestId('base-withdraw-total').textContent).toBe('Unavailable')
    expect(screen.getByRole('button', { name: 'Unavailable' }).disabled).toBe(true)
  })

  it('fails closed when a Base position explicitly supplies an undefined token', () => {
    render(
      <_Withdraw
        {...baseProps}
        positions={[{ ...baseProps.positions[0], token: undefined }]}
        idleUsdc={0n}
      />
    )
    expect(screen.getByTestId('base-withdraw-total').textContent).toBe('Unavailable')
    expect(screen.getByRole('button', { name: 'Unavailable' }).disabled).toBe(true)
  })

  it.each([
    ['a missing pool identity', [{ assets: 1_000_000n, decimals: 6 }]],
    [
      'duplicate pool identities',
      [{ ...baseProps.positions[0] }, { ...baseProps.positions[0], assets: 3_000_000n }],
    ],
  ])('fails closed for %s in the Base position set', (_label, positions) => {
    render(<_Withdraw {...baseProps} positions={positions} idleUsdc={0n} />)
    expect(screen.getByTestId('base-withdraw-total').textContent).toBe('Unavailable')
    expect(screen.getByRole('button', { name: 'Unavailable' }).disabled).toBe(true)
  })

  it('keeps a done projection in reconciliation when receipt evidence is incomplete', async () => {
    pollUnwindStatus.mockResolvedValue({
      jobId: JOB_ID,
      status: 'done',
      unwindTxHash: UNWIND_TX_HASH,
      // Missing mintTxHash means the bridge receipt is not yet reconciled.
    })
    render(<_Withdraw {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() => expect(screen.getByTestId('base-withdraw-reconcile')).toBeTruthy())
    expect(baseProps.onDone).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })

  it('uses settled copy only after receipt and mint reconciliation prove completion', async () => {
    render(<_Withdraw {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() =>
      expect(screen.getByText(/receipt and reconciliation confirm/i)).toBeTruthy()
    )
    expect(screen.getByText(/arrived in your stellar wallet/i)).toBeTruthy()
    expect(screen.queryByText(/in flight to stellar/i)).toBeNull()
    const route = screen.getByLabelText('Network route facts')
    expect(route.textContent).toMatch(/Custody: Stellar testnet/)
    expect(route.textContent).toMatch(/Transit: arrived/)
    expect(screen.getByText('Status detail: Arrived on Stellar testnet')).toBeTruthy()
  })

  it('keeps an exact high-precision Base total without Number coercion', () => {
    render(
      <_Withdraw
        {...baseProps}
        positions={[{ ...baseProps.positions[0], assets: '9007199254740993', decimals: 6 }]}
        idleUsdc={0n}
      />
    )
    expect(screen.getByTestId('base-withdraw-total').textContent).toContain('9007199254.740993')
  })

  it('does not commit an old attempt after the connected kernel account changes', async () => {
    let resolveSign
    signAndSubmitUnwind.mockImplementation(async ({ onSubmitted }) => {
      await onSubmitted(USER_OP_HASH)
      return new Promise((resolve) => {
        resolveSign = resolve
      })
    })
    const { rerender } = render(<_Withdraw {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() => expect(signAndSubmitUnwind).toHaveBeenCalled())

    rerender(
      <_Withdraw
        {...baseProps}
        ownerKernelAccount={{ address: '0x0000000000000000000000000000000000000bb2' }}
      />
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Withdraw all' })).toBeTruthy())

    resolveSign?.({
      userOpHash: USER_OP_HASH,
      unwindTxHash: UNWIND_TX_HASH,
      burned: 5_500_000n,
      exited: 2,
      skipped: 0,
      evidenceStatus: 'verified',
    })
    await Promise.resolve()
    expect(baseProps.onDone).not.toHaveBeenCalled()
    expect(postUnwindAttach).not.toHaveBeenCalled()
  })

  it('keeps the lazy handoff visibly submitting and action-locked while reserving', async () => {
    let resolveReservation
    reserveUnwind.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReservation = resolve
        })
    )
    render(<_Withdraw {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw all' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /preparing/i })).toBeTruthy())
    expect(screen.getByRole('button', { name: /preparing/i }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Cancel' }).disabled).toBe(true)
    resolveReservation?.({ jobId: JOB_ID, status: 'awaiting_burn' })
  })

  it('keeps the lazy Base overlay on route-owned Pocket Crew classes with no legacy or inline styling', () => {
    const source = fs.readFileSync(path.resolve(here, './Withdraw.jsx'), 'utf8')
    const css = fs.readFileSync(path.resolve(here, '../components/money/my-money.css'), 'utf8')
    const activeCss = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(source).not.toMatch(/\b(?:wd-|modal-|grant-receipt|think-spin)/)
    expect(source).not.toMatch(/\bstyle\s*=/)
    expect(css).toMatch(/\.pc-base-withdraw-hero\s*\{/)
    expect(css).toMatch(/\.pc-base-withdraw-loading-fill\[data-progress=/)
    expect(css).toMatch(/\.pc-base-withdraw-stage\s*\{/)
    expect(activeCss).not.toMatch(/\.wd-|\.modal-|\.grant-receipt|\.think-spin/)
  })
})
