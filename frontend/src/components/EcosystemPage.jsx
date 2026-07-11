// EcosystemPage.jsx
// Public tech-stack + partner page for Vibing Farmer.
// Aesthetic: dark terminal, acid accent, monospace labels.
// Same pattern as ExplorerPage: fixed scroll container, inherited CSS-var tokens.

import { useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import NavBar from './NavBar.jsx'

/* ------------------------------------------------------------------ */
/* data                                                                  */
/* ------------------------------------------------------------------ */

// Marks are 2-char monospace lockups (no emoji, per design system §8) —
// rendered uniform in currentColor so no per-partner accent competes with brand.
const PARTNERS = [
  {
    name: 'Stellar / Soroban',
    subtitle: 'Single-Chain Smart Contracts',
    category: 'CHAIN',
    description:
      'Soroban contracts on Stellar. The registry enforces per-agent ed25519 session-key scopes; the vault holds funds. Every authorize, deposit, and attestation is verifiable on Stellar testnet.',
    tags: ['Soroban', 'ed25519 auth', 'Testnet'],
    link: 'https://stellar.org/soroban',
    mark: 'ST',
  },
  {
    name: 'Freighter',
    subtitle: 'Stellar Wallet',
    category: 'WALLET',
    description:
      'A standard Stellar wallet (Freighter / xBull / Albedo). One signature authorizes and funds each agent. No smart-account upgrade, no browser permission prompt.',
    tags: ['Freighter', 'xBull', 'Albedo'],
    link: 'https://www.freighter.app',
    mark: 'FR',
  },
  {
    name: 'Fee-bump Relayer',
    subtitle: 'Gas Abstraction',
    category: 'RELAYER',
    description:
      'A funded relayer fee-bumps every agent transaction. Vibing Farmer users pay $0 in gas: the agent signs with its ed25519 key, the relayer pays.',
    tags: ['Fee-bump', 'Gas 0', 'ed25519'],
    link: 'https://developers.stellar.org/docs/learn/fundamentals/transactions/fee-bump-transactions',
    mark: 'FB',
  },
  {
    name: 'Venice AI',
    subtitle: 'Privacy-First AI Brain',
    category: 'AI',
    description:
      'Zero-retention inference via TEE + E2EE, wallet-funded through x402 + SIWE. DeepSeek V4 is the default strategist. Both generate yield strategies and per-agent skill sets.',
    tags: ['x402', 'TEE', 'DeepSeek V4'],
    link: 'https://venice.ai',
    mark: 'VA',
  },
  {
    name: 'DeFiLlama',
    subtitle: 'Live Yield Data',
    category: 'DATA',
    description:
      'Real-time APY and TVL data from 1000+ DeFi protocols. The AI strategist receives live market data before generating any strategy recommendation.',
    tags: ['APY', 'TVL', 'Real-time'],
    link: 'https://defillama.com',
    mark: 'DL',
  },
  {
    name: 'Tavily',
    subtitle: 'Market Intelligence',
    category: 'SEARCH',
    description:
      'AI-powered web search for real-time market context and security signals. The risk watcher uses Tavily to detect protocol exploits before they affect positions.',
    tags: ['Risk signals', 'Market intel', 'AI search'],
    link: 'https://tavily.com',
    mark: 'TV',
  },
]

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
    link: 'https://developers.stellar.org/docs/learn/fundamentals/transactions/fee-bump-transactions',
  },
  {
    id: 'Soroban Events',
    desc: 'On-chain audit trail',
    link: 'https://developers.stellar.org/docs/build/guides/events',
  },
  { id: 'x402', desc: 'HTTP-native payments', link: 'https://x402.org' },
  { id: 'Blend', desc: 'Real-yield lending (WIP)', link: 'https://www.blend.capital' },
]

const GITHUB_URL = 'https://github.com/poggufanz/vibingfarmer'

/* ── Visual architecture diagram (SVG) ── */

