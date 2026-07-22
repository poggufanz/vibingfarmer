// frontend/src/components/pocket/RouteFocus.jsx
// Shell-wide route accessibility: a "Skip to content" link and a route-change focus manager,
// shared by every route -- public (landing, explorer, ecosystem, replay) and authenticated
// (home, strategy, agent, history, settings, developers, vault/tx detail) alike (Foundation Task
// 6). Both read the same routeLabel()/routeTitle() table so the visible page name, the
// document.title, and the live-region announcement can never drift apart from each other.

import { useEffect, useId } from 'react'

// Ordered so a longer/more specific prefix (e.g. '/vault/') never loses to a shorter one; every
// entry after the exact-path matches is a prefix match for a param/nested route.
const ROUTE_LABELS = [
  { test: (p) => p === '/home', label: 'Home' },
  { test: (p) => p === '/strategy', label: 'New deposit' },
  { test: (p) => p === '/agent', label: 'My money' },
  { test: (p) => p === '/history', label: 'History' },
  { test: (p) => p === '/settings', label: 'Settings' },
  { test: (p) => p === '/explorer', label: 'Explorer' },
  { test: (p) => p === '/ecosystem', label: 'Ecosystem' },
  { test: (p) => p === '/replay', label: 'Replay' },
  { test: (p) => p.startsWith('/developers'), label: 'Developers' },
  { test: (p) => p.startsWith('/vault/'), label: 'Vault details' },
  { test: (p) => p.startsWith('/tx/'), label: 'Transaction details' },
]

/** The visible page name for a pathname, or null when the path has no distinct page (redirects). */
export function routeLabel(pathname) {
  const hit = ROUTE_LABELS.find((r) => r.test(pathname || ''))
  return hit ? hit.label : null
}

/** One consistent `<Page> · Vibing Farmer` document.title, brand-only when there is no page name. */
export function routeTitle(pathname) {
  const label = routeLabel(pathname)
  return label ? `${label} · Vibing Farmer` : 'Vibing Farmer'
}

// Shared by SkipLink and RouteFocus: the destination is `[data-route-heading]` (routes adopt this
// in later plans) or else the page's own `<main>`. Neither is guaranteed to already be
// programmatically focusable, so a missing tabindex is added on demand -- the standard technique
// for focusing a landmark without requiring every page to hand-author `tabindex="-1"` itself.
function focusRouteTarget() {
  const target = document.querySelector('[data-route-heading]') || document.querySelector('main')
  if (!target) return
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
  target.focus()
}

/**
 * First focusable element on the page, visually hidden until it receives keyboard focus. Works on
 * every route (public or authenticated) without any route owning its own copy, because it targets
 * the same `[data-route-heading]`/`<main>` pair RouteFocus does.
 */
export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="pc-skip-link"
      onClick={(e) => {
        e.preventDefault()
        focusRouteTarget()
      }}
    >
      Skip to content
    </a>
  )
}

/**
 * Mounted immediately inside a route's landmark. Moves focus to the route's heading/main and
 * announces the page name in a polite live region -- but only when `pathname` itself changes, so
 * an unrelated background re-render (a position figure ticking, a poll landing) never steals
 * focus from whatever the user is doing.
 */
export function RouteFocus({ pathname }) {
  const liveId = useId()

  useEffect(() => {
    focusRouteTarget()
    // pathname is the only thing this effect should ever react to -- see the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  const label = routeLabel(pathname)

  return (
    <div id={liveId} className="pc-visually-hidden" role="status" aria-live="polite">
      {label ? `Navigated to ${label}` : ''}
    </div>
  )
}
