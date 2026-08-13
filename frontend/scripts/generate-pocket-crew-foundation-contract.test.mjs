import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test as nodeTest } from 'node:test'
import { fileURLToPath } from 'node:url'

const test = process.env.VITEST_WORKER_ID ? (await import('vitest')).test : nodeTest

import { resolveAgentIdentity } from '../src/design/pocket-crew-foundation.js'
import {
  assertPocketCrewFoundationContract,
  assertPocketCrewVisualFixtureSafe,
  buildPocketCrewFoundationContract,
  serializePocketCrewFoundationContract,
} from './generate-pocket-crew-foundation-contract.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ARTIFACT_PATH = path.resolve(
  HERE,
  '../src/wallet/ui/pocketCrewFoundationContract.generated.json'
)

const CONTRACT_KEYS = [
  'version',
  'themes',
  'sharedTokens',
  'crewTokens',
  'mobileOverrides',
  'breakpoints',
  'motion',
  'layers',
  'assetPaths',
]

const FORBIDDEN_KEYS = [
  'privateKey',
  'private_key',
  'key',
  'keyMaterial',
  'mnemonic',
  'seed',
  'secret',
  'secretKey',
  'secret_key',
  'clientSecret',
  'client_secret',
  'apiKey',
  'api_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'sessionKey',
  'session_key',
  'signer',
  'signerKey',
  'signerSecret',
  'signerAddress',
  'capability',
  'capabilityKey',
  'capabilityToken',
  'relayer',
  'relayerSecret',
  'relayer_secret',
  'password',
  'passphrase',
  'credential',
  'address',
  'sourceAddress',
  'destinationAddress',
  'owner',
  'ownerAddress',
  'agentAddress',
  'vaultAddress',
  'tokenAddress',
  'contractAddress',
  'account',
  'accountId',
  'accountAddress',
  'allocationId',
  'runId',
  'kernel',
  'kernelAddress',
  'session',
  'sessionKeyAddress',
  'relayerOrigin',
  'from',
  'to',
  'custody',
  'custodian',
  'custodyState',
  'custodyType',
  'walletState',
  'route',
  'rpcUrl',
  'networkEndpoint',
  'private',
]

const FORBIDDEN_KEY_PATTERN =
  /(?:private|secret|mnemonic|seed|password|passphrase|credential|signer|capability|relayer|custod|address|owner|account|kernel|session|wallet.?state|route|rpc|network.?endpoint)/iu

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseKeys(child)])
  )
}

function nestedForbiddenValue(key) {
  return { allowed: [{ deeper: { [key]: 'must fail' } }] }
}

function cloneContract() {
  return JSON.parse(JSON.stringify(buildPocketCrewFoundationContract()))
}

test('publishes the exact nine-key contract and byte-stable generated artifact', () => {
  const inMemory = buildPocketCrewFoundationContract()
  const serialized = serializePocketCrewFoundationContract(inMemory)
  const artifact = readFileSync(ARTIFACT_PATH, 'utf8')

  assert.deepEqual(Object.keys(inMemory).sort(), [...CONTRACT_KEYS].sort())
  assert.deepEqual(JSON.parse(artifact), inMemory)
  assert.equal(serialized, artifact)
  assert.equal(serialized, `${JSON.stringify(JSON.parse(serialized), null, 2)}\n`)
  assert.equal(serialized.endsWith('\n'), true)
  assert.equal(serialized.endsWith('\n\n'), false)
  assert.equal(/\t/u.test(serialized), false)

  const reordered = reverseKeys(inMemory)
  assert.equal(
    serializePocketCrewFoundationContract(reordered),
    serialized,
    'recursive key order must not depend on source insertion order'
  )
})

test('rejects forbidden keys recursively while allowing public-looking display values', () => {
  const contract = buildPocketCrewFoundationContract()
  assert.doesNotThrow(() => assertPocketCrewFoundationContract(contract))
  assert.doesNotThrow(() =>
    assertPocketCrewVisualFixtureSafe({
      display: 'GABC123PUBLICDISPLAYONLY',
      label: 'Stellar testnet',
      nested: [{ copy: 'A public address may be displayed as a value.' }],
    })
  )

  for (const key of FORBIDDEN_KEYS) {
    assert.throws(
      () => assertPocketCrewVisualFixtureSafe(nestedForbiddenValue(key)),
      new RegExp(`forbidden.*${key}`, 'iu'),
      `must reject forbidden key ${key}`
    )
    assert.throws(
      () => assertPocketCrewVisualFixtureSafe(nestedForbiddenValue(key.toUpperCase())),
      /forbidden key/iu,
      `must reject case variant ${key}`
    )
  }

  for (const key of [
    'customPrivateMaterial',
    'secretPayload',
    'destination_address',
    'wallet-state',
    'rpc_endpoint',
    'networkEndpointUrl',
  ]) {
    assert.equal(FORBIDDEN_KEY_PATTERN.test(key), true)
    assert.throws(
      () => assertPocketCrewVisualFixtureSafe(nestedForbiddenValue(key)),
      /forbidden key/iu,
      `must reject regex variant ${key}`
    )
  }

  for (const key of ['address', 'owner', 'custody', 'signerAddress', 'accountAddress']) {
    assert.throws(
      () => assertPocketCrewFoundationContract({ ...contract, [key]: 'must fail' }),
      /contract key|forbidden key|unexpected:/iu,
      `must reject top-level ${key}`
    )
  }

  assert.throws(
    () => assertPocketCrewFoundationContract({ ...contract, unsupported: true }),
    /exactly.*nine|unexpected.*key|contract key/iu
  )
  assert.throws(
    () => assertPocketCrewFoundationContract({ ...contract, address: 'GDISPLAYONLY' }),
    /contract key|forbidden key|unexpected:/iu
  )
})

