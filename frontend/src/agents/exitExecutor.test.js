// frontend/src/agents/exitExecutor.test.js
import { describe, test, expect, vi, beforeEach } from 'vitest'
import {
  xdr,
  Address,
  nativeToScVal,
  Account,
  Contract,
  Keypair,
  TransactionBuilder,
} from '@stellar/stellar-sdk'

// ── module-boundary mocks ─────────────────────────────────────────────────────
const buildInvokeTxMock = vi.fn()
vi.mock('../stellar/client.js', () => ({
  rpcServer: vi.fn(async () => {
    throw new Error('tests must inject a server')
  }),
  buildInvokeTx: (...a) => buildInvokeTxMock(...a),
}))

const readVaultSharesMock = vi.fn()
const readTokenBalanceMock = vi.fn()
vi.mock('../stellar/agentDeposit.js', () => ({
  readVaultShares: (...a) => readVaultSharesMock(...a),
  readTokenBalance: (...a) => readTokenBalanceMock(...a),
}))

const getRelayerAddressMock = vi.fn()
const submitViaRelayMock = vi.fn()
vi.mock('../stellar/relay.js', () => ({
  getRelayerAddress: (...a) => getRelayerAddressMock(...a),
  submitViaRelay: (...a) => submitViaRelayMock(...a),
}))

const loadExitKeyMock = vi.fn()
vi.mock('../wallet/exitKey.js', () => ({
  loadExitKey: (...a) => loadExitKeyMock(...a),
}))

const { signAgentExitEntries, runAutonomousExit } = await import('./exitExecutor.js')
const { NETWORK_PASSPHRASE } = await import('../stellar/config.js')

// ── fixtures ──────────────────────────────────────────────────────────────────
const EXIT_KP = Keypair.random()
const AGENT = Address.contract(Buffer.alloc(32, 7)).toString()
const OWNER = Keypair.random().publicKey()
const RELAYER = Keypair.random().publicKey()
const VAULT_C = 'CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5'

// A REAL single-op invoke tx (no network) so signAgentExitEntries / fromXDR /
// prepareTransaction all operate on genuine SDK objects.
function realInvokeTx() {
  const source = new Account(RELAYER, '0')
  return new TransactionBuilder(source, { fee: '100', networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      new Contract(VAULT_C).call(
        'redeem',
        Address.fromString(AGENT).toScVal(),
        nativeToScVal(1n, { type: 'i128' })
      )
    )
    .setTimeout(60)
    .build()
}

const fakeServer = {
  getLatestLedger: async () => ({ sequence: 100 }),
  prepareTransaction: async (tx) => tx,
}

beforeEach(() => {
  vi.clearAllMocks()
  loadExitKeyMock.mockReturnValue({ secret: EXIT_KP.secret() })
  getRelayerAddressMock.mockResolvedValue(RELAYER)
  buildInvokeTxMock.mockImplementation(async () => ({ tx: realInvokeTx() }))
  submitViaRelayMock.mockResolvedValue({ hash: 'TXHASH', status: 'SUCCESS', relayer: RELAYER })
})

// ── signAgentExitEntries: tag-1 signature shape (mirrors agentDeposit test) ───
function fakeTxWithAgentEntry(agentAddress) {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(VAULT_C).toScAddress(),
        functionName: 'redeem',
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
    nonce: xdr.Int64.fromString('12345'),
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  })
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(creds),
    rootInvocation: invocation,
  })
  return {
    operations: [{ auth: [entry] }],
    toEnvelope: () => ({ toXDR: () => 'unused' }),
  }
}

describe('signAgentExitEntries', () => {
  test('signs the agent entry with a 65-byte tag-1 signature and bumps the expiration ledger', async () => {
    // Arrange
    const tx = fakeTxWithAgentEntry(AGENT)
    // Act
    await signAgentExitEntries({
      tx,
      exitKeypair: EXIT_KP,
      validUntilLedger: 99999,
      agentAddress: AGENT,
    })
    // Assert
    const creds = tx.operations[0].auth[0].credentials().address()
    expect(creds.signatureExpirationLedger()).toBe(99999)
    const sig = creds.signature()
    expect(sig.switch().name).toBe('scvBytes')
    expect(sig.bytes().length).toBe(65)
    expect(sig.bytes()[0]).toBe(1) // exit-signer tag
  })

  test('leaves entries credentialed to other addresses untouched', async () => {
    // Arrange
    const otherAgent = Address.contract(Buffer.alloc(32, 9)).toString()
    const tx = fakeTxWithAgentEntry(otherAgent)
    // Act
    await signAgentExitEntries({
      tx,
      exitKeypair: EXIT_KP,
      validUntilLedger: 99999,
      agentAddress: AGENT,
    })
    // Assert: signature still void, ledger untouched
    const creds = tx.operations[0].auth[0].credentials().address()
    expect(creds.signature().switch().name).toBe('scvVoid')
    expect(creds.signatureExpirationLedger()).toBe(0)
  })
})

