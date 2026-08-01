import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as signP256,
  verify as verifyP256,
} from 'node:crypto'
import * as realSdk from '@stellar/stellar-sdk'
import stellarDeployment from '../../deployments/stellar-testnet.json'
import {
  feeBumpAndSubmit,
  loadStellarRelayConfig,
  RelayError,
  STELLAR_RELAY_FACTS,
  _clearSeen,
  assertRelayableTransaction,
} from './stellar-relay.js'
import * as relayApi from './stellar-relay.js'
import { submitViaRelay as submitViaRelayClient } from '../src/stellar/relay.js'

const PASS = 'Test SDF Network ; September 2015'
const SECRET = 'SABCD' // never parsed — Keypair.fromSecret is faked below
const RELAYER_SOURCE = 'GBVJ34MT4GDKZJGILI6DRYGD75ZNUBJGGZIDUV7IPFNVVDWGE5GBLV3X'
const OTHER_SOURCE = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'

const VAULT = 'CCTGGJVVY45DYDDXM3XBFEJ2OT2J2ZT6HIXZEQKXU7Z53TH3YSZJC3PF'
const TOKEN = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'
const ROUTER = 'CROUTER'
const ROUTER_V1 = 'CROUTERV1'
const ROUTER_V2 = 'CROUTERV2'
const EXIT_ROUTER = 'CEXITROUTER'
const MESSENGER = 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP'
const AGENT_HASH = 'd61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba'
const SAK_WASM = 'a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e'
const REAL_AGENT = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const CURRENT_AGENT_HASH = '1fdbe175ddeb6d237a178c3c117b4e6c168122eec7d94f06a4b27ee4026efbe1'

// ── fake op/tx fixtures — mirror the shape TransactionBuilder.fromXDR hands back ──

// Positional arg markers, decoded by the fake `scValToNative` below. `{__vec:[...]}` decodes
// recursively so a router.grant's budgets/agents Vec args can hold nested marker objects too.
function nativeOf(v) {
  if (v && typeof v === 'object') {
    if ('__addr' in v) return v.__addr
    if ('__amount' in v) return v.__amount
    if ('__u32' in v) return v.__u32
    if ('__bytes' in v) return v.__bytes
    if ('__vec' in v) return v.__vec.map(nativeOf)
  }
  return v
}

function invokeOp(contractStr, fnStr, args = []) {
  return {
    type: 'invokeHostFunction',
    func: {
      switch: () => ({ name: 'hostFunctionTypeInvokeContract' }),
      invokeContract: () => ({
        contractAddress: () => ({ __sc: contractStr }),
        functionName: () => fnStr, // ScSymbol stringifies to the symbol
        args: () => args,
      }),
    },
  }
}
function depositTx(contractStr, fnStr, args = []) {
  return { operations: [invokeOp(contractStr, fnStr, args)] }
}

// Fake sdk: real code only needs Address.fromScAddress (the op's contract) and scValToNative
// (every arg) — assertRelayableTransaction never calls Address.fromScVal directly anymore.
const sdkAddr = {
  Address: { fromScAddress: (sc) => ({ toString: () => sc.__sc }) },
  scValToNative: nativeOf,
}

function deployTx(hashHex, execKind = 'contractExecutableWasm') {
  return {
    operations: [
      {
        type: 'invokeHostFunction',
        func: {
          switch: () => ({ name: 'hostFunctionTypeCreateContractV2' }),
          createContractV2: () => ({
            executable: () => ({
              switch: () => ({ name: execKind }),
              wasmHash: () => Buffer.from(hashHex, 'hex'),
            }),
          }),
        },
      },
    ],
  }
}

// ─────────────────────────── feeBumpAndSubmit (fee-bump mechanics) ───────────────────────────

// Fake SDK. fromXDR returns a fake inner Transaction carrying ONE allowlisted vault-deposit op
// (so assertRelayableTransaction — always consulted now, no vaultAddr-empty bypass — passes and
// these tests stay focused on fee-bump/sign/poll mechanics). instanceof FeeBumpTransaction is
// used to reject an already-bumped tx.
class FakeFeeBump {}
function makeSdk({
  innerFee = '100000',
  innerHashHex = 'aa',
  alreadyBumped = false,
  innerSource = RELAYER_SOURCE,
} = {}) {
  const signSpy = vi.fn()
  const innerSignSpy = vi.fn()
  const builtFeeBump = { sign: signSpy }
  const buildFeeBumpTransaction = vi.fn(() => builtFeeBump)
  const inner = alreadyBumped
    ? new FakeFeeBump()
    : {
        fee: innerFee,
        source: innerSource,
        operations: [invokeOp(VAULT, 'deposit')],
        hash: () => Buffer.from(innerHashHex, 'hex'),
        sign: innerSignSpy,
      }
  return {
    sdk: {
      TransactionBuilder: { fromXDR: vi.fn(() => inner), buildFeeBumpTransaction },
      FeeBumpTransaction: FakeFeeBump,
      Keypair: { fromSecret: () => ({ publicKey: () => RELAYER_SOURCE }) },
      Address: sdkAddr.Address,
      scValToNative: nativeOf,
      rpc: {
        Api: {
          isSimulationSuccess: (value) => Boolean(value && 'transactionData' in value),
        },
      },
    },
    signSpy,
    innerSignSpy,
    buildFeeBumpTransaction,
    builtFeeBump,
  }
}
function makeRpc({ sendStatus = 'PENDING', getStatuses = ['SUCCESS'] } = {}) {
  const queue = [...getStatuses]
  return {
    sendTransaction: vi.fn(async () => ({ status: sendStatus, hash: 'OUTERHASH' })),
    simulateTransaction: vi.fn(async () => ({
      transactionData: {},
      result: { retval: {} },
    })),
    getTransaction: vi.fn(async () => ({ status: queue.shift() ?? 'NOT_FOUND' })),
  }
}

