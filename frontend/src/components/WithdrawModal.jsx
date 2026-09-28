// WithdrawModal.jsx
// Manual withdraw from a single active position. Reuses the app's modal tokens.
import React, { useState, useEffect, useRef } from 'react'
import { withdrawAllFromVault } from '../agents/agentController.js'
import { saveTransaction } from '../history/history.js'
import { loadSettings, t } from '../store/settingsStore.js'
import { toDisplay, toBaseUnits } from '../stellar/format.js'
import { SOROBAN_EXIT_ROUTER_ADDRESS } from '../stellar/config.js'
import {
  partialWithdraw,
  ensureExitSigner,
  readAgentScope,
  planProportionalWithdraw,
  partialWithdrawMulti,
} from '../stellar/partialWithdraw.js'
import { readVaultShares } from '../stellar/agentDeposit.js'
import { readPricePerShare } from '../stellar/vaultReads.js'
import { clearManualExitKey } from '../wallet/exitKey.js'
import { signaturesForSweep, friendlyOwnerActionError } from '../money/ownerActions.js'
import { getActiveAccount } from '../stellar/walletKit.js'
import { sameActiveAccount } from '../stellar/activeAccount.js'
import { venueYield } from '../strategy/venueTruth.js'

const PPS_SCALE = 10_000_000n

// With the exit router deployed the whole position is swept in batches, so the exit costs the same
// single signature the deposit does — until a position is spread over more agents than fit one
// transaction's budget, when it costs one per batch. Unset, it is one per agent. Promising "1
// signature" and then opening three popups is a worse lie than quoting the real number, so quote it.
// My Money Task 13 Part B item 7: the Math.ceil/MAX_AGENTS_PER_SWEEP batching math itself moved to
// ownerActions.js's signaturesForSweep (the SAME formula planFullExit's own expectedConfirmations
// uses) -- this stays local only because it is a deploy-config fact (is the exit router live at
// all), not owner-action vocabulary.
const ONE_SIGNATURE_EXIT = Boolean(SOROBAN_EXIT_ROUTER_ADDRESS)
const signaturesFor = (agentCount) =>
  signaturesForSweep(agentCount, { oneSignatureExit: ONE_SIGNATURE_EXIT })

// The v2 vault exposes no per-deposit timestamp, so "time deposited" is unknown (renders "-").
// Kept as a 0-stub so the modal effect below is unchanged. ponytail: no chain read to wire here.
const readVaultDepositTimestamp = async () => 0

const fmtDur = (secAgo) => {
  if (!secAgo || secAgo <= 0) return '-'
  const d = Math.floor(secAgo / 86400),
    h = Math.floor((secAgo % 86400) / 3600),
    m = Math.floor((secAgo % 3600) / 60)
  if (d > 0) return `${d} day${d === 1 ? '' : 's'} ${h} hour${h === 1 ? '' : 's'}`
  return h > 0 ? `${h} hour${h === 1 ? '' : 's'} ${m} min` : `${m} min`
}

