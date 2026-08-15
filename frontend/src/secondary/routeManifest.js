// Visual inventory only.  This is deliberately not a router, gate resolver, or redirect table.
const entries = [
  {
    id: 'onboarding',
    path: '/onboarding',
    gate: 'onboarding',
    heading: 'Onboarding',
    visualClass: 'secondary-onboarding',
  },
  {
    id: 'explorer',
    path: '/explorer',
    gate: 'public',
    heading: 'Explorer',
    visualClass: 'secondary-explorer',
  },
  {
    id: 'ecosystem',
    path: '/ecosystem',
    gate: 'public',
    heading: 'Ecosystem',
    visualClass: 'secondary-ecosystem',
  },
  {
    id: 'replay',
    path: '/replay',
    gate: 'public',
    heading: 'Replay',
    visualClass: 'secondary-replay',
  },
  {
    id: 'history',
    path: '/history',
    gate: 'authenticated',
    heading: 'History',
    visualClass: 'secondary-history',
  },
  {
    id: 'vault',
    path: '/vault/:protocol',
    gate: 'authenticated',
    heading: 'Vault detail',
    visualClass: 'secondary-vault',
  },
  {
    id: 'tx',
    path: '/tx/:txHash',
    gate: 'authenticated',
    heading: 'Transaction detail',
    visualClass: 'secondary-tx',
  },
  {
    id: 'developers',
    path: '/developers/*',
    gate: 'authenticated',
    heading: 'Developers',
    visualClass: 'secondary-developers',
  },
]

export const SECONDARY_ROUTE_MANIFEST = Object.freeze(entries.map((entry) => Object.freeze(entry)))
