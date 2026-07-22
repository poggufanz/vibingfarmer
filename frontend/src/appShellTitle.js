// frontend/src/appShellTitle.js
// Pure document.title resolver for App's render branches (Foundation Task 6 review fix). Split
// out of app.jsx (which pulls in ~90 heavy stellar/wallet/orchestrator imports) so this one small,
// easily-regressed branch-ordering rule can be unit tested without dragging all of that into a
// test module -- same reason mergeFlowHelpers.js exists.
//
// MUST mirror App's own render branch order exactly: the standalone public pages
// (/explorer, /ecosystem, /replay) render regardless of wallet/onboarding state (checked before
// every gate in app.jsx), so they must be checked first here too -- otherwise a fresh,
// not-yet-connected visitor on e.g. /explorer sees Explorer content under a "Welcome" tab title.
import { routeTitle } from './components/pocket/RouteFocus.jsx'

const STANDALONE_PUBLIC_PATHS = new Set(['/explorer', '/ecosystem', '/replay'])

export function resolveDocumentTitle({ pathname, skipLanding, realAddress, onboarded }) {
  if (STANDALONE_PUBLIC_PATHS.has(pathname)) return routeTitle(pathname)
  if (!skipLanding && !realAddress) return 'Welcome · Vibing Farmer'
  if (!onboarded) return 'Get started · Vibing Farmer'
  return routeTitle(pathname)
}