// Node layout coordinates (designed for 800×520 viewBox)
const ARCH_NODES = [
  { id: 'wallet',   x: 400, y: 40,  label: 'User Wallet',      sub: 'Freighter / xBull / Albedo', icon: 'W', color: '#ecebe1' },
  { id: 'ai',       x: 400, y: 140, label: 'AI Strategy',       sub: 'Venice AI / DeepSeek',        icon: 'AI', color: '#b8a9ff' },
  { id: 'registry', x: 400, y: 260, label: 'Registry',          sub: 'Soroban smart contract',      icon: 'RG', color: '#cfff3d', hero: true },
  { id: 'worker1',  x: 240, y: 370, label: 'Worker-1',          sub: 'Parallel agent',              icon: 'W1', color: '#ffb86c' },
  { id: 'worker2',  x: 560, y: 370, label: 'Worker-2',          sub: 'Parallel agent',              icon: 'W2', color: '#ffb86c' },
  { id: 'vault1',   x: 240, y: 460, label: 'Vault (USDC)',      sub: 'Soroban',                     icon: 'V1', color: '#7dd3c0' },
  { id: 'vault2',   x: 560, y: 460, label: 'Vault (USDC)',      sub: 'Soroban',                     icon: 'V2', color: '#7dd3c0' },
]

const ARCH_EDGES = [
  { from: 'wallet',   to: 'ai',       label: 'one signature' },
  { from: 'ai',       to: 'registry', label: 'strategy + skills' },
  { from: 'registry', to: 'worker1',  label: 'ed25519 scope' },
  { from: 'registry', to: 'worker2',  label: 'ed25519 scope' },
  { from: 'worker1',  to: 'vault1',   label: 'deposit' },
  { from: 'worker2',  to: 'vault2',   label: 'deposit' },
]

function ArchNode({ node }) {
  const w = 200, h = 56, rx = 10
  return (
    <g className={'arch-node' + (node.hero ? ' arch-node--hero' : '')}>
      {node.hero && (
        <rect
          x={node.x - w/2 - 4} y={node.y - h/2 - 4}
          width={w + 8} height={h + 8}
          rx={rx + 2}
          className="arch-glow"
        />
      )}
      <rect
        x={node.x - w/2} y={node.y - h/2}
        width={w} height={h}
        rx={rx}
        className="arch-card"
        style={{ stroke: node.hero ? 'rgba(207,255,61,0.4)' : undefined }}
      />
      {/* icon circle */}
      <circle cx={node.x - w/2 + 24} cy={node.y} r={14} className="arch-icon-bg" style={{ fill: node.color + '18' , stroke: node.color + '40' }} />
      <text x={node.x - w/2 + 24} y={node.y + 1} className="arch-icon-text" style={{ fill: node.color }} dominantBaseline="central" textAnchor="middle">
        {node.icon}
      </text>
      {/* labels */}
      <text x={node.x - w/2 + 48} y={node.y - 6} className="arch-label" style={{ fill: node.hero ? node.color : undefined }}>
        {node.label}
      </text>
      <text x={node.x - w/2 + 48} y={node.y + 10} className="arch-sublabel">
        {node.sub}
      </text>
    </g>
  )
}

function ArchEdge({ from, to, label, index }) {
  const x1 = from.x, y1 = from.y + 28
  const x2 = to.x,   y2 = to.y - 28
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2

  return (
    <g className="arch-edge">
      <line x1={x1} y1={y1} x2={x2} y2={y2} className="arch-line" style={{ animationDelay: `${index * 0.3}s` }} />
      {/* arrowhead */}
      <polygon
        points={`${x2},${y2} ${x2-4},${y2-8} ${x2+4},${y2-8}`}
        className="arch-arrow"
      />
      {/* label */}
      <rect
        x={mx - label.length * 3.2} y={my - 8}
        width={label.length * 6.4} height={16}
        rx={4}
        className="arch-edge-bg"
      />
      <text x={mx} y={my + 1} className="arch-edge-label" textAnchor="middle" dominantBaseline="central">
        {label}
      </text>
    </g>
  )
}

