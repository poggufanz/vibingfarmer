// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'

const partialWithdraw = vi.fn(async () => ({
  redeemed: 20_000_000n,
  redeemHash: 'H1',
  transferHash: 'H2',
  channel: 'relay',
}))
const ensureExitSigner = vi.fn(async () => ({ publicKey: 'GPUB', secret: 'S' }))
const partialWithdrawMulti = vi.fn(async ({ legs }) => ({
  results: legs.map((leg) => ({
    ...leg,
    ok: true,
    redeemed: leg.amountUnits,
    redeemHash: `HR:${leg.agentAddress}`,
    transferHash: `HT:${leg.agentAddress}`,
    channel: 'relay',
  })),
  queued: [],
}))
vi.mock('../../stellar/partialWithdraw.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    partialWithdraw: (...a) => partialWithdraw(...a),
    ensureExitSigner: (...a) => ensureExitSigner(...a),
    partialWithdrawMulti: (...a) => partialWithdrawMulti(...a),
    readAgentScope: async () => ({
      expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
      revoked: false,
    }),
  }
})
const readVaultShares = vi.fn(async () => 100_000_000n) // 10 USDC per agent
vi.mock('../../stellar/agentDeposit.js', () => ({
  readVaultShares: (...a) => readVaultShares(...a),
}))
vi.mock('../../stellar/vaultReads.js', () => ({ readPricePerShare: async () => 10_000_000n }))
const clearManualExitKey = vi.fn()
vi.mock('../../wallet/exitKey.js', () => ({
  clearManualExitKey: (...a) => clearManualExitKey(...a),
}))
const withdrawAllFromVault = vi.fn()
vi.mock('../../agents/agentController.js', () => ({
  withdrawAllFromVault: (...a) => withdrawAllFromVault(...a),
}))
const saveTransaction = vi.fn()
vi.mock('../../history/history.js', () => ({
  saveTransaction: (...a) => saveTransaction(...a),
}))

import WithdrawModal from '../WithdrawModal.jsx'

afterEach(cleanup)

const vault = { address: 'CVAULT', name: 'VFUSD Yield Vault', protocol: 'blend', apy: 5 }
const props = {
  vault,
  balance: '200000000', // 20 USDC across 2 agents
  userAddress: 'GOWNER',
  agentAddresses: ['CAGENT1', 'CAGENT2'],
  onClose: () => {},
  onSuccess: vi.fn(),
}

describe('WithdrawModal partial mode', () => {
  beforeEach(() => vi.clearAllMocks())

  test('partial tab lists agents with per-agent max and submits the entered amount', async () => {
    render(<WithdrawModal {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: /partial/i }))
    // Agents load with balances
    const agentRow = await screen.findByLabelText(/CAGE.*1/i)
    fireEvent.click(agentRow)
    const input = screen.getByRole('spinbutton')
    fireEvent.change(input, { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: /withdraw 2/i }))
    await waitFor(() => expect(partialWithdraw).toHaveBeenCalled())
    const call = partialWithdraw.mock.calls[0][0]
    expect(call.agentAddress).toBe('CAGENT1')
    expect(call.amountUnits).toBe(20_000_000n)
    expect(call.vault).toBe('CVAULT')
    expect(ensureExitSigner).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'GOWNER', agentAddress: 'CAGENT1' })
    )
    expect(readVaultShares.mock.calls[0][1]).toEqual({ vault: 'CVAULT' })
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledWith('CVAULT', '20000000'))
    expect(saveTransaction).toHaveBeenCalledWith(expect.objectContaining({ channel: 'relay' }))
  })

  test('amount above the selected agent max disables the confirm button', async () => {
    render(<WithdrawModal {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: /partial/i }))
    fireEvent.click(await screen.findByLabelText(/CAGE.*1/i))
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '11' } }) // agent max 10
    // Deviation from brief: .disabled instead of .toBeDisabled() (no jest-dom setup in this repo
    // — see BackupScreen.test.jsx / ApproveOverlay.test.jsx for the same convention).
    expect(screen.getByRole('button', { name: /withdraw/i }).disabled).toBe(true)
  })

  test('full mode stays the default and keeps the whole-position copy', () => {
    render(<WithdrawModal {...props} />)
    expect(screen.getByText(/your whole position/i)).toBeTruthy()
  })

  // Step 3 (My Money Task 12): the old "Estimated time" row was a fabricated formula
  // (Math.max(30, signatures * 20) seconds), not derived from any real timing model. Removed
  // outright rather than replaced with another guess.
  test('never claims an approximate, unmodeled withdrawal time', () => {
    render(<WithdrawModal {...props} />)
    expect(screen.queryByText(/estimated time/i)).toBeNull()
    expect(screen.queryByText(/~\d+\s*seconds/i)).toBeNull()
  })

  // Step 3 (My Money Task 12): the network-fee line used to unconditionally say "Paid by you, in
  // XLM" even for a C (VF Wallet/passkey) owner, whose transactions are always relay-sponsored
  // (stellar/ownerAuthorization.js) -- the owner never pays a fee in that model at all.
  test('a G owner (classic keypair) is truthfully told they pay the network fee', () => {
    render(<WithdrawModal {...props} userAddress="GOWNER" />)
    expect(screen.getByText(/paid by you, in xlm/i)).toBeTruthy()
  })

  test('a C owner (VF Wallet / passkey) sees the real sponsored fee, never "Paid by you"', () => {
    render(<WithdrawModal {...props} userAddress="CCONTRACTOWNER1" />)
    // Mutation guard: a formulation that renders BOTH lines (rather than branching) would still
    // pass a weaker "sponsored text exists" check -- this also asserts the false claim is absent.
    expect(screen.getByText(/sponsored by fee-bump relay/i)).toBeTruthy()
    expect(screen.queryByText(/paid by you, in xlm/i)).toBeNull()
  })

  test('Fix 4 (fix loop 2): an auth failure on a stale v2 key clears it under the same {owner, agent} pair ensureExitSigner registered under', async () => {
    // Regression for WithdrawModal.jsx:241. A stale/lost exit-signer registration fails on-chain
    // auth; the retry must clear the SAME v2 owner-scoped key ensureExitSigner just registered
    // under (wallet/exitKey.js's manualKeyV2(owner, agent)), not the legacy agent-only cache — or
    // the next attempt reloads the same dead key instead of re-registering.
    partialWithdraw.mockRejectedValueOnce(new Error('signature verification failed'))
    render(<WithdrawModal {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: /partial/i }))
    fireEvent.click(await screen.findByLabelText(/CAGE.*1/i))
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: /withdraw 2/i }))
    await waitFor(() => expect(clearManualExitKey).toHaveBeenCalled())
    const registeredWith = ensureExitSigner.mock.calls[0][0]
    expect(clearManualExitKey).toHaveBeenCalledWith({
      owner: registeredWith.owner,
      agent: registeredWith.agentAddress,
    })
  })
})

