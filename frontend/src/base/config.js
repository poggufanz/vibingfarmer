// frontend/src/base/config.js
// Base-side chain config. Mirrors stellar/config.js's discipline: fail loudly at the point of
// use on a missing/malformed address rather than silently building against nothing. Every
// address here is a VITE_ env override synced from deployments/base-sepolia.json (SP1) — see
// docs/deploy-checklist.md for the sync step.
import { getAddress } from 'viem'
import { baseSepolia } from 'viem/chains'
import { RECORDED_BASE_DEPLOYMENT } from './deploymentFacts.js'

export const BASE_CHAIN = baseSepolia // chainId 84532 (Base Sepolia)
export const ENTRY_POINT_VERSION = '0.7'
// Kernel v3.1 — the version spikes/smart-sessions/session-test.mjs proved the drain-proof
// session policy against (SP0-GATE.md). Do not bump without re-running that gate.
export const KERNEL_VERSION_TAG = 'KERNEL_V3_1'

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/
const HASH_RE = /^0x[0-9a-f]{64}$/
const SELECTOR_RE = /^0x[0-9a-f]{8}$/
const POSITIVE_DECIMAL_RE = /^[1-9]\d*$/
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ZERO_HASH = `0x${'00'.repeat(32)}`
const CIRCLE_BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const CIRCLE_BASE_SEPOLIA_TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'
const isDecimalString = (value) => typeof value === 'string' && POSITIVE_DECIMAL_RE.test(value)
const UNAVAILABLE_REASON =
  'Base cross-chain actions are temporarily unavailable while the hardened deployment is verified.'
const EXACT_ABSENT_SELECTORS = Object.freeze(['0x0d390c9e', '0x9abaf267'])
const CONFIGURED_APPROVED_POOLS = Object.freeze(
  [
    import.meta.env?.VITE_BASE_POOL_1_ADDRESS || '0x389250872044368759D3db5C09b2706A6628d4e0',
    import.meta.env?.VITE_BASE_POOL_2_ADDRESS || '0x5E843A639F0555E2A6669601621befC887Bdb479',
    import.meta.env?.VITE_BASE_POOL_3_ADDRESS || '0xadD3c1A75c7Cef2516b51750959BD829a4AD4761',
  ]
    .map((address) => {
      try {
        return getAddress(address)
      } catch {
        return null
      }
    })
    .sort((left, right) => String(left).toLowerCase().localeCompare(String(right).toLowerCase()))
)

const exactKeys = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

const isChecksummedAddress = (value) => {
  if (typeof value !== 'string' || !ADDR_RE.test(value)) return false
  try {
    return value !== ZERO_ADDRESS && getAddress(value) === value
  } catch {
    return false
  }
}

const isCanonicalNonzeroHash = (value) =>
  typeof value === 'string' && HASH_RE.test(value) && value !== ZERO_HASH

const isSortedUnique = (values, validator) =>
  Array.isArray(values) &&
  values.length > 0 &&
  values.every(validator) &&
  values.every(
    (value, index) => index === 0 || values[index - 1].toLowerCase() < value.toLowerCase()
  )

const cloneRecord = (value) => {
  if (Array.isArray(value)) return value.map(cloneRecord)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneRecord(entry)])
    )
  }
  return value
}

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}

const isCodeRecord = (value) =>
  exactKeys(value, [
    'address',
    'deployTxHash',
    'deployBlockNumber',
    'deployBlockHash',
    'rawRuntimeCodeHash',
    'normalizedRuntimeCodeHash',
  ]) &&
  isChecksummedAddress(value.address) &&
  isCanonicalNonzeroHash(value.deployTxHash) &&
  isDecimalString(value.deployBlockNumber) &&
  isCanonicalNonzeroHash(value.deployBlockHash) &&
  isCanonicalNonzeroHash(value.rawRuntimeCodeHash) &&
  isCanonicalNonzeroHash(value.normalizedRuntimeCodeHash)

/**
 * Validate the verifier-owned deployment record without consulting VITE configuration. This is
 * deliberately a closed schema: the caller cannot turn an address or generation label into
 * execution authority. Only RECORDED_BASE_DEPLOYMENT below is used for the live gate.
 */
