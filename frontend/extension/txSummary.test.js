import { describe, it, expect } from 'vitest'
import {
  Account,
  Address,
  Contract,
  hash,
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
import { buildApprovalView } from './approvalView.js'
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
  contract: contractOverride = null,
  authorizer = owner,
  addressCredentials = false,
  signWith = null,
  operationSource = null,
  extraOperation = false,
  extraAuth = false,
  siblingInvocation = false,
  extraArg = false,
  rawOwnerArg,
  rawRecipientArg,
  rawAgentsArg,
  rawExtraArgs = [],
  rawContractAddress,
} = {}) {
  const contract =
    contractOverride ?? (fn === 'sweep' ? SOROBAN_EXIT_ROUTER_ADDRESS : SOROBAN_DEMO_AGENT)
  const ownerArg = rawOwnerArg ?? new Address(owner).toScVal()
  const recipientArg = rawRecipientArg ?? new Address(recipient).toScVal()
  const agentsArg = rawAgentsArg ?? xdr.ScVal.scvVec([new Address(SOROBAN_DEMO_AGENT).toScVal()])
  const trailingArgs = [...(extraArg ? [xdr.ScVal.scvVoid()] : []), ...rawExtraArgs]
  const args =
    fn === 'sweep'
      ? [ownerArg, agentsArg, recipientArg, ...trailingArgs]
      : [recipientArg, ...trailingArgs]
  const contractAddress = rawContractAddress ?? new Address(contract).toScAddress()
  const invokeArgs = new xdr.InvokeContractArgs({
    contractAddress,
    functionName: fn,
    args,
  })
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invokeArgs),
    subInvocations: siblingInvocation
      ? [
          new xdr.SorobanAuthorizedInvocation({
            function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              new xdr.InvokeContractArgs({
                contractAddress: new Address(SOROBAN_AUTOFARM_VAULT_ADDRESS).toScAddress(),
                functionName: 'redeem',
                args: [],
              })
            ),
            subInvocations: [],
          }),
        ]
      : [],
  })
  const credentials = addressCredentials
    ? xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(authorizer).toScAddress(),
          nonce: xdr.Int64.fromString('7'),
          signatureExpirationLedger: 500,
          signature: xdr.ScVal.scvBytes(Buffer.alloc(64, 3)),
        })
      )
    : xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
  const builder = new TransactionBuilder(new Account(source, '0'), {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  }).addOperation(
    Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs),
      auth: [
        new xdr.SorobanAuthorizationEntry({ credentials, rootInvocation: invocation }),
        ...(extraAuth
          ? [new xdr.SorobanAuthorizationEntry({ credentials, rootInvocation: invocation })]
          : []),
      ],
      ...(operationSource ? { source: operationSource } : {}),
    })
  )
  if (extraOperation) builder.addOperation(Operation.manageData({ name: 'hidden', value: '1' }))
  const tx = builder.setTimeout(300).build()
  if (signWith) tx.sign(signWith)
  return tx.toXDR()
}

const PROVEN_AGENT = Address.contract(Buffer.alloc(32, 19)).toString()
const PROVEN_AGENT_WASM = '1fdbe175ddeb6d237a178c3c117b4e6c168122eec7d94f06a4b27ee4026efbe1'

function provenOwnerWithdrawContext(xdrB64, owner, overrides = {}) {
  const tx = TransactionBuilder.fromXDR(xdrB64, NETWORK_PASSPHRASE)
  const authDigests = (tx.operations[0]?.auth ?? []).map((entry) =>
    hash(entry.toXDR()).toString('hex')
  )
  return {
    kind: 'owner-withdraw-v1',
    networkPassphrase: NETWORK_PASSPHRASE,
    contract: PROVEN_AGENT,
    wasmHash: PROVEN_AGENT_WASM,
    owner,
    recipient: owner,
    token: SOROBAN_TOKEN_ADDRESS,
    vault: SOROBAN_AUTOFARM_VAULT_ADDRESS,
    bodyDigest: tx.hash().toString('hex'),
    authorizationDigests: authDigests,
    ...overrides,
  }
}

