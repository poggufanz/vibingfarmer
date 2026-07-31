// frontend/src/stellar/grant.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  Account,
  Address,
  Keypair,
  TransactionBuilder,
  xdr,
  nativeToScVal,
} from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE } from './config.js'
import {
  fromScVal,
  structScVal,
  bytes32ScVal,
  addrScVal,
  i128ScVal,
  u32ScVal,
  boolScVal,
} from './scval.js'
import { classifyActiveAccount } from './activeAccount.js'
import { AGENT_WASM_GENERATIONS } from './agentCreatorManifest.js'
// Cross-directory import, read-only: this test proves the seam BETWEEN grant.js's new readers and
// permissionGrantV3.js's prover (Task W2b's whole point) — mirrors permissionGrantV3.js itself
// importing AGENT_KIND_BRIDGE back from stellar/grant.js. Nothing in strategy/ is modified.
import { deriveScopeIdV3, proveReusablePermission } from '../strategy/permissionGrantV3.js'

// Relay is the only network dependency submitGrant/runAgentPull reach for; mock it so the tests
// run offline. Each test reconfigures the two fns it needs.
const submitViaRelayMock = vi.fn()
const getRelayerAddressMock = vi.fn()
vi.mock('./relay.js', () => ({
  submitViaRelay: (...a) => submitViaRelayMock(...a),
  getRelayerAddress: (...a) => getRelayerAddressMock(...a),
}))

const signAgentDepositEntriesMock = vi.fn()
vi.mock('./agentDeposit.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    signAgentDepositEntries: (...a) => signAgentDepositEntriesMock(...a),
  }
})

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
  buildAgentPull,
  runAgentPull,
  buildGrantV3Tx,
  buildAgentPullV3,
  submitGrantV3,
  revokeGrant,
  readPermissionGrant,
  readRemainingBudget,
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
  signAgentDepositEntriesMock.mockReset()
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
  it('buildAgentPull remains independent of owner-account variables on the session-key path', async () => {
    const server = fakeServer()
    signAgentDepositEntriesMock.mockImplementation(async ({ tx }) => ({
      xdr: tx.toEnvelope().toXDR('base64'),
    }))

    await expect(
      buildAgentPull({
        agentAddress: AGENT_1,
        amount: 10_000_000n,
        relayer: RELAYER_G,
        sessionKey: { rawPublicKey: new Uint8Array(32), sign: () => new Uint8Array(64) },
        server,
      })
    ).resolves.toEqual({ xdr: expect.any(String) })
    expect(signAgentDepositEntriesMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentAddress: AGENT_1 })
    )
  })

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

  it('classifies an account change after relay dispatch as submission-unknown', async () => {
    const server = fakeServer()
    const captured = Object.freeze({
      version: 1,
      kind: 'G',
      address: OWNER,
      networkPassphrase: 'Test SDF Network ; September 2015',
      connectorId: 'freighter',
      epoch: 41,
    })
    let current = captured
    getRelayerAddressMock.mockResolvedValue(RELAYER_G)
    signAgentDepositEntriesMock.mockImplementation(async ({ tx }) => ({
      xdr: tx.toEnvelope().toXDR('base64'),
    }))
    submitViaRelayMock.mockImplementation(async () => {
      current = Object.freeze({ ...captured, epoch: 42 })
      return { hash: 'HPULL', status: 'SUCCESS' }
    })

    await expect(
      runAgentPull({
        agentAddress: AGENT_1,
        amount: 10_000_000n,
        sessionKey: { rawPublicKey: new Uint8Array(32), sign: () => new Uint8Array(64) },
        server,
        activeAccount: captured,
        getCurrentActiveAccount: () => current,
      })
    ).rejects.toMatchObject({
      code: 'VF_SUBMISSION_UNKNOWN',
      submission: 'unknown',
      result: { hash: 'HPULL', status: 'SUCCESS' },
    })
  })
})

// --- Router V3, bounded reusable permission (IQ Alter remediation Task 5) ---------------------

// Shape-valid contract id standing in for a future deployed V3 router. Deliberately absent from
// ROUTER_SCHEMAS, so the production resolver treats it exactly like every other live address.
const ROUTER_V3 = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const asV3 = () => ({ version: 3, tokenMode: 'reusable-permission' })
const PERMISSION_ID = '0x' + '11'.repeat(32)
const EXECUTION_ID = '0x' + '22'.repeat(32)
const reviewedApproval = { mandateCeilingUnits: '100000000', liveUntilLedger: 1_412_345 }

// grant_v3 returns (permission_id, agent_addresses).
function grantV3Retval(addrs) {
  return xdr.ScVal.scvVec([
    nativeToScVal(Buffer.alloc(32, 0x11), { type: 'bytes' }),
    agentsRetval(addrs),
  ])
}

function invokeArgs(tx) {
  return tx.operations[0].func.invokeContract().args()
}

describe('buildGrantV3Tx / buildAgentPullV3 — dormant until a V3 router is deployed', () => {
  it('refuses every router that exists today, before touching the network', async () => {
    const server = fakeServer({ latest: 1000, retval: grantV3Retval([AGENT_1]) })
    const touched = vi.fn()
    const watched = { ...server, getAccount: touched, simulateTransaction: touched }
    await expect(
      buildGrantV3Tx({
        owner: OWNER,
        token: TOKEN,
        approval: reviewedApproval,
        perRunMaxUnits: '50000000',
        agentInits: [sampleInits[0]],
        router: ROUTER_V3,
        server: watched,
      })
    ).rejects.toThrow(/bounded reusable permissions/i)
    expect(touched).not.toHaveBeenCalled()
  })

  it('refuses a pull_v3 against every router that exists today', async () => {
    await expect(
      buildAgentPullV3({
        permissionId: PERMISSION_ID,
        executionId: EXECUTION_ID,
        agentAddress: AGENT_1,
        amount: 1n,
        relayer: RELAYER_G,
        sessionKey: {},
        router: ROUTER_V3,
        server: fakeServer({ latest: 1000 }),
      })
    ).rejects.toThrow(/bounded reusable permissions/i)
  })
})