describe('feeBumpAndSubmit', () => {
  beforeEach(() => _clearSeen())
  afterEach(() => vi.unstubAllGlobals())

  it('fee-bumps, signs with the relayer key, submits, polls to SUCCESS', async () => {
    const { sdk, signSpy, buildFeeBumpTransaction } = makeSdk({ innerHashHex: '11' })
    const rpc = makeRpc({ getStatuses: ['NOT_FOUND', 'SUCCESS'] })
    const out = await feeBumpAndSubmit({
      xdr: 'INNERXDR',
      secret: SECRET,
      passphrase: PASS,
      vaultAddr: VAULT,
      sdk,
      rpcServer: rpc,
    })
    expect(out).toEqual({ hash: 'OUTERHASH', status: 'SUCCESS', relayer: RELAYER_SOURCE })
    expect(buildFeeBumpTransaction).toHaveBeenCalledOnce()
    expect(signSpy).toHaveBeenCalledOnce()
    expect(rpc.sendTransaction).toHaveBeenCalledOnce()
  })

  it('signs the inner tx when the relayer is its source (agent-deposit path), then fee-bumps', async () => {
    const { sdk, innerSignSpy, signSpy, buildFeeBumpTransaction } = makeSdk({
      innerHashHex: '55',
      innerSource: RELAYER_SOURCE,
    })
    const rpc = makeRpc({ getStatuses: ['SUCCESS'] })
    const out = await feeBumpAndSubmit({
      xdr: 'INNERXDR',
      secret: SECRET,
      passphrase: PASS,
      vaultAddr: VAULT,
      sdk,
      rpcServer: rpc,
    })
    expect(out.status).toBe('SUCCESS')
    expect(innerSignSpy).toHaveBeenCalledOnce() // the new branch: relayer signs the inner tx
    expect(signSpy).toHaveBeenCalledOnce() // still fee-bumped + signed
    expect(buildFeeBumpTransaction).toHaveBeenCalledOnce()
  })

  it('enforces the signed inner transaction before constructing or sending the fee bump', async () => {
    const { sdk, innerSignSpy, buildFeeBumpTransaction, builtFeeBump } = makeSdk({
      innerHashHex: '57',
      innerSource: RELAYER_SOURCE,
    })
    const rpc = makeRpc({ getStatuses: ['SUCCESS'] })
    const order = []
    innerSignSpy.mockImplementation(() => order.push('inner-sign'))
    rpc.simulateTransaction.mockImplementation(async () => {
      expect(innerSignSpy).toHaveBeenCalledOnce()
      expect(buildFeeBumpTransaction).not.toHaveBeenCalled()
      order.push('enforcing-simulation')
      return { transactionData: {}, result: { retval: {} } }
    })
    buildFeeBumpTransaction.mockImplementation(() => {
      order.push('build-fee-bump')
      return builtFeeBump
    })
    rpc.sendTransaction.mockImplementation(async () => {
      order.push('submit-fee-bump')
      return { status: 'PENDING', hash: 'OUTERHASH' }
    })

    await feeBumpAndSubmit({
      xdr: 'INNERXDR',
      secret: SECRET,
      passphrase: PASS,
      vaultAddr: VAULT,
      sdk,
      rpcServer: rpc,
    })

    expect(order).toEqual([
      'inner-sign',
      'enforcing-simulation',
      'build-fee-bump',
      'submit-fee-bump',
    ])
  })

  it('fails closed when enforcing simulation rejects the signed inner transaction', async () => {
    const { sdk, buildFeeBumpTransaction } = makeSdk({
      innerHashHex: '58',
      innerSource: RELAYER_SOURCE,
    })
    const rpc = makeRpc()
    rpc.simulateTransaction.mockResolvedValue({ error: 'auth failed' })

    await expect(
      feeBumpAndSubmit({
        xdr: 'INNERXDR',
        secret: SECRET,
        passphrase: PASS,
        vaultAddr: VAULT,
        sdk,
        rpcServer: rpc,
      })
    ).rejects.toThrow('RPC enforcing simulation rejected the signed transaction')
    expect(buildFeeBumpTransaction).not.toHaveBeenCalled()
    expect(rpc.sendTransaction).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty object', {}],
    ['success-shaped data without a result payload', { transactionData: {} }],
    ['a malformed result payload', { transactionData: {}, result: {} }],
  ])('fails closed on %s before constructing a fee bump', async (_label, simulation) => {
    const { sdk, buildFeeBumpTransaction } = makeSdk({ innerHashHex: '59' })
    const rpc = makeRpc()
    rpc.simulateTransaction.mockResolvedValue(simulation)
    await expect(
      feeBumpAndSubmit({
        xdr: 'INNERXDR',
        secret: SECRET,
        passphrase: PASS,
        vaultAddr: VAULT,
        sdk,
        rpcServer: rpc,
      })
    ).rejects.toThrow(/simulation/i)
    expect(buildFeeBumpTransaction).not.toHaveBeenCalled()
    expect(rpc.sendTransaction).not.toHaveBeenCalled()
  })

  it('rejects an unproven non-relayer source before simulation or fee-bump construction', async () => {
    const { sdk, innerSignSpy } = makeSdk({ innerHashHex: '56', innerSource: OTHER_SOURCE })
    const rpc = makeRpc({ getStatuses: ['SUCCESS'] })
    await expect(
      feeBumpAndSubmit({
        xdr: 'INNERXDR',
        secret: SECRET,
        passphrase: PASS,
        vaultAddr: VAULT,
        sdk,
        rpcServer: rpc,
      })
    ).rejects.toThrow(/source|authorization|account/i)
    expect(innerSignSpy).not.toHaveBeenCalled()
    expect(rpc.simulateTransaction).not.toHaveBeenCalled()
  })

  it('rejects an already-fee-bumped inner tx (the relay must be the fee source)', async () => {
    const { sdk } = makeSdk({ alreadyBumped: true })
    const rpc = makeRpc()
    await expect(
      feeBumpAndSubmit({
        xdr: 'X',
        secret: SECRET,
        passphrase: PASS,
        vaultAddr: VAULT,
        sdk,
        rpcServer: rpc,
      })
    ).rejects.toBeInstanceOf(RelayError)
    expect(rpc.sendTransaction).not.toHaveBeenCalled()
  })

  it('throws when the RPC rejects the submission (status ERROR)', async () => {
    const { sdk } = makeSdk({ innerHashHex: '22' })
    const rpc = makeRpc({ sendStatus: 'ERROR' })
    await expect(
      feeBumpAndSubmit({
        xdr: 'X',
        secret: SECRET,
        passphrase: PASS,
        vaultAddr: VAULT,
        sdk,
        rpcServer: rpc,
      })
    ).rejects.toBeInstanceOf(RelayError)
  })

  it('short-circuits a replayed inner tx without re-broadcasting (same inner hash)', async () => {
    const a = makeSdk({ innerHashHex: '33' })
    const rpcA = makeRpc({ getStatuses: ['SUCCESS'] })
    await feeBumpAndSubmit({
      xdr: 'X',
      secret: SECRET,
      passphrase: PASS,
      vaultAddr: VAULT,
      sdk: a.sdk,
      rpcServer: rpcA,
    })
    const b = makeSdk({ innerHashHex: '33' }) // same inner hash → duplicate
    const rpcB = makeRpc({ getStatuses: ['SUCCESS'] })
    const out = await feeBumpAndSubmit({
      xdr: 'X',
      secret: SECRET,
      passphrase: PASS,
      vaultAddr: VAULT,
      sdk: b.sdk,
      rpcServer: rpcB,
    })
    expect(out).toEqual({
      hash: 'OUTERHASH',
      status: 'SUCCESS',
      relayer: RELAYER_SOURCE,
      duplicate: true,
    })
    expect(rpcB.sendTransaction).not.toHaveBeenCalled()
  })

  it.each([
    ['PENDING', [], '34'],
    ['FAILED', ['FAILED'], '35'],
  ])(
    'preserves cached %s when an identical inner transaction is seen again',
    async (status, getStatuses, innerHashHex) => {
      const firstSdk = makeSdk({ innerHashHex })
      const firstRpc = makeRpc({ getStatuses })
      await expect(
        feeBumpAndSubmit({
          xdr: 'X',
          secret: SECRET,
          passphrase: PASS,
          vaultAddr: VAULT,
          sdk: firstSdk.sdk,
          rpcServer: firstRpc,
          pollTries: status === 'PENDING' ? 1 : 10,
          pollIntervalMs: 0,
        })
      ).resolves.toMatchObject({ hash: 'OUTERHASH', status })

      const duplicateSdk = makeSdk({ innerHashHex })
      const duplicateRpc = makeRpc()
      await expect(
        feeBumpAndSubmit({
          xdr: 'X',
          secret: SECRET,
          passphrase: PASS,
          vaultAddr: VAULT,
          sdk: duplicateSdk.sdk,
          rpcServer: duplicateRpc,
        })
      ).resolves.toEqual({
        hash: 'OUTERHASH',
        status,
        relayer: RELAYER_SOURCE,
        duplicate: true,
      })
      expect(duplicateRpc.sendTransaction).not.toHaveBeenCalled()
    }
  )

  it('returns a structured 409 unknown for an identical inner transaction already in flight', async () => {
    let releasePoll
    const firstSdk = makeSdk({ innerHashHex: '36' })
    const firstRpc = makeRpc()
    firstRpc.getTransaction.mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePoll = resolve
        })
    )
    const first = feeBumpAndSubmit({
      xdr: 'X',
      secret: SECRET,
      passphrase: PASS,
      vaultAddr: VAULT,
      sdk: firstSdk.sdk,
      rpcServer: firstRpc,
      pollIntervalMs: 0,
    })
    await vi.waitFor(() => expect(firstRpc.getTransaction).toHaveBeenCalledOnce())

    const duplicateSdk = makeSdk({ innerHashHex: '36' })
    const duplicateRpc = makeRpc()
    let inFlightError
    try {
      await feeBumpAndSubmit({
        xdr: 'X',
        secret: SECRET,
        passphrase: PASS,
        vaultAddr: VAULT,
        sdk: duplicateSdk.sdk,
        rpcServer: duplicateRpc,
      })
    } catch (error) {
      inFlightError = error
    }
    expect(inFlightError).toMatchObject({
      name: 'RelaySubmissionUnknownError',
      code: 'VF_SUBMISSION_UNKNOWN',
      httpStatus: 409,
      result: { hash: 'OUTERHASH', status: 'PENDING', relayer: RELAYER_SOURCE },
    })
    expect(relayApi.relayUnknownHttpResponse(inFlightError)).toEqual({
      status: 409,
      body: {
        error: 'inner tx already in flight',
        submission: 'unknown',
        hash: 'OUTERHASH',
        status: 'PENDING',
        relayer: RELAYER_SOURCE,
      },
    })
    expect(duplicateRpc.sendTransaction).not.toHaveBeenCalled()

    releasePoll({ status: 'SUCCESS' })
    await expect(first).resolves.toMatchObject({ status: 'SUCCESS' })
  })

  it('turns a post-send poll exception into a hash-preserving API 502 and client unknown', async () => {
    const { sdk } = makeSdk({ innerHashHex: '37' })
    const rpc = makeRpc()
    rpc.getTransaction.mockRejectedValue(new Error('RPC poll unavailable'))

    let producerError
    try {
      await feeBumpAndSubmit({
        xdr: 'X',
        secret: SECRET,
        passphrase: PASS,
        vaultAddr: VAULT,
        sdk,
        rpcServer: rpc,
      })
    } catch (error) {
      producerError = error
    }
    expect(producerError).toMatchObject({
      name: 'RelaySubmissionUnknownError',
      code: 'VF_SUBMISSION_UNKNOWN',
      httpStatus: 502,
      result: { hash: 'OUTERHASH', status: 'PENDING', relayer: RELAYER_SOURCE },
    })

    const produced = relayApi.relayUnknownHttpResponse(producerError)
    expect(produced).toMatchObject({
      status: 502,
      body: {
        submission: 'unknown',
        hash: 'OUTERHASH',
        status: 'PENDING',
        relayer: RELAYER_SOURCE,
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: produced.status,
        json: async () => produced.body,
      }))
    )
    await expect(submitViaRelayClient({ xdr: 'X' })).rejects.toMatchObject({
      code: 'VF_SUBMISSION_UNKNOWN',
      result: { hash: 'OUTERHASH', status: 'PENDING', relayer: RELAYER_SOURCE },
    })
    expect(rpc.sendTransaction).toHaveBeenCalledOnce()
  })

  it('returns PENDING (not an error) when the tx is still NOT_FOUND after the poll budget', async () => {
    const { sdk } = makeSdk({ innerHashHex: '44' })
    const rpc = makeRpc({ getStatuses: [] }) // always NOT_FOUND
    const out = await feeBumpAndSubmit({
      xdr: 'X',
      secret: SECRET,
      passphrase: PASS,
      vaultAddr: VAULT,
      sdk,
      rpcServer: rpc,
      pollTries: 2,
      pollIntervalMs: 0,
    })
    expect(out.status).toBe('PENDING')
    expect(out.hash).toBe('OUTERHASH')
  })

  it('rejects a non-allowlisted inner tx before ever touching the RPC (guard runs first)', async () => {
    const { sdk } = makeSdk()
    sdk.TransactionBuilder.fromXDR = vi.fn(() => ({
      fee: '100000',
      operations: [invokeOp('CATTACKER', 'drain')],
      hash: () => Buffer.from('99', 'hex'),
      sign: vi.fn(),
    }))
    const rpc = makeRpc()
    await expect(
      feeBumpAndSubmit({
        xdr: 'X',
        secret: SECRET,
        passphrase: PASS,
        vaultAddr: VAULT,
        sdk,
        rpcServer: rpc,
      })
    ).rejects.toBeInstanceOf(RelayError)
    expect(rpc.sendTransaction).not.toHaveBeenCalled()
  })
})

