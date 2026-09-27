// P1 G7: grant-time exit-signer bundling — the grant's own envelope carries `set_exit_signer`
// for each bundled agent (same popup, same single owner signature), so later partial
// withdraws need no extra owner authorization. The default (unbundled) path must stay the
// proven single-op transaction byte-for-byte (live smoke tx in
// deployments/stellar-testnet.json::fundingRouter.smokeTxs).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Account, Address, Keypair, scValToNative, xdr } from '@stellar/stellar-sdk'
import { buildGrantTx, submitGrant, AGENT_KIND_DEPOSIT, AGENT_KIND_BRIDGE } from '../grant.js'

const submitViaRelayMock = vi.fn()
const getRelayerAddressMock = vi.fn()
vi.mock('../relay.js', () => ({
  submitViaRelay: (...a) => submitViaRelayMock(...a),
  getRelayerAddress: (...a) => getRelayerAddressMock(...a),
}))

const signOwnerAuthEntryMock = vi.fn()
vi.mock('../ownerAuthorization.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, signOwnerAuthEntry: (...a) => signOwnerAuthEntryMock(...a) }
})

const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const AGENT_1 = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const AGENT_2 = 'CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY'
const VAULT = 'CB5VKYDUIYX3RZWGVLKKNBPG7V7Z5JIHF2QPNQKWKAHVA3IPSLFZJDYU'
const TOKEN = 'CAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQTD2L'
const OWNER_C = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const RELAYER_G = Keypair.random().publicKey()
const ZERO32 = new Uint8Array(32)

function agentsRetval(addrs) {
  return xdr.ScVal.scvVec(addrs.map((a) => Address.fromString(a).toScVal()))
}

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

const sampleBudgets = [{ budget: 100_000_000n, token: TOKEN }]
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

// Decode one invoke-host-function operation of a built tx into {contract, fn, args}.
function decodeInvokeOp(op) {
  const kind = op.func.switch().name
  expect(kind).toBe('hostFunctionTypeInvokeContract')
  const ic = op.func.invokeContract()
  return {
    contract: Address.fromScAddress(ic.contractAddress()).toString(),
    fn: ic.functionName().toString(),
    args: ic.args().map((a) => scValToNative(a)),
  }
}

beforeEach(() => vi.clearAllMocks())

describe('buildGrantTx exit-signer bundling', () => {
  it('stays a single grant op when exitSigners is absent (live path unchanged)', async () => {
    const server = fakeServer({ latest: 1000, retval: agentsRetval([AGENT_1, AGENT_2]) })
    const built = await buildGrantTx({
      owner: OWNER,
      budgets: sampleBudgets,
      durationSeconds: 3600,
      agentInits: sampleInits,
      server,
    })
    expect(built.tx.operations).toHaveLength(1)
    const op = decodeInvokeOp(built.tx.operations[0])
    expect(op.fn).toBe('grant')
    expect(built.agentAddresses).toEqual([AGENT_1, AGENT_2])
    expect(built.exitSignerCount).toBe(0)
  })

  it('appends one set_exit_signer op per agent into the SAME envelope (strkey keys)', async () => {
    const server = fakeServer({ latest: 1000, retval: agentsRetval([AGENT_1, AGENT_2]) })
    const key1 = Keypair.random()
    const key2 = Keypair.random()
    const built = await buildGrantTx({
      owner: OWNER,
      budgets: sampleBudgets,
      durationSeconds: 3600,
      agentInits: sampleInits,
      server,
      exitSigners: [key1.publicKey(), key2.publicKey()],
    })
    expect(built.tx.operations).toHaveLength(3)
    // Op 0 is still the grant itself.
    expect(decodeInvokeOp(built.tx.operations[0]).fn).toBe('grant')
    // Ops 1..N target the SIMULATED deployed addresses with the matching 32-byte key.
    const exit1 = decodeInvokeOp(built.tx.operations[1])
    expect(exit1.fn).toBe('set_exit_signer')
    expect(exit1.contract).toBe(AGENT_1)
    expect(Buffer.from(exit1.args[0])).toEqual(Buffer.from(key1.rawPublicKey()))
    const exit2 = decodeInvokeOp(built.tx.operations[2])
    expect(exit2.fn).toBe('set_exit_signer')
    expect(exit2.contract).toBe(AGENT_2)
    expect(Buffer.from(exit2.args[0])).toEqual(Buffer.from(key2.rawPublicKey()))
    expect(built.exitSignerCount).toBe(2)
  })

  it('accepts raw 32-byte keys and skips null slots (bridge agents)', async () => {
    const server = fakeServer({ latest: 1000, retval: agentsRetval([AGENT_1, AGENT_2]) })
    const raw = new Uint8Array(32).fill(7)
    const inits = [{ ...sampleInits[0] }, { ...sampleInits[1], kind: AGENT_KIND_BRIDGE }]
    const built = await buildGrantTx({
      owner: OWNER,
      budgets: sampleBudgets,
      durationSeconds: 3600,
      agentInits: inits,
      server,
      exitSigners: [raw, null],
    })
    expect(built.tx.operations).toHaveLength(2)
    const exit = decodeInvokeOp(built.tx.operations[1])
    expect(exit.fn).toBe('set_exit_signer')
    expect(exit.contract).toBe(AGENT_1)
    expect(Buffer.from(exit.args[0])).toEqual(Buffer.from(raw))
    expect(built.exitSignerCount).toBe(1)
  })

  it('an all-null exitSigners array keeps the single-op grant (no forced direct submit)', async () => {
    const server = fakeServer({ latest: 1000, retval: agentsRetval([AGENT_1]) })
    const built = await buildGrantTx({
      owner: OWNER,
      budgets: sampleBudgets,
      durationSeconds: 60,
      agentInits: [sampleInits[0]],
      server,
      exitSigners: [null],
    })
    expect(built.tx.operations).toHaveLength(1)
    expect(built.exitSignerCount).toBe(0)
  })

  it('a length mismatch throws before any network read', async () => {
    const getLatestLedger = vi.fn(async () => ({ sequence: 1000 }))
    const server = { ...fakeServer(), getLatestLedger }
    await expect(
      buildGrantTx({
        owner: OWNER,
        budgets: sampleBudgets,
        durationSeconds: 60,
        agentInits: sampleInits,
        server,
        exitSigners: [Keypair.random().publicKey()],
      })
    ).rejects.toThrow(/one slot per agent init/)
    expect(getLatestLedger).not.toHaveBeenCalled()
  })

  it('a malformed key throws a clear error', async () => {
    const server = fakeServer({ latest: 1000, retval: agentsRetval([AGENT_1]) })
    await expect(
      buildGrantTx({
        owner: OWNER,
        budgets: sampleBudgets,
        durationSeconds: 60,
        agentInits: [sampleInits[0]],
        server,
        exitSigners: ['NOT-A-KEY'],
      })
    ).rejects.toThrow(/valid ed25519 public key/)
  })
})

