// frontend/src/components/strategy/ProtectStage.jsx
// Strategy Task 11 (Pocket Crew redesign, Wave 5). Protect is where the user actually authorizes
// the run: either a fresh `funding_router.grant` with the source-reported wallet confirmation
// count or a revalidated reuse of an already-proven permission. This component never fakes any part of
// that: no modal, no timer, no simulated signing screen of its own. The real wallet/chain
// work (preflight, connect, the actual grant/revalidation) is injected via async props, exactly
// like PlanStage's `onGenerate` -- this file owns only the phase state machine and the view, never
// a wallet/provider/transaction builder itself (see StrategyRoute.jsx's header comment: "no
// data fetching, no wallet/relayer reads" -- Task 13 wires real implementations later).
//
// Design notes for the reviewer (judgment calls made where the brief described intent, not code):
//   - The brief's Interfaces section names the produced reducer events as `GRANT_REQUESTED`,
//     `PERMISSION_CONFIRMED`, `PERMISSION_FAILED` -- flowState.js (off-limits, verified-stable)
//     defines `GRANT_REQUESTED`/`GRANT_CONFIRMED`/`REUSE_CONFIRMED`/`WALLET_REJECTED`/
//     `WALLET_FAILED` instead. This component does not import flowState.js at all (same as
//     PlanStage): it exposes exactly the three callback props the brief lists --
//     `onRetryPreflight`, `onRequestGrant`, `onEditPlan` -- and it is the composition layer
//     (Task 13) that will make calling them dispatch the real reducer events. `onRetryPreflight`
//     serves both the FIRST permission check and every later retry (PlanStage's onGenerate/
//     onRetryLive precedent). `onRequestGrant`/`onConfirmReuse` together cover "the one action
//     that moves this run forward" -- see the fix loop 1 / I2 note below for why this component
//     now picks between two distinctly-named props instead of branching inside one.
//   - `onConnectWallet` is one small necessary addition beyond those three: connecting a wallet
//     (address disclosure) is not itself a grant request, and the brief's disconnected-choice
//     requirement needs a trigger distinct from `onRequestGrant`. `owner` stays a plain prop
//     (CONSUMED, never re-derived, matching PlanStage's `base` prop) -- this component never
//     holds its own copy of "am I connected."
//   - `toPermissionDecisionView` is called on whatever `onRetryPreflight` resolves with, so this
//     component's own state can never carry `executionCredentialRef` even if a caller's test
//     double forgot to strip it first (belt-and-suspenders on top of reusePreflight.js's own
//     secret boundary).
//   - A `PermissionPhaseError` (preflight OR reuse-revalidation) clears the held decision -- it is
//     proof the reviewed permission no longer holds -- and Retry re-runs `onRetryPreflight`
//     (never `onRequestGrant`, so no surprise wallet popup). A plain wallet rejection/failure
//     PRESERVES the decision (nothing about the permission itself was invalidated, only the
//     signature attempt) and Retry re-runs the same `onRequestGrant`/`onConfirmReuse` action
//     directly, mirroring flowState.js's own 'rejected' -> GRANT_REQUESTED-allowed-again shape.
//   - Rice (`.pc-protect-limit`, `--pc-owned`) renders ONLY the reuse-usable receipt: an
//     already-proven, on-chain-verified headroom (checklist item 4: Rice is reserved for
//     confirmed money). A fresh decision's "headroom after granting"/"worst case" figures are
//     still prospective -- true only once the grant actually confirms -- so they render in the
//     neutral `.pc-support` role instead, never in Rice.
//
// Fix loop 1 notes (review findings, all fixed inside this file only):
//   - C1 (Critical): `reviewedBudgets[].token`, `reviewedAgentInits[].cap.token`, and reuse
//     `agents[].headroom.token` are Stellar CONTRACT ADDRESSES in production, never a currency
//     symbol -- reusePreflight.js only ever copies through whatever `token` a caller's AgentInit
//     carried (reusePreflight.js:44-46 `capView`, :359 `headroom`), and grant.js's
//     `agentInitScVal`/`tokenBudgetScVal` (grant.js:88,101) both wrap that same field in
//     `addrScVal`, which THROWS on anything that isn't a real Stellar Address -- so by the time
//     any of these three fields reaches this component, it cannot be a friendly literal like
//     'USDC'. Every render site below now resolves a display symbol via `tokenSymbol()` instead
//     of printing the field verbatim; the raw address still renders, correctly, inside
//     TechnicalDetails' "Token contract:" line a few lines below -- that is the one place a raw
//     identifier belongs.
//   - I3 (Important): "Cap per period" and "Worst case" now label from the SAME reviewed value's
//     own token (`reviewed.cap.token` / `r.cap.token`), never `plan.amount.token` -- a mixed-token
//     plan's second agent can be budgeted in a different Stellar contract than the plan's own
//     display token names, and labelling it with the wrong asset is exactly the money-truth
//     defect the brief's mixed-token rule forbids.
//   - I2 (Important): the single `onRequestGrant` prop used for BOTH the fresh-grant signature and
//     the zero-signature reuse confirmation let an integration silently dispatch the wrong
//     reducer event for reuse and deadlock the flow (REUSE_CONFIRMED's guard fails against
//     GRANT_REQUESTED's state). Split into two distinctly-named props -- `onRequestGrant` (fresh
//     only) and `onConfirmReuse` (reuse only) -- so which one fires is unambiguous by construction,
//     not by an integration correctly reading `decision.mode` on its own.
import { useState } from 'react'
import { MoneyFigure, StatusNotice, TechnicalDetails, VenueTruth } from '../pocket/Primitives.jsx'
import { AgentMark } from '../pocket/AgentMark.jsx'
import { NetworkBadge, NetworkRoute } from '../pocket/NetworkIdentity.jsx'
import { PermissionPhaseError } from '../../strategy/permissionError.js'
import { toPermissionDecisionView } from '../../strategy/reusePreflight.js'
import { maxAtRisk } from '../../strategy/permissionScope.js'
import { buildAmountDisplayMap } from '../../strategy/planModel.js'
import { SOROBAN_TOKEN_ADDRESS } from '../../stellar/config.js'
import { STELLAR_USDC_SAC } from '../../stellar/cctpBurn.js'
import { CREW_PERSONAS, personaForOrdinal } from '../../crew/personas.js'
import {
  formatCoreAmount,
  normalizeCoreAmount,
  toAgentIdentityView,
  toBaseCustodyTruth,
  toPermissionCopy,
} from '../../core/coreRouteAdapters.js'

const DEFAULT_WALLETS = ['VF Wallet', 'Freighter', 'xBull', 'Albedo']

function addressPersona(personaByAddress, address) {
  if (typeof address !== 'string' || address.length === 0) return null
  const candidate =
    personaByAddress instanceof Map ? personaByAddress.get(address) : personaByAddress?.[address]
  return CREW_PERSONAS.find((persona) => persona.id === candidate?.id) || null
}

// Wave 6 carry (Strategy Tasks 11/13): relocated from the now-deleted GrantPanel.jsx (a demoted
// legacy card whose default export became dead once app.jsx's production /strategy route stopped
// rendering it in Strategy Task 13 -- this was its only remaining live consumer).
// Fix round 1 (reviewer M4): not exported -- this file is now DURATION_PRESETS' only consumer.
// ~5s per ledger on Soroban testnet; labels are what the user reasons about.
const DURATION_PRESETS = [
  { id: '1h', label: '1 hour', seconds: 3600 },
  { id: '24h', label: '24 hours', seconds: 86400 },
  { id: '7d', label: '7 days', seconds: 604800 },
]