describe('loadStellarRelayConfig — canonical deployment facts', () => {
  it('derives the relay network/contracts/RPC entirely from tracked deployment JSON', () => {
    const config = loadStellarRelayConfig({ NODE_ENV: 'production' })
    expect(config).toMatchObject(STELLAR_RELAY_FACTS)
  })

  it.each([
    ['STELLAR_NETWORK_PASSPHRASE', 'wrong network'],
    ['SOROBAN_RPC_URL', 'https://rpc.example'],
    ['SOROBAN_VAULT_ADDRESS', TOKEN],
    ['SOROBAN_TOKEN_ADDRESS', VAULT],
    ['SOROBAN_ROUTER_ADDRESSES', STELLAR_RELAY_FACTS.exitRouterAddress],
    ['SOROBAN_EXIT_ROUTER_ADDRESS', STELLAR_RELAY_FACTS.vaultAddress],
  ])('rejects production drift for %s', (key, value) => {
    expect(() => loadStellarRelayConfig({ NODE_ENV: 'production', [key]: value })).toThrow(
      new RegExp(key)
    )
  })

  it.each([
    ['SOROBAN_RPC_URL', 'file:///tmp/rpc'],
    ['SOROBAN_VAULT_ADDRESS', 'CNOTASTRKEY'],
    ['SOROBAN_ROUTER_ADDRESSES', 'CNOTASTRKEY'],
    ['SOROBAN_AGENT_WASM_HASHES', 'abcd'],
    ['STELLAR_NETWORK_PASSPHRASE', ''],
  ])('strictly rejects an invalid development override for %s', (key, value) => {
    expect(() => loadStellarRelayConfig({ NODE_ENV: 'development', [key]: value })).toThrow(
      new RegExp(key)
    )
  })
})

