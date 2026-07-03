// App configuration — AI providers + the vault catalog. Single-chain Stellar: the EVM stack was
// decommissioned 2026-06-21, so all chain addresses now live in stellar/config.js. This file holds
// only chain-agnostic app config plus the AI advisor's vault universe.
import { SOROBAN_ACTIVE_VAULT_ADDRESS } from './stellar/config.js'

// APIs
export const VENICE_BASE_URL = 'https://api.venice.ai/api/v1'
// Venice model slug — must be a Venice-hosted ID, NOT a DeepSeek name. 'deepseek-v4-flash' is
// DeepSeek's own slug and 400s on Venice (Venice's docs default to zai-org-glm-5-1 / GLM-5.1).
// Used by the Settings Venice-API-key path. See resolveProvider in venice.js.
export const VENICE_MODEL = 'deepseek-v4-flash'
export const VENICE_TIMEOUT_MS = 60000

// DeepSeek — OpenAI-compatible, used as dev fallback when Venice is not configured.
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'
export const DEEPSEEK_MODEL = 'deepseek-v4-flash'
// Server-side AI proxy — key stays on the server (see api/ai.js). No secret in client.
export const AI_PROXY_URL = '/api/ai'

// Vault catalog — enriched metadata so the AI advisor can reason, not just split. Each entry's
// `address` is the on-chain execution target: the single deployed Soroban yield vault. The demo's
// multi-vault universe (Aave/Morpho/Pendle/Fluid as reference protocols) all execute on that one
// vault — the metadata (apy/risk/yield_source) is what the advisor reasons over.
export const VAULT_CATALOG = [
  {
    name: 'Aave v3 USDC',
    protocol: 'aave-v3',
    address: SOROBAN_ACTIVE_VAULT_ADDRESS,
    apy: 4.8,
    risk: 'low',
    yield_source: 'lending',
    drawdown: '-1.2',
    min_capital: 100,
    description:
      'Overcollateralized pooled lending. Battle-tested, highest TVL in DeFi. Best for principal preservation.',
  },
  {
    name: 'Morpho Blue USDC',
    protocol: 'morpho-blue',
    address: SOROBAN_ACTIVE_VAULT_ADDRESS,
    apy: 6.1,
    risk: 'medium',
    yield_source: 'curated',
    drawdown: '-2.8',
    min_capital: 500,
    description:
      'Curator-managed isolated lending markets. Better yield than Aave, curator-dependent risk.',
  },
  {
    name: 'Pendle PT-USDC',
    protocol: 'pendle-v2',
    address: SOROBAN_ACTIVE_VAULT_ADDRESS,
    apy: 9.4,
    risk: 'high',
    yield_source: 'structured',
    drawdown: '-6.5',
    min_capital: 1000,
    description:
      'Fixed-rate yield via zero-coupon bond mechanics. Hold to maturity or face AMM exit loss.',
  },
  {
    name: 'Fluid USDC',
    protocol: 'fluid',
    address: SOROBAN_ACTIVE_VAULT_ADDRESS,
    apy: 5.2,
    risk: 'high',
    yield_source: 'hybrid',
    drawdown: '-4.1',
    min_capital: 2000,
    description:
      'Unified lending + DEX architecture. Highest capital efficiency, highest architectural risk.',
  },
]