// Task 5 chunk C: the canonical-decimal-integer convention `permissionGrantV3.js`'s (private,
// unexported) `UNITS_RE` enforces -- re-declared here for the same reason this file already
// re-declares `BRIDGE_NETWORK_CONTEXT` locally: the shared version isn't exported and the source
// file is off-limits to edit for this chunk. Serves two callers: the reusable-
// ceiling control's own edit validation (`buildReusableApproval` is the actual gate that will one
// day consume the committed value; this regex only decides what the CONTROL itself will let a user
// commit to, never a second, competing validation authority) and `reuseIsUsable`'s V3 defense-in-
// depth check below (fix round 1, Important 1) -- both need the identical rule, so one shared const.
const CANONICAL_UNITS_RE = /^(0|[1-9][0-9]*)$/

// Fix loop 1 -- C1: the only two Stellar contracts this app ever budgets against today --
// SOROBAN_TOKEN_ADDRESS (the Autofarm vault's Blend-pool USDC) and STELLAR_USDC_SAC (the CCTP
// bridge's Circle USDC burn source -- the same asset PlanStage.jsx's own "Bridged as Circle USDC"
// line already names). Reusing those two already-shipped labels here, rather than inventing new
// copy, keeps this surface's friendly text consistent with what Plan already told the user. A
// token this map doesn't recognize still never renders more than a short, visibly-truncated
// identifier -- never the full 56-char address -- so an unmapped future token can't reopen this
// defect (or the 320px overflow it originally caused).
const TOKEN_SYMBOLS = {
  [SOROBAN_TOKEN_ADDRESS]: 'USDC',
  [STELLAR_USDC_SAC]: 'Circle USDC',
}

function tokenSymbol(token) {
  if (TOKEN_SYMBOLS[token]) return TOKEN_SYMBOLS[token]
  if (typeof token === 'string' && token.length > 12)
    return `${token.slice(0, 4)}…${token.slice(-4)}`
  return token
}

function exactCoreAmountText(amount) {
  if (!amount || typeof amount !== 'object') return 'Amount unavailable'
  try {
    return formatCoreAmount(normalizeCoreAmount({ ...amount, token: tokenSymbol(amount.token) }))
  } catch {
    return 'Amount unavailable'
  }
}

// Display-only 2dp projection shared with PlanStage/StartStage.  Keep the canonical unit DTO as
// the source of truth and never round anything that is handed to a grant or reuse callback.  A
// malformed decision must fail closed at the decision gate, not crash this presentation surface.
function safeAmountDisplayMap(rows, amountKey) {
  if (!Array.isArray(rows) || rows.length === 0) return {}
  try {
    // Keep independent token rows independent.  buildAmountDisplayMap redistributes a final-cent
    // remainder within a group; grouping only by kind would let a mixed-token decision move that
    // cent from one asset into another and imply a blended total.
    const groups = new Map()
    for (const row of rows) {
      const amount = row?.[amountKey]
      const groupKey = `${row?.kind ?? ''}:${amount?.token ?? ''}:${amount?.decimals ?? ''}`
      const group = groups.get(groupKey) || []
      group.push(row)
      groups.set(groupKey, group)
    }
    return [...groups.values()].reduce(
      (all, group) => Object.assign(all, buildAmountDisplayMap(group, amountKey)),
      {}
    )
  } catch {
    return {}
  }
}

// Same source network context PlanStage.jsx builds for its own bridge row -- not exported there,
// so re-declared here identically (PlanStage.jsx is a sibling surface, not a shared module).
const BRIDGE_NETWORK_CONTEXT = Object.freeze({
  hostNetworkId: 'stellar-testnet',
  sourceNetworkId: 'stellar-testnet',
  destinationNetworkId: 'base-sepolia',
  custodyNetworkId: 'stellar-testnet',
  transitState: 'source',
})

function formatExpiry(expirySeconds) {
  return Number.isFinite(expirySeconds) ? new Date(expirySeconds * 1000).toISOString() : 'Unknown'
}

// Fix round 1 -- F2 (review finding): formatExpiry above is PRE-EXISTING and stays untouched --
// its Rice "As of"/"Expires" call sites deliberately print the raw machine instant next to a
// technical fact. Task 6's OWN new copy -- the boundary sentence and the ceiling row --
// needs an English-reading value instead, never formatExpiry's ISO-with-milliseconds string. Same
// Intl.DateTimeFormat technique PlanStage.jsx's own local (unexported) formatExpiry already
// establishes as precedent in this codebase -- not a new dependency; kept local and minimal here
// since that helper lives in a sibling file outside this task's scope to modify.
function humanExpiry(expirySeconds) {
  return Number.isFinite(expirySeconds)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(expirySeconds * 1000)
      )
    : 'an unknown time'
}

