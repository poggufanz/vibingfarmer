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
    name: 'MetaMask',
    subtitle: 'Smart Accounts Kit',
    category: 'WALLET',
    description:
      'EIP-7702 smart account upgrade and ERC-7715 scoped permission delegation. The wallet layer that makes bounded autonomy possible.',
    tags: ['EIP-7702', 'ERC-7715', 'Flask 13.9+'],
    link: 'https://docs.metamask.io/smart-accounts-kit',
    mark: 'MM',
  },
  {
    name: 'Venice AI',
    subtitle: 'Privacy-First AI Brain',
    category: 'AI',
    description:
      'Zero-retention inference via TEE + E2EE. 200+ open-source models. Vibing Farmer uses Venice to generate yield strategies with full privacy.',
    tags: ['llama-3.3-70b', 'TEE', 'Zero-retention'],
    link: 'https://venice.ai',
    mark: 'VA',
  },
  {
    name: '1Shot API',
    subtitle: 'Gasless Relayer',
    category: 'RELAYER',
    description:
      'Permissionless EIP-7710 relayer. Vibing Farmer agents pay $0 in gas. 1Shot sponsors every execution via stablecoin gas payments.',
    tags: ['EIP-7710', 'Gas abstraction', 'Stablecoin'],
    link: 'https://1shotapi.com',
    mark: '1S',
  },
  {
    name: 'DeFiLlama',
    subtitle: 'Live Yield Data',
    category: 'DATA',
    description:
      'Real-time APY and TVL data from 1000+ DeFi protocols. Venice AI receives live market data before generating any strategy recommendation.',
    tags: ['APY', 'TVL', 'Real-time'],
    link: 'https://defillama.com',
    mark: 'DL',
  },
  {
    name: 'Tavily',
    subtitle: 'Market Intelligence',
    category: 'SEARCH',
    description:
      'AI-powered web search for real-time market context and security signals. Risk watcher uses Tavily to detect protocol exploits before they affect positions.',
    tags: ['Risk signals', 'Market intel', 'AI search'],
    link: 'https://tavily.com',
    mark: 'TV',
  },
  {
    name: 'Base Sepolia',
    subtitle: 'L2 Testnet',
    category: 'CHAIN',
    description:
      'All Vibing Farmer contracts are deployed and verified on Base Sepolia. Every transaction, permission, and attestation is publicly verifiable on-chain.',
    tags: ['Chain ID 84532', 'OP Stack L2', 'Verified'],
    link: 'https://sepolia.basescan.org',
    mark: 'BS',
  },
]

const STANDARDS = [
  { id: 'EIP-7702', desc: 'Smart account delegation',   link: 'https://eips.ethereum.org/EIPS/eip-7702' },
  { id: 'ERC-7715', desc: 'Scoped permissions',         link: 'https://eips.ethereum.org/EIPS/eip-7715' },
  { id: 'EIP-7710', desc: 'Delegation redemption',      link: 'https://eips.ethereum.org/EIPS/eip-7710' },
  { id: 'ERC-4626', desc: 'Tokenized vault standard',   link: 'https://eips.ethereum.org/EIPS/eip-4626' },
  { id: 'x402',     desc: 'HTTP-native payments',       link: 'https://x402.org' },
  { id: 'ERC-8004', desc: 'AI agent identity',          link: 'https://eips.ethereum.org/EIPS/eip-8004' },
]

const GITHUB_URL = 'https://github.com/poggufanz/yield-vibing'

// Static colored diagram — dangerouslySetInnerHTML is safe: fully hardcoded, no user input.
const DIAGRAM_HTML =
`<span class="eco-d-base">User Wallet</span>
    │
    │  <span class="eco-d-accent">EIP-7702 (MetaMask Flask)</span>
    ▼
<span class="eco-d-base">Smart Account</span> ─── <span class="eco-d-accent">ERC-7715 Permission</span>
    │
    │  AI Strategy
    │  <span class="eco-d-muted">Venice AI ← DeFiLlama APY ← Tavily Context</span>
    ▼
<span class="eco-d-bright">AgentVaultDepositor.sol</span>
    │
    ├── Worker-1 ──► Vault A <span class="eco-d-muted">(aave-v3)</span>
    │                 <span class="eco-d-muted">ERC-4626</span>
    └── Worker-2 ──► Vault B <span class="eco-d-muted">(morpho-blue)</span>
                      <span class="eco-d-muted">ERC-4626</span>
    │
    │  <span class="eco-d-accent">Gas: $0 (1Shot · EIP-7710)</span>
    ▼
<span class="eco-d-muted">Base Sepolia</span>`