describe('buildGrantV3Tx — the reviewed bound is what gets signed', () => {
  it('encodes grant_v3 with exactly six args in ABI order', async () => {
    const server = fakeServer({ latest: 1000, retval: grantV3Retval([AGENT_1, AGENT_2]) })
    const { tx } = await buildGrantV3Tx({
      owner: OWNER,
      token: TOKEN,
      approval: reviewedApproval,
      perRunMaxUnits: '50000000',
      agentInits: sampleInits,
      router: ROUTER_V3,
      server,
      resolveSchema: asV3,
    })
    const op = tx.operations[0].func.invokeContract()
    expect(op.functionName().toString()).toBe('grant_v3')
    expect(invokeArgs(tx)).toHaveLength(6)
  })

  it('signs the REVIEWED liveUntilLedger, never one recomputed from the current ledger', async () => {
    // A latest-ledger far from the reviewed value: any recomputation here would be visible.
    const server = fakeServer({ latest: 7, retval: grantV3Retval([AGENT_1]) })
    const { tx, liveUntilLedger } = await buildGrantV3Tx({
      owner: OWNER,
      token: TOKEN,
      approval: reviewedApproval,
      perRunMaxUnits: '50000000',
      agentInits: [sampleInits[0]],
      router: ROUTER_V3,
      server,
      resolveSchema: asV3,
    })
    expect(liveUntilLedger).toBe(reviewedApproval.liveUntilLedger)
    expect(invokeArgs(tx)[4].u32()).toBe(reviewedApproval.liveUntilLedger)
  })

  it('carries the reviewed ceiling exactly, beyond Number precision', async () => {
    const server = fakeServer({ latest: 1000, retval: grantV3Retval([AGENT_1]) })
    const { tx } = await buildGrantV3Tx({
      owner: OWNER,
      token: TOKEN,
      approval: { mandateCeilingUnits: '9007199254740993', liveUntilLedger: 1_412_345 },
      perRunMaxUnits: '50000000',
      agentInits: [sampleInits[0]],
      router: ROUTER_V3,
      server,
      resolveSchema: asV3,
    })
    const ceiling = invokeArgs(tx)[2].i128()
    const encoded = (BigInt(ceiling.hi().toString()) << 64n) | BigInt(ceiling.lo().toString())
    expect(encoded).toBe(9007199254740993n)
  })

  it("reads the deployed agent addresses out of grant_v3's (permission_id, agents) retval", async () => {
    const server = fakeServer({ latest: 1000, retval: grantV3Retval([AGENT_1, AGENT_2]) })
    const { agentAddresses } = await buildGrantV3Tx({
      owner: OWNER,
      token: TOKEN,
      approval: reviewedApproval,
      perRunMaxUnits: '50000000',
      agentInits: sampleInits,
      router: ROUTER_V3,
      server,
      resolveSchema: asV3,
    })
    expect(agentAddresses).toEqual([AGENT_1, AGENT_2])
  })

  it("decodes permissionId from the SAME retval agentAddresses comes from (grant_v3's first tuple element), never a fabricated value", async () => {
    const server = fakeServer({ latest: 1000, retval: grantV3Retval([AGENT_1, AGENT_2]) })
    const { permissionId } = await buildGrantV3Tx({
      owner: OWNER,
      token: TOKEN,
      approval: reviewedApproval,
      perRunMaxUnits: '50000000',
      agentInits: sampleInits,
      router: ROUTER_V3,
      server,
      resolveSchema: asV3,
    })
    // grantV3Retval encodes a 32-byte permission_id of all 0x11 — anything else means the decode
    // path drifted from the chain's own retval. Compared directly, with NO normalization on
    // either side: `permissionId` must already be the repo-wide '0x'-prefixed lowercase hex
    // STRING (never a Buffer) — see this function's own doc comment for why.
    expect(permissionId).toBe('0x' + '11'.repeat(32))
    expect(typeof permissionId).toBe('string')
  })

  it('refuses an approval with no absolute ledger expiry', async () => {
    await expect(
      buildGrantV3Tx({
        owner: OWNER,
        token: TOKEN,
        approval: { mandateCeilingUnits: '1' },
        perRunMaxUnits: '1',
        agentInits: [sampleInits[0]],
        router: ROUTER_V3,
        server: fakeServer({ latest: 1000 }),
        resolveSchema: asV3,
      })
    ).rejects.toThrow(/liveUntilLedger/i)
  })
})

describe('buildGrantV3Tx — permissionId 32-byte guard (fail loudly, never a placeholder)', () => {
  // Feeding a bad INPUT to exercise a validation branch is what testing a guard means — these
  // stub the chain's own retval so retval[0] is the wrong shape, rather than mutating any
  // production code, and assert the guard's own throw message.
  const buildArgs = (server) => ({
    owner: OWNER,
    token: TOKEN,
    approval: reviewedApproval,
    perRunMaxUnits: '50000000',
    agentInits: [sampleInits[0]],
    router: ROUTER_V3,
    server,
    resolveSchema: asV3,
  })

  it('throws when the decoded permission_id is 31 bytes (one short)', async () => {
    const server = fakeServer({
      latest: 1000,
      retval: xdr.ScVal.scvVec([
        nativeToScVal(Buffer.alloc(31, 0x11), { type: 'bytes' }),
        agentsRetval([AGENT_1]),
      ]),
    })
    await expect(buildGrantV3Tx(buildArgs(server))).rejects.toThrow(
      /malformed permission_id \(expected 32 bytes, got 31\)/
    )
  })

  it('throws when the decoded permission_id is 33 bytes (one over)', async () => {
    const server = fakeServer({
      latest: 1000,
      retval: xdr.ScVal.scvVec([
        nativeToScVal(Buffer.alloc(33, 0x11), { type: 'bytes' }),
        agentsRetval([AGENT_1]),
      ]),
    })
    await expect(buildGrantV3Tx(buildArgs(server))).rejects.toThrow(
      /malformed permission_id \(expected 32 bytes, got 33\)/
    )
  })

  it('throws when the retval is not the (permission_id, agents) tuple at all', async () => {
    // A single Address ScVal (not wrapped in a Vec) decodes DIRECTLY to a bare string (per this
    // file's own pinned scValToNative-shape tests below) — Array.isArray(retval) is false, so the
    // guard sees `undefined`, not merely the wrong type.
    const server = fakeServer({ latest: 1000, retval: Address.fromString(AGENT_1).toScVal() })
    await expect(buildGrantV3Tx(buildArgs(server))).rejects.toThrow(
      /malformed permission_id \(expected 32 bytes, got none\)/
    )
  })
})

