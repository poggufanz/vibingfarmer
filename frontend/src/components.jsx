/* ============================================
   VIBING FARMER — v2 shared components & icons
   ============================================ */
import React from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { getSidebarPath } from './router.js'
import { t } from './settingsStore.js'
import { BrandLockup } from './components/pocket/BrandLockup.jsx'
import { NetworkBadge } from './components/pocket/NetworkIdentity.jsx'
import { NETWORK_IDS } from './design/networks.js'

/* ---------- Icons (Lucide-style, stroke 1.5) ---------- */
const Icon = ({ name, size = 16, className = '' }) => {
  const paths = {
    home: (
      <>
        <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1V9.5z" />
      </>
    ),
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.2" />
        <rect x="14" y="3" width="7" height="7" rx="1.2" />
        <rect x="3" y="14" width="7" height="7" rx="1.2" />
        <rect x="14" y="14" width="7" height="7" rx="1.2" />
      </>
    ),
    layers: (
      <>
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </>
    ),
    bell: (
      <>
        <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </>
    ),
    refresh: (
      <>
        <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
        <path d="M21 3v5h-5" />
      </>
    ),
    plus: (
      <>
        <path d="M12 5v14M5 12h14" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h14M13 5l7 7-7 7" />
      </>
    ),
    check: (
      <>
        <path d="M20 6L9 17l-5-5" />
      </>
    ),
    x: (
      <>
        <path d="M18 6L6 18M6 6l12 12" />
      </>
    ),
    copy: (
      <>
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </>
    ),
    external: (
      <>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <path d="M15 3h6v6" />
        <path d="M10 14L21 3" />
      </>
    ),
    wallet: (
      <>
        <path d="M4 7V5a2 2 0 0 1 2-2h12" />
        <rect x="3" y="7" width="18" height="14" rx="2" />
        <path d="M16 13h5" />
      </>
    ),
    logout: (
      <>
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <path d="M16 17l5-5-5-5" />
        <path d="M21 12H9" />
      </>
    ),
    chev: (
      <>
        <path d="M9 6l6 6-6 6" />
      </>
    ),
    chevDown: (
      <>
        <path d="M6 9l6 6 6-6" />
      </>
    ),
    network: (
      <>
        <circle cx="12" cy="5" r="2" />
        <circle cx="5" cy="19" r="2" />
        <circle cx="19" cy="19" r="2" />
        <path d="M12 7v3M12 10l-6 7M12 10l6 7" />
      </>
    ),
    code: (
      <>
        <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
      </>
    ),
    edit: (
      <>
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
      </>
    ),
    brain: (
      <>
        <path d="M9.5 2a2.5 2.5 0 0 1 2.5 2.5V20a2 2 0 0 1-4 0 2 2 0 0 1-2-2 2 2 0 0 1-1-3.732 2 2 0 0 1 .732-3 2.5 2.5 0 0 1 1-4.268A2.5 2.5 0 0 1 9.5 2zM14.5 2a2.5 2.5 0 0 0-2.5 2.5V20a2 2 0 0 0 4 0 2 2 0 0 0 2-2 2 2 0 0 0 1-3.732 2 2 0 0 0-.732-3 2.5 2.5 0 0 0-1-4.268A2.5 2.5 0 0 0 14.5 2z" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    panelLeftOpen: (
      <>
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M9 3v18M14 9l3 3-3 3" />
      </>
    ),
    panelLeftClose: (
      <>
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M9 3v18M17 15l-3-3 3-3" />
      </>
    ),
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {paths[name] || null}
    </svg>
  )
}

/* ---------- Sidebar (self-contained with React Router) ---------- */
// Task 10 (IA remap): final IA -- /home is My money, /strategy is Put it to work, /agent is
// The crew (Task 9's live console). `agentCount` badges the crew item with the count of
// non-revoked agents (app.jsx's own filter); zero renders no badge at all, never a bare "0".
const Sidebar = ({ extended, onToggle, agentCount = 0 }) => {
  const navigate = useNavigate()
  const location = useLocation()
  const activePath = getSidebarPath(location.pathname)

  const items = [
    { key: 'money', icon: 'home', path: '/home', label: 'My money' },
    { key: 'strategy', icon: 'grid', path: '/strategy', label: 'Put it to work' },
    { key: 'crew', icon: 'network', path: '/agent', label: 'The crew' },
    { key: 'history', icon: 'layers', path: '/history', label: 'History' },
    { key: 'developers', icon: 'code', path: '/developers', label: 'Developers' },
    { key: 'settings', icon: 'settings', path: '/settings', label: 'Settings' },
  ]

  return (
    <nav className="sidebar" aria-label="Primary navigation">
      <div className="sb-logo">
        <BrandLockup variant="compact" className="sb-logo-mark" />
        <span className="sb-logo-text">Vibing Farmer</span>
      </div>
      {items.map((it) => {
        // Fix round 1, F6: the button's own `aria-label` already wins the accessible-name
        // computation over any descendant content, so a plain `aria-label` on the child <span>
        // below was never announced -- and `aria-label` on a role-less <span> isn't
        // name-from-author in the first place. Fold the count into the BUTTON's own name instead
        // (Global Constraints override the brief's verbatim markup here: a11y invariants win),
        // and hide the now-decorative digit from assistive tech with `aria-hidden`.
        const hasBadge = it.key === 'crew' && agentCount > 0
        const accessibleLabel = hasBadge ? `${it.label}, ${agentCount} active` : it.label
        return (
          <button
            key={it.key}
            className={`sb-item ${activePath === it.path ? 'active' : ''}`}
            title={it.label}
            aria-label={accessibleLabel}
            aria-current={activePath === it.path ? 'page' : undefined}
            onClick={() => navigate(it.path)}
          >
            <Icon name={it.icon} />
            <span className="sb-label">{it.label}</span>
            {hasBadge && (
              <span className="sb-badge" aria-hidden="true">
                {agentCount}
              </span>
            )}
          </button>
        )
      })}
      <div className="sb-spacer" style={{ flex: 1 }} />

      <button
        className="sb-item sb-toggle"
        onClick={onToggle}
        title={extended ? 'Collapse sidebar' : 'Expand sidebar'}
        aria-label={extended ? 'Collapse sidebar' : 'Expand sidebar'}
        aria-expanded={extended}
      >
        <Icon name={extended ? 'panelLeftClose' : 'panelLeftOpen'} />
        <span className="sb-label">{extended ? 'Collapse' : 'Expand'}</span>
      </button>
    </nav>
  )
}

