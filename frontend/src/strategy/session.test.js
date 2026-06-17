// frontend/src/strategy/session.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock SAK + viem BEFORE importing the module under test.
const sendTxMock = vi.fn(async () => '0xdeadbeef')
vi.mock('@metamask/smart-accounts-kit/actions', () => ({
  erc7710WalletActions: () => (client) => ({ ...client, sendTransactionWithDelegation: sendTxMock }),
}))
const createWalletClientMock = vi.fn((cfg) => ({ ...cfg, extend: (fn) => ({ ...cfg, ...fn({ ...cfg }) }) }))
vi.mock('viem', () => ({
  createWalletClient: (cfg) => createWalletClientMock(cfg),
  http: (url) => ({ __transport: 'http', url }),
}))
vi.mock('viem/chains', () => ({ baseSepolia: { id: 84532, name: 'Base Sepolia' } }))
vi.mock('viem/accounts', () => ({
  privateKeyToAccount: (k) => ({ address: '0xSESSION', __key: k }),
  generatePrivateKey: () => '0xPRIV',
}))

import { initSession, redeemCall, clearSession, getSessionAddress } from './session.js'

describe('session', () => {
  beforeEach(() => {
    sendTxMock.mockClear()
    createWalletClientMock.mockClear()
    clearSession()
    vi.stubGlobal('window', { ethereum: { request: vi.fn() } })
  })

  it('initSession creates a session account with an address', () => {
    initSession({ permissionContext: '0xctx', delegationManager: '0xdm' })
    expect(getSessionAddress()).toBe('0xSESSION')
  })

  it('initSession sets the chain on the wallet client (regression: SAK requires client.chain.id)', () => {
    initSession({ permissionContext: '0xctx', delegationManager: '0xdm' })
    expect(createWalletClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ chain: expect.objectContaining({ id: 84532 }) })
    )
  })

  it('initSession broadcasts via direct RPC, not the injected provider (regression: MetaMask blocks eth_sendRawTransaction from dapps)', () => {
    initSession({ permissionContext: '0xctx', delegationManager: '0xdm' })
    const cfg = createWalletClientMock.mock.calls[0][0]
    expect(cfg.transport.__transport).toBe('http')
  })

  it('redeemCall routes to sendTransactionWithDelegation with context + manager', async () => {
    initSession({ permissionContext: '0xctx', delegationManager: '0xdm' })
    const hash = await redeemCall({ to: '0xVault', data: '0xcalldata' })
    expect(hash).toBe('0xdeadbeef')
    expect(sendTxMock).toHaveBeenCalledWith(expect.objectContaining({
      to: '0xVault', data: '0xcalldata', permissionContext: '0xctx', delegationManager: '0xdm',
    }))
  })

  it('redeemCall throws when no session is active', async () => {
    await expect(redeemCall({ to: '0xVault', data: '0x' })).rejects.toThrow(/no active session/i)
  })

  it('clearSession disables redemption', async () => {
    initSession({ permissionContext: '0xctx', delegationManager: '0xdm' })
    clearSession()
    await expect(redeemCall({ to: '0xVault', data: '0x' })).rejects.toThrow(/no active session/i)
  })
})
