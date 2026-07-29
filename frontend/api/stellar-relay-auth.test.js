import { describe, it, expect, vi } from 'vitest'
import {
  Account,
  Address,
  Contract,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { assertOwnerWithdrawAuthorization } from './stellar-relay-auth.js'
import { AGENT_WASM_CAPABILITIES } from './agentCapabilities.js'

const PASS = 'Test SDF Network ; September 2015'
const PUBLIC_PASS = 'Public Global Stellar Network ; September 2015'
const AGENT = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const OTHER_AGENT = 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP'
const VAULT = 'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77'
const TOKEN = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'
const CURRENT_HASH = '1fdbe175ddeb6d237a178c3c117b4e6c168122eec7d94f06a4b27ee4026efbe1'
const LEGACY_HASH = 'd61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba'
const UNPROVEN_LEGACY_HASH = '7ced45e735e7e084d96d6a04df7cec6e07bc2b203eedb4d3422949a7e9cca717'
const RELAYER = Keypair.random()
const OWNER_G = Keypair.random()
const OTHER_G = Keypair.random()
const OWNER_C = StrKey.encodeContract(Buffer.alloc(32, 9))

function invocation({ agent = AGENT, recipient, fn = 'owner_withdraw', siblings = [] }) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(agent).toScAddress(),
        functionName: fn,
        args: [Address.fromString(recipient).toScVal()],
      })
    ),
    subInvocations: siblings,
  })
}

function sourceCredentials() {
  return xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
}

function addressCredentials(address, expiration = 500) {
  return xdr.SorobanCredentials.sorobanCredentialsAddress(
    new xdr.SorobanAddressCredentials({
      address: Address.fromString(address).toScAddress(),
      nonce: xdr.Int64.fromString('7'),
      signatureExpirationLedger: expiration,
      signature: xdr.ScVal.scvBytes(Buffer.alloc(64, 3)),
    })
  )
}

function authEntry({ credentials, root }) {
  return new xdr.SorobanAuthorizationEntry({ credentials, rootInvocation: root })
}

function siblingInvocation(recipient) {
  return invocation({ agent: TOKEN, recipient, fn: 'transfer' })
}

function buildFixture({
  owner = OWNER_G.publicKey(),
  recipient = owner,
  source = owner,
  credentials = sourceCredentials(),
  authOwner = owner,
  authAgent = AGENT,
  authRecipient = recipient,
  authFn = 'owner_withdraw',
  siblings = [],
  expiration = 500,
  agent = AGENT,
  operationSource,
  extraAuth = false,
  extraOperation = false,
  sign = source === owner && owner === OWNER_G.publicKey(),
  networkPassphrase = PASS,
} = {}) {
  const contractCall = new Contract(agent).call(
    'owner_withdraw',
    Address.fromString(recipient).toScVal()
  )
  const auth = [
    authEntry({
      credentials:
        credentials === 'address' ? addressCredentials(authOwner, expiration) : credentials,
      root: invocation({
        agent: authAgent,
        recipient: authRecipient,
        fn: authFn,
        siblings,
      }),
    }),
  ]
  if (extraAuth) auth.push(auth[0])
  const operation = Operation.invokeHostFunction({
    func: contractCall.body().invokeHostFunctionOp().hostFunction(),
    auth,
    ...(operationSource ? { source: operationSource } : {}),
  })
  let builder = new TransactionBuilder(new Account(source, '12'), {
    fee: '100',
    networkPassphrase,
  }).addOperation(operation)
  if (extraOperation) builder = builder.addOperation(Operation.bumpSequence({ bumpTo: '100' }))
  const tx = builder.setTimeout(300).build()
  if (sign) OWNER_G.sign(tx.hash()) && tx.sign(OWNER_G)
  return tx.toEnvelope().toXDR('base64')
}

function scopeFor(owner, hash = CURRENT_HASH, overrides = {}) {
  return hash === LEGACY_HASH
    ? { owner, vault: VAULT, token: TOKEN, revoked: false, expiry: 9999999999n, ...overrides }
    : {
        owner,
        target: VAULT,
        token: TOKEN,
        kind: 0,
        revoked: false,
        expiry: 9999999999n,
        ...overrides,
      }
}

function assertFixture(
  xdrB64,
  {
    owner = OWNER_G.publicKey(),
    hash = CURRENT_HASH,
    scope = scopeFor(owner, hash),
    networkPassphrase = PASS,
    expectedNetworkPassphrase = PASS,
    readScope = vi.fn(async () => scope),
  } = {}
) {
  return assertOwnerWithdrawAuthorization({
    xdr: xdrB64,
    networkPassphrase,
    expectedNetworkPassphrase,
    expectedAgent: AGENT,
    expectedRelayer: RELAYER.publicKey(),
    expectedToken: TOKEN,
    expectedVault: VAULT,
    wasmHash: hash,
    currentLedger: 100,
    readScope,
  })
}