function expectSchemaMismatchApproval(xdrB64, consentContext = null) {
  const summary = summarizeTransaction(xdrB64, NETWORK_PASSPHRASE, consentContext)
  expect(summary.allFunds).toBe(false)
  expect(summary.token).toBeNull()
  const view = buildApprovalView(
    { method: 'signTransaction', params: { xdr: xdrB64 }, origin: 'https://fixture.test' },
    {
      address: 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS',
      summary,
      kind: 'classic',
      unlocked: true,
    }
  )
  const consequence = view.sections.find((section) => section.kind === 'consequence')
  expect(consequence.warning).toBe(true)
  expect(consequence.statements.join(' ')).toMatch(/Soroban ABI schema mismatch/i)
  expect(consequence.statements.join(' ')).not.toMatch(/withdraws all funds held/i)
  expect(view.needsAcknowledgment).toBe(true)
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

  it('binds a proven direct exit to exact body/auth digests and owner/network/function/token/recipient facts', () => {
    const ownerKey = Keypair.random()
    const owner = ownerKey.publicKey()
    const xdrB64 = buildExitTx({ owner, contract: PROVEN_AGENT, signWith: ownerKey })
    const summary = summarizeTransaction(
      xdrB64,
      NETWORK_PASSPHRASE,
      provenOwnerWithdrawContext(xdrB64, owner)
    )
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
  ])('accepts a proven %s only from the exact address authorizer', (_label, owner) => {
    const relayer = Keypair.random().publicKey()
    const xdrB64 = buildExitTx({
      owner,
      source: relayer,
      contract: PROVEN_AGENT,
      addressCredentials: true,
    })
    const summary = summarizeTransaction(
      xdrB64,
      NETWORK_PASSPHRASE,
      provenOwnerWithdrawContext(xdrB64, owner)
    )
    expect(summary.owner).toBe(owner)
    expect(summary.owner).not.toBe(relayer)
    expect(summary.recipient).toBe(owner)
    expect(summary.token).toBe(SOROBAN_TOKEN_ADDRESS)
    expect(summary.allFunds).toBe(true)
  })

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

  it.each([
    [
      'recipient encoded as scvString with the exact owner text',
      ({ owner }) => xdr.ScVal.scvString(owner),
    ],
    [
      'recipient encoded as scvBytes containing the exact owner text',
      ({ owner }) => xdr.ScVal.scvBytes(Buffer.from(owner)),
    ],
    ['recipient encoded as a symbol instead of an address', () => xdr.ScVal.scvSymbol('owner')],
  ])('warns for owner_withdraw with %s', (_label, recipientArgFor) => {
    const owner = Keypair.random().publicKey()
    const xdrB64 = buildExitTx({
      owner,
      contract: PROVEN_AGENT,
      rawRecipientArg: recipientArgFor({ owner }),
    })
    expectSchemaMismatchApproval(xdrB64, provenOwnerWithdrawContext(xdrB64, owner))
  })

  it('warns when owner_withdraw carries a token-like extra scvString outside its exact ABI', () => {
    const owner = Keypair.random().publicKey()
    const xdrB64 = buildExitTx({
      owner,
      contract: PROVEN_AGENT,
      rawExtraArgs: [xdr.ScVal.scvString(SOROBAN_TOKEN_ADDRESS)],
    })
    expectSchemaMismatchApproval(xdrB64, provenOwnerWithdrawContext(xdrB64, owner))
  })

  it('warns when owner_withdraw invokes an account-kind ScAddress as though it were a contract', () => {
    const owner = Keypair.random().publicKey()
    const xdrB64 = buildExitTx({
      owner,
      rawContractAddress: new Address(owner).toScAddress(),
    })
    expectSchemaMismatchApproval(
      xdrB64,
      provenOwnerWithdrawContext(xdrB64, owner, { contract: owner })
    )
  })

  it.each([
    [
      'owner encoded as scvString with the exact owner text',
      ({ owner }) => ({ rawOwnerArg: xdr.ScVal.scvString(owner) }),
    ],
    [
      'owner encoded as scvBytes containing the exact owner text',
      ({ owner }) => ({ rawOwnerArg: xdr.ScVal.scvBytes(Buffer.from(owner)) }),
    ],
    [
      'recipient encoded as scvString with the exact owner text',
      ({ owner }) => ({ rawRecipientArg: xdr.ScVal.scvString(owner) }),
    ],
    [
      'recipient encoded as scvBytes containing the exact owner text',
      ({ owner }) => ({ rawRecipientArg: xdr.ScVal.scvBytes(Buffer.from(owner)) }),
    ],
    [
      'agent encoded as scvString with the exact contract text',
      () => ({
        rawAgentsArg: xdr.ScVal.scvVec([xdr.ScVal.scvString(SOROBAN_DEMO_AGENT)]),
      }),
    ],
    [
      'agent encoded as scvBytes containing the exact contract text',
      () => ({
        rawAgentsArg: xdr.ScVal.scvVec([xdr.ScVal.scvBytes(Buffer.from(SOROBAN_DEMO_AGENT))]),
      }),
    ],
    [
      'agent encoded as a symbol instead of an address',
      () => ({ rawAgentsArg: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('agent')]) }),
    ],
    [
      'agents vector encoded as bytes',
      () => ({ rawAgentsArg: xdr.ScVal.scvBytes(Buffer.from(SOROBAN_DEMO_AGENT)) }),
    ],
    [
      'account-kind address inside the agent contract vector',
      ({ owner }) => ({
        rawAgentsArg: xdr.ScVal.scvVec([new Address(owner).toScVal()]),
      }),
    ],
  ])('warns for sweep with %s', (_label, rawArgsFor) => {
    const owner = Keypair.random().publicKey()
    const xdrB64 = buildExitTx({ fn: 'sweep', owner, ...rawArgsFor({ owner }) })
    expectSchemaMismatchApproval(xdrB64)
  })

  it('warns when sweep carries a token-like extra scvString outside its exact ABI', () => {
    const owner = Keypair.random().publicKey()
    const xdrB64 = buildExitTx({
      fn: 'sweep',
      owner,
      rawExtraArgs: [xdr.ScVal.scvString(SOROBAN_TOKEN_ADDRESS)],
    })
    expectSchemaMismatchApproval(xdrB64)
  })

  it.each([
    [
      'an arbitrary contract named owner_withdraw',
      ({ owner }) =>
        buildExitTx({ owner, contract: Address.contract(Buffer.alloc(32, 21)).toString() }),
      null,
    ],
    [
      'unknown capability',
      ({ owner }) => buildExitTx({ owner, contract: PROVEN_AGENT }),
      ({ xdrB64, owner }) =>
        provenOwnerWithdrawContext(xdrB64, owner, { wasmHash: '00'.repeat(32) }),
    ],
    [
      'mismatched authorizer',
      ({ owner, relayer }) =>
        buildExitTx({
          owner,
          source: relayer,
          contract: PROVEN_AGENT,
          addressCredentials: true,
          authorizer: relayer,
        }),
      ({ xdrB64, owner }) => provenOwnerWithdrawContext(xdrB64, owner),
    ],
    [
      'a hidden extra operation',
      ({ owner }) => buildExitTx({ owner, contract: PROVEN_AGENT, extraOperation: true }),
      ({ xdrB64, owner }) => provenOwnerWithdrawContext(xdrB64, owner),
    ],
    [
      'an operation source override',
      ({ owner, relayer }) =>
        buildExitTx({ owner, contract: PROVEN_AGENT, operationSource: relayer }),
      ({ xdrB64, owner }) => provenOwnerWithdrawContext(xdrB64, owner),
    ],
    [
      'more than one auth entry',
      ({ owner }) => buildExitTx({ owner, contract: PROVEN_AGENT, extraAuth: true }),
      ({ xdrB64, owner }) => provenOwnerWithdrawContext(xdrB64, owner),
    ],
    [
      'a sibling invocation',
      ({ owner }) => buildExitTx({ owner, contract: PROVEN_AGENT, siblingInvocation: true }),
      ({ xdrB64, owner }) => provenOwnerWithdrawContext(xdrB64, owner),
    ],
    [
      'an owner_withdraw schema mismatch',
      ({ owner }) => buildExitTx({ owner, contract: PROVEN_AGENT, extraArg: true }),
      ({ xdrB64, owner }) => provenOwnerWithdrawContext(xdrB64, owner),
    ],
    [
      'a recipient different from the authorizer',
      ({ owner, other }) => buildExitTx({ owner, contract: PROVEN_AGENT, recipient: other }),
      ({ xdrB64, owner }) => provenOwnerWithdrawContext(xdrB64, owner),
    ],
  ])('fails closed for %s', (_label, build, contextFor) => {
    const owner = Keypair.random().publicKey()
    const relayer = Keypair.random().publicKey()
    const other = Keypair.random().publicKey()
    const xdrB64 = build({ owner, relayer, other })
    const context = contextFor?.({ xdrB64, owner, relayer, other }) ?? null
    const summary = summarizeTransaction(xdrB64, NETWORK_PASSPHRASE, context)
    expect(summary.allFunds).toBe(false)
    expect(summary.consentWarning).toMatch(/could not be proven/i)
    expect(summary.token).toBeNull()
  })

  it.each([
    ['wrong proof contract', { contract: Address.contract(Buffer.alloc(32, 22)).toString() }],
    ['wrong proof owner', { owner: Keypair.random().publicKey() }],
    ['wrong proof recipient', { recipient: Keypair.random().publicKey() }],
    ['wrong canonical token', { token: Address.contract(Buffer.alloc(32, 23)).toString() }],
    ['wrong canonical vault', { vault: Address.contract(Buffer.alloc(32, 24)).toString() }],
    ['wrong network', { networkPassphrase: 'Public Global Stellar Network ; September 2015' }],
    ['wrong body digest', { bodyDigest: '00'.repeat(32) }],
    ['wrong authorization digest', { authorizationDigests: ['11'.repeat(32)] }],
  ])('rejects direct-exit consent context with %s', (_label, contextOverride) => {
    const owner = Keypair.random().publicKey()
    const xdrB64 = buildExitTx({ owner, contract: PROVEN_AGENT })
    const summary = summarizeTransaction(
      xdrB64,
      NETWORK_PASSPHRASE,
      provenOwnerWithdrawContext(xdrB64, owner, contextOverride)
    )
    expect(summary.allFunds).toBe(false)
    expect(summary.consentWarning).toMatch(/could not be proven/i)
  })

  it('fails closed when a canonical sweep has a mismatched recipient', () => {
    const owner = Keypair.random().publicKey()
    const summary = summarizeTransaction(
      buildExitTx({ fn: 'sweep', owner, recipient: Keypair.random().publicKey() })
    )
    expect(summary.allFunds).toBe(false)
    expect(summary.consentWarning).toMatch(/could not be proven/i)
    expect(summary.token).toBeNull()
  })

  it.each([
    [
      'an arbitrary contract named sweep',
      ({ owner }) =>
        buildExitTx({
          fn: 'sweep',
          owner,
          contract: Address.contract(Buffer.alloc(32, 25)).toString(),
        }),
      NETWORK_PASSPHRASE,
    ],
    [
      'a sweep authorizer different from owner/recipient',
      ({ owner, relayer }) =>
        buildExitTx({
          fn: 'sweep',
          owner,
          source: relayer,
          authorizer: relayer,
          addressCredentials: true,
        }),
      NETWORK_PASSPHRASE,
    ],
    [
      'a sweep with a hidden operation',
      ({ owner }) => buildExitTx({ fn: 'sweep', owner, extraOperation: true }),
      NETWORK_PASSPHRASE,
    ],
    [
      'a sweep with an operation source override',
      ({ owner, relayer }) => buildExitTx({ fn: 'sweep', owner, operationSource: relayer }),
      NETWORK_PASSPHRASE,
    ],
    [
      'a sweep with more than one auth entry',
      ({ owner }) => buildExitTx({ fn: 'sweep', owner, extraAuth: true }),
      NETWORK_PASSPHRASE,
    ],
    [
      'a sweep with a sibling invocation',
      ({ owner }) => buildExitTx({ fn: 'sweep', owner, siblingInvocation: true }),
      NETWORK_PASSPHRASE,
    ],
    [
      'a sweep schema mismatch',
      ({ owner }) => buildExitTx({ fn: 'sweep', owner, extraArg: true }),
      NETWORK_PASSPHRASE,
    ],
    [
      'a sweep decoded under a noncanonical network',
      ({ owner }) => buildExitTx({ fn: 'sweep', owner }),
      'Public Global Stellar Network ; September 2015',
    ],
  ])('fails closed for %s', (_label, build, passphrase) => {
    const owner = Keypair.random().publicKey()
    const relayer = Keypair.random().publicKey()
    const summary = summarizeTransaction(build({ owner, relayer }), passphrase)
    expect(summary.allFunds).toBe(false)
    expect(summary.consentWarning).toMatch(/could not be proven/i)
    expect(summary.token).toBeNull()
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