describe('fee relay — real signed XDR security path', () => {
  const relayer = realSdk.Keypair.random()
  const owner = realSdk.Keypair.random()
  // Pinned to the smart-account-kit 0.2.10 / bindings 0.1.2 path used by ownerAuthorization.js.
  const webauthnVerifier = stellarDeployment.smartAccount.webauthnVerifierAddress
  const rpId = 'vibing-farmer.test'
  const origin = `https://${rpId}`
  const credentialId = Buffer.from('vf-real-auth-fixture')
  const p256 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const wrongP256 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const p256Jwk = p256.publicKey.export({ format: 'jwk' })
  const p256PublicKey = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(p256Jwk.x, 'base64url'),
    Buffer.from(p256Jwk.y, 'base64url'),
  ])
  const passkeyKeyData = Buffer.concat([p256PublicKey, credentialId])
  const passkeyOwner = realSdk.StrKey.encodeContract(realSdk.hash(passkeyKeyData))

  function exitAuthEntry({ ownerAddress, credentials }) {
    return new realSdk.xdr.SorobanAuthorizationEntry({
      credentials,
      rootInvocation: new realSdk.xdr.SorobanAuthorizedInvocation({
        function: realSdk.xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new realSdk.xdr.InvokeContractArgs({
            contractAddress: realSdk.Address.fromString(REAL_AGENT).toScAddress(),
            functionName: 'owner_withdraw',
            args: [realSdk.Address.fromString(ownerAddress).toScVal()],
          })
        ),
        subInvocations: [],
      }),
    })
  }

  function realExitTx({ ownerAddress = owner.publicKey(), sign = true } = {}) {
    const credentials = realSdk.xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
    const call = new realSdk.Contract(REAL_AGENT).call(
      'owner_withdraw',
      realSdk.Address.fromString(ownerAddress).toScVal()
    )
    const tx = new realSdk.TransactionBuilder(new realSdk.Account(ownerAddress, '12'), {
      fee: '100',
      networkPassphrase: PASS,
    })
      .addOperation(
        realSdk.Operation.invokeHostFunction({
          func: call.body().invokeHostFunctionOp().hostFunction(),
          auth: [exitAuthEntry({ ownerAddress, credentials })],
        })
      )
      .setTimeout(300)
      .build()
    if (sign) tx.sign(owner)
    return tx
  }

  function unsignedAddressAuthEntry(ownerAddress) {
    return exitAuthEntry({
      ownerAddress,
      credentials: realSdk.xdr.SorobanCredentials.sorobanCredentialsAddress(
        new realSdk.xdr.SorobanAddressCredentials({
          address: realSdk.Address.fromString(ownerAddress).toScAddress(),
          nonce: realSdk.xdr.Int64.fromString('9'),
          signatureExpirationLedger: 0,
          signature: realSdk.xdr.ScVal.scvVoid(),
        })
      ),
    })
  }

  function addressAuthorizedExitTx(ownerAddress, signedEntry) {
    const call = new realSdk.Contract(REAL_AGENT).call(
      'owner_withdraw',
      realSdk.Address.fromString(ownerAddress).toScVal()
    )
    return new realSdk.TransactionBuilder(new realSdk.Account(relayer.publicKey(), '12'), {
      fee: '100',
      networkPassphrase: PASS,
    })
      .addOperation(
        realSdk.Operation.invokeHostFunction({
          func: call.body().invokeHostFunctionOp().hostFunction(),
          auth: [signedEntry],
        })
      )
      .setTimeout(300)
      .build()
  }

  async function sponsoredGExitTx({ signer = owner, expiration = 500 } = {}) {
    const signedEntry = await realSdk.authorizeEntry(
      unsignedAddressAuthEntry(owner.publicKey()),
      signer,
      expiration,
      PASS,
      owner.publicKey()
    )
    return addressAuthorizedExitTx(owner.publicKey(), signedEntry)
  }

  function lowS(signature) {
    const order = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
    const r = signature.subarray(0, 32)
    let s = BigInt(`0x${signature.subarray(32).toString('hex')}`)
    if (s > order / 2n) s = order - s
    return Buffer.concat([r, Buffer.from(s.toString(16).padStart(64, '0'), 'hex')])
  }

  function signedPasskeyEntry({ expiration = 500, signingKey = p256.privateKey } = {}) {
    const entry = realSdk.xdr.SorobanAuthorizationEntry.fromXDR(
      unsignedAddressAuthEntry(passkeyOwner).toXDR()
    )
    const credentials = entry.credentials().address()
    credentials.signatureExpirationLedger(expiration)
    const payload = canonicalAuthPayload(entry)
    const clientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: payload.toString('base64url'),
        origin,
        crossOrigin: false,
      })
    )
    const authenticatorData = Buffer.concat([
      createHash('sha256').update(rpId).digest(),
      Buffer.from([0x05]),
      Buffer.alloc(4),
    ])
    const signedData = Buffer.concat([
      authenticatorData,
      createHash('sha256').update(clientData).digest(),
    ])
    const signature = lowS(
      signP256('sha256', signedData, { key: signingKey, dsaEncoding: 'ieee-p1363' })
    )
    const signatureData = realSdk.xdr.ScVal.scvMap([
      new realSdk.xdr.ScMapEntry({
        key: realSdk.xdr.ScVal.scvSymbol('authenticator_data'),
        val: realSdk.xdr.ScVal.scvBytes(authenticatorData),
      }),
      new realSdk.xdr.ScMapEntry({
        key: realSdk.xdr.ScVal.scvSymbol('client_data'),
        val: realSdk.xdr.ScVal.scvBytes(clientData),
      }),
      new realSdk.xdr.ScMapEntry({
        key: realSdk.xdr.ScVal.scvSymbol('signature'),
        val: realSdk.xdr.ScVal.scvBytes(signature),
      }),
    ])
    const signerId = realSdk.xdr.ScVal.scvVec([
      realSdk.xdr.ScVal.scvSymbol('External'),
      realSdk.xdr.ScVal.scvAddress(realSdk.Address.fromString(webauthnVerifier).toScAddress()),
      realSdk.xdr.ScVal.scvBytes(passkeyKeyData),
    ])
    credentials.signature(
      realSdk.xdr.ScVal.scvVec([
        realSdk.xdr.ScVal.scvMap([
          new realSdk.xdr.ScMapEntry({
            key: signerId,
            val: realSdk.xdr.ScVal.scvBytes(signatureData.toXDR()),
          }),
        ]),
      ])
    )
    return entry
  }

  function sponsoredCExitTx(options = {}) {
    return addressAuthorizedExitTx(passkeyOwner, signedPasskeyEntry(options))
  }

  function replaceGSignature(tx, bytes) {
    const signerMap = tx.operations[0].auth[0].credentials().address().signature().vec()[0]
    const entry = signerMap
      .map()
      .find((candidate) => candidate.key().sym().toString() === 'signature')
    entry.val(realSdk.xdr.ScVal.scvBytes(bytes))
  }

  function replaceCSignature(tx, bytes) {
    const credentials = tx.operations[0].auth[0].credentials().address()
    const outerEntry = credentials.signature().vec()[0].map()[0]
    const signatureData = realSdk.xdr.ScVal.fromXDR(outerEntry.val().bytes())
    const signatureEntry = signatureData
      .map()
      .find((candidate) => candidate.key().sym().toString() === 'signature')
    signatureEntry.val(realSdk.xdr.ScVal.scvBytes(bytes))
    outerEntry.val(realSdk.xdr.ScVal.scvBytes(signatureData.toXDR()))
  }

  function authError(message) {
    throw new Error(`enforcing simulation auth rejected: ${message}`)
  }

  function exactMap(scVal, expectedKeys) {
    if (scVal.switch().name !== 'scvMap') authError('signature value is not a map')
    const entries = scVal.map() ?? []
    if (entries.length !== expectedKeys.length) authError('signature map field count mismatch')
    const out = new Map()
    for (const entry of entries) {
      if (entry.key().switch().name !== 'scvSymbol') authError('signature map key is not a symbol')
      out.set(entry.key().sym().toString(), entry.val())
    }
    if (out.size !== expectedKeys.length || expectedKeys.some((key) => !out.has(key))) {
      authError('signature map schema mismatch')
    }
    return out
  }

  function onlySignatureMap(credentials) {
    const signature = credentials.signature()
    if (signature.switch().name !== 'scvVec') authError('signature is not a signer vector')
    const signers = signature.vec() ?? []
    if (signers.length !== 1) authError('signature must contain exactly one signer')
    return signers[0]
  }

  function enforceSdkGAuthorization(tx, ownerAddress, currentLedger = 100) {
    const entry = tx.operations[0].auth[0]
    const credentials = entry.credentials().address()
    if (realSdk.Address.fromScAddress(credentials.address()).toString() !== ownerAddress) {
      authError('G authorizer mismatch')
    }
    if (Number(credentials.signatureExpirationLedger()) <= currentLedger) authError('expired')
    const signed = exactMap(onlySignatureMap(credentials), ['public_key', 'signature'])
    const publicKey = Buffer.from(signed.get('public_key').bytes())
    const signature = Buffer.from(signed.get('signature').bytes())
    const encoded = realSdk.StrKey.encodeEd25519PublicKey(publicKey)
    if (encoded !== ownerAddress) authError('G signing key does not equal authorizer')
    if (
      !realSdk.Keypair.fromPublicKey(ownerAddress).verify(canonicalAuthPayload(entry), signature)
    ) {
      authError('G signature is invalid')
    }
  }

  function enforcePasskeyAuthorization(tx, currentLedger = 100) {
    const entry = tx.operations[0].auth[0]
    const credentials = entry.credentials().address()
    const authorizer = realSdk.Address.fromScAddress(credentials.address()).toString()
    if (authorizer !== passkeyOwner) authError('C authorizer mismatch')
    if (Number(credentials.signatureExpirationLedger()) <= currentLedger) authError('expired')
    const outer = onlySignatureMap(credentials)
    if (outer.switch().name !== 'scvMap' || (outer.map() ?? []).length !== 1) {
      authError('C signature must contain one signer map entry')
    }
    const signerEntry = outer.map()[0]
    const signerId = signerEntry.key()
    if (signerId.switch().name !== 'scvVec') authError('C signer id is malformed')
    const signerParts = signerId.vec() ?? []
    if (
      signerParts.length !== 3 ||
      signerParts[0].switch().name !== 'scvSymbol' ||
      signerParts[0].sym().toString() !== 'External' ||
      signerParts[1].switch().name !== 'scvAddress' ||
      realSdk.Address.fromScAddress(signerParts[1].address()).toString() !== webauthnVerifier ||
      signerParts[2].switch().name !== 'scvBytes' ||
      !Buffer.from(signerParts[2].bytes()).equals(passkeyKeyData)
    ) {
      authError('C External signer id/key_data mismatch')
    }
    if (signerEntry.val().switch().name !== 'scvBytes')
      authError('C signature payload is malformed')
    const signatureData = realSdk.xdr.ScVal.fromXDR(signerEntry.val().bytes())
    const fields = exactMap(signatureData, ['authenticator_data', 'client_data', 'signature'])
    const authenticatorData = Buffer.from(fields.get('authenticator_data').bytes())
    const clientData = Buffer.from(fields.get('client_data').bytes())
    const signature = Buffer.from(fields.get('signature').bytes())
    if (authenticatorData.length < 37) authError('authenticator data is too short')
    if (!authenticatorData.subarray(0, 32).equals(createHash('sha256').update(rpId).digest())) {
      authError('RP ID hash mismatch')
    }
    if ((authenticatorData[32] & 0x05) !== 0x05)
      authError('user presence/verification flags missing')
    let client
    try {
      client = JSON.parse(clientData.toString('utf8'))
    } catch {
      authError('client data is not JSON')
    }
    if (
      client.type !== 'webauthn.get' ||
      client.challenge !== canonicalAuthPayload(entry).toString('base64url') ||
      client.origin !== origin ||
      client.crossOrigin !== false
    ) {
      authError('WebAuthn client data does not bind the canonical auth payload')
    }
    if (signature.length !== 64) authError('P-256 signature length mismatch')
    const curveOrder = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
    if (BigInt(`0x${signature.subarray(32).toString('hex')}`) > curveOrder / 2n) {
      authError('P-256 signature is not low-S')
    }
    const signedData = Buffer.concat([
      authenticatorData,
      createHash('sha256').update(clientData).digest(),
    ])
    const signerPublicKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: signerParts[2].bytes().subarray(1, 33).toString('base64url'),
        y: signerParts[2].bytes().subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    })
    if (
      !verifyP256(
        'sha256',
        signedData,
        { key: signerPublicKey, dsaEncoding: 'ieee-p1363' },
        signature
      )
    ) {
      authError('P-256 signature is invalid')
    }
  }

  function enforceAddressAuthorization(tx, currentLedger = 100) {
    if ((tx.operations ?? []).length !== 1) authError('operation count mismatch')
    const operation = tx.operations[0]
    if (operation.source) authError('operation source override')
    if ((operation.auth ?? []).length !== 1) authError('auth count mismatch')
    const entry = operation.auth[0]
    const root = entry.rootInvocation()
    if ((root.subInvocations() ?? []).length !== 0) authError('sibling invocation')
    if (
      root.function().switch().name !== 'sorobanAuthorizedFunctionTypeContractFn' ||
      !root.function().contractFn().toXDR().equals(operation.func.invokeContract().toXDR())
    ) {
      authError('auth root does not match operation')
    }
    const credentials = entry.credentials()
    if (credentials.switch().name === 'sorobanCredentialsSourceAccount') return
    if (credentials.switch().name !== 'sorobanCredentialsAddress') authError('credential kind')
    const authorizer = realSdk.Address.fromScAddress(credentials.address().address()).toString()
    if (authorizer.startsWith('G')) enforceSdkGAuthorization(tx, authorizer, currentLedger)
    else enforcePasskeyAuthorization(tx, currentLedger)
  }

  function realRpc(
    simulation = { transactionData: {}, result: { retval: {} } },
    { currentLedger = 100 } = {}
  ) {
    return {
      getLatestLedger: vi.fn(async () => ({ sequence: currentLedger })),
      simulateTransaction: vi.fn(async (tx) => {
        enforceAddressAuthorization(tx, currentLedger)
        return simulation
      }),
      sendTransaction: vi.fn(async () => ({ status: 'PENDING', hash: 'REALOUTER' })),
      getTransaction: vi.fn(async () => ({ status: 'SUCCESS' })),
    }
  }

  function canonicalAuthPayload(entry) {
    const credentials = entry.credentials().address()
    const preimage = realSdk.xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new realSdk.xdr.HashIdPreimageSorobanAuthorization({
        networkId: realSdk.hash(Buffer.from(PASS)),
        nonce: credentials.nonce(),
        signatureExpirationLedger: credentials.signatureExpirationLedger(),
        invocation: entry.rootInvocation(),
      })
    )
    return createHash('sha256').update(preimage.toXDR()).digest()
  }

  function submitReal(tx, overrides = {}) {
    const rpcServer = overrides.rpcServer || realRpc()
    const args = {
      xdr: tx.toXDR(),
      secret: relayer.secret(),
      passphrase: PASS,
      expectedNetworkPassphrase: PASS,
      vaultAddr: VAULT,
      tokenAddr: TOKEN,
      agentWasmHashes: [CURRENT_AGENT_HASH],
      getWasmHash: vi.fn(async () => CURRENT_AGENT_HASH),
      readAgentScope: vi.fn(async () => ({
        owner: overrides.ownerAddress || owner.publicKey(),
        target: VAULT,
        token: TOKEN,
        kind: 0,
        revoked: false,
      })),
      readAccountAuthorization: vi.fn(async (account) => ({
        account,
        masterWeight: 1,
        mediumThreshold: overrides.mediumThreshold ?? 1,
        signers: [],
      })),
      sdk: realSdk,
      rpcServer,
      pollIntervalMs: 0,
      ...overrides,
    }
    delete args.ownerAddress
    delete args.mediumThreshold
    return { promise: feeBumpAndSubmit(args), rpcServer }
  }

  beforeEach(() => _clearSeen())

  it('uses an SDK-produced cryptographically valid sponsored G authorization entry', async () => {
    const tx = await sponsoredGExitTx()
    expect(() => enforceSdkGAuthorization(tx, owner.publicKey())).not.toThrow()
  })

  it('takes valid signed XDR through current auth, enforcing simulation, real fee bump, and submission', async () => {
    const { promise, rpcServer } = submitReal(realExitTx())
    await expect(promise).resolves.toMatchObject({
      status: 'SUCCESS',
      relayer: relayer.publicKey(),
    })
    expect(rpcServer.simulateTransaction).toHaveBeenCalledOnce()
    const submitted = rpcServer.sendTransaction.mock.calls[0][0]
    expect(submitted).toBeInstanceOf(realSdk.FeeBumpTransaction)
  })

  it.each([
    ['missing signature', null],
    [
      'wrong hint',
      (tx) => {
        const signature = tx.signatures[0]
        tx.signatures[0] = new realSdk.xdr.DecoratedSignature({
          hint: Buffer.alloc(4, 0),
          signature: signature.signature(),
        })
      },
    ],
    [
      'invalid signature',
      (tx) => {
        const signature = tx.signatures[0]
        tx.signatures[0] = new realSdk.xdr.DecoratedSignature({
          hint: signature.hint(),
          signature: Buffer.alloc(64, 0),
        })
      },
    ],
  ])('rejects %s before simulation', async (_label, mutate) => {
    const tx = realExitTx({ sign: Boolean(mutate) })
    mutate?.(tx)
    const { promise, rpcServer } = submitReal(tx)
    await expect(promise).rejects.toThrow(/signature|hint/i)
    expect(rpcServer.simulateTransaction).not.toHaveBeenCalled()
    expect(rpcServer.sendTransaction).not.toHaveBeenCalled()
  })

  it('rejects valid crypto with insufficient current signer weight before simulation', async () => {
    const { promise, rpcServer } = submitReal(realExitTx(), { mediumThreshold: 2 })
    await expect(promise).rejects.toThrow(/threshold/i)
    expect(rpcServer.simulateTransaction).not.toHaveBeenCalled()
  })

  it.each([
    ['G', () => sponsoredGExitTx(), () => owner.publicKey()],
    ['C', () => sponsoredCExitTx(), () => passkeyOwner],
  ])(
    'takes a real sponsored %s auth entry through authorization, enforcing simulation, fee bump, and submission',
    async (_kind, build, ownerAddress) => {
      const tx = await build()
      const expectedOwner = ownerAddress()
      const signedAuthXdr = tx.operations[0].auth[0].toXDR('base64')
      const { promise, rpcServer } = submitReal(tx, { ownerAddress: expectedOwner })
      await expect(promise).resolves.toMatchObject({ status: 'SUCCESS' })
      const simulated = rpcServer.simulateTransaction.mock.calls[0][0]
      expect(simulated.operations[0].auth[0].toXDR('base64')).toBe(signedAuthXdr)
      expect(rpcServer.sendTransaction).toHaveBeenCalledOnce()
      expect(rpcServer.sendTransaction.mock.calls[0][0]).toBeInstanceOf(realSdk.FeeBumpTransaction)
    }
  )

  it.each([
    [
      'mutated sponsored G signature',
      async () => {
        const tx = await sponsoredGExitTx()
        replaceGSignature(tx, Buffer.alloc(64, 1))
        return { tx, ownerAddress: owner.publicKey() }
      },
    ],
    [
      'dummy sponsored G signature bytes',
      async () => {
        const tx = await sponsoredGExitTx()
        tx.operations[0].auth[0]
          .credentials()
          .address()
          .signature(realSdk.xdr.ScVal.scvBytes(Buffer.alloc(64, 7)))
        return { tx, ownerAddress: owner.publicKey() }
      },
    ],
    [
      'wrong sponsored G key',
      async () => ({
        tx: await sponsoredGExitTx({ signer: realSdk.Keypair.random() }),
        ownerAddress: owner.publicKey(),
      }),
    ],
    [
      'mutated sponsored C signature',
      async () => {
        const tx = sponsoredCExitTx()
        replaceCSignature(tx, Buffer.alloc(64, 2))
        return { tx, ownerAddress: passkeyOwner }
      },
    ],
    [
      'dummy sponsored C signature bytes',
      async () => {
        const tx = sponsoredCExitTx()
        tx.operations[0].auth[0]
          .credentials()
          .address()
          .signature(realSdk.xdr.ScVal.scvBytes(Buffer.alloc(64, 7)))
        return { tx, ownerAddress: passkeyOwner }
      },
    ],
    [
      'wrong sponsored C key',
      async () => ({
        tx: sponsoredCExitTx({ signingKey: wrongP256.privateKey }),
        ownerAddress: passkeyOwner,
      }),
    ],
  ])('rejects %s in enforcing simulation before fee-bump submission', async (_label, build) => {
    const { tx, ownerAddress } = await build()
    const { promise, rpcServer } = submitReal(tx, { ownerAddress })
    await expect(promise).rejects.toThrow(/auth|signature|signer/i)
    expect(rpcServer.simulateTransaction).toHaveBeenCalledOnce()
    expect(rpcServer.sendTransaction).not.toHaveBeenCalled()
  })

  it.each([
    ['expired sponsored G auth', () => sponsoredGExitTx({ expiration: 100 }), owner.publicKey()],
    ['expired sponsored C auth', () => sponsoredCExitTx({ expiration: 100 }), passkeyOwner],
  ])('rejects %s before fee-bump submission', async (_label, build, ownerAddress) => {
    const tx = await build()
    const { promise, rpcServer } = submitReal(tx, { ownerAddress })
    await expect(promise).rejects.toThrow(/expired/i)
    expect(rpcServer.sendTransaction).not.toHaveBeenCalled()
  })

  it('rejects an empty enforcing simulation response before fee-bump construction', async () => {
    const rpcServer = realRpc({})
    const { promise } = submitReal(realExitTx(), { rpcServer })
    await expect(promise).rejects.toThrow(/simulation/i)
    expect(rpcServer.sendTransaction).not.toHaveBeenCalled()
  })

  it.each([
    ['network', { expectedNetworkPassphrase: 'wrong network' }],
    ['vault contract', { vaultAddr: TOKEN }],
  ])('rejects canonical %s drift before sponsorship', async (_label, overrides) => {
    const { promise, rpcServer } = submitReal(realExitTx(), overrides)
    await expect(promise).rejects.toThrow(/network|vault|scope|allowlist|configured/i)
    expect(rpcServer.sendTransaction).not.toHaveBeenCalled()
  })
})

