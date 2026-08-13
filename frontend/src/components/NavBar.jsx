// NavBar.jsx
// Shared top navigation for the public surfaces (LandingHero + ExplorerPage).
// Self-contained: carries its own wordmark + imported declarations so it renders
// identically wherever it's mounted, inheriting only the Pocket Crew tokens.
//
// The CTA launches the app (persists yv_skip_landing, then opens /strategy).
// LandingHero can provide the same in-memory callback used by its primary CTA.

import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { BrandLockup } from './pocket/BrandLockup.jsx'
import './NavBar.css'

const GITHUB_URL = 'https://github.com/poggufanz/vibingfarmer'
const DOCS_URL = 'https://vibingfarmer.gitbook.io/vibingfarmer/'

// 2026-08-02 polish (audit item #14): the public pages' brand slot used the retired
// pre-Pocket-Crew "vibing / farmer" script+mono text treatment -- a different product read from
// the app shell one click away. The fixed Pocket Crew lockup (pocket/V mark + wordmark,
// BrandLockup) is the one approved identity everywhere, landing included (2026-07-28 owner
// alignment: logo treatment follows the app, narrative/layout unchanged).

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
      <button className="nv-brand" onClick={() => go('/')} aria-label="Vibing Farmer home">
        <BrandLockup variant="full" />
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
