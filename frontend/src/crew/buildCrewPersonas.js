import { assignCrewPersona, CREW_PERSONAS } from './personas.js'

const PRODUCTIVE_LOCATIONS = new Set(['stellar-vault', 'base-proxy'])
const INCOMPLETE_MONEY_PROBLEMS = new Set([
  'vault-shares-unavailable',
  'idle-token-unavailable',
  'base-read-unavailable',
  'base-execution-failed',
  'base-reported-amount-rejected',
  'base-child-invalid',
  'base-child-conflict',
  'base-inflight-unaccounted',
  'scope-read-failed',
  'unexpected-error',
])

function isValidIndex(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function compareExactStrings(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function compareOptionalIndex(left, right) {
  const leftValid = isValidIndex(left)
  const rightValid = isValidIndex(right)
  if (leftValid && rightValid) return left === right ? 0 : left < right ? -1 : 1
  if (leftValid) return -1
  if (rightValid) return 1
  return 0
}

function compareChildren(left, right) {
  return (
    compareOptionalIndex(left.discoveryRow.createdLedger, right.discoveryRow.createdLedger) ||
    compareOptionalIndex(left.discoveryRow.runOrdinal, right.discoveryRow.runOrdinal) ||
    compareExactStrings(left.agent.address, right.agent.address)
  )
}

function readPositiveAmount(amount) {
  if (
    !amount ||
    typeof amount.token !== 'string' ||
    amount.token.length === 0 ||
    typeof amount.units !== 'string' ||
    !Number.isSafeInteger(amount.decimals) ||
    amount.decimals < 0
  ) {
    return { state: 'unavailable', amount: null }
  }

  try {
    const units = BigInt(amount.units)
    if (units <= 0n) return { state: 'non-positive', amount: null }
    return {
      state: 'known',
      amount: { token: amount.token, units: String(units), decimals: amount.decimals },
    }
  } catch {
    return { state: 'unavailable', amount: null }
  }
}

function sumAmounts(amounts) {
  const grouped = new Map()
  for (const amount of amounts) {
    const key = `${amount.token}:${amount.decimals}`
    const current = grouped.get(key)
    if (current) current.units += BigInt(amount.units)
    else grouped.set(key, { token: amount.token, decimals: amount.decimals, units: BigInt(amount.units) })
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => compareExactStrings(left, right))
    .map(([, value]) => ({
      token: value.token,
      units: String(value.units),
      decimals: value.decimals,
    }))
}

function custodyEvidence(agent) {
  if (Array.isArray(agent.custodyBreakdown) && agent.custodyBreakdown.length > 0) {
    return agent.custodyBreakdown
  }
  return [{ location: agent.custody?.location, amount: agent.amount }]
}

function stellarKey(networkId, agent, token) {
  return `${networkId}:stellar:${agent.address}:${agent.scope?.value?.vault ?? ''}:${token}`
}

function baseKey(networkId, leg, token) {
  return `${networkId}:base:${String(leg.kernelAddress ?? '').toLowerCase()}:${String(
    leg.poolAddress ?? ''
  ).toLowerCase()}:${token}`
}

function extractMoneyEvidence(agent, networkId) {
  const workingLegs = []
  const idleAmounts = []
  let hasUnreadableProductiveLeg = false
  let hasCoverageUncertainty = false

  for (const leg of custodyEvidence(agent)) {
    const amountRead = readPositiveAmount(leg?.amount)

    if (leg?.location === 'agent') {
      if (amountRead.state === 'known') idleAmounts.push(amountRead.amount)
      continue
    }
    if (!PRODUCTIVE_LOCATIONS.has(leg?.location)) continue
    if (amountRead.state === 'non-positive') continue
    if (leg.coverageReason != null) hasCoverageUncertainty = true

    const keyToken =
      leg.location === 'base-proxy'
        ? (leg.asset ?? amountRead.amount?.token ?? leg.amount?.token ?? '')
        : (amountRead.amount?.token ?? leg.amount?.token ?? '')
    const key =
      leg.location === 'base-proxy'
        ? baseKey(networkId, leg, keyToken)
        : stellarKey(networkId, agent, keyToken)

    if (amountRead.state !== 'known') hasUnreadableProductiveLeg = true
    workingLegs.push({
      ...leg,
      amount: amountRead.amount,
      key,
      shared: false,
      counted: amountRead.state === 'known',
    })
  }

  const idleTotals = sumAmounts(idleAmounts)
  return {
    workingLegs,
    idleAmount: idleTotals.length === 1 ? idleTotals[0] : null,
    idleEvidenceAmbiguous: idleTotals.length > 1,
    hasUnreadableProductiveLeg,
    hasCoverageUncertainty,
  }
}

function hasIncompleteEvidence(agent, evidence) {
  return (
    agent.vaultShares?.state === 'unavailable' ||
    agent.idleToken?.state === 'unavailable' ||
    (Array.isArray(agent.problems) &&
      agent.problems.some((problem) => INCOMPLETE_MONEY_PROBLEMS.has(problem))) ||
    evidence.hasUnreadableProductiveLeg ||
    evidence.hasCoverageUncertainty ||
    evidence.idleEvidenceAmbiguous
  )
}

function isActive(agent) {
  return !agent.scope?.value?.revoked && !agent.problems?.length
}

function makeChild({ agent, discoveryRow, assignment, networkId }) {
  const evidence = extractMoneyEvidence(agent, networkId)
  if (evidence.workingLegs.length === 0) return null

  return {
    agent,
    discoveryRow,
    assignment,
    workingLegs: evidence.workingLegs,
    workingTotals: [],
    idleAmount: evidence.idleAmount,
    hasWithdrawableStellar: evidence.workingLegs.some(
      (leg) => leg.location === 'stellar-vault' && leg.amount != null
    ),
    active: assignment.state === 'assigned' && isActive(agent),
    incomplete: hasIncompleteEvidence(agent, evidence),
  }
}

function markBaseOwnership(children) {
  const groups = new Map()

  for (const child of children) {
    child.workingLegs.forEach((leg, legIndex) => {
      if (leg.location !== 'base-proxy') return
      const associations = groups.get(leg.key) ?? []
      associations.push({ child, leg, legIndex })
      groups.set(leg.key, associations)
    })
  }

  for (const associations of groups.values()) {
    associations.sort(
      (left, right) =>
        (left.child.assignment.state === 'assigned' ? -1 : 0) -
          (right.child.assignment.state === 'assigned' ? -1 : 0) ||
        compareChildren(left.child, right.child) ||
        left.legIndex - right.legIndex
    )
    const owner = associations[0]
    const shared = associations.length > 1
    const groupCanBeValued = owner.leg.amount != null

    for (const association of associations) {
      association.leg.shared = shared
      association.leg.counted = groupCanBeValued && association === owner
      if (!groupCanBeValued) association.child.incomplete = true
    }
  }
}

function finishChild(child) {
  child.workingTotals = sumAmounts(
    child.workingLegs
      .filter((leg) => leg.counted && leg.amount != null)
      .map((leg) => leg.amount)
  )
  return child
}

function projectionStatus(discoveryStatus, assignedChildren, pendingAssignments) {
  if (!['complete', 'partial', 'unavailable'].includes(discoveryStatus)) return 'unavailable'
  if (discoveryStatus !== 'complete') return discoveryStatus
  return assignedChildren.some((child) => child.incomplete) || pendingAssignments.length > 0
    ? 'partial'
    : 'complete'
}

/**
 * Build the pure, evidence-backed Crew read model. Money rows join membership by their original,
 * exact address string; presentation personas never become an identity fallback.
 */
export function buildCrewPersonas({ moneyAgents = [], discovery } = {}) {
  const discoveryByAddress = new Map()
  for (const row of discovery?.agents ?? []) {
    if (typeof row?.address === 'string' && row.address.length > 0 && !discoveryByAddress.has(row.address)) {
      discoveryByAddress.set(row.address, row)
    }
  }

  const assignedChildren = []
  const pendingAssignments = []
  const networkId = typeof discovery?.networkId === 'string' ? discovery.networkId : ''

  for (const agent of Array.isArray(moneyAgents) ? moneyAgents : []) {
    if (typeof agent?.address !== 'string') continue
    const discoveryRow = discoveryByAddress.get(agent.address)
    if (!discoveryRow) continue

    const assignment = assignCrewPersona({ networkId, discoveryRow })
    const child = makeChild({ agent, discoveryRow, assignment, networkId })
    if (!child) continue

    if (assignment.state === 'assigned') assignedChildren.push(child)
    else pendingAssignments.push(child)
  }

  assignedChildren.sort(compareChildren)
  pendingAssignments.sort(compareChildren)
  const allChildren = [...assignedChildren, ...pendingAssignments]
  markBaseOwnership(allChildren)
  allChildren.forEach(finishChild)

  const status = projectionStatus(discovery?.status, assignedChildren, pendingAssignments)
  const personas = CREW_PERSONAS.map((catalogEntry) => {
    const children = assignedChildren.filter((child) => child.assignment.persona.id === catalogEntry.id)
    return {
      ...catalogEntry,
      children,
      totals: sumAmounts(children.flatMap((child) => child.workingTotals)),
      totalState:
        discovery?.status !== 'complete' ||
        pendingAssignments.length > 0 ||
        children.some((child) => child.incomplete)
          ? 'partial'
          : 'known',
    }
  })

  return {
    status,
    personas,
    pendingAssignments,
    productiveAgentCount: assignedChildren.length + pendingAssignments.length,
    activeCount: assignedChildren.filter((child) => child.active).length,
    totals: sumAmounts(allChildren.flatMap((child) => child.workingTotals)),
  }
}
