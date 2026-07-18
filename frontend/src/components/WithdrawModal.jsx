// WithdrawModal.jsx
// Manual withdraw from a single active position. Reuses the app's modal tokens.
import React, { useState, useEffect, useRef } from 'react'
import { withdrawAllFromVault } from '../agents/agentController.js'
import { saveTransaction } from '../history.js'
import { loadSettings, t } from '../settingsStore.js'
import { toDisplay, toBaseUnits } from '../stellar/format.js'
import { SOROBAN_EXIT_ROUTER_ADDRESS } from '../stellar/config.js'
import { MAX_AGENTS_PER_SWEEP } from '../stellar/exit.js'
import { partialWithdraw, ensureExitSigner, readAgentScope } from '../stellar/partialWithdraw.js'
import { readVaultShares } from '../stellar/agentDeposit.js'
import { readPricePerShare } from '../stellar/vaultReads.js'
import { clearExitKey } from '../wallet/exitKey.js'

const PPS_SCALE = 10_000_000n

// With the exit router deployed the whole position is swept in batches, so the exit costs the same
// single signature the deposit does — until a position is spread over more agents than fit one
// transaction's budget, when it costs one per batch. Unset, it is one per agent. Promising "1
// signature" and then opening three popups is a worse lie than quoting the real number, so quote it.
const ONE_SIGNATURE_EXIT = Boolean(SOROBAN_EXIT_ROUTER_ADDRESS)
const signaturesFor = (agentCount) =>
  ONE_SIGNATURE_EXIT ? Math.ceil(agentCount / MAX_AGENTS_PER_SWEEP) : agentCount

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

// Map raw ethers/relayer errors to a short, human-readable line.
// Avoids dumping the full ACTION_REJECTED / sendTransaction payload into the UI.
const friendlyError = (err) => {
  const code = err?.code || err?.info?.error?.code
  const raw = (err?.shortMessage || err?.message || '').toLowerCase()
  if (
    code === 'ACTION_REJECTED' ||
    code === 4001 ||
    raw.includes('user rejected') ||
    raw.includes('user denied')
  ) {
    return 'You rejected the transaction in your wallet.'
  }
  if (raw.includes('insufficient funds') || raw.includes('insufficient balance')) {
    return 'Insufficient balance to cover this withdrawal.'
  }
  if (raw.includes('timeout') || raw.includes('timed out')) {
    return 'The relayer timed out. Please try again.'
  }
  if (raw.includes('expired') || raw.includes('permission')) {
    return 'Agent permission is no longer active. Re-grant and retry.'
  }
  // Fall back to the wallet's own short message when present, else a generic line.
  const short = err?.shortMessage || err?.reason
  if (short && short.length < 120) return short
  return 'Withdraw failed. Please try again.'
}

const PCT_CHIPS = [
  { id: '25', label: '25%', frac: 0.25 },
  { id: '50', label: '50%', frac: 0.5 },
  { id: '75', label: '75%', frac: 0.75 },
  { id: 'max', label: 'Max', frac: 1 },
]

