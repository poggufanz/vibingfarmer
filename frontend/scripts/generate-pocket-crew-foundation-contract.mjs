import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  POCKET_CREW_CONTRACT,
  POCKET_CREW_CONTRACT_KEYS,
} from '../src/design/pocket-crew-contract.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_OUTPUT_PATH = path.resolve(
  HERE,
  '../src/wallet/ui/pocketCrewFoundationContract.generated.json'
)

export const POCKET_CREW_CONTRACT_KEYS_ORDER = Object.freeze([...POCKET_CREW_CONTRACT_KEYS])

const FORBIDDEN_KEY_NAMES = Object.freeze([
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
])

const normalizeKey = (key) => key.replace(/[_-]/gu, '').toLowerCase()
const FORBIDDEN_KEY_NAMES_NORMALIZED = new Set(FORBIDDEN_KEY_NAMES.map(normalizeKey))
const FORBIDDEN_KEY_PATTERN =
  /(?:private|secret|mnemonic|seed|password|passphrase|credential|signer|capability|relayer|custod|address|owner|account|kernel|session|wallet.?state|route|rpc|network.?endpoint)/iu
const FOUNDATION_TOKEN_KEYS = new Set(
  Object.values(POCKET_CREW_CONTRACT)
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value))
    .flatMap((value) => Object.keys(value).filter((key) => key.startsWith('--pc-')))
)

function contractError(message) {
  return new Error(`Pocket Crew foundation contract: ${message}`)
}

function ownPropertyDescriptors(value, location) {
  try {
    return Object.getOwnPropertyDescriptors(value)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw contractError(`cannot inspect ${location}: ${reason}`)
  }
}

function prototypeOf(value, location) {
  try {
    return Object.getPrototypeOf(value)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw contractError(`cannot inspect ${location}: ${reason}`)
  }
}

function isCanonicalArrayIndex(key, length) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return false
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key
}

function assertSafeKey(key, keyLocation, allowFoundationTokenKeys, arrayKey = false) {
  const normalizedKey = normalizeKey(key)
  const isFoundationToken = allowFoundationTokenKeys && FOUNDATION_TOKEN_KEYS.has(key)
  if (
    (!isFoundationToken && FORBIDDEN_KEY_NAMES_NORMALIZED.has(normalizedKey)) ||
    (!isFoundationToken && FORBIDDEN_KEY_PATTERN.test(key))
  ) {
    throw contractError(`forbidden key "${key}" at ${keyLocation}`)
  }
  if (arrayKey)
    throw contractError(`array property "${key}" is not a canonical index at ${keyLocation}`)
}

function assertNoAccessor(descriptor, keyLocation) {
  if ('get' in descriptor || 'set' in descriptor) {
    throw contractError(`accessor property at ${keyLocation} is not allowed`)
  }
}

function snapshotJsonValue(value, location, stack, allowFoundationTokenKeys = false) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
    throw contractError(`non-finite number at ${location}`)
  }
  if (typeof value !== 'object') {
    throw contractError(`unsupported value at ${location}`)
  }
  if (stack.has(value)) throw contractError(`cyclic value at ${location}`)
  stack.add(value)

  try {
    let isArray
    try {
      isArray = Array.isArray(value)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw contractError(`cannot inspect ${location}: ${reason}`)
    }

    const prototype = prototypeOf(value, location)
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
      throw contractError(`non-JSON object at ${location}; only plain objects are allowed`)
    }

    const descriptors = ownPropertyDescriptors(value, location)
    for (const key of Reflect.ownKeys(descriptors)) {
      assertNoAccessor(descriptors[key], `${location}.${String(key)}`)
    }

    if (isArray) {
      const lengthDescriptor = descriptors.length
      if (!lengthDescriptor || typeof lengthDescriptor.value !== 'number') {
        throw contractError(`array at ${location} has no valid length descriptor`)
      }
      const length = lengthDescriptor.value
      if (!Number.isInteger(length) || length < 0 || length > 2 ** 32 - 1) {
        throw contractError(`array at ${location} has an invalid length`)
      }
      const snapshot = new Array(length)
      for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = descriptors[key]
        if (typeof key === 'symbol') {
          if (descriptor.enumerable) {
            throw contractError(`enumerable symbol property at ${location}`)
          }
          continue
        }
        if (key === 'length') continue
        if (!isCanonicalArrayIndex(key, length)) {
          if (descriptor.enumerable) {
            assertSafeKey(key, `${location}.${key}`, allowFoundationTokenKeys, true)
          }
          continue
        }
        snapshot[Number(key)] = snapshotJsonValue(
          descriptor.value,
          `${location}[${key}]`,
          stack,
          allowFoundationTokenKeys
        )
      }
      return snapshot
    }

    const snapshot = {}
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key]
      if (typeof key === 'symbol') {
        if (descriptor.enumerable) {
          throw contractError(`enumerable symbol property at ${location}`)
        }
        continue
      }
      if (!descriptor.enumerable) continue
      assertSafeKey(key, `${location}.${key}`, allowFoundationTokenKeys)
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: snapshotJsonValue(
          descriptor.value,
          `${location}.${key}`,
          stack,
          allowFoundationTokenKeys
        ),
        writable: true,
      })
    }
    return snapshot
  } finally {
    stack.delete(value)
  }
}

