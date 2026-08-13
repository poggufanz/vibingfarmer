// frontend/src/components/strategy/StrategyReceipt.jsx
// Strategy Task 12 (Pocket Crew redesign, Wave 5); custody rendering extended by Task 6 chunk C2.
// The durable custody receipt for a settled run. Renders ONLY from an already-built
// `DispatchReceiptV1` (frontend/src/strategy/dispatchSummary.js's `buildDispatchReceipt`) the
// caller supplies -- this component never re-derives execution status or custody itself; the
// receipt producer already did that reconciliation and is the single source of truth for "what
// actually happened." (This header previously read "dispatchSummary.js is off-limits to edit for
// this task, read-only" -- that note was stale, left over from the earlier, different Strategy
// Task 12 this file was originally built under. Task 6's own file list explicitly includes
// dispatchSummary.js, ruled on directly by the controller; chunk C2 edits both files together.)
// This component's own job is purely: group+sum the already-canonical per-allocation amounts
// (bigint, never mixing two different tokens' units), project each allocation's own custody
// evidence as-is -- never re-deriving a location or a confirmation dispatchSummary.js did not
// already assert -- and present it all truthfully.
import { MoneyFigure, StatusNotice, TechnicalDetails } from '../pocket/Primitives.jsx'
import { SOROBAN_TOKEN_ADDRESS } from '../../stellar/config.js'
import { STELLAR_USDC_SAC } from '../../stellar/cctpBurn.js'
import {
  formatCoreAmount,
  normalizeCoreAmount,
  toFactView,
  toFreshnessView,
} from '../../core/coreRouteAdapters.js'

// Same real-contract -> human-symbol map ProtectStage.jsx uses (fix loop 1 -- C1 there): a
// `token` field on a canonical amount is a Stellar CONTRACT ADDRESS in production, never a
// friendly literal like 'USDC'. Not exported from ProtectStage.jsx, so re-declared here identically
// (same rationale as ProtectStage's own header comment: sibling surface, not a shared module).
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

function receiptAmount(units, decimals, token) {
  try {
    return normalizeCoreAmount({
      token: tokenSymbol(token),
      units: BigInt(units).toString(),
      decimals,
    })
  } catch {
    return null
  }
}

function receiptAmountText(units, decimals, token) {
  const amount = receiptAmount(units, decimals, token)
  return amount ? formatCoreAmount(amount) : 'Amount unavailable'
}

function terminalCustodyLocationFor(allocation) {
  const context = allocation?.networkContext
  if (!context || typeof context !== 'object') return null
  if (context.destinationNetwork === 'base-sepolia') return 'base-proxy'
  if (
    context.executionNetwork === 'stellar-testnet' &&
    (context.destinationNetwork == null || context.destinationNetwork === 'stellar-testnet')
  ) {
    return 'stellar-vault'
  }
  return null
}

function hasReceiptProof(allocation) {
  const terminalLocation = terminalCustodyLocationFor(allocation)
  return (
    terminalLocation != null &&
    allocation?.executionStatus === 'succeeded' &&
    allocation.custody?.confirmed === true &&
    allocation.custody?.source === 'receipt' &&
    allocation.custody?.location === terminalLocation
  )
}