describe('submitGrant exit-signer bundling', () => {
  it('a bundled G grant signs once and submits DIRECT (never via the relay)', async () => {
    const server = fakeServer({ latest: 1000, retval: agentsRetval([AGENT_1]) })
    const sign = vi.fn(async (x) => `SIGNED:${x}`)
    const key = Keypair.random()
    const out = await submitGrant({
      owner: OWNER,
      budgets: sampleBudgets,
      durationSeconds: 60,
      agentInits: [sampleInits[0]],
      server,
      sign,
      exitSigners: [key.publicKey()],
    })
    expect(sign).toHaveBeenCalledTimes(1)
    expect(submitViaRelayMock).not.toHaveBeenCalled()
    expect(out).toMatchObject({
      hash: 'HDIRECT',
      status: 'SUCCESS',
      agentAddresses: [AGENT_1],
      exitSignersRegistered: true,
    })
  })

  it('an unbundled G grant still prefers the relay and reports no registration', async () => {
    const server = fakeServer({ latest: 1000, retval: agentsRetval([AGENT_1]) })
    submitViaRelayMock.mockResolvedValue({ hash: 'HREL', status: 'SUCCESS', relayer: 'GR' })
    const out = await submitGrant({
      owner: OWNER,
      budgets: sampleBudgets,
      durationSeconds: 60,
      agentInits: [sampleInits[0]],
      server,
      sign: async (x) => x,
    })
    expect(submitViaRelayMock).toHaveBeenCalledTimes(1)
    expect(out.exitSignersRegistered).toBe(false)
  })

  it('a C owner cannot bundle: throws before signing, grant untouched', async () => {
    const server = fakeServer({ latest: 1000, retval: agentsRetval([AGENT_1]) })
    getRelayerAddressMock.mockResolvedValue(RELAYER_G)
    await expect(
      submitGrant({
        owner: OWNER_C,
        budgets: sampleBudgets,
        durationSeconds: 60,
        agentInits: [sampleInits[0]],
        server,
        activeAccount: { kind: 'C', address: OWNER_C },
        exitSigners: [Keypair.random().publicKey()],
      })
    ).rejects.toThrow(/cannot be bundled/)
    expect(signOwnerAuthEntryMock).not.toHaveBeenCalled()
    expect(submitViaRelayMock).not.toHaveBeenCalled()
  })
})
