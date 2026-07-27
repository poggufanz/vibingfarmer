// frontend/src/components/strategy/ProtectStage.jsx
// Strategy Task 11 (Pocket Crew redesign, Wave 5). Protect is where the user actually authorizes
// the run: either a fresh `funding_router.grant` (one REAL wallet signature) or a revalidated
// reuse of an already-proven permission (zero signatures). This component never fakes any part of
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
import { NetworkBadge, NetworkRoute } from '../pocket/NetworkIdentity.jsx'
import { AgentMark } from '../pocket/AgentMark.jsx'
import { PermissionPhaseError } from '../../strategy/permissionError.js'
import { toPermissionDecisionView } from '../../strategy/reusePreflight.js'
import { maxAtRisk } from '../../strategy/permissionScope.js'
import { SOROBAN_TOKEN_ADDRESS } from '../../stellar/config.js'
import { STELLAR_USDC_SAC } from '../../stellar/cctpBurn.js'

const DEFAULT_WALLETS = ['VF Wallet', 'Freighter', 'xBull', 'Albedo']

// Wave 6 carry (Strategy Tasks 11/13): relocated from the now-deleted GrantPanel.jsx (a demoted
// legacy card whose default export became dead once app.jsx's production /strategy route stopped
// rendering it in Strategy Task 13 -- this was its only remaining live consumer).
// ~5s per ledger on Soroban testnet; labels are what the user reasons about.
export const DURATION_PRESETS = [
  { id: '1h', label: '1 hour', seconds: 3600 },
  { id: '24h', label: '24 hours', seconds: 86400 },
  { id: '7d', label: '7 days', seconds: 604800 },
]

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

// Same source network context PlanStage.jsx builds for its own bridge row -- not exported there,
// so re-declared here identically (PlanStage.jsx is a sibling surface, not a shared module).
const BRIDGE_NETWORK_CONTEXT = Object.freeze({
  hostNetworkId: 'stellar-testnet',
  sourceNetworkId: 'stellar-testnet',
  destinationNetworkId: 'base-sepolia',
  custodyNetworkId: 'stellar-testnet',
  transitState: 'source',
})

// Same boundary math as planModel.js's private unitsToDecimal -- re-declared here for the same
// reason PlanStage.jsx does (that helper isn't exported and planModel.js is out of this task's
// file list). Display-only, never touches anything that becomes a grant/burn unit.
function unitsToDisplay(units, decimals) {
  return Number(BigInt(units)) / 10 ** decimals
}