// ────────────────────────────── assertRelayableTransaction ──────────────────────────────

describe('assertRelayableTransaction — structural gate', () => {
  it('rejects a multi-operation tx', async () => {
    const tx = depositTx(VAULT, 'deposit')
    tx.operations.push(tx.operations[0])
    await expect(
      assertRelayableTransaction(tx, { sdk: sdkAddr, vaultAddr: VAULT })
    ).rejects.toThrow(RelayError)
  })
  it('rejects a non-invoke op', async () => {
    await expect(
      assertRelayableTransaction({ operations: [{ type: 'payment' }] }, { sdk: sdkAddr })
    ).rejects.toThrow(RelayError)
  })
  it('rejects a zero-operation tx', async () => {
    await expect(assertRelayableTransaction({ operations: [] }, { sdk: sdkAddr })).rejects.toThrow(
      RelayError
    )
  })
  it('rejects every contract when nothing is configured (deny by default)', async () => {
    await expect(
      assertRelayableTransaction(depositTx(VAULT, 'deposit'), { sdk: sdkAddr })
    ).rejects.toThrow(RelayError)
  })
})

describe('assertRelayableTransaction — vault deposit/redeem (unchanged)', () => {
  it('passes a single deposit op to the configured vault', async () => {
    await expect(
      assertRelayableTransaction(depositTx(VAULT, 'deposit'), { sdk: sdkAddr, vaultAddr: VAULT })
    ).resolves.toBeUndefined()
  })
  it('passes a vault redeem (F11 exit leg 1)', async () => {
    await expect(
      assertRelayableTransaction(depositTx(VAULT, 'redeem'), { sdk: sdkAddr, vaultAddr: VAULT })
    ).resolves.toBeUndefined()
  })
  it('rejects a call to a different contract', async () => {
    await expect(
      assertRelayableTransaction(depositTx('CWRONG', 'deposit'), { sdk: sdkAddr, vaultAddr: VAULT })
    ).rejects.toThrow(RelayError)
  })
  it('rejects a non-deposit/redeem vault function', async () => {
    await expect(
      assertRelayableTransaction(depositTx(VAULT, 'withdraw'), { sdk: sdkAddr, vaultAddr: VAULT })
    ).rejects.toThrow(RelayError)
  })
})

describe('assertRelayableTransaction — funding_router grant/pull (schema-validated)', () => {
  const grantArgs = [
    { __addr: 'GOWNER' },
    { __vec: [] },
    { __u32: 1000 },
    { __vec: [{ __addr: 'CAGENT' }] },
  ]
  const pullArgs = [{ __addr: 'CAGENT' }, { __amount: 500_000n }]

  it('rejects router.grant when no router is configured (fail closed)', async () => {
    await expect(
      assertRelayableTransaction(depositTx(ROUTER, 'grant', grantArgs), { sdk: sdkAddr })
    ).rejects.toThrow(RelayError)
  })
  it('passes router.grant with a well-formed argument schema', async () => {
    await expect(
      assertRelayableTransaction(depositTx(ROUTER, 'grant', grantArgs), {
        sdk: sdkAddr,
        routerAddrs: [ROUTER],
      })
    ).resolves.toBeUndefined()
  })
  it('passes router.pull with a well-formed argument schema', async () => {
    await expect(
      assertRelayableTransaction(depositTx(ROUTER, 'pull', pullArgs), {
        sdk: sdkAddr,
        routerAddrs: [ROUTER],
      })
    ).resolves.toBeUndefined()
  })
  it('rejects router.grant with the wrong argument count', async () => {
    await expect(
      assertRelayableTransaction(depositTx(ROUTER, 'grant', grantArgs.slice(0, 3)), {
        sdk: sdkAddr,
        routerAddrs: [ROUTER],
      })
    ).rejects.toThrow(RelayError)
  })
  it('rejects router.grant whose owner argument is not an address (schema mismatch)', async () => {
    const bad = [{ __vec: [] }, { __vec: [] }, { __u32: 1000 }, { __vec: [] }]
    await expect(
      assertRelayableTransaction(depositTx(ROUTER, 'grant', bad), {
        sdk: sdkAddr,
        routerAddrs: [ROUTER],
      })
    ).rejects.toThrow(RelayError)
  })
  it('rejects router.pull whose amount argument is not an i128 (schema mismatch)', async () => {
    const bad = [{ __addr: 'CAGENT' }, { __addr: 'CWRONGTYPE' }]
    await expect(
      assertRelayableTransaction(depositTx(ROUTER, 'pull', bad), {
        sdk: sdkAddr,
        routerAddrs: [ROUTER],
      })
    ).rejects.toThrow(RelayError)
  })
  it('rejects any other function on the configured router (no wider loosening)', async () => {
    await expect(
      assertRelayableTransaction(depositTx(ROUTER, 'sweep'), {
        sdk: sdkAddr,
        routerAddrs: [ROUTER],
      })
    ).rejects.toThrow(RelayError)
  })
  it('rejects grant/pull on a different contract even with the router configured', async () => {
    await expect(
      assertRelayableTransaction(depositTx('COTHER', 'pull', pullArgs), {
        sdk: sdkAddr,
        routerAddrs: [ROUTER],
      })
    ).rejects.toThrow(RelayError)
  })
  it('leaves the vault-deposit branch untouched when the router is configured', async () => {
    await expect(
      assertRelayableTransaction(depositTx(VAULT, 'deposit'), {
        sdk: sdkAddr,
        vaultAddr: VAULT,
        routerAddrs: [ROUTER],
      })
    ).resolves.toBeUndefined()
  })
  it('passes grant/pull on EITHER router when v1 and v2 are both listed (dual-support migration)', async () => {
    const routers = [ROUTER_V1, ROUTER_V2]
    await expect(
      assertRelayableTransaction(depositTx(ROUTER_V1, 'grant', grantArgs), {
        sdk: sdkAddr,
        routerAddrs: routers,
      })
    ).resolves.toBeUndefined()
    await expect(
      assertRelayableTransaction(depositTx(ROUTER_V2, 'pull', pullArgs), {
        sdk: sdkAddr,
        routerAddrs: routers,
      })
    ).resolves.toBeUndefined()
  })
})