describe('buildAgentPullV3 — permission + deterministic execution id', () => {
  it('encodes pull_v3(permission_id, execution_id, agent, amount)', async () => {
    let built = null
    signAgentDepositEntriesMock.mockImplementation(async ({ tx }) => {
      built = tx
      return { xdr: tx.toEnvelope().toXDR('base64') }
    })
    await buildAgentPullV3({
      permissionId: PERMISSION_ID,
      executionId: EXECUTION_ID,
      agentAddress: AGENT_1,
      amount: 25_000_000n,
      relayer: RELAYER_G,
      sessionKey: {},
      router: ROUTER_V3,
      server: fakeServer({ latest: 1000 }),
      resolveSchema: asV3,
    })
    const op = built.operations[0].func.invokeContract()
    expect(op.functionName().toString()).toBe('pull_v3')
    const args = invokeArgs(built)
    expect(args).toHaveLength(4)
    expect(args[0].bytes().toString('hex')).toBe('11'.repeat(32))
    expect(args[1].bytes().toString('hex')).toBe('22'.repeat(32))
    expect(Address.fromScVal(args[2]).toString()).toBe(AGENT_1)
  })
})

// Reviewed approval whose ceiling exceeds Number.MAX_SAFE_INTEGER — a stray Number() coercion
// anywhere in submitGrantV3's pass-through would visibly corrupt this (unlike a round value like
// '100000000', which round-trips through Number perfectly and would hide the same bug).
const bigApproval = { mandateCeilingUnits: '9007199254740993', liveUntilLedger: 1_412_345 }
const bigPerRunMaxUnits = '9007199254740993'

describe('submitGrantV3 - a single signature (dormant until a V3 router is deployed)', () => {
  it('signs exactly ONCE (the envelope), relays, and returns the CHAIN-DECODED permissionId (never invented locally)', async () => {
    const server = fakeServer({ latest: 1000, retval: grantV3Retval([AGENT_1, AGENT_2]) })
    submitViaRelayMock.mockResolvedValue({ hash: 'HV3REL', status: 'SUCCESS', relayer: 'GR' })
    const sign = vi.fn(async (x) => `SIGNED:${x}`)

    const out = await submitGrantV3({
      owner: OWNER,
      token: TOKEN,
      approval: bigApproval,
      perRunMaxUnits: bigPerRunMaxUnits,
      agentInits: sampleInits,
      router: ROUTER_V3,
      server,
      sign,
      resolveSchema: asV3,
    })

    expect(sign).toHaveBeenCalledTimes(1) // a single signature for N=2 agents, same as submitGrant
    expect(signOwnerAuthEntryMock).not.toHaveBeenCalled() // G owner never takes the C ceremony path
    expect(submitViaRelayMock).toHaveBeenCalledTimes(1)
    expect(out.hash).toBe('HV3REL')
    expect(out.status).toBe('SUCCESS')
    expect(out.agentAddresses).toEqual([AGENT_1, AGENT_2])
    expect(out.liveUntilLedger).toBe(bigApproval.liveUntilLedger)
    // grantV3Retval's permission_id is 32 bytes of 0x11 — a locally-invented or re-derived value
    // would not reproduce this exact byte pattern. Compared directly (no `Buffer.from(...)`
    // normalization on either side): a bare Buffer here fails this literal string comparison
    // immediately, which is the point — only the repo-wide '0x'-prefixed hex string satisfies it.
    expect(out.permissionId).toBe('0x' + '11'.repeat(32))
  })

  it('threads mandateCeilingUnits/perRunMaxUnits through submitGrantV3 → buildGrantV3Tx into the BUILT TX exactly, beyond Number precision', async () => {
    // Unlike a test that only reads submitGrantV3's own return value, this reads the unit values
    // back out of the actual built transaction (via the xdr the G-owner `sign` step was handed) —
    // so a stray Number() ANYWHERE in the pass-through (submitGrantV3's own args, or the object it
    // hands to buildGrantV3Tx) is caught, not just one already covered by buildGrantV3Tx's own
    // narrower "carries the reviewed ceiling exactly" unit test.
    const server = fakeServer({ latest: 1000, retval: grantV3Retval([AGENT_1, AGENT_2]) })
    submitViaRelayMock.mockResolvedValue({ hash: 'HV3REL', status: 'SUCCESS', relayer: 'GR' })
    let signedXdr = null
    const sign = vi.fn(async (x) => {
      signedXdr = x
      return `SIGNED:${x}`
    })

    await submitGrantV3({
      owner: OWNER,
      token: TOKEN,
      approval: bigApproval,
      perRunMaxUnits: bigPerRunMaxUnits,
      agentInits: sampleInits,
      router: ROUTER_V3,
      server,
      sign,
      resolveSchema: asV3,
    })

    const builtTx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE)
    const args = invokeArgs(builtTx)
    const i128ToString = (scv) => {
      const v = scv.i128()
      return ((BigInt(v.hi().toString()) << 64n) | BigInt(v.lo().toString())).toString()
    }
    // ABI order: owner(0), token(1), mandate_ceiling(2), per_run_max(3), live_until_ledger(4), agents(5).
    expect(i128ToString(args[2])).toBe(bigApproval.mandateCeilingUnits)
    expect(i128ToString(args[3])).toBe(bigPerRunMaxUnits)
  })

  it("crosses the decode→next-use seam: submitGrantV3's own permissionId feeds straight into buildAgentPullV3 with NO conversion at the call site", async () => {
    const server = fakeServer({ latest: 1000, retval: grantV3Retval([AGENT_1]) })
    submitViaRelayMock.mockResolvedValue({ hash: 'HV3REL2', status: 'SUCCESS' })
    const sign = vi.fn(async (x) => `SIGNED:${x}`)

    const granted = await submitGrantV3({
      owner: OWNER,
      token: TOKEN,
      approval: bigApproval,
      perRunMaxUnits: bigPerRunMaxUnits,
      agentInits: [sampleInits[0]],
      router: ROUTER_V3,
      server,
      sign,
      resolveSchema: asV3,
    })

    // The value itself, UNNORMALIZED on either side — the seam-crossing assertion that actually
    // matters. `Buffer.from(x).toString('hex')` would erase a representation mismatch (a Buffer
    // and a hex string of the same bytes both survive that round-trip); a bare `toBe` against the
    // literal hex string does not.
    expect(granted.permissionId).toBe('0x' + '11'.repeat(32))

    // Feed it straight into buildAgentPullV3 exactly as a real caller would — no conversion at the
    // call site — proving the two functions actually agree on the wire, not just that each one
    // individually claims to use hex in its own JSDoc.
    let builtPull = null
    signAgentDepositEntriesMock.mockImplementation(async ({ tx }) => {
      builtPull = tx
      return { xdr: tx.toEnvelope().toXDR('base64') }
    })
    await buildAgentPullV3({
      permissionId: granted.permissionId,
      executionId: EXECUTION_ID,
      agentAddress: AGENT_1,
      amount: 1_000_000n,
      relayer: RELAYER_G,
      sessionKey: {},
      router: ROUTER_V3,
      server: fakeServer({ latest: 1000 }),
      resolveSchema: asV3,
    })
    const pullArgs = invokeArgs(builtPull)
    expect(pullArgs[0].bytes().toString('hex')).toBe('11'.repeat(32))
  })

  it('falls back to a direct user-paid submit when the relay is off (returns null)', async () => {
    const server = fakeServer({ latest: 1000, retval: grantV3Retval([AGENT_1]) })
    submitViaRelayMock.mockResolvedValue(null) // relay unconfigured
    const sign = vi.fn(async (x) => `SIGNED:${x}`)

    const out = await submitGrantV3({
      owner: OWNER,
      token: TOKEN,
      approval: bigApproval,
      perRunMaxUnits: bigPerRunMaxUnits,
      agentInits: [sampleInits[0]],
      router: ROUTER_V3,
      server,
      sign,
      resolveSchema: asV3,
    })

    expect(sign).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ hash: 'HDIRECT', status: 'SUCCESS', agentAddresses: [AGENT_1] })
  })

  it('throws when the relay reports a non-SUCCESS status (never swallows the refusal into a success)', async () => {
    const server = fakeServer({ latest: 1, retval: grantV3Retval([AGENT_1]) })
    submitViaRelayMock.mockResolvedValue({ hash: 'H', status: 'FAILED' })
    await expect(
      submitGrantV3({
        owner: OWNER,
        token: TOKEN,
        approval: bigApproval,
        perRunMaxUnits: bigPerRunMaxUnits,
        agentInits: [sampleInits[0]],
        router: ROUTER_V3,
        server,
        sign: async (x) => x,
        resolveSchema: asV3,
      })
    ).rejects.toThrow(/grant relay returned FAILED/)
  })
})

