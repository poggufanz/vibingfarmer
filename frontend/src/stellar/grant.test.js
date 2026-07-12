// frontend/src/stellar/grant.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Account, Address, xdr, nativeToScVal } from '@stellar/stellar-sdk'

// Relay is the only network dependency submitGrant/runAgentPull reach for; mock it so the tests
// run offline. Each test reconfigures the two fns it needs.
const submitViaRelayMock = vi.fn()
const getRelayerAddressMock = vi.fn()
vi.mock('./relay.js', () => ({
  submitViaRelay: (...a) => submitViaRelayMock(...a),
  getRelayerAddress: (...a) => getRelayerAddressMock(...a),
}))

import { agentInitScVal, buildGrantTx, submitGrant, readAllowance, runAgentPull } from './grant.js'

// Real testnet-shaped addresses (valid strkeys — the SDK validates them on encode).
const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const AGENT_1 = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const AGENT_2 = 'CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY'
const VAULT = 'CB5VKYDUIYX3RZWGVLKKNBPG7V7Z5JIHF2QPNQKWKAHVA3IPSLFZJDYU'

// Vec<Address> retval the router's grant returns — the deployed agent addresses in input order.
function agentsRetval(addrs) {
  return xdr.ScVal.scvVec(addrs.map((a) => Address.fromString(a).toScVal()))
}

// A fake Soroban RPC server: no network. Simulate returns the agents Vec; prepare echoes the raw
// tx; sendTransaction/getTransaction back the direct-submit fallback.
function fakeServer({ latest = 1000, retval } = {}) {
  return {
    getLatestLedger: async () => ({ sequence: latest }),
    getAccount: async (addr) => new Account(addr, '5'),
    simulateTransaction: async () => ({ result: { retval } }),
    prepareTransaction: async (tx) => tx,
    sendTransaction: async () => ({ hash: 'HDIRECT', status: 'PENDING' }),
    getTransaction: async () => ({ status: 'SUCCESS' }),
  }
}

const sampleInits = [
  {
    signer: new Uint8Array(32).fill(1),
    cap: 40_000_000n,
    vault: VAULT,
    periodDuration: 86400,
    expiry: 111,
  },
  {
    signer: new Uint8Array(32).fill(2),
    cap: 60_000_000n,
    vault: VAULT,
    periodDuration: 86400,
    expiry: 111,
  },
]

beforeEach(() => {
  submitViaRelayMock.mockReset()
  getRelayerAddressMock.mockReset()
})

describe('agentInitScVal - encoding matches funding_router types.rs', () => {
  it('emits the ScMap keys in lexicographic field order: cap, expiry, period_duration, salt, signer, vault', () => {
    const sv = agentInitScVal({
      signer: new Uint8Array(32).fill(7),
      salt: new Uint8Array(32).fill(8),
      cap: 5n,
      vault: VAULT,
      periodDuration: 3600,
      expiry: 222,
    })
    expect(sv.switch().name).toBe('scvMap')
    const keys = sv.map().map((e) => e.key().sym().toString())
    // MUST match the Rust #[contracttype] AgentInit fields sorted lexicographically — the host
    // rejects any other key order.
    expect(keys).toEqual(['cap', 'expiry', 'period_duration', 'salt', 'signer', 'vault'])
  })

  it('encodes each field with the right ScVal type (cap=i128, period/expiry=u64, salt/signer=bytes, vault=address)', () => {
    const sv = agentInitScVal({
      signer: new Uint8Array(32).fill(3),
      salt: new Uint8Array(32).fill(4),
      cap: 9n,
      vault: VAULT,
      periodDuration: 3600,
      expiry: 222,
    })
    const byKey = Object.fromEntries(sv.map().map((e) => [e.key().sym().toString(), e.val()]))
    expect(byKey.cap.switch().name).toBe('scvI128')
    expect(byKey.expiry.switch().name).toBe('scvU64')
    expect(byKey.period_duration.switch().name).toBe('scvU64')
    expect(byKey.salt.switch().name).toBe('scvBytes')
    expect(byKey.salt.bytes().length).toBe(32)
    expect(byKey.signer.switch().name).toBe('scvBytes')
    expect(byKey.vault.switch().name).toBe('scvAddress')
  })
})

