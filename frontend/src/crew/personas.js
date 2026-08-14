// Presentation-only identities for agent UI. These never replace or transform agent addresses.
export const CREW_PERSONAS = Object.freeze([
  Object.freeze({
    id: 'sprout',
    name: 'Sprout',
    ordinal: 0,
    avatar: '/brand/agents/sprout.svg',
  }),
  Object.freeze({
    id: 'clover',
    name: 'Clover',
    ordinal: 1,
    avatar: '/brand/agents/clover.svg',
  }),
  Object.freeze({
    id: 'mochi',
    name: 'Mochi',
    ordinal: 2,
    avatar: '/brand/agents/mochi.svg',
  }),
])

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function isD1Proven(discoveryRow) {
  if (!discoveryRow || typeof discoveryRow !== 'object') return false

  const indexedByApi =
    Array.isArray(discoveryRow.discoverySources) &&
    discoveryRow.discoverySources.includes('agent-index-api')
  if (indexedByApi) return true

  return hasIndexedIdentity(discoveryRow) && hasIndexedProvenance(discoveryRow.provenance)
}

export function personaForOrdinal(ordinal) {
  if (!isNonNegativeSafeInteger(ordinal)) return null
  return CREW_PERSONAS[ordinal % CREW_PERSONAS.length]
}

export function legacyPersonaSlot(networkId, verifiedAddress) {
  if (!isNonEmptyString(networkId) || !isNonEmptyString(verifiedAddress)) return null

  const bytes = new TextEncoder().encode(`crew-persona-v1\0${networkId}\0${verifiedAddress}`)
  let hash = 0x811c9dc5
  for (const byte of bytes) hash = Math.imul((hash ^ byte) >>> 0, 0x01000193) >>> 0
  return hash % CREW_PERSONAS.length
}

// Resolve the presentation-only persona used by compact account summaries. A proven assignment
// from owner discovery always wins. Older agent accounts can predate run ordinals, so they fall
// back to the same stable address hash used by the legacy crew projection. The returned persona
// never replaces the account address as the actual identity or transaction target.
export function presentationPersonaForAddress(
  personaByAddress,
  address,
  networkId = 'stellar-testnet'
) {
  if (!isNonEmptyString(address)) return null

  const assigned =
    personaByAddress instanceof Map ? personaByAddress.get(address) : personaByAddress?.[address]
  const catalogPersona = CREW_PERSONAS.find((persona) => persona.id === assigned?.id)
  if (catalogPersona) return catalogPersona

  const slot = legacyPersonaSlot(networkId, address)
  return slot == null ? null : CREW_PERSONAS[slot]
}

export function assignCrewPersona({ networkId, discoveryRow } = {}) {
  if (!isD1Proven(discoveryRow)) return { state: 'pending', reason: 'unverified-discovery-row' }

  const runOrdinal = discoveryRow.runOrdinal
  if (runOrdinal != null) {
    const persona = personaForOrdinal(runOrdinal)
    if (!persona) return { state: 'pending', reason: 'invalid-run-ordinal' }
    return { state: 'assigned', persona, source: 'run-ordinal', runOrdinal }
  }

  const slot = legacyPersonaSlot(networkId, discoveryRow.address)
  if (slot == null) return { state: 'pending', reason: 'missing-legacy-identity' }
  return {
    state: 'assigned',
    persona: CREW_PERSONAS[slot],
    source: 'legacy-fnv1a',
    runOrdinal: null,
  }
}
function hasIndexedIdentity(discoveryRow) {
  return (
    isNonEmptyString(discoveryRow.address) &&
    isNonEmptyString(discoveryRow.creator) &&
    isNonNegativeSafeInteger(discoveryRow.createdLedger) &&
    isNonEmptyString(discoveryRow.createdTxHash)
  )
}

function hasIndexedProvenance(provenance) {
  if (!provenance || typeof provenance !== 'object') return false

  if (provenance.source === 'backfill-audit') {
    return isNonEmptyString(provenance.evidenceKind) && isNonEmptyString(provenance.evidenceHash)
  }

  return (
    ['router-event', 'registry-event'].includes(provenance.source) &&
    isNonEmptyString(provenance.providerId) &&
    isNonEmptyString(provenance.endpointClass) &&
    isNonEmptyString(provenance.generation)
  )
}
