// frontend/src/components/money/RecoveryPanel.jsx
// My Money Task 12 (Pocket Crew redesign, Wave 5). "Where is my money, and what (if anything) can I
// do about it right now" -- a Foundation Dialog (Primitives.jsx) that never guesses a location and
// never invites a blind retry of a transaction that may already have landed. Pure component tree;
// the caller (Task 13) wires the recovery/retry callbacks to the real chain calls.
//
// THREE independent inputs, checked in this priority order (most urgent/dangerous first):
//
//   1. `submission` -- an owner ACTION's own outcome (money/ownerActions.js's ownerActionOutcome:
//      'unknown' or 'not-submitted'). We do not know if it landed. Brief: "submission-unknown
//      displays explorer/status reconciliation before resubmission. No resubmit control exists
//      until the caller proves `reconciled === 'not-landed'`; only then does "Submit again" appear.
//      A blind resubmission here risks moving money twice.
//
//   2. `strandedBridge` -- read-only pass-through of the EXACT stranded-funds payload
//      frontend/src/baseLeg.js:313 emits on a pull-ok/burn-fails Base-leg failure
//      (`{ pulled: true, bridgeAgentAddress }`, alongside `stage: 'burn'`). This is NOT sourced
//      from Withdraw.jsx or withdrawBatch.js (both off-limits/read-only for this task) -- it is the
//      SAME evidence baseLeg.js's own header comment calls "stranded, recoverable via owner sweep":
//      the money left the owner but never crossed chains, so it is sitting at the bridge agent's
//      Stellar balance (custody.js's 'agent' location), not lost and not yet on Base.
//
//   3. `location` -- custody.js's own fixed vocabulary ('stellar-vault'|'agent'|'in-transit'|
//      'base-proxy'|'owner'|'unknown'), reused verbatim rather than inventing a second one, so this
//      panel can never describe the same money differently than PositionList/AgentTeam do.
import { Dialog, MoneyFigure, StatusNotice, VenueTruth } from '../pocket/Primitives.jsx'
import { assertStellarStrKey } from '../../base/hookData.js'

function shortAddr(address) {
  return typeof address === 'string' && address.length > 12
    ? `${address.slice(0, 4)}…${address.slice(-4)}`
    : (address ?? 'Unavailable')
}

// Recovery can target only a deployed Stellar agent account. G-addresses are contracts, not
// agent identities; accepting them here would expose a full-exit action for the wrong principal.
const STELLAR_AGENT_ACCOUNT = /^C[A-Z2-7]{55}$/

function verifiedStellarAccount(address) {
  if (typeof address !== 'string' || !STELLAR_AGENT_ACCOUNT.test(address)) return false
  try {
    assertStellarStrKey(address)
    return true
  } catch {
    return false
  }
}

function canonicalAmount(amount) {
  if (!amount || typeof amount !== 'object' || Array.isArray(amount)) return null
  const token = typeof amount.token === 'string' && amount.token.trim() ? amount.token : null
  const decimals = amount.decimals
  if (!token || !Number.isInteger(decimals) || decimals < 0 || decimals > 38) return null
  const units = typeof amount.units === 'bigint' ? amount.units.toString() : amount.units
  if (typeof units !== 'string' || !/^\d+$/.test(units)) return null
  return { token, units, decimals }
}

function explorerAccountUrl(address) {
  return `https://stellar.expert/explorer/testnet/account/${address}`
}

