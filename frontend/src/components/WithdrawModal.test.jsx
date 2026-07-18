// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import React from 'react'

const partialWithdraw = vi.fn(async () => ({
  redeemed: 20_000_000n,
  redeemHash: 'H1',
  transferHash: 'H2',
}))
const ensureExitSigner = vi.fn(async () => ({ publicKey: 'GPUB', secret: 'S' }))
vi.mock('../stellar/partialWithdraw.js', () => ({
  partialWithdraw: (...a) => partialWithdraw(...a),
  ensureExitSigner: (...a) => ensureExitSigner(...a),
  readAgentScope: async () => ({
    expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
    revoked: false,
  }),
}))
vi.mock('../stellar/agentDeposit.js', () => ({
  readVaultShares: async () => 100_000_000n, // 10 USDC per agent
}))
vi.mock('../stellar/vaultReads.js', () => ({ readPricePerShare: async () => 10_000_000n }))

import WithdrawModal from './WithdrawModal.jsx'

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
    expect(ensureExitSigner).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'GOWNER', agentAddress: 'CAGENT1' })
    )
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledWith('CVAULT', '20000000'))
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
})