describe('WithdrawModal full mode sweep failure', () => {
  beforeEach(() => vi.clearAllMocks())

  // Regression for WithdrawModal.jsx:171. My Money Task 9 turned a failed agent's error into a
  // structured {message, code, submission} object so 'confirmed failed' and 'unknown' stay
  // distinct, but this render still interpolated it as a string, showing "[object Object]".
  test('a structured sweep error renders its human-readable message', async () => {
    withdrawAllFromVault.mockResolvedValueOnce([
      { ok: true, txHash: 'H1' },
      {
        ok: false,
        error: {
          message: 'Relay lost the submission.',
          code: 'VF_SUBMISSION_UNKNOWN',
          submission: 'unknown',
        },
      },
    ])
    render(<WithdrawModal {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /^withdraw$/i }))
    await waitFor(() => expect(withdrawAllFromVault).toHaveBeenCalled())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Relay lost the submission.')
    expect(alert.textContent).not.toContain('[object Object]')
  })

  // A legacy plain-string error (still a valid shape) must keep rendering exactly as before.
  test('a plain string sweep error still renders unchanged', async () => {
    withdrawAllFromVault.mockResolvedValueOnce([
      { ok: true, txHash: 'H1' },
      { ok: false, error: 'Insufficient trustline balance.' },
    ])
    render(<WithdrawModal {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /^withdraw$/i }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Insufficient trustline balance.')
  })

  test('records the full-exit channel instead of assuming relay sponsorship', async () => {
    withdrawAllFromVault.mockResolvedValueOnce([
      { ok: true, txHash: 'H1', channel: 'direct' },
      { ok: true, txHash: 'H1', channel: 'direct' },
    ])
    render(<WithdrawModal {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /^withdraw$/i }))
    await waitFor(() => expect(saveTransaction).toHaveBeenCalled())
    expect(saveTransaction).toHaveBeenCalledWith(expect.objectContaining({ channel: 'direct' }))
  })
})