const shortAddr = (addr) => {
  if (!addr || addr.length < 10) return addr || '-'
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`
}

// My Money Task 13 Part B item 7: this used to be a local `friendlyError` -- moved to
// ownerActions.js's friendlyOwnerActionError (MM12's report, concern #5) since WithdrawDialog.jsx
// needed the same raw-error-to-copy mapping and neither file should keep its own copy. Alias kept
// so every call site below stays byte-identical.
const friendlyError = friendlyOwnerActionError

const PCT_CHIPS = [
  { id: '25', label: '25%', frac: 0.25 },
  { id: '50', label: '50%', frac: 0.5 },
  { id: '75', label: '75%', frac: 0.75 },
  { id: 'max', label: 'Max', frac: 1 },
]

const PROP_CHIPS = [
  { id: 'p10', label: '10%', pct: '10' },
  { id: 'p25', label: '25%', pct: '25' },
  { id: 'p50', label: '50%', pct: '50' },
]

export default function WithdrawModal({
  vault,
  balance,
  unclaimedRewards = 0,
  userAddress,
  activeAccount = null,
  agentAddresses = [],
  onClose,
  onSuccess,
}) {
  const { language: lang } = loadSettings()
  const vaultYield = venueYield(vault)
  const evidencedVaultApy = vaultYield.state === 'live' ? vaultYield.apy : null
  const yieldEvidence = vaultYield.state === 'live' ? 'live-venue' : null
  // stellar/ownerAuthorization.js's G/C split: a G keypair signs and pays its own fee directly; a C
  // (VF Wallet/passkey) contract address can never hold or spend XLM, so the relay sponsors the fee
  // instead (submitOwnerAuthorizedTx routes every C action through the relay). Same
  // address-prefix convention developers/walletSign.js:20 already uses to tell the two apart.
  const isSponsoredOwner = userAddress?.startsWith('C')
  const balUsdc = toDisplay(balance)
  const rewardsUsdc = toDisplay(unclaimedRewards)
  const [status, setStatus] = useState('idle') // idle | loading | done
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState(null)
  const [depositedAgoSec, setDepositedAgoSec] = useState(0)
  const [mode, setMode] = useState('full') // 'full' | 'partial' | 'proportional'
  const [agentInfo, setAgentInfo] = useState(null) // [{address, maxUnits, blocked}] | null=loading
  const [chosen, setChosen] = useState(null)
  const [amount, setAmount] = useState('')
  const [propPct, setPropPct] = useState('25')
  const [multiResults, setMultiResults] = useState(null) // {results:[{agentAddress,amountUnits,ok,...}], queued:[...]} | null
  const [multiStep, setMultiStep] = useState(null)
  const [unknownNote, setUnknownNote] = useState(null)
  const confirmRef = useRef(null)
  const actionControllerRef = useRef(null)
  if (!actionControllerRef.current) actionControllerRef.current = new AbortController()
  const actionSignal = actionControllerRef.current.signal
  const isCurrentOwner = () =>
    !actionSignal.aborted &&
    (activeAccount?.version !== 1 || sameActiveAccount(activeAccount, getActiveAccount()))
  const commitIfCurrent = (callback) => {
    if (!isCurrentOwner()) return false
    callback()
    return true
  }

  useEffect(() => {
    const prev = document.activeElement
    confirmRef.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape' && status !== 'loading') onClose()
    }
    window.addEventListener('keydown', onKey)
    readVaultDepositTimestamp(vault.address, userAddress).then((ts) => {
      if (ts > 0) commitIfCurrent(() => setDepositedAgoSec(Math.floor(Date.now() / 1000) - ts))
    })
    return () => {
      actionControllerRef.current?.abort()
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [])
  // Partial + proportional modes both need each agent's withdrawable max (shares *
  // price-per-share) and scope gate. A failed scope read leaves the row selectable — the
  // chain still enforces expiry/revocation either way.
  useEffect(() => {
    if ((mode !== 'partial' && mode !== 'proportional') || agentInfo) return
    let dead = false
    ;(async () => {
      const pps = (await readPricePerShare(vault.address)) ?? PPS_SCALE
      const rows = await Promise.all(
        agentAddresses.map(async (address) => {
          const [shares, scope] = await Promise.all([
            readVaultShares(address, { vault: vault.address }),
            readAgentScope(address),
          ])
          const maxUnits = shares == null ? 0n : (shares * pps) / PPS_SCALE
          const blocked =
            scope != null &&
            (scope.revoked || scope.expiry <= BigInt(Math.floor(Date.now() / 1000)))
          return { address, maxUnits, blocked }
        })
      )
      if (!dead) setAgentInfo(rows)
    })()
    return () => {
      dead = true
    }
  }, [mode])

  // owner_withdraw sweeps an agent's ENTIRE position — there is no partial-amount form of it — and
  // a position is the sum over every agent, so a withdraw is N sweeps of 100%. The old amount input
  // and 25/50/75% buttons never reached the chain: the typed value was passed to a parameter the
  // controller ignores. Showing the real, unsplittable amount beats offering a choice we can't honour.
  const canWithdraw = balUsdc > 0 && agentAddresses.length > 0

  const handleConfirm = async () => {
    if (!canWithdraw || status !== 'idle') return
    if (!isCurrentOwner()) {
      onClose()
      return
    }
    setStatus('loading')
    setError(null)
    setProgress(null)
    try {
      const results = await withdrawAllFromVault(
        vault.address,
        userAddress,
        agentAddresses,
        (next) => commitIfCurrent(() => setProgress(next)),
        { activeAccount, getCurrentActiveAccount: getActiveAccount, signal: actionSignal }
      )
      if (!isCurrentOwner()) return
      const failed = results.filter((r) => !r.ok)

      if (failed.length) {
        // Partial sweep: some USDC moved, some did not, and the per-agent split is not readable
        // from here — so claim no amount rather than a wrong one. Reconcile shows what is left.
        // ponytail: the successful legs get no history row on this branch; add per-agent amounts
        // if the vault ever exposes a per-sweep event to size them from.
        commitIfCurrent(() => {
          setError(
            `Swept ${results.length - failed.length} of ${results.length} agents. ` +
              `${failed.length} failed: ${failed[0].error?.message ?? failed[0].error}`
          )
          setStatus('idle')
          setProgress(null)
          onSuccess(vault.address, '0') // reconcile from chain, but never a false zero
        })
        return
      }

      saveTransaction({
        txHash: results[0].txHash,
        vaultName: vault.name,
        vaultAddress: vault.address,
        protocol: vault.protocol,
        amountUsdc: balUsdc,
        apy: evidencedVaultApy,
        yieldEvidence,
        channel: results[0]?.channel,
        type: 'withdraw',
        network: 'stellar-testnet',
      })
      commitIfCurrent(() => {
        setStatus('done')
        onSuccess(vault.address, balance)
        setTimeout(() => commitIfCurrent(onClose), 700)
      })
    } catch (err) {
      if (err?.code === 'ACTIVE_ACCOUNT_CHANGED' || !isCurrentOwner()) return
      commitIfCurrent(() => {
        setError(friendlyError(err))
        setStatus('idle')
        setProgress(null)
      })
    }
  }

  const chosenRow = agentInfo?.find((a) => a.address === chosen)
  const amountUnits = amount ? BigInt(toBaseUnits(amount)) : 0n
  const canPartial =
    chosenRow && !chosenRow.blocked && amountUnits > 0n && amountUnits <= chosenRow.maxUnits
  const maxDisplay = chosenRow ? toDisplay(chosenRow.maxUnits) : 0
  const overMax = chosenRow && amountUnits > 0n && amountUnits > chosenRow.maxUnits

  const setPct = (frac) => {
    if (!chosenRow || chosenRow.blocked) return
    const max = toDisplay(chosenRow.maxUnits)
    const v = frac >= 1 ? max : Math.floor(max * frac * 100) / 100
    setAmount(String(v))
  }

  const handlePartial = async () => {
    if (!canPartial || status !== 'idle') return
    if (!isCurrentOwner()) {
      onClose()
      return
    }
    setStatus('loading')
    setError(null)
    setUnknownNote(null)
    try {
      await ensureExitSigner({
        owner: userAddress,
        agentAddress: chosen,
        activeAccount,
        getCurrentActiveAccount: getActiveAccount,
        signal: actionSignal,
      })
      const out = await partialWithdraw({
        owner: userAddress,
        agentAddress: chosen,
        amountUnits,
        vault: vault.address,
        activeAccount,
        getCurrentActiveAccount: getActiveAccount,
        signal: actionSignal,
      })
      if (!isCurrentOwner()) return
      saveTransaction({
        txHash: out.transferHash,
        vaultName: vault.name,
        vaultAddress: vault.address,
        protocol: vault.protocol,
        amountUsdc: toDisplay(out.redeemed),
        apy: evidencedVaultApy,
        yieldEvidence,
        channel: out.channel,
        type: 'withdraw',
        network: 'stellar-testnet',
      })
      commitIfCurrent(() => {
        setStatus('done')
        onSuccess(vault.address, out.redeemed.toString())
        setTimeout(() => commitIfCurrent(onClose), 700)
      })
    } catch (err) {
      if (err?.code === 'ACTIVE_ACCOUNT_CHANGED' || !isCurrentOwner()) return
      // A stale exit key (localStorage from a lost registration, or re-registered elsewhere)
      // fails auth on-chain; drop it so the retry re-registers fresh.
      if (/signature|auth/i.test(err?.message || ''))
        clearManualExitKey({ owner: userAddress, agent: chosen })
      commitIfCurrent(() => {
        // Relay-down / lost-submission outcomes carry submission:'unknown': surface that status
        // explicitly with the error's own honest message (it says what was and was not
        // submitted) instead of collapsing it into the generic failure line — and never mark
        // anything received. The confirm button stays enabled: this exact call is the retry.
        if (err?.submission === 'unknown') setUnknownNote(err.message)
        else setError(friendlyError(err))
        setStatus('idle')
      })
    }
  }
  // Proportional multi-agent mode (P1 G7): withdraw X% of EVERY eligible agent's max —
  // client-side composition of the single-agent partialWithdraw per leg (no new contract
  // call). The preview plans from the loaded maxima; each leg still re-reads chain state at
  // submit time, so a retry after an unknown outcome can only move what is actually there
  // (never a double payout: redeem burns shares, so a repeat collapses to an honest error).
  const eligiblePropRows = (agentInfo || []).filter((r) => !r.blocked && r.maxUnits > 0n)
  const pctNum = Number(propPct)
  const pctValid = propPct.trim() !== '' && Number.isFinite(pctNum) && pctNum > 0 && pctNum <= 100
  let propPlan = null
  if (mode === 'proportional' && agentInfo && pctValid && eligiblePropRows.length > 0) {
    try {
      propPlan = planProportionalWithdraw(
        eligiblePropRows.map((r) => ({ address: r.address, maxUnits: r.maxUnits })),
        Math.round(pctNum * 100)
      )
      if (propPlan.legs.length === 0) propPlan = null
    } catch {
      propPlan = null
    }
  }
  const canProportional = propPlan != null && propPlan.legs.length > 0 && status === 'idle'
  const propTotalDisplay = propPlan ? toDisplay(propPlan.totalUnits) : 0

  const mergeMultiResults = (prev, next) => {
    if (!prev) return next
    const byAgent = new Map(prev.results.map((r) => [r.agentAddress, r]))
    next.results.forEach((r) => byAgent.set(r.agentAddress, r))
    const results = [...byAgent.values()]
    return { results, queued: results.filter((r) => !r.ok) }
  }

  const finishMulti = (merged, freshOk) => {
    // History rows only for legs confirmed in THIS run — never for unknown/failed legs, and
    // never twice for legs confirmed by an earlier run.
    freshOk.forEach((r) => {
      saveTransaction({
        txHash: r.transferHash,
        vaultName: vault.name,
        vaultAddress: vault.address,
        protocol: vault.protocol,
        amountUsdc: toDisplay(r.redeemed),
        apy: evidencedVaultApy,
        yieldEvidence,
        channel: r.channel,
        type: 'withdraw',
        network: 'stellar-testnet',
      })
    })
    const confirmedTotal = merged.results
      .filter((r) => r.ok)
      .reduce((sum, r) => sum + BigInt(r.redeemed ?? 0n), 0n)
    const unknownLegs = merged.results.filter((r) => !r.ok && r.error?.submission === 'unknown')
    const failedLegs = merged.results.filter((r) => !r.ok && r.error?.submission !== 'unknown')
    commitIfCurrent(() => {
      setMultiResults(merged)
      // Confirmed failures and unknown outcomes get SEPARATE banners: an unknown leg may or
      // may not have landed, so it must never read as a plain failure — and neither banner
      // ever claims anything was received.
      setError(
        failedLegs.length > 0
          ? `${failedLegs.length} leg(s) failed: ${failedLegs[0].error?.message ?? failedLegs[0].error}`
          : null
      )
      setUnknownNote(
        unknownLegs.length > 0
          ? `${unknownLegs.length} leg(s) have unknown status — they may or may not have landed. ` +
              `Not counted as received; check the explorer, then retry the queue below.`
          : null
      )
      if (merged.queued.length === 0) {
        setStatus('done')
        onSuccess(vault.address, confirmedTotal.toString())
        setTimeout(() => commitIfCurrent(onClose), 700)
      } else {
        setStatus('idle')
        // Reconcile from chain without claiming an amount (same convention as the full-sweep
        // partial-failure branch above) — some legs moved, the split is per-agent.
        onSuccess(vault.address, '0')
      }
    })
  }

  const runMultiLegs = async (legs) => {
    if (status !== 'idle') return null
    if (!isCurrentOwner()) {
      onClose()
      return null
    }
    setStatus('loading')
    setError(null)
    setUnknownNote(null)
    setMultiStep(`Withdrawing from ${legs.length} ${legs.length === 1 ? 'agent' : 'agents'}…`)
    try {
      const out = await partialWithdrawMulti({
        owner: userAddress,
        legs,
        vault: vault.address,
        activeAccount,
        getCurrentActiveAccount: getActiveAccount,
        signal: actionSignal,
      })
      if (!isCurrentOwner()) return null
      return out
    } catch (err) {
      // The composer only throws on a global abort (account switch); per-leg failures arrive
      // inside results. Belt-and-braces: never let anything escape unhandled.
      if (err?.code === 'ACTIVE_ACCOUNT_CHANGED' || !isCurrentOwner()) return null
      commitIfCurrent(() => {
        setError(friendlyError(err))
        setStatus('idle')
      })
      return null
    } finally {
      commitIfCurrent(() => setMultiStep(null))
    }
  }

  const handleProportional = async () => {
    if (!canProportional) return
    const out = await runMultiLegs(propPlan.legs)
    if (!out) return
    finishMulti(
      mergeMultiResults(multiResults, out),
      out.results.filter((r) => r.ok)
    )
  }

  const handleRetryQueued = async () => {
    const queued = multiResults?.queued ?? []
    if (queued.length === 0 || status !== 'idle') return
    const out = await runMultiLegs(
      queued.map((q) => ({ agentAddress: q.agentAddress, amountUnits: q.amountUnits }))
    )
    if (!out) return
    finishMulti(
      mergeMultiResults(multiResults, out),
      out.results.filter((r) => r.ok)
    )
  }

  return (
    <div className="modal-backdrop" onClick={() => status !== 'loading' && onClose()}>
      <div
        className="modal withdraw-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="withdraw-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wd-head">
          <div className="modal-eyebrow">
            {mode === 'full'
              ? 'Full exit, signed in your wallet'
              : mode === 'partial'
                ? 'Partial exit, one agent'
                : 'Partial exit, every agent'}
          </div>
          <h3 className="modal-title" id="withdraw-title">
            {t(lang, 'withdraw')} from {vault.name}
          </h3>

          <div role="tablist" aria-label="Withdraw mode" className="wd-mode-tabs">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'full'}
              className={`wd-mode-tab${mode === 'full' ? ' is-active' : ''}`}
              onClick={() => setMode('full')}
            >
              Full exit
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'partial'}
              className={`wd-mode-tab${mode === 'partial' ? ' is-active' : ''}`}
              onClick={() => setMode('partial')}
            >
              Partial
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'proportional'}
              className={`wd-mode-tab${mode === 'proportional' ? ' is-active' : ''}`}
              onClick={() => setMode('proportional')}
            >
              Proportional
            </button>
          </div>
        </div>

        <div className="modal-scroll-content">
          {mode === 'full' && (
            <div className="wd-body">
              <div className="wd-hero">
                <span className="wd-hero-k">Position</span>
                <span className="wd-hero-v mono tnum">{balUsdc.toFixed(2)}</span>
                <span className="wd-hero-unit">USDC</span>
              </div>
              <p className="wd-lede">Your whole position across every agent holding this vault.</p>

              {agentAddresses.length === 0 ? (
                <div className="wd-callout wd-callout--danger" role="status">
                  No active agent holds this position, so there is nothing to sweep. If you just
                  made a deposit, wait for agent permissions to load and reopen this.
                </div>
              ) : (
                <div className="wd-callout">
                  Held by {agentAddresses.length} {agentAddresses.length === 1 ? 'agent' : 'agents'}
                  .{' '}
                  {ONE_SIGNATURE_EXIT
                    ? `${
                        signaturesFor(agentAddresses.length) === 1
                          ? 'Swept in one transaction; your wallet asks once'
                          : `Swept in ${signaturesFor(agentAddresses.length)} batches; your wallet asks ${signaturesFor(agentAddresses.length)} times`
                      }. A busy pool can split a batch and ask once more.`
                    : `Each agent is its own transaction, so your wallet asks ${
                        agentAddresses.length === 1 ? 'once' : `${agentAddresses.length} times`
                      }.`}
                </div>
              )}

              {progress && (
                <div className="wd-progress mono" role="status">
                  Sweeping agent {progress.index + 1} of {progress.total}. Confirm in your wallet…
                </div>
              )}

              <div className="grant-receipt wd-receipt" role="region" aria-label="Exit summary">
                <div className="grant-receipt-row">
                  <span className="grant-receipt-k">Time deposited</span>
                  <span className="grant-receipt-v mono">{fmtDur(depositedAgoSec)}</span>
                </div>
                <div className="grant-receipt-row">
                  <span className="grant-receipt-k">Total earned</span>
                  <span className="grant-receipt-v grant-receipt-v--ok mono tnum">
                    +{rewardsUsdc.toFixed(2)} USDC
                  </span>
                </div>
                <div className="grant-receipt-row">
                  <span className="grant-receipt-k">You receive</span>
                  <span className="grant-receipt-v mono tnum">~{balUsdc.toFixed(2)} USDC</span>
                </div>
                <div className="grant-receipt-row">
                  <span className="grant-receipt-k">Rewards</span>
                  <span className="grant-receipt-v grant-receipt-v--ok mono tnum">
                    +{rewardsUsdc.toFixed(2)} USDC (preserved)
                  </span>
                </div>
                <div className="grant-receipt-row">
                  <span className="grant-receipt-k">Signatures</span>
                  <span className="grant-receipt-v mono">
                    {ONE_SIGNATURE_EXIT
                      ? `~${signaturesFor(agentAddresses.length)} (all agents)`
                      : `${agentAddresses.length} (one per agent)`}
                  </span>
                </div>
                <div className="grant-receipt-row">
                  <span className="grant-receipt-k">Network fee</span>
                  {isSponsoredOwner ? (
                    <span className="grant-receipt-v grant-receipt-v--ok">
                      Sponsored by fee-bump relay
                    </span>
                  ) : (
                    <span className="grant-receipt-v">Paid by you, in XLM</span>
                  )}
                </div>
              </div>
              <p className="wd-footnote">Earnings remain claimable after withdrawal.</p>
            </div>
          )}

          {mode === 'partial' && (
            <div className="wd-body">
              <p className="wd-lede">
                Withdraw an exact amount from one agent. The rest keeps farming.
              </p>

              <div className="wd-section">
                <div className="wd-section-label" id="pw-agent-label">
                  Choose agent
                </div>
                {!agentInfo ? (
                  <div className="wd-agent-list" aria-busy="true" aria-labelledby="pw-agent-label">
                    {[0, 1].map((i) => (
                      <div key={i} className="wd-agent-row wd-agent-row--skeleton">
                        <span className="skeleton-bar" style={{ width: 72, height: 10 }} />
                        <span
                          className="skeleton-bar"
                          style={{ width: 88, height: 10, marginLeft: 'auto' }}
                        />
                      </div>
                    ))}
                    <span className="wd-hint">Reading agent balances…</span>
                  </div>
                ) : agentInfo.length === 0 ? (
                  <div className="wd-callout wd-callout--danger" role="status">
                    No agents available for partial withdraw.
                  </div>
                ) : (
                  <div className="wd-agent-list" role="radiogroup" aria-labelledby="pw-agent-label">
                    {agentInfo.map((a, i) => {
                      const selected = chosen === a.address
                      const maxUsdc = toDisplay(a.maxUnits).toFixed(2)
                      return (
                        // A plain div + onClick keeps click-anywhere-in-row selection without
                        // testing-library label-text false matches on "max 10.00 USDC".
                        <div
                          key={a.address}
                          className={[
                            'wd-agent-row',
                            selected ? 'is-selected' : '',
                            a.blocked ? 'is-blocked' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          onClick={() => {
                            if (a.blocked) return
                            setChosen(a.address)
                            setAmount('')
                          }}
                        >
                          <input
                            type="radio"
                            name="pw-agent"
                            aria-label={`${a.address.slice(0, 4)}…${a.address.slice(-4)} agent ${i + 1}`}
                            disabled={a.blocked}
                            checked={selected}
                            onChange={() => {
                              setChosen(a.address)
                              setAmount('')
                            }}
                          />
                          <div className="wd-agent-meta">
                            <span className="wd-agent-addr mono">{shortAddr(a.address)}</span>
                            <span className="wd-agent-idx">Agent {i + 1}</span>
                          </div>
                          <div className="wd-agent-max">
                            {a.blocked ? (
                              <span className="wd-agent-blocked">Expired. Use Full exit</span>
                            ) : (
                              <>
                                <span className="wd-agent-max-val mono tnum">{maxUsdc}</span>
                                <span className="wd-agent-max-unit">USDC max</span>
                              </>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {chosenRow && !chosenRow.blocked && (
                <div className="wd-section">
                  <label className="wd-section-label" htmlFor="pw-amount">
                    Amount
                  </label>
                  <div className="wd-amount-row">
                    <input
                      id="pw-amount"
                      type="number"
                      role="spinbutton"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.00"
                      className="wd-amount-input mono tnum"
                      aria-describedby="pw-amount-hint"
                    />
                    <span className="wd-amount-unit">USDC</span>
                  </div>
                  <div className="wd-pct-row" role="group" aria-label="Quick amounts">
                    {PCT_CHIPS.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className="btn btn-chip wd-pct-chip"
                        onClick={() => setPct(c.frac)}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                  <span id="pw-amount-hint" className={`wd-hint${overMax ? ' wd-hint--err' : ''}`}>
                    {overMax
                      ? `Exceeds this agent's max (${maxDisplay.toFixed(2)} USDC).`
                      : `Available on this agent: ${maxDisplay.toFixed(2)} USDC. Remainder stays in the vault.`}
                  </span>
                </div>
              )}

              {chosenRow && !chosenRow.blocked && amountUnits > 0n && !overMax && (
                <div
                  className="grant-receipt wd-receipt"
                  role="region"
                  aria-label="Partial summary"
                >
                  <div className="grant-receipt-row">
                    <span className="grant-receipt-k">You receive</span>
                    <span className="grant-receipt-v mono tnum">
                      ~{Number(amount).toFixed(2)} USDC
                    </span>
                  </div>
                  <div className="grant-receipt-row">
                    <span className="grant-receipt-k">From agent</span>
                    <span className="grant-receipt-v mono">{shortAddr(chosen)}</span>
                  </div>
                  <div className="grant-receipt-row">
                    <span className="grant-receipt-k">Left farming</span>
                    <span className="grant-receipt-v mono tnum">
                      ~{Math.max(0, maxDisplay - Number(amount)).toFixed(2)} USDC
                    </span>
                  </div>
                  <div className="grant-receipt-row">
                    <span className="grant-receipt-k">Network fee</span>
                    <span className="grant-receipt-v grant-receipt-v--ok">
                      Sponsored by fee-bump relay
                    </span>
                  </div>
                </div>
              )}

              <div className="wd-callout">
                Exit keys registered at grant time mean zero signatures here — otherwise the first
                partial withdraw from an agent asks for one signature to register its key. Either
                way the network fee is sponsored by the fee-bump relay.
              </div>
            </div>
          )}

          {mode === 'proportional' && (
            <div className="wd-body">
              <p className="wd-lede">
                Withdraw the same percentage from every eligible agent. The rest keeps farming.
              </p>

              <div className="wd-section">
                <label className="wd-section-label" htmlFor="pp-pct">
                  Percentage of each agent
                </label>
                <div className="wd-amount-row">
                  <input
                    id="pp-pct"
                    type="number"
                    role="spinbutton"
                    min="1"
                    max="100"
                    step="1"
                    inputMode="numeric"
                    value={propPct}
                    onChange={(e) => setPropPct(e.target.value)}
                    placeholder="25"
                    className="wd-amount-input mono tnum"
                    aria-describedby="pp-pct-hint"
                  />
                  <span className="wd-amount-unit">%</span>
                </div>
                <div className="wd-pct-row" role="group" aria-label="Quick percentages">
                  {PROP_CHIPS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="btn btn-chip wd-pct-chip"
                      onClick={() => setPropPct(c.pct)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <span id="pp-pct-hint" className="wd-hint">
                  {agentInfo
                    ? eligiblePropRows.length === 0
                      ? 'No eligible agents for a proportional withdraw (scopes expired or empty).'
                      : `${eligiblePropRows.length} eligible ${eligiblePropRows.length === 1 ? 'agent' : 'agents'}.`
                    : 'Reading agent balances…'}
                </span>
              </div>

              {propPlan && (
                <div
                  className="grant-receipt wd-receipt"
                  role="region"
                  aria-label="Proportional summary"
                >
                  {propPlan.legs.map((leg) => (
                    <div className="grant-receipt-row" key={leg.agentAddress}>
                      <span className="grant-receipt-k mono">{shortAddr(leg.agentAddress)}</span>
                      <span className="grant-receipt-v mono tnum">
                        ~{toDisplay(leg.amountUnits).toFixed(2)} USDC
                      </span>
                    </div>
                  ))}
                  <div className="grant-receipt-row">
                    <span className="grant-receipt-k">You receive</span>
                    <span className="grant-receipt-v mono tnum">
                      ~{propTotalDisplay.toFixed(2)} USDC
                    </span>
                  </div>
                  <div className="grant-receipt-row">
                    <span className="grant-receipt-k">Network fee</span>
                    <span className="grant-receipt-v grant-receipt-v--ok">
                      Sponsored by fee-bump relay
                    </span>
                  </div>
                </div>
              )}

              {multiStep && (
                <div className="wd-progress mono" role="status">
                  {multiStep}
                </div>
              )}

              {multiResults && (
                <div className="wd-section" role="status" aria-label="Withdraw results">
                  <div className="wd-section-label">Per-agent results</div>
                  {multiResults.results.map((r) => (
                    <div className="wd-agent-row" key={r.agentAddress}>
                      <div className="wd-agent-meta">
                        <span className="wd-agent-addr mono">{shortAddr(r.agentAddress)}</span>
                        <span className="wd-agent-idx">
                          {toDisplay(r.amountUnits).toFixed(2)} USDC
                        </span>
                      </div>
                      <div className="wd-agent-max">
                        {r.ok ? (
                          <span className="grant-receipt-v grant-receipt-v--ok">Done</span>
                        ) : r.error?.submission === 'unknown' ? (
                          <span className="wd-hint">
                            <strong>Unknown</strong> — check before retry
                          </span>
                        ) : (
                          <span className="wd-hint wd-hint--err">Failed</span>
                        )}
                      </div>
                    </div>
                  ))}
                  {multiResults.queued.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handleRetryQueued}
                      disabled={status !== 'idle'}
                    >
                      {status === 'loading'
                        ? 'Retrying…'
                        : `Retry ${multiResults.queued.length} queued`}
                    </button>
                  )}
                </div>
              )}

              <div className="wd-callout">
                One relayed withdraw per agent, no contract change: legs that fail or come back
                unknown stay queued above with their status — confirmed legs are recorded, the rest
                are never counted as received.
              </div>
            </div>
          )}

          {error && (
            <div className="wd-error" role="alert">
              <span>{error}</span>
            </div>
          )}
          {unknownNote && (
            <div className="wd-callout" role="status">
              <span>
                <strong>Status: unknown.</strong> {unknownNote}
              </span>
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={status === 'loading'}>
            Cancel
          </button>
          {mode === 'full' ? (
            <button
              ref={confirmRef}
              className="btn btn-primary"
              onClick={handleConfirm}
              disabled={!canWithdraw || status !== 'idle'}
            >
              {status === 'idle'
                ? t(lang, 'withdraw')
                : status === 'loading'
                  ? progress
                    ? `Sweeping ${progress.index + 1}/${progress.total}…`
                    : 'Withdrawing…'
                  : 'Done'}
            </button>
          ) : mode === 'partial' ? (
            <button
              className="btn btn-primary"
              onClick={handlePartial}
              disabled={!canPartial || status !== 'idle'}
            >
              {status === 'loading'
                ? 'Withdrawing…'
                : status === 'done'
                  ? 'Done'
                  : amount
                    ? `Withdraw ${amount} USDC`
                    : 'Withdraw'}
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={handleProportional}
              disabled={!canProportional}
            >
              {status === 'loading'
                ? 'Withdrawing…'
                : status === 'done'
                  ? 'Done'
                  : propPlan
                    ? `Withdraw ~${propTotalDisplay.toFixed(2)} USDC`
                    : 'Withdraw'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
