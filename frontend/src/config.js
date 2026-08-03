// App configuration — AI providers + the vault catalog. Single-chain Stellar: the EVM stack was
// decommissioned 2026-06-21, so all chain addresses now live in stellar/config.js. This file holds
// only chain-agnostic app config plus the AI advisor's vault universe.
import { SOROBAN_ACTIVE_VAULT_ADDRESS } from './stellar/config.js'
import { NETWORK_IDS } from './design/networks.js'

// APIs
export const VENICE_BASE_URL = 'https://api.venice.ai/api/v1'
// Venice model slug — must be a Venice-hosted ID, NOT a DeepSeek name. 'deepseek-v4-flash' is
// DeepSeek's own slug and 400s on Venice (Venice's docs default to zai-org-glm-5-1 / GLM-5.1).
// Used by the Settings Venice-API-key path. See resolveProvider in strategist.js.
export const VENICE_MODEL = 'deepseek-v4-flash'
export const VENICE_TIMEOUT_MS = 60000

// DeepSeek — OpenAI-compatible, used as dev fallback when Venice is not configured.
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'
export const DEEPSEEK_MODEL = 'deepseek-v4-flash'
// Server-side AI proxy — key stays on the server (see api/ai.js). No secret in client.
export const AI_PROXY_URL = '/api/ai'

// Vault catalog — the truthful execution universe (Strategy Task 1, Pocket Crew Wave 1). There is
// exactly ONE live Stellar venue: this product's own Autofarm vault, which supplies USDC into
// Blend Capital v2 for real testnet lending yield. Earlier revisions of this file presented four
// reference "personas" (Aave/Morpho/Pendle/Fluid) as if each were a distinct Stellar venue, when
// all four actually executed on this same address — that was the fake-persona problem this catalog
// now removes. `apy` below is a static/expected figure (still read by out-of-scope UI surfaces
// this task does not touch) — it must never be read as current/live yield; only
// `strategy/venueTruth.js`'s `venueYield`/`isLiveYieldVenue` guards decide that, and they never
// trust this flat field (see venueTruth.js's normalizeYield).
export const VAULT_CATALOG = [
  {
    name: 'Vibing Farmer Autofarm',
    protocol: 'blend-usdc',
    address: SOROBAN_ACTIVE_VAULT_ADDRESS,
    venueKind: 'stellar-live',
    networkId: NETWORK_IDS.STELLAR_TESTNET,
    destination: 'Autofarm Vault to Blend Capital v2',
    apy: 4.8,
    risk: 'low',
    yield_source: 'lending',
    drawdown: '-1.2',
    min_capital: 100,
    description:
      "The product's own Autofarm vault. Deposits supply USDC into Blend Capital v2 on Stellar testnet — the only Stellar execution venue this app uses.",
    chain: 'stellar',
  },
]

// Base pool catalog (Approach C, SP3) — the whitelisted ERC-4626 pools the AI strategist can
// allocate into. Addresses are SP1 deliverables (base-contracts/), synced here as VITE_ env
// overrides — same fail-loud discipline as VAULT_CATALOG's SOROBAN_ACTIVE_VAULT_ADDRESS.
// Assumed venue set per the design spec (§9): Aave v3 + Morpho Blue + Moonwell on Base.
const BASE_POOL_ADDR_RE = /^0x[a-fA-F0-9]{40}$/
function requireBasePoolAddress(name, value) {
  if (!value || !BASE_POOL_ADDR_RE.test(value)) {
    throw new Error(
      `${name} is missing or is not a 0x address. Set VITE_${name} (see docs/deploy-checklist.md).`
    )
  }
  return value
}

// Custody-only proxies: the Base Sepolia leg never carries protocol yield (there is no live
// Aave/Morpho/Moonwell position behind these pools, only our own MockERC4626 wrapper over CCTP
// USDC). `proxyTarget` names the mainnet protocol a future real integration is PLANNED to use —
// a label only, never an execution or yield claim (see strategy/venueTruth.js's normalizeVenue,
// which forces `yield: {state:'none', apy:null}` for every base-custody-proxy record regardless
// of any apy this file — or a caller — might otherwise supply).
export const BASE_POOL_CATALOG = [
  {
    name: 'Aave v3 USDC (Base)',
    protocol: 'vf-erc4626-proxy',
    proxyTarget: 'aave-v3',
    factSlug: 'aave-v3-base',
    address: requireBasePoolAddress(
      'BASE_POOL_1_ADDRESS',
      import.meta.env?.VITE_BASE_POOL_1_ADDRESS || '0x389250872044368759D3db5C09b2706A6628d4e0'
    ),
    venueKind: 'base-custody-proxy',
    networkId: NETWORK_IDS.BASE_SEPOLIA,
    risk: 'low',
    min_capital: 50,
    chain: 'base',
  },
  {
    name: 'Morpho Blue USDC (Base)',
    protocol: 'vf-erc4626-proxy',
    proxyTarget: 'morpho-blue',
    factSlug: 'morpho-blue-base',
    address: requireBasePoolAddress(
      'BASE_POOL_2_ADDRESS',
      import.meta.env?.VITE_BASE_POOL_2_ADDRESS || '0x5E843A639F0555E2A6669601621befC887Bdb479'
    ),
    venueKind: 'base-custody-proxy',
    networkId: NETWORK_IDS.BASE_SEPOLIA,
    risk: 'medium',
    min_capital: 50,
    chain: 'base',
  },
  {
    name: 'Moonwell USDC (Base)',
    protocol: 'vf-erc4626-proxy',
    proxyTarget: 'moonwell',
    factSlug: 'moonwell-base',
    address: requireBasePoolAddress(
      'BASE_POOL_3_ADDRESS',
      import.meta.env?.VITE_BASE_POOL_3_ADDRESS || '0xadD3c1A75c7Cef2516b51750959BD829a4AD4761'
    ),
    venueKind: 'base-custody-proxy',
    networkId: NETWORK_IDS.BASE_SEPOLIA,
    risk: 'medium',
    min_capital: 50,
    chain: 'base',
  },
]
