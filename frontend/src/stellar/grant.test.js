// frontend/src/stellar/grant.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Account, Address, Keypair, xdr, nativeToScVal } from '@stellar/stellar-sdk'

// Relay is the only network dependency submitGrant/runAgentPull reach for; mock it so the tests
// run offline. Each test reconfigures the two fns it needs.
const submitViaRelayMock = vi.fn()
const getRelayerAddressMock = vi.fn()
vi.mock('./relay.js', () => ({
  submitViaRelay: (...a) => submitViaRelayMock(...a),
  getRelayerAddress: (...a) => getRelayerAddressMock(...a),
}))

// signOwnerAuthEntry does a real passkey-ceremony + re-simulate round trip (covered on its own in
// ownerAuthorization.test.js) — grant.test.js's fakeServer never populates real auth entries, so
// only the C-routing (which contractId, which channel) is this file's concern; resolveOwnerTxModel
// and submitOwnerAuthorizedTx stay REAL so the G-path tests below still exercise the real adapter.
const signOwnerAuthEntryMock = vi.fn()
vi.mock('./ownerAuthorization.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, signOwnerAuthEntry: (...a) => signOwnerAuthEntryMock(...a) }
})

import {
  agentInitScVal,
  tokenBudgetScVal,
  buildGrantTx,
  submitGrant,
  readAllowance,
  readAllowanceStrict,
  AllowanceReadError,
  readConfirmedLedger,
  runAgentPull,
  revokeGrant,
  AGENT_KIND_DEPOSIT,
  AGENT_KIND_BRIDGE,
} from './grant.js'

// Real testnet-shaped addresses (valid strkeys — the SDK validates them on encode).
const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const AGENT_1 = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const AGENT_2 = 'CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY'
const VAULT = 'CB5VKYDUIYX3RZWGVLKKNBPG7V7Z5JIHF2QPNQKWKAHVA3IPSLFZJDYU'
const TOKEN = 'CAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQTD2L'
const OWNER_C = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const RELAYER_G = Keypair.random().publicKey() // any well-formed G — never asserted by value
const ZERO32 = new Uint8Array(32)

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
    token: TOKEN,
    target: VAULT,
    kind: AGENT_KIND_DEPOSIT,
    mintRecipient: ZERO32,
    destinationDomain: 0,
    periodDuration: 86400,
    expiry: 111,
  },
  {
    signer: new Uint8Array(32).fill(2),
    cap: 60_000_000n,
    token: TOKEN,
    target: VAULT,
    kind: AGENT_KIND_DEPOSIT,
    mintRecipient: ZERO32,
    destinationDomain: 0,
    periodDuration: 86400,
    expiry: 111,
  },
]

const sampleBudgets = [{ budget: 100_000_000n, token: TOKEN }]

beforeEach(() => {
  submitViaRelayMock.mockReset()
  getRelayerAddressMock.mockReset()
  signOwnerAuthEntryMock.mockReset()
})

describe('AGENT_KIND_* constants', () => {
  it('exports the Deposit/Bridge discriminants matching AgentInit.kind on the Rust side', () => {
    expect(AGENT_KIND_DEPOSIT).toBe(0)
    expect(AGENT_KIND_BRIDGE).toBe(1)
  })
})

describe('agentInitScVal - encoding matches funding_router types.rs (v2 AgentInit)', () => {
  it('emits the ScMap keys in lexicographic field order: cap, destination_domain, expiry, kind, mint_recipient, period_duration, salt, signer, target, token', () => {
    const sv = agentInitScVal({
      signer: new Uint8Array(32).fill(7),
      salt: new Uint8Array(32).fill(8),
      cap: 5n,
      token: TOKEN,
      target: VAULT,
      kind: AGENT_KIND_DEPOSIT,
      mintRecipient: ZERO32,
      destinationDomain: 0,
      periodDuration: 3600,
      expiry: 222,
    })
    expect(sv.switch().name).toBe('scvMap')
    const keys = sv.map().map((e) => e.key().sym().toString())
    // MUST match the Rust #[contracttype] AgentInit fields sorted lexicographically — the host
    // rejects any other key order.
    expect(keys).toEqual([
      'cap',
      'destination_domain',
      'expiry',
      'kind',
      'mint_recipient',
      'period_duration',
      'salt',
      'signer',
      'target',
      'token',
    ])
  })

  it('encodes each field with the right ScVal type (cap=i128, kind/destination_domain=u32, mint_recipient=bytes32, period_duration/expiry=u64, salt/signer=bytes, target/token=address)', () => {
    const sv = agentInitScVal({
      signer: new Uint8Array(32).fill(3),
      salt: new Uint8Array(32).fill(4),
      cap: 9n,
      token: TOKEN,
      target: VAULT,
      kind: AGENT_KIND_BRIDGE,
      mintRecipient: new Uint8Array(32).fill(6),
      destinationDomain: 6,
      periodDuration: 3600,
      expiry: 222,
    })
    const byKey = Object.fromEntries(sv.map().map((e) => [e.key().sym().toString(), e.val()]))
    expect(byKey.cap.switch().name).toBe('scvI128')
    expect(byKey.destination_domain.switch().name).toBe('scvU32')
    expect(byKey.expiry.switch().name).toBe('scvU64')
    expect(byKey.kind.switch().name).toBe('scvU32')
    expect(byKey.mint_recipient.switch().name).toBe('scvBytes')
    expect(byKey.mint_recipient.bytes().length).toBe(32)
    expect(byKey.period_duration.switch().name).toBe('scvU64')
    expect(byKey.salt.switch().name).toBe('scvBytes')
    expect(byKey.salt.bytes().length).toBe(32)
    expect(byKey.signer.switch().name).toBe('scvBytes')
    expect(byKey.target.switch().name).toBe('scvAddress')
    expect(byKey.token.switch().name).toBe('scvAddress')
  })
})

