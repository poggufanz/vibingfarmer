// Public technology catalog and architecture route.
// The catalog model is presentation-only; any settled read remains an injected input owned by
// the route caller and passes through the Secondary adapter before it reaches the primitives.
import { useNavigate } from 'react-router-dom'
import NavBar from './NavBar.jsx'
import { ECOSYSTEM } from './LandingHero.jsx'
import { NETWORK_IDS } from '../design/networks.js'
import { toEcosystemPresentation } from '../secondary/secondaryRouteAdapters.js'
import { createEcosystemModel } from '../secondary/ecosystemModel.js'
import { NetworkBadge, NetworkRoute } from './pocket/NetworkIdentity.jsx'
import { StageShell, StatusNotice, TechnicalDetails, VenueTruth } from './pocket/Primitives.jsx'
import './EcosystemPage.css'

const STANDARDS = [
  {
    id: 'Soroban Auth',
    desc: 'ed25519 session-key scopes',
    link: 'https://developers.stellar.org/docs/build/guides/auth',
  },
  {
    id: 'SEP-41',
    desc: 'Token interface',
    link: 'https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md',
  },
  {
    id: 'Fee-bump',
    desc: 'Gas-abstracted transactions',
    link: 'https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions',
  },
  {
    id: 'Soroban Events',
    desc: 'On-chain audit trail',
    link: 'https://developers.stellar.org/docs/build/guides/events',
  },
  { id: 'x402', desc: 'HTTP-native payments', link: 'https://x402.org' },
  { id: 'Blend', desc: 'Blend v2 lending yield', link: 'https://www.blend.capital' },
]

const GITHUB_URL = 'https://github.com/poggufanz/vibingfarmer'
const DEFAULT_ECOSYSTEM_MODEL = createEcosystemModel()

const CATALOG_BRANDS = Object.freeze({
  'stellar-soroban': 'Stellar / Soroban',
  'autofarm-vault': null,
  'blend-capital-v2': 'Blend Capital',
  'base-sepolia-proxy': 'Base',
  'circle-cctp': 'Circle CCTP',
  openzeppelin: 'OpenZeppelin',
  defillama: 'DeFiLlama',
  zerodev: 'ZeroDev',
})

/* ── Static architecture diagram ───────────────────────────────────────── */

// The diagram mirrors the product pipeline: wallet → council gate → one grant → parallel agents
// → one vault → Blend v2.  The adjacent semantic list below is the complete stack catalog.
const ARCH_NODES = [
  {
    id: 'wallet',
    x: 400,
    y: 42,
    label: 'User Wallet',
    sub: 'VF Wallet / Freighter',
    icon: 'W',
    color: 'var(--text)',
  },
  {
    id: 'ai',
    x: 400,
    y: 134,
    label: 'AI Strategy + Council',
    sub: 'AI API',
    icon: 'AI',
    color: '#b8a9ff',
  },
  {
    id: 'router',
    x: 400,
    y: 232,
    label: 'Funding Router',
    sub: 'One sign: budget + expiry',
    icon: 'FR',
    color: '#dff56c',
    hero: true,
  },
  {
    id: 'worker1',
    x: 244,
    y: 332,
    label: 'Agent Account 1',
    sub: 'Scoped signer',
    icon: 'A1',
    color: '#ffb86c',
  },
  {
    id: 'worker2',
    x: 556,
    y: 332,
    label: 'Agent Account 2',
    sub: 'Scoped signer',
    icon: 'A2',
    color: '#ffb86c',
  },
  {
    id: 'vault',
    x: 400,
    y: 430,
    label: 'Autofarm Vault',
    sub: 'Pooled shares (vfVLT)',
    icon: 'V',
    color: '#7dd3c0',
  },
  {
    id: 'blend',
    x: 400,
    y: 512,
    label: 'Blend v2 Pool',
    sub: 'Real testnet lending yield',
    icon: 'BL',
    color: '#7dd3c0',
  },
]

const ARCH_EDGES = [
  { from: 'wallet', to: 'ai', label: 'Amount + limits' },
  { from: 'ai', to: 'router', label: 'Reviewed + gated' },
  { from: 'router', to: 'worker1', label: 'Scoped account' },
  { from: 'router', to: 'worker2', label: 'Scoped account' },
  { from: 'worker1', to: 'vault', label: 'Deposit · relayed' },
  { from: 'worker2', to: 'vault', label: 'Deposit · relayed' },
  { from: 'vault', to: 'blend', label: 'Supply' },
]

