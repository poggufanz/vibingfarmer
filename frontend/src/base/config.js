// frontend/src/base/config.js
// Base-side chain config. Mirrors stellar/config.js's discipline: fail loudly at the point of
// use on a missing/malformed address rather than silently building against nothing. Every
// address here is a VITE_ env override synced from deployments/base-sepolia.json (SP1) — see
// docs/deploy-checklist.md for the sync step.
import { baseSepolia } from 'viem/chains'

export const BASE_CHAIN = baseSepolia // chainId 84532 (Base Sepolia)
export const ENTRY_POINT_VERSION = '0.7'
// Kernel v3.1 — the version spikes/smart-sessions/session-test.mjs proved the drain-proof
// session policy against (SP0-GATE.md). Do not bump without re-running that gate.
export const KERNEL_VERSION_TAG = 'KERNEL_V3_1'

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/

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
  import.meta.env?.VITE_YIELD_ROUTER_ADDRESS || '0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d'
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
