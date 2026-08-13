// Pure presentation seams for the secondary route family.
//
// Route components remain the owners of readers and effects.  These adapters accept their
// settled result as an input and expose only Foundation/Core render props.
import { normalizeCoreAmount, toFactView, toLiveVenueView } from '../core/coreRouteAdapters.js'
import { statusNoticeModel, toFreshnessView } from '../design/pocket-crew-foundation.js'

const ROUTE_READS = Object.freeze({
  onboarding: 'onboarding read',
  explorer: 'explorer read',
  ecosystem: 'ecosystem read',
  replay: 'replay read',
  history: 'history read',
  vault: 'vault read',
  tx: 'transaction read',
  developers: 'developer read',
})

const ROUTE_SAFE_ACTIONS = Object.freeze({
  onboarding: 'Return to onboarding setup.',
  explorer: 'Return to Explorer setup.',
  ecosystem: 'Return to Ecosystem setup.',
  replay: 'Return to Replay setup.',
  history: 'Return to History setup.',
  vault: 'Return to Vault setup.',
  tx: 'Return to transaction details.',
  developers: 'Return to Developers setup.',
})

const isRecord = (value) => value !== null && typeof value === 'object'

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

const isFactLike = (value) =>
  isRecord(value) &&
  [
    'state',
    'value',
    'source',
    'checkedAt',
    'staleAfterMs',
    'confirmedLedger',
    'confirmedBlock',
  ].some((key) => hasOwn(value, key))

const textOr = (value, fallback) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback

function factInputWithCanonicalAmount(input) {
  if (!isRecord(input) || !hasOwn(input, 'amount') || hasOwn(input, 'value')) return input
  if (input.amount == null) return { ...input, value: null }
  try {
    return { ...input, value: normalizeCoreAmount(input.amount) }
  } catch {
    return { ...input, value: null }
  }
}

function copyForNotice(state, fact, read, safeAction) {
  const readText = textOr(read, 'this read')
  const safeText = textOr(safeAction, 'Return to the route’s safe setup action.')

  switch (state) {
    case 'loading':
      return {
        consequence: `Checking ${readText}.`,
        nextAction: 'Wait for this read to finish.',
      }
    case 'current':
    case 'confirmed':
      return {
        consequence: `Verified from ${textOr(fact.source, 'the source')}.`,
        nextAction: 'Review technical details.',
      }
    case 'stale':
      return {
        consequence: 'Showing the last known value.',
        nextAction: 'Refresh before taking a money-moving action.',
      }
    case 'empty':
      return {
        consequence: 'The source confirmed no records.',
        nextAction: safeText,
      }
    case 'partial':
      return {
        consequence: 'Some sources responded; the rest are unknown.',
        nextAction: 'Refresh missing sources; account-wide actions stay disabled.',
      }
    case 'error':
      return {
        consequence: `The ${readText} failed; movement is not confirmed.`,
        nextAction: 'Retry the read or inspect Technical details.',
      }
    case 'unavailable':
      return {
        consequence: 'We cannot verify this fact right now.',
        nextAction: 'Retry later; do not act on the unverified value.',
      }
    default:
      return {
        consequence: statusNoticeModel(fact).consequence,
        nextAction: statusNoticeModel(fact).nextAction,
      }
  }
}

/**
 * Adapt one source-owned Fact into render props.  Core owns Fact normalization; Foundation owns
 * freshness and status projections.  The route-specific copy only fills the visual notice
 * contract and never changes the normalized Fact itself.
 */
export function adaptSecondaryFact({ fact = {}, previousFact = null, read, safeAction } = {}) {
  const normalized = toFactView(factInputWithCanonicalAmount(fact), previousFact)
  const freshness = toFreshnessView(normalized)
  const foundationNotice = statusNoticeModel(normalized)
  const projectedCopy = copyForNotice(normalized.state, normalized, read, safeAction)
  const notice = Object.freeze({
    ...foundationNotice,
    ...projectedCopy,
    freshness,
  })

  return Object.freeze({
    fact: normalized,
    value: normalized.value,
    freshness,
    notice,
    tone: foundationNotice.tone,
    label: foundationNotice.label,
    consequence: notice.consequence,
    safeNextAction: notice.nextAction,
  })
}

