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
  test("redeems then transfers the agent's REAL post-redeem balance (never a pps estimate)", async () => {
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
    ).rejects.toThrow('There are no vault shares to exit.')
    expect(submitViaRelayMock).not.toHaveBeenCalled()
  })

  test('aborts before the transfer when the redeem relay reports a non-SUCCESS status', async () => {
    readVaultSharesMock.mockResolvedValue(10n)
    submitViaRelayMock.mockResolvedValueOnce({ hash: 'H', status: 'FAILED' })
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow('Redeem returned FAILED. Exit stopped.')
    expect(submitViaRelayMock).toHaveBeenCalledTimes(1)
    expect(readTokenBalanceMock).not.toHaveBeenCalled()
  })

  test('throws when the relay is unreachable for the redeem (submitViaRelay → null)', async () => {
    readVaultSharesMock.mockResolvedValue(10n)
    submitViaRelayMock.mockResolvedValueOnce(null)
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow('Redeem returned relay unreachable. Exit stopped.')
  })

  test('throws when the transfer leg fails, exposing the confirmed redeem hash', async () => {
    readVaultSharesMock.mockResolvedValue(10n)
    readTokenBalanceMock.mockResolvedValue(5n)
    submitViaRelayMock
      .mockResolvedValueOnce({ hash: 'REDEEMHASH', status: 'SUCCESS' })
      .mockResolvedValueOnce({ hash: 'T', status: 'FAILED' })
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow(
      'Transfer returned FAILED after redemption REDEEMHASH. Funds remain with the agent; retry the sweep.'
    )
  })

  test('throws on share-read RPC failure (null) without submitting anything', async () => {
    readVaultSharesMock.mockResolvedValue(null)
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow('The share balance could not be read. Exit stopped.')
    expect(submitViaRelayMock).not.toHaveBeenCalled()
  })

  test('throws on balance-read RPC failure after a confirmed redeem (no blind transfer)', async () => {
    readVaultSharesMock.mockResolvedValue(10n)
    readTokenBalanceMock.mockResolvedValue(null)
    submitViaRelayMock.mockResolvedValueOnce({ hash: 'REDEEMHASH', status: 'SUCCESS' })
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow(
      'The token balance could not be read after redemption (transaction REDEEMHASH). Retry the sweep.'
    )
    expect(submitViaRelayMock).toHaveBeenCalledTimes(1) // redeem only — never a guessed transfer
  })

  test('throws when no exit key is authorized for the agent', async () => {
    loadExitKeyMock.mockReturnValue(null)
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow('No exit key is authorized for this agent.')
  })

  test('throws when no relayer is configured', async () => {
    readVaultSharesMock.mockResolvedValue(10n)
    getRelayerAddressMock.mockResolvedValue(null)
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow('The relayer is not configured.')
  })

  test('rejects a concurrent second run for the same agent (in-flight lock)', async () => {
    // Arrange: park the first run inside the redeem submit
    readVaultSharesMock.mockResolvedValue(10n)
    readTokenBalanceMock.mockResolvedValue(5n)
    let releaseSubmit
    submitViaRelayMock.mockImplementationOnce(
      () => new Promise((res) => (releaseSubmit = () => res({ hash: 'H', status: 'SUCCESS' })))
    )
    const first = runAutonomousExit({
      agentAddress: AGENT,
      ownerAddress: OWNER,
      server: fakeServer,
    })
    await vi.waitFor(() => expect(submitViaRelayMock).toHaveBeenCalled())
    // Act + Assert: second run for the SAME agent rejects immediately
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow('already in flight')
    // Release; first run completes and the lock clears for a fresh run
    releaseSubmit()
    await first
    readVaultSharesMock.mockResolvedValue(0n)
    readTokenBalanceMock.mockResolvedValue(0n)
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow('There are no vault shares to exit.') // lock released — normal path error, not "in flight"
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

// ── cross-tab lock: localStorage layered on top of the in-memory Set ──────────
function stubLocalStorage() {
  const store = {}
  vi.stubGlobal('localStorage', {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v)
    },
    removeItem: (k) => {
      delete store[k]
    },
  })
  return store
}

const LOCK_KEY = `vf_exit_inflight_${AGENT}`

describe('runAutonomousExit - cross-tab lock (localStorage)', () => {
  beforeEach(() => {
    stubLocalStorage()
  })

  test('rejects a call while another tab holds a fresh (non-expired) lock', async () => {
    // Arrange: simulate another tab's lock — this tab's in-memory Set is empty
    localStorage.setItem(LOCK_KEY, String(Date.now()))
    readVaultSharesMock.mockResolvedValue(10n)
    // Act + Assert
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow('already in flight')
    expect(submitViaRelayMock).not.toHaveBeenCalled()
  })

  test('an expired lock is treated as free and replaced, letting the exit proceed', async () => {
    // Arrange: a lock older than the TTL — e.g. left by a crashed tab
    localStorage.setItem(LOCK_KEY, String(Date.now() - 130_000))
    readVaultSharesMock.mockResolvedValue(0n)
    readTokenBalanceMock.mockResolvedValue(0n)
    // Act + Assert: reaches the normal no-op error, not the lock rejection
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow('There are no vault shares to exit.')
  })

  test('clears the lock after a successful exit', async () => {
    readVaultSharesMock.mockResolvedValue(10n)
    readTokenBalanceMock.mockResolvedValue(5n)
    await runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    expect(localStorage.getItem(LOCK_KEY)).toBeNull()
  })

  test('clears the lock after a failed exit', async () => {
    loadExitKeyMock.mockReturnValue(null)
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow('No exit key is authorized for this agent.')
    expect(localStorage.getItem(LOCK_KEY)).toBeNull()
  })

  test('degrades to the in-memory guard alone when localStorage throws (non-browser env)', async () => {
    // Arrange: no Storage in this environment — every access throws
    vi.stubGlobal('localStorage', undefined)
    readVaultSharesMock.mockResolvedValue(10n)
    readTokenBalanceMock.mockResolvedValue(5n)
    let releaseSubmit
    submitViaRelayMock.mockImplementationOnce(
      () => new Promise((res) => (releaseSubmit = () => res({ hash: 'H', status: 'SUCCESS' })))
    )
    // Act: first run parks mid-flight; concurrent second run still rejects via the Set alone
    const first = runAutonomousExit({
      agentAddress: AGENT,
      ownerAddress: OWNER,
      server: fakeServer,
    })
    await vi.waitFor(() => expect(submitViaRelayMock).toHaveBeenCalled())
    await expect(
      runAutonomousExit({ agentAddress: AGENT, ownerAddress: OWNER, server: fakeServer })
    ).rejects.toThrow('already in flight')
    // Assert: releasing lets the first run finish cleanly despite the missing localStorage
    releaseSubmit()
    const out = await first
    expect(out.status).toBe('SUCCESS')
  })
})
