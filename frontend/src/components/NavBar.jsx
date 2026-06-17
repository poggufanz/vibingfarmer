// NavBar.jsx
// Shared top navigation for the public surfaces (LandingHero + ExplorerPage).
// Self-contained: carries its own wordmark + scoped <style> so it renders
// identically wherever it's mounted, inheriting only the palette CSS-var tokens.
//
// "Products" launches the app (persists yv_skip_landing → /strategy), mirroring
// LandingHero's onStart. External links (Resources, Whitepaper) open in a new tab.

import { useNavigate, useLocation } from 'react-router-dom'

const GITHUB_URL = 'https://github.com/poggufanz/yield-vibing'
const WHITEPAPER_URL = '/vibing-farmer-whitepaper.pdf'

function Wordmark() {
  return (
    <span className="nv-wordmark">
      <span className="nv-wordmark__vibe">vibing</span>
      <span className="nv-wordmark__slash">/</span>
      <span className="nv-wordmark__farm">farmer</span>
    </span>
  )
}

export default function NavBar() {
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const launchApp = () => {
    localStorage.setItem('yv_skip_landing', 'true')
    localStorage.setItem('yv_onboarded', 'true')
    navigate('/strategy')
  }

  const isEcosystem = pathname === '/ecosystem'
  const isExplorer  = pathname === '/explorer'
  const isReplay    = pathname === '/replay'

  return (
    <nav className="nv-bar" aria-label="Main navigation">
      <NavStyle />
      <button className="nv-brand" onClick={() => navigate('/')} aria-label="Vibing Farmer home">
        <Wordmark />
      </button>

      <div className="nv-links">
        <button className="nv-link" onClick={launchApp}>Products</button>
        <button
          className={`nv-link${isEcosystem ? ' is-active' : ''}`}
          onClick={() => navigate('/ecosystem')}
          aria-current={isEcosystem ? 'page' : undefined}
        >
          Ecosystem
        </button>
        <button
          className={`nv-link${isExplorer ? ' is-active' : ''}`}
          onClick={() => navigate('/explorer')}
          aria-current={isExplorer ? 'page' : undefined}
        >
          Explorer
        </button>
        <button
          className={`nv-link${isReplay ? ' is-active' : ''}`}
          onClick={() => navigate('/replay')}
          aria-current={isReplay ? 'page' : undefined}
        >
          Replay
        </button>
        <a className="nv-link" href={GITHUB_URL} target="_blank" rel="noreferrer noopener">Resources</a>
        <a className="nv-link" href={WHITEPAPER_URL} target="_blank" rel="noreferrer noopener">Whitepaper</a>
      </div>

      <button className="nv-cta" onClick={launchApp}>
        Launch <span aria-hidden="true">→</span>
      </button>
    </nav>
  )
}

function NavStyle() {
  return (
    <style>{`
.nv-bar {
  position: fixed;
  top: 0; left: 0; right: 0;
  z-index: 100;
  height: 64px;
  display: flex;
  align-items: center;
  gap: 1.2rem;
  padding: 0 clamp(1rem, 4vw, 2.6rem);
  background: color-mix(in oklab, var(--bg-base, #0e0f0c) 72%, transparent);
  -webkit-backdrop-filter: saturate(140%) blur(14px);
  backdrop-filter: saturate(140%) blur(14px);
  border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
  font-family: var(--font-body, "Geist", system-ui, sans-serif);
}

/* ---------- wordmark ---------- */
.nv-brand {
  appearance: none;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  display: inline-flex;
}
.nv-wordmark {
  display: inline-flex;
  align-items: baseline;
  gap: 0.38ch;
  font-size: clamp(1rem, 1.7vw, 1.22rem);
  letter-spacing: -0.01em;
  user-select: none;
}
.nv-wordmark__vibe {
  font-family: var(--font-script, "Newsreader", serif);
  font-style: italic;
  font-weight: 500;
  color: var(--text, #ecebe1);
}
.nv-wordmark__slash {
  color: var(--accent, #cfff3d);
  transform: translateY(-0.02em);
}
.nv-wordmark__farm {
  font-family: var(--font-mono, "JetBrains Mono", monospace);
  font-weight: 500;
  text-transform: lowercase;
  letter-spacing: 0.02em;
  color: var(--text, #ecebe1);
}

/* ---------- links ---------- */
.nv-links {
  display: flex;
  align-items: center;
  gap: clamp(0.3rem, 1.5vw, 1.1rem);
  margin-left: auto;
}
.nv-link {
  appearance: none;
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--font-mono, monospace);
  font-size: 0.82rem;
  letter-spacing: 0.01em;
  text-decoration: none;
  color: var(--text-muted, #95958a);
  padding: 0.45rem 0.55rem;
  border-radius: var(--radius-sm, 4px);
  position: relative;
  transition: color 180ms ease;
}
.nv-link::after {
  content: "";
  position: absolute;
  left: 0.55rem; right: 0.55rem; bottom: 0.28rem;
  height: 1px;
  background: var(--accent, #cfff3d);
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 220ms cubic-bezier(0.16,1,0.3,1);
}
.nv-link:hover { color: var(--text, #ecebe1); }
.nv-link:hover::after { transform: scaleX(1); }
.nv-link.is-active { color: var(--accent, #cfff3d); }
.nv-link.is-active::after { transform: scaleX(1); }
.nv-link:focus-visible {
  outline: 2px solid var(--accent, #cfff3d);
  outline-offset: 2px;
}

/* ---------- cta ---------- */
.nv-cta {
  appearance: none;
  cursor: pointer;
  font-family: var(--font-mono, monospace);
  font-weight: 600;
  font-size: 0.82rem;
  color: var(--accent-fg, #0e0f0c);
  background: var(--accent, #cfff3d);
  border: none;
  padding: 0.55rem 1.05rem;
  border-radius: var(--radius-md, 8px);
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  transition: transform 200ms cubic-bezier(0.16,1,0.3,1), box-shadow 200ms ease;
}
.nv-cta span { transition: transform 200ms cubic-bezier(0.16,1,0.3,1); }
.nv-cta:hover { transform: translateY(-1px); box-shadow: 0 0 28px 1px rgba(207,255,61,0.32); }
.nv-cta:hover span { transform: translateX(3px); }
.nv-cta:active { transform: translateY(0); }
.nv-cta:focus-visible { outline: 2px solid var(--accent, #cfff3d); outline-offset: 2px; }

/* ---------- responsive ---------- */
@media (max-width: 760px) {
  .nv-links { display: none; }
  .nv-bar { gap: 0; }
  .nv-cta { margin-left: auto; }
}
`}</style>
  )
}
