// frontend/src/stellar/agentDeposit.test.js
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { xdr, Address, Account, nativeToScVal } from '@stellar/stellar-sdk'
import { signAgentDepositEntries, readVaultShares, runAgentDeposit } from './agentDeposit.js'
import { newSessionKey } from './sessionKey.js'
import { classifyActiveAccount } from './activeAccount.js'
import { NETWORK_PASSPHRASE } from './config.js'

// Task 6 chunk C1 — runAgentDeposit's indeterminate-outcome path (mirrors runAgentPull's own
// activeAccountSubmissionUnknown handling, grant.js:844-891/876-889). Relay is the only network
// dependency this reaches through; mock it so the test runs offline, same pattern grant.test.js
// uses for runAgentPull.
const submitViaRelayMock = vi.fn()
const getRelayerAddressMock = vi.fn()
vi.mock('./relay.js', () => ({
  submitViaRelay: (...a) => submitViaRelayMock(...a),
  getRelayerAddress: (...a) => getRelayerAddressMock(...a),
}))

// Build a one-op invoke tx carrying a single agent-credentialed auth entry with an empty sig,
// so the test exercises the signing without a network. (Helper mirrors the real assembled shape.)
function fakeTxWithAgentEntry(env) {
  const { agentAddress, nonce } = env
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(
          'CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5'
        ).toScAddress(),
        functionName: 'deposit',
        args: [
          Address.fromString(agentAddress).toScVal(),
          nativeToScVal(50000000n, { type: 'i128' }),
        ],
      })
    ),
    subInvocations: [],
  })
  const creds = new xdr.SorobanAddressCredentials({
    address: Address.fromString(agentAddress).toScAddress(),
    nonce: xdr.Int64.fromString(String(nonce)),
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  })
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(creds),
    rootInvocation: invocation,
  })
  // Minimal stand-in tx: only what signAgentDepositEntries reads (operations[0].auth + re-serialize).
  return {
    operations: [{ auth: [entry] }],
    toEnvelope: () => ({ toXDR: () => Buffer.from('deadbeef') }),
  }
}

describe('signAgentDepositEntries', () => {
  test('signs the agent entry, sets a 64-byte BytesN signature and the expiration ledger', async () => {
    // Arrange
    const sessionKey = newSessionKey()
    const agentAddress = Address.contract(sessionKey.rawPublicKey).toString() // any C-address stand-in
    const tx = fakeTxWithAgentEntry({ agentAddress, nonce: 12345 })
    // Act
    await signAgentDepositEntries({
      tx,
      sessionKey,
      validUntilLedger: 99999,
      agentAddress,
      server: null,
    })
    // Assert: the entry now carries a 64-byte scvBytes signature and the bumped expiration ledger.
    const creds = tx.operations[0].auth[0].credentials().address()
    expect(creds.signatureExpirationLedger()).toBe(99999)
    const sig = creds.signature()
    expect(sig.switch().name).toBe('scvBytes')
    expect(sig.bytes().length).toBe(64)
  })
})

describe('signAgentDepositEntries with sigTag', () => {
  test('prefixes the tag byte: 65-byte scvBytes starting with 0x01', async () => {
    const sessionKey = newSessionKey()
    const agentAddress = Address.contract(sessionKey.rawPublicKey).toString()
    const tx = fakeTxWithAgentEntry({ agentAddress, nonce: 777 })
    await signAgentDepositEntries({
      tx,
      sessionKey,
      validUntilLedger: 12345,
      agentAddress,
      sigTag: 1,
    })
    const sig = tx.operations[0].auth[0].credentials().address().signature()
    expect(sig.switch().name).toBe('scvBytes')
    expect(sig.bytes().length).toBe(65)
    expect(sig.bytes()[0]).toBe(1)
  })
})

