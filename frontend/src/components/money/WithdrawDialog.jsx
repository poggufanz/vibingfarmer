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
// Three MUTUALLY EXCLUSIVE tabs (full / partial / base, Base only offered when `basePlan.available`)
// rather than an always-appended Base section -- every tab therefore has exactly ONE primary action
// in the shared Dialog `actions` footer, Cancel always rendered right alongside it (brief: "Cancel
// before/alongside a non-Harvest destructive action").
//
// Base blocker note (verified cleared by the task owner, NOT by this file): the deployed
// BaseExitSweeper (0x5451a6dc..., base-contracts/src/BaseExitSweeper.sol:164) calls
// `router.allowedPool(pool)`, matching the live YieldRouter's real selector -- exitAllAndBurn no
// longer reverts. BaseExitSweeper.sol:152-162 documents the remaining, real limitation this file
// must keep surfacing honestly: `allowedPool` is an owner-revocable DEPOSIT allowlist, not a
// permanent exit-eligibility one -- a pool de-listed after a deposit is SKIPPED by the sweep
// (`_eligible`, :163-171), not zeroed, and its balance stays on Base, recoverable by the owner
// later. The preview below can only ever promise the KNOWN target set it was given (`basePlan.
// positions`) plus this honest caveat -- it can never promise a complete sweep, because pool
// eligibility is revocable in real time and this component makes no chain read of its own.
import { useMemo, useState } from 'react'
import { Dialog } from '../pocket/Primitives.jsx'
import {
  planFullExit,
  planPartialExit,
  confirmationsCopy,
  feeModelCopy,
  targetStateLabel,
} from '../../money/ownerActions.js'
import { formatAssetUnits, parseAssetUnits } from '../../money/assetUnits.js'