describe('submitGrantV3 - C owner (passkey), routed through OwnerAuthorizationV1', () => {
  it('sources the grant from the relayer, signs via the passkey ceremony, and submits relay-only', async () => {
    const server = fakeServer({ latest: 1000, retval: grantV3Retval([AGENT_1]) })
    getRelayerAddressMock.mockResolvedValue(RELAYER_G)
    signOwnerAuthEntryMock.mockResolvedValue('SIGNED_C_XDR_V3')
    submitViaRelayMock.mockResolvedValue({ hash: 'HCV3', status: 'SUCCESS' })
    // An explicit mock here (rather than relying on the default `signWithTimeout`) is what makes
    // a mis-routed G-branch mutation fail DETERMINISTICALLY on the assertion below, instead of on
    // an unrelated environmental crash (a real, unmocked `signWithTimeout` throwing on a Freighter
    // import in this non-wallet test environment) that happens to also produce a red test but
    // proves nothing about the routing branch itself.
    const sign = vi.fn(async (x) => `SIGNED:${x}`)

    const out = await submitGrantV3({
      owner: OWNER_C,
      token: TOKEN,
      approval: bigApproval,
      perRunMaxUnits: bigPerRunMaxUnits,
      agentInits: [sampleInits[0]],
      router: ROUTER_V3,
      server,
      sign,
      activeAccount: { kind: 'C', address: OWNER_C },
      resolveSchema: asV3,
    })

    expect(signOwnerAuthEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: OWNER_C })
    )
    expect(sign).not.toHaveBeenCalled() // C owner never takes the classic-envelope path
    expect(submitViaRelayMock).toHaveBeenCalledWith({ xdr: 'SIGNED_C_XDR_V3' })
    expect(out).toMatchObject({ hash: 'HCV3', status: 'SUCCESS', agentAddresses: [AGENT_1] })
    // Direct, unnormalized comparison — see the G-owner test above for why.
    expect(out.permissionId).toBe('0x' + '11'.repeat(32))
  })

  it('has no user-funded fallback: an unreachable relay throws instead of billing the C owner', async () => {
    const server = fakeServer({ latest: 1000, retval: grantV3Retval([AGENT_1]) })
    getRelayerAddressMock.mockResolvedValue(RELAYER_G)
    signOwnerAuthEntryMock.mockResolvedValue('SIGNED_C_XDR_V3')
    submitViaRelayMock.mockResolvedValue(null) // relay unreachable AFTER the ceremony already ran
    const sign = vi.fn(async (x) => `SIGNED:${x}`)

    await expect(
      submitGrantV3({
        owner: OWNER_C,
        token: TOKEN,
        approval: bigApproval,
        perRunMaxUnits: bigPerRunMaxUnits,
        agentInits: [sampleInits[0]],
        router: ROUTER_V3,
        server,
        sign,
        activeAccount: { kind: 'C', address: OWNER_C },
        resolveSchema: asV3,
      })
    ).rejects.toMatchObject({ code: 'VF_SUBMISSION_UNKNOWN' })
    expect(sign).not.toHaveBeenCalled()
  })

  it('fails BEFORE the passkey ceremony when no relayer is funded', async () => {
    const server = fakeServer({ latest: 1000, retval: grantV3Retval([AGENT_1]) })
    getRelayerAddressMock.mockResolvedValue(null)
    const sign = vi.fn(async (x) => `SIGNED:${x}`)

    await expect(
      submitGrantV3({
        owner: OWNER_C,
        token: TOKEN,
        approval: bigApproval,
        perRunMaxUnits: bigPerRunMaxUnits,
        agentInits: [sampleInits[0]],
        router: ROUTER_V3,
        sign,
        server,
        activeAccount: { kind: 'C', address: OWNER_C },
        resolveSchema: asV3,
      })
    ).rejects.toMatchObject({ code: 'VF_FEE_PAYER_UNAVAILABLE' })
    expect(signOwnerAuthEntryMock).not.toHaveBeenCalled()
    expect(sign).not.toHaveBeenCalled()
  })
})