describe('balance reads', () => {
  test('readVaultShares returns the decoded i128 via an injected server', async () => {
    // Arrange: a fake server whose simulate returns an i128 ScVal of 50_000_000.
    const fakeServer = {
      simulateTransaction: async () => ({
        result: { retval: nativeToScVal(50000000n, { type: 'i128' }) },
      }),
    }
    // Act
    const shares = await readVaultShares(
      'CCRG37UTQ2BRCJSA3WYZIUTSGZVLYQ7C4EET2WYUWLU4NAWTETGB77JW',
      { server: fakeServer }
    )
    // Assert
    expect(shares).toBe(50000000n)
  })
})

// Task 6 chunk C1 — real testnet-shaped addresses (valid strkeys — the SDK validates them on
// encode), same convention grant.test.js uses.
const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const RELAYER_G = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ'

// A fake Soroban RPC server: no network. `prepareTransaction` echoes the raw (unassembled) tx --
// runAgentDeposit's chain (buildAgentDeposit -> buildAgentAuthedInvoke -> buildInvokeTx) never
// reads `simulateTransaction` at all (unlike buildGrantTx), so this fake needs nothing more.
function fakeServer({ latest = 1000 } = {}) {
  return {
    getAccount: async (addr) => new Account(addr, '5'),
    getLatestLedger: async () => ({ sequence: latest }),
    prepareTransaction: async (tx) => tx,
  }
}

describe('runAgentDeposit', () => {
  beforeEach(() => {
    submitViaRelayMock.mockReset()
    getRelayerAddressMock.mockReset()
  })

  test('returns null when the relay is unconfigured (no relayer address)', async () => {
    getRelayerAddressMock.mockResolvedValue(null)
    const sessionKey = newSessionKey()
    const agentAddress = Address.contract(sessionKey.rawPublicKey).toString()
    const res = await runAgentDeposit({
      agentAddress,
      amount: 50_000_000n,
      sessionKey,
      server: fakeServer(),
    })
    expect(res).toBeNull()
    expect(submitViaRelayMock).not.toHaveBeenCalled()
  })

  // Mirrors grant.test.js's "classifies an account change after relay dispatch as
  // submission-unknown" for runAgentPull -- runAgentDeposit had NO equivalent path before this
  // chunk (map-task6-refreshed.md section 2, agentDeposit.js:61 old-map correction).
  test('classifies an account change after relay dispatch as submission-unknown', async () => {
    const server = fakeServer()
    const captured = classifyActiveAccount({
      address: OWNER,
      networkPassphrase: NETWORK_PASSPHRASE,
      connectorId: 'freighter',
      epoch: 41,
    })
    let current = captured
    getRelayerAddressMock.mockResolvedValue(RELAYER_G)
    submitViaRelayMock.mockImplementation(async () => {
      current = Object.freeze({ ...captured, epoch: 42 })
      return { hash: 'HDEP', status: 'SUCCESS' }
    })
    const sessionKey = newSessionKey()
    const agentAddress = Address.contract(sessionKey.rawPublicKey).toString()

    await expect(
      runAgentDeposit({
        agentAddress,
        amount: 50_000_000n,
        sessionKey,
        server,
        activeAccount: captured,
        getCurrentActiveAccount: () => current,
      })
    ).rejects.toMatchObject({
      code: 'VF_SUBMISSION_UNKNOWN',
      submission: 'unknown',
      result: { hash: 'HDEP', status: 'SUCCESS' },
    })
  })

  test('a clean relay rejection is not reclassified as submission-unknown when the account never changed', async () => {
    const server = fakeServer()
    const captured = classifyActiveAccount({
      address: OWNER,
      networkPassphrase: NETWORK_PASSPHRASE,
      connectorId: 'freighter',
      epoch: 1,
    })
    getRelayerAddressMock.mockResolvedValue(RELAYER_G)
    submitViaRelayMock.mockRejectedValue(new Error('The Stellar relay refused this transaction'))
    const sessionKey = newSessionKey()
    const agentAddress = Address.contract(sessionKey.rawPublicKey).toString()

    await expect(
      runAgentDeposit({
        agentAddress,
        amount: 50_000_000n,
        sessionKey,
        server,
        activeAccount: captured,
        getCurrentActiveAccount: () => captured,
      })
    ).rejects.toMatchObject({ message: 'The Stellar relay refused this transaction' })
  })
})