describe('assertRelayableTransaction — funding_router grant_v3/pull_v3 (Task 4, schema-validated)', () => {
  const grantV3Args = [
    { __addr: 'GOWNER' },
    { __addr: 'CTOKEN' },
    { __amount: 300_000_000n },
    { __amount: 200_000_000n },
    { __u32: 1000 },
    { __vec: [{ __addr: 'CAGENT' }] },
  ]
  const pullV3Args = [
    { __bytes: Buffer.alloc(32, 1) },
    { __bytes: Buffer.alloc(32, 2) },
    { __addr: 'CAGENT' },
    { __amount: 500_000n },
  ]

  it('rejects router.grant_v3 when no router is configured (fail closed)', async () => {
    await expect(
      assertRelayableTransaction(depositTx(ROUTER, 'grant_v3', grantV3Args), { sdk: sdkAddr })
    ).rejects.toThrow(RelayError)
  })
  it('passes router.grant_v3 with a well-formed argument schema', async () => {
    await expect(
      assertRelayableTransaction(depositTx(ROUTER, 'grant_v3', grantV3Args), {
        sdk: sdkAddr,
        routerAddrs: [ROUTER],
      })
    ).resolves.toBeUndefined()
  })
  it('passes router.pull_v3 with a well-formed argument schema', async () => {
    await expect(
      assertRelayableTransaction(depositTx(ROUTER, 'pull_v3', pullV3Args), {
        sdk: sdkAddr,
        routerAddrs: [ROUTER],
      })
    ).resolves.toBeUndefined()
  })
  it('rejects router.grant_v3 with the wrong argument count', async () => {
    await expect(
      assertRelayableTransaction(depositTx(ROUTER, 'grant_v3', grantV3Args.slice(0, 5)), {
        sdk: sdkAddr,
        routerAddrs: [ROUTER],
      })
    ).rejects.toThrow(RelayError)
  })
  it('rejects router.grant_v3 whose token argument is not an address (schema mismatch)', async () => {
    const bad = [
      { __addr: 'GOWNER' },
      { __amount: 1n },
      { __amount: 300_000_000n },
      { __amount: 200_000_000n },
      { __u32: 1000 },
      { __vec: [] },
    ]
    await expect(
      assertRelayableTransaction(depositTx(ROUTER, 'grant_v3', bad), {
        sdk: sdkAddr,
        routerAddrs: [ROUTER],
      })
    ).rejects.toThrow(RelayError)
  })
  it('rejects router.pull_v3 whose permission_id is not 32 bytes (schema mismatch)', async () => {
    const bad = [
      { __bytes: Buffer.alloc(16, 1) },
      { __bytes: Buffer.alloc(32, 2) },
      { __addr: 'CAGENT' },
      { __amount: 500_000n },
    ]
    await expect(
      assertRelayableTransaction(depositTx(ROUTER, 'pull_v3', bad), {
        sdk: sdkAddr,
        routerAddrs: [ROUTER],
      })
    ).rejects.toThrow(RelayError)
  })
  it('rejects router.pull_v3 whose amount argument is not an i128 (schema mismatch)', async () => {
    const bad = [
      { __bytes: Buffer.alloc(32, 1) },
      { __bytes: Buffer.alloc(32, 2) },
      { __addr: 'CAGENT' },
      { __addr: 'CWRONGTYPE' },
    ]
    await expect(
      assertRelayableTransaction(depositTx(ROUTER, 'pull_v3', bad), {
        sdk: sdkAddr,
        routerAddrs: [ROUTER],
      })
    ).rejects.toThrow(RelayError)
  })
  it('rejects grant_v3/pull_v3 on a different contract even with the router configured', async () => {
    await expect(
      assertRelayableTransaction(depositTx('COTHER', 'pull_v3', pullV3Args), {
        sdk: sdkAddr,
        routerAddrs: [ROUTER],
      })
    ).rejects.toThrow(RelayError)
  })
  it('rejects any other function on the configured router (no wider loosening)', async () => {
    await expect(
      assertRelayableTransaction(depositTx(ROUTER, 'sweep'), {
        sdk: sdkAddr,
        routerAddrs: [ROUTER],
      })
    ).rejects.toThrow(RelayError)
  })
})

describe('assertRelayableTransaction — exit_router sweep (one-popup full exit)', () => {
  const sweepArgs = (to) => [
    { __addr: 'GOWNER' },
    { __vec: [{ __addr: 'CAGENT1' }, { __addr: 'CAGENT2' }] },
    { __addr: to },
  ]

  it('passes sweep when to === owner and every agent is a pinned wasm', async () => {
    const getWasmHash = vi.fn(async () => AGENT_HASH)
    await expect(
      assertRelayableTransaction(depositTx(EXIT_ROUTER, 'sweep', sweepArgs('GOWNER')), {
        sdk: sdkAddr,
        exitRouterAddr: EXIT_ROUTER,
        agentWasmHashes: [AGENT_HASH],
        getWasmHash,
      })
    ).resolves.toBeUndefined()
    expect(getWasmHash).toHaveBeenCalledWith('CAGENT1')
    expect(getWasmHash).toHaveBeenCalledWith('CAGENT2')
  })
  it('rejects sweep when to !== owner (recipient must be the sweeping owner)', async () => {
    const getWasmHash = vi.fn(async () => AGENT_HASH)
    await expect(
      assertRelayableTransaction(depositTx(EXIT_ROUTER, 'sweep', sweepArgs('GATTACKER')), {
        sdk: sdkAddr,
        exitRouterAddr: EXIT_ROUTER,
        agentWasmHashes: [AGENT_HASH],
        getWasmHash,
      })
    ).rejects.toThrow(RelayError)
  })
  it('rejects sweep when any listed agent is not a pinned wasm', async () => {
    const getWasmHash = vi.fn(async (addr) =>
      addr === 'CAGENT2' ? 'deadbeef'.repeat(8) : AGENT_HASH
    )
    await expect(
      assertRelayableTransaction(depositTx(EXIT_ROUTER, 'sweep', sweepArgs('GOWNER')), {
        sdk: sdkAddr,
        exitRouterAddr: EXIT_ROUTER,
        agentWasmHashes: [AGENT_HASH],
        getWasmHash,
      })
    ).rejects.toThrow(RelayError)
  })
  it('rejects sweep with an empty agents vec', async () => {
    await expect(
      assertRelayableTransaction(
        depositTx(EXIT_ROUTER, 'sweep', [
          { __addr: 'GOWNER' },
          { __vec: [] },
          { __addr: 'GOWNER' },
        ]),
        {
          sdk: sdkAddr,
          exitRouterAddr: EXIT_ROUTER,
          agentWasmHashes: [AGENT_HASH],
          getWasmHash: vi.fn(),
        }
      )
    ).rejects.toThrow(RelayError)
  })
  it('rejects sweep when the exit router is not configured (fail closed)', async () => {
    await expect(
      assertRelayableTransaction(depositTx(EXIT_ROUTER, 'sweep', sweepArgs('GOWNER')), {
        sdk: sdkAddr,
        agentWasmHashes: [AGENT_HASH],
        getWasmHash: vi.fn(async () => AGENT_HASH),
      })
    ).rejects.toThrow(RelayError)
  })
  it('rejects a non-sweep function on the exit router', async () => {
    await expect(
      assertRelayableTransaction(depositTx(EXIT_ROUTER, 'revoke'), {
        sdk: sdkAddr,
        exitRouterAddr: EXIT_ROUTER,
      })
    ).rejects.toThrow(RelayError)
  })
  it('rejects sweep when no agent wasm pin is configured at all (fail closed)', async () => {
    await expect(
      assertRelayableTransaction(depositTx(EXIT_ROUTER, 'sweep', sweepArgs('GOWNER')), {
        sdk: sdkAddr,
        exitRouterAddr: EXIT_ROUTER,
      })
    ).rejects.toThrow(RelayError)
  })
})

describe('assertRelayableTransaction — pinned agent: revoke / owner_withdraw / set_exit_signer', () => {
  const AGENT = 'CAGENTPINNED'
  const cfg = (over = {}) => ({
    sdk: sdkAddr,
    agentWasmHashes: [AGENT_HASH],
    getWasmHash: vi.fn(async () => AGENT_HASH),
    ...over,
  })

  it('passes agent.revoke() on a pinned agent with no arguments', async () => {
    await expect(
      assertRelayableTransaction(depositTx(AGENT, 'revoke'), cfg())
    ).resolves.toBeUndefined()
  })
  it('rejects agent.revoke() carrying unexpected arguments', async () => {
    await expect(
      assertRelayableTransaction(depositTx(AGENT, 'revoke', [{ __addr: 'GX' }]), cfg())
    ).rejects.toThrow(RelayError)
  })
  it('rejects agent.owner_withdraw without canonical XDR/auth/scope proof', async () => {
    await expect(
      assertRelayableTransaction(depositTx(AGENT, 'owner_withdraw', [{ __addr: 'GOWNER' }]), cfg())
    ).rejects.toThrow(RelayError)
  })
  it('rejects agent.owner_withdraw with a missing/malformed to argument', async () => {
    await expect(
      assertRelayableTransaction(depositTx(AGENT, 'owner_withdraw', []), cfg())
    ).rejects.toThrow(RelayError)
    await expect(
      assertRelayableTransaction(depositTx(AGENT, 'owner_withdraw', [{ __amount: 1n }]), cfg())
    ).rejects.toThrow(RelayError)
  })
  it('passes agent.set_exit_signer(bytes32)', async () => {
    await expect(
      assertRelayableTransaction(
        depositTx(AGENT, 'set_exit_signer', [{ __bytes: Buffer.alloc(32, 7) }]),
        cfg()
      )
    ).resolves.toBeUndefined()
  })
  it('rejects agent.set_exit_signer with a wrong-length key', async () => {
    await expect(
      assertRelayableTransaction(
        depositTx(AGENT, 'set_exit_signer', [{ __bytes: Buffer.alloc(16) }]),
        cfg()
      )
    ).rejects.toThrow(RelayError)
  })
  it('rejects an unrelayable function on an otherwise-pinned agent', async () => {
    await expect(
      assertRelayableTransaction(
        depositTx(AGENT, 'deposit', [{ __addr: 'X' }, { __amount: 1n }]),
        cfg()
      )
    ).rejects.toThrow(RelayError)
  })
  it('rejects when the contract is not a pinned agent wasm (fail closed, unknown contract)', async () => {
    const getWasmHash = vi.fn(async () => 'deadbeef'.repeat(8))
    await expect(
      assertRelayableTransaction(depositTx('CUNKNOWN', 'revoke'), cfg({ getWasmHash }))
    ).rejects.toThrow(RelayError)
  })
  it('rejects every pinned-agent action when no wasm pin is configured at all (fail closed)', async () => {
    await expect(
      assertRelayableTransaction(depositTx(AGENT, 'revoke'), { sdk: sdkAddr })
    ).rejects.toThrow(RelayError)
  })
  it('rejects (fail closed) when the wasm lookup itself throws', async () => {
    const getWasmHash = vi.fn(async () => {
      throw new Error('rpc down')
    })
    await expect(
      assertRelayableTransaction(depositTx(AGENT, 'revoke'), cfg({ getWasmHash }))
    ).rejects.toThrow(RelayError)
  })
  it('does NOT accept an allowlist-only match (agentAllowlist is scoped to token transfers, not agent actions)', async () => {
    await expect(
      assertRelayableTransaction(depositTx(AGENT, 'revoke'), {
        sdk: sdkAddr,
        agentAllowlist: AGENT, // present in the allowlist, but NOT wasm-pinned
      })
    ).rejects.toThrow(RelayError)
  })
})