describe('tokenBudgetScVal - encoding matches funding_router types.rs (TokenBudget)', () => {
  it('emits the ScMap keys in lexicographic field order: budget, token', () => {
    const sv = tokenBudgetScVal({ budget: 100_000_000n, token: TOKEN })
    expect(sv.switch().name).toBe('scvMap')
    const keys = sv.map().map((e) => e.key().sym().toString())
    expect(keys).toEqual(['budget', 'token'])
  })

  it('encodes each field with the right ScVal type (budget=i128, token=address)', () => {
    const sv = tokenBudgetScVal({ budget: 5n, token: TOKEN })
    const byKey = Object.fromEntries(sv.map().map((e) => [e.key().sym().toString(), e.val()]))
    expect(byKey.budget.switch().name).toBe('scvI128')
    expect(byKey.token.switch().name).toBe('scvAddress')
  })
})

describe('buildGrantTx', () => {
  it('converts duration→expiry_ledger at ~5s/ledger (latest + ceil(duration/5))', async () => {
    const server = fakeServer({ latest: 1000, retval: agentsRetval([AGENT_1, AGENT_2]) })
    const { expiryLedger } = await buildGrantTx({
      owner: OWNER,
      budgets: sampleBudgets,
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
      budgets: sampleBudgets,
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
      budgets: sampleBudgets,
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
      budgets: sampleBudgets,
      durationSeconds: 60,
      agentInits: [sampleInits[0]],
      server,
    })
    expect(tx.source).toBe(OWNER) // tx source IS the owner → require_auth met by the envelope sig
    expect(tx.operations).toHaveLength(1)
    // No SorobanAuthorizationEntry to sign separately — the single wallet signature signs the envelope.
    expect((tx.operations[0].auth || []).length).toBe(0)
  })

  it('names bridgeAgentAddress when the LAST submitted agent is a Bridge-kind init', async () => {
    const server = fakeServer({ latest: 1000, retval: agentsRetval([AGENT_1, AGENT_2]) })
    const bridgeInit = {
      ...sampleInits[0],
      kind: AGENT_KIND_BRIDGE,
      mintRecipient: new Uint8Array(32).fill(5),
      destinationDomain: 6,
    }
    const { agentAddresses, bridgeAgentAddress } = await buildGrantTx({
      owner: OWNER,
      budgets: sampleBudgets,
      durationSeconds: 60,
      agentInits: [sampleInits[0], bridgeInit],
      server,
    })
    expect(agentAddresses).toEqual([AGENT_1, AGENT_2])
    expect(bridgeAgentAddress).toBe(AGENT_2) // last deployed agent
  })

  it('bridgeAgentAddress is null when no submitted agent is Bridge-kind (additive: existing callers unaffected)', async () => {
    const server = fakeServer({ latest: 1000, retval: agentsRetval([AGENT_1, AGENT_2]) })
    const { bridgeAgentAddress } = await buildGrantTx({
      owner: OWNER,
      budgets: sampleBudgets,
      durationSeconds: 60,
      agentInits: sampleInits, // both AGENT_KIND_DEPOSIT
      server,
    })
    expect(bridgeAgentAddress).toBeNull()
  })

  it('sources the tx from txSource (relayer G) when given, leaving the grant() owner arg unchanged', async () => {
    const server = fakeServer({ latest: 100, retval: agentsRetval([AGENT_1]) })
    const { tx } = await buildGrantTx({
      owner: OWNER_C, // the C address stays the `grant` call's owner argument
      budgets: sampleBudgets,
      durationSeconds: 60,
      agentInits: [sampleInits[0]],
      server,
      txSource: RELAYER_G, // but a C address can never be the tx source
    })
    expect(tx.source).toBe(RELAYER_G)
    expect(tx.source).not.toBe(OWNER_C)
  })

  it('rejects an empty agent list and a missing router', async () => {
    const server = fakeServer({ latest: 1, retval: agentsRetval([]) })
    await expect(
      buildGrantTx({
        owner: OWNER,
        budgets: sampleBudgets,
        durationSeconds: 60,
        agentInits: [],
        server,
      })
    ).rejects.toThrow(/at least one agent/)
    await expect(
      buildGrantTx({
        owner: OWNER,
        budgets: sampleBudgets,
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
      budgets: sampleBudgets,
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
      budgets: sampleBudgets,
      durationSeconds: 60,
      agentInits: [sampleInits[0]],
      server,
      sign,
    })

    expect(sign).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ hash: 'HDIRECT', status: 'SUCCESS', agentAddresses: [AGENT_1] })
  })

  it('propagates bridgeAgentAddress through the relayed result', async () => {
    const server = fakeServer({ latest: 1000, retval: agentsRetval([AGENT_1, AGENT_2]) })
    submitViaRelayMock.mockResolvedValue({ hash: 'HREL', status: 'SUCCESS', relayer: 'GR' })
    const bridgeInit = { ...sampleInits[0], kind: AGENT_KIND_BRIDGE }
    const out = await submitGrant({
      owner: OWNER,
      budgets: sampleBudgets,
      durationSeconds: 3600,
      agentInits: [sampleInits[0], bridgeInit],
      server,
      sign: async (x) => x,
    })
    expect(out.bridgeAgentAddress).toBe(AGENT_2)
  })

  it('throws when the relay reports a non-SUCCESS status', async () => {
    const server = fakeServer({ latest: 1, retval: agentsRetval([AGENT_1]) })
    submitViaRelayMock.mockResolvedValue({ hash: 'H', status: 'FAILED' })
    await expect(
      submitGrant({
        owner: OWNER,
        budgets: sampleBudgets,
        durationSeconds: 60,
        agentInits: [sampleInits[0]],
        server,
        sign: async (x) => x,
      })
    ).rejects.toThrow(/grant relay returned FAILED/)
  })
})

