// frontend/src/components/pocket/RouteFocus.jsx
// Shell-wide route accessibility: a "Skip to content" link and a route-change focus manager,
// shared by every route -- public (landing, explorer, ecosystem, replay) and authenticated
// (home, strategy, agent, history, settings, developers, vault/tx detail) alike (Foundation Task
// 6). Both read the same routeLabel()/routeTitle() table so the visible page name, the
// document.title, and the live-region announcement can never drift apart from each other.

import { useEffect, useId } from 'react'

// Ordered so a longer/more specific prefix (e.g. '/vault/') never loses to a shorter one; every
// entry after the exact-path matches is a prefix match for a param/nested route.
// Task 10 (IA remap): /home is My money, /strategy is Put it to work, /agent is The crew --
// these three must track Sidebar's own item labels (components.jsx) exactly, or the live-region
// announcement drifts from the page the user just navigated to (this file's own header comment).
const ROUTE_LABELS = [
  { test: (p) => p === '/home', label: 'My money' },
  { test: (p) => p === '/strategy', label: 'Put it to work' },
  { test: (p) => p === '/agent', label: 'The crew' },
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

// Module-scoped (not a per-instance ref): App renders a fresh RouteFocus instance per branch
// (public pages, landing, onboarding, the authenticated shell), so every branch switch is a
// genuine unmount+remount of a *different* RouteFocus element, not a re-render of the same one.
// A ref would reset on every one of those and re-skip focus on every first visit to a branch --
// exactly the "first client-side nav to a lazy page does nothing" bug this exists to avoid. This
// flag instead tracks "has this page load ever moved route focus", true for the entire session
// after the very first real skip, so only the true cold load defers to the browser's own default
// focus (leaving the skip link reachable first) -- every later mount, of any branch, still focuses.
let hasFocusedRoute = false

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
    if (!hasFocusedRoute) {
      // True cold load: let the browser's natural initial focus stand so the skip link stays the
      // first stop, instead of this effect jumping straight past it.
      hasFocusedRoute = true
      return
    }
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