function ArchNode({ node }) {
  const w = 200
  const h = 56
  const rx = 10

  return (
    <g className={`arch-node${node.hero ? ' arch-node--hero' : ''}`}>
      <rect
        x={node.x - w / 2}
        y={node.y - h / 2}
        width={w}
        height={h}
        rx={rx}
        className="arch-card"
        style={{
          stroke: node.hero ? 'color-mix(in srgb, var(--accent) 40%, transparent)' : undefined,
        }}
      />
      <circle
        cx={node.x - w / 2 + 24}
        cy={node.y}
        r={14}
        className="arch-icon-bg"
        style={{ fill: `${node.color}18`, stroke: `${node.color}40` }}
      />
      <text
        x={node.x - w / 2 + 24}
        y={node.y + 1}
        className="arch-icon-text"
        style={{ fill: node.color }}
        dominantBaseline="central"
        textAnchor="middle"
      >
        {node.icon}
      </text>
      <text
        x={node.x - w / 2 + 48}
        y={node.y - 6}
        className="arch-label"
        style={{ fill: node.hero ? node.color : undefined }}
      >
        {node.label}
      </text>
      <text x={node.x - w / 2 + 48} y={node.y + 10} className="arch-sublabel">
        {node.sub}
      </text>
    </g>
  )
}

function ArchEdge({ from, to, label }) {
  const x1 = from.x
  const y1 = from.y + 28
  const x2 = to.x
  const y2 = to.y - 28
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2

  return (
    <g className="arch-edge">
      <line x1={x1} y1={y1} x2={x2} y2={y2} className="arch-line" />
      <polygon
        points={`${x2},${y2} ${x2 - 4},${y2 - 8} ${x2 + 4},${y2 - 8}`}
        className="arch-arrow"
      />
      <rect
        x={mx - label.length * 3.2}
        y={my - 8}
        width={label.length * 6.4}
        height={16}
        rx={4}
        className="arch-edge-bg"
      />
      <text
        x={mx}
        y={my + 1}
        className="arch-edge-label"
        textAnchor="middle"
        dominantBaseline="central"
      >
        {label}
      </text>
    </g>
  )
}

function ArchDiagram() {
  const nodeMap = Object.fromEntries(ARCH_NODES.map((node) => [node.id, node]))

  return (
    <svg
      className="arch-svg"
      viewBox="0 0 800 560"
      role="img"
      aria-label="Architecture: wallet limits inform the AI strategy and council gate; one Funding Router signature deploys scoped agents; the agents deposit into one Autofarm Vault, which supplies the Blend v2 pool"
    >
      <rect x={585} y={392} width={180} height={22} rx={6} className="arch-gas-bg" />
      <text
        x={675}
        y={403}
        className="arch-gas-text"
        textAnchor="middle"
        dominantBaseline="central"
      >
        Network fee sponsored by fee-bump relay
      </text>
      {ARCH_EDGES.map((edge) => (
        <ArchEdge
          key={`${edge.from}-${edge.to}`}
          from={nodeMap[edge.from]}
          to={nodeMap[edge.to]}
          label={edge.label}
        />
      ))}
      {ARCH_NODES.map((node) => (
        <ArchNode key={node.id} node={node} />
      ))}
    </svg>
  )
}