// --- Router V3 permission readers (Task W2b) --------------------------------------------------
// `proveReusablePermission` (permissionGrantV3.js) has always taken `readPermissionGrant` and
// `readRemainingBudget` as injected dependencies and called them unconditionally — but neither
// existed anywhere in the repo (parameter names with no implementation, no default). This section
// proves the two functions above ARE that missing seam, and — the point of the whole task — that
// their ACTUAL output satisfies the exact contract the prover requires: a one-character format
// drift on a 32-byte id (missing `0x`, wrong case, a byte reversal) makes every V3 reuse decision
// `scope-drift` forever, which is exactly the defect class this remediation plan exists to fix.

// Deterministic, non-palindromic, letter-containing 32-byte hex fixtures for the UNIT-level
// readPermissionGrant tests below (never the cross-layer seam test, which uses the REAL Rust-pinned
// vector instead — see that describe block). Built the same way the brief warns against NOT
// building fixtures: a round value like `'00'.repeat(32)` or a palindrome would hide exactly the
// byte-reversal / case bugs these ids exist to catch.
const SCOPE_ID_RAW_HEX = 'a0a7aeb5bcc3cad1d8dfe6edf4fb020910171e252c333a41484f565d646b7279'
const PERMISSION_ID_RAW_HEX = '303b46515c67727d88939ea9b4bfcad5e0ebf6010c17222d38434e59646f7a85'

// Encodes a `PermissionGrantV3` (funding_router/src/types.rs) exactly as the router would return
// it from `permission_grant` — structScVal sorts the ScMap keys lexicographically itself, so field
// order here is purely for readability (mirrors the Rust struct's declared order).
function permissionGrantStructScVal({
  permissionIdHex,
  scopeIdHex,
  owner,
  token,
  mandateCeiling,
  confirmedSpent,
  perRunMax,
  liveUntilLedger,
  revoked,
}) {
  return structScVal({
    permission_id: bytes32ScVal(permissionIdHex),
    scope_id: bytes32ScVal(scopeIdHex),
    owner: addrScVal(owner),
    token: addrScVal(token),
    mandate_ceiling: i128ScVal(mandateCeiling),
    confirmed_spent: i128ScVal(confirmedSpent),
    per_run_max: i128ScVal(perRunMax),
    live_until_ledger: u32ScVal(liveUntilLedger),
    revoked: boolScVal(revoked),
  })
}

const invokedMethod = (tx) => tx.operations[0].func.invokeContract().functionName().toString()

// One fake RPC server standing in for BOTH `permission_grant` and `remaining_budget` — readContract
// picks the method via the tx it builds, this just answers whichever one was invoked.
function v3ReadServer({ grantRetval, remainingRetval } = {}) {
  return {
    simulateTransaction: async (tx) => {
      const method = invokedMethod(tx)
      if (method === 'permission_grant') return { result: { retval: grantRetval } }
      if (method === 'remaining_budget') return { result: { retval: remainingRetval } }
      throw new Error(`v3ReadServer: unexpected method ${method}`)
    },
  }
}

// --- Fix round 1, item 1: exercise each decoded-field type guard INDIVIDUALLY --------------------
// Review found that disabling bytes32ToHexId's length check, requireDecodedString,
// requireI128UnitsString's bigint check, and requireU32Integer's number check ALL AT ONCE left the
// suite green — only requireDecodedBool was ever fed a wrong-typed value. Every test below swaps
// exactly ONE field of an otherwise-valid grant struct for a wrong-typed ScVal (never a
// production-code mutation) so each guard is independently proven to matter.
function withField(sv, key, replacement) {
  const entries = sv
    .map()
    .map((e) =>
      e.key().sym().toString() === key ? new xdr.ScMapEntry({ key: e.key(), val: replacement }) : e
    )
  return xdr.ScVal.scvMap(entries)
}

function validGrantScVal(over = {}) {
  return permissionGrantStructScVal({
    permissionIdHex: '0x' + PERMISSION_ID_RAW_HEX,
    scopeIdHex: '0x' + SCOPE_ID_RAW_HEX,
    owner: OWNER,
    token: TOKEN,
    mandateCeiling: 1n,
    confirmedSpent: 1n,
    perRunMax: 1n,
    liveUntilLedger: 1_412_345,
    revoked: false,
    ...over,
  })
}

describe('scValToNative shape — pinned empirically per Rust type, never assumed (Task W2b)', () => {
  it('i128 decodes to a BigInt', () => {
    const decoded = fromScVal(i128ScVal(9_007_199_254_740_993n))
    expect(typeof decoded).toBe('bigint')
    expect(decoded).toBe(9_007_199_254_740_993n)
  })

  it('u32 decodes to a number satisfying Number.isInteger (never a BigInt)', () => {
    const decoded = fromScVal(u32ScVal(1_412_345))
    expect(typeof decoded).toBe('number')
    expect(Number.isInteger(decoded)).toBe(true)
    expect(decoded).toBe(1_412_345)
  })

  it('bool decodes to a boolean', () => {
    expect(fromScVal(boolScVal(true))).toBe(true)
    expect(fromScVal(boolScVal(false))).toBe(false)
  })

  it('a bytes(32) value decodes to a Uint8Array-compatible byte array (a Buffer, in Node)', () => {
    const decoded = fromScVal(bytes32ScVal('0x' + SCOPE_ID_RAW_HEX))
    expect(decoded instanceof Uint8Array).toBe(true)
    expect(decoded.length).toBe(32)
  })

  it('an Address decodes DIRECTLY to its strkey string — already the final shape, unchanged', () => {
    const decoded = fromScVal(addrScVal(OWNER))
    expect(typeof decoded).toBe('string')
    expect(decoded).toBe(OWNER)
  })

  it('a #[contracttype] struct (an ScMap of symbol keys) decodes to a plain object keyed by the Rust field names VERBATIM (snake_case, never renamed)', () => {
    const sv = permissionGrantStructScVal({
      permissionIdHex: '0x' + PERMISSION_ID_RAW_HEX,
      scopeIdHex: '0x' + SCOPE_ID_RAW_HEX,
      owner: OWNER,
      token: TOKEN,
      mandateCeiling: 9_007_199_254_740_993n,
      confirmedSpent: 1n,
      perRunMax: 50_000_000n,
      liveUntilLedger: 1_412_345,
      revoked: false,
    })
    const decoded = fromScVal(sv)
    expect(Object.keys(decoded).sort()).toEqual(
      [
        'permission_id',
        'scope_id',
        'owner',
        'token',
        'mandate_ceiling',
        'confirmed_spent',
        'per_run_max',
        'live_until_ledger',
        'revoked',
      ].sort()
    )
    expect(typeof decoded.mandate_ceiling).toBe('bigint')
    expect(typeof decoded.live_until_ledger).toBe('number')
    expect(typeof decoded.revoked).toBe('boolean')
    expect(decoded.permission_id instanceof Uint8Array).toBe(true)
    expect(typeof decoded.owner).toBe('string')
  })

  it("Option::None decodes to bare null — Soroban's Option<T> has no separate Some/None wrapper, and neither does scValToNative", () => {
    expect(fromScVal(xdr.ScVal.scvVoid())).toBeNull()
  })
})