/**
 * Validate a JSON-like visual fixture recursively. Values are deliberately not inspected for
 * address-shaped text: a public destination/network label is presentation data, while a
 * forbidden property would turn the fixture into an implicit wallet/custody record.
 */
export function assertPocketCrewVisualFixtureSafe(value) {
  return snapshotJsonValue(value, '$', new WeakSet())
}

export function assertPocketCrewFoundationContract(value) {
  const snapshot = snapshotJsonValue(value, '$', new WeakSet(), true)
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw contractError('serialized value must be an object')
  }
  const keys = Object.keys(snapshot)
  const expected = new Set(POCKET_CREW_CONTRACT_KEYS_ORDER)
  const unexpected = keys.filter((key) => !expected.has(key))
  if (keys.length !== POCKET_CREW_CONTRACT_KEYS_ORDER.length || unexpected.length > 0) {
    throw contractError(
      `serialized contract must contain exactly nine keys; unexpected: ${unexpected.join(', ') || 'missing key'}`
    )
  }
  for (const key of POCKET_CREW_CONTRACT_KEYS_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
      throw contractError(`serialized contract is missing key "${key}"`)
    }
  }
  return snapshot
}

function sortJsonKeys(value) {
  if (Array.isArray(value)) return value.map(sortJsonKeys)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => [key, sortJsonKeys(value[key])])
  )
}

export function buildPocketCrewFoundationContract() {
  const contract = Object.fromEntries(
    POCKET_CREW_CONTRACT_KEYS_ORDER.map((key) => [key, POCKET_CREW_CONTRACT[key]])
  )
  return assertPocketCrewFoundationContract(contract)
}

export function serializePocketCrewFoundationContract(value = buildPocketCrewFoundationContract()) {
  const snapshot = assertPocketCrewFoundationContract(value)
  return `${JSON.stringify(sortJsonKeys(snapshot), null, 2)}\n`
}

export function generatePocketCrewFoundationContract({
  outputPath = DEFAULT_OUTPUT_PATH,
  check = false,
} = {}) {
  const serialized = serializePocketCrewFoundationContract()
  let existing
  try {
    existing = readFileSync(outputPath, 'utf8')
  } catch {
    if (check) {
      throw contractError(`generated artifact is missing at ${outputPath}`)
    }
    existing = null
  }

  if (check) {
    if (existing !== serialized) {
      throw contractError(`generated artifact is stale at ${outputPath}`)
    }
    return { outputPath, checked: true, serialized }
  }

  if (existing !== serialized) writeFileSync(outputPath, serialized, 'utf8')
  return { outputPath, checked: false, serialized }
}

function runCli(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== '--check')
  if (unknown.length > 0) throw contractError(`unknown argument ${unknown[0]}`)
  const result = generatePocketCrewFoundationContract({ check: argv.includes('--check') })
  process.stdout.write(
    `${result.checked ? 'Pocket Crew foundation contract is current' : 'Generated Pocket Crew foundation contract'}: ${result.outputPath}\n`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