describe('submitGrant - C owner (passkey), routed through OwnerAuthorizationV1', () => {
  it('sources the grant from the relayer, signs via the passkey ceremony, and submits relay-only', async () => {
    const server = fakeServer({ latest: 1000, retval: agentsRetval([AGENT_1]) })
    getRelayerAddressMock.mockResolvedValue(RELAYER_G)
    signOwnerAuthEntryMock.mockResolvedValue('SIGNED_C_XDR')
    submitViaRelayMock.mockResolvedValue({ hash: 'HC', status: 'SUCCESS' })

    const out = await submitGrant({
      owner: OWNER_C,
      budgets: sampleBudgets,
      durationSeconds: 60,
      agentInits: [sampleInits[0]],
      server,
      activeAccount: { kind: 'C', address: OWNER_C },
    })

    expect(signOwnerAuthEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: OWNER_C })
    )
    expect(submitViaRelayMock).toHaveBeenCalledWith({ xdr: 'SIGNED_C_XDR' })
    expect(out).toMatchObject({ hash: 'HC', status: 'SUCCESS', agentAddresses: [AGENT_1] })
  })

  it('has no user-funded fallback: an unreachable relay throws instead of billing the C owner', async () => {
    const server = fakeServer({ latest: 1000, retval: agentsRetval([AGENT_1]) })
    getRelayerAddressMock.mockResolvedValue(RELAYER_G)
    signOwnerAuthEntryMock.mockResolvedValue('SIGNED_C_XDR')
    submitViaRelayMock.mockResolvedValue(null) // relay unreachable AFTER the ceremony already ran

    await expect(
      submitGrant({
        owner: OWNER_C,
        budgets: sampleBudgets,
        durationSeconds: 60,
        agentInits: [sampleInits[0]],
        server,
        activeAccount: { kind: 'C', address: OWNER_C },
      })
    ).rejects.toMatchObject({ code: 'VF_SUBMISSION_UNKNOWN' })
  })

  it('fails BEFORE the passkey ceremony when no relayer is funded', async () => {
    const server = fakeServer({ latest: 1000, retval: agentsRetval([AGENT_1]) })
    getRelayerAddressMock.mockResolvedValue(null)

    await expect(
      submitGrant({
        owner: OWNER_C,
        budgets: sampleBudgets,
        durationSeconds: 60,
        agentInits: [sampleInits[0]],
        server,
        activeAccount: { kind: 'C', address: OWNER_C },
      })
    ).rejects.toMatchObject({ code: 'VF_FEE_PAYER_UNAVAILABLE' })
    expect(signOwnerAuthEntryMock).not.toHaveBeenCalled()
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

describe('readAllowanceStrict - distinguishes RPC failure from a confirmed zero', () => {
  it('decodes the SEP-41 allowance i128 into { amount }', async () => {
    const server = {
      simulateTransaction: async () => ({
        result: { retval: nativeToScVal(70_000_000n, { type: 'i128' }) },
      }),
    }
    expect(await readAllowanceStrict({ owner: OWNER, server })).toEqual({ amount: 70_000_000n })
  })

  it('a CONFIRMED zero allowance decodes to { amount: 0n } - not an error', async () => {
    const server = {
      simulateTransaction: async () => ({
        result: { retval: nativeToScVal(0n, { type: 'i128' }) },
      }),
    }
    expect(await readAllowanceStrict({ owner: OWNER, server })).toEqual({ amount: 0n })
  })

  it('an RPC failure THROWS AllowanceReadError - never masquerades as zero', async () => {
    const server = {
      simulateTransaction: async () => {
        throw new Error('rpc down')
      },
    }
    await expect(readAllowanceStrict({ owner: OWNER, server })).rejects.toThrow(AllowanceReadError)
  })
})

describe('readConfirmedLedger - GrantReceiptV1.confirmedAt source (never Date.now())', () => {
  it('reads confirmedLedger + confirmedAt from the confirmed getTransaction response', async () => {
    const server = {
      getTransaction: async () => ({ status: 'SUCCESS', ledger: 12345, createdAt: 1_700_000_000 }),
    }
    const out = await readConfirmedLedger({ hash: 'HDEADBEEF', server })
    expect(out).toEqual({ confirmedLedger: 12345, confirmedAt: 1_700_000_000 })
  })

  it('throws when the transaction is not confirmed SUCCESS (never fabricates a receipt)', async () => {
    const server = { getTransaction: async () => ({ status: 'PENDING' }) }
    await expect(readConfirmedLedger({ hash: 'H', server })).rejects.toThrow(/not confirmed/i)
  })

  it('throws when the RPC omits ledger/createdAt even on SUCCESS (never falls back to Date.now())', async () => {
    const server = { getTransaction: async () => ({ status: 'SUCCESS' }) }
    await expect(readConfirmedLedger({ hash: 'H', server })).rejects.toThrow()
  })
})

describe('revokeGrant — router allowance kill switch', () => {
  describe('G owner (default, direct)', () => {
    it('signs the envelope once and submits directly; the relay is never consulted', async () => {
      const server = fakeServer({ latest: 1000 })
      const sign = vi.fn(async (x) => `SIGNED:${x}`)
      const out = await revokeGrant({ owner: OWNER, server, sign })
      expect(sign).toHaveBeenCalledTimes(1)
      expect(submitViaRelayMock).not.toHaveBeenCalled()
      expect(out).toEqual({ hash: 'HDIRECT', status: 'SUCCESS' })
    })

    it('throws when the revoke is not confirmed SUCCESS', async () => {
      const server = fakeServer({ latest: 1000 })
      server.getTransaction = async () => ({ status: 'PENDING' })
      await expect(revokeGrant({ owner: OWNER, server, sign: async (x) => x })).rejects.toThrow(
        /not confirmed/i
      )
    })
  })

  describe('C owner (passkey, relay-only)', () => {
    it('sources from the relayer, signs a passkey auth entry, submits relay-only', async () => {
      const server = fakeServer({ latest: 1000 })
      getRelayerAddressMock.mockResolvedValue(RELAYER_G)
      signOwnerAuthEntryMock.mockResolvedValue('SIGNED_C')
      submitViaRelayMock.mockResolvedValue({ hash: 'rc1', status: 'SUCCESS' })

      const out = await revokeGrant({
        owner: OWNER_C,
        server,
        activeAccount: { kind: 'C', address: OWNER_C },
      })

      expect(signOwnerAuthEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({ contractId: OWNER_C })
      )
      expect(out).toEqual({ hash: 'rc1', status: 'SUCCESS' })
    })

    it('has no user-funded fallback: fails BEFORE the passkey ceremony when no relayer is funded', async () => {
      const server = fakeServer({ latest: 1000 })
      getRelayerAddressMock.mockResolvedValue(null)
      await expect(
        revokeGrant({ owner: OWNER_C, server, activeAccount: { kind: 'C', address: OWNER_C } })
      ).rejects.toMatchObject({ code: 'VF_FEE_PAYER_UNAVAILABLE' })
      expect(signOwnerAuthEntryMock).not.toHaveBeenCalled()
    })
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