describe('readPermissionGrant — Router V3 (Task W2b)', () => {
  // Beyond Number.MAX_SAFE_INTEGER so a stray Number() coercion anywhere in the reader visibly
  // corrupts it — a round value like '100000000' round-trips through Number perfectly and would
  // hide the exact same bug.
  const BIG = 9_007_199_254_740_993n

  function grantScVal(over = {}) {
    return permissionGrantStructScVal({
      permissionIdHex: '0x' + PERMISSION_ID_RAW_HEX,
      scopeIdHex: '0x' + SCOPE_ID_RAW_HEX,
      owner: OWNER,
      token: TOKEN,
      mandateCeiling: BIG,
      confirmedSpent: 1n,
      perRunMax: BIG,
      liveUntilLedger: 1_412_345,
      revoked: false,
      ...over,
    })
  }

  it('decodes a Some(PermissionGrantV3) into the EXACT camelCase shape the V3 prover requires', async () => {
    const server = v3ReadServer({ grantRetval: grantScVal() })
    const grant = await readPermissionGrant({
      router: ROUTER_V3,
      permissionId: PERMISSION_ID,
      server,
    })
    expect(grant).toEqual({
      permissionId: '0x' + PERMISSION_ID_RAW_HEX,
      scopeId: '0x' + SCOPE_ID_RAW_HEX,
      owner: OWNER,
      token: TOKEN,
      mandateCeilingUnits: '9007199254740993',
      confirmedSpentUnits: '1',
      perRunMaxUnits: '9007199254740993',
      liveUntilLedger: 1_412_345,
      revoked: false,
    })
  })

  it('normalizes both 32-byte ids to 0x-prefixed LOWERCASE hex — the exact format deriveScopeIdV3 emits', async () => {
    const server = v3ReadServer({ grantRetval: grantScVal() })
    const grant = await readPermissionGrant({
      router: ROUTER_V3,
      permissionId: PERMISSION_ID,
      server,
    })
    expect(grant.scopeId).toMatch(/^0x[0-9a-f]{64}$/)
    expect(grant.permissionId).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('emits liveUntilLedger as a number satisfying Number.isInteger — never a BigInt', async () => {
    const server = v3ReadServer({ grantRetval: grantScVal() })
    const grant = await readPermissionGrant({
      router: ROUTER_V3,
      permissionId: PERMISSION_ID,
      server,
    })
    expect(typeof grant.liveUntilLedger).toBe('number')
    expect(Number.isInteger(grant.liveUntilLedger)).toBe(true)
  })

  it('carries i128 fields beyond Number.MAX_SAFE_INTEGER exactly, as canonical decimal STRINGS — never Number()', async () => {
    const server = v3ReadServer({ grantRetval: grantScVal() })
    const grant = await readPermissionGrant({
      router: ROUTER_V3,
      permissionId: PERMISSION_ID,
      server,
    })
    expect(grant.mandateCeilingUnits).toBe('9007199254740993')
    expect(grant.perRunMaxUnits).toBe('9007199254740993')
    expect(typeof grant.mandateCeilingUnits).toBe('string')
    expect(typeof grant.perRunMaxUnits).toBe('string')
  })

  it('returns null for a confirmed-absent permission (Option::None) — never a partial object', async () => {
    const server = v3ReadServer({ grantRetval: xdr.ScVal.scvVoid() })
    const grant = await readPermissionGrant({
      router: ROUTER_V3,
      permissionId: PERMISSION_ID,
      server,
    })
    expect(grant).toBeNull()
  })

  it('a read FAILURE (RPC down / simulation error) THROWS — never masquerades as null', async () => {
    const server = {
      simulateTransaction: async () => {
        throw new Error('rpc down')
      },
    }
    await expect(
      readPermissionGrant({ router: ROUTER_V3, permissionId: PERMISSION_ID, server })
    ).rejects.toThrow()
  })

  it('throws when the decoded struct is MISSING a field, rather than returning a half-populated grant', async () => {
    const full = grantScVal()
    const entries = full.map().filter((e) => e.key().sym().toString() !== 'revoked')
    const server = v3ReadServer({ grantRetval: xdr.ScVal.scvMap(entries) })
    await expect(
      readPermissionGrant({ router: ROUTER_V3, permissionId: PERMISSION_ID, server })
    ).rejects.toThrow(/revoked/)
  })

  it('throws when a field decodes to the WRONG type (revoked encoded as a string, not a bool)', async () => {
    const full = grantScVal()
    const entries = full
      .map()
      .map((e) =>
        e.key().sym().toString() === 'revoked'
          ? new xdr.ScMapEntry({ key: e.key(), val: xdr.ScVal.scvString('nope') })
          : e
      )
    const server = v3ReadServer({ grantRetval: xdr.ScVal.scvMap(entries) })
    await expect(
      readPermissionGrant({ router: ROUTER_V3, permissionId: PERMISSION_ID, server })
    ).rejects.toThrow(/revoked/)
  })
})

describe('readRemainingBudget — Router V3 (Task W2b)', () => {
  it('decodes the i128 remaining budget into a canonical decimal-integer STRING satisfying assertUnits', async () => {
    const server = v3ReadServer({ remainingRetval: i128ScVal(75_000_000n) })
    const remaining = await readRemainingBudget({
      router: ROUTER_V3,
      permissionId: PERMISSION_ID,
      server,
    })
    expect(remaining).toBe('75000000')
    expect(typeof remaining).toBe('string')
  })

  it('carries a value beyond Number.MAX_SAFE_INTEGER exactly, as a string — never Number()', async () => {
    const server = v3ReadServer({ remainingRetval: i128ScVal(9_007_199_254_740_993n) })
    const remaining = await readRemainingBudget({
      router: ROUTER_V3,
      permissionId: PERMISSION_ID,
      server,
    })
    expect(remaining).toBe('9007199254740993')
  })

  it('a confirmed zero remaining budget decodes to "0" — not an error', async () => {
    const server = v3ReadServer({ remainingRetval: i128ScVal(0n) })
    const remaining = await readRemainingBudget({
      router: ROUTER_V3,
      permissionId: PERMISSION_ID,
      server,
    })
    expect(remaining).toBe('0')
  })

  it('rejects a NEGATIVE remaining_budget HERE, with a clear error — never lets it reach assertUnits as an unhandled rejection', async () => {
    const server = v3ReadServer({ remainingRetval: i128ScVal(-1n) })
    await expect(
      readRemainingBudget({ router: ROUTER_V3, permissionId: PERMISSION_ID, server })
    ).rejects.toThrow(/negative/i)
  })

  // Fix round 1, item 1: this reader's OWN bigint guard (now `requireI128UnitsString`, shared with
  // readPermissionGrant's i128 fields — item 2) was previously untested. A u32 retval decodes to a
  // `number`, not a `bigint`, so this is a genuine wrong-typed decode, not a contrived value.
  it('throws when remaining_budget decodes to a non-BigInt (u32, not i128)', async () => {
    const server = v3ReadServer({ remainingRetval: u32ScVal(5) })
    await expect(
      readRemainingBudget({ router: ROUTER_V3, permissionId: PERMISSION_ID, server })
    ).rejects.toThrow(/remaining_budget must decode to a BigInt/)
  })

  it('a read FAILURE (RPC down / simulation error) THROWS — never masquerades as a budget value', async () => {
    const server = {
      simulateTransaction: async () => {
        throw new Error('rpc down')
      },
    }
    await expect(
      readRemainingBudget({ router: ROUTER_V3, permissionId: PERMISSION_ID, server })
    ).rejects.toThrow()
  })
})

describe('readPermissionGrant — decoded-field type guards, individually exercised (Fix round 1, item 1)', () => {
  it('bytes32ToHexId: throws when permission_id decodes to the wrong length (16 bytes, not 32)', async () => {
    const bad = withField(
      validGrantScVal(),
      'permission_id',
      nativeToScVal(new Uint8Array(16), { type: 'bytes' })
    )
    const server = v3ReadServer({ grantRetval: bad })
    await expect(
      readPermissionGrant({ router: ROUTER_V3, permissionId: PERMISSION_ID, server })
    ).rejects.toThrow(/permission_id must decode to exactly 32 bytes/)
  })

  it('bytes32ToHexId: throws when scope_id decodes to the wrong length (16 bytes, not 32)', async () => {
    const bad = withField(
      validGrantScVal(),
      'scope_id',
      nativeToScVal(new Uint8Array(16), { type: 'bytes' })
    )
    const server = v3ReadServer({ grantRetval: bad })
    await expect(
      readPermissionGrant({ router: ROUTER_V3, permissionId: PERMISSION_ID, server })
    ).rejects.toThrow(/scope_id must decode to exactly 32 bytes/)
  })

  it('requireDecodedString: throws when owner decodes to a non-string (u32, not an Address)', async () => {
    const bad = withField(validGrantScVal(), 'owner', u32ScVal(5))
    const server = v3ReadServer({ grantRetval: bad })
    await expect(
      readPermissionGrant({ router: ROUTER_V3, permissionId: PERMISSION_ID, server })
    ).rejects.toThrow(/owner must decode to a non-empty string/)
  })

  it('requireDecodedString: throws when token decodes to a non-string (u32, not an Address)', async () => {
    const bad = withField(validGrantScVal(), 'token', u32ScVal(5))
    const server = v3ReadServer({ grantRetval: bad })
    await expect(
      readPermissionGrant({ router: ROUTER_V3, permissionId: PERMISSION_ID, server })
    ).rejects.toThrow(/token must decode to a non-empty string/)
  })

  it('requireI128UnitsString: throws when mandate_ceiling decodes to a non-BigInt (u32, not i128)', async () => {
    const bad = withField(validGrantScVal(), 'mandate_ceiling', u32ScVal(5))
    const server = v3ReadServer({ grantRetval: bad })
    await expect(
      readPermissionGrant({ router: ROUTER_V3, permissionId: PERMISSION_ID, server })
    ).rejects.toThrow(/mandate_ceiling must decode to a BigInt/)
  })

  it('requireU32Integer: throws when live_until_ledger decodes to a non-number (i128, not u32)', async () => {
    const bad = withField(validGrantScVal(), 'live_until_ledger', i128ScVal(5n))
    const server = v3ReadServer({ grantRetval: bad })
    await expect(
      readPermissionGrant({ router: ROUTER_V3, permissionId: PERMISSION_ID, server })
    ).rejects.toThrow(/live_until_ledger must decode to an integer/)
  })

  // Fix round 1, item 2: requireI128UnitsString now rejects a negative i128 for EVERY field it
  // guards, not just readRemainingBudget's top-level return. mandate_ceiling is exercised here;
  // confirmed_spent and per_run_max share the identical guard function, so this one row proves the
  // fix for all three (retesting per-field would be redundant, not additional coverage).
  it('requireI128UnitsString: throws when mandate_ceiling decodes to a negative value', async () => {
    const bad = withField(validGrantScVal(), 'mandate_ceiling', i128ScVal(-5n))
    const server = v3ReadServer({ grantRetval: bad })
    await expect(
      readPermissionGrant({ router: ROUTER_V3, permissionId: PERMISSION_ID, server })
    ).rejects.toThrow(/mandate_ceiling decoded a negative value/)
  })
})

describe('readPermissionGrant / readRemainingBudget feed proveReusablePermission — the seam (Task W2b)', () => {
  // Produced by the Rust `funding_router/src/test.rs::scope_id_matches_pinned_cross_layer_vector`
  // (commit c39f9bf) — copied verbatim, exactly like permissionGrantV3.test.js's own
  // PINNED_SCOPE_ID_DEPOSIT — never computed by either side of this test. Using the REAL pinned
  // vector (rather than an invented fixture) makes this a genuine cross-layer proof: the router's
  // OWN target/token/kind/mintRecipient/destinationDomain inputs, hashing to the router's OWN
  // recorded output, decoded by THIS reader off a simulated RPC response and independently
  // reproduced by deriveScopeIdV3.
  const PINNED_TARGET = 'CCQKDIVDUSS2NJ5IVGVKXLFNV2X3BMNSWO2LLNVXXC43VO54XW7L65UW'
  const PINNED_TOKEN = 'CCYLDMVTWS23NN5YXG5LXPF5X274BQOCYPCMLRWHZDE4VS6MZXHM6QJS'
  const PINNED_SCOPE_ID_DEPOSIT =
    '0x775ad5a5c5f2ec6382447626694b4ca75b25a23d466cfa3fda505596861d3202'
  const ZERO_MINT_RECIPIENT = new Uint8Array(32)
  const LEDGER_NOW = 1_400_000
  const NOW_SEC = 1_800_000_000
  // Larger than Number.MAX_SAFE_INTEGER so a stray Number() ANYWHERE on the reader→prover path
  // visibly corrupts it — never a round value like '25000000', which round-trips through Number
  // perfectly and would hide the exact same bug (the brief's own instruction).
  const BIG_UNITS = 9_007_199_254_740_993n
  const REAL_CODE_V3 =
    '0x' + AGENT_WASM_GENERATIONS.find((g) => g.generation === 'agent-v3').wasmHash

  const seamActiveAccount = classifyActiveAccount({
    address: OWNER,
    networkPassphrase: NETWORK_PASSPHRASE,
    connectorId: 'freighter',
    epoch: 3,
  })

  function grantRetval(over = {}) {
    return permissionGrantStructScVal({
      permissionIdHex: PERMISSION_ID,
      scopeIdHex: PINNED_SCOPE_ID_DEPOSIT,
      owner: OWNER,
      token: PINNED_TOKEN,
      mandateCeiling: BIG_UNITS,
      confirmedSpent: 1n,
      perRunMax: BIG_UNITS,
      liveUntilLedger: LEDGER_NOW + 10_000,
      revoked: false,
      ...over,
    })
  }

  function seamDeps(over = {}) {
    const server = v3ReadServer({
      grantRetval: grantRetval(),
      remainingRetval: i128ScVal(BIG_UNITS),
    })
    return {
      runId: 'run-1',
      owner: OWNER,
      router: ROUTER_V3,
      planFingerprint: '0x' + 'f0'.repeat(32),
      permissionId: PERMISSION_ID,
      activeAccount: seamActiveAccount,
      getCurrentActiveAccount: () => seamActiveAccount,
      approval: { mandateCeilingUnits: BIG_UNITS.toString(), liveUntilLedger: LEDGER_NOW + 10_000 },
      currentLedger: LEDGER_NOW,
      nowSec: NOW_SEC,
      server,
      resolveSchema: asV3,
      eligibleGenerations: ['agent-v3'],
      // The functions under test — REAL, not mocked. This IS the seam the brief calls out: if
      // either reader's output format ever drifts from what deriveScopeIdV3/assertUnits/the prover's
      // own gates require, THIS is where it breaks.
      readPermissionGrant,
      readRemainingBudget,
      proveAllowance: vi.fn(async () => ({
        proven: true,
        proof: { gapFree: true, noLaterMutation: true },
      })),
      inspectAgents: vi.fn(async () => [
        {
          agentAddress: AGENT_1,
          target: PINNED_TARGET,
          token: PINNED_TOKEN,
          code: REAL_CODE_V3,
          perRunCapUnits: BIG_UNITS.toString(),
          cumulativeCapUnits: BIG_UNITS.toString(),
          perExecutionMaxUnits: null,
        },
      ]),
      readLinkedPermission: vi.fn(async () => PERMISSION_ID),
      fetchCredential: vi.fn(() => ({ agentAddress: AGENT_1 })),
      agentInits: [
        {
          allocationId: 'run-1:deposit:0',
          kind: AGENT_KIND_DEPOSIT,
          token: PINNED_TOKEN,
          target: PINNED_TARGET,
          cap: { token: PINNED_TOKEN, units: BIG_UNITS, decimals: 7 },
          periodSeconds: 86_400,
          expiry: NOW_SEC + 3600,
          mintRecipient: ZERO_MINT_RECIPIENT,
          destinationDomain: 0,
        },
      ],
      ...over,
    }
  }

  it("proveReusablePermission reaches 'reuse' fed EXCLUSIVELY by these readers' real output — the point of this task", async () => {
    const expectedScopeId = deriveScopeIdV3({
      target: PINNED_TARGET,
      token: PINNED_TOKEN,
      kind: AGENT_KIND_DEPOSIT,
      mintRecipient: ZERO_MINT_RECIPIENT,
      destinationDomain: 0,
    })
    // deriveScopeIdV3's own computation matches the pinned Rust vector — sanity-checks the fixture
    // itself before trusting anything built on top of it.
    expect(expectedScopeId).toBe(PINNED_SCOPE_ID_DEPOSIT)

    const decision = await proveReusablePermission(seamDeps())

    // This is the ONLY load-bearing assertion in this test (Fix round 1, item 3 — a prior
    // `expect(decision.scopeId).toBe(expectedScopeId)` here was removed: `proveReusablePermission`
    // returns its OWN `deriveScopeIdV3` computation, never `grant.scopeId` — see permissionGrantV3.js
    // step 7b — so that line compared `deriveScopeIdV3`'s output to itself and could never fail).
    // If `readPermissionGrant`'s `scopeId` format ever drifted from `expectedScopeId` (missing '0x',
    // wrong case, byte-reversed), gate 7b's `!==` comparison against `grant.scopeId` would force
    // `mode: 'fresh'` / `freshReason: 'scope-drift'`, and THIS assertion goes RED.
    expect(decision.mode).toBe('reuse')
    expect(decision.freshReason).toBeNull()
    // The exact value survives beyond Number precision through the ENTIRE reader -> prover path.
    expect(decision.mandateCeilingUnits).toBe(BIG_UNITS.toString())
    expect(decision.remainingHeadroomUnits).toBe(BIG_UNITS.toString())
  })

  it('a corrupted grant.scopeId (real reader, but the router disagrees) forces scope-drift, never a silent reuse', async () => {
    const decision = await proveReusablePermission(
      seamDeps({
        server: v3ReadServer({
          // A DIFFERENT, still well-formed 32-byte scope_id — simulates the router's own record
          // disagreeing with what this run's reviewed allocation derives to.
          grantRetval: grantRetval({ scopeIdHex: '0x' + SCOPE_ID_RAW_HEX }),
          remainingRetval: i128ScVal(BIG_UNITS),
        }),
      })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('scope-drift')
  })
})
