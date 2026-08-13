// Presentation-only ecosystem catalog.
//
// The ecosystem route is a public catalog, not a chain reader.  Keep that distinction explicit:
// cards carry catalog provenance and a display state, while the route-level `fact` is the
// source-owned presentation envelope passed through `toEcosystemPresentation`.  No card in this
// module contains an APY or a live balance.
import { NETWORK_IDS } from '../design/networks.js'

export const BASE_PROXY_TRUTH = 'Base Sepolia proxy. Custody only. No protocol yield.'

const STATES = Object.freeze([
  'loading',
  'current',
  'stale',
  'empty',
  'partial',
  'error',
  'unavailable',
])
const CATALOG_CHECKED_AT = 'catalog'

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}

const card = ({
  id,
  name,
  state = 'current',
  networkId = null,
  network = null,
  kind = 'unknown',
  description,
  truth,
  verifiedProxy = false,
}) => ({
  id,
  name,
  state,
  status: state === 'planned' ? 'Planned' : state === 'current' ? 'Current' : 'Unavailable',
  source: 'catalog',
  sourceKind: 'catalog',
  networkId,
  network,
  kind,
  description,
  truth,
  verifiedProxy,
  verified: verifiedProxy,
  // Deliberately null: the catalog does not publish a protocol-yield fact.
  apyFact: null,
})

const TESTNET_CARDS = [
  card({
    id: 'stellar-soroban',
    name: 'Stellar / Soroban',
    networkId: NETWORK_IDS.STELLAR_TESTNET,
    network: 'Stellar testnet',
    kind: 'stellar-live',
    description: 'Primary network and smart-contract runtime for the scoped agent flow.',
    truth: 'Soroban contracts enforce the grant and agent scope.',
  }),
  card({
    id: 'autofarm-vault',
    name: 'Autofarm Vault',
    networkId: NETWORK_IDS.STELLAR_TESTNET,
    network: 'Stellar testnet',
    kind: 'stellar-live',
    description: 'The single product vault that receives agent deposits.',
    truth: 'Autofarm Vault supplies USDC into Blend Capital v2.',
  }),
  card({
    id: 'blend-capital-v2',
    name: 'Blend Capital v2',
    networkId: NETWORK_IDS.STELLAR_TESTNET,
    network: 'Stellar testnet',
    kind: 'stellar-live',
    description: 'The lending venue behind the Autofarm strategy.',
    truth: 'Testnet lending venue; no yield fact is attached to the catalog.',
  }),
  card({
    id: 'base-sepolia-proxy',
    name: 'Base Sepolia proxy',
    networkId: NETWORK_IDS.BASE_SEPOLIA,
    network: 'Base Sepolia',
    kind: 'base-proxy',
    description: 'Optional destination for bridged USDC custody.',
    truth: BASE_PROXY_TRUTH,
    verifiedProxy: true,
  }),
  card({
    id: 'circle-cctp',
    name: 'Circle CCTP',
    networkId: NETWORK_IDS.STELLAR_TESTNET,
    network: 'Stellar testnet → Base Sepolia',
    kind: 'bridge',
    description: 'The optional USDC bridge corridor between the two testnets.',
    truth: 'CCTP moves USDC between the declared source and destination networks.',
  }),
  card({
    id: 'openzeppelin',
    name: 'OpenZeppelin',
    network: null,
    kind: 'tooling',
    description: 'Open-source contract and security tooling used by the optional EVM leg.',
    truth: 'Tooling reference only; it is not a yield venue.',
  }),
  card({
    id: 'defillama',
    name: 'DeFiLlama',
    network: null,
    kind: 'market-data',
    description: 'Catalog and market-data provenance for route reads.',
    truth: 'Market-data source; it does not custody user funds.',
  }),
  card({
    id: 'zerodev',
    name: 'ZeroDev',
    state: 'planned',
    networkId: NETWORK_IDS.BASE_SEPOLIA,
    network: 'Base Sepolia',
    kind: 'planned-tooling',
    description: 'Planned session-key infrastructure for the optional EVM leg.',
    truth: 'Planned infrastructure; no protocol yield is attached.',
  }),
]

const MAINNET_LENDING_IDS = new Set(['autofarm-vault', 'blend-capital-v2'])

function normalizedState(value) {
  return STATES.includes(value) ? value : 'current'
}

function catalogCards({ deployment, baseProxyVerified }) {
  return TESTNET_CARDS.map((entry) => {
    const isMainnetLending = deployment === 'mainnet' && MAINNET_LENDING_IDS.has(entry.id)
    const isUnverifiedProxy = entry.id === 'base-sepolia-proxy' && baseProxyVerified === false
    const nextState = isMainnetLending ? 'planned' : isUnverifiedProxy ? 'unavailable' : entry.state
    const nextNetwork = isMainnetLending ? 'Mainnet' : entry.network
    const nextDescription = isMainnetLending
      ? 'Mainnet lending deployment is planned; no deposits are routed.'
      : entry.description
    const nextTruth = isMainnetLending
      ? 'Mainnet lending deployment is planned; no protocol yield is available.'
      : entry.truth
    return {
      ...entry,
      state: nextState,
      status:
        nextState === 'planned' ? 'Planned' : nextState === 'current' ? 'Current' : 'Unavailable',
      network: nextNetwork,
      description: nextDescription,
      truth: nextTruth,
      verifiedProxy: entry.id === 'base-sepolia-proxy' ? baseProxyVerified : entry.verifiedProxy,
      verified: entry.id === 'base-sepolia-proxy' ? baseProxyVerified : entry.verified,
      apyFact: null,
    }
  })
}

/**
 * Build the frozen catalog input consumed by `toEcosystemPresentation`.
 *
 * `deployment: 'mainnet'` is intentionally explicit: lending cards become Planned and retain
 * no APY fact.  The default is the product's Stellar testnet catalog.  `baseProxyVerified` is
 * equally explicit so a Base card cannot be presented as Current without proxy evidence.
 */
export function createEcosystemModel(options = {}) {
  const config = typeof options === 'string' ? { state: options } : options || {}
  const {
    state = 'current',
    deployment = 'testnet',
    baseProxyVerified = true,
    checkedAt,
    cards,
  } = config
  const normalized = normalizedState(state)
  const source = normalized === 'unavailable' ? null : 'catalog'
  const catalogCheckedAt =
    normalized === 'unavailable' ? null : checkedAt === undefined ? CATALOG_CHECKED_AT : checkedAt
  const fact = {
    state: normalized,
    value: null,
    source,
    checkedAt: catalogCheckedAt,
    staleAfterMs: null,
    confirmedLedger: null,
    confirmedBlock: null,
  }
  const resolvedCards = Array.isArray(cards)
    ? cards
    : catalogCards({ deployment, baseProxyVerified })

  return deepFreeze({
    state: normalized,
    source: 'catalog',
    checkedAt: catalogCheckedAt,
    staleAfterMs: null,
    fact,
    cards: resolvedCards,
    deployment,
  })
}

export const ECOSYSTEM_CARD_ORDER = Object.freeze(TESTNET_CARDS.map(({ name }) => name))
