import { describe, it, expect } from 'vitest'
import {
  Account,
  Address,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import {
  NETWORK_PASSPHRASE,
  SOROBAN_AUTOFARM_VAULT_ADDRESS,
  SOROBAN_DEMO_AGENT,
  SOROBAN_EXIT_ROUTER_ADDRESS,
  SOROBAN_FUNDING_ROUTER_ADDRESS,
  SOROBAN_TOKEN_ADDRESS,
} from '../src/stellar/config.js'
import { agentInitScVal, tokenBudgetScVal, AGENT_KIND_DEPOSIT } from '../src/stellar/grant.js'
import { addrScVal, u32ScVal } from '../src/stellar/scval.js'
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

function buildExitTx({
  fn = 'owner_withdraw',
  owner,
  source = owner,
  recipient = owner,
  addressCredentials = false,
  signWith = null,
} = {}) {
  const contract = fn === 'sweep' ? SOROBAN_EXIT_ROUTER_ADDRESS : SOROBAN_DEMO_AGENT
  const args =
    fn === 'sweep'
      ? [
          new Address(owner).toScVal(),
          xdr.ScVal.scvVec([new Address(SOROBAN_DEMO_AGENT).toScVal()]),
          new Address(recipient).toScVal(),
        ]
      : [new Address(recipient).toScVal()]
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contract).toScAddress(),
        functionName: fn,
        args,
      })
    ),
    subInvocations: [],
  })
  const credentials = addressCredentials
    ? xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(owner).toScAddress(),
          nonce: xdr.Int64.fromString('7'),
          signatureExpirationLedger: 500,
          signature: xdr.ScVal.scvBytes(Buffer.alloc(64, 3)),
        })
      )
    : xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
  const call = new Contract(contract).call(fn, ...args)
  const tx = new TransactionBuilder(new Account(source, '0'), {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: call.body().invokeHostFunctionOp().hostFunction(),
        auth: [new xdr.SorobanAuthorizationEntry({ credentials, rootInvocation: invocation })],
      })
    )
    .setTimeout(300)
    .build()
  if (signWith) tx.sign(signWith)
  return tx.toXDR()
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

  it('binds consent to exact body/auth digests and full owner/network/function/token/recipient facts', () => {
    const ownerKey = Keypair.random()
    const owner = ownerKey.publicKey()
    const summary = summarizeTransaction(buildExitTx({ owner, signWith: ownerKey }))
    expect(summary).toMatchObject({
      owner,
      networkPassphrase: NETWORK_PASSPHRASE,
      fn: 'owner_withdraw',
      token: SOROBAN_TOKEN_ADDRESS,
      recipient: owner,
      allFunds: true,
    })
    expect(summary.bodyDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(summary.authDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(summary.consentDigest).toMatch(/^[a-f0-9]{64}$/)

    const authSummary = summarizeAuthEntry(buildAuthEntryXdr())
    expect(authSummary.authDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(authSummary.consentDigest).toBe(authSummary.authDigest)
  })

  it.each([
    ['sponsored G owner', Keypair.random().publicKey()],
    ['sponsored C owner', Address.contract(Buffer.alloc(32, 11)).toString()],
  ])(
    'derives %s from the address authorizer rather than the relayer transaction source',
    (_label, owner) => {
      const relayer = Keypair.random().publicKey()
      const summary = summarizeTransaction(
        buildExitTx({ owner, source: relayer, addressCredentials: true })
      )
      expect(summary.owner).toBe(owner)
      expect(summary.owner).not.toBe(relayer)
      expect(summary.recipient).toBe(owner)
      expect(summary.token).toBe(SOROBAN_TOKEN_ADDRESS)
      expect(summary.allFunds).toBe(true)
    }
  )

  it('summarizes sweep with the canonical token and exact owner/recipient/all-funds consequence', () => {
    const ownerKey = Keypair.random()
    const owner = ownerKey.publicKey()
    const summary = summarizeTransaction(buildExitTx({ fn: 'sweep', owner, signWith: ownerKey }))
    expect(summary).toMatchObject({
      owner,
      fn: 'sweep',
      token: SOROBAN_TOKEN_ADDRESS,
      recipient: owner,
      allFunds: true,
    })
    expect(summary.authorizationDigests).toHaveLength(1)
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

// A funding_router.grant transaction is the ONE thing this popup exists to make truthful — it
// must decode into a real FundingGrantSummaryV1 (grant.kind === 'funding-router-grant'), never
// just fall back to a generic arg dump. Everything else (a non-router tx) must see grant: null.
describe('txSummary — funding_router.grant decoding', () => {
  function buildGrantTxXdr(owner) {
    const source = new Account(owner, '0')
    return new TransactionBuilder(source, { fee: '100', networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(
        new Contract(SOROBAN_FUNDING_ROUTER_ADDRESS).call(
          'grant',
          addrScVal(owner),
          xdr.ScVal.scvVec([
            tokenBudgetScVal({ budget: 5_000_000n, token: SOROBAN_TOKEN_ADDRESS }),
          ]),
          u32ScVal(1_000_000),
          xdr.ScVal.scvVec([
            agentInitScVal({
              signer: Buffer.alloc(32, 1),
              salt: Buffer.alloc(32, 2),
              cap: 1_000_000n,
              token: SOROBAN_TOKEN_ADDRESS,
              target: SOROBAN_AUTOFARM_VAULT_ADDRESS,
              kind: AGENT_KIND_DEPOSIT,
              mintRecipient: new Uint8Array(32),
              destinationDomain: 0,
              periodDuration: 86400,
              expiry: 2_000_000,
            }),
          ])
        )
      )
      .setTimeout(300)
      .build()
      .toXDR()
  }

  it('summarizeTransaction attaches a decoded grant summary for the live router', () => {
    const owner = Keypair.random().publicKey()
    const s = summarizeTransaction(buildGrantTxXdr(owner))
    expect(s.contract).toBe(SOROBAN_FUNDING_ROUTER_ADDRESS)
    expect(s.fn).toBe('grant')
    expect(s.grant).not.toBeNull()
    expect(s.grant.kind).toBe('funding-router-grant')
    expect(s.grant.owner).toBe(owner)
    expect(s.grant.budgets).toEqual([
      { token: SOROBAN_TOKEN_ADDRESS, units: 5_000_000n, decimals: 7 },
    ])
    expect(s.grant.agents).toHaveLength(1)
    expect(s.grant.agents[0].destination.classification).toBe('known-stellar-vault')
  })

  it('a non-router transaction (deposit) never gets a grant summary', () => {
    const s = summarizeTransaction(buildDepositTxXdr())
    expect(s.grant).toBeNull()
  })
})
