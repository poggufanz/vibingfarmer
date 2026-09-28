/* ============================================
   VIBING FARMER — v2 shared components & icons
   ============================================ */
import React from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { getSidebarPath } from './app/router.js'
import { t } from './store/settingsStore.js'
import { BrandLockup } from './components/pocket/BrandLockup.jsx'
import { DOCS_URL } from './components/NavBar.jsx'
import { getNetworkMeta, NETWORK_IDS } from './design/networks.js'

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
    network: (
      <>
        <circle cx="12" cy="5" r="2" />
        <circle cx="5" cy="19" r="2" />
        <circle cx="19" cy="19" r="2" />
        <path d="M12 7v3M12 10l-6 7M12 10l6 7" />
      </>
    ),
    // Language (TopBar account panel): nothing in the set above reads as "locale" -- `network`
    // is topology and `code` is markup, so the nearest mark would have been a lie. Lucide globe.
    globe: (
      <>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
        <path d="M2 12h20" />
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
    shield: (
      <>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
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
  ]

  return (
    <nav
      className="sidebar"
      aria-label="Primary navigation"
      data-pocket-sidebar
      data-pocket-primary-nav
    >
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

      {/* P1 G7: the permanent Risks link — a shell footer, always one click away, routing to
          the /risks page. Kept OUT of the four-item primary nav above (pinned by the Sidebar
          label test) so the IA order never shifts. */}
      <div className="sb-footer">
        <button
          type="button"
          className="sb-item"
          title="Risks"
          aria-label="Risks"
          aria-current={activePath === '/risks' ? 'page' : undefined}
          onClick={() => navigate('/risks')}
        >
          <Icon name="shield" />
          <span className="sb-label">Risks</span>
        </button>
      </div>
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
const NOOP = () => {}

// Cross-workstream contract with src/design/networks.js: the shell names the mainnet row even
// though nothing is deployed there yet, so the id falls back to the literal if this file ever
// ships ahead of the registry entry -- `undefined` must never reach a `data-network` attribute.
const MAINNET_ID = NETWORK_IDS.STELLAR_MAINNET || 'stellar-mainnet'
// The registry owns every network name. `getNetworkMeta` answers an unregistered id with its
// id-less "Unknown network" sentinel, which would be a false name for a row we deliberately show,
// so the literal is the last resort.
const MAINNET_META = getNetworkMeta(MAINNET_ID)
const MAINNET_LABEL = MAINNET_META.id ? MAINNET_META.label : 'Stellar mainnet'
// The account control now carries the network identity itself -- the mark in its closed state and
// the picker inside its panel -- so this file resolves the testnet meta, not just its label.
const TESTNET_META = getNetworkMeta(NETWORK_IDS.STELLAR_TESTNET)
const TESTNET_LABEL = TESTNET_META.label

const TopBar = ({
  onReset,
  walletPhase = 'none',
  walletAddress = '',
  walletLabel = '',
  notifications = null,
  onConnect = NOOP,
  onDisconnect = NOOP,
  language = 'en',
  onLanguageChange = NOOP,
  onOpenSettings,
}) => {
  const navigate = useNavigate()
  const [copied, setCopied] = React.useState(false)
  const accountRef = React.useRef(null)
  const walletConnected = walletPhase !== 'none' && Boolean(walletAddress)
  const sessionActive = walletPhase === 'upgraded'

  // One header popover remains: the account panel, a native `<details>` disclosure (this shell has
  // no role="menu" anywhere). The network picker used to be a second, sibling disclosure with its
  // own trigger and its own close path; it now lives INSIDE this panel, so there is no sibling to
  // close and no cross-panel open/close dance left -- Escape, an outside pointerdown, and the
  // disclosure's own toggle cover every way it can be dismissed. Closing never moves focus, which
  // is why the outside-pointerdown rule can dismiss a panel without stealing focus from whatever
  // the user just pressed.
  const closeAccountMenu = () => accountRef.current?.removeAttribute('open')

  // Escape closes the panel and returns focus to its trigger. stopPropagation keeps the key from
  // also reaching the notification bell's dialog.
  const handlePanelKeyDown = (event) => {
    if (event.key !== 'Escape') return
    const panel = accountRef.current
    if (!panel || !panel.hasAttribute('open')) return
    event.stopPropagation()
    panel.removeAttribute('open')
    panel.querySelector('summary')?.focus()
  }

  React.useEffect(() => {
    const handlePointerDown = (event) => {
      const panel = accountRef.current
      if (panel && panel.hasAttribute('open') && !panel.contains(event.target)) {
        panel.removeAttribute('open')
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [])

  // The account panel's nav list: Settings / Developers / Language / Documentation are identical
  // rows in the connected and the disconnected panel; only Log out depends on having a wallet --
  // one definition, so the two states cannot drift apart. Each row's trailing mark says where it
  // goes: a chevron for an in-app page, the current value for a toggle, an arrow for a new tab.
  const languageName = language === 'en' ? 'English' : 'Indonesia'
  const networkHeadingId = React.useId()
  const accountActions = (
    <div className="header-wallet-actions header-wallet-nav">
      <button
        type="button"
        className="header-wallet-action"
        onClick={() => {
          closeAccountMenu()
          if (onOpenSettings) onOpenSettings()
          else navigate('/settings')
        }}
      >
        <Icon name="settings" />
        Settings
        <Icon name="chev" className="header-wallet-action-trail" />
      </button>
      <button
        type="button"
        className="header-wallet-action"
        onClick={() => {
          closeAccountMenu()
          navigate('/developers')
        }}
      >
        <Icon name="code" />
        Developers
        <Icon name="chev" className="header-wallet-action-trail" />
      </button>
      <button
        type="button"
        className="header-wallet-action"
        aria-label={`Language: ${languageName}`}
        title={language === 'en' ? 'Switch to Indonesia' : 'Switch to English'}
        onClick={() => {
          closeAccountMenu()
          onLanguageChange(language === 'en' ? 'id' : 'en')
        }}
      >
        <Icon name="globe" />
        Language
        <span className="header-wallet-action-trail header-wallet-action-value">
          {languageName}
        </span>
      </button>
      <a className="header-wallet-action" href={DOCS_URL} target="_blank" rel="noreferrer noopener">
        <Icon name="layers" />
        Documentation
        <Icon name="external" className="header-wallet-action-trail" />
      </a>
      {walletConnected && (
        <button
          type="button"
          className="header-wallet-action header-wallet-action--exit"
          onClick={() => {
            closeAccountMenu()
            onDisconnect()
          }}
        >
          <Icon name="logout" />
          Log out
        </button>
      )}
    </div>
  )

  return (
    <header className="topbar" data-pocket-topbar>
      {/* The brand stands alone on the left: the network identity used to sit beside the wordmark,
          where it read as part of the product name. It belongs to the account control on the right
          now (see `.header-wallet`), so nothing network-shaped sits beside the wordmark. */}
      <div className="topbar-left">
        <BrandLockup variant="full" />
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
        {/* Order is deliberate: fee notice, bell, plus, account -- the one controlling popover sits
            at the far end, next to nothing that can reset the flow. The network picker used to be a
            second pill beside this one; it now lives inside the account panel, so the header holds
            exactly one identity control. */}
        <details className="header-wallet" ref={accountRef} onKeyDown={handlePanelKeyDown}>
          {walletConnected ? (
            <summary
              className="header-wallet-trigger"
              aria-label={`Wallet ${walletLabel} on ${TESTNET_LABEL}`}
              title={sessionActive ? 'Session keys active' : 'Standard wallet'}
            >
              <Icon name="wallet" />
              <span
                className={`header-wallet-dot ${sessionActive ? 'is-active' : ''}`}
                aria-hidden="true"
              />
              <span className="header-wallet-address">{walletLabel}</span>
              {/* Network identity, carried by the account control itself now that the standalone
                  network pill is gone. Decorative: the aria-label above names the network. */}
              <img
                className="header-wallet-netmark"
                src={TESTNET_META.markPath}
                alt=""
                aria-hidden="true"
              />
            </summary>
          ) : (
            /* Same disclosure as the connected state -- "Not connected" used to be a dead span
               with no way to act on it, which made the header the one place a visitor could not
               start the flow. */
            <summary
              className="header-wallet-trigger is-disconnected"
              aria-label={`Wallet not connected on ${TESTNET_LABEL}`}
              title="Connect wallet"
            >
              <Icon name="wallet" />
              <span className="header-wallet-address">Not connected</span>
            </summary>
          )}
          <div className="header-wallet-menu">
            {/* Identity plate: the lamp restates the status line beside it (aria-hidden there), so
                nothing is carried by color alone. */}
            <div
              className="header-wallet-plate"
              data-tone={walletConnected ? (sessionActive ? 'live' : 'idle') : 'off'}
            >
              <p className="header-wallet-status">
                {walletConnected
                  ? sessionActive
                    ? 'Session keys active'
                    : 'Standard wallet'
                  : 'Wallet not connected'}
              </p>
              {walletConnected ? (
                <p className="header-wallet-full-address">{walletAddress}</p>
              ) : (
                <p className="header-wallet-hint">
                  Connect a Stellar wallet to see what you hold and put it to work.
                </p>
              )}
            </div>
            {walletConnected ? null : (
              <button
                type="button"
                className="header-wallet-connect"
                onClick={() => {
                  closeAccountMenu()
                  onConnect()
                }}
              >
                <Icon name="wallet" />
                Connect wallet
              </button>
            )}
            {walletConnected ? (
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
            ) : null}
            {/* The network picker lives here now: the header's single identity control owns both
                halves of "which account on which network". */}
            <div className="header-network-group" role="group" aria-labelledby={networkHeadingId}>
              <p className="header-network-section" id={networkHeadingId}>
                Network
              </p>
              <div className="header-network-list">
                <button
                  type="button"
                  className="header-network-option is-current"
                  data-network={NETWORK_IDS.STELLAR_TESTNET}
                  onClick={closeAccountMenu}
                >
                  <span className="header-network-lamp" aria-hidden="true" />
                  <span className="header-network-option-label">{TESTNET_LABEL}</span>{' '}
                  <Icon name="check" className="header-network-option-check" />
                  <span className="header-network-option-note">Current</span>
                </button>
                {/* The only other network this product could run on, listed so the choice is not
                    a mystery -- and disabled, because there is no mainnet deployment to point at. */}
                <button
                  type="button"
                  className="header-network-option"
                  data-network={MAINNET_ID}
                  disabled
                  title={`${MAINNET_LABEL} is not deployed yet`}
                >
                  <span className="header-network-lamp" aria-hidden="true" />
                  <span className="header-network-option-label">{MAINNET_LABEL}</span>{' '}
                  <span className="header-network-option-note">Not deployed yet</span>
                </button>
              </div>
            </div>
            {accountActions}
          </div>
        </details>
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
