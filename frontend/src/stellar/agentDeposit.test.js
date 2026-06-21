// frontend/src/stellar/agentDeposit.test.js
import { describe, test, expect } from 'vitest'
import { xdr, Address, nativeToScVal } from '@stellar/stellar-sdk'
import { signAgentDepositEntries, readVaultShares } from './agentDeposit.js'
import { newSessionKey } from './sessionKey.js'

// Build a one-op invoke tx carrying a single agent-credentialed auth entry with an empty sig,
// so the test exercises the signing without a network. (Helper mirrors the real assembled shape.)
function fakeTxWithAgentEntry(env) {
  const { agentAddress, nonce } = env
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(
          'CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5',
        ).toScAddress(),
        functionName: 'deposit',
        args: [
          Address.fromString(agentAddress).toScVal(),
          nativeToScVal(50000000n, { type: 'i128' }),
        ],
      }),
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
      { server: fakeServer },
    )
    // Assert
    expect(shares).toBe(50000000n)
  })
})