describe('WithdrawModal proportional mode', () => {
  beforeEach(() => vi.clearAllMocks())

  test('plans X% per agent from loaded maxima and submits one multi call', async () => {
    render(<WithdrawModal {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: /proportional/i }))
    // Each mocked agent holds 10 USDC max; default 25% => 2.50 USDC per agent, ~5.00 total.
    expect(await screen.findByText(/2 eligible agents/i)).toBeTruthy()
    expect(screen.getByRole('region', { name: /proportional summary/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /withdraw ~5\.00 usdc/i }))
    await waitFor(() => expect(partialWithdrawMulti).toHaveBeenCalled())
    const call = partialWithdrawMulti.mock.calls[0][0]
    expect(call.vault).toBe('CVAULT')
    expect(call.legs).toEqual([
      { agentAddress: 'CAGENT1', amountUnits: 25_000_000n },
      { agentAddress: 'CAGENT2', amountUnits: 25_000_000n },
    ])
    // Confirmed legs are recorded individually and reported honestly in aggregate.
    await waitFor(() => expect(saveTransaction).toHaveBeenCalledTimes(2))
    expect(props.onSuccess).toHaveBeenCalledWith('CVAULT', '50000000')
    // Two leg badges read Done (the confirm button also reads Done — scoped out here).
    const resultsRegion = screen.getByRole('status', { name: /withdraw results/i })
    expect(within(resultsRegion).getAllByText('Done')).toHaveLength(2)
  })

  test('relay down across all legs: unknown status is shown, queue offered, nothing recorded', async () => {
    partialWithdrawMulti.mockResolvedValueOnce({
      results: ['CAGENT1', 'CAGENT2'].map((agentAddress) => ({
        agentAddress,
        amountUnits: 25_000_000n,
        ok: false,
        error: Object.assign(
          new Error('The gasless relay is unreachable, so nothing was submitted.'),
          { code: 'VF_SUBMISSION_UNKNOWN', submission: 'unknown', stage: 'relay-unreachable' }
        ),
      })),
      get queued() {
        return this.results
      },
    })
    render(<WithdrawModal {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: /proportional/i }))
    fireEvent.click(await screen.findByRole('button', { name: /withdraw ~5\.00 usdc/i }))
    // Unknown (not failed): the status badge, the unknown banner, and an explicit retry.
    expect(await screen.findAllByText('Unknown')).toHaveLength(2)
    const banner = await screen.findByText(/Status: unknown/i)
    expect(banner.textContent).toMatch(/Status: unknown/i)
    expect(screen.getByRole('button', { name: /retry 2 queued/i })).toBeTruthy()
    // Never a false success: no history rows, reconcile-from-chain instead of an amount.
    expect(saveTransaction).not.toHaveBeenCalled()
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledWith('CVAULT', '0'))
  })

  test('a queued retry re-runs only the queued legs and merges the outcome', async () => {
    const unknownLeg = (agentAddress) => ({
      agentAddress,
      amountUnits: 25_000_000n,
      ok: false,
      error: Object.assign(new Error('Lost contact with the relay after submission.'), {
        code: 'VF_SUBMISSION_UNKNOWN',
        submission: 'unknown',
      }),
    })
    partialWithdrawMulti
      .mockResolvedValueOnce({
        results: [
          {
            agentAddress: 'CAGENT1',
            amountUnits: 25_000_000n,
            ok: true,
            redeemed: 25_000_000n,
            redeemHash: 'HR1',
            transferHash: 'HT1',
            channel: 'relay',
          },
          unknownLeg('CAGENT2'),
        ],
        queued: [unknownLeg('CAGENT2')],
      })
      .mockResolvedValueOnce({
        results: [
          {
            agentAddress: 'CAGENT2',
            amountUnits: 25_000_000n,
            ok: true,
            redeemed: 25_000_000n,
            redeemHash: 'HR2',
            transferHash: 'HT2',
            channel: 'relay',
          },
        ],
        queued: [],
      })
    render(<WithdrawModal {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: /proportional/i }))
    fireEvent.click(await screen.findByRole('button', { name: /withdraw ~5\.00 usdc/i }))
    fireEvent.click(await screen.findByRole('button', { name: /retry 1 queued/i }))
    await waitFor(() => expect(partialWithdrawMulti).toHaveBeenCalledTimes(2))
    // Retry carries only the queued leg's original planned amount.
    expect(partialWithdrawMulti.mock.calls[1][0].legs).toEqual([
      { agentAddress: 'CAGENT2', amountUnits: 25_000_000n },
    ])
    await waitFor(() => expect(screen.queryByRole('button', { name: /retry/i })).toBeNull())
    const merged = screen.getByRole('status', { name: /withdraw results/i })
    expect(within(merged).getAllByText('Done')).toHaveLength(2)
  })
})

describe('WithdrawModal single partial relay-down', () => {
  beforeEach(() => vi.clearAllMocks())

  test('an unknown submission surfaces status unknown, never a raw throw or false success', async () => {
    partialWithdraw.mockRejectedValueOnce(
      Object.assign(
        new Error(
          'The gasless relay is unreachable, so nothing was submitted. ' +
            'Your funds stay where they are — queued below for retry when the relay is back. ' +
            'This was recorded as unknown, never as success.'
        ),
        { code: 'VF_SUBMISSION_UNKNOWN', submission: 'unknown', stage: 'relay-unreachable' }
      )
    )
    render(<WithdrawModal {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: /partial/i }))
    fireEvent.click(await screen.findByLabelText(/CAGE.*1/i))
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: /withdraw 2/i }))
    const status = await screen.findByRole('status')
    expect(status.textContent).toMatch(/Status: unknown/i)
    expect(status.textContent).toMatch(/nothing was submitted/i)
    // No success reported, no history row, confirm stays available as the retry.
    expect(props.onSuccess).not.toHaveBeenCalled()
    expect(saveTransaction).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /withdraw 2/i }).disabled).toBe(false)
  })
})