describe('buildGrantTx', () => {
  it('converts duration→expiry_ledger at ~5s/ledger (latest + ceil(duration/5))', async () => {
    const server = fakeServer({ latest: 1000, retval: agentsRetval([AGENT_1, AGENT_2]) })
    const { expiryLedger } = await buildGrantTx({
      owner: OWNER,
      budgetBaseUnits: 100_000_000n,
      durationSeconds: 3600, // 3600/5 = 720
      agentInits: sampleInits,
      server,
    })
    expect(expiryLedger).toBe(1000 + 720)
  })

  it('rounds the ledger delta UP (ceil), never truncating below the requested duration', async () => {
    const server = fakeServer({ latest: 0, retval: agentsRetval([AGENT_1]) })
    const { expiryLedger } = await buildGrantTx({
      owner: OWNER,
      budgetBaseUnits: 1n,
      durationSeconds: 11, // 11/5 = 2.2 → 3
      agentInits: [sampleInits[0]],
      server,
    })
    expect(expiryLedger).toBe(3)
  })

  it('parses the simulated retval into the deployed agent addresses (input order)', async () => {
    const server = fakeServer({ latest: 500, retval: agentsRetval([AGENT_1, AGENT_2]) })
    const { agentAddresses } = await buildGrantTx({
      owner: OWNER,
      budgetBaseUnits: 100_000_000n,
      durationSeconds: 60,
      agentInits: sampleInits,
      server,
    })
    expect(agentAddresses).toEqual([AGENT_1, AGENT_2])
  })

  it('builds a single owner-sourced grant op with NO separate auth entries (single-signature: source-account credentials cover the whole tree)', async () => {
    const server = fakeServer({ latest: 100, retval: agentsRetval([AGENT_1]) })
    const { tx } = await buildGrantTx({
      owner: OWNER,
      budgetBaseUnits: 40_000_000n,
      durationSeconds: 60,
      agentInits: [sampleInits[0]],
      server,
    })
    expect(tx.source).toBe(OWNER) // tx source IS the owner → require_auth met by the envelope sig
    expect(tx.operations).toHaveLength(1)
    // No SorobanAuthorizationEntry to sign separately — the single wallet signature signs the envelope.
    expect((tx.operations[0].auth || []).length).toBe(0)
  })

  it('rejects an empty agent list and a missing router', async () => {
    const server = fakeServer({ latest: 1, retval: agentsRetval([]) })
    await expect(
      buildGrantTx({
        owner: OWNER,
        budgetBaseUnits: 1n,
        durationSeconds: 60,
        agentInits: [],
        server,
      })
    ).rejects.toThrow(/at least one agent/)
    await expect(
      buildGrantTx({
        owner: OWNER,
        budgetBaseUnits: 1n,
        durationSeconds: 60,
        agentInits: sampleInits,
        router: '',
        server,
      })
    ).rejects.toThrow(/funding router is not configured/)
  })
})

describe('submitGrant - a single signature', () => {
  it('signs exactly ONCE (the envelope) and returns the relayed result + parsed agents', async () => {
    const server = fakeServer({ latest: 1000, retval: agentsRetval([AGENT_1, AGENT_2]) })
    submitViaRelayMock.mockResolvedValue({ hash: 'HREL', status: 'SUCCESS', relayer: 'GR' })
    const sign = vi.fn(async (x) => `SIGNED:${x}`)

    const out = await submitGrant({
      owner: OWNER,
      budgetBaseUnits: 100_000_000n,
      durationSeconds: 3600,
      agentInits: sampleInits,
      server,
      sign,
    })

    expect(sign).toHaveBeenCalledTimes(1) // a single signature for N=2 agents
    expect(submitViaRelayMock).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({
      hash: 'HREL',
      status: 'SUCCESS',
      agentAddresses: [AGENT_1, AGENT_2],
    })
  })

  it('falls back to a direct user-paid submit when the relay is off (returns null)', async () => {
    const server = fakeServer({ latest: 1000, retval: agentsRetval([AGENT_1]) })
    submitViaRelayMock.mockResolvedValue(null) // relay unconfigured
    const sign = vi.fn(async (x) => `SIGNED:${x}`)

    const out = await submitGrant({
      owner: OWNER,
      budgetBaseUnits: 40_000_000n,
      durationSeconds: 60,
      agentInits: [sampleInits[0]],
      server,
      sign,
    })

    expect(sign).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ hash: 'HDIRECT', status: 'SUCCESS', agentAddresses: [AGENT_1] })
  })

  it('throws when the relay reports a non-SUCCESS status', async () => {
    const server = fakeServer({ latest: 1, retval: agentsRetval([AGENT_1]) })
    submitViaRelayMock.mockResolvedValue({ hash: 'H', status: 'FAILED' })
    await expect(
      submitGrant({
        owner: OWNER,
        budgetBaseUnits: 1n,
        durationSeconds: 60,
        agentInits: [sampleInits[0]],
        server,
        sign: async (x) => x,
      })
    ).rejects.toThrow(/grant relay returned FAILED/)
  })
})

describe('readAllowance', () => {
  it('decodes the SEP-41 allowance i128 into { amount, liveUntilLedger:null }', async () => {
    const server = {
      simulateTransaction: async () => ({
        result: { retval: nativeToScVal(70_000_000n, { type: 'i128' }) },
      }),
    }
    const out = await readAllowance({ owner: OWNER, server })
    expect(out).toEqual({ amount: 70_000_000n, liveUntilLedger: null })
  })

  it('returns 0 on a read failure (safe side - orchestrator then does a fresh grant)', async () => {
    const server = {
      simulateTransaction: async () => {
        throw new Error('rpc down')
      },
    }
    const out = await readAllowance({ owner: OWNER, server })
    expect(out).toEqual({ amount: 0n, liveUntilLedger: null })
  })
})

describe('runAgentPull', () => {
  it('returns null when the relay is unconfigured (no relayer address)', async () => {
    getRelayerAddressMock.mockResolvedValue(null)
    const res = await runAgentPull({
      agentAddress: AGENT_1,
      amount: 10_000_000n,
      sessionKey: { rawPublicKey: new Uint8Array(32), sign: () => new Uint8Array(64) },
    })
    expect(res).toBeNull()
    expect(submitViaRelayMock).not.toHaveBeenCalled()
  })
})