// ── runAutonomousExit: two sequential single-op txs, balance-sized transfer ───
describe('runAutonomousExit', () => {
  test('redeems then transfers the agent\'s REAL post-redeem balance (never a pps estimate)', async () => {
    // Arrange: 30 shares; post-redeem balance deliberately UNRELATED to shares so any
    // pps-style sizing (shares × price) would produce a different number.
    readVaultSharesMock.mockResolvedValue(30_030_030n)
    readTokenBalanceMock.mockResolvedValue(29_999_996n)
    submitViaRelayMock
      .mockResolvedValueOnce({ hash: 'REDEEMHASH', status: 'SUCCESS' })
      .mockResolvedValueOnce({ hash: 'TRANSFERHASH', status: 'SUCCESS' })
    // Act
    const out = await runAutonomousExit({
      agentAddress: AGENT,
      ownerAddress: OWNER,
      server: fakeServer,
    })
    // Assert: two separate single-op builds — redeem first, then transfer
    expect(buildInvokeTxMock).toHaveBeenCalledTimes(2)
    const [redeemCall, transferCall] = buildInvokeTxMock.mock.calls
    expect(redeemCall[0].method).toBe('redeem')
    expect(redeemCall[0].args).toEqual([{ addr: AGENT }, { i128: 30_030_030n }])
    expect(transferCall[0].method).toBe('transfer')
    expect(transferCall[0].args).toEqual([
      { addr: AGENT },
      { addr: OWNER },
      { i128: 29_999_996n }, // exact balance read — not shares×pps
    ])
    expect(submitViaRelayMock).toHaveBeenCalledTimes(2)
    expect(out).toEqual({ hash: 'TRANSFERHASH', status: 'SUCCESS', redeemHash: 'REDEEMHASH' })
  })

  test('reads the balance only AFTER the redeem is confirmed', async () => {
    // Arrange
    const order = []
    readVaultSharesMock.mockResolvedValue(10n)
    submitViaRelayMock.mockImplementation(async () => {
      order.push('submit')
      return { hash: 'H', status: 'SUCCESS' }
    })
    readTokenBalanceMock.mockImplementation(async () => {
      order.push('balance')
      return 5n
    })
    // Act
    await runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    // Assert: redeem submit precedes the balance read that sizes the transfer
    expect(order).toEqual(['submit', 'balance', 'submit'])
  })

  test('skips redeem and sweeps a stranded balance when shares are already 0 (self-heal)', async () => {
    // Arrange: a previous run redeemed but its transfer leg failed
    readVaultSharesMock.mockResolvedValue(0n)
    readTokenBalanceMock.mockResolvedValue(1_234n)
    // Act
    const out = await runAutonomousExit({
      agentAddress: AGENT,
      ownerAddress: OWNER,
      server: fakeServer,
    })
    // Assert: one tx only — the sweep
    expect(buildInvokeTxMock).toHaveBeenCalledTimes(1)
    expect(buildInvokeTxMock.mock.calls[0][0].method).toBe('transfer')
    expect(buildInvokeTxMock.mock.calls[0][0].args[2]).toEqual({ i128: 1_234n })
    expect(out.redeemHash).toBe(null)
  })

  test('throws "No vault shares to exit" when there are no shares and no balance', async () => {
    readVaultSharesMock.mockResolvedValue(0n)
    readTokenBalanceMock.mockResolvedValue(0n)
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow('No vault shares to exit')
    expect(submitViaRelayMock).not.toHaveBeenCalled()
  })

  test('aborts before the transfer when the redeem relay reports a non-SUCCESS status', async () => {
    readVaultSharesMock.mockResolvedValue(10n)
    submitViaRelayMock.mockResolvedValueOnce({ hash: 'H', status: 'FAILED' })
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow(/redeem.*FAILED/)
    expect(submitViaRelayMock).toHaveBeenCalledTimes(1)
    expect(readTokenBalanceMock).not.toHaveBeenCalled()
  })

  test('throws when the relay is unreachable for the redeem (submitViaRelay → null)', async () => {
    readVaultSharesMock.mockResolvedValue(10n)
    submitViaRelayMock.mockResolvedValueOnce(null)
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow(/redeem/)
  })

  test('throws when the transfer leg fails, exposing the confirmed redeem hash', async () => {
    readVaultSharesMock.mockResolvedValue(10n)
    readTokenBalanceMock.mockResolvedValue(5n)
    submitViaRelayMock
      .mockResolvedValueOnce({ hash: 'REDEEMHASH', status: 'SUCCESS' })
      .mockResolvedValueOnce({ hash: 'T', status: 'FAILED' })
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow(/transfer.*FAILED.*REDEEMHASH/)
  })

  test('throws on share-read RPC failure (null) without submitting anything', async () => {
    readVaultSharesMock.mockResolvedValue(null)
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow(/share balance read failed/)
    expect(submitViaRelayMock).not.toHaveBeenCalled()
  })

  test('throws on balance-read RPC failure after a confirmed redeem (no blind transfer)', async () => {
    readVaultSharesMock.mockResolvedValue(10n)
    readTokenBalanceMock.mockResolvedValue(null)
    submitViaRelayMock.mockResolvedValueOnce({ hash: 'REDEEMHASH', status: 'SUCCESS' })
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow(/balance read failed/)
    expect(submitViaRelayMock).toHaveBeenCalledTimes(1) // redeem only — never a guessed transfer
  })

  test('throws when no exit key is authorized for the agent', async () => {
    loadExitKeyMock.mockReturnValue(null)
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow('No exit key authorized')
  })

  test('throws when no relayer is configured', async () => {
    readVaultSharesMock.mockResolvedValue(10n)
    getRelayerAddressMock.mockResolvedValue(null)
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow('No relayer configured')
  })

  test('re-prepares each signed tx before submit (footprint refresh for __check_auth)', async () => {
    // Arrange
    readVaultSharesMock.mockResolvedValue(10n)
    readTokenBalanceMock.mockResolvedValue(5n)
    const prepareSpy = vi.fn(async (tx) => tx)
    // Act
    await runAutonomousExit({
      agentAddress: AGENT,
      ownerAddress: OWNER,
      server: { ...fakeServer, prepareTransaction: prepareSpy },
    })
    // Assert: one re-prepare per leg (buildInvokeTx is mocked, so its internal prepare
    // doesn't count — every prepare seen here is the post-signing one).
    expect(prepareSpy).toHaveBeenCalledTimes(2)
  })
})