function explorerTxUrl(hash) {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`
}

function isKnownPositive(amount) {
  const normalized = canonicalAmount(amount)
  if (normalized == null) return false
  try {
    return BigInt(normalized.units) > 0n
  } catch {
    return false
  }
}

// custody.js's location vocabulary spelled out honestly. Never a guess beyond what the location
// value itself asserts -- 'unknown' gets the same "can't confirm" treatment as a missing location.
const LOCATION_COPY = {
  'stellar-vault': 'Still in the vault. No action is needed.',
  agent: "Sitting at this agent's Stellar balance, not yet deposited into the vault.",
  'in-transit': 'Bridging between chains right now. It is not lost. Check back shortly.',
  'base-proxy': 'Settled on Base custody. Recoverable with a full Base withdrawal.',
  owner: 'Already back in your wallet. There is nothing left to recover.',
}

function AmountLine({ amount }) {
  const normalized = canonicalAmount(amount)
  if (!isKnownPositive(normalized)) return null
  return <MoneyFigure state="current" amount={normalized} />
}

export function RecoveryPanel({
  open,
  onClose,
  location = 'unknown',
  amount = null,
  agentAddress = null,
  strandedBridge = null,
  submission = null,
  reconciled = null, // null (not yet checked) | 'not-landed' | 'landed'
  pending = false,
  onRecoverViaFullExit,
  onGoToBaseWithdraw,
  onCheckStatus,
  onRetry,
  sourceFact = null,
}) {
  const closeIfSafe = () => {
    if (!pending) onClose?.()
  }

  const showSubmission =
    submission && (submission.outcome === 'unknown' || submission.outcome === 'not-submitted')
  const showStrandedBridge =
    !showSubmission && strandedBridge?.pulled === true && strandedBridge.bridgeAgentAddress
  const showLocation = !showSubmission && !showStrandedBridge
  const verifiedAgentAddress = verifiedStellarAccount(agentAddress)
  const verifiedBridgeAddress = verifiedStellarAccount(strandedBridge?.bridgeAgentAddress)

  const explorerHref =
    submission?.explorerUrl || (submission?.hash ? explorerTxUrl(submission.hash) : null)
  const retryEnabled = reconciled === 'not-landed' && typeof onRetry === 'function'

  return (
    <Dialog
      // See WithdrawDialog.jsx / my-money.css: the money dialog scope travels on this class
      // because app.jsx mounts this dialog beside <MyMoneyRoute>, not inside it.
      className="pc-money-dialog"
      open={open}
      title="Recovery status"
      description="Where your money actually is right now. What you can safely do is shown below."
      onClose={closeIfSafe}
      actions={
        <>
          <button
            type="button"
            className="pc-button pc-button--secondary"
            onClick={closeIfSafe}
            disabled={pending}
          >
            Close
          </button>
          {showSubmission && typeof onCheckStatus === 'function' && (
            <button
              type="button"
              className="pc-button pc-button--secondary"
              disabled={pending}
              onClick={() => onCheckStatus?.(submission)}
            >
              Check status
            </button>
          )}
          {showSubmission && retryEnabled && (
            <button
              type="button"
              className="pc-button pc-button--primary"
              disabled={pending}
              onClick={() => onRetry?.(submission)}
            >
              Submit again
            </button>
          )}
          {showStrandedBridge &&
            verifiedBridgeAddress &&
            typeof onRecoverViaFullExit === 'function' && (
              <button
                type="button"
                className="pc-button pc-button--primary"
                disabled={pending}
                onClick={() => onRecoverViaFullExit?.(strandedBridge.bridgeAgentAddress)}
              >
                Recover via full exit
              </button>
            )}
          {showLocation &&
            location === 'agent' &&
            verifiedAgentAddress &&
            typeof onRecoverViaFullExit === 'function' && (
              <button
                type="button"
                className="pc-button pc-button--primary"
                disabled={pending}
                onClick={() => onRecoverViaFullExit?.(agentAddress)}
              >
                Recover via full exit
              </button>
            )}
          {showLocation &&
            location === 'base-proxy' &&
            typeof onGoToBaseWithdraw === 'function' && (
              <button
                type="button"
                className="pc-button pc-button--primary"
                disabled={pending}
                onClick={() => onGoToBaseWithdraw?.()}
              >
                Go to Base withdraw
              </button>
            )}
        </>
      }
    >
      {showSubmission && (
        <>
          <StatusNotice state="warning" title="We could not confirm whether this went through">
            <p>
              The submission result is unavailable. We will not repeat the action until a fresh
              status read proves it did not land.
            </p>
          </StatusNotice>
          {explorerHref && (
            <p>
              <a href={explorerHref} target="_blank" rel="noreferrer">
                Check this transaction on the explorer
              </a>
            </p>
          )}
          <p>
            {reconciled == null &&
              "We haven't reconciled this against the chain yet. Submit again stays unavailable until we do."}
            {reconciled === 'landed' &&
              'This already landed on-chain. Submitting again could duplicate it, so Submit again stays unavailable.'}
            {reconciled === 'not-landed' &&
              'We rechecked the chain and this never landed. Submit again is now safe.'}
          </p>
        </>
      )}

      {showStrandedBridge && (
        <>
          <StatusNotice state="warning" title="Funds are stuck at the Base bridge agent">
            <p>
              The transfer to Base did not complete, but the money never left Stellar. It moved from
              your wallet into the bridge agent and stopped there. It is not lost, and it has not
              crossed chains.
            </p>
          </StatusNotice>
          <p>
            Bridge agent:{' '}
            {verifiedBridgeAddress ? (
              <a
                href={explorerAccountUrl(strandedBridge.bridgeAgentAddress)}
                target="_blank"
                rel="noreferrer"
              >
                {shortAddr(strandedBridge.bridgeAgentAddress)}
              </a>
            ) : (
              'Agent identity unavailable'
            )}
          </p>
        </>
      )}

      {showLocation && (
        <>
          <p>
            {LOCATION_COPY[location] ||
              "We can't confirm exactly where this is right now. Try again shortly."}
          </p>
          {location === 'base-proxy' && <VenueTruth kind="base-proxy" />}
          {location === 'stellar-vault' && sourceFact && (
            <VenueTruth kind="stellar-live" fact={sourceFact} />
          )}
          <AmountLine amount={amount} />
          {agentAddress && verifiedAgentAddress && (
            <p>
              Agent:{' '}
              <a href={explorerAccountUrl(agentAddress)} target="_blank" rel="noreferrer">
                {shortAddr(agentAddress)}
              </a>
            </p>
          )}
          {location === 'agent' && !verifiedAgentAddress && (
            <StatusNotice state="warning" title="Agent identity unavailable">
              <p>We cannot verify the agent identity, so recovery is unavailable.</p>
            </StatusNotice>
          )}
        </>
      )}
    </Dialog>
  )
}