describe('AGENT_WASM_CAPABILITIES', () => {
  it('grants direct withdraw only to exact deployment hashes with source-proven owner ABIs', () => {
    expect(AGENT_WASM_CAPABILITIES[CURRENT_HASH]).toMatchObject({
      generation: expect.any(String),
      scopeOfOwnerAbi: expect.any(String),
      allowedRelayOps: expect.arrayContaining(['owner_withdraw']),
    })
    expect(AGENT_WASM_CAPABILITIES[LEGACY_HASH]).toMatchObject({
      scopeOfOwnerAbi: expect.any(String),
      allowedRelayOps: expect.arrayContaining(['owner_withdraw']),
    })
    expect(AGENT_WASM_CAPABILITIES[UNPROVEN_LEGACY_HASH]).toBeUndefined()
  })
})

describe('assertOwnerWithdrawAuthorization — real XDR/auth', () => {
  it('accepts a full-signed G owner-to-self transaction', async () => {
    await expect(assertFixture(buildFixture())).resolves.toMatchObject({
      owner: OWNER_G.publicKey(),
    })
  })

  it('accepts a G owner auth entry on a relayer-sponsored transaction', async () => {
    const xdrB64 = buildFixture({
      source: RELAYER.publicKey(),
      credentials: 'address',
      sign: false,
    })
    await expect(assertFixture(xdrB64)).resolves.toMatchObject({ owner: OWNER_G.publicKey() })
  })

  it('accepts a C owner auth entry on a relayer-sponsored transaction', async () => {
    const xdrB64 = buildFixture({
      owner: OWNER_C,
      source: RELAYER.publicKey(),
      credentials: 'address',
      authOwner: OWNER_C,
      sign: false,
    })
    await expect(
      assertFixture(xdrB64, { owner: OWNER_C, scope: scopeFor(OWNER_C) })
    ).resolves.toMatchObject({ owner: OWNER_C })
  })

  it.each([
    ['wrong agent', { agent: OTHER_AGENT }],
    ['wrong root agent', { authAgent: OTHER_AGENT }],
    ['wrong root function', { authFn: 'revoke' }],
    ['wrong root recipient', { authRecipient: OTHER_G.publicKey() }],
    [
      'wrong signer',
      {
        source: RELAYER.publicKey(),
        credentials: 'address',
        authOwner: OTHER_G.publicKey(),
        sign: false,
      },
    ],
    ['wrong recipient', { recipient: OTHER_G.publicKey() }],
    ['source override', { operationSource: OTHER_G.publicKey() }],
    ['extra operation', { extraOperation: true }],
    ['extra auth', { extraAuth: true }],
    ['sibling invocation', { siblings: [siblingInvocation(OWNER_G.publicKey())] }],
    [
      'expired auth',
      { source: RELAYER.publicKey(), credentials: 'address', expiration: 100, sign: false },
    ],
  ])('rejects %s', async (_label, changes) => {
    await expect(assertFixture(buildFixture(changes))).rejects.toThrow()
  })

  it('rejects a wrong network', async () => {
    await expect(assertFixture(buildFixture(), { networkPassphrase: PUBLIC_PASS })).rejects.toThrow(
      /network|signature/i
    )
  })

  it.each([
    ['token', { token: OTHER_AGENT }],
    ['vault', { target: OTHER_AGENT }],
    ['stored owner', { owner: OTHER_G.publicKey() }],
  ])('rejects a scope with the wrong %s', async (_label, scopeChanges) => {
    await expect(
      assertFixture(buildFixture(), {
        scope: scopeFor(OWNER_G.publicKey(), CURRENT_HASH, scopeChanges),
      })
    ).rejects.toThrow()
  })

  it('accepts the proven legacy owner/vault/token scope ABI', async () => {
    await expect(
      assertFixture(buildFixture(), {
        hash: LEGACY_HASH,
        scope: scopeFor(OWNER_G.publicKey(), LEGACY_HASH),
      })
    ).resolves.toMatchObject({ owner: OWNER_G.publicKey() })
  })

  it.each([
    ['unknown', 'cafebabe'.repeat(8)],
    ['unproven legacy', UNPROVEN_LEGACY_HASH],
  ])('rejects an %s hash before reading scope_of', async (_label, hash) => {
    const readScope = vi.fn()
    await expect(assertFixture(buildFixture(), { hash, readScope })).rejects.toThrow(
      /capability|proven/i
    )
    expect(readScope).not.toHaveBeenCalled()
  })
})