/**
 * Bigint, per-(token,decimals) reconciliation. For every group: deposited + inTransit + held +
 * unmoved === total, always -- a mutation-provable invariant (see StrategyReceipt.test.jsx).
 * Never mixes two different tokens' units in one sum: a mixed Stellar (7dp) + Base (6dp) run's
 * units are not the same integer scale, so each (token,decimals) pair gets its own row.
 *
 * - `deposited`  executionStatus 'succeeded' with receipt-sourced confirmed custody (stellar-vault,
 *                or base-proxy for a bridged child -- both are the honest "arrived where it was
 *                supposed to" outcome). A succeeded outcome without that proof stays unknown.
 * - `inTransit`  executionStatus 'pending' (dispatchSummary.js's branchStatus marks a Base branch
 *                with any pending child 'in-transit' -- the CCTP job is still running server-side;
 *                this is the reconciliation-level mirror of that same fact, never resolved by a
 *                timeout on this side).
 * - `held`       failed AND custody.location === 'agent' -- pulled from the owner into an agent
 *                (a Stellar deposit agent, a Stellar bridge agent that pulled funds but never
 *                burned them, or -- once Task 6's receipt evidence reaches the Base leg --
 *                a Base-side kernel that received a CCTP mint but never reached the destination
 *                vault; dispatchSummary.js's `provenCustody` deliberately maps the receipt's own
 *                'base-kernel' onto this SAME 'agent' bucket, so this reconciliation needs no
 *                change on that day) but never reached its destination; baseLeg.js's own
 *                vocabulary for this is "stranded funds, recoverable via an owner sweep"
 *                (baseLeg.js:294-301,328-330).
 * - `unmoved`    everything else that isn't deposited/in-transit/held: a failed allocation whose
 *                custody is 'owner'/'unknown', OR an allocation with no evidence at all
 *                (`not-started`/`unknown` executionStatus) -- the conservative bucket. Never claim
 *                custody this receipt cannot prove.
 * @param {Array} allocations DispatchReceiptV1['allocations'] (AllocationOutcomeV1[])
 * @returns {Array<{token:string, decimals:number, deposited:bigint, confirmed:bigint, inTransit:bigint, held:bigint, unmoved:bigint, unknown:bigint, total:bigint}>}
 */
export function reconcileAllocations(allocations) {
  const byGroup = new Map()
  for (const a of allocations) {
    const key = `${a.amount.token}:${a.amount.decimals}`
    const row =
      byGroup.get(key) ||
      Object.seal({
        token: a.amount.token,
        decimals: a.amount.decimals,
        deposited: 0n,
        confirmed: 0n,
        inTransit: 0n,
        held: 0n,
        unmoved: 0n,
        unknown: 0n,
        total: 0n,
      })
    const units = BigInt(a.amount.units)
    row.total += units
    if (a.executionStatus === 'succeeded' && hasReceiptProof(a)) {
      row.deposited += units
      row.confirmed += units
    } else if (a.executionStatus === 'succeeded') {
      row.unmoved += units
      row.unknown += units
    } else if (a.executionStatus === 'pending') row.inTransit += units
    else if (a.custody?.location === 'agent') row.held += units
    else {
      row.unmoved += units
      if (!['failed', 'cancelled'].includes(a.executionStatus)) row.unknown += units
    }
    byGroup.set(key, row)
  }
  return [...byGroup.values()]
}

// A "nominal total" collapses every token group into one display amount under the assumption every
// group is a 1:1 stablecoin -- exact only when explicitly labeled that way (Step 3's rule). Groups
// may use different decimal scales, so each is promoted to the largest scale before the BigInt sum.
function nominalTotal(groups) {
  try {
    if (groups.some((group) => group.unknown > 0n)) return 'Unavailable'
    const decimals = groups.reduce((max, group) => Math.max(max, group.decimals), 0)
    const units = groups.reduce(
      (sum, group) => sum + group.total * 10n ** BigInt(decimals - group.decimals),
      0n
    )
    return formatCoreAmount({ token: 'USDC', units: units.toString(), decimals })
  } catch {
    return 'Unavailable'
  }
}

function explorerTxUrl(allocation) {
  const isBase =
    allocation.networkContext?.destinationNetwork === 'base-sepolia' &&
    allocation.networkContext?.currentCustodyNetwork === 'base-sepolia'
  return isBase
    ? `https://sepolia.basescan.org/tx/${allocation.txHash}`
    : `https://stellar.expert/explorer/testnet/tx/${allocation.txHash}`
}