export function evaluateBaseDeploymentRecord(record) {
  const fail = () => ({ available: false, reason: UNAVAILABLE_REASON, facts: null })
  if (!exactKeys(record, ['base']) || !exactKeys(record.base, ['hardenedDeployment'])) return fail()
  const facts = record.base.hardenedDeployment
  if (
    !exactKeys(facts, [
      'generation',
      'chainId',
      'adminSafe',
      'yieldRouter',
      'baseExitSweeper',
      'route',
      'selectors',
      'pools',
      'verification',
    ]) ||
    facts.generation !== 'hardened-v2' ||
    facts.chainId !== 84532
  ) {
    return fail()
  }
  const safe = facts.adminSafe
  if (
    !exactKeys(safe, [
      'address',
      'proxyImplementation',
      'runtimeCodeHash',
      'threshold',
      'owners',
    ]) ||
    !isChecksummedAddress(safe.address) ||
    !isChecksummedAddress(safe.proxyImplementation) ||
    !isCanonicalNonzeroHash(safe.runtimeCodeHash) ||
    !Number.isSafeInteger(safe.threshold) ||
    safe.threshold <= 0 ||
    !isSortedUnique(safe.owners, isChecksummedAddress) ||
    safe.threshold > safe.owners.length
  ) {
    return fail()
  }
  if (!isCodeRecord(facts.yieldRouter) || !isCodeRecord(facts.baseExitSweeper)) return fail()
  const route = facts.route
  if (
    !exactKeys(route, [
      'usdcAddress',
      'tokenMessengerAddress',
      'stellarDomain',
      'mintRecipient',
      'destinationCaller',
      'finalityThreshold',
    ]) ||
    route.usdcAddress !== CIRCLE_BASE_SEPOLIA_USDC ||
    route.tokenMessengerAddress !== CIRCLE_BASE_SEPOLIA_TOKEN_MESSENGER ||
    route.stellarDomain !== 27 ||
    !isCanonicalNonzeroHash(route.mintRecipient) ||
    !isCanonicalNonzeroHash(route.destinationCaller) ||
    route.finalityThreshold !== 1000
  ) {
    return fail()
  }
  const selectors = facts.selectors
  if (
    !exactKeys(selectors, ['exitAllAndBurn', 'absent']) ||
    selectors.exitAllAndBurn !== '0x4c9d247b' ||
    !SELECTOR_RE.test(selectors.exitAllAndBurn) ||
    !Array.isArray(selectors.absent) ||
    selectors.absent.length !== EXACT_ABSENT_SELECTORS.length ||
    selectors.absent.some((selector, index) => selector !== EXACT_ABSENT_SELECTORS[index])
  ) {
    return fail()
  }
  const pools = facts.pools
  if (
    !exactKeys(pools, ['enabled', 'known']) ||
    !isSortedUnique(pools.enabled, isChecksummedAddress) ||
    !isSortedUnique(pools.known, isChecksummedAddress) ||
    pools.enabled.length !== pools.known.length ||
    pools.enabled.some((pool, index) => pool !== pools.known[index])
  ) {
    return fail()
  }
  const verification = facts.verification
  if (
    !exactKeys(verification, ['blockNumber', 'blockHash']) ||
    !isDecimalString(verification.blockNumber) ||
    !isCanonicalNonzeroHash(verification.blockHash)
  ) {
    return fail()
  }
  try {
    const routerDeployBlock = BigInt(facts.yieldRouter.deployBlockNumber)
    const sweeperDeployBlock = BigInt(facts.baseExitSweeper.deployBlockNumber)
    const verificationBlock = BigInt(verification.blockNumber)
    if (routerDeployBlock > sweeperDeployBlock || sweeperDeployBlock > verificationBlock) {
      return fail()
    }
  } catch {
    return fail()
  }
  return { available: true, reason: null, facts: deepFreeze(cloneRecord(facts)) }
}

const evaluatedDeployment = evaluateBaseDeploymentRecord(RECORDED_BASE_DEPLOYMENT)
const configuredAddressAgrees = (configured, verified) => {
  if (!configured) return true
  try {
    return getAddress(configured) === verified
  } catch {
    return false
  }
}
const configuredRouterMatches =
  evaluatedDeployment.available &&
  configuredAddressAgrees(
    import.meta.env?.VITE_YIELD_ROUTER_ADDRESS,
    evaluatedDeployment.facts.yieldRouter.address
  )
const configuredSweeperMatches =
  evaluatedDeployment.available &&
  configuredAddressAgrees(
    import.meta.env?.VITE_BASE_EXIT_SWEEPER_ADDRESS,
    evaluatedDeployment.facts.baseExitSweeper.address
  )
const configuredPoolsMatch =
  evaluatedDeployment.available &&
  CONFIGURED_APPROVED_POOLS.every(Boolean) &&
  evaluatedDeployment.facts.pools.enabled.length === CONFIGURED_APPROVED_POOLS.length &&
  evaluatedDeployment.facts.pools.enabled.every(
    (pool, index) => pool === CONFIGURED_APPROVED_POOLS[index]
  )
const deploymentAvailability =
  configuredRouterMatches && configuredSweeperMatches && configuredPoolsMatch
    ? evaluatedDeployment
    : { available: false, reason: UNAVAILABLE_REASON, facts: null }
export const BASE_CROSS_CHAIN_AVAILABLE = deploymentAvailability.available
export const BASE_CROSS_CHAIN_UNAVAILABLE_REASON = deploymentAvailability.reason
export const VERIFIED_BASE_DEPLOYMENT = deploymentAvailability.facts

