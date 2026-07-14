// agentSetup.test.js
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { scValToNative } from '@stellar/stellar-sdk'
vi.mock('./client.js', () => ({
  buildInvokeTx: vi.fn().mockResolvedValue({ tx: {}, xdr: 'UNSIGNED' }),
  buildCreateContractTx: vi
    .fn()
    .mockResolvedValue({ tx: {}, xdr: 'DEPLOY_UNSIGNED', contractAddress: 'CNEWAGENT' }),
  submitUserTx: vi.fn().mockResolvedValue({ hash: 'h1', status: 'SUCCESS' }),
}))
vi.mock('./walletKit.js', () => ({ signTxXdr: vi.fn().mockResolvedValue('SIGNED') }))
import { fundAgent, registryAuthorizeAgent, deployAgentForSession } from './agentSetup.js'
import { buildInvokeTx, buildCreateContractTx, submitUserTx } from './client.js'
import { signTxXdr } from './walletKit.js'
import {
  SOROBAN_AGENT_WASM_HASH,
  SOROBAN_ACTIVE_VAULT_ADDRESS,
  SOROBAN_REGISTRY_ADDRESS,
  SOROBAN_TOKEN_ADDRESS,
} from './config.js'

beforeEach(() => {
  vi.clearAllMocks()
  // Full reset: the timeout test swaps in a never-resolving signTxXdr implementation — without
  // mockReset it would leak into every later test (clearAllMocks keeps implementations).
  signTxXdr.mockReset()
  signTxXdr.mockResolvedValue('SIGNED')
  submitUserTx.mockReset()
  submitUserTx.mockResolvedValue({ hash: 'h1', status: 'SUCCESS' })
})

describe('fundAgent', () => {
  test('signs the token.transfer(owner → agent) with the user wallet and submits it', async () => {
    const r = await fundAgent({ owner: 'GUSER', agentAddress: 'CAGENT', amount: 50_000_000n })
    expect(buildInvokeTx).toHaveBeenCalledTimes(1)
    expect(buildInvokeTx.mock.calls[0][0]).toMatchObject({
      source: 'GUSER',
      contract: SOROBAN_TOKEN_ADDRESS,
      method: 'transfer',
    })
    expect(signTxXdr).toHaveBeenCalledWith('UNSIGNED')
    expect(submitUserTx).toHaveBeenCalledWith(expect.objectContaining({ signedXdr: 'SIGNED' }))
    expect(r.status).toBe('SUCCESS')
  })

  test('throws when the funding tx does not confirm (silent PENDING would doom the deposit)', async () => {
    submitUserTx.mockResolvedValueOnce({ hash: 'h2', status: 'PENDING' })
    await expect(fundAgent({ owner: 'GUSER', agentAddress: 'CAGENT', amount: 1n })).rejects.toThrow(
      /funding was not confirmed: PENDING/
    )
  })

  test('rejects after 120s when the wallet signature never resolves (no infinite hang)', async () => {
    vi.useFakeTimers()
    try {
      signTxXdr.mockImplementation(() => new Promise(() => {})) // signature dismissed / wallet stuck
      const p = fundAgent({ owner: 'GUSER', agentAddress: 'CAGENT', amount: 1n })
      const assertion = expect(p).rejects.toThrow(/timed out after 120 seconds/)
      await vi.advanceTimersByTimeAsync(120_001)
      await assertion
      expect(submitUserTx).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('registryAuthorizeAgent (optional record-keeping - off the critical path)', () => {
  test('signs Registry.authorize with the user wallet and status-checks the submit', async () => {
    const r = await registryAuthorizeAgent({
      owner: 'GUSER',
      agentAddress: 'CAGENT',
    })
    expect(buildInvokeTx).toHaveBeenCalledTimes(1)
    expect(buildInvokeTx.mock.calls[0][0]).toMatchObject({
      source: 'GUSER',
      contract: SOROBAN_REGISTRY_ADDRESS,
      method: 'authorize',
      // Hardened registry derives every record field from agent.scope_of() —
      // the caller supplies ONLY the agent address, nothing forgeable.
      args: [{ addr: 'CAGENT' }],
    })
    expect(r.status).toBe('SUCCESS')
  })

  test('throws when the authorize tx does not confirm', async () => {
    submitUserTx.mockResolvedValueOnce({ hash: 'h3', status: 'FAILED' })
    await expect(
      registryAuthorizeAgent({
        owner: 'GUSER',
        agentAddress: 'CAGENT',
      })
    ).rejects.toThrow(/authorization was not confirmed: FAILED/)
  })
})

describe('deployAgentForSession (Option B: fresh agent per run)', () => {
  // Real strkeys — the scope/constructor args are REALLY encoded (only the tx build is faked).
  const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
  const rawPublicKey = new Uint8Array(32).fill(7)
  const sessionKey = { rawPublicKey, publicKey: 'GSESSION' }

  test('builds the __constructor args: owner, session pubkey, AgentScope struct, router=None', async () => {
    await deployAgentForSession({
      owner: OWNER,
      sessionKey,
      cap: 50_0000000n,
      periodDuration: 86400,
      expiry: 4000000000,
    })
    expect(buildCreateContractTx).toHaveBeenCalledTimes(1)
    const call = buildCreateContractTx.mock.calls[0][0]
    // Deploy source = the connected user wallet; wasm = the already-uploaded agent_account hash.
    expect(call.source).toBe(OWNER)
    expect(call.wasmHash).toBe(SOROBAN_AGENT_WASM_HASH)
    expect(call.constructorArgs).toHaveLength(4)
    const [ownerArg, signerArg, scopeArg, routerArg] = call.constructorArgs
    expect(ownerArg).toEqual({ addr: OWNER })
    // The EXACT run session pubkey is pinned as the account signer — the whole point of Option B.
    expect(signerArg.bytes32).toBe(rawPublicKey)
    // Direct (non-router) deploy passes Option::None for the 4th ctor arg — a bare ScVal Void.
    expect(routerArg.switch().name).toBe('scvVoid')
    const scope = scValToNative(scopeArg)
    expect(scope).toEqual({
      owner: OWNER,
      vault: SOROBAN_ACTIVE_VAULT_ADDRESS,
      token: SOROBAN_TOKEN_ADDRESS,
      cap_per_period: 50_0000000n,
      period_duration: 86400n,
      spent_in_period: 0n,
      period_start: 0n,
      expiry: 4000000000n,
      revoked: false,
    })
  })

  test('signs the deploy with the user wallet, submits it, and returns the fresh agent address', async () => {
    const addr = await deployAgentForSession({
      owner: OWNER,
      sessionKey,
      cap: 10_0000000n,
      expiry: 4000000000,
    })
    expect(signTxXdr).toHaveBeenCalledWith('DEPLOY_UNSIGNED')
    expect(submitUserTx).toHaveBeenCalledWith(expect.objectContaining({ signedXdr: 'SIGNED' }))
    expect(addr).toBe('CNEWAGENT')
  })

  test('throws when the deploy tx does not confirm (never hands back a dead address)', async () => {
    submitUserTx.mockResolvedValueOnce({ hash: 'h2', status: 'PENDING' })
    await expect(
      deployAgentForSession({ owner: OWNER, sessionKey, cap: 1n, expiry: 4000000000 })
    ).rejects.toThrow(/deployment was not confirmed: PENDING/)
  })
})
