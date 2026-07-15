// NavBar.jsx
// Shared top navigation for the public surfaces (LandingHero + ExplorerPage).
// Self-contained: carries its own wordmark + scoped <style> so it renders
// identically wherever it's mounted, inheriting only the palette CSS-var tokens.
//
// The CTA launches the app (persists yv_skip_landing, then opens /strategy).
// LandingHero can provide the same in-memory callback used by its primary CTA.

import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'

const GITHUB_URL = 'https://github.com/poggufanz/vibingfarmer'
const DOCS_URL = 'https://vibingfarmer.gitbook.io/vibingfarmer/'

function Wordmark() {
  return (
    <span className="nv-wordmark">
      <span className="nv-wordmark__vibe">vibing</span>
      <span className="nv-wordmark__slash">/</span>
      <span className="nv-wordmark__farm">farmer</span>
    </span>
  )
}

export default function NavBar({ onLaunch }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)

  const launchApp = () => {
    setMenuOpen(false)
    if (onLaunch) {
      onLaunch()
      return
    }
    localStorage.setItem('yv_skip_landing', 'true')
    localStorage.setItem('yv_onboarded', 'true')
    navigate('/strategy')
  }

  const go = (path) => {
    setMenuOpen(false)
    navigate(path)
  }

  const isEcosystem = pathname === '/ecosystem'
  const isExplorer = pathname === '/explorer'
  const isReplay = pathname === '/replay'

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
        <a className="nv-link" href={GITHUB_URL} target="_blank" rel="noreferrer noopener">
          GitHub
        </a>
        <a className="nv-link" href={DOCS_URL} target="_blank" rel="noreferrer noopener">
          Docs
        </a>
      </div>

      <button className="nv-cta" onClick={launchApp}>
        Launch app
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
  color: var(--text, #ecebe1);
  background: var(--bg-elev, #22231d);
  border: 1px solid var(--border-strong, rgba(255,255,255,0.13));
  padding: 0.55rem 1.05rem;
  border-radius: var(--radius-md, 8px);
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
}
.nv-cta:focus-visible { outline: 2px solid var(--accent, #cfff3d); outline-offset: 2px; }

@media (hover: hover) and (pointer: fine) {
  .nv-link:hover::after { transform: scaleX(1); }
  .nv-cta:hover { transform: translateY(-1px); }
}

@media (prefers-reduced-transparency: reduce) {
  .nv-bar {
    background: var(--bg-base, #0e0f0c);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}

@media (prefers-contrast: more) {
  .nv-bar {
    background: var(--bg-base, #0e0f0c);
    border-bottom-color: var(--border-strong, rgba(255,255,255,0.13));
  }
}

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

.nv-brand,
.nv-menu-btn,
.nv-cta {
  transition: transform var(--duration-press, 160ms) var(--ease-out, cubic-bezier(0.23,1,0.32,1));
}
.nv-brand:active,
.nv-menu-btn:active,
.nv-cta:active { transform: scale(0.97); }

/* ---------- responsive ---------- */
@media (max-width: 860px) {
  .nv-menu-btn { display: inline-flex; align-items: center; justify-content: center; }
  .nv-links {
    display: flex;
    visibility: hidden;
    opacity: 0;
    pointer-events: none;
    position: absolute;
    top: 64px; left: 0; right: 0;
    flex-direction: column;
    align-items: stretch;
    gap: 0;
    margin-left: 0;
    padding: 0.5rem;
    background: var(--bg-canvas, #131410);
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
    transform: translateY(-8px) scale(0.98);
    transform-origin: top right;
    transition:
      opacity var(--duration-ui, 220ms) var(--ease-out, cubic-bezier(0.23,1,0.32,1)),
      transform var(--duration-ui, 220ms) var(--ease-out, cubic-bezier(0.23,1,0.32,1)),
      visibility 0s linear var(--duration-ui, 220ms);
  }
  .nv-bar.is-open .nv-links {
    visibility: visible;
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0) scale(1);
    transition-delay: 0s;
  }
  .nv-link { min-height: 44px; width: 100%; justify-content: flex-start; }
  .nv-bar { gap: 0; position: fixed; }
  .nv-cta { margin-left: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .nv-link::after { transition: none; }
  .nv-links {
    transform: none;
    transition:
      opacity var(--duration-press, 160ms) ease,
      visibility 0s linear var(--duration-press, 160ms);
  }
  .nv-bar.is-open .nv-links {
    transform: none;
    transition-delay: 0s;
  }
  .nv-brand,
  .nv-menu-btn,
  .nv-cta {
    transition:
      opacity var(--duration-press, 160ms) ease,
      color var(--duration-press, 160ms) ease;
  }
  .nv-brand:active,
  .nv-menu-btn:active,
  .nv-cta:active {
    opacity: 0.82;
    transform: none;
  }
  .nv-cta:hover {
    transform: none;
  }
}
`}</style>
  )
}
