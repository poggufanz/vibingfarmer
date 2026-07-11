import { describe, test, expect, vi } from 'vitest'
import { xdr, Address, nativeToScVal } from '@stellar/stellar-sdk'
import { signTransactionForContract, signAuthEntryString } from './signGeneric.js'

// Mirrors stellar/agentDeposit.test.js's fakeTxWithAgentEntry — builds a real
// xdr.SorobanAuthorizationEntry credentialed to `contractId`.
function fakeEntryFor(contractId) {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(
          'CBZNITAPHCLSPEXC3UKIERYRUJR56GISM2G2Z5XD6KZH3U4ZZ76XNQOU'
        ).toScAddress(),
        functionName: 'deposit',
        args: [Address.fromString(contractId).toScVal(), nativeToScVal(1000000n, { type: 'i128' })],
      })
    ),
    subInvocations: [],
  })
  const creds = new xdr.SorobanAddressCredentials({
    address: Address.fromString(contractId).toScAddress(),
    nonce: xdr.Int64.fromString('1'),
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  })
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(creds),
    rootInvocation: invocation,
  })
}

// Minimal stand-in tx: only what signTransactionForContract reads (operations[].auth +
// re-serialize) — same discipline as agentDeposit.test.js's fake.
function fakeTx(entries) {
  return {
    operations: [{ auth: entries }],
    toEnvelope: () => ({ toXDR: () => 'deadbeef' }),
  }
}

describe('signTransactionForContract', () => {
  test('signs only the auth entry credentialed to contractId, leaves others untouched', async () => {
    const ours = fakeEntryFor('CBZNITAPHCLSPEXC3UKIERYRUJR56GISM2G2Z5XD6KZH3U4ZZ76XNQOU')
    const other = fakeEntryFor('CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU')
    const tx = fakeTx([other, ours])
    const kit = { signAuthEntry: vi.fn(async (e) => ({ signed: true, of: e })) }

    await signTransactionForContract({
      tx,
      contractId: 'CBZNITAPHCLSPEXC3UKIERYRUJR56GISM2G2Z5XD6KZH3U4ZZ76XNQOU',
      kit,
    })

    expect(kit.signAuthEntry).toHaveBeenCalledTimes(1)
    expect(kit.signAuthEntry).toHaveBeenCalledWith(ours)
    expect(tx.operations[0].auth[0]).toBe(other) // the other account's entry stays untouched
    expect(tx.operations[0].auth[1]).toEqual({ signed: true, of: ours }) // ours got replaced
  })

  test('throws when the transaction has no auth entry for our contractId (fail closed)', async () => {
    const tx = fakeTx([fakeEntryFor('CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU')])
    const kit = { signAuthEntry: vi.fn() }
    await expect(
      signTransactionForContract({
        tx,
        contractId: 'CBZNITAPHCLSPEXC3UKIERYRUJR56GISM2G2Z5XD6KZH3U4ZZ76XNQOU',
        kit,
      })
    ).rejects.toThrow(/no auth entry/i)
    expect(kit.signAuthEntry).not.toHaveBeenCalled()
  })

  test('returns the re-serialized envelope XDR after signing', async () => {
    const tx = fakeTx([fakeEntryFor('CBZNITAPHCLSPEXC3UKIERYRUJR56GISM2G2Z5XD6KZH3U4ZZ76XNQOU')])
    const kit = { signAuthEntry: vi.fn(async () => 'SIGNED') }
    const out = await signTransactionForContract({
      tx,
      contractId: 'CBZNITAPHCLSPEXC3UKIERYRUJR56GISM2G2Z5XD6KZH3U4ZZ76XNQOU',
      kit,
    })
    expect(out).toBe('deadbeef')
  })
})

describe('signAuthEntryString', () => {
  test('decodes the base64 entry, signs via kit.signAuthEntry, re-encodes to base64', async () => {
    const entry = fakeEntryFor('CBZNITAPHCLSPEXC3UKIERYRUJR56GISM2G2Z5XD6KZH3U4ZZ76XNQOU')
    const b64 = entry.toXDR('base64')
    const kit = { signAuthEntry: vi.fn(async (e) => e) } // pass-through signer stand-in

    const out = await signAuthEntryString({ authEntry: b64, kit })

    expect(kit.signAuthEntry).toHaveBeenCalledOnce()
    expect(out).toBe(b64) // round-trips back to an equivalent entry
  })
})
