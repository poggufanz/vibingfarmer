// EcosystemPage.jsx
// Public tech-stack + partner page for Vibing Farmer.
// Aesthetic: dark terminal, acid accent, monospace labels.
// Same pattern as ExplorerPage: fixed scroll container, inherited CSS-var tokens.

import { useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import NavBar from './NavBar.jsx'
import { ECOSYSTEM } from './LandingHero.jsx'

/* ------------------------------------------------------------------ */
/* data                                                                  */
/* ------------------------------------------------------------------ */

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

/* ── Visual architecture diagram (SVG) ── */

// Node layout coordinates (designed for 800×560 viewBox). Mirrors the real pipeline in
// CLAUDE.md: wallet → AI + council/gate → one grant → scoped agents (parallel) → ONE autofarm
// vault (deposits fee-bumped by the relay) → Blend v2. Single vault, not one-per-agent.
const ARCH_NODES = [
  {
    id: 'wallet',
    x: 400,
    y: 42,
    label: 'User Wallet',
    sub: 'VF Wallet / Freighter',
    icon: 'W',
    color: '#ecebe1',
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
    color: '#cfff3d',
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
  const w = 200,
    h = 56,
    rx = 10
  return (
    <g className={'arch-node' + (node.hero ? ' arch-node--hero' : '')}>
      {node.hero && (
        <rect
          x={node.x - w / 2 - 4}
          y={node.y - h / 2 - 4}
          width={w + 8}
          height={h + 8}
          rx={rx + 2}
          className="arch-glow"
        />
      )}
      <rect
        x={node.x - w / 2}
        y={node.y - h / 2}
        width={w}
        height={h}
        rx={rx}
        className="arch-card"
        style={{ stroke: node.hero ? 'rgba(207,255,61,0.4)' : undefined }}
      />
      {/* icon circle */}
      <circle
        cx={node.x - w / 2 + 24}
        cy={node.y}
        r={14}
        className="arch-icon-bg"
        style={{ fill: node.color + '18', stroke: node.color + '40' }}
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
      {/* labels */}
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

function ArchEdge({ from, to, label, index }) {
  const x1 = from.x,
    y1 = from.y + 28
  const x2 = to.x,
    y2 = to.y - 28
  const mx = (x1 + x2) / 2,
    my = (y1 + y2) / 2

  return (
    <g className="arch-edge">
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        className="arch-line"
        style={{ animationDelay: `${index * 0.3}s` }}
      />
      {/* arrowhead */}
      <polygon
        points={`${x2},${y2} ${x2 - 4},${y2 - 8} ${x2 + 4},${y2 - 8}`}
        className="arch-arrow"
      />
      {/* label */}
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
  const nodeMap = Object.fromEntries(ARCH_NODES.map((n) => [n.id, n]))

  return (
    <svg
      className="arch-svg"
      viewBox="0 0 800 560"
      role="img"
      aria-label="Architecture: the user's limits inform the AI strategy and council gate; one Funding Router signature deploys scoped agent accounts; the agents deposit — fees covered by the relay — into a single Autofarm vault, which supplies the Blend v2 pool for yield"
    >
      <defs>
        <filter id="arch-glow-f">
          <feGaussianBlur stdDeviation="8" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {/* gas badge — annotates the relayed deposit hop (fee-bump relay covers agent fees) */}
      <rect x={585} y={392} width={180} height={22} rx={6} className="arch-gas-bg" />
      <text
        x={675}
        y={403}
        className="arch-gas-text"
        textAnchor="middle"
        dominantBaseline="central"
      >
        Fee-bump relay: fees covered
      </text>
      {/* edges first (behind nodes) */}
      {ARCH_EDGES.map((e, i) => (
        <ArchEdge key={i} from={nodeMap[e.from]} to={nodeMap[e.to]} label={e.label} index={i} />
      ))}
      {/* nodes */}
      {ARCH_NODES.map((n) => (
        <ArchNode key={n.id} node={n} />
      ))}
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* components                                                            */
/* ------------------------------------------------------------------ */

// Wordmark fallback for entries without a shipped logo: initials of the first two words
// (e.g. "Blend Capital" -> "BC", "Soroban" -> "SO"), the same 2-char lockup style as the
// old partner marks and the design-system wallet monogram.
function initials(name) {
  const words = name.split(/\s+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function EcoCard({ item }) {
  return (
    <article className="eco-card eco-card--brand">
      <span className="eco-card__logo" aria-hidden="true">
        {item.icon ? (
          <img src={item.icon} alt="" loading="lazy" />
        ) : (
          <span className="eco-card__mark">{initials(item.name)}</span>
        )}
      </span>
      <h3 className="eco-card__name">{item.name}</h3>
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
            Vibing Farmer runs on Soroban contracts, scoped agent accounts, current market data, and
            an allowlisted fee-bump relay.
          </p>
        </header>

        {/* partners */}
        <section className="eco-section" aria-labelledby="eco-sec-partners">
          <h2 id="eco-sec-partners" className="eco-section__title">
            Core services
          </h2>
          <div className="eco-grid">
            {ECOSYSTEM.map((item) => (
              <EcoCard key={item.name} item={item} />
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
          <div ref={diagramRef} className="eco-diagram">
            <ArchDiagram />
          </div>
        </section>

        {/* CTA */}
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

/* ------------------------------------------------------------------ */
/* styles                                                                */
/* ------------------------------------------------------------------ */

function EcoStyle() {
  return (
    <style>{`
/* Fixed + own scroll - same pattern as ExplorerPage. */
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
/* Faint grid texture - same atmosphere as hero / explorer. */
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

/* ---------- ecosystem cards (logo + name, one source with the landing marquee) ---------- */
.eco-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.7rem;
}
.eco-card {
  border: 1px solid var(--border-strong, rgba(255,255,255,0.13));
  border-radius: var(--radius-lg, 14px);
  background: var(--bg-card, #1a1b16);
  transition: transform 220ms cubic-bezier(0.16,1,0.3,1),
              border-color 220ms ease, box-shadow 220ms ease;
}
.eco-card--brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.85rem;
  padding: clamp(1.4rem, 3vw, 1.9rem) 1rem;
  text-align: center;
}
.eco-card:hover {
  border-color: var(--border-accent, rgba(207,255,61,0.4));
}
.eco-card__logo {
  display: inline-grid;
  place-items: center;
  height: 40px;
}
.eco-card__logo img {
  height: 32px;
  width: auto;
  /* each logo carries its own official brand color — shown at full strength, not tinted. */
}
.eco-card__mark {
  display: inline-grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: 1px solid var(--border-strong, rgba(255,255,255,0.13));
  border-radius: var(--radius-sm, 4px);
  background: var(--bg-elev, #22231d);
  font-family: var(--font-mono, "JetBrains Mono", monospace);
  font-size: 0.82rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text, #ecebe1);
}
.eco-card__name {
  font-family: var(--font-display, "Geist", sans-serif);
  font-weight: 600;
  font-size: clamp(0.9rem, 1.4vw, 1.05rem);
  letter-spacing: -0.015em;
  color: var(--text, #ecebe1);
  margin: 0;
}

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
.eco-btn-primary:active { transform: scale(0.97); }
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
}
.eco-btn-ghost:active { transform: scale(0.97); }
.eco-btn-ghost:focus-visible { outline: 2px solid var(--eco-accent); outline-offset: 2px; }

@media (hover: hover) and (pointer: fine) {
  .eco-card:hover { transform: translateY(-2px); box-shadow: 0 8px 32px -8px rgba(0,0,0,0.55); }
  .eco-extlink:hover span { transform: translate(2px, -2px); }
  .eco-std:hover { transform: translateY(-2px); }
  .eco-btn-primary:hover { transform: translateY(-2px); box-shadow: 0 0 40px 2px rgba(207,255,61,0.38); }
  .eco-btn-primary:hover span { transform: translateX(4px); }
  .eco-btn-primary:active { transform: scale(0.97); }
  .eco-btn-ghost:hover { transform: translateY(-1px); }
  .eco-btn-ghost:hover span { transform: translate(2px, -2px); }
  .eco-btn-ghost:active { transform: scale(0.97); }
}

@media (prefers-reduced-motion: reduce) {
  .arch-glow,
  .arch-line { animation: none !important; }
  .eco-card,
  .eco-extlink span,
  .eco-std,
  .eco-btn-primary,
  .eco-btn-primary span,
  .eco-btn-ghost,
  .eco-btn-ghost span { transition: color 160ms ease, border-color 160ms ease; }
  .eco-card:hover,
  .eco-std:hover,
  .eco-btn-primary:hover,
  .eco-btn-primary:active,
  .eco-btn-ghost:hover,
  .eco-btn-ghost:active { transform: none; }
  .eco-extlink:hover span,
  .eco-btn-primary:hover span,
  .eco-btn-ghost:hover span { transform: none; }
}

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
  .eco-grid { grid-template-columns: repeat(3, 1fr); }
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
  .eco-grid { grid-template-columns: repeat(2, 1fr); }
}
`}</style>
  )
}