describe('assertRelayableTransaction — token approve (SEP-41 revoke path)', () => {
  const args = (amount, spender, from = 'CWALLET') => [
    { __addr: from },
    { __addr: spender },
    { __amount: amount },
    { __u32: 1000 },
  ]
  const cfg = (over = {}) => ({
    sdk: sdkAddr,
    tokenAddr: TOKEN,
    routerAddrs: [ROUTER],
    accountWasmHash: SAK_WASM,
    getWasmHash: vi.fn(async () => SAK_WASM),
    ...over,
  })

  it('passes a zero-amount approve from the pinned smart-account wasm to an allowed router', async () => {
    await expect(
      assertRelayableTransaction(depositTx(TOKEN, 'approve', args(0n, ROUTER)), cfg())
    ).resolves.toBeUndefined()
  })
  it('rejects a positive-amount approval (never a generic/arbitrary approve)', async () => {
    await expect(
      assertRelayableTransaction(depositTx(TOKEN, 'approve', args(1n, ROUTER)), cfg())
    ).rejects.toThrow(RelayError)
  })
  it('rejects when spender is not an allowed router', async () => {
    await expect(
      assertRelayableTransaction(depositTx(TOKEN, 'approve', args(0n, 'CNOTAROUTER')), cfg())
    ).rejects.toThrow(RelayError)
  })
  it('rejects when from does not run the pinned smart-account wasm', async () => {
    const getWasmHash = vi.fn(async () => 'deadbeef'.repeat(8))
    await expect(
      assertRelayableTransaction(
        depositTx(TOKEN, 'approve', args(0n, ROUTER)),
        cfg({ getWasmHash })
      )
    ).rejects.toThrow(RelayError)
  })
  it('rejects when no smart-account wasm pin is configured (fail closed)', async () => {
    await expect(
      assertRelayableTransaction(
        depositTx(TOKEN, 'approve', args(0n, ROUTER)),
        cfg({ accountWasmHash: '' })
      )
    ).rejects.toThrow(RelayError)
  })
  it('rejects (fail closed) when the wasm lookup itself throws', async () => {
    const getWasmHash = vi.fn(async () => {
      throw new Error('rpc down')
    })
    await expect(
      assertRelayableTransaction(
        depositTx(TOKEN, 'approve', args(0n, ROUTER)),
        cfg({ getWasmHash })
      )
    ).rejects.toThrow(RelayError)
  })
  it('rejects a malformed approve argument schema', async () => {
    await expect(
      assertRelayableTransaction(
        depositTx(TOKEN, 'approve', [{ __addr: 'CWALLET' }, { __addr: ROUTER }]),
        cfg()
      )
    ).rejects.toThrow(RelayError)
  })
})

describe('assertRelayableTransaction — token transfer (F11 exit-leg-2 / partial-withdraw leg 2)', () => {
  it('passes a token transfer from an allowlisted agent to a G-owner recipient', async () => {
    const tx = depositTx(TOKEN, 'transfer', [
      { __addr: 'CAGENT' },
      { __addr: 'GOWNER' },
      { __amount: 10n },
    ])
    await expect(
      assertRelayableTransaction(tx, { sdk: sdkAddr, tokenAddr: TOKEN, agentAllowlist: 'CAGENT' })
    ).resolves.toBeUndefined()
  })
  it('rejects a token transfer from a G account (relayer is not a public gas faucet)', async () => {
    const tx = depositTx(TOKEN, 'transfer', [
      { __addr: 'GSOMEONE' },
      { __addr: 'GOWNER' },
      { __amount: 10n },
    ])
    await expect(
      assertRelayableTransaction(tx, { sdk: sdkAddr, tokenAddr: TOKEN, agentAllowlist: 'CAGENT' })
    ).rejects.toThrow(RelayError)
  })
  it('rejects a token transfer when tokenAddr is not configured (fail closed)', async () => {
    const tx = depositTx(TOKEN, 'transfer', [
      { __addr: 'CAGENT' },
      { __addr: 'GOWNER' },
      { __amount: 10n },
    ])
    await expect(
      assertRelayableTransaction(tx, { sdk: sdkAddr, agentAllowlist: 'CAGENT' })
    ).rejects.toThrow(RelayError)
  })
  it('rejects a non-allowlisted contract address (attacker custom account)', async () => {
    const tx = depositTx(TOKEN, 'transfer', [
      { __addr: 'CATTACKER' },
      { __addr: 'GOWNER' },
      { __amount: 10n },
    ])
    await expect(
      assertRelayableTransaction(tx, { sdk: sdkAddr, tokenAddr: TOKEN, agentAllowlist: 'CAGENT' })
    ).rejects.toThrow(RelayError)
  })
  it('rejects every transfer when the allowlist is empty and no wasm pin is set (fail closed)', async () => {
    const tx = depositTx(TOKEN, 'transfer', [
      { __addr: 'CAGENT' },
      { __addr: 'GOWNER' },
      { __amount: 10n },
    ])
    await expect(
      assertRelayableTransaction(tx, { sdk: sdkAddr, tokenAddr: TOKEN })
    ).rejects.toThrow(RelayError)
  })
  it('accepts a multi-entry allowlist, matching any listed agent (trims whitespace, ignores empty segments)', async () => {
    const tx = depositTx(TOKEN, 'transfer', [
      { __addr: 'CAGENT2' },
      { __addr: 'GOWNER' },
      { __amount: 10n },
    ])
    const list = ' CAGENT1 , CAGENT2 ,,CAGENT3 '
    await expect(
      assertRelayableTransaction(tx, { sdk: sdkAddr, tokenAddr: TOKEN, agentAllowlist: list })
    ).resolves.toBeUndefined()
  })
  it('rejects non-transfer/approve token functions', async () => {
    const tx = depositTx(TOKEN, 'burn', [{ __addr: 'CAGENT' }])
    await expect(
      assertRelayableTransaction(tx, { sdk: sdkAddr, tokenAddr: TOKEN })
    ).rejects.toThrow(RelayError)
  })
  it('sponsors a transfer from a NON-allowlisted agent whose wasm hash matches the pin', async () => {
    const tx = depositTx(TOKEN, 'transfer', [
      { __addr: 'CDYNAMIC' },
      { __addr: 'GOWNER' },
      { __amount: 10n },
    ])
    const getWasmHash = vi.fn(async () => AGENT_HASH)
    await expect(
      assertRelayableTransaction(tx, {
        sdk: sdkAddr,
        tokenAddr: TOKEN,
        agentWasmHashes: [AGENT_HASH],
        getWasmHash,
      })
    ).resolves.toBeUndefined()
    expect(getWasmHash).toHaveBeenCalledWith('CDYNAMIC')
  })
  it('rejects when the wasm hash does not match', async () => {
    const tx = depositTx(TOKEN, 'transfer', [
      { __addr: 'CEVIL' },
      { __addr: 'GOWNER' },
      { __amount: 10n },
    ])
    const getWasmHash = async () => 'deadbeef'.repeat(8)
    await expect(
      assertRelayableTransaction(tx, {
        sdk: sdkAddr,
        tokenAddr: TOKEN,
        agentWasmHashes: [AGENT_HASH],
        getWasmHash,
      })
    ).rejects.toThrow(RelayError)
  })
  it('env-allowlisted agent still passes WITHOUT a wasm lookup', async () => {
    const tx = depositTx(TOKEN, 'transfer', [
      { __addr: 'CDEMO' },
      { __addr: 'GOWNER' },
      { __amount: 10n },
    ])
    const getWasmHash = vi.fn()
    await expect(
      assertRelayableTransaction(tx, {
        sdk: sdkAddr,
        tokenAddr: TOKEN,
        agentAllowlist: 'CDEMO',
        agentWasmHashes: [AGENT_HASH],
        getWasmHash,
      })
    ).resolves.toBeUndefined()
    expect(getWasmHash).not.toHaveBeenCalled()
  })

  // ── new in Task 5: recipient + amount validation (partial-withdraw / F11-leg-2 hardening) ──
  it('rejects a non-positive transfer amount', async () => {
    const tx = depositTx(TOKEN, 'transfer', [
      { __addr: 'CAGENT' },
      { __addr: 'GOWNER' },
      { __amount: 0n },
    ])
    await expect(
      assertRelayableTransaction(tx, { sdk: sdkAddr, tokenAddr: TOKEN, agentAllowlist: 'CAGENT' })
    ).rejects.toThrow(RelayError)
  })
  it('rejects a transfer to a recipient that is neither a G account nor the pinned smart-account wasm', async () => {
    const tx = depositTx(TOKEN, 'transfer', [
      { __addr: 'CAGENT' },
      { __addr: 'CRANDOMCONTRACT' },
      { __amount: 10n },
    ])
    const getWasmHash = vi.fn(async () => 'deadbeef'.repeat(8)) // never the pinned SAK_WASM
    await expect(
      assertRelayableTransaction(tx, {
        sdk: sdkAddr,
        tokenAddr: TOKEN,
        agentAllowlist: 'CAGENT', // from-check short-circuits on the allowlist, so only `to` is at stake
        accountWasmHash: SAK_WASM,
        getWasmHash,
      })
    ).rejects.toThrow(RelayError)
  })
  it('passes a transfer to a C recipient running the pinned VF smart-account wasm (passkey owner)', async () => {
    const tx = depositTx(TOKEN, 'transfer', [
      { __addr: 'CAGENT' },
      { __addr: 'CPASSKEYOWNER' },
      { __amount: 10n },
    ])
    const getWasmHash = vi.fn(async (addr) => (addr === 'CPASSKEYOWNER' ? SAK_WASM : null))
    await expect(
      assertRelayableTransaction(tx, {
        sdk: sdkAddr,
        tokenAddr: TOKEN,
        agentAllowlist: 'CAGENT',
        accountWasmHash: SAK_WASM,
        getWasmHash,
      })
    ).resolves.toBeUndefined()
  })
})

