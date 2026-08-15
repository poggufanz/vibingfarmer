// frontend/src/components/money/WithdrawDialog.jsx
// My Money Task 12 (Pocket Crew redesign, Wave 5). Consequence-first withdraw preview -- Stellar
// full exit, Stellar partial exit (one agent), and the Base full-unwind CTA -- built on top of
// Foundation's Dialog (trap focus/labelled title+description/restore focus/Escape, Primitives.jsx)
// and Task 9's PURE planners (money/ownerActions.js's planFullExit/planPartialExit). This file
// never calls the chain itself -- same convention as MyMoneyRoute/AgentTeam.jsx (Task 11): a pure
// component tree, no data fetching. The caller (Task 13) owns discovery/position/account state and
// wires onConfirmFull/onConfirmPartial/onConfirmBase to the real stellar/exit.js + Base full-unwind
// calls, then re-renders with `pending`/`progress` as the real attempt proceeds.
//
// Three MUTUALLY EXCLUSIVE tabs (full / partial / base). A historical Base position remains
// represented when execution is unavailable, but its tab is disabled and bound to a public-safe
// notice; verified availability is the only state that can expose the destructive Base CTA.
// rather than an always-appended Base section -- every tab therefore has exactly ONE primary action
// in the shared Dialog `actions` footer, Cancel always rendered right alongside it (brief: "Cancel
// before/alongside a non-Harvest destructive action").
//
// Hardened BaseExitSweeper checks YieldRouter.knownPool, not the owner-revocable new-deposit
// allowlist. A pool disabled after deposit therefore remains sweepable; the preview names the
// known target set it was given without reviving the obsolete "disabled pools are skipped" copy.
import { useMemo, useState } from 'react'
import { Dialog, VenueTruth } from '../pocket/Primitives.jsx'
import { NetworkRoute } from '../pocket/NetworkIdentity.jsx'
import {
  planFullExit,
  planPartialExit,
  confirmationsCopy,
  feeModelCopy,
  targetStateLabel,
} from '../../money/ownerActions.js'
import { formatAssetUnits, parseAssetUnits } from '../../money/assetUnits.js'

const BASE_USDC_DECIMALS = 6

// Same convention as AgentTeam.jsx/PositionList.jsx/StrategyReceipt.jsx: each sibling surface
// keeps its own tiny copy of these display-only helpers rather than sharing a module across
// unrelated route trees.
function shortAddr(address) {
  return typeof address === 'string' && address.length > 12
    ? `${address.slice(0, 4)}…${address.slice(-4)}`
    : (address ?? 'Unavailable')
}

// ownerActions owns the business vocabulary, including legacy separator punctuation. This
// presentation boundary keeps money copy readable without exposing visible dash separators.
function safeMoneyCopy(value) {
  return typeof value === 'string' ? value.replace(/\s*(?:--|—|–)\s*/g, '. ') : value
}

// Task 6 presentation boundary. Money rows may originate in business code as BigInts, but the
// Foundation primitives only receive the exact `{ token, units, decimals }` DTO. A malformed row
// is unknown, never a zero balance or a partially summed total.
function canonicalAmount(amount, fallbackDecimals = null) {
  if (!amount || typeof amount !== 'object' || Array.isArray(amount)) return null
  const token = typeof amount.token === 'string' && amount.token.trim() ? amount.token : null
  const decimals = amount.decimals ?? fallbackDecimals
  if (!token || !Number.isInteger(decimals) || decimals < 0 || decimals > 38) return null
  let units
  try {
    units = typeof amount.units === 'bigint' ? amount.units.toString() : amount.units
  } catch {
    return null
  }
  if (typeof units !== 'string' || !/^\d+$/.test(units)) return null
  return { token, units, decimals }
}

function unitsToDisplay(units, decimals) {
  try {
    return formatAssetUnits(units, decimals)
  } catch {
    return null
  }
}

// My Money Task 13 Part B item 7: confirmationsCopy/feeModelCopy/targetStateLabel used to be a
// local copy of vocabulary ownerActions.js already owns (targetState()'s own states, planFullExit's
// own expectedConfirmations doc) -- MM12's own report flagged this as the exact duplication that
// belonged next to its source once ownerActions.js came into scope (see that file's header comment
// on this section). Now imported from there; this file keeps no local copy.