function ArchDiagram() {
  const nodeMap = Object.fromEntries(ARCH_NODES.map(n => [n.id, n]))

  return (
    <svg className="arch-svg" viewBox="0 0 800 520" role="img" aria-label="Architecture: user wallet signs once, AI strategy generates plan, Registry enforces ed25519 scopes, parallel workers deposit to vaults">
      <defs>
        <filter id="arch-glow-f">
          <feGaussianBlur stdDeviation="8" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      {/* gas badge */}
      <rect x={325} y={494} width={150} height={22} rx={6} className="arch-gas-bg" />
      <text x={400} y={505} className="arch-gas-text" textAnchor="middle" dominantBaseline="central">
        Gas: $0 (fee-bump relayer)
      </text>
      {/* edges first (behind nodes) */}
      {ARCH_EDGES.map((e, i) => (
        <ArchEdge key={i} from={nodeMap[e.from]} to={nodeMap[e.to]} label={e.label} index={i} />
      ))}
      {/* nodes */}
      {ARCH_NODES.map(n => <ArchNode key={n.id} node={n} />)}
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* components                                                            */
/* ------------------------------------------------------------------ */

function PartnerCard({ partner }) {
  return (
    <article className="eco-card">
      <div className="eco-card__head">
        <span className="eco-card__mark" aria-hidden="true">
          {partner.mark}
        </span>
        <span className="eco-card__cat">{partner.category}</span>
      </div>
      <h3 className="eco-card__name">{partner.name}</h3>
      <p className="eco-card__sub">{partner.subtitle}</p>
      <p className="eco-card__desc">{partner.description}</p>
      <div className="eco-card__tags">
        {partner.tags.map((t) => (
          <span key={t} className="eco-tag">
            {t}
          </span>
        ))}
      </div>
      <a
        className="eco-extlink"
        href={partner.link}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={`Learn more about ${partner.name}`}
      >
        Learn more <span aria-hidden="true">↗</span>
      </a>
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
      <span className="eco-std__view">
        View doc <span aria-hidden="true">↗</span>
      </span>
    </a>
  )
}

/* ------------------------------------------------------------------ */
/* page                                                                  */
/* ------------------------------------------------------------------ */

export default function EcosystemPage() {
  const navigate = useNavigate()
  const diagramRef = useRef(null)

  useEffect(() => {
    const el = diagramRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.classList.add('is-visible')
          obs.disconnect()
        }
      },
      { threshold: 0.2 }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const launchApp = () => {
    localStorage.setItem('yv_skip_landing', 'true')
    localStorage.setItem('yv_onboarded', 'true')
    navigate('/strategy')
  }

  return (
    <div className="eco-page">
      <EcoStyle />
      <NavBar />

      <main className="eco-main">
        {/* header */}
        <header className="eco-header">
          <h1 className="eco-title">Ecosystem</h1>
          <p className="eco-lede">
            The infrastructure powering Vibing Farmer. Built on Soroban smart contracts,
            privacy-first AI, and gas-abstracted fee-bump relaying.
          </p>
        </header>

        {/* partners */}
        <section className="eco-section" aria-labelledby="eco-sec-partners">
          <h2 id="eco-sec-partners" className="eco-section__title">
            Powered by
          </h2>
          <div className="eco-grid">
            {PARTNERS.map((p) => (
              <PartnerCard key={p.name} partner={p} />
            ))}
          </div>
        </section>

        {/* standards */}
        <section className="eco-section" aria-labelledby="eco-sec-stds">
          <h2 id="eco-sec-stds" className="eco-section__title">
            Integrated standards
          </h2>
          <div className="eco-stds-wrap">
            {STANDARDS.map((s) => (
              <StandardBadge key={s.id} standard={s} />
            ))}
          </div>
        </section>

        {/* architecture diagram */}
        <section className="eco-section" aria-labelledby="eco-sec-arch">
          <h2 id="eco-sec-arch" className="eco-section__title">
            How they connect
          </h2>
          <div
            ref={diagramRef}
            className="eco-diagram"
          >
            <ArchDiagram />
          </div>
        </section>

        {/* CTA */}
        <section className="eco-section eco-section--cta" aria-labelledby="eco-sec-cta">
          <div className="eco-cta__inner">
            <h2 id="eco-sec-cta" className="eco-cta__heading">
              Ready to vibe?
            </h2>
            <p className="eco-cta__tagline">
              Set once. <em>Vibe forever.</em>
            </p>
            <div className="eco-cta__row">
              <button className="eco-btn-primary" onClick={launchApp}>
                Launch App <span aria-hidden="true">→</span>
              </button>
              <a
                className="eco-btn-ghost"
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer noopener"
              >
                View on GitHub <span aria-hidden="true">↗</span>
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

/* ------------------------------------------------------------------ */
/* styles                                                                */
/* ------------------------------------------------------------------ */

function EcoStyle() {
  return (
    <style>{`
/* Fixed + own scroll — same pattern as ExplorerPage. */
.eco-page {
  position: fixed;
  inset: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  background: var(--bg-base, #0e0f0c);
  color: var(--text, #ecebe1);
  font-family: var(--font-body, "Geist", system-ui, sans-serif);
  --eco-accent: var(--accent, #cfff3d);
}
/* Faint grid texture — same atmosphere as hero / explorer. */
.eco-page::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background-image:
    linear-gradient(rgba(255,255,255,0.016) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.016) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(ellipse 90% 60% at 50% 0%, #000 20%, transparent 100%);
}

.eco-main {
  position: relative;
  z-index: 1;
  max-width: 1080px;
  margin: 0 auto;
  padding: calc(64px + clamp(2.5rem, 7vw, 5rem)) clamp(1.1rem, 5vw, 2.6rem) 4rem;
}

/* ---------- header ---------- */
.eco-header {
  padding-bottom: clamp(2rem, 5vw, 3.4rem);
  border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
}
.eco-title {
  font-family: var(--font-display, "Geist", sans-serif);
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1;
  font-size: clamp(2.6rem, 7vw, 4.6rem);
  color: var(--text, #ecebe1);
}
.eco-lede {
  margin-top: 1.1rem;
  max-width: 62ch;
  font-family: var(--font-mono, monospace);
  font-size: clamp(0.82rem, 1.1vw, 0.95rem);
  line-height: 1.7;
  color: var(--text-muted, #95958a);
}

/* ---------- sections ---------- */
.eco-section {
  padding: clamp(2.2rem, 5vw, 3.6rem) 0;
  border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
}
.eco-section--cta { border-bottom: none; }
.eco-section__title {
  font-family: var(--font-mono, monospace);
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--eco-accent);
  margin-bottom: 1.5rem;
}

/* ---------- partner cards ---------- */
.eco-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.7rem;
}
.eco-card {
  border: 1px solid var(--border-strong, rgba(255,255,255,0.13));
  border-radius: var(--radius-lg, 14px);
  background: var(--bg-card, #1a1b16);
  padding: clamp(1.1rem, 2.2vw, 1.4rem);
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  transition: transform 220ms cubic-bezier(0.16,1,0.3,1),
              border-color 220ms ease, box-shadow 220ms ease;
}
.eco-card:hover {
  transform: translateY(-2px);
  border-color: var(--border-accent, rgba(207,255,61,0.4));
  box-shadow: 0 8px 32px -8px rgba(0,0,0,0.55);
}
.eco-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.eco-card__mark {
  flex-shrink: 0;
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--border-strong, rgba(255,255,255,0.13));
  border-radius: var(--radius-sm, 4px);
  background: var(--bg-elev, #22231d);
  font-family: var(--font-mono, "JetBrains Mono", monospace);
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text, #ecebe1);
}
.eco-card__cat {
  font-family: var(--font-mono, monospace);
  font-size: 0.6rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-faint, #56564f);
  background: var(--bg-elev, #22231d);
  border: 1px solid var(--border, rgba(255,255,255,0.06));
  border-radius: var(--radius-sm, 4px);
  padding: 0.28rem 0.55rem;
  white-space: nowrap;
}
.eco-card__name {
  font-family: var(--font-display, "Geist", sans-serif);
  font-weight: 600;
  font-size: clamp(1rem, 1.5vw, 1.15rem);
  letter-spacing: -0.015em;
  color: var(--text, #ecebe1);
  margin: 0;
}
.eco-card__sub {
  font-family: var(--font-mono, monospace);
  font-size: 0.75rem;
  color: var(--text-muted, #95958a);
  margin: 0;
}
.eco-card__desc {
  font-family: var(--font-mono, monospace);
  font-size: 0.78rem;
  line-height: 1.55;
  color: var(--text-muted, #95958a);
  margin: 0;
  flex-grow: 1;
}
.eco-card__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.eco-tag {
  font-family: var(--font-mono, monospace);
  font-size: 0.62rem;
  letter-spacing: 0.02em;
  padding: 0.25rem 0.55rem;
  border-radius: var(--radius-sm, 4px);
  background: var(--bg-elev, #22231d);
  border: 1px solid var(--border, rgba(255,255,255,0.06));
  color: var(--text-muted, #95958a);
}
.eco-extlink {
  font-family: var(--font-mono, monospace);
  font-size: 0.74rem;
  letter-spacing: 0.01em;
  color: var(--eco-accent);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 0.4ch;
  margin-top: auto;
}
.eco-extlink span { transition: transform 200ms cubic-bezier(0.16,1,0.3,1); }
.eco-extlink:hover span { transform: translate(2px, -2px); }
.eco-extlink:focus-visible { outline: 2px solid var(--eco-accent); outline-offset: 2px; }

/* ---------- standards row ---------- */
.eco-stds-wrap {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 0.7rem;
}
.eco-std {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  border: 1px solid var(--border-strong, rgba(255,255,255,0.13));
  border-radius: var(--radius-lg, 14px);
  background: var(--bg-card, #1a1b16);
  padding: 1.1rem 1rem;
  text-decoration: none;
  transition: border-color 200ms ease, transform 200ms cubic-bezier(0.16,1,0.3,1);
}
.eco-std:hover {
  border-color: var(--border-accent, rgba(207,255,61,0.4));
  transform: translateY(-2px);
}
.eco-std:focus-visible { outline: 2px solid var(--eco-accent); outline-offset: 2px; }
.eco-std__id {
  font-family: var(--font-mono, monospace);
  font-size: 0.9rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--eco-accent);
  line-height: 1;
}
.eco-std__desc {
  font-family: var(--font-mono, monospace);
  font-size: 0.68rem;
  line-height: 1.45;
  color: var(--text-muted, #95958a);
  flex-grow: 1;
}
.eco-std__view {
  font-family: var(--font-mono, monospace);
  font-size: 0.64rem;
  letter-spacing: 0.04em;
  color: var(--text-faint, #56564f);
  display: inline-flex;
  align-items: center;
  gap: 0.3ch;
  margin-top: auto;
}

/* ---------- architecture diagram (SVG) ---------- */
.eco-diagram {
  opacity: 0;
  transform: translateY(14px);
  transition: opacity 600ms ease, transform 600ms cubic-bezier(0.16,1,0.3,1);
}
.eco-diagram.is-visible {
  opacity: 1;
  transform: translateY(0);
}
@media (prefers-reduced-motion: reduce) {
  .eco-diagram { opacity: 1 !important; transform: none !important; transition: none !important; }
}
.arch-svg {
  display: block;
  width: 100%;
  max-width: 800px;
  height: auto;
  margin: 0 auto;
}
.arch-card {
  fill: var(--bg-card, #1a1b16);
  stroke: var(--border-strong, rgba(255,255,255,0.13));
  stroke-width: 1;
  transition: stroke 200ms ease;
}
.arch-node:hover .arch-card {
  stroke: rgba(207,255,61,0.4);
}
.arch-glow {
  fill: none;
  stroke: rgba(207,255,61,0.15);
  stroke-width: 2;
  filter: url(#arch-glow-f);
  animation: arch-pulse 3s ease-in-out infinite;
}
@keyframes arch-pulse {
  0%, 100% { stroke: rgba(207,255,61,0.1); }
  50%      { stroke: rgba(207,255,61,0.3); }
}
.arch-icon-bg {
  stroke-width: 1;
}
.arch-icon-text {
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.arch-label {
  font-family: var(--font-display, "Geist", sans-serif);
  font-size: 11.5px;
  font-weight: 600;
  fill: var(--text, #ecebe1);
}
.arch-sublabel {
  font-family: var(--font-mono, monospace);
  font-size: 8.5px;
  fill: var(--text-faint, #56564f);
}
.arch-line {
  stroke: rgba(255,255,255,0.12);
  stroke-width: 1;
  stroke-dasharray: 6 4;
  stroke-dashoffset: 0;
  animation: arch-dash 8s linear infinite;
}
@keyframes arch-dash {
  to { stroke-dashoffset: -40; }
}
.arch-arrow {
  fill: rgba(255,255,255,0.2);
}
.arch-edge-bg {
  fill: var(--bg-base, #0e0f0c);
  stroke: var(--border, rgba(255,255,255,0.06));
  stroke-width: 0.5;
}
.arch-edge-label {
  font-family: var(--font-mono, monospace);
  font-size: 8px;
  letter-spacing: 0.03em;
  fill: var(--text-muted, #95958a);
}
.arch-gas-bg {
  fill: rgba(207,255,61,0.06);
  stroke: rgba(207,255,61,0.2);
  stroke-width: 0.5;
}
.arch-gas-text {
  font-family: var(--font-mono, monospace);
  font-size: 8.5px;
  font-weight: 600;
  fill: var(--eco-accent);
  letter-spacing: 0.03em;
}

/* ---------- CTA ---------- */
.eco-cta__inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.2rem;
  text-align: center;
  padding: clamp(2rem, 6vw, 4rem) clamp(1rem, 4vw, 2rem);
  background: radial-gradient(120% 80% at 50% 100%, rgba(207,255,61,0.07), transparent 60%);
  border-radius: var(--radius-xl, 18px);
}
.eco-cta__heading {
  font-family: var(--font-display, "Geist", sans-serif);
  font-weight: 700;
  letter-spacing: -0.035em;
  line-height: 1;
  font-size: clamp(2.2rem, 5.5vw, 4.2rem);
  color: var(--text, #ecebe1);
  margin: 0;
}
.eco-cta__tagline {
  font-family: var(--font-mono, monospace);
  font-size: clamp(0.84rem, 1.2vw, 0.98rem);
  color: var(--text-muted, #95958a);
  margin: 0;
}
.eco-cta__tagline em {
  font-family: var(--font-script, "Newsreader", serif);
  font-style: italic;
  font-weight: 500;
  color: var(--text-muted, #95958a);
}
.eco-cta__row {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  flex-wrap: wrap;
  justify-content: center;
  margin-top: 0.4rem;
}
.eco-btn-primary {
  font-family: var(--font-mono, monospace);
  font-weight: 600;
  font-size: 0.96rem;
  letter-spacing: 0.01em;
  padding: 0.9rem 2rem;
  border-radius: var(--radius-lg, 14px);
  color: var(--accent-fg, #0e0f0c);
  background: var(--eco-accent);
  border: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  transition: transform 220ms cubic-bezier(0.16,1,0.3,1),
              box-shadow 220ms ease;
}
.eco-btn-primary span { transition: transform 220ms cubic-bezier(0.16,1,0.3,1); }
.eco-btn-primary:hover { transform: translateY(-2px); box-shadow: 0 0 40px 2px rgba(207,255,61,0.38); }
.eco-btn-primary:hover span { transform: translateX(4px); }
.eco-btn-primary:active { transform: translateY(0); }
.eco-btn-primary:focus-visible { outline: 2px solid var(--eco-accent); outline-offset: 3px; }

.eco-btn-ghost {
  font-family: var(--font-mono, monospace);
  font-weight: 500;
  font-size: 0.96rem;
  letter-spacing: 0.01em;
  padding: 0.9rem 2rem;
  border-radius: var(--radius-lg, 14px);
  color: var(--text-muted, #95958a);
  background: transparent;
  border: 1px solid var(--border-strong, rgba(255,255,255,0.13));
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  text-decoration: none;
  transition: border-color 200ms ease, color 200ms ease,
              transform 200ms cubic-bezier(0.16,1,0.3,1);
}
.eco-btn-ghost span { transition: transform 200ms cubic-bezier(0.16,1,0.3,1); }
.eco-btn-ghost:hover {
  border-color: var(--border-accent, rgba(207,255,61,0.4));
  color: var(--text, #ecebe1);
  transform: translateY(-1px);
}
.eco-btn-ghost:hover span { transform: translate(2px, -2px); }
.eco-btn-ghost:focus-visible { outline: 2px solid var(--eco-accent); outline-offset: 2px; }

/* ---------- footer ---------- */
.eco-foot {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-top: 3rem;
  padding-top: 1.8rem;
  border-top: 1px solid var(--border, rgba(255,255,255,0.06));
}
.eco-foot__mark {
  font-family: var(--font-mono, monospace);
  font-size: 0.78rem;
  color: var(--text-muted, #95958a);
}
.eco-foot__tag {
  font-family: var(--font-script, "Newsreader", serif);
  font-style: italic;
  font-size: 0.95rem;
  color: var(--text-faint, #56564f);
}

/* ---------- responsive ---------- */
@media (max-width: 900px) {
  .eco-grid { grid-template-columns: repeat(2, 1fr); }
  .eco-stds-wrap {
    display: flex;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    padding-bottom: 0.6rem;
    scroll-snap-type: x mandatory;
    gap: 0.7rem;
  }
  .eco-std {
    flex-shrink: 0;
    min-width: 155px;
    scroll-snap-align: start;
  }
}
@media (max-width: 580px) {
  .eco-grid { grid-template-columns: 1fr; }
}
`}</style>
  )
}