function walletsSentence(list) {
  const names = (list || []).filter(Boolean)
  if (names.length === 0) return 'a supported wallet'
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} or ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`
}

function periodLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'an unknown period'
  if (seconds % 86400 === 0) {
    const days = seconds / 86400
    return `${days} day${days === 1 ? '' : 's'}`
  }
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  return `${seconds}s`
}

// A reuse decision is only trustworthy to SHOW as reusable when every agent it names carries a
// real, finite on-chain scope expiry -- reusePreflight.js's own selectAgents() already guarantees
// this for a well-formed decision, but this view treats the decision as untrusted input regardless
// (defense in depth, and the exact rule the brief names: "unknown expiry cannot show reuse").
//
// Task 5 chunk C: a V3 decision (permissionGrantV3.js) carries `executions[]`, never `agents[]` --
// `toPermissionDecisionView` defaults `agents` to `[]` for exactly this shape, so the V2 branch
// below would always read "unusable" for a V3 decision (not a crash, just permanently the wrong
// answer). Branching on `decision.version` here, rather than teaching the V2 branch to also accept
// `executions`, keeps the V2 branch's own logic (and every test pinned against it) byte-identical --
// the two shapes are genuinely different facts (an on-chain scope expiry vs. an absolute ledger
// sequence) and deserve their own usability rule, not a merged one.
function reuseIsUsable(decision) {
  if (!decision || decision.mode !== 'reuse') return false
  // `toPermissionDecisionView` deliberately strips the credential lookup key.  The caller-side
  // projection below carries only this boolean proof forward; an absent/unknown V2 credential can
  // therefore never turn into an enabled zero-signature Continue action.
  if (decision.credentialProofValid === false) return false
  if (decision.version === 3) {
    // Fix round 1, Important 1 (reviewer finding): this used to check ONLY `executions[]`/
    // `liveUntilLedger`, but the V3 render also reads `reviewedBudgets[0]` (for every money
    // figure's token/decimals) and a `reviewedAgentInit` per execution `allocationId` (for its own
    // token/decimals) -- neither was validated, so a decision missing either rendered "NaN
    // undefined" with an ENABLED Continue button (probed: `reviewedBudgets: []`), or threw
    // outright (an execution with no matching reviewed init -> an unavailable amount). This
    // function's own header says it "treats the decision as untrusted input regardless" -- this
    // branch now actually does.
    if (
      !Array.isArray(decision.executions) ||
      decision.executions.length === 0 ||
      !Number.isInteger(decision.liveUntilLedger) ||
      decision.liveUntilLedger <= 0 ||
      typeof decision.permissionId !== 'string' ||
      decision.permissionId.trim().length === 0 ||
      typeof decision.scopeId !== 'string' ||
      decision.scopeId.trim().length === 0 ||
      !Number.isFinite(decision.checkedAt) ||
      decision.checkedAt <= 0
    )
      return false
    const budget = decision.reviewedBudgets?.[0]
    if (!budget || typeof budget.token !== 'string' || !Number.isInteger(budget.decimals))
      return false
    if (
      !CANONICAL_UNITS_RE.test(decision.mandateCeilingUnits) ||
      !CANONICAL_UNITS_RE.test(decision.confirmedSpentUnits) ||
      !CANONICAL_UNITS_RE.test(decision.remainingHeadroomUnits)
    )
      return false
    const reviewedByAllocation = new Map(
      (decision.reviewedAgentInits || []).map((r) => [r.allocationId, r])
    )
    return decision.executions.every((e) => {
      const r = reviewedByAllocation.get(e.allocationId)
      return (
        Boolean(r) &&
        typeof r.cap?.token === 'string' &&
        Number.isInteger(r.cap?.decimals) &&
        typeof e.agentAddress === 'string' &&
        e.agentAddress.trim().length > 0 &&
        typeof e.executionId === 'string' &&
        e.executionId.trim().length > 0 &&
        typeof e.scopeId === 'string' &&
        e.scopeId.trim().length > 0 &&
        e.scopeId === decision.scopeId &&
        CANONICAL_UNITS_RE.test(e.amountUnits)
      )
    })
  }
  if (!Array.isArray(decision.agents) || decision.agents.length === 0) return false
  return decision.agents.every(
    (agent) =>
      typeof agent?.allocationId === 'string' &&
      agent.allocationId.trim().length > 0 &&
      typeof agent.agentAddress === 'string' &&
      agent.agentAddress.trim().length > 0 &&
      typeof agent.scopeFingerprint === 'string' &&
      agent.scopeFingerprint.trim().length > 0 &&
      Number.isFinite(agent.scopeExpiry) &&
      agent.scopeExpiry > 0 &&
      typeof agent.headroom?.token === 'string' &&
      agent.headroom.token.trim().length > 0 &&
      Number.isInteger(agent.headroom.decimals) &&
      agent.headroom.decimals >= 0 &&
      CANONICAL_UNITS_RE.test(agent.headroom.units)
  )
}

function freshDecisionIsUsable(decision) {
  if (!decision || decision.mode !== 'fresh') return false
  if (!Number.isInteger(decision.confirmationCount) || decision.confirmationCount < 0) return false
  if (!Number.isFinite(decision.checkedAt) || decision.checkedAt <= 0) return false
  if (!Array.isArray(decision.reviewedBudgets) || decision.reviewedBudgets.length === 0)
    return false
  if (
    !decision.reviewedBudgets.every(
      (budget) =>
        typeof budget?.token === 'string' &&
        budget.token.trim().length > 0 &&
        Number.isInteger(budget.decimals) &&
        budget.decimals >= 0 &&
        CANONICAL_UNITS_RE.test(budget.units)
    )
  )
    return false
  if (!Array.isArray(decision.reviewedAgentInits) || decision.reviewedAgentInits.length === 0)
    return false
  return decision.reviewedAgentInits.every(
    (agent) =>
      typeof agent?.allocationId === 'string' &&
      agent.allocationId.trim().length > 0 &&
      Number.isFinite(agent.expiry) &&
      agent.expiry > 0 &&
      typeof agent.signerFingerprint === 'string' &&
      agent.signerFingerprint.trim().length > 0 &&
      typeof agent.saltFingerprint === 'string' &&
      agent.saltFingerprint.trim().length > 0 &&
      typeof agent.cap?.token === 'string' &&
      agent.cap.token.trim().length > 0 &&
      Number.isInteger(agent.cap.decimals) &&
      agent.cap.decimals >= 0 &&
      CANONICAL_UNITS_RE.test(agent.cap.units)
  )
}

function hasV2CredentialProof(decision) {
  if (!decision || decision.mode !== 'reuse' || decision.version === 3) return true
  return (
    Array.isArray(decision.agents) &&
    decision.agents.length > 0 &&
    decision.agents.every(
      (agent) =>
        typeof agent?.executionCredentialRef === 'string' &&
        agent.executionCredentialRef.trim().length > 0
    )
  )
}

function toV3PermissionView(decision, reusable) {
  const adapterView = toPermissionCopy('stellar-reuse-verified', decision)
  const available = reusable && decision?.confirmationCount === 0
  return Object.freeze({
    ...adapterView,
    status: available ? 'Available' : 'Unavailable',
    confirmationCount: available ? decision.confirmationCount : null,
    copy: available
      ? `Confirmation count: ${decision.confirmationCount}.`
      : 'The existing permission cannot be verified for this run.',
  })
}

export function ProtectStage({
  plan,
  owner = null,
  personaByAddress = null,
  availableWallets = DEFAULT_WALLETS,
  baseMandateView = null,
  // Task 5 chunk C fix round 1 (Critical 1 -- reviewer finding): the ONLY signal that a cumulative
  // ceiling exists at all is the router generation this permission would be checked against --
  // V2's `funding_router.grant` has no such concept, so rendering the ceiling control
  // unconditionally on the live pre-check phase made a false claim on the one path that actually
  // runs in production. No caller can know the router generation before the FIRST check even
  // resolves (`preflightPermission`'s `resolveSchema` decides it internally and is not exposed
  // upward), so this defaults to `null` -- "not yet known" -- which gates the control off, the
  // same dormant-by-default posture every other V3 path in this app already takes. Tests inject
  // `3` to exercise it; `app.jsx` passes nothing today, so it is unreachable in production.
  routerVersion = null,
  onConnectWallet,
  onRetryPreflight,
  onRequestGrant,
  onConfirmReuse,
  onEditPlan,
}) {
  const [durationId, setDurationId] = useState('24h')
  // Task 5 chunk C: the reusable spending ceiling. Defaults BYTE-FOR-BYTE to `plan.amount.units`
  // (the exact string this run moves, i.e. `plannedUnitsNow`) -- assigned straight from the prop,
  // never re-serialized through `Number`/`BigInt`, so it starts life identical to the value that
  // leaves zero repeat headroom once this run spends. `ceilingDraft` is whatever the user is
  // literally typing (so an invalid/rejected keystroke is still visible to fix); `ceilingUnits` is
  // the last COMMITTED value -- it only ever moves forward to a value that parsed as a canonical
  // decimal integer AND was not below `plan.amount.units`. A future reviewer wiring this into
  // `buildReusableApproval` should read `ceilingUnits`, never `ceilingDraft`.
  const [ceilingUnits, setCeilingUnits] = useState(plan.amount.units)
  const [ceilingDraft, setCeilingDraft] = useState(plan.amount.units)
  const [ceilingError, setCeilingError] = useState(null)
  const [connecting, setConnecting] = useState(false)
  // 'select' (choose duration, ready to check) | 'checking' | 'review' | 'requesting' | 'confirmed'
  // | 'failed'. Distinct from `decision`: the REVIEWED FACTS below render off of `decision` alone
  // (whenever present) so a wallet-class failure can preserve them through 'failed' -- only the
  // action area (buttons/status copy) is gated on `phase`.
  const [phase, setPhase] = useState('select')
  const [decision, setDecision] = useState(null)
  const [failureKind, setFailureKind] = useState(null) // 'wallet' | 'preflight'
  const [failureMessage, setFailureMessage] = useState(null)
  const [confirmedResult, setConfirmedResult] = useState(null)

  const preset = DURATION_PRESETS.find((d) => d.id === durationId) || DURATION_PRESETS[1]
  const hasBridge = plan.agents.some((a) => a.kind === 'bridge')
  const permissionView =
    decision?.mode === 'fresh'
      ? toPermissionCopy('fresh-grant', decision)
      : decision?.mode === 'reuse'
        ? decision?.version === 3
          ? toV3PermissionView(decision, reuseIsUsable(decision))
          : toPermissionCopy('stellar-reuse-verified', decision)
        : decision
          ? toPermissionCopy(decision.mode, decision)
          : null
  const usableReuse = reuseIsUsable(decision) && permissionView?.status === 'Available'
  const freshPermissionAvailable =
    decision?.mode === 'fresh' &&
    decision?.freshProofValid !== false &&
    permissionView?.status === 'Available'
  const stopFutureAccessCopy = toPermissionCopy('stop-future-access', decision)
  const withdrawalSeparateCopy = toPermissionCopy('withdrawal-separate', decision)
  const baseCustodyTruth = toBaseCustodyTruth()
  const baseStellarOwner = baseMandateView?.evidence?.stellarOwner
  const basePerCallCap = baseMandateView?.perCallCap
  const baseAllowedActions = baseMandateView?.allowedActions
  const baseMandateReady = Boolean(
    baseMandateView?.status === 'ready' &&
    baseMandateView?.ready === true &&
    typeof baseMandateView.primaryCopy === 'string' &&
    baseMandateView.primaryCopy.includes('while this smart account has funds') &&
    baseMandateView.primaryCopy.includes('It cannot withdraw.') &&
    typeof baseStellarOwner === 'string' &&
    baseStellarOwner.trim().length > 0 &&
    typeof baseMandateView.kernelAddress === 'string' &&
    baseMandateView.kernelAddress.trim().length > 0 &&
    Array.isArray(baseAllowedActions) &&
    baseAllowedActions.length === 2 &&
    new Set(baseAllowedActions).size === 2 &&
    baseAllowedActions.includes('Circle USDC approve') &&
    baseAllowedActions.includes('YieldRouter deposit') &&
    baseMandateView.destination === 'allowlisted Base Sepolia custody proxies' &&
    baseMandateView.repeatedCalls === true &&
    basePerCallCap?.usdc === '10,000' &&
    basePerCallCap?.cumulative === false &&
    basePerCallCap?.nonCumulative === true &&
    baseMandateView.durationDays === 7 &&
    Number.isInteger(baseMandateView.validUntilSeconds) &&
    baseMandateView.validUntilSeconds > 0 &&
    typeof baseMandateView.technicalDisclosure === 'string' &&
    baseMandateView.technicalDisclosure.trim().length > 0 &&
    typeof baseMandateView.renewalCopy === 'string' &&
    baseMandateView.renewalCopy.trim().length > 0 &&
    typeof baseMandateView.revokeCopy === 'string' &&
    baseMandateView.revokeCopy.trim().length > 0 &&
    typeof baseMandateView.outageCopy === 'string' &&
    baseMandateView.outageCopy.trim().length > 0
  )

  // Task 6 (Pocket Crew design alignment) -- the boundaries list and the ceiling card below both
  // need the SAME total-amount/expiry/per-agent-cap figures this component already renders in its
  // review/summary blocks further down (canonical amount DTOs -- no display arithmetic).
  // `totalAmountText` mirrors exactly what the fresh-mode MoneyFigure below prints for `plan.amount`
  // (same two calls, plus the same `.toLocaleString()` MoneyFigure itself applies -- see
  // Primitives.jsx).
  //
  // Fix round 1 -- F2 (review finding): the old single `expiryText` fed formatExpiry's raw ISO
  // instant straight into this stage's most prominent copy. `expiryValue` is the bare English-
  // reading value (the currently selected duration preset before a decision exists -- the same
  // `preset.label` the "Valid for X" line below already reads off -- or a formatted human date via
  // `humanExpiry` once a decision exists, anchored on the first reviewed/reused agent since every
  // agent in one preflight call shares the same requested duration). `expiryPhrase` adds the
  // preposition English needs for each case ("in 24 hours" vs. "on Jan 15, 2027, 11:00 AM") for the
  // boundary sentence; the ceiling row is a labelled row ("Stops working  <value>"), so it renders
  // `expiryValue` bare.
  const totalAmount = (() => {
    try {
      return normalizeCoreAmount({ ...plan.amount, token: tokenSymbol(plan.amount.token) })
    } catch {
      return null
    }
  })()
  const totalAmountText = totalAmount ? formatCoreAmount(totalAmount) : 'Amount unavailable'
  // Task 5 chunk C: a V3 reuse decision carries `executions[]`, never V2's `agents[]` -- so
  // `firstReuseAgent` (and the reads below it) stays `undefined` for V3 by
  // construction. The fresh-mode path is untouched: `firstReviewedAgent` reads `reviewedAgentInits`,
  // which chunk C's own decision composition (app.jsx) populates identically for V2 and V3, so
  // fresh-mode rendering needs no version branch at all.
  const isV3Reuse = decision?.mode === 'reuse' && decision?.version === 3
  const firstReviewedAgent = decision?.mode === 'fresh' ? decision.reviewedAgentInits[0] : null
  const firstReuseAgent = decision?.mode === 'reuse' ? decision.agents[0] : null
  // The absolute ledger expiry is a LEDGER SEQUENCE NUMBER, a different fact from a wall-clock
  // instant -- rendering it through `humanExpiry` (which multiplies by 1000 and treats its input as
  // Unix seconds) would print a nonsense date. Kept out of `expiryValue` entirely for V3 reuse;
  // `expiryPhrase` states it in its own honest ledger-sequence terms instead of pretending a
  // wall-clock precision this fact doesn't have.
  // Fix round 1, Minor 1 (reviewer finding): an unusable V3 decision (missing/invalid
  // `liveUntilLedger`, or any of Important 1's other new checks) must fall back to the SAME
  // neutral "an unknown time" phrasing V2 already uses for unknown expiry, never "at ledger
  // undefined" -- gating on `usableReuse` too (not just mode+version) is what makes that so.
  const v3LedgerExpiryUsable = isV3Reuse && usableReuse
  const expiryValue = !decision
    ? preset.label
    : v3LedgerExpiryUsable
      ? null
      : humanExpiry(
          decision.mode === 'reuse' ? firstReuseAgent?.scopeExpiry : firstReviewedAgent?.expiry
        )
  const expiryPhrase = !decision
    ? `in ${expiryValue}`
    : v3LedgerExpiryUsable
      ? `at ledger ${decision.liveUntilLedger}`
      : `on ${expiryValue}`
  const perAgentCap = firstReuseAgent?.headroom || firstReviewedAgent?.cap
  const perAgentDisplayMap = decision
    ? safeAmountDisplayMap(
        decision.mode === 'reuse' ? decision.agents : decision.reviewedAgentInits,
        decision.mode === 'reuse' ? 'headroom' : 'cap'
      )
    : {}
  const perAgentAllocationId = firstReuseAgent?.allocationId ?? firstReviewedAgent?.allocationId
  const perAgentText = perAgentCap
    ? perAgentDisplayMap[perAgentAllocationId]
      ? `${perAgentDisplayMap[perAgentAllocationId]} ${tokenSymbol(perAgentCap.token)}`
      : exactCoreAmountText(perAgentCap)
    : 'Unknown'

  // Task 5 chunk C -- the V3 projection. `decision.agents` is always `[]` on a V3 decision
  // (toPermissionDecisionView's hardening default), so nothing above this line ever sees a V3
  // execution; this is the one place that reads `decision.executions` at all. `reviewedByAllocation`
  // looks up each execution's token/decimals off the composed `reviewedAgentInits` (chunk C's own
  // app.jsx composition; see that file's `onRetryPreflight`) -- `executions[]` itself carries no
  // token, since one V3 permission binds exactly one token (permissionGrantV3.js's own header).
  // Money figures resolve through the same tokenSymbol()/exactCoreAmountText() boundary used by
  // every other amount path here -- no float display reconstruction.
  const reviewedByAllocation = new Map(
    (decision?.reviewedAgentInits || []).map((r) => [r.allocationId, r])
  )
  const v3TokenDecimals = decision?.reviewedBudgets?.[0]?.decimals
  const v3Token = decision?.reviewedBudgets?.[0]?.token
  // Fix round 1, Important 1 (reviewer finding): gated on `usableReuse` too, not just mode+version
  // -- `reuseIsUsable`'s V3 branch is what now actually proves `reviewedBudgets[0]` and a reviewed
  // init per execution exist and are well-formed; computing these BEFORE that proof (as before)
  // produced "NaN undefined" figures or threw on a malformed decision, even though the render
  // itself was correctly gated. One shared gate for both the computation and the render.
  const v3Figures =
    isV3Reuse && usableReuse
      ? {
          ceiling: exactCoreAmountText({
            token: v3Token,
            units: decision.mandateCeilingUnits,
            decimals: v3TokenDecimals,
          }),
          spent: exactCoreAmountText({
            token: v3Token,
            units: decision.confirmedSpentUnits,
            decimals: v3TokenDecimals,
          }),
          headroom: exactCoreAmountText({
            token: v3Token,
            units: decision.remainingHeadroomUnits,
            decimals: v3TokenDecimals,
          }),
        }
      : null
  const executionAmountRows =
    isV3Reuse && usableReuse
      ? decision.executions.map((e) => {
          const reviewed = reviewedByAllocation.get(e.allocationId)
          return {
            allocationId: e.allocationId,
            kind: reviewed?.kind ?? 0,
            amount: {
              units: e.amountUnits,
              decimals: reviewed?.cap?.decimals,
              token: reviewed?.cap?.token,
            },
          }
        })
      : []
  const executionDisplayMap = safeAmountDisplayMap(executionAmountRows, 'amount')
  const personaForAllocation = (allocationId, fallbackOrdinal) => {
    const ordinal = plan.agents.findIndex((agent) => agent.allocationId === allocationId)
    return personaForOrdinal(ordinal >= 0 ? ordinal : fallbackOrdinal)
  }

  // Fix round 1 -- F3 (review finding): the heading `<p>` + 4-row `<ul>` ceiling card below used to
  // be written out near-verbatim in BOTH `.pc-protect-limit` (reuse) and `.pc-support` (fresh) --
  // mutually exclusive on `decision.mode`, so only one ever renders at a time. Computed once here
  // and referenced from both branches; each branch keeps its own ancestor class untouched (F1's
  // separator-color fix depends on `.pc-protect-limit` vs. `.pc-support` staying distinct ancestors,
  // so this fragment carries no class/background of its own).
  const ceilingCard = (
    <>
      {/* Final-review fix, bundled with F2: was one line at --pc-type-section/700 with no
          tabular-nums, rendering "Ceiling 400 USDC" as a single uniform-size line where the mock
          has a small caption above a large tabular-nums amount. Split into a label + amount pair
          -- tokens only, no new literal. */}
      <p className="pc-ceiling-total">
        <span className="pc-ceiling-total-label">Ceiling</span>
        <span className="pc-ceiling-total-amount">{totalAmountText}</span>
      </p>
      <ul className="pc-ceiling-rows">
        <li>
          <span>Stops working</span>
          <span>{expiryValue}</span>
        </li>
        <li>
          {/* `{perAgentText} cap` (not the bare figure alone): for a single-agent plan the per-agent
              cap and the total amount are the SAME number, and the review block further down
              already renders that exact "<n> <TOKEN>" string as its own standalone MoneyFigure
              element -- an isolated duplicate leaf with the identical bare text would make Testing
              Library's exact `getByText('<n> <TOKEN>')` throw "multiple elements found" (reproduced
              during Task 6's own build; see that task's report). */}
          <span>Per crew member</span>
          <span>{perAgentText} cap</span>
        </li>
        <li>
          <span>Can only reach</span>
          <span>1 vault</span>
        </li>
        <li>
          <span>Future access</span>
          <span>Bounded</span>
        </li>
      </ul>
      <p>{stopFutureAccessCopy.copy}</p>
      <p>{withdrawalSeparateCopy.label}</p>
    </>
  )

  async function handleConnect() {
    setConnecting(true)
    try {
      await onConnectWallet?.()
    } catch {
      // A rejected/failed connect leaves the disconnected view on screen -- nothing to move
      // forward from yet, so there is no permission decision to fail. The (not-yet-built) global
      // wallet surface owns richer connect-error copy; this stage only releases its own spinner.
    } finally {
      setConnecting(false)
    }
  }

  function handleDurationChange(id) {
    setDurationId(id)
    // A decision reviewed against the OLD duration must never keep displaying next to a changed
    // control -- go back to needing an explicit re-check rather than silently relabeling it.
    if (decision) {
      setDecision(null)
      setPhase('select')
    }
  }

  // Task 5 chunk C: raising the ceiling is a real, explicit user edit; lowering it below what this
  // run moves is rejected outright, not clamped or silently ignored -- the draft stays on screen
  // (so the user can see and fix what they typed) but `ceilingUnits`, the committed value, never
  // moves. Same clear-on-edit idiom as `handleDurationChange` above (a decision reviewed against
  // the OLD ceiling must never keep displaying next to a changed control), fired only on a
  // successfully committed edit -- an invalid or rejected keystroke commits nothing, so there is
  // nothing stale to invalidate.
  function handleCeilingInput(raw) {
    setCeilingDraft(raw)
    if (!CANONICAL_UNITS_RE.test(raw)) {
      setCeilingError('Enter a whole number of asset units.')
      return
    }
    if (BigInt(raw) < BigInt(plan.amount.units)) {
      setCeilingError('The ceiling cannot be lower than what this run moves.')
      return
    }
    setCeilingError(null)
    setCeilingUnits(raw)
    if (decision) {
      setDecision(null)
      setPhase('select')
    }
  }

  async function handleCheckPermission() {
    setPhase('checking')
    setDecision(null)
    setFailureKind(null)
    setFailureMessage(null)
    try {
      const raw = await onRetryPreflight({ durationSeconds: preset.seconds })
      const projected = toPermissionDecisionView(raw)
      const decisionView = {
        ...projected,
        freshProofValid: raw?.mode === 'fresh' ? freshDecisionIsUsable(raw) : true,
        credentialProofValid: hasV2CredentialProof(raw),
      }
      setDecision(decisionView)
      setPhase('review')
    } catch {
      setFailureKind('preflight')
      setFailureMessage('Could not check your permission. Nothing moved.')
      setPhase('failed')
    }
  }

  // Fix loop 1 -- I2: which action fires is decided ONCE, here, from the held decision's own
  // mode -- never left for an integration to infer from a single ambiguous prop. Retry (below)
  // re-runs this same function, so a wallet-class retry still dispatches through the correct one
  // of the two props even though `decision` (and therefore its mode) was never cleared.
  async function handleAuthorize() {
    setPhase('requesting')
    const action = decision?.mode === 'reuse' ? onConfirmReuse : onRequestGrant
    try {
      const result = await action()
      setConfirmedResult(result || {})
      setPhase('confirmed')
    } catch (err) {
      if (err instanceof PermissionPhaseError) {
        // The world moved since this was reviewed -- the held decision is proven stale.
        setFailureKind('preflight')
        setDecision(null)
        setFailureMessage('The permission is no longer current. Nothing moved.')
      } else {
        // A plain wallet rejection/failure invalidates only the signature attempt, not the
        // permission review itself.
        setFailureKind('wallet')
        setFailureMessage('The wallet request did not complete. Nothing moved.')
      }
      setPhase('failed')
    }
  }

  function handleRetry() {
    if (failureKind === 'wallet') handleAuthorize()
    else handleCheckPermission()
  }

  function handleEdit() {
    onEditPlan?.()
  }

  const permissionAnnouncement =
    phase === 'checking'
      ? 'Checking your existing permissions.'
      : phase === 'failed'
        ? 'Nothing moved. Review the permission and retry safely.'
        : decision?.mode === 'fresh'
          ? permissionView?.confirmationCount != null
            ? `${permissionView.label}: ${permissionView.confirmationCount} wallet confirmation${permissionView.confirmationCount === 1 ? '' : 's'} required.`
            : permissionView?.copy || 'Permission details are unavailable.'
          : decision?.mode === 'reuse' && usableReuse && permissionView?.status === 'Available'
            ? `${permissionView.label}: confirmation count ${permissionView.confirmationCount}.`
            : decision?.mode === 'reuse'
              ? 'The existing permission cannot be verified for this run.'
              : decision
                ? permissionView?.copy || 'Permission details are unavailable.'
                : ''

  return (
    <div className="pc-protect-stage">
      <p
        className="pc-visually-hidden"
        aria-live="polite"
        aria-atomic="true"
        data-testid="protect-live-region"
      >
        {permissionAnnouncement}
      </p>
      <div className="pc-protect-boundary">
        <div className="pc-dominant pc-dominant--decision pc-strategy-decision">
          <h2 className="pc-strategy-question">Protect this run</h2>

          {/* Final-review fix, M2: `aria-label` overrode the section's own visible <h2> as its
              accessible name, so a landmark list would announce different words than the heading
              on screen. `aria-labelledby` points AT the h2 instead -- the name and the visible
              text are now the same string by construction. */}
          <section className="pc-boundaries" aria-labelledby="protect-boundaries-heading">
            <h2 id="protect-boundaries-heading" className="pc-aside-title">
              Here is what they can never do.
            </h2>
            <ul className="pc-boundary-list">
              <li>
                They can spend at most {totalAmountText}. The token contract itself refuses more.
              </li>
              <li>The permission stops {expiryPhrase}, with no action from you.</li>
              <li>
                Each crew member is pinned to one vault. They cannot send money anywhere else.
              </li>
              <li>Anything leaving a crew account can only go back to your address.</li>
            </ul>
          </section>

          {plan.review?.candidates?.length > 0 && (
            <section
              className="pc-background-check"
              aria-label="Pools that passed the background check"
            >
              <h2 className="pc-aside-title">Pools that passed the background check</h2>
              <p className="pc-section-sub">
                Anything we cannot verify is dropped, not assumed safe.
              </p>
              <ul className="pc-candidate-list">
                {plan.review.candidates.map((c, i) => (
                  <li
                    key={`${c.protocol}-${i}`}
                    className="pc-candidate-row"
                    data-eligible={c.eligible}
                  >
                    <span className="pc-candidate-dot" aria-hidden="true" />
                    <div className="pc-candidate-body">
                      <p className="pc-candidate-name">
                        {/* Fix round 1 -- F5 (review finding): `chain` was never rendered, so two
                            candidates for the same protocol on different chains (e.g. Blend on
                            Stellar and Blend on Base) rendered as pixel-identical rows -- exactly
                            the "byte-identical eligibility rows carry zero information" defect this
                            plan already ruled against, just moved to the render layer. */}
                        {c.protocol} <span className="pc-candidate-chain">{c.chain}</span>
                      </p>
                      {!c.eligible && c.reasons.length > 0 && (
                        <p className="pc-candidate-reason">{c.reasons.join(' · ')}</p>
                      )}
                    </div>
                    <span className="pc-candidate-badge">{c.eligible ? 'PASSED' : 'REJECTED'}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!owner && (
            <div>
              <p>Connect a wallet to review and confirm this permission.</p>
              <p>Connect using {walletsSentence(availableWallets)}.</p>
              <button
                type="button"
                className="pc-button pc-button--primary"
                onClick={handleConnect}
                disabled={connecting}
              >
                {connecting ? 'Connecting…' : 'Connect wallet'}
              </button>
            </div>
          )}

          {owner && !decision && phase === 'select' && (
            <div>
              <div className="pc-field">
                <label htmlFor="protect-duration">
                  How long should this permission stay valid?
                </label>
                <div
                  id="protect-duration"
                  className="pc-comfort-group"
                  role="group"
                  aria-label="Permission duration"
                >
                  {DURATION_PRESETS.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className={`pc-button ${d.id === durationId ? 'pc-button--primary' : 'pc-button--secondary'}`}
                      aria-pressed={d.id === durationId}
                      onClick={() => handleDurationChange(d.id)}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
              {/* Fix round 1, Critical 1 (reviewer finding): a cumulative ceiling is a V3-ONLY
                  concept -- V2's `funding_router.grant` has none -- and this phase is the LIVE
                  pre-check path every real user reaches today. Rendering it unconditionally made a
                  false claim ("Applies 100 USDC as the most this permission can ever move...") on
                  the one surface that actually ships. Gated on `routerVersion === 3`, the only
                  generation where a cumulative ceiling exists; `routerVersion` defaults to `null`
                  (not yet known pre-check), so this is unreachable in production today, same as
                  every other V3 path in this file. Reuses `.pc-field`/`.pc-field-help`/
                  `.pc-field-error` verbatim (already ported, already dark-surface-tuned via
                  `.pc-dominant--decision .pc-field-help/.pc-field-error`) -- no new CSS. */}
              {routerVersion === 3 && (
                <div className="pc-field">
                  <label htmlFor="protect-ceiling">Reusable spending ceiling</label>
                  <input
                    id="protect-ceiling"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    value={ceilingDraft}
                    // Fix round 1, Critical 2 (reviewer finding): the byte-for-byte constraint is
                    // about the COMMITTED value (`ceilingUnits`), never the draft the user is mid-
                    // typing (`ceilingDraft`, which is what `value` above renders). Exposed as its
                    // own data attribute -- not folded into the help sentence below, which is a
                    // human-readable projection rather than the committed value.
                    data-ceiling-units={ceilingUnits}
                    aria-describedby="protect-ceiling-help"
                    aria-invalid={ceilingError ? 'true' : undefined}
                    onChange={(e) => handleCeilingInput(e.target.value)}
                  />
                  <p id="protect-ceiling-help" className="pc-field-help">
                    Applies{' '}
                    {exactCoreAmountText({
                      ...plan.amount,
                      units: ceilingUnits,
                    })}{' '}
                    as the most this permission can ever move, across every future run, until you
                    raise it again.
                  </p>
                  {ceilingError && (
                    <p className="pc-field-error" role="alert">
                      {ceilingError}
                    </p>
                  )}
                </div>
              )}
              <button
                type="button"
                className="pc-button pc-button--primary pc-protect-check-button"
                onClick={handleCheckPermission}
                // Fix round 2, Minor 1 (reviewer finding): `ceilingError` can only ever be
                // non-null when the ceiling input itself is mounted (`routerVersion === 3` --
                // it's the ONLY caller of `handleCeilingInput`), so the extra `routerVersion === 3`
                // conjunct here was redundant and unfalsifiable. Dropped rather than adding a
                // contrived test for an invariant the component already enforces structurally.
                disabled={Boolean(ceilingError)}
              >
                Check my permission
              </button>
            </div>
          )}

          {phase === 'checking' && (
            <StatusNotice state="info" title="Checking your permission">
              <p>Checking your existing permissions…</p>
            </StatusNotice>
          )}

          {decision && decision.mode === 'fresh' && freshPermissionAvailable && (
            <div className="pc-protect-review-summary">
              <p className="pc-permission-status">
                {permissionView.label}: {permissionView.status}
              </p>
              <p>{permissionView.copy}</p>
              <MoneyFigure state="current" amount={totalAmount} />
              <p>Valid for {preset.label} once confirmed.</p>
            </div>
          )}

          {decision &&
            decision.mode === 'fresh' &&
            !freshPermissionAvailable &&
            phase === 'review' && (
              <StatusNotice state="warning" title="Permission unavailable">
                <p className="pc-permission-status">
                  {permissionView.label}: {permissionView.status}
                </p>
                <p>{permissionView?.copy || 'Permission details are unavailable.'}</p>
                <button
                  type="button"
                  className="pc-button pc-button--primary"
                  onClick={handleCheckPermission}
                >
                  Check again
                </button>
              </StatusNotice>
            )}

          {decision && phase === 'review' && (
            <div className="pc-protect-review-lifetime">
              <p>Permission lifetime: {preset.label}</p>
              <p>
                Stellar stores this as an agent timestamp and an allowance ledger cutoff derived
                from the same lifetime.
              </p>
            </div>
          )}

          {decision && decision.mode === 'reuse' && usableReuse && (
            <>
              <p className="pc-permission-status">
                {permissionView.label}: {permissionView.status}
              </p>
              <p>{permissionView.copy}</p>
            </>
          )}

          {decision && decision.mode === 'reuse' && !usableReuse && (
            <StatusNotice state="warning" title="Could not confirm your existing permission">
              <p className="pc-permission-status">
                {permissionView?.label || 'Existing permission'}:{' '}
                {permissionView?.status || 'Unavailable'}
              </p>
              <p>This permission's expiry could not be confirmed, so it cannot be reused.</p>
              <button
                type="button"
                className="pc-button pc-button--primary"
                onClick={handleCheckPermission}
              >
                Check again
              </button>
            </StatusNotice>
          )}

          {decision &&
            decision.mode !== 'fresh' &&
            decision.mode !== 'reuse' &&
            phase === 'review' && (
              <StatusNotice state="warning" title="Permission unavailable">
                <p className="pc-permission-status">
                  {permissionView?.label || 'Permission unavailable'}:{' '}
                  {permissionView?.status || 'Unavailable'}
                </p>
                <p>{permissionView?.copy || 'Permission details are unavailable.'}</p>
                <button
                  type="button"
                  className="pc-button pc-button--primary"
                  onClick={handleCheckPermission}
                >
                  Check again
                </button>
              </StatusNotice>
            )}

          {phase === 'review' &&
            decision &&
            decision.mode === 'fresh' &&
            freshPermissionAvailable && (
              <div className="pc-protect-review-actions">
                <button
                  type="button"
                  className="pc-button pc-button--primary"
                  onClick={handleAuthorize}
                >
                  Authorize with wallet
                </button>
                <button
                  type="button"
                  className="pc-button pc-button--secondary"
                  onClick={handleEdit}
                >
                  Edit plan
                </button>
              </div>
            )}

          {phase === 'review' && decision && decision.mode === 'reuse' && usableReuse && (
            <div className="pc-protect-review-actions">
              <button
                type="button"
                className="pc-button pc-button--primary"
                onClick={handleAuthorize}
              >
                Continue
              </button>
              <button type="button" className="pc-button pc-button--secondary" onClick={handleEdit}>
                Edit plan
              </button>
            </div>
          )}

          {phase === 'requesting' && decision?.mode === 'fresh' && (
            <StatusNotice state="info" title="Waiting for your wallet">
              <p>Approve this in your wallet to continue. Nothing moves until you confirm there.</p>
            </StatusNotice>
          )}

          {phase === 'requesting' && decision?.mode === 'reuse' && (
            <StatusNotice state="info" title="Confirming your permission">
              <p>Checking this permission is still valid on-chain. No signature is needed.</p>
            </StatusNotice>
          )}

          {phase === 'confirmed' && (
            <StatusNotice state="success" title="Confirmed">
              <p>Ready to start.</p>
              {confirmedResult?.agentAddresses?.map((addr) => (
                <p key={addr}>{addr}</p>
              ))}
            </StatusNotice>
          )}

          {phase === 'failed' && (
            <div className="pc-protect-failure">
              <StatusNotice state="danger" title="Nothing moved">
                <p>{failureMessage}</p>
                <div className="pc-protect-failure-actions">
                  <button
                    type="button"
                    className="pc-button pc-button--primary"
                    onClick={handleRetry}
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    className="pc-button pc-button--secondary"
                    onClick={handleEdit}
                  >
                    Edit plan
                  </button>
                </div>
              </StatusNotice>
            </div>
          )}
        </div>

        {/* Rice (`--pc-owned`) is reserved for user-owned or CONFIRMED money (checklist item 4) --
            a reuse decision's headroom is an already-proven, on-chain-verified fact, so it alone
            earns this surface. A fresh decision's "headroom after granting"/"worst case" figures
            are still prospective (true only once the grant confirms), so they render in the
            neutral `.pc-support` role below instead, never in Rice. */}
        {decision && decision.mode === 'reuse' && usableReuse && !isV3Reuse && (
          <div className="pc-protect-limit">
            {ceilingCard}
            {/* Minor (review finding): a point-in-time on-chain read had no freshness stamp
                alongside its scope `Expires` -- one line, decision-level (checkedAt is one
                timestamp for the whole preflight, not per-agent), makes the Rice claim
                self-evidently sound. */}
            <p>As of {formatExpiry(decision.checkedAt)}</p>
            {decision.agents.map((a, index) => {
              const assigned = addressPersona(personaByAddress, a.agentAddress)
              const persona = assigned || personaForAllocation(a.allocationId, index)
              const identity = toAgentIdentityView({
                phase: 'reused',
                allocationId: a.allocationId,
                runId: plan.runId,
                address: a.agentAddress,
                verified: true,
                source: 'owner-discovery',
                state: 'existing',
              })
              return (
                <div
                  key={a.allocationId}
                  className="pc-protect-bound-agent"
                  data-agent-address={a.agentAddress}
                >
                  <div className="pc-protect-agent-identity">
                    <AgentMark identity={identity} state="existing" size={44} label="agent" />
                    <img
                      className="pc-protect-agent-avatar pc-crew-avatar"
                      src={persona.avatar}
                      alt=""
                      aria-hidden="true"
                      width="44"
                      height="44"
                    />
                  </div>
                  <div>
                    <p className="pc-worker-name">{persona.name}</p>
                    {!assigned && <p className="pc-crew-syncing">Crew assignment syncing.</p>}
                    <p>Headroom: {exactCoreAmountText(a.headroom)}</p>
                    <p>Expires {formatExpiry(a.scopeExpiry)}</p>
                    <TechnicalDetails summary={`${persona.name} agent technical details`} open>
                      <p>
                        Soroban C-account: <span className="pc-technical">{a.agentAddress}</span>
                      </p>
                    </TechnicalDetails>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Task 5 chunk C -- the V3 projection. A V3 decision carries `executions[]`, one per
            reviewed allocation, each already bound to a specific deployed agent (chunk A's
            `proveReusablePermission`) -- rendered here instead of the V2 `decision.agents.map(...)`
            above, which a V3 decision can never populate. Four review figures (cumulative ceiling,
            confirmed spend, remaining headroom, absolute ledger expiry) replace the generic
            `ceilingCard` -- a V3 permission's real bound is these on-chain-proven numbers, not the
            plan-derived total/per-agent-cap guess `ceilingCard` shows for V2. `permissionId`/
            `scopeId`/`executionId` are raw sha256 identifiers, not friendly facts -- each renders
            only inside a `TechnicalDetails` disclosure, same convention as the fingerprint/token-
            contract/target facts below (Owner decision #19). */}
        {decision && decision.mode === 'reuse' && usableReuse && isV3Reuse && (
          <div className="pc-protect-limit">
            <p className="pc-ceiling-total">
              <span className="pc-ceiling-total-label">Cumulative ceiling</span>
              <span className="pc-ceiling-total-amount">{v3Figures.ceiling}</span>
            </p>
            <ul className="pc-ceiling-rows">
              <li>
                <span>Confirmed spend</span>
                <span>{v3Figures.spent}</span>
              </li>
              <li>
                <span>Remaining headroom</span>
                <span>{v3Figures.headroom}</span>
              </li>
              <li>
                {/* A ledger SEQUENCE NUMBER, never run through `formatExpiry`/`humanExpiry` -- those
                    treat their input as a Unix-seconds wall-clock instant, and conflating the two
                    facts is exactly how a user misreads how long they are exposed for. */}
                <span>Ledger expiry</span>
                <span>ledger {decision.liveUntilLedger}</span>
              </li>
            </ul>
            {/* Fix round 1, Minor 2 (reviewer finding): V2's own Rice block carries this exact
                freshness stamp (a couple hundred lines up) -- an on-chain-proven figure with no
                as-of timestamp is a regression against V2's own standard on this same surface.
                `decision.checkedAt` is composed in app.jsx's `onRetryPreflight` at the moment the
                V3 check resolves, mirroring V2's own `checkedAt` (reusePreflight.js's `nowSec`). */}
            <p>As of {formatExpiry(decision.checkedAt)}</p>
            <TechnicalDetails summary="Permission technical details">
              <p>
                Permission: <span className="pc-technical">{decision.permissionId}</span>
              </p>
              <p>
                Scope: <span className="pc-technical">{decision.scopeId}</span>
              </p>
            </TechnicalDetails>
            {decision.executions.map((e, index) => {
              const assigned = addressPersona(personaByAddress, e.agentAddress)
              const persona = assigned || personaForAllocation(e.allocationId, index)
              const identity = toAgentIdentityView({
                phase: 'reused',
                allocationId: e.allocationId,
                runId: plan.runId,
                address: e.agentAddress,
                verified: true,
                source: 'owner-discovery',
                state: 'existing',
              })
              return (
                <div
                  key={e.allocationId}
                  className="pc-protect-bound-agent"
                  data-agent-address={e.agentAddress}
                >
                  <div className="pc-protect-agent-identity">
                    <AgentMark identity={identity} state="existing" size={44} label="agent" />
                    <img
                      className="pc-protect-agent-avatar pc-crew-avatar"
                      src={persona.avatar}
                      alt=""
                      aria-hidden="true"
                      width="44"
                      height="44"
                    />
                  </div>
                  <div>
                    <p className="pc-worker-name">{persona.name}</p>
                    {!assigned && <p className="pc-crew-syncing">Crew assignment syncing.</p>}
                    <p>
                      Moves{' '}
                      {executionDisplayMap[e.allocationId]
                        ? `${executionDisplayMap[e.allocationId]} ${tokenSymbol(reviewedByAllocation.get(e.allocationId)?.cap?.token)}`
                        : 'Amount unavailable'}
                    </p>
                    <TechnicalDetails summary={`${persona.name} execution technical details`} open>
                      <p>
                        Soroban C-account: <span className="pc-technical">{e.agentAddress}</span>
                      </p>
                      <p>
                        Execution: <span className="pc-technical">{e.executionId}</span>
                      </p>
                    </TechnicalDetails>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {decision && decision.mode === 'fresh' && freshPermissionAvailable && (
          <div className="pc-support">
            <div className="pc-support-content">
              {ceilingCard}
              {decision.reviewedBudgets.map((b) => (
                <p key={b.token}>Headroom after granting: {exactCoreAmountText(b)}</p>
              ))}
              {decision.reviewedAgentInits.map((r, i) => {
                const exposure = maxAtRisk({
                  capPerPeriod: BigInt(r.cap.units),
                  periodDuration: r.periodSeconds,
                  expiry: r.expiry,
                  nowSec: decision.checkedAt,
                  // Minor (review finding): this is the PRE-approval review screen -- nothing has
                  // been approved yet, so claiming `approvedByUser: true` here was the wrong
                  // signal (permissionScope.js's guard exists precisely to catch that claim).
                  // Omitted, not `false`: `assertScope` only throws on a literal `false` (an
                  // explicit refusal), and this call is pure display math, never the actual grant
                  // args (`toAuthorizeArgs`) -- so leaving the field simply unset never claims
                  // either state one way or the other.
                })
                return (
                  <p key={r.allocationId}>
                    {/* Fix loop 1 -- I3/C1: label from THIS agent's own reviewed cap token, never
                        plan.amount.token -- a mixed-token plan's second agent can be budgeted in a
                        different Stellar contract than the plan's display token names. */}
                    Worst case for agent {i + 1}:{' '}
                    {exactCoreAmountText({
                      ...r.cap,
                      units: exposure.toString(),
                    })}
                  </p>
                )
              })}
              <p>Each agent signs with its own separate session key.</p>
              <p>Each agent can be stopped on its own, independent of the others.</p>
              <p>Network fee sponsored by fee-bump relay.</p>
            </div>
          </div>
        )}
      </div>

      {decision && decision.mode === 'fresh' && (
        <ul
          className="pc-agent-lanes pc-agent-lanes--review"
          aria-label="Reviewed crew permissions"
        >
          {plan.agents.map((planAgent, i) => {
            const reviewed = decision.reviewedAgentInits.find(
              (r) => r.allocationId === planAgent.allocationId
            )
            const isBridge = planAgent.kind === 'bridge'
            const persona = personaForOrdinal(i)
            const identity = toAgentIdentityView({
              phase: 'planned',
              allocationId: planAgent.allocationId,
              runId: plan.runId,
              source: 'reviewed-plan',
              state: 'planned',
            })
            return (
              <li
                key={planAgent.allocationId}
                className="pc-agent-lane"
                data-agent-kind={planAgent.kind}
              >
                <div className="pc-protect-agent-identity">
                  <AgentMark identity={identity} state="planned" size={44} label="agent" />
                  <img
                    className="pc-protect-agent-avatar pc-crew-avatar"
                    src={persona.avatar}
                    alt=""
                    aria-hidden="true"
                    width="44"
                    height="44"
                  />
                </div>
                <div>
                  <p className="pc-worker-name">{persona.name}</p>
                  {isBridge ? (
                    <NetworkRoute context={BRIDGE_NETWORK_CONTEXT} />
                  ) : (
                    <NetworkBadge networkId="stellar-testnet" />
                  )}
                  {reviewed && (
                    <>
                      <p>
                        {/* Fix loop 1 -- I3/C1: label from THIS agent's own reviewed cap token, never
                            plan.amount.token -- a mixed-token plan's second agent can be budgeted in a
                            different Stellar contract than the plan's display token names. */}
                        Cap per period:{' '}
                        {perAgentDisplayMap[reviewed.allocationId]
                          ? `${perAgentDisplayMap[reviewed.allocationId]} ${tokenSymbol(reviewed.cap.token)}`
                          : exactCoreAmountText(reviewed.cap)}
                      </p>
                      <p>Resets every {periodLabel(reviewed.periodSeconds)}</p>
                      <p>Expires {humanExpiry(reviewed.expiry)}</p>
                      <TechnicalDetails summary={`${persona.name} technical details`}>
                        {/* Owner decision #19: the container no longer defaults to mono (it holds
                            friendly prose just as often, see PlanStage.jsx) -- these three raw
                            values are marked .pc-technical individually so they keep rendering in
                            the mono face. */}
                        <p>
                          Session key fingerprint:{' '}
                          <span className="pc-technical">{reviewed.signerFingerprint}</span>
                        </p>
                        <p>
                          Token contract: <span className="pc-technical">{reviewed.token}</span>
                        </p>
                        <p>
                          Target: <span className="pc-technical">{reviewed.target}</span>
                        </p>
                      </TechnicalDetails>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {hasBridge && (
        <div className="pc-support">
          <div className="pc-support-content">
            <h2>Base Sepolia bridge</h2>
            <VenueTruth kind={baseCustodyTruth.custody === 'custody' ? 'base-proxy' : 'unknown'} />
            {baseMandateReady ? (
              <>
                <p>{baseMandateView.primaryCopy}</p>
                <dl>
                  <div>
                    <dt>Stellar owner</dt>
                    <dd className="pc-technical">{baseStellarOwner}</dd>
                  </div>
                  <div>
                    <dt>Base kernel</dt>
                    <dd className="pc-technical">{baseMandateView.kernelAddress}</dd>
                  </div>
                  <div>
                    <dt>Session-key custody</dt>
                    <dd>Relayer-held session key</dd>
                  </div>
                  <div>
                    <dt>Approved calls</dt>
                    <dd>{baseAllowedActions.join(' + ')}</dd>
                  </div>
                  <div>
                    <dt>Pool / destination</dt>
                    <dd>{baseMandateView.destination}</dd>
                  </div>
                  <div>
                    <dt>Per-call cap</dt>
                    <dd>{basePerCallCap.usdc} USDC per call, non-cumulative</dd>
                  </div>
                  <div>
                    <dt>Expiry</dt>
                    <dd>{baseMandateView.durationDays} days</dd>
                  </div>
                </dl>
                <TechnicalDetails summary="Base mandate technical details" open>
                  <p>{baseMandateView.technicalDisclosure}</p>
                </TechnicalDetails>
                <p>{baseMandateView.renewalCopy}</p>
                <p>{baseMandateView.revokeCopy}</p>
                <p>{baseMandateView.outageCopy}</p>
              </>
            ) : (
              <p>Base mandate details are unavailable right now.</p>
            )}
            <a href="/settings?tab=wallet#base-mandate">Base mandate settings</a>
          </div>
        </div>
      )}
    </div>
  )
}