describe('assertRelayableTransaction - smart-account deploy sponsorship (SAK createWallet)', () => {
  it('passes a createContractV2 deploy of the pinned smart-account wasm', async () => {
    const tx = deployTx(SAK_WASM)
    await expect(
      assertRelayableTransaction(tx, { sdk: sdkAddr, accountWasmHash: SAK_WASM })
    ).resolves.toBeUndefined()
  })
  it('rejects a deploy of any other wasm (attacker contract gets no free deploy)', async () => {
    const tx = deployTx('deadbeef'.repeat(8))
    await expect(
      assertRelayableTransaction(tx, { sdk: sdkAddr, accountWasmHash: SAK_WASM })
    ).rejects.toThrow(RelayError)
  })
  it('rejects every deploy when no wasm hash is pinned (fail closed, default param)', async () => {
    const tx = deployTx(SAK_WASM)
    await expect(assertRelayableTransaction(tx, { sdk: sdkAddr })).rejects.toThrow(RelayError)
  })
  it('rejects a non-wasm executable (stellar-asset SAC deploy is not a smart account)', async () => {
    const tx = deployTx(SAK_WASM, 'contractExecutableStellarAsset')
    await expect(
      assertRelayableTransaction(tx, { sdk: sdkAddr, accountWasmHash: SAK_WASM })
    ).rejects.toThrow(RelayError)
  })
  it('still rejects V1 createContract (SAK posts V2 only - anything else stays closed)', async () => {
    const tx = deployTx(SAK_WASM)
    tx.operations[0].func.switch = () => ({ name: 'hostFunctionTypeCreateContract' })
    await expect(
      assertRelayableTransaction(tx, { sdk: sdkAddr, accountWasmHash: SAK_WASM })
    ).rejects.toThrow(RelayError)
  })
})

describe('assertRelayableTransaction - CCTP messenger deposit_for_burn', () => {
  const AGENT_HASH_V3 = '1fdbe175ddeb6d237a178c3c117b4e6c168122eec7d94f06a4b27ee4026efbe1'

  it('sponsors deposit_for_burn when from (args[0]) is a pinned agent_account wasm', async () => {
    const tx = depositTx(MESSENGER, 'deposit_for_burn', [{ __addr: 'CAGENTV3' }])
    const getWasmHash = vi.fn(async () => AGENT_HASH_V3)
    await expect(
      assertRelayableTransaction(tx, {
        sdk: sdkAddr,
        agentWasmHashes: [AGENT_HASH_V3],
        getWasmHash,
        messengerAddr: MESSENGER,
      })
    ).resolves.toBeUndefined()
    expect(getWasmHash).toHaveBeenCalledWith('CAGENTV3')
  })
  it('rejects deposit_for_burn when from runs a foreign (non-pinned) wasm', async () => {
    const tx = depositTx(MESSENGER, 'deposit_for_burn', [{ __addr: 'CFOREIGN' }])
    const getWasmHash = async () => 'deadbeef'.repeat(8)
    await expect(
      assertRelayableTransaction(tx, {
        sdk: sdkAddr,
        agentWasmHashes: [AGENT_HASH_V3],
        getWasmHash,
        messengerAddr: MESSENGER,
      })
    ).rejects.toThrow(RelayError)
  })
  it('rejects deposit_for_burn when the messenger env is unset (fail closed, default param)', async () => {
    const tx = depositTx(MESSENGER, 'deposit_for_burn', [{ __addr: 'CAGENTV3' }])
    // Falls through to the pinned-agent branch (does MESSENGER itself run a pinned wasm?) — a
    // real messenger contract never does, so getWasmHash(MESSENGER) here stands in for "no",
    // and the transaction still gets rejected because deposit_for_burn is not a relayable
    // pinned-agent function either.
    const getWasmHash = vi.fn(async () => null)
    await expect(
      assertRelayableTransaction(tx, {
        sdk: sdkAddr,
        agentWasmHashes: [AGENT_HASH_V3],
        getWasmHash,
      })
    ).rejects.toThrow(RelayError)
  })
  it('rejects any other function on the messenger contract (only deposit_for_burn is relayable)', async () => {
    const tx = depositTx(MESSENGER, 'deposit', [{ __addr: 'CAGENTV3' }])
    const getWasmHash = vi.fn(async () => AGENT_HASH_V3)
    await expect(
      assertRelayableTransaction(tx, {
        sdk: sdkAddr,
        agentWasmHashes: [AGENT_HASH_V3],
        getWasmHash,
        messengerAddr: MESSENGER,
      })
    ).rejects.toThrow(RelayError)
  })
  it('rejects deposit_for_burn from a wasm hash outside the pinned list, even with the messenger configured', async () => {
    const tx = depositTx(MESSENGER, 'deposit_for_burn', [{ __addr: 'CV1AGENT' }])
    const getWasmHash = async () => 'cafebabe'.repeat(8)
    await expect(
      assertRelayableTransaction(tx, {
        sdk: sdkAddr,
        agentWasmHashes: ['cafed00d'.repeat(8)],
        getWasmHash,
        messengerAddr: MESSENGER,
      })
    ).rejects.toThrow(RelayError)
  })
})

// ─────────────────── real XDR structures (built via @stellar/stellar-sdk, not mocks) ───────────────────
// A handful of round-tripped, genuinely-built Soroban operations — exercises the actual
// Address/scValToNative decode path the production handler uses, not just the fake sdkAddr above.

describe('assertRelayableTransaction — real XDR (round-tripped through the actual SDK)', () => {
  const RELAYER_G = 'GA2RIV5IILMNAL2U6ZT5RP5YVIAIN7MRDMAAVKAKUZYNTF2PIR7D2DFG'
  // Real, checksum-valid testnet strkeys (deployments/stellar-testnet.json) — the fake-fixture
  // constants above (ROUTER, EXIT_ROUTER, ...) are NOT valid strkeys and would fail `new Contract`.
  const REAL_ROUTER = 'CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE'
  const REAL_EXIT_ROUTER = 'CDGDIPHBN3MSNURDX33IZBXXQTJPT7THAXSMVBAIOIXLOA6OF32IRS2J'
  const REAL_AGENT = MESSENGER // any valid C-strkey stands in for an agent address here

  async function realOp(build) {
    const mod = await import('@stellar/stellar-sdk')
    const { TransactionBuilder, Account, BASE_FEE } = mod
    const acct = new Account(RELAYER_G, '100')
    const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: PASS })
      .addOperation(build(mod))
      .setTimeout(30)
      .build()
    const back = TransactionBuilder.fromXDR(tx.toEnvelope().toXDR('base64'), PASS)
    return { inner: back, sdk: { Address: mod.Address, scValToNative: mod.scValToNative } }
  }

  it('passes a real router.grant operation with a well-formed schema', async () => {
    const { inner, sdk } = await realOp(({ Contract, Address, xdr, nativeToScVal }) =>
      new Contract(REAL_ROUTER).call(
        'grant',
        new Address(RELAYER_G).toScVal(),
        xdr.ScVal.scvVec([]),
        nativeToScVal(1000, { type: 'u32' }),
        xdr.ScVal.scvVec([])
      )
    )
    await expect(
      assertRelayableTransaction(inner, { sdk, routerAddrs: [REAL_ROUTER] })
    ).resolves.toBeUndefined()
  })

  it('rejects a real router.grant operation with an extra argument (schema mismatch)', async () => {
    const { inner, sdk } = await realOp(({ Contract, Address, xdr, nativeToScVal }) =>
      new Contract(REAL_ROUTER).call(
        'grant',
        new Address(RELAYER_G).toScVal(),
        xdr.ScVal.scvVec([]),
        nativeToScVal(1000, { type: 'u32' }),
        xdr.ScVal.scvVec([]),
        xdr.ScVal.scvVoid() // unexpected 5th argument
      )
    )
    await expect(
      assertRelayableTransaction(inner, { sdk, routerAddrs: [REAL_ROUTER] })
    ).rejects.toThrow(RelayError)
  })

  it('passes a real agent.revoke() operation on a pinned-wasm agent', async () => {
    const { inner, sdk } = await realOp(({ Contract }) => new Contract(REAL_AGENT).call('revoke'))
    await expect(
      assertRelayableTransaction(inner, {
        sdk,
        agentWasmHashes: [AGENT_HASH],
        getWasmHash: async () => AGENT_HASH,
      })
    ).resolves.toBeUndefined()
  })

  it('rejects a real exit_router.sweep operation whose to differs from owner', async () => {
    const { inner, sdk } = await realOp(({ Contract, Address, xdr }) =>
      new Contract(REAL_EXIT_ROUTER).call(
        'sweep',
        new Address(RELAYER_G).toScVal(),
        xdr.ScVal.scvVec([new Address(REAL_AGENT).toScVal()]),
        new Address(REAL_AGENT).toScVal() // to = an agent, not the owner
      )
    )
    await expect(
      assertRelayableTransaction(inner, {
        sdk,
        exitRouterAddr: REAL_EXIT_ROUTER,
        agentWasmHashes: [AGENT_HASH],
        getWasmHash: async () => AGENT_HASH,
      })
    ).rejects.toThrow(RelayError)
  })
})