// Same convention as AgentTeam.jsx/PositionList.jsx/StrategyReceipt.jsx: each sibling surface
// keeps its own tiny copy of these display-only helpers rather than sharing a module across
// unrelated route trees.
function shortAddr(address) {
  return typeof address === 'string' && address.length > 12
    ? `${address.slice(0, 4)}…${address.slice(-4)}`
    : (address ?? '-')
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
  if (!amount?.units) return 'Unavailable'
  const value = unitsToDisplay(amount.units, amount.decimals ?? 7)
  return value == null ? 'Unavailable' : `${value} ${amount.token || 'USDC'}`
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
    return "This agent's vault balance could not be confirmed -- try again, or use full exit."
  if (plan.reason === 'exceeds-max') {
    const max = plan.maxAmount
      ? unitsToDisplay(plan.maxAmount.units, plan.maxAmount.decimals)
      : null
    const token = plan.maxAmount?.token || 'USDC'
    return `Exceeds this agent's confirmed balance${max != null ? ` (${max} ${token})` : ''}.`
  }
  return plan.message || null
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
  const effectiveMode = mode === 'base' && !basePlan?.available ? 'full' : mode

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
  const decimals = availableAmount?.decimals ?? 7
  const exactAvailableUnits = (() => {
    if (availableAmount?.units == null) return null
    try {
      return BigInt(availableAmount.units)
    } catch {
      return null
    }
  })()
  const parsedAmount = chosenAgent
    ? parseAssetUnits(amountInput, decimals, {
        ...(exactAvailableUnits != null ? { availableUnits: exactAvailableUnits } : {}),
      })
    : null

  const partialPlan =
    chosenAgent && parsedAmount?.ok && account
      ? planPartialExit({
          agent: chosenAgent,
          amount: {
            token: availableAmount?.token || 'USDC',
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
      const units = row?.amount?.units
      if (typeof units !== 'string' || !units.trim()) return false
      try {
        BigInt(units)
        return true
      } catch {
        return false
      }
    })
  // Fix loop 1 (M2): decimals must be read from the target rows' own amounts, never a hardcoded
  // assumption -- correct for every 7-decimal SAC today, silently wrong (by orders of magnitude)
  // the moment a non-SAC token appears. Rows disagreeing on decimals is itself a "can't trust this
  // total" case, same as a missing/unparseable amount -- demote to null rather than guess.
  const knownDecimals = allAmountsKnown
    ? targetRows.reduce((decimals, row) => {
        const d = row.amount.decimals ?? 7
        return decimals == null || decimals === d ? d : NaN
      }, null)
    : null
  const knownTotal =
    allAmountsKnown && Number.isFinite(knownDecimals)
      ? targetRows.reduce((sum, row) => sum + BigInt(row.amount.units), 0n)
      : null

  return (
    <Dialog
      // my-money.css's dialog block (owner decisions #26/#27) is keyed off this class, NOT off a
      // route ancestor -- app.jsx renders this dialog as a sibling of <MyMoneyRoute>, so an
      // ancestor scope never reaches it. See my-money.css's own `.pc-money-dialog` comment.
      className="pc-money-dialog"
      open={open}
      title="Withdraw"
      description="Review exactly what this withdraws before you confirm -- nothing moves until you do."
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
              disabled={pending || !fullPlan?.ok}
              onClick={() => onConfirmFull?.(fullPlan)}
            >
              {pending ? 'Withdrawing…' : fullPlan?.label || 'Exit all'}
            </button>
          )}
          {effectiveMode === 'partial' && partialPlan?.mode === 'fallback-full-exit' && (
            <button
              type="button"
              className="pc-button pc-button--primary"
              disabled={pending || !fullPlan?.ok}
              onClick={() => onConfirmFull?.(fullPlan)}
            >
              {pending ? 'Withdrawing…' : 'Use full exit instead'}
            </button>
          )}
          {effectiveMode === 'partial' && partialPlan?.ok && partialPlan.mode === 'partial' && (
            <button
              type="button"
              className="pc-button pc-button--primary"
              disabled={pending}
              onClick={() => onConfirmPartial?.(partialPlan)}
            >
              {pending ? 'Withdrawing…' : 'Withdraw this amount'}
            </button>
          )}
          {effectiveMode === 'base' && (
            <button
              type="button"
              className="pc-button pc-button--danger"
              disabled={pending}
              onClick={() => onConfirmBase?.()}
            >
              {pending ? 'Withdrawing…' : 'Withdraw everything from Base'}
            </button>
          )}
        </>
      }
    >
      <div role="tablist" aria-label="Withdraw mode">
        <button
          type="button"
          role="tab"
          aria-selected={effectiveMode === 'full'}
          disabled={pending}
          onClick={() => setMode('full')}
        >
          Full exit
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={effectiveMode === 'partial'}
          disabled={pending}
          onClick={() => setMode('partial')}
        >
          Partial (one agent)
        </button>
        {basePlan?.available && (
          <button
            type="button"
            role="tab"
            aria-selected={effectiveMode === 'base'}
            disabled={pending}
            onClick={() => setMode('base')}
          >
            Base full unwind
          </button>
        )}
      </div>

      {effectiveMode === 'full' && (
        <div>
          {!fullPlan && (
            <p>Full exit details will be available once agent discovery finishes loading.</p>
          )}
          {fullPlan && !fullPlan.ok && <p>{fullPlan.limitation}</p>}
          {fullPlan?.ok && (
            <>
              <p>{feeModelCopy(fullPlan.model)}</p>
              <p>{confirmationsCopy(fullPlan.expectedConfirmations)}</p>
              {fullPlan.limitation && <p>{fullPlan.limitation}</p>}
              <p>
                Known amount across every target agent:{' '}
                {knownTotal != null
                  ? `${unitsToDisplay(knownTotal.toString(), knownDecimals)} USDC`
                  : 'Unavailable'}
                . Sent to {shortAddr(account?.address)}.
              </p>
              <ul aria-label="Agents in this exit">
                {fullPlan.targets.map((t) => (
                  <li key={t.address}>
                    {shortAddr(t.address)} -- {targetStateLabel(t.state)}
                  </li>
                ))}
              </ul>
              <p>
                If part of this fails partway, we never assume the rest is done or the position is
                zero -- we recheck the real chain balance before calling it complete, and the parts
                that already succeeded stay succeeded.
              </p>
            </>
          )}
          {progress && (
            <p role="status" aria-live="polite">
              Sweeping agent {progress.index + 1} of {progress.total}. Confirm in your wallet…
            </p>
          )}
        </div>
      )}

      {effectiveMode === 'partial' && (
        <div>
          <p>Withdraw an exact amount from one agent. The rest keeps farming.</p>
          <div role="radiogroup" aria-label="Choose agent">
            {agents.length === 0 && <p>No agents available for partial withdraw.</p>}
            {agents.map((agent, i) => {
              const avail = stellarVaultAvailable(agent)
              const display = avail ? unitsToDisplay(avail.units, avail.decimals ?? 7) : null
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
                  {shortAddr(agent.address)} (agent {i + 1}) --{' '}
                  {display != null
                    ? `${display} ${avail?.token || 'USDC'} available`
                    : 'Unavailable'}
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
              {account && <p>{feeModelCopy(account.kind)}</p>}
              <p>Sent to {shortAddr(account?.address)}.</p>
              {inputReasonMessage(parsedAmount, decimals, availableAmount) && (
                <p>{inputReasonMessage(parsedAmount, decimals, availableAmount)}</p>
              )}
              {partialPlan && !partialPlan.ok && <p>{partialReasonMessage(partialPlan)}</p>}
              {partialPlan?.mode === 'fallback-full-exit' && <p>{partialPlan.message}</p>}
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

      {effectiveMode === 'base' && (
        <div>
          <p>
            This always exits every known Base position in one signature -- a partial Base
            withdrawal isn't available yet.
          </p>
          <ul aria-label="Known Base positions">
            {(basePlan?.positions || []).map((p) => (
              <li key={p.pool}>
                {p.poolName || shortAddr(p.pool)} --{' '}
                {p.assets != null ? `${(Number(p.assets) / 1e6).toFixed(2)} USDC` : 'Unavailable'}
              </li>
            ))}
          </ul>
          <p>
            A pool's Base allowlist can be revoked by its owner after you deposited into it -- if
            that happens, this sweep SKIPS that pool rather than guessing at it. A skipped pool's
            balance is not lost and is not shown as zero; it stays on Base, untouched, until it is
            eligible again.
          </p>
          <p>One passkey signature. The relay sponsors Base gas -- 0 ETH from you.</p>
        </div>
      )}
    </Dialog>
  )
}