export default function WithdrawModal({
  vault,
  balance,
  unclaimedRewards = 0,
  userAddress,
  agentAddresses = [],
  onClose,
  onSuccess,
}) {
  const { language: lang } = loadSettings()
  const balUsdc = toDisplay(balance)
  const rewardsUsdc = toDisplay(unclaimedRewards)
  const [status, setStatus] = useState('idle') // idle | loading | done
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState(null)
  const [depositedAgoSec, setDepositedAgoSec] = useState(0)
  const [mode, setMode] = useState('full') // 'full' | 'partial'
  const [agentInfo, setAgentInfo] = useState(null) // [{address, maxUnits, blocked}] | null=loading
  const [chosen, setChosen] = useState(null)
  const [amount, setAmount] = useState('')
  const confirmRef = useRef(null)

  useEffect(() => {
    const prev = document.activeElement
    confirmRef.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape' && status !== 'loading') onClose()
    }
    window.addEventListener('keydown', onKey)
    readVaultDepositTimestamp(vault.address, userAddress).then((ts) => {
      if (ts > 0) setDepositedAgoSec(Math.floor(Date.now() / 1000) - ts)
    })
    return () => {
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [])

  // Partial mode: load each agent's withdrawable max (shares * price-per-share) and whether its
  // scope has expired/been revoked (chain still enforces either way — this read only drives the UI
  // gate, so a failed scope read leaves the row selectable rather than falsely blocking it).
  useEffect(() => {
    if (mode !== 'partial' || agentInfo) return
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
    setStatus('loading')
    setError(null)
    setProgress(null)
    try {
      const results = await withdrawAllFromVault(
        vault.address,
        userAddress,
        agentAddresses,
        setProgress
      )
      const failed = results.filter((r) => !r.ok)

      if (failed.length) {
        // Partial sweep: some USDC moved, some did not, and the per-agent split is not readable
        // from here — so claim no amount rather than a wrong one. Reconcile shows what is left.
        // ponytail: the successful legs get no history row on this branch; add per-agent amounts
        // if the vault ever exposes a per-sweep event to size them from.
        setError(
          `Swept ${results.length - failed.length} of ${results.length} agents. ` +
            `${failed.length} failed: ${failed[0].error}`
        )
        setStatus('idle')
        setProgress(null)
        onSuccess(vault.address, '0') // reconcile from chain, but never a false zero
        return
      }

      saveTransaction({
        txHash: results[0].txHash,
        vaultName: vault.name,
        vaultAddress: vault.address,
        protocol: vault.protocol,
        amountUsdc: balUsdc,
        apy: vault.apy,
        type: 'withdraw',
        network: 'stellar-testnet',
      })
      setStatus('done')
      onSuccess(vault.address, balance)
      setTimeout(onClose, 700)
    } catch (err) {
      setError(friendlyError(err))
      setStatus('idle')
      setProgress(null)
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
    setStatus('loading')
    setError(null)
    try {
      await ensureExitSigner({ owner: userAddress, agentAddress: chosen })
      const out = await partialWithdraw({
        owner: userAddress,
        agentAddress: chosen,
        amountUnits,
        vault: vault.address,
      })
      saveTransaction({
        txHash: out.transferHash,
        vaultName: vault.name,
        vaultAddress: vault.address,
        protocol: vault.protocol,
        amountUsdc: toDisplay(out.redeemed),
        apy: vault.apy,
        type: 'withdraw',
        network: 'stellar-testnet',
      })
      setStatus('done')
      onSuccess(vault.address, out.redeemed.toString())
      setTimeout(onClose, 700)
    } catch (err) {
      // A stale exit key (localStorage from a lost registration, or re-registered elsewhere)
      // fails auth on-chain; drop it so the retry re-registers fresh.
      if (/signature|auth/i.test(err?.message || '')) clearExitKey(chosen)
      setError(friendlyError(err))
      setStatus('idle')
    }
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
            {mode === 'full' ? 'Full exit, signed in your wallet' : 'Partial exit, one agent'}
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
                  No active agent holds this position, so there is nothing to sweep. If you just made
                  a deposit, wait for agent permissions to load and reopen this.
                </div>
              ) : (
                <div className="wd-callout">
                  Held by {agentAddresses.length}{' '}
                  {agentAddresses.length === 1 ? 'agent' : 'agents'}.{' '}
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
                  <span className="grant-receipt-v">Paid by you, in XLM</span>
                </div>
                <div className="grant-receipt-row">
                  <span className="grant-receipt-k">Estimated time</span>
                  <span className="grant-receipt-v mono">
                    ~{Math.max(30, signaturesFor(agentAddresses.length) * 20)} seconds
                  </span>
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
                  <div
                    className="wd-agent-list"
                    role="radiogroup"
                    aria-labelledby="pw-agent-label"
                  >
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
                  <span
                    id="pw-amount-hint"
                    className={`wd-hint${overMax ? ' wd-hint--err' : ''}`}
                  >
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
                    <span className="grant-receipt-v grant-receipt-v--ok">0 XLM, fee-bump</span>
                  </div>
                </div>
              )}

              <div className="wd-callout">
                First partial withdraw from an agent asks for one signature to register its exit
                key. After that: zero signatures, zero gas, two relayed transactions.
              </div>
            </div>
          )}

          {error && (
            <div className="wd-error" role="alert">
              <span>{error}</span>
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
          ) : (
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
          )}
        </div>
      </div>
    </div>
  )
}
