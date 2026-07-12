// frontend/src/dev/viewAs.js
// Dev-only "view-as" override: /agent?as=G... opens the console reading that address's
// on-chain state (positions = that address's own vault shares, not the demo agent's).
// DEV builds only — every caller is import.meta.env.DEV-gated, so this whole module is
// dead-code-eliminated in production. scripts/assert-no-dev-dispatch.mjs asserts the
// __vfDevViewAs marker never ships in dist/.

/** @returns {string|null} the validated ?as=G... address, or null when absent/invalid/prod */
export function getViewAsAddress() {
  if (!import.meta.env.DEV) return null
  if (typeof window === 'undefined') return null
  const as = new URLSearchParams(window.location.search).get('as')
  if (as && /^G[A-Z2-7]{55}$/.test(as)) return as
  return null
}