function amountLine(amount) {
  const normalized = canonicalAmount(amount)
  if (!normalized || normalized.units === '') return 'Unavailable'
  const value = unitsToDisplay(normalized.units, normalized.decimals)
  return value == null ? 'Unavailable' : `${value} ${normalized.token}`
}

function formatBasePositionAmount(position) {
  // Base positions come from the pinned Base USDC reader. Its source-owned wire shape omits both
  // token and decimals because this reader is fixed to Circle USDC (6 decimals). That omission is
  // explicit here, not a generic fallback: once a producer supplies a decimals field it must be
  // exactly 6, and malformed precision never gets silently treated as a six-decimal value.
  if (!position || typeof position !== 'object' || Array.isArray(position)) return 'Unavailable'
  const hasExplicitToken = Object.prototype.hasOwnProperty.call(position, 'token')
  const hasExplicitDecimals = Object.prototype.hasOwnProperty.call(position, 'decimals')
  const token = hasExplicitToken ? position.token : 'USDC'
  const decimals = hasExplicitDecimals ? position?.decimals : BASE_USDC_DECIMALS
  if (
    typeof position.pool !== 'string' ||
    !position.pool.trim() ||
    decimals !== BASE_USDC_DECIMALS ||
    (hasExplicitToken && token !== 'USDC')
  ) {
    return 'Unavailable'
  }
  const amount = canonicalAmount(
    {
      token,
      units: position?.assets,
      decimals,
    },
    BASE_USDC_DECIMALS
  )
  if (!amount) return 'Unavailable'
  const value = unitsToDisplay(amount.units, amount.decimals)
  return value == null ? 'Unavailable' : `${value} ${amount.token}`
}

// Stellar-vault leg only (custody.js's own precedence: per-leg breakdown first, whole-agent
// custody only when there is no breakdown) -- a display-only hint for "how much is available to
// withdraw from this agent". Never fed back into planPartialExit's own max-vs-amount gate, which
// re-derives the same thing from the same evidence independently.
function stellarVaultAvailable(agent) {
  const legs = agent?.custodyBreakdown?.length
    ? agent.custodyBreakdown
    : agent?.custody?.location
      ? [{ location: agent.custody.location, amount: agent.amount }]
      : []
  return legs.find((leg) => leg.location === 'stellar-vault')?.amount ?? null
}

function partialReasonMessage(plan) {
  if (!plan) return null
  if (plan.reason === 'invalid-amount') return 'Enter an amount greater than zero.'
  if (plan.reason === 'balance-unavailable')
    return "This agent's vault balance could not be confirmed. Try again, or use full exit."
  if (plan.reason === 'exceeds-max') {
    const max = plan.maxAmount
      ? unitsToDisplay(plan.maxAmount.units, plan.maxAmount.decimals)
      : null
    const token = plan.maxAmount?.token || 'USDC'
    return `Exceeds this agent's confirmed balance${max != null ? ` (${max} ${token})` : ''}.`
  }
  return safeMoneyCopy(plan.message) || null
}

function inputReasonMessage(parsed, decimals, availableAmount) {
  if (!parsed || parsed.ok || parsed.code === 'EMPTY') return null
  if (parsed.code === 'INVALID_FORMAT') return 'Enter a plain decimal amount, like 100 or 12.5.'
  if (parsed.code === 'ZERO') return 'Enter an amount greater than zero.'
  if (parsed.code === 'TOO_PRECISE') return `Amount has more than ${decimals} decimal places.`
  if (parsed.code === 'OVERFLOW') return 'Amount is too large for the selected asset.'
  if (parsed.code === 'EXCEEDS_AVAILABLE') {
    const max = availableAmount
      ? unitsToDisplay(availableAmount.units, availableAmount.decimals)
      : null
    const token = availableAmount?.token || 'USDC'
    return `Exceeds this agent's confirmed balance${max != null ? ` (${max} ${token})` : ''}.`
  }
  return null
}