function formatExpiry(expirySeconds) {
  return Number.isFinite(expirySeconds) ? new Date(expirySeconds * 1000).toISOString() : 'Unknown'
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
function reuseIsUsable(decision) {
  if (!decision || decision.mode !== 'reuse') return false
  if (!Array.isArray(decision.agents) || decision.agents.length === 0) return false
  return decision.agents.every((a) => Number.isFinite(a.scopeExpiry) && a.scopeExpiry > 0)
}

export function ProtectStage({
  plan,
  owner = null,
  availableWallets = DEFAULT_WALLETS,
  baseMandateView = null,
  onConnectWallet,
  onRetryPreflight,
  onRequestGrant,
  onConfirmReuse,
  onEditPlan,
}) {
  const [durationId, setDurationId] = useState('24h')
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
  const usableReuse = reuseIsUsable(decision)

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

  async function handleCheckPermission() {
    setPhase('checking')
    setDecision(null)
    setFailureKind(null)
    setFailureMessage(null)
    try {
      const raw = await onRetryPreflight({ durationSeconds: preset.seconds })
      setDecision(toPermissionDecisionView(raw))
      setPhase('review')
    } catch (err) {
      setFailureKind('preflight')
      setFailureMessage(err?.message || 'Could not check your permission. Try again.')
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
      } else {
        // A plain wallet rejection/failure invalidates only the signature attempt, not the
        // permission review itself.
        setFailureKind('wallet')
      }
      setFailureMessage(err?.message || 'The wallet request did not complete.')
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

  return (
    <div className="pc-protect-stage">
      <div className="pc-protect-boundary">
        <div className="pc-dominant pc-dominant--decision pc-strategy-decision">
          <h1 className="pc-strategy-question">Protect this run</h1>

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
              <button
                type="button"
                className="pc-button pc-button--primary"
                onClick={handleCheckPermission}
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

          {decision && decision.mode === 'fresh' && (
            <div>
              <p>
                This needs {decision.confirmationCount} wallet confirmation
                {decision.confirmationCount === 1 ? '' : 's'}.
              </p>
              <MoneyFigure
                state="current"
                value={unitsToDisplay(plan.amount.units, plan.amount.decimals)}
                currency={plan.amount.token}
              />
              <p>Valid for {preset.label} once confirmed.</p>
            </div>
          )}

          {decision && decision.mode === 'reuse' && usableReuse && (
            <p>0 wallet confirmations needed -- this permission already covers this run.</p>
          )}

          {decision && decision.mode === 'reuse' && !usableReuse && (
            <StatusNotice state="warning" title="Could not confirm your existing permission">
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

          {phase === 'review' && decision && decision.mode === 'fresh' && (
            <>
              <button
                type="button"
                className="pc-button pc-button--primary"
                onClick={handleAuthorize}
              >
                Authorize with wallet
              </button>
              <button type="button" className="pc-button pc-button--secondary" onClick={handleEdit}>
                Edit plan
              </button>
            </>
          )}

          {phase === 'review' && decision && decision.mode === 'reuse' && usableReuse && (
            <>
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
            </>
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
            <StatusNotice state="danger" title="Nothing moved">
              <p>{failureMessage}</p>
              <button type="button" className="pc-button pc-button--primary" onClick={handleRetry}>
                Retry
              </button>
              <button type="button" className="pc-button pc-button--secondary" onClick={handleEdit}>
                Edit plan
              </button>
            </StatusNotice>
          )}
        </div>

        {/* Rice (`--pc-owned`) is reserved for user-owned or CONFIRMED money (checklist item 4) --
            a reuse decision's headroom is an already-proven, on-chain-verified fact, so it alone
            earns this surface. A fresh decision's "headroom after granting"/"worst case" figures
            are still prospective (true only once the grant confirms), so they render in the
            neutral `.pc-support` role below instead, never in Rice. */}
        {decision && decision.mode === 'reuse' && usableReuse && (
          <div className="pc-protect-limit">
            {/* Minor (review finding): a point-in-time on-chain read had no freshness stamp
                alongside its scope `Expires` -- one line, decision-level (checkedAt is one
                timestamp for the whole preflight, not per-agent), makes the Rice claim
                self-evidently sound. */}
            <p>As of {formatExpiry(decision.checkedAt)}</p>
            {decision.agents.map((a) => (
              <div key={a.allocationId}>
                <p>{a.agentAddress}</p>
                <p>
                  Headroom: {unitsToDisplay(a.headroom.units, a.headroom.decimals)}{' '}
                  {tokenSymbol(a.headroom.token)}
                </p>
                <p>Expires {formatExpiry(a.scopeExpiry)}</p>
              </div>
            ))}
          </div>
        )}

        {decision && decision.mode === 'fresh' && (
          <div className="pc-support">
            <div className="pc-support-content">
              {decision.reviewedBudgets.map((b) => (
                <p key={b.token}>
                  Headroom after granting: {unitsToDisplay(b.units, b.decimals)}{' '}
                  {tokenSymbol(b.token)}
                </p>
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
                    {unitsToDisplay(exposure.toString(), r.cap.decimals)} {tokenSymbol(r.cap.token)}
                  </p>
                )
              })}
              <p>Each agent signs with its own separate session key.</p>
              <p>Each agent can be stopped on its own, independent of the others.</p>
              <p>Gas is sponsored -- you pay no XLM for this run.</p>
            </div>
          </div>
        )}
      </div>

      {decision && decision.mode === 'fresh' && (
        <ul className="pc-agent-lanes">
          {plan.agents.map((planAgent, i) => {
            const reviewed = decision.reviewedAgentInits.find(
              (r) => r.allocationId === planAgent.allocationId
            )
            const isBridge = planAgent.kind === 'bridge'
            return (
              <li
                key={planAgent.allocationId}
                className="pc-agent-lane"
                data-agent-kind={planAgent.kind}
              >
                <AgentMark
                  identity={planAgent.allocationId}
                  state="planned"
                  label={isBridge ? 'B' : String(i + 1)}
                />
                <div>
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
                        Cap per period: {unitsToDisplay(reviewed.cap.units, reviewed.cap.decimals)}{' '}
                        {tokenSymbol(reviewed.cap.token)}
                      </p>
                      <p>Resets every {periodLabel(reviewed.periodSeconds)}</p>
                      <p>Expires {formatExpiry(reviewed.expiry)}</p>
                      <TechnicalDetails summary={`Agent ${i + 1} technical details`}>
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
            <VenueTruth kind="base-proxy" />
            <p>
              {baseMandateView?.technicalDisclosure ||
                'Base mandate details are unavailable right now.'}
            </p>
            {baseMandateView?.renewalCopy && <p>{baseMandateView.renewalCopy}</p>}
            {baseMandateView?.revokeCopy && <p>{baseMandateView.revokeCopy}</p>}
            {baseMandateView?.outageCopy && <p>{baseMandateView.outageCopy}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