function initials(name) {
  const words = name.split(/\s+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function EcoCard({ item }) {
  const brandName = CATALOG_BRANDS[item.id]
  const brand = ECOSYSTEM.find((entry) => entry.name === brandName)
  return (
    <article className="eco-card eco-card--brand" data-ecosystem-card={item.id}>
      <span className="eco-card__logo" aria-hidden="true">
        {brand?.icon ? (
          <img
            src={brand.icon}
            alt=""
            loading="lazy"
            className={brand.iconDark ? 'eco-card__logo-icon--default' : undefined}
          />
        ) : (
          <span className="eco-card__mark">{initials(item.name)}</span>
        )}
        {brand?.iconDark ? (
          <img src={brand.iconDark} alt="" loading="lazy" className="eco-card__logo-icon--dark" />
        ) : null}
      </span>
      <h3 className="eco-card__name">{item.name}</h3>
      <span className={`eco-card__state eco-card__state--${item.state}`}>{item.status}</span>
    </article>
  )
}

function StandardBadge({ standard }) {
  return (
    <a
      className="eco-std"
      href={standard.link}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`${standard.id}: ${standard.desc}`}
    >
      <span className="eco-std__id">{standard.id}</span>
      <span className="eco-std__desc">{standard.desc}</span>
      <span className="eco-std__view">View documentation</span>
    </a>
  )
}

const STELLAR_ROUTE = Object.freeze({
  hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  destinationNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  transitState: 'none',
})

const CCTP_ROUTE = Object.freeze({
  hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
  custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  transitState: 'unknown',
})

function CatalogRow({ item, fact }) {
  const statusFact = { ...fact, state: fact.state }
  return (
    <li
      className="eco-catalog-row"
      data-ecosystem-list-card={item.id}
      data-testid={`ecosystem-row-${item.id}`}
    >
      <div className="eco-catalog-row__heading">
        <h3>{item.name}</h3>
        <span className={`eco-catalog-row__state eco-catalog-row__state--${item.state}`}>
          {item.status}
        </span>
      </div>
      {item.networkId && <NetworkBadge networkId={item.networkId} compact />}
      {item.network && <p className="eco-catalog-row__network">Network: {item.network}</p>}
      {item.kind === 'base-proxy' ? (
        <VenueTruth kind="base-proxy" fact={statusFact} />
      ) : item.kind === 'bridge' ? (
        <NetworkRoute context={CCTP_ROUTE} compact />
      ) : (
        <p className="eco-catalog-row__truth">{item.truth}</p>
      )}
      <p className="eco-catalog-row__description">{item.description}</p>
      <p className="eco-catalog-row__source">
        Source: <span>{item.source}</span>
      </p>
    </li>
  )
}

/* ── page ──────────────────────────────────────────────────────────────── */

export default function EcosystemPage({ ecosystemRead } = {}) {
  const navigate = useNavigate()
  const settledRead = ecosystemRead || DEFAULT_ECOSYSTEM_MODEL
  const presentation = toEcosystemPresentation(settledRead)
  const model = Array.isArray(settledRead.cards) ? settledRead : DEFAULT_ECOSYSTEM_MODEL
  const fact = presentation.fact
  const statusFact = {
    ...fact,
    consequence: presentation.notice.consequence,
    safeNextAction: presentation.notice.nextAction,
  }

  const launchApp = () => {
    localStorage.setItem('yv_skip_landing', 'true')
    localStorage.setItem('yv_onboarded', 'true')
    navigate('/strategy')
  }

  return (
    <div className="eco-page">
      <NavBar />

      <main className="eco-main" id="main-content" data-route-heading>
        <StageShell
          eyebrow="Public catalog"
          title="Ecosystem"
          description="Vibing Farmer runs on Soroban contracts, scoped agent accounts, current market data, and an allowlisted fee-bump relay."
          state={fact.state}
        >
          <div className="eco-stage-evidence">
            <NetworkRoute context={STELLAR_ROUTE} />
            <StatusNotice fact={statusFact} title="Catalog read" />
            {fact.state === 'unavailable' && presentation.notice.consequence && (
              <div className="eco-notice-copy" role="status">
                <p>{presentation.notice.consequence}</p>
                {presentation.notice.nextAction && <p>{presentation.notice.nextAction}</p>}
              </div>
            )}
            <TechnicalDetails summary="Technical details" fact={fact} open />
          </div>
        </StageShell>

        <section className="eco-section" aria-labelledby="eco-sec-partners">
          <h2 id="eco-sec-partners" className="eco-section__title">
            Core services
          </h2>
          <div className="eco-grid">
            {model.cards.map((item) => (
              <EcoCard key={item.id} item={item} />
            ))}
          </div>
        </section>

        <section className="eco-section eco-section--catalog" aria-labelledby="eco-sec-catalog">
          <h2 id="eco-sec-catalog" className="eco-section__title">
            Service details
          </h2>
          <ol className="eco-catalog-list" aria-label="Ecosystem services">
            {model.cards.map((item) => (
              <CatalogRow key={item.id} item={item} fact={fact} />
            ))}
          </ol>
        </section>

        <section className="eco-section" aria-labelledby="eco-sec-stds">
          <h2 id="eco-sec-stds" className="eco-section__title">
            Integrated standards
          </h2>
          <div className="eco-stds-wrap">
            {STANDARDS.map((standard) => (
              <StandardBadge key={standard.id} standard={standard} />
            ))}
          </div>
        </section>

        <section className="eco-section" aria-labelledby="eco-sec-arch">
          <h2 id="eco-sec-arch" className="eco-section__title">
            How they connect
          </h2>
          <div className="eco-diagram">
            <ArchDiagram />
          </div>
          <p className="eco-diagram-note">
            The service list above remains the readable source of the route. The diagram adds the
            execution sequence for visual scanning.
          </p>
        </section>

        <section className="eco-section eco-section--cta" aria-labelledby="eco-sec-cta">
          <div className="eco-cta__inner">
            <h2 id="eco-sec-cta" className="eco-cta__heading">
              Run a strategy
            </h2>
            <p className="eco-cta__tagline">Review the code or open the app.</p>
            <div className="eco-cta__row">
              <button className="eco-btn-primary" onClick={launchApp}>
                Launch app
              </button>
              <a
                className="eco-btn-ghost"
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer noopener"
              >
                View on GitHub
              </a>
            </div>
          </div>
        </section>

        <footer className="eco-foot">
          <span className="eco-foot__mark">vibing / farmer</span>
          <span className="eco-foot__tag">Set once. Vibe forever.</span>
        </footer>
      </main>
    </div>
  )
}
