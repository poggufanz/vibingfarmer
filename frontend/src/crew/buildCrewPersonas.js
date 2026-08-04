import { assignCrewPersona, CREW_PERSONAS } from './personas.js'
import { SOROBAN_DECIMALS } from '../stellar/config.js'

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

function readExactAmount(amount) {
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
    if (units < 0n) return { state: 'unavailable', amount: null }
    return {
      state: 'known',
      amount: { token: amount.token, units: String(units), decimals: amount.decimals },
    }
  } catch {
    return { state: 'unavailable', amount: null }
  }
}

function readPositiveAmount(amount) {
  const exact = readExactAmount(amount)
  if (exact.state !== 'known') return exact
  if (BigInt(exact.amount.units) === 0n) return { state: 'non-positive', amount: null }
  return exact
}

function sumAmounts(amounts) {
  const grouped = new Map()
  for (const amount of amounts) {
    const key = `${amount.token}:${amount.decimals}`
    const current = grouped.get(key)
    if (current) current.units += BigInt(amount.units)
    else
      grouped.set(key, {
        token: amount.token,
        decimals: amount.decimals,
        units: BigInt(amount.units),
      })
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

function normalizedBaseIdentity(value) {
  const kernelAddress = value?.kernelAddress
  const poolAddress = value?.poolAddress
  const asset = value?.asset ?? value?.amount?.token
  if (
    typeof kernelAddress !== 'string' ||
    kernelAddress.length === 0 ||
    kernelAddress !== kernelAddress.trim() ||
    typeof poolAddress !== 'string' ||
    poolAddress.length === 0 ||
    poolAddress !== poolAddress.trim() ||
    typeof asset !== 'string' ||
    asset.length === 0 ||
    asset !== asset.trim()
  ) {
    return null
  }
  return `${kernelAddress.toLowerCase()}:${poolAddress.toLowerCase()}:${asset.toLowerCase()}`
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
  const incomplete = hasIncompleteEvidence(agent, evidence)
  // A technical location without a readable positive balance is coverage evidence, not a
  // productive Crew child. Mixed rows keep every leg because their positive sibling proves the
  // child is productive; unreadable-only rows stay outside both productive and active counts.
  if (!evidence.workingLegs.some((leg) => leg.amount != null)) {
    return { child: null, incomplete }
  }

  return {
    incomplete,
    child: {
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
      incomplete,
    },
  }
}

function indexAuthoritativeBaseGroups(moneyRead) {
  const groups = new Map()
  let malformed = !Array.isArray(moneyRead?.baseGroups)
  if (malformed) return { groups, malformed }

  for (const group of moneyRead.baseGroups) {
    const identity = normalizedBaseIdentity(group)
    const coverageState = group?.coverage?.state
    const problems = group?.coverage?.problems
    const amountRead = readExactAmount(group?.amount)
    const groupKeyValid =
      typeof group?.groupKey === 'string' &&
      group.groupKey === group.groupKey.trim() &&
      group.groupKey.endsWith(`:${identity}`)
    const coverageValid =
      ['complete', 'partial', 'unavailable'].includes(coverageState) &&
      Array.isArray(problems) &&
      problems.every((problem) => typeof problem === 'string') &&
      (coverageState === 'complete' ? problems.length === 0 : problems.length > 0)
    const amountValid =
      coverageState === 'unavailable'
        ? group?.amount == null
        : amountRead.state === 'known' &&
          amountRead.amount.decimals === SOROBAN_DECIMALS &&
          amountRead.amount.token.toLowerCase() === String(group?.asset).toLowerCase()
    const valid = identity != null && groupKeyValid && coverageValid && amountValid

    if (!identity) {
      malformed = true
      continue
    }
    if (groups.has(identity)) {
      // Two authoritative entries for one normalized kernel+pool+asset group are ambiguous even
      // when byte-equal. Never pick one by order.
      malformed = true
      groups.set(identity, { valid: false, group: null, amount: null })
      continue
    }
    if (!valid) malformed = true
    groups.set(identity, {
      valid,
      group,
      amount: amountRead.state === 'known' ? amountRead.amount : null,
    })
  }

  return { groups, malformed }
}

function ownerCoverageIncomplete(moneyRead) {
  if (moneyRead == null) return false
  return (
    moneyRead.status !== 'complete' ||
    ['associationCoverage', 'baseSourceCoverage', 'basePositionCoverage'].some(
      (axis) => moneyRead?.[axis]?.state !== 'complete'
    )
  )
}

function markBaseOwnership(children, moneyRead) {
  const groups = new Map()
  const authoritative = moneyRead != null
  const indexedEvidence = authoritative ? indexAuthoritativeBaseGroups(moneyRead) : null
  const matchedEvidence = new Set()
  let incomplete = indexedEvidence?.malformed ?? false

  for (const child of children) {
    child.workingLegs.forEach((leg, legIndex) => {
      if (leg.location !== 'base-proxy') return
      const identity = normalizedBaseIdentity(leg)
      const groupKey = identity ?? `invalid:${leg.key}`
      const associations = groups.get(groupKey) ?? []
      associations.push({ child, leg, legIndex })
      groups.set(groupKey, associations)
    })
  }

  for (const [identity, associations] of groups) {
    associations.sort(
      (left, right) =>
        (left.child.assignment.state === 'assigned' ? -1 : 0) -
          (right.child.assignment.state === 'assigned' ? -1 : 0) ||
        compareChildren(left.child, right.child) ||
        left.legIndex - right.legIndex
    )
    const owner = associations[0]
    const shared = associations.length > 1

    if (!authoritative) {
      const groupCanBeValued = owner.leg.amount != null
      for (const association of associations) {
        association.leg.shared = shared
        association.leg.counted = groupCanBeValued && association === owner
        if (!groupCanBeValued) association.child.incomplete = true
      }
      continue
    }

    const evidence = indexedEvidence.groups.get(identity)
    if (evidence) matchedEvidence.add(identity)
    const authoritativePositive =
      evidence?.valid === true &&
      evidence.group.coverage.state !== 'unavailable' &&
      evidence.amount != null &&
      BigInt(evidence.amount.units) > 0n
    const groupIncomplete = !evidence?.valid || evidence.group.coverage.state !== 'complete'
    if (groupIncomplete) incomplete = true

    for (const association of associations) {
      association.leg.shared = shared
      association.leg.counted = authoritativePositive && association === owner
      if (groupIncomplete || !authoritativePositive) association.child.incomplete = true
    }
    if (authoritativePositive) owner.leg.amount = evidence.amount
  }

  if (
    authoritative &&
    [...indexedEvidence.groups.entries()].some(
      ([identity, evidence]) =>
        !matchedEvidence.has(identity) &&
        (!evidence.valid ||
          evidence.group.coverage.state !== 'complete' ||
          BigInt(evidence.amount.units) > 0n)
    )
  ) {
    // The owner read knows about a group that no readable Crew child can present. Keep the
    // projection partial rather than silently dropping that owner money into a complete total.
    incomplete = true
  }

  return { incomplete }
}

function finishChild(child) {
  child.workingTotals = sumAmounts(
    child.workingLegs.filter((leg) => leg.counted && leg.amount != null).map((leg) => leg.amount)
  )
  return child
}

function projectionStatus(
  discoveryStatus,
  assignedChildren,
  pendingAssignments,
  incompleteJoinedRows,
  ownerEvidenceIncomplete
) {
  if (!['complete', 'partial', 'unavailable'].includes(discoveryStatus)) return 'unavailable'
  if (discoveryStatus !== 'complete') return discoveryStatus
  return assignedChildren.some((child) => child.incomplete) ||
    pendingAssignments.length > 0 ||
    incompleteJoinedRows.length > 0 ||
    ownerEvidenceIncomplete
    ? 'partial'
    : 'complete'
}

/**
 * Build the pure, evidence-backed Crew read model. Money rows join membership by their original,
 * exact address string; presentation personas never become an identity fallback.
 */
export function buildCrewPersonas({ moneyRead = null, moneyAgents = [], discovery } = {}) {
  const discoveryByAddress = new Map()
  for (const row of discovery?.agents ?? []) {
    if (
      typeof row?.address === 'string' &&
      row.address.length > 0 &&
      !discoveryByAddress.has(row.address)
    ) {
      discoveryByAddress.set(row.address, row)
    }
  }

  const assignedChildren = []
  const pendingAssignments = []
  const incompleteJoinedRows = []
  const networkId = typeof discovery?.networkId === 'string' ? discovery.networkId : ''

  const joinedMoneyAgents = moneyRead == null ? moneyAgents : moneyRead?.agents
  for (const agent of Array.isArray(joinedMoneyAgents) ? joinedMoneyAgents : []) {
    if (typeof agent?.address !== 'string') continue
    const discoveryRow = discoveryByAddress.get(agent.address)
    if (!discoveryRow) continue

    const assignment = assignCrewPersona({ networkId, discoveryRow })
    const { child, incomplete } = makeChild({ agent, discoveryRow, assignment, networkId })
    if (!child) {
      if (incomplete) incompleteJoinedRows.push({ assignment })
      continue
    }

    if (assignment.state === 'assigned') assignedChildren.push(child)
    else pendingAssignments.push(child)
  }

  assignedChildren.sort(compareChildren)
  pendingAssignments.sort(compareChildren)
  const allChildren = [...assignedChildren, ...pendingAssignments]
  const baseOwnership = markBaseOwnership(allChildren, moneyRead)
  allChildren.forEach(finishChild)

  const envelopeIncomplete = ownerCoverageIncomplete(moneyRead) || baseOwnership.incomplete

  const status = projectionStatus(
    discovery?.status,
    assignedChildren,
    pendingAssignments,
    incompleteJoinedRows,
    envelopeIncomplete
  )
  const personas = CREW_PERSONAS.map((catalogEntry) => {
    const children = assignedChildren.filter(
      (child) => child.assignment.persona.id === catalogEntry.id
    )
    const hasIncompleteJoinedRow = incompleteJoinedRows.some(
      ({ assignment }) =>
        assignment.state !== 'assigned' || assignment.persona.id === catalogEntry.id
    )
    return {
      ...catalogEntry,
      children,
      totals: sumAmounts(children.flatMap((child) => child.workingTotals)),
      totalState:
        discovery?.status !== 'complete' ||
        pendingAssignments.length > 0 ||
        hasIncompleteJoinedRow ||
        envelopeIncomplete ||
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