/* ---------- Top bar — minimal, no chip soup ---------- */
const TopBar = ({
  onReset,
  walletPhase = 'none',
  walletAddress = '',
  walletLabel = '',
  notifications = null,
}) => {
  const [copied, setCopied] = React.useState(false)
  const walletConnected = walletPhase !== 'none' && Boolean(walletAddress)
  const sessionActive = walletPhase === 'upgraded'

  return (
    <header className="topbar">
      <div className="topbar-left">
        <BrandLockup variant="full" />
        <NetworkBadge networkId={NETWORK_IDS.STELLAR_TESTNET} />
      </div>
      <div className="topbar-right">
        <span className="topbar-meta">Network fee sponsored by fee-bump relay.</span>
        {notifications}
        {/* 2026-08-02 polish (audit item #8): there used to be TWO icon buttons here that both
            called onReset ("Restart flow", refresh icon, and "Start over", plus icon) -- two
            identical anonymous actions side by side. One reset affordance remains. */}
        <button className="icon-btn" title="Start over" aria-label="Start over" onClick={onReset}>
          <Icon name="plus" />
        </button>
        {walletConnected ? (
          <details className="header-wallet">
            <summary
              className="header-wallet-trigger"
              aria-label={`Wallet ${walletLabel}`}
              title={sessionActive ? 'Session keys active' : 'Standard wallet'}
            >
              <Icon name="wallet" />
              <span
                className={`header-wallet-dot ${sessionActive ? 'is-active' : ''}`}
                aria-hidden="true"
              />
              <span className="header-wallet-address">{walletLabel}</span>
            </summary>
            <div className="header-wallet-menu">
              <p className="header-wallet-status">
                {sessionActive ? 'Session keys active' : 'Standard wallet'}
              </p>
              <p className="header-wallet-full-address">{walletAddress}</p>
              <div className="header-wallet-actions">
                <button
                  type="button"
                  className="header-wallet-action"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(walletAddress)
                      setCopied(true)
                      window.setTimeout(() => setCopied(false), 1200)
                    } catch {
                      setCopied(false)
                    }
                  }}
                >
                  <Icon name={copied ? 'check' : 'copy'} />
                  {copied ? 'Copied' : 'Copy address'}
                </button>
                <a
                  className="header-wallet-action"
                  href={`https://stellar.expert/explorer/testnet/account/${walletAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon name="external" />
                  Explorer
                </a>
              </div>
            </div>
          </details>
        ) : (
          <span className="header-wallet-trigger is-disconnected" role="status">
            <Icon name="wallet" />
            <span className="header-wallet-address">Not connected</span>
          </span>
        )}
      </div>
    </header>
  )
}

/* ---------- Step rail (subtle numeric, no wizard chrome) ----------
   Strategy Task 13 (Pocket Crew redesign, Wave 5): STEPS/StepRail are DEMOTED, not deleted. The
   production `/strategy` route now renders StrategyProgress (components/strategy/StrategyProgress.jsx)
   + PlanStage/ProtectStage/StartStage instead — app.jsx only mounts StepRail behind its
   `isDevMode() && stage !== 'strategy'` dev-seam branch, reachable solely via TweaksPanel's
   `jumpTo` (itself devMode-gated), never on any production code path (`stage` no longer leaves its
   initial 'strategy' value in production). Kept exported for that dev/test compatibility seam and
   because components.sidebar.test.jsx and other direct consumers of this file are unaffected by
   the route-level change. See app.jsx's `/strategy` Route element for the actual gate. */
const STEPS = [
  { id: 'strategy', label: 'AI Strategy' },
  { id: 'connect', label: 'Connect & Upgrade' },
  { id: 'skills', label: 'Review Skills' },
  { id: 'permission', label: 'Grant Permission' },
  { id: 'execute', label: 'Auto-Execute' },
  { id: 'done', label: 'Complete' },
]

const StepRail = ({ stage, furthest = 0, onStepClick, lang = 'en' }) => {
  const idx = STEPS.findIndex((s) => s.id === stage)
  return (
    <div
      className="step-rail"
      role="progressbar"
      aria-valuenow={idx + 1}
      aria-valuemax={STEPS.length}
    >
      {STEPS.map((s, i) => {
        const state = i < idx ? 'done' : i === idx ? 'active' : 'idle'
        const clickable = i !== idx && i <= furthest // navigate to any reached step (back/forward); never beyond
        return (
          <div
            key={s.id}
            className={`step-rail-item ${state}${clickable ? ' clickable' : ''}`}
            onClick={clickable ? () => onStepClick?.(s.id) : undefined}
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            onKeyDown={
              clickable
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onStepClick?.(s.id)
                    }
                  }
                : undefined
            }
            title={clickable ? `Ke ${s.label}` : undefined}
          >
            <span className="num">{String(i + 1).padStart(2, '0')}</span>
            <span>{t(lang, s.id)}</span>
          </div>
        )
      })}
    </div>
  )
}

export { Icon, Sidebar, TopBar, StepRail, STEPS }