/* ------------------------------------------------------------------ */
/* components                                                            */
/* ------------------------------------------------------------------ */

function PartnerCard({ partner }) {
  return (
    <article className="eco-card">
      <div className="eco-card__head">
        <span className="eco-card__mark" aria-hidden="true">{partner.mark}</span>
        <span className="eco-card__cat">{partner.category}</span>
      </div>
      <h3 className="eco-card__name">{partner.name}</h3>
      <p className="eco-card__sub">{partner.subtitle}</p>
      <p className="eco-card__desc">{partner.description}</p>
      <div className="eco-card__tags">
        {partner.tags.map((t) => (
          <span key={t} className="eco-tag">{t}</span>
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
        View EIP <span aria-hidden="true">↗</span>
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
            The infrastructure powering Vibing Farmer. Built on battle-tested
            primitives, privacy-first AI, and permissionless relaying.
          </p>
        </header>

        {/* partners */}
        <section className="eco-section" aria-labelledby="eco-sec-partners">
          <h2 id="eco-sec-partners" className="eco-section__title">Powered by</h2>
          <div className="eco-grid">
            {PARTNERS.map((p) => (
              <PartnerCard key={p.name} partner={p} />
            ))}
          </div>
        </section>

        {/* standards */}
        <section className="eco-section" aria-labelledby="eco-sec-stds">
          <h2 id="eco-sec-stds" className="eco-section__title">Integrated standards</h2>
          <div className="eco-stds-wrap">
            {STANDARDS.map((s) => (
              <StandardBadge key={s.id} standard={s} />
            ))}
          </div>
        </section>

        {/* architecture diagram */}
        <section className="eco-section" aria-labelledby="eco-sec-arch">
          <h2 id="eco-sec-arch" className="eco-section__title">How they connect</h2>
          <div
            ref={diagramRef}
            className="eco-diagram"
            role="img"
            aria-label="Architecture: user wallet via EIP-7702 to smart account with ERC-7715 permission; Venice AI + DeFiLlama + Tavily generate strategy; AgentVaultDepositor.sol dispatches parallel workers to ERC-4626 vaults; 1Shot EIP-7710 relayer pays all gas on Base Sepolia"
          >
            <pre
              className="eco-diagram__pre"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: DIAGRAM_HTML }}
            />
          </div>
        </section>

        {/* CTA */}
        <section className="eco-section eco-section--cta" aria-labelledby="eco-sec-cta">
          <div className="eco-cta__inner">
            <h2 id="eco-sec-cta" className="eco-cta__heading">Ready to vibe?</h2>
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

/* ---------- architecture diagram ---------- */
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
.eco-diagram__pre {
  font-family: var(--font-mono, "JetBrains Mono", monospace);
  font-size: clamp(0.72rem, 1vw, 0.84rem);
  line-height: 1.7;
  color: var(--text-muted, #95958a);
  background: var(--bg-card, #1a1b16);
  border: 1px solid var(--border-strong, rgba(255,255,255,0.13));
  border-radius: var(--radius-lg, 14px);
  padding: clamp(1.4rem, 3vw, 2rem) clamp(1.2rem, 3vw, 2.2rem);
  overflow-x: auto;
  white-space: pre;
  -webkit-overflow-scrolling: touch;
  margin: 0;
}
.eco-d-accent { color: var(--eco-accent); }
.eco-d-bright { color: var(--text, #ecebe1); font-weight: 600; }
.eco-d-base   { color: var(--text, #ecebe1); }
.eco-d-muted  { color: var(--text-faint, #56564f); }

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
