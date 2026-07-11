// NavBar.jsx
// Shared top navigation for the public surfaces (LandingHero + ExplorerPage).
// Self-contained: carries its own wordmark + scoped <style> so it renders
// identically wherever it's mounted, inheriting only the palette CSS-var tokens.
//
// "Products" launches the app (persists yv_skip_landing → /strategy), mirroring
// LandingHero's onStart. External links (Resources, Whitepaper) open in a new tab.

import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'

const GITHUB_URL = 'https://github.com/poggufanz/vibingfarmer'
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
  const [menuOpen, setMenuOpen] = useState(false)

  const launchApp = () => {
    localStorage.setItem('yv_skip_landing', 'true')
    localStorage.setItem('yv_onboarded', 'true')
    setMenuOpen(false)
    navigate('/strategy')
  }

  const go = (path) => {
    setMenuOpen(false)
    navigate(path)
  }

  const isEcosystem = pathname === '/ecosystem'
  const isExplorer  = pathname === '/explorer'
  const isReplay    = pathname === '/replay'

  return (
    <nav className={`nv-bar${menuOpen ? ' is-open' : ''}`} aria-label="Main navigation">
      <NavStyle />
      <button className="nv-brand" onClick={() => go('/')} aria-label="Vibing Farmer home">
        <Wordmark />
      </button>

      <button
        type="button"
        className="nv-menu-btn"
        aria-expanded={menuOpen}
        aria-controls="nv-main-links"
        onClick={() => setMenuOpen((o) => !o)}
      >
        {menuOpen ? 'Close' : 'Menu'}
      </button>

      <div className="nv-links" id="nv-main-links">
        <button className="nv-link" onClick={launchApp}>Products</button>
        <button
          className={`nv-link${isEcosystem ? ' is-active' : ''}`}
          onClick={() => go('/ecosystem')}
          aria-current={isEcosystem ? 'page' : undefined}
        >
          Ecosystem
        </button>
        <button
          className={`nv-link${isExplorer ? ' is-active' : ''}`}
          onClick={() => go('/explorer')}
          aria-current={isExplorer ? 'page' : undefined}
        >
          Explorer
        </button>
        <button
          className={`nv-link${isReplay ? ' is-active' : ''}`}
          onClick={() => go('/replay')}
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
  color: var(--text-faint, #7a7a70);
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
  padding: 0.55rem 0.65rem;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
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
.nv-cta:hover { transform: translateY(-1px); }
.nv-cta:hover span { transform: translateX(3px); }
.nv-cta:active { transform: translateY(0); }
.nv-cta:focus-visible { outline: 2px solid var(--accent, #cfff3d); outline-offset: 2px; }

.nv-menu-btn {
  display: none;
  appearance: none;
  background: none;
  border: 1px solid var(--border-strong, rgba(255,255,255,0.13));
  color: var(--text, #ecebe1);
  border-radius: var(--radius-sm, 4px);
  min-width: 44px;
  min-height: 44px;
  margin-left: auto;
  margin-right: 0.5rem;
  cursor: pointer;
  font-family: var(--font-mono, monospace);
  font-size: 0.75rem;
}
.nv-menu-btn:focus-visible { outline: 2px solid var(--accent, #cfff3d); outline-offset: 2px; }

/* ---------- responsive ---------- */
@media (max-width: 860px) {
  .nv-menu-btn { display: inline-flex; align-items: center; justify-content: center; }
  .nv-links {
    display: none;
    position: absolute;
    top: 64px; left: 0; right: 0;
    flex-direction: column;
    align-items: stretch;
    gap: 0;
    margin-left: 0;
    padding: 0.5rem;
    background: var(--bg-canvas, #131410);
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
  }
  .nv-bar.is-open .nv-links { display: flex; }
  .nv-link { min-height: 44px; width: 100%; justify-content: flex-start; }
  .nv-bar { gap: 0; position: fixed; }
  .nv-cta { margin-left: 0; }
}
`}</style>
  )
}