function sourceProofIsCurrent(row) {
  if (!row || typeof row !== 'object') return false
  const rowAmount = canonicalAmount(row.amount)
  if (!rowAmount) return false
  const freshnessValues = [
    row.freshness,
    row.amountFreshness,
    row.amountState,
    row.moneyState,
    row.amount?.state,
  ]
  if (freshnessValues.some((state) => state && !['current', 'known'].includes(state))) return false
  for (const leg of [row.vaultShares, row.idleToken]) {
    if (
      !leg ||
      typeof leg !== 'object' ||
      leg.state !== 'known' ||
      !Number.isFinite(leg.checkedAt) ||
      leg.checkedAt <= 0 ||
      !canonicalAmount(leg.amount) ||
      leg.amount.token !== rowAmount.token ||
      leg.amount.decimals !== rowAmount.decimals
    ) {
      return false
    }
  }
  if (row.checkedAt !== undefined && (!Number.isFinite(row.checkedAt) || row.checkedAt <= 0)) {
    return false
  }
  return true
}

export function WithdrawDialog({
  open,
  onClose,
  agents = [],
  discovery = null,
  account = null,
  basePlan = null,
  pending = false,
  progress = null,
  onConfirmFull,
  onConfirmPartial,
  onConfirmBase,
}) {
  const [mode, setMode] = useState('full')
  const [chosenAddress, setChosenAddress] = useState(null)
  const [amountInput, setAmountInput] = useState('')
  const basePositions = Array.isArray(basePlan?.positions) ? basePlan.positions : []
  const hasBaseHistory = basePositions.length > 0
  const basePositionSetValid = (() => {
    if (!hasBaseHistory) return false
    const pools = new Set()
    for (const position of basePositions) {
      if (formatBasePositionAmount(position) === 'Unavailable') return false
      const pool = position.pool.trim()
      if (pools.has(pool)) return false
      pools.add(pool)
    }
    return true
  })()
  const baseUnavailable = hasBaseHistory && basePlan?.available !== true
  const baseDataUnavailable = hasBaseHistory && !basePositionSetValid
  const baseUnavailableReason = baseUnavailable
    ? basePlan?.unavailableReason
    : baseDataUnavailable
      ? 'Base position data could not be verified. Withdrawal is disabled until every position is read again.'
      : null
  const effectiveMode = mode === 'base' && baseUnavailable ? 'full' : mode

  const fullPlan = useMemo(
    () =>
      discovery && account ? planFullExit({ discovery, position: { agents }, account }) : null,
    // Fresh derivation per open/agents/discovery/account change only -- never re-derived from
    // amountInput/mode (Stellar UI-only state) so switching tabs can't change WHICH agents a full
    // exit targets.
    [discovery, account, agents]
  )

  // planPartialExit's own docstring: `agent` must carry scopeReadStatus/revoked/expiry "merged in
  // from discovery" -- readOwnerMoney.js's row (what `agents` carries) and ownerDiscovery.js's row
  // (what `discovery` carries) are two separate reads the real app keeps apart, so this dialog does
  // the merge itself rather than assume a caller already flattened them onto one object.
  const discoveryByAddress = useMemo(
    () => new Map((discovery?.agents ?? []).map((row) => [row.address, row])),
    [discovery]
  )
  const chosenAgentRaw = agents.find((a) => a.address === chosenAddress) ?? null
  const chosenAgent = chosenAgentRaw
    ? { ...chosenAgentRaw, ...(discoveryByAddress.get(chosenAgentRaw.address) ?? {}) }
    : null
  const availableAmount = chosenAgent ? stellarVaultAvailable(chosenAgent) : null
  const canonicalAvailable = canonicalAmount(availableAmount)
  const decimals = canonicalAvailable?.decimals ?? 7
  const exactAvailableUnits = (() => {
    if (!canonicalAvailable) return null
    try {
      return BigInt(canonicalAvailable.units)
    } catch {
      return null
    }
  })()
  const parsedAmount =
    chosenAgent && canonicalAvailable
      ? parseAssetUnits(amountInput, decimals, {
          ...(exactAvailableUnits != null ? { availableUnits: exactAvailableUnits } : {}),
        })
      : null

  const partialPlan =
    chosenAgent && parsedAmount?.ok && account
      ? planPartialExit({
          agent: chosenAgent,
          amount: {
            token: canonicalAvailable.token,
            units: parsedAmount.units.toString(),
            decimals,
          },
          account,
        })
      : null

  const closeIfSafe = () => {
    if (!pending) onClose?.()
  }

  // Item 4 (rejection checklist): a total must never look complete when it silently skipped an
  // unread agent. Every target's amount must be present and parse cleanly -- one missing/corrupt
  // read demotes the WHOLE total to "Unavailable" rather than quietly under-counting it.
  const targetRows = fullPlan?.targets?.length
    ? fullPlan.targets.map((t) => agents.find((a) => a.address === t.address))
    : []
  // Fix loop 1 (I1): this must be a PARSE check, not a null check -- `row?.amount?.units != null`
  // let a present-but-unparseable units string (e.g. a corrupt read) through the gate, where the
  // old reducer's own try/catch then silently dropped it from the sum. `BigInt(...)` throws on
  // null/undefined/unparseable alike, so attempting the real parse here is the only check that
  // actually matches what the reducer below needs to succeed.
  // Fix loop 2 (M6): `BigInt('')` returns `0n` rather than throwing, so a blank units string
  // passed the parse attempt above and silently contributed 0 to the total -- a leg with an
  // unknown balance rendered as a known zero. Reject blank/whitespace-only strings before
  // attempting the parse, closing the one hazard shape a pure try/catch around BigInt cannot see.
  const allAmountsKnown =
    targetRows.length > 0 &&
    targetRows.every((row) => {
      const normalized = canonicalAmount(row?.amount)
      if (!normalized || !normalized.units.trim() || !sourceProofIsCurrent(row)) return false
      try {
        return BigInt(normalized.units) >= 0n
      } catch {
        return false
      }
    })
  // A full exit is one canonical asset total. Rows disagreeing on token or decimals are themselves
  // proof failure, even when every individual units string parses cleanly.
  const normalizedTargetAmounts = allAmountsKnown
    ? targetRows.map((row) => canonicalAmount(row.amount))
    : []
  const firstTargetAmount = normalizedTargetAmounts[0]
  const knownDecimals =
    firstTargetAmount &&
    normalizedTargetAmounts.every(({ decimals }) => decimals === firstTargetAmount.decimals)
      ? firstTargetAmount.decimals
      : null
  const knownToken =
    firstTargetAmount &&
    normalizedTargetAmounts.every(({ token }) => token === firstTargetAmount.token)
      ? firstTargetAmount.token
      : null
  const knownTotal =
    allAmountsKnown && Number.isFinite(knownDecimals) && knownToken
      ? normalizedTargetAmounts.reduce((sum, amount) => sum + BigInt(amount.units), 0n)
      : null
  const fullExitReady = Boolean(fullPlan?.ok && knownTotal != null)

  return (
    <Dialog
      // my-money.css's dialog block (owner decisions #26/#27) is keyed off this class, NOT off a
      // route ancestor -- app.jsx renders this dialog as a sibling of <MyMoneyRoute>, so an
      // ancestor scope never reaches it. See my-money.css's own `.pc-money-dialog` comment.
      className="pc-money-dialog"
      open={open}
      title="Withdraw"
      description="Review exactly what this withdraws before you confirm. Nothing moves until you do."
      onClose={closeIfSafe}
      actions={
        <>
          <button
            type="button"
            className="pc-button pc-button--secondary"
            onClick={closeIfSafe}
            disabled={pending}
          >
            Cancel
          </button>
          {effectiveMode === 'full' && (
            <button
              type="button"
              className="pc-button pc-button--primary"
              disabled={pending || !fullExitReady || typeof onConfirmFull !== 'function'}
              onClick={() => onConfirmFull?.(fullPlan)}
            >
              {pending ? 'Withdrawing...' : fullPlan?.label || 'Exit all'}
            </button>
          )}
          {effectiveMode === 'partial' && partialPlan?.mode === 'fallback-full-exit' && (
            <button
              type="button"
              className="pc-button pc-button--primary"
              disabled={pending || !fullExitReady || typeof onConfirmFull !== 'function'}
              onClick={() => onConfirmFull?.(fullPlan)}
            >
              {pending ? 'Withdrawing...' : 'Use full exit instead'}
            </button>
          )}
          {effectiveMode === 'partial' && partialPlan?.ok && partialPlan.mode === 'partial' && (
            <button
              type="button"
              className="pc-button pc-button--primary"
              disabled={pending || typeof onConfirmPartial !== 'function'}
              onClick={() => onConfirmPartial?.(partialPlan)}
            >
              {pending ? 'Withdrawing...' : 'Withdraw this amount'}
            </button>
          )}
          {effectiveMode === 'base' && (
            <button
              type="button"
              className="pc-button pc-button--danger"
              disabled={
                pending ||
                !basePositionSetValid ||
                basePlan?.available !== true ||
                typeof onConfirmBase !== 'function'
              }
              onClick={() => onConfirmBase?.()}
            >
              {pending ? 'Withdrawing...' : 'Withdraw everything from Base'}
            </button>
          )}
        </>
      }
    >
      <div role="tablist" aria-label="Withdraw mode">
        <button
          type="button"
          role="tab"
          id="withdraw-tab-full"
          aria-controls="withdraw-panel-full"
          aria-selected={effectiveMode === 'full'}
          disabled={pending}
          onClick={() => setMode('full')}
        >
          Full exit
        </button>
        <button
          type="button"
          role="tab"
          id="withdraw-tab-partial"
          aria-controls="withdraw-panel-partial"
          aria-selected={effectiveMode === 'partial'}
          disabled={pending}
          onClick={() => setMode('partial')}
        >
          Partial (one agent)
        </button>
        {hasBaseHistory && (
          <button
            type="button"
            role="tab"
            id="withdraw-tab-base"
            aria-controls="withdraw-panel-base"
            aria-selected={effectiveMode === 'base'}
            aria-describedby={baseUnavailableReason ? 'withdraw-base-unavailable' : undefined}
            disabled={pending || baseUnavailable}
            onClick={() => {
              if (!baseUnavailable) setMode('base')
            }}
          >
            Base full unwind
          </button>
        )}
      </div>

      {baseUnavailableReason && (
        <p id="withdraw-base-unavailable" role="status">
          {safeMoneyCopy(baseUnavailableReason)}
        </p>
      )}

      {effectiveMode === 'full' && (
        <div
          id="withdraw-panel-full"
          role="tabpanel"
          aria-labelledby="withdraw-tab-full"
          hidden={effectiveMode !== 'full'}
        >
          {!fullPlan && (
            <p>Full exit details will be available once agent discovery finishes loading.</p>
          )}
          {fullPlan && !fullPlan.ok && <p>{safeMoneyCopy(fullPlan.limitation)}</p>}
          {fullPlan?.ok && (
            <>
              <p>{safeMoneyCopy(feeModelCopy(fullPlan.model))}</p>
              <p>{safeMoneyCopy(confirmationsCopy(fullPlan.expectedConfirmations))}</p>
              {fullPlan.limitation && <p>{safeMoneyCopy(fullPlan.limitation)}</p>}
              <p>
                Known amount across every target agent:{' '}
                {knownTotal != null
                  ? `${unitsToDisplay(knownTotal.toString(), knownDecimals)} ${knownToken}`
                  : 'Unavailable'}
                . Sent to {shortAddr(account?.address)}.
              </p>
              <p>
                Revoke/stop access is not withdrawal. It only stops future access; use withdraw to
                return money.
              </p>
              <ul aria-label="Agents in this exit">
                {fullPlan.targets.map((t) => (
                  <li key={t.address}>
                    {shortAddr(t.address)}: {targetStateLabel(t.state)}
                  </li>
                ))}
              </ul>
              <p>
                If part of this fails partway, we never assume the rest is done or the position is
                zero. We recheck the real chain balance before calling it complete, and the parts
                that already succeeded stay succeeded.
              </p>
            </>
          )}
          {progress && (
            <p role="status" aria-live="polite">
              Sweeping agent {progress.index + 1} of {progress.total}. Confirm in your wallet.
            </p>
          )}
        </div>
      )}
      {effectiveMode !== 'full' && (
        <div id="withdraw-panel-full" role="tabpanel" aria-labelledby="withdraw-tab-full" hidden />
      )}

      {effectiveMode === 'partial' && (
        <div
          id="withdraw-panel-partial"
          role="tabpanel"
          aria-labelledby="withdraw-tab-partial"
          hidden={effectiveMode !== 'partial'}
        >
          <p>Withdraw an exact amount from one agent. The rest keeps farming.</p>
          <div role="radiogroup" aria-label="Choose agent">
            {agents.length === 0 && <p>No agents available for partial withdraw.</p>}
            {agents.map((agent, i) => {
              const avail = stellarVaultAvailable(agent)
              const canonicalAvail = canonicalAmount(avail)
              const display = canonicalAvail
                ? unitsToDisplay(canonicalAvail.units, canonicalAvail.decimals)
                : null
              return (
                <label key={agent.address}>
                  <input
                    type="radio"
                    name="withdraw-dialog-agent"
                    disabled={pending}
                    checked={chosenAddress === agent.address}
                    onChange={() => {
                      setChosenAddress(agent.address)
                      setAmountInput('')
                    }}
                  />
                  {shortAddr(agent.address)} (agent {i + 1}):{' '}
                  {display != null ? `${display} ${canonicalAvail.token} available` : 'Unavailable'}
                </label>
              )
            })}
          </div>

          {chosenAgent && (
            <div>
              <label htmlFor="withdraw-dialog-amount">Amount</label>
              <input
                id="withdraw-dialog-amount"
                type="text"
                inputMode="decimal"
                disabled={pending}
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
              />
              {account && <p>{safeMoneyCopy(feeModelCopy(account.kind))}</p>}
              <p>Sent to {shortAddr(account?.address)}.</p>
              {inputReasonMessage(parsedAmount, decimals, availableAmount) && (
                <p>{inputReasonMessage(parsedAmount, decimals, availableAmount)}</p>
              )}
              {partialPlan && !partialPlan.ok && <p>{partialReasonMessage(partialPlan)}</p>}
              {partialPlan?.mode === 'fallback-full-exit' && (
                <p>{safeMoneyCopy(partialPlan.message)}</p>
              )}
              {partialPlan?.ok && partialPlan.mode === 'partial' && (
                <p>
                  You receive {amountLine(partialPlan.amount)} from{' '}
                  {shortAddr(partialPlan.agentAddress)}. The remainder stays farming.
                </p>
              )}
              <p>
                If this fails partway through, no amount is assumed withdrawn until the chain
                confirms it.
              </p>
            </div>
          )}
        </div>
      )}
      {effectiveMode !== 'partial' && (
        <div
          id="withdraw-panel-partial"
          role="tabpanel"
          aria-labelledby="withdraw-tab-partial"
          hidden
        />
      )}

      {effectiveMode === 'base' && (
        <div
          id="withdraw-panel-base"
          role="tabpanel"
          aria-labelledby="withdraw-tab-base"
          hidden={effectiveMode !== 'base'}
        >
          <p>
            This exits every known Base position in one signature. A partial Base withdrawal is not
            available yet.
          </p>
          <ul aria-label="Known Base positions">
            {basePositions.map((p, index) => (
              <li key={`${p?.pool || 'base-position'}-${index}`}>
                {p?.poolName || shortAddr(p?.pool)}: {formatBasePositionAmount(p)}
              </li>
            ))}
          </ul>
          <p>
            The owner can disable a pool for new deposits after you deposited. This exit uses the
            router's known-pool record, so a disabled pool remains sweepable. Disabling new deposits
            does not strand or silently zero the position.
          </p>
          <VenueTruth kind="base-proxy" />
          <NetworkRoute
            context={{
              sourceNetworkId: 'base-sepolia',
              destinationNetworkId: 'stellar-testnet',
              custodyNetworkId: 'base-sepolia',
              transitState: 'none',
            }}
            compact
          />
          <p>
            Base network fee sponsored by relay. This does not confirm that money moved until
            receipt and reconciliation evidence arrive.
          </p>
        </div>
      )}
      {hasBaseHistory && effectiveMode !== 'base' && (
        <div id="withdraw-panel-base" role="tabpanel" aria-labelledby="withdraw-tab-base" hidden />
      )}
    </Dialog>
  )
}