export function assertBaseCrossChainAvailable() {
  if (!BASE_CROSS_CHAIN_AVAILABLE) {
    const error = new Error(BASE_CROSS_CHAIN_UNAVAILABLE_REASON)
    error.code = 'BASE_CROSS_CHAIN_UNAVAILABLE'
    throw error
  }
  return VERIFIED_BASE_DEPLOYMENT
}

function requireAddress(name, value) {
  if (!value || !ADDR_RE.test(value)) {
    throw new Error(
      `${name} is missing or is not a 0x address. Set VITE_${name} (see docs/deploy-checklist.md).`
    )
  }
  return value
}

export const ZERODEV_PROJECT_ID = import.meta.env?.VITE_ZERODEV_PROJECT_ID || ''
export const ZERODEV_PASSKEY_SERVER_URL = import.meta.env?.VITE_ZERODEV_PASSKEY_SERVER_URL || ''
// The rp.id the ZeroDev dashboard registered for this project's passkey server. The hosted
// server ignores client-sent rpID, so this is the scope EVERY ceremony must use — see
// wallet/passkeyBase.js signWithRpId for why sign-side needs it spelled out.
export const ZERODEV_PASSKEY_RP_ID =
  import.meta.env?.VITE_ZERODEV_PASSKEY_RP_ID || 'vibing-farmer.pages.dev'
export const BASE_SEPOLIA_RPC_URL =
  import.meta.env?.VITE_BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org'

// ZeroDev's unified v3 RPC serves as BOTH bundler and paymaster transport (proven in SP0).
export function zerodevRpcUrl(chainId = BASE_CHAIN.id, projectId = ZERODEV_PROJECT_ID) {
  if (!projectId) {
    throw new Error('VITE_ZERODEV_PROJECT_ID is missing. See docs/deploy-checklist.md.')
  }
  return `https://rpc.zerodev.app/api/v3/${projectId}/chain/${chainId}`
}

// SP1 deliverable — deposit-only router, holds no funds (base-contracts/src/YieldRouter.sol).
// Baked Base Sepolia default (deployments/base-sepolia.json) so builds without a
// local .env don't crash at module scope; VITE_ env still overrides (mainnet flip).
export const YIELD_ROUTER_ADDRESS = requireAddress(
  'YIELD_ROUTER_ADDRESS',
  VERIFIED_BASE_DEPLOYMENT?.yieldRouter.address ||
    import.meta.env?.VITE_YIELD_ROUTER_ADDRESS ||
    '0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d'
)

export const YIELD_ROUTER_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'pool', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'minShares', type: 'uint256' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'pool', type: 'address' },
      { name: 'shares', type: 'uint256' },
      { name: 'minAssets', type: 'uint256' },
    ],
    outputs: [{ name: 'assets', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Deposited',
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'pool', type: 'address', indexed: true },
      { name: 'assets', type: 'uint256', indexed: false },
      { name: 'shares', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Withdrawn',
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'pool', type: 'address', indexed: true },
      { name: 'assets', type: 'uint256', indexed: false },
      { name: 'shares', type: 'uint256', indexed: false },
    ],
  },
]

export const BASE_EXIT_SWEEPER_ADDRESS = requireAddress(
  'BASE_EXIT_SWEEPER_ADDRESS',
  VERIFIED_BASE_DEPLOYMENT?.baseExitSweeper.address ||
    import.meta.env?.VITE_BASE_EXIT_SWEEPER_ADDRESS ||
    '0x5451a6dc234d07F3C80752E3c0E798913E53de6D'
)

export const BASE_USDC_ADDRESS =
  VERIFIED_BASE_DEPLOYMENT?.route.usdcAddress || '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

export const BASE_EXIT_SWEEPER_ABI = [
  {
    type: 'function',
    name: 'exitAllAndBurn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'pools', type: 'address[]' },
      { name: 'minAssetsPerPool', type: 'uint256[]' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [
      { name: 'burned', type: 'uint256' },
      { name: 'exited', type: 'uint256' },
      { name: 'skipped', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'Swept',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'burned', type: 'uint256', indexed: false },
      { name: 'exited', type: 'uint256', indexed: false },
      { name: 'skipped', type: 'uint256', indexed: false },
    ],
  },
]

export const ERC4626_ABI = [
  {
    type: 'function',
    name: 'convertToShares',
    stateMutability: 'view',
    inputs: [{ name: 'assets', type: 'uint256' }],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ name: 'assets', type: 'uint256' }],
  },
]

export const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
]

// Base/EVM USDC is 6 decimals (Stellar's is 7 — stellar/format.js). Never share a BASE_UNIT
// constant across chains (the SP0 "decimals gotcha", spikes/cctp-corridor/addresses.md).
export const BASE_USDC_DECIMALS = 6
export const BASE_USDC_UNIT = 10 ** BASE_USDC_DECIMALS

export function toBaseChainUnits(amount) {
  return BigInt(Math.round(Number(amount || 0) * BASE_USDC_UNIT))
}
export function fromBaseChainUnits(units) {
  return Number(units || 0) / BASE_USDC_UNIT
}