// Task 6 chunk C2 -- projects an allocation's own custody evidence AS EVIDENCE, rather than the
// page silently treating a proven receipt-sourced verdict and the pre-existing inferred fallback
// (dispatchSummary.js's CustodyV1 `source:'receipt'|'inferred'|'unmapped'`) with the same
// confidence. Leaving that distinction unrendered would be exactly the "transport acceptance
// mistaken for custody" defect this task exists to remove, just relocated to the view layer
// instead of fixed. Reads `custody` as supplied -- never re-derives a location, a confirmation, or
// an amount from `executionStatus`/`txHash` the way the OLD `inferredCustody()` guessed.
// `custody.amount` is the receipt's OWN amount (present only when proven); it is never folded into
// the plan-authoritative `a.amount` reconciliation above (`reconcileAllocations` untouched).
function custodyEvidenceText(custody) {
  if (!custody) return null
  // Fix round 1, Important finding 2: `source:'unmapped'` (dispatchSummary.js's `unmappedCustody`,
  // the controller-ruled per-allocation fail-loud verdict for a receipt location this module's
  // vocabulary copy doesn't recognize) is its own case, rendered distinctly so it is never mistaken
  // for a genuine "no evidence" `unknown` -- the whole point of that fix was to make the failure
  // loud and visible instead of indistinguishable from an honest absence of evidence.
  if (custody.source === 'unmapped') {
    return `custody evidence unreadable (${custody.reason || 'unrecognized receipt location'})`
  }
  const provenance = custody.source === 'receipt' ? 'receipt-confirmed' : 'not receipt-confirmed'
  // Fix round 1, Important finding 1: `location` and `amount` are INDEPENDENT facts on CustodyV1 --
  // a confirmed, proven custody at a known, non-'unknown' location with NO amount evidence is real
  // and producible (allocationReceipt.js's `confirmCustody` omits `amount` whenever a caller does,
  // e.g. a bare `{location:'stellar-vault', txSuccess:true, matchingEvent:true}` call never passes
  // one). The earlier version of this function branched on `custody.amount == null` to decide
  // whether to show "unknown," which silently erased a proven LOCATION any time its amount merely
  // happened to be absent -- the exact silent-discard defect this chunk exists to close, relocated
  // into the view. Only a genuine `location === 'unknown'` gets the "unknown" text now; every other
  // location renders as given, with the amount clause simply omitted (never a coerced zero) when
  // there is no amount to show.
  if (custody.location === 'unknown') {
    return `custody unknown (${provenance})`
  }
  const amountText =
    custody.amount == null
      ? ''
      : `, ${receiptAmountText(custody.amount.units, custody.amount.decimals, custody.amount.token)}`
  return `custody: ${custody.location}${amountText} (${provenance})`
}

function receiptFactView(receipt, allocations, runMatches) {
  if (!runMatches) return null
  const evidence = allocations.find(
    (allocation) => allocation.custody?.source && allocation.custody?.checkedAt != null
  )
  const source = receipt.source || receipt.receiptSource || evidence?.custody?.source
  const checkedAt = receipt.checkedAt ?? receipt.observedAt ?? evidence?.custody?.checkedAt
  if (!source || checkedAt == null) return null
  try {
    const fact = toFactView({
      phase: 'confirmed',
      state: allocations.length > 0 && allocations.every(hasReceiptProof) ? 'confirmed' : 'current',
      source,
      checkedAt,
    })
    return toFreshnessView(fact).state === 'unavailable' ? null : fact
  } catch {
    return null
  }
}

function allocationAgentAddress(allocation) {
  const evidence = allocation?.evidence
  if (!evidence || typeof evidence !== 'object') return null
  if (
    typeof allocation?.allocationId !== 'string' ||
    allocation.allocationId.trim().length === 0 ||
    evidence.allocationId !== allocation.allocationId
  ) {
    return null
  }
  const address = evidence.agentAddress
  return typeof address === 'string' && address.trim().length > 0 ? address.trim() : null
}

function isRealCheckedAt(value) {
  return (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.trim().length > 0)
  )
}

function networkEvidence(allocation) {
  const context = allocation?.networkContext
  if (!context || typeof context !== 'object') return []
  return [
    ['Execution network', context.executionNetwork],
    ['Source network', context.sourceNetwork],
    ['Destination network', context.destinationNetwork],
    ['Current custody network', context.currentCustodyNetwork],
    ['Transit', context.transit],
  ].filter(([, value]) => value !== null && value !== undefined && value !== '')
}