function unwrapResult(result) {
  if (!isRecord(result)) return {}
  if (isRecord(result.readResult)) return result.readResult
  return result
}

function primaryFact(result) {
  const source = unwrapResult(result)
  if (isFactLike(source.fact)) return source.fact
  if (isFactLike(source)) return source
  if (isRecord(source.facts)) {
    const first = Object.values(source.facts).find(isFactLike)
    if (first) return first
  }
  const first = Object.values(source).find(isFactLike)
  return first || { state: 'unavailable' }
}

function previousPrimaryFact(result) {
  if (result == null) return null
  const source = unwrapResult(result)
  return primaryFact(source)
}

function adaptNestedFacts(result, previousResult, routeId) {
  const source = unwrapResult(result)
  const previous = unwrapResult(previousResult)
  const entries = []

  if (isFactLike(source.fact)) entries.push(['fact', source.fact])
  if (isRecord(source.facts)) {
    Object.entries(source.facts).forEach(([key, fact]) => {
      if (isFactLike(fact)) entries.push([key, fact])
    })
  }
  Object.entries(source).forEach(([key, value]) => {
    if (key !== 'fact' && key !== 'facts' && isFactLike(value)) entries.push([key, value])
  })

  return Object.freeze(
    Object.fromEntries(
      entries.map(([key, fact]) => [
        key,
        adaptSecondaryFact({
          fact,
          previousFact: previous?.facts?.[key] ?? (key === 'fact' ? previous?.fact : null),
          read: source.read || ROUTE_READS[routeId],
          safeAction: source.safeAction || ROUTE_SAFE_ACTIONS[routeId],
        }),
      ])
    )
  )
}

function optionalAmount(result) {
  const source = unwrapResult(result)
  if (!hasOwn(source, 'amount')) return undefined
  if (source.amount == null) return null
  try {
    return normalizeCoreAmount(source.amount)
  } catch {
    return null
  }
}

function projectRoute(routeId, result, previousResult = null) {
  const source = unwrapResult(result)
  const adapted = adaptSecondaryFact({
    fact: primaryFact(source),
    previousFact: previousPrimaryFact(previousResult),
    read: source.read || ROUTE_READS[routeId],
    safeAction: source.safeAction || ROUTE_SAFE_ACTIONS[routeId],
  })
  const amount = optionalAmount(source)
  const nestedFacts = adaptNestedFacts(source, previousResult, routeId)
  const venue = isRecord(source.venue) ? toLiveVenueView(source.venue) : undefined

  return Object.freeze({
    route: routeId,
    fact: adapted.fact,
    value: adapted.value,
    amount: amount === undefined ? adapted.value : amount,
    freshness: adapted.freshness,
    notice: adapted.notice,
    facts: nestedFacts,
    venue,
  })
}

export const toOnboardingPresentation = (result, previousResult) =>
  projectRoute('onboarding', result, previousResult)

export const toExplorerPresentation = (result, previousResult) =>
  projectRoute('explorer', result, previousResult)

export const toEcosystemPresentation = (result, previousResult) =>
  projectRoute('ecosystem', result, previousResult)

export const toReplayPresentation = (result, previousResult) =>
  projectRoute('replay', result, previousResult)

export const toHistoryPresentation = (result, previousResult) =>
  projectRoute('history', result, previousResult)

export const toVaultPresentation = (result, previousResult) =>
  projectRoute('vault', result, previousResult)

export const toTxPresentation = (result, previousResult) =>
  projectRoute('tx', result, previousResult)

export const toDevelopersPresentation = (result, previousResult) =>
  projectRoute('developers', result, previousResult)
