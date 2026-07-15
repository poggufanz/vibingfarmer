import { describe, it, expect } from 'vitest'
import {
  Account,
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import {
  NETWORK_PASSPHRASE,
  SOROBAN_AUTOFARM_VAULT_ADDRESS,
  SOROBAN_DEMO_AGENT,
} from '../src/stellar/config.js'
import { summarizeTransaction, summarizeAuthEntry, shortAddr, formatArg } from './txSummary.js'

function buildDepositTxXdr() {
  const source = new Account(Keypair.random().publicKey(), '0')
  const contract = new Contract(SOROBAN_AUTOFARM_VAULT_ADDRESS)
  return new TransactionBuilder(source, { fee: '100', networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      contract.call(
        'deposit',
        new Address(SOROBAN_DEMO_AGENT).toScVal(),
        nativeToScVal(5000000n, { type: 'i128' })
      )
    )
    .setTimeout(300)
    .build()
    .toXDR()
}

function buildAuthEntryXdr() {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(SOROBAN_DEMO_AGENT).toScAddress(),
        nonce: xdr.Int64.fromString('0'),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(SOROBAN_AUTOFARM_VAULT_ADDRESS).toScAddress(),
          functionName: 'deposit',
          args: [
            new Address(SOROBAN_DEMO_AGENT).toScVal(),
            nativeToScVal(5000000n, { type: 'i128' }),
          ],
        })
      ),
      subInvocations: [],
    }),
  }).toXDR('base64')
}

describe('txSummary', () => {
  it('decodes an invokeContract transaction into contract/fn/args', () => {
    const s = summarizeTransaction(buildDepositTxXdr())
    expect(s.network).toBe('TESTNET')
    expect(s.contract).toBe(SOROBAN_AUTOFARM_VAULT_ADDRESS)
    expect(s.contractLabel).toBe('autofarm vault')
    expect(s.fn).toBe('deposit')
    expect(s.args).toHaveLength(2)
    expect(s.args[0]).toBe(shortAddr(SOROBAN_DEMO_AGENT))
    expect(s.args[1]).toBe('5000000 (0.5)')
  })

  it('decodes a Soroban auth entry including the required signer', () => {
    const s = summarizeAuthEntry(buildAuthEntryXdr())
    expect(s.contract).toBe(SOROBAN_AUTOFARM_VAULT_ADDRESS)
    expect(s.contractLabel).toBe('autofarm vault')
    expect(s.fn).toBe('deposit')
    expect(s.signer).toBe(SOROBAN_DEMO_AGENT)
    expect(s.args).toHaveLength(2)
  })

  it('returns null on undecodable input instead of throwing', () => {
    expect(summarizeTransaction('definitely-not-xdr')).toBeNull()
    expect(summarizeAuthEntry('definitely-not-xdr')).toBeNull()
    expect(summarizeTransaction('')).toBeNull()
  })

  it('shortAddr truncates strkeys and leaves short strings alone', () => {
    expect(shortAddr(SOROBAN_DEMO_AGENT)).toBe(
      `${SOROBAN_DEMO_AGENT.slice(0, 4)}…${SOROBAN_DEMO_AGENT.slice(-4)}`
    )
    expect(shortAddr('abc')).toBe('abc')
    expect(shortAddr(null)).toBe('')
  })

  it('formatArg renders bigints with a 7dp hint and truncates strkeys', () => {
    expect(formatArg(5000000n)).toBe('5000000 (0.5)')
    expect(formatArg(SOROBAN_DEMO_AGENT)).toBe(shortAddr(SOROBAN_DEMO_AGENT))
    expect(formatArg('hello')).toBe('hello')
    expect(formatArg(true)).toBe('true')
  })
})