test('allows only current foundation token names through the route-key scanner bypass', () => {
  const currentToken = cloneContract()
  currentToken.sharedTokens['--pc-route-gutter'] = '16px'
  assert.doesNotThrow(() => assertPocketCrewFoundationContract(currentToken))

  const unknownToken = cloneContract()
  unknownToken.sharedTokens['--pc-route-secret'] = 'must fail'
  assert.throws(() => assertPocketCrewFoundationContract(unknownToken), /forbidden key|route/iu)
})

test('keeps planned AgentMark identity props outside the serialized contract boundary', () => {
  const identity = resolveAgentIdentity({
    phase: 'planned',
    allocationId: 'allocation-reviewed-1',
    runId: 'run-reviewed-1',
    source: 'reviewed-plan',
  })

  assert.equal(identity.phase, 'planned')
  assert.equal(identity.key, 'allocation-reviewed-1')
  assert.equal(identity.address, null)
  assert.equal(identity.verified, false)
  assert.equal(JSON.stringify(identity).includes('GPUBLIC'), false)
  assert.equal(JSON.stringify(identity).includes('SSECRET'), false)
  assert.doesNotThrow(() => assertPocketCrewFoundationContract(buildPocketCrewFoundationContract()))
})

test('fails closed before a changing getter can be read twice during serialization', () => {
  const contract = cloneContract()
  let reads = 0
  Object.defineProperty(contract.sharedTokens, 'changingValue', {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1
      return reads === 1 ? 'safe display value' : { address: 'GSHOULD-NOT-SERIALIZE' }
    },
  })

  assert.throws(() => serializePocketCrewFoundationContract(contract), /accessor|getter|snapshot/iu)
  assert.equal(reads, 0, 'accessors must be rejected before executing attacker-controlled code')
})

test('fails closed for trapping and revoked proxies with a contract error', () => {
  const trapped = new Proxy(cloneContract(), {
    ownKeys() {
      throw new Error('ownKeys trap')
    },
  })
  assert.throws(
    () => serializePocketCrewFoundationContract(trapped),
    /Pocket Crew foundation contract:/u
  )

  const revoked = Proxy.revocable(cloneContract(), {})
  revoked.revoke()
  assert.throws(
    () => serializePocketCrewFoundationContract(revoked.proxy),
    /Pocket Crew foundation contract:/u
  )
})

test('snapshots proxy data without invoking a changing get trap', () => {
  const target = cloneContract()
  let reads = 0
  let sharedTokenReads = 0
  const proxy = new Proxy(target, {
    get(object, key, receiver) {
      reads += 1
      if (key === 'sharedTokens') {
        sharedTokenReads += 1
        if (sharedTokenReads > 1) return { address: 'GSHOULD-NOT-SERIALIZE' }
      }
      return Reflect.get(object, key, receiver)
    },
  })

  const serialized = serializePocketCrewFoundationContract(proxy)
  assert.doesNotMatch(serialized, /GSHOULD-NOT-SERIALIZE/iu)
  assert.equal(reads, 0, 'descriptor snapshots must not fall back to proxy property reads')
})

test('rejects cycles, custom prototypes, and non-plain nested objects', () => {
  const cyclic = cloneContract()
  cyclic.sharedTokens.cycle = cyclic.sharedTokens
  assert.throws(() => serializePocketCrewFoundationContract(cyclic), /cyclic/iu)

  const customPrototype = cloneContract()
  const customObject = Object.create({ inherited: 'not JSON data' })
  customObject.safe = 'value'
  customPrototype.sharedTokens.customObject = customObject
  assert.throws(
    () => serializePocketCrewFoundationContract(customPrototype),
    /plain|prototype|JSON object/iu
  )

  const nonPlain = cloneContract()
  nonPlain.sharedTokens.date = new Date('2026-08-12T00:00:00.000Z')
  assert.throws(() => serializePocketCrewFoundationContract(nonPlain), /plain|JSON object/iu)
})

test('rejects enumerable non-index array properties, including nested forbidden keys', () => {
  for (const property of ['extra', 'address']) {
    const contract = cloneContract()
    const fixture = ['display-only']
    fixture[property] = property === 'address' ? 'GSHOULD-NOT-SERIALIZE' : 'not an index'
    contract.sharedTokens.arrayFixture = fixture

    assert.throws(
      () => serializePocketCrewFoundationContract(contract),
      property === 'address' ? /forbidden|address/iu : /array|index|property/iu,
      `must reject array.${property}`
    )
  }
})

test('rejects every missing required top-level contract key', () => {
  const contract = cloneContract()
  for (const key of CONTRACT_KEYS) {
    const missing = { ...contract }
    delete missing[key]
    assert.throws(
      () => assertPocketCrewFoundationContract(missing),
      /exactly.*nine|missing.*key/iu,
      `must reject missing ${key}`
    )
  }
})