export function StrategyReceipt({ receipt, runId, onViewMoney, onMakeAnotherDeposit, onViewCrew }) {
  const allocations = receipt.allocations || []
  const runMatches =
    typeof runId === 'string' &&
    runId.trim().length > 0 &&
    typeof receipt.runId === 'string' &&
    receipt.runId.trim().length > 0 &&
    runId === receipt.runId
  const displayAllocations = runMatches
    ? allocations
    : allocations.map((allocation) => ({
        ...allocation,
        executionStatus: 'unknown',
        custody: { ...allocation.custody, location: 'unknown', confirmed: false },
      }))
  const groups = reconcileAllocations(displayAllocations)
  const effectiveRunId = runId || receipt.runId || 'Unavailable'
  const anyFailed = allocations.some((a) => a.executionStatus === 'failed')
  const anyPending = allocations.some((a) => a.executionStatus === 'pending')
  const succeededWithoutProof = allocations.some(
    (allocation) => allocation.executionStatus === 'succeeded' && !hasReceiptProof(allocation)
  )
  const anyUnknown =
    !runMatches ||
    succeededWithoutProof ||
    allocations.some((a) => !['succeeded', 'failed', 'pending'].includes(a.executionStatus))
  const receiptFact = receiptFactView(receipt, allocations, runMatches)
  // Optional and separate from the deposit reconciliation above (Step 1's rule: "optional
  // attestation is separate and counts its own confirmation") -- only rendered when a real
  // allocation actually carries attestation evidence (dispatchSummary.js's safeEvidence() only
  // copies this key through when the raw branch result had one).
  const attestedAllocation = allocations.find((a) => a.evidence?.attestation)

  return (
    <div className="pc-dominant pc-dominant--owned pc-strategy-receipt">
      <h2>Your receipt</h2>

      {anyUnknown && (
        <StatusNotice state="warning" title="Receipt unavailable">
          <p>Some allocation outcomes could not be reconciled from a trusted receipt.</p>
          <p>Next safe action: Check the latest ledger receipt before retrying.</p>
        </StatusNotice>
      )}
      {!anyUnknown && anyFailed && (
        <StatusNotice state="warning" title="Some agents did not complete">
          <p>
            Agents that already finished stay confirmed -- nothing already deposited was undone.
          </p>
          <p>Next safe action: Review held or unmoved allocations before retrying.</p>
        </StatusNotice>
      )}
      {!anyUnknown && !anyFailed && !anyPending && allocations.length > 0 && (
        <StatusNotice state="success" title="Every agent completed">
          <p>Every planned allocation reached its destination.</p>
        </StatusNotice>
      )}
      {!anyUnknown && !anyFailed && anyPending && (
        <StatusNotice state="info" title="Still in transit">
          <p>
            The rest is still moving. This page will keep reflecting the real, reconciled state.
          </p>
          <p>Next safe action: Wait for the in-transit receipt before retrying.</p>
        </StatusNotice>
      )}

      <ul className="pc-allocation-list">
        {groups.map((g) => (
          <li key={`${g.token}:${g.decimals}`} className="pc-allocation-row">
            <div>
              <p>{tokenSymbol(g.token)}</p>
              <MoneyFigure
                state={g.deposited > 0n ? 'current' : 'unavailable'}
                amount={g.deposited > 0n ? receiptAmount(g.deposited, g.decimals, g.token) : null}
              />
              {g.deposited > 0n && <p>Deposited</p>}
              {g.confirmed > 0n && <p>Confirmed</p>}
              {g.inTransit > 0n && (
                <p>In transit: {receiptAmountText(g.inTransit, g.decimals, g.token)}</p>
              )}
              {g.held > 0n && <p>Held: {receiptAmountText(g.held, g.decimals, g.token)}</p>}
              {g.unknown > 0n ? (
                <p>Reconciliation unavailable: Unavailable</p>
              ) : (
                g.unmoved > 0n && (
                  <p>Money did not move: {receiptAmountText(g.unmoved, g.decimals, g.token)}</p>
                )
              )}
              <p>
                Total:{' '}
                {g.unknown > 0n ? 'Unavailable' : receiptAmountText(g.total, g.decimals, g.token)}
              </p>
            </div>
          </li>
        ))}
      </ul>

      {/* Step 3: a nominal blended total, shown ONLY when explicitly labeled as such, and only
          when there is more than one token group to blend in the first place. */}
      {groups.length > 1 && (
        <p className="pc-field-help">
          Nominal total (assumes each token above is worth 1 USDC): {nominalTotal(groups)}
        </p>
      )}

      {attestedAllocation && (
        <StatusNotice state="info" title="Attestation">
          <p>Confirmed for allocation {attestedAllocation.allocationId}.</p>
        </StatusNotice>
      )}

      {/* Owner decision #19: the container no longer defaults to mono -- every raw run id/address/
          tx hash below is marked .pc-technical individually so it keeps rendering in the mono
          face; "Reused existing permission"/"Fresh grant" stay friendly prose in the body face,
          which is correct. */}
      <TechnicalDetails summary="Technical details" fact={receiptFact}>
        <p>
          Run: <span className="pc-technical">{effectiveRunId}</span>
        </p>
        {!runMatches && (
          <p>
            Receipt run: <span className="pc-technical">{receipt.runId || 'Unavailable'}</span>
          </p>
        )}
        <p>
          Grant/permission:{' '}
          {receipt.permission?.mode === 'reuse' ? 'Reused existing permission' : 'Fresh grant'}
        </p>
        {receipt.permission?.txHash && (
          <p>
            Grant transaction:{' '}
            <a
              className="pc-technical"
              href={explorerTxUrl({ txHash: receipt.permission.txHash })}
              target="_blank"
              rel="noreferrer"
            >
              {receipt.permission.txHash}
            </a>
          </p>
        )}
        {allocations.map((a) => {
          // Fix round 1 (minor): computed once, not twice, per allocation.
          const custodyNote = custodyEvidenceText(a.custody)
          const agentAddress = allocationAgentAddress(a)
          const networkFacts = networkEvidence(a)
          const checkedAt = a.custody?.checkedAt
          return (
            <div key={a.allocationId}>
              <p>
                <span className="pc-technical">{a.allocationId}</span>:{' '}
                {a.txHash ? (
                  <a
                    className="pc-technical"
                    href={explorerTxUrl(a)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {a.txHash}
                  </a>
                ) : (
                  <span className="pc-technical">—</span>
                )}
                {a.error ? ` -- ${a.error}` : ''}
                {custodyNote && <span className="pc-field-help"> ({custodyNote})</span>}
              </p>
              {agentAddress && (
                <p>
                  Agent: <span className="pc-technical">{agentAddress}</span>
                </p>
              )}
              {networkFacts.map(([label, value]) => (
                <p key={`${a.allocationId}:${label}`}>
                  {label}: <span className="pc-technical">{String(value)}</span>
                </p>
              ))}
              {isRealCheckedAt(checkedAt) && (
                <p>
                  Checked at: <span className="pc-technical">{String(checkedAt)}</span>
                </p>
              )}
            </div>
          )
        })}
      </TechnicalDetails>

      {/* Task 7 (Start polish) -- brief's own file list named only StartStage.jsx/strategy.css/
          app.jsx as the files to touch for the done-state "Watch the crew"/"Back to my money"
          actions, describing them as replacing what renders at `.pc-receipt-actions` -- but that
          markup actually lives here, in this sibling component (StartStage.jsx only composes
          <StrategyReceipt>, it never renders its own action row). `onViewCrew` is the one addition
          this task makes to this file: strictly additive and opt-in, so StrategyReceipt.test.jsx's
          own locked-down "actions are exactly View my money (primary) and Make another deposit
          (secondary)" test (none of whose call sites pass onViewCrew) keeps passing untouched. Only
          a caller that supplies onViewCrew (StartStage.jsx, once app.jsx wires it) gets the new
          three-action row; every other/older caller sees the original two-button behavior,
          byte-identical to before. */}
      <div className="pc-receipt-actions">
        {onViewCrew ? (
          <>
            <button type="button" className="pc-button pc-button--primary" onClick={onViewCrew}>
              Watch the crew
            </button>
            <button type="button" className="pc-button pc-button--secondary" onClick={onViewMoney}>
              Back to my money
            </button>
            <button
              type="button"
              className="pc-button pc-button--secondary"
              onClick={onMakeAnotherDeposit}
            >
              Make another deposit
            </button>
          </>
        ) : (
          <>
            <button type="button" className="pc-button pc-button--primary" onClick={onViewMoney}>
              View my money
            </button>
            <button
              type="button"
              className="pc-button pc-button--secondary"
              onClick={onMakeAnotherDeposit}
            >
              Make another deposit
            </button>
          </>
        )}
      </div>
    </div>
  )
}
