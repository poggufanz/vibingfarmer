import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock wallet.js (avoid loading the SAK/viem session chain) + config (stable addresses).
vi.mock('./wallet.js', () => ({
  broadcastDepositOnChain: vi.fn(async () => '0xONCHAINDEP'),
}))
vi.mock('./config.js', () => ({
  AGENT_VAULT_DEPOSITOR_ADDRESS: '0x' + 'de'.repeat(20),
  AGENT_REGISTRY_ADDRESS: '0x' + 're'.repeat(20),
  SEPOLIA_CHAIN_ID: 84532,
  USDC_SEPOLIA: '0x' + 'dc'.repeat(20),
}))

import {
  encodeExecuteAgentDeposit, computeExecId, buildAuthorizeSessionKeyCall, buildApproveCall,
  relayDeposit,
} from './relay.js'
import { broadcastDepositOnChain } from './wallet.js'

// All-lowercase 20-byte addresses: viem's encodeAbiParameters validates EIP-55 checksum on
// mixed-case input and throws. Lowercase = no checksum check, so fixtures exercise encoding.
const owner = '0x' + 'a1'.repeat(20)
const vault = '0x' + 'b2'.repeat(20)
const token = '0x' + 'c3'.repeat(20)
const agent = '0x' + 'd4'.repeat(20)

describe('relay encode + execId', () => {
  beforeEach(() => { vi.clearAllMocks(); global.fetch = vi.fn(async () => ({ ok: false })) })

  it('encodes executeAgentDeposit(amount,minAmount,minShares,execId,sig)', () => {
    const execId = computeExecId({ owner, vault, planId: 1, step: 0 })
    const sig = '0x' + '11'.repeat(65)
    const data = encodeExecuteAgentDeposit({ amount: 50_000000n, minAmount: 49_000000n, minShares: 0n, execId, sig })
    expect(data.startsWith('0x')).toBe(true)
    expect(execId).toMatch(/^0x[0-9a-f]{64}$/i)
  })

  it('computeExecId is deterministic for the same (owner,vault,planId,step)', () => {
    const a = computeExecId({ owner, vault, planId: 7, step: 2 })
    const b = computeExecId({ owner, vault, planId: 7, step: 2 })
    const c = computeExecId({ owner, vault, planId: 7, step: 3 })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('builds an authorizeSessionKey call to the registry', () => {
    const call = buildAuthorizeSessionKeyCall({ agent, vault, token, capPerPeriod: 100_000000n, periodDuration: 86400, expiry: 1_900_000_000 })
    expect(call.to).toBe('0x' + 're'.repeat(20))
    expect(call.data.startsWith('0x')).toBe(true)
  })

  it('builds a USDC approve call to the depositor', () => {
    const call = buildApproveCall({ amount: 100_000000n })
    expect(call.to).toBe('0x' + 'dc'.repeat(20)) // USDC
    expect(call.data.startsWith('0x')).toBe(true)
  })

  it('relayDeposit falls back to a user-signed on-chain broadcast when the proxy is unconfigured', async () => {
    const execId = computeExecId({ owner, vault, planId: 1, step: 0 })
    const res = await relayDeposit({ amount: 1n, minAmount: 1n, execId, sig: '0x' + '11'.repeat(65) })
    expect(res.txHash).toBe('0xONCHAINDEP')
    expect(res.status).toBe('onchain')
    expect(broadcastDepositOnChain).toHaveBeenCalledOnce()
  })
})
