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

const Row = ({ k, v, color }) => (
  <div
    style={{
      display: 'flex',
      justifyContent: 'space-between',
      gap: 12,
      fontSize: 12,
      padding: '3px 0',
    }}
  >
    <span style={{ color: 'var(--text-muted)' }}>{k}</span>
    <span className="mono" style={{ textAlign: 'right', color: color || 'inherit' }}>
      {v}
    </span>
  </div>
)

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
            readVaultShares(address),
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
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="withdraw-title"
        style={{ maxWidth: 420 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-eyebrow">Full exit, signed in your wallet</div>
        <h3 className="modal-title" id="withdraw-title">
          {t(lang, 'withdraw')} from {vault.name}
        </h3>

        <div
          role="tablist"
          aria-label="Withdraw mode"
          className="flex"
          style={{ gap: 8, margin: '10px 0 4px' }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'full'}
            className="btn btn-ghost"
            style={{
              fontSize: 11,
              padding: '5px 10px',
              background: mode === 'full' ? 'var(--bg-elev-2)' : undefined,
              borderColor: mode === 'full' ? 'var(--border-strong)' : undefined,
            }}
            onClick={() => setMode('full')}
          >
            Full exit
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'partial'}
            className="btn btn-ghost"
            style={{
              fontSize: 11,
              padding: '5px 10px',
              background: mode === 'partial' ? 'var(--bg-elev-2)' : undefined,
              borderColor: mode === 'partial' ? 'var(--border-strong)' : undefined,
            }}
            onClick={() => setMode('partial')}
          >
            Partial
          </button>
        </div>

        {mode === 'full' && (
          <>
            <div className="act-meta" style={{ fontSize: 11, margin: '8px 0 6px' }}>
              Withdrawing <span className="mono">{balUsdc.toFixed(2)} USDC</span> — your whole
              position.
            </div>

            {agentAddresses.length === 0 ? (
              <div style={{ color: 'var(--danger)', fontSize: 10.5, marginTop: 5 }}>
                No active agent holds this position, so there is nothing to sweep. If you just made
                a deposit, wait for agent permissions to load and reopen this.
              </div>
            ) : (
              <div style={{ fontSize: 10.5, opacity: 0.6, marginTop: 5, lineHeight: 1.45 }}>
                This position is held by {agentAddresses.length}{' '}
                {agentAddresses.length === 1 ? 'agent' : 'agents'}.{' '}
                {ONE_SIGNATURE_EXIT
                  ? `${
                      signaturesFor(agentAddresses.length) === 1
                        ? 'They are all swept by one transaction, so your wallet asks you to sign once'
                        : `They are swept in ${signaturesFor(agentAddresses.length)} batches, so your wallet asks you to sign ${signaturesFor(agentAddresses.length)} times`
                    } — a busy pool can split a batch and ask once more.`
                  : `Each is swept by its own transaction, so your wallet asks you to sign ${
                      agentAddresses.length === 1 ? 'once' : `${agentAddresses.length} times`
                    }.`}
              </div>
            )}

            {progress && (
              <div
                className="mono"
                style={{ fontSize: 10.5, marginTop: 6, color: 'var(--text-muted)' }}
              >
                Sweeping agent {progress.index + 1} of {progress.total} — confirm in your wallet…
              </div>
            )}

            <div style={{ borderTop: '.5px solid rgba(255,255,255,.08)', margin: '10px 0' }} />
            <Row k="Time deposited" v={fmtDur(depositedAgoSec)} />
            <Row k="Total earned" v={`+${rewardsUsdc.toFixed(2)} USDC`} color="var(--ok)" />
            <div style={{ fontSize: 9.5, opacity: 0.5, textAlign: 'right', marginTop: -2 }}>
              Earnings remain claimable after withdrawal.
            </div>

            <div style={{ borderTop: '.5px solid rgba(255,255,255,.08)', margin: '10px 0' }} />
            <Row k="You receive" v={`~${balUsdc.toFixed(2)} USDC`} />
            <Row k="Rewards" v={`+${rewardsUsdc.toFixed(2)} USDC (preserved)`} color="var(--ok)" />
            <Row
              k="Signatures"
              v={
                ONE_SIGNATURE_EXIT
                  ? // A floor, not a promise: the batch size is calibrated against a cost that moves
                    // with the pool, so a batch that overruns splits and asks once more. Quote it as
                    // the estimate it is rather than a number the wallet can overshoot.
                    `~${signaturesFor(agentAddresses.length)} (all agents)`
                  : `${agentAddresses.length} (one per agent)`
              }
            />
            <Row k="Network fee" v="Paid by you, in XLM" />
            <Row
              k="Estimated time"
              v={`~${Math.max(30, signaturesFor(agentAddresses.length) * 20)} seconds`}
            />
          </>
        )}

        {mode === 'partial' && (
          <>
            <div className="act-meta" style={{ fontSize: 11, margin: '8px 0 6px' }}>
              Withdraw an exact amount from one agent. The rest keeps farming.
            </div>
            {!agentInfo ? (
              <div style={{ fontSize: 10.5, opacity: 0.6 }}>Reading agent balances…</div>
            ) : (
              agentInfo.map((a, i) => (
                // A <label> wrapper's OWN rendered text (not just the input's aria-label) also
                // drives testing-library's label-text lookup — and "max 10.00 USDC" trivially
                // contains a "1", so two <label>-wrapped rows both satisfy an /…1/ query. A plain
                // div + onClick keeps click-anywhere-in-row selection without that false match.
                <div
                  key={a.address}
                  onClick={() => {
                    if (a.blocked) return
                    setChosen(a.address)
                    setAmount('')
                  }}
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    fontSize: 11,
                    padding: '4px 0',
                    opacity: a.blocked ? 0.45 : 1,
                    cursor: a.blocked ? 'default' : 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="pw-agent"
                    aria-label={`${a.address.slice(0, 4)}…${a.address.slice(-4)} agent ${i + 1}`}
                    disabled={a.blocked}
                    checked={chosen === a.address}
                    onChange={() => {
                      setChosen(a.address)
                      setAmount('')
                    }}
                  />
                  <span className="mono">
                    {a.address.slice(0, 4)}…{a.address.slice(-4)}
                  </span>
                  <span style={{ marginLeft: 'auto' }} className="mono">
                    {a.blocked
                      ? 'expired — use Full exit'
                      : `max ${toDisplay(a.maxUnits).toFixed(2)} USDC`}
                  </span>
                </div>
              ))
            )}
            {chosenRow && !chosenRow.blocked && (
              <div style={{ marginTop: 8 }}>
                <input
                  type="number"
                  role="spinbutton"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={`≤ ${toDisplay(chosenRow.maxUnits).toFixed(2)}`}
                  style={{ width: '100%' }}
                />
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 10, marginTop: 4 }}
                  onClick={() => setAmount(String(toDisplay(chosenRow.maxUnits)))}
                >
                  Max
                </button>
              </div>
            )}
            <div style={{ fontSize: 10, opacity: 0.55, marginTop: 6, lineHeight: 1.4 }}>
              First partial withdraw from an agent asks for one signature to register its exit key.
              After that: zero signatures, zero gas — two relayed transactions.
            </div>
          </>
        )}

        {error && (
          <div
            role="alert"
            style={{
              display: 'flex',
              gap: 7,
              alignItems: 'flex-start',
              color: 'var(--danger)',
              fontSize: 11,
              lineHeight: 1.4,
              marginTop: 8,
              padding: '7px 9px',
              background: 'rgba(255,80,80,.08)',
              border: '.5px solid rgba(255,80,80,.25)',
              borderRadius: 6,
              overflowWrap: 'anywhere',
            }}
          >
            <span>{error}</span>
          </div>
        )}

        {mode === 'full' && (
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={onClose} disabled={status === 'loading'}>
              Cancel
            </button>
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
          </div>
        )}

        {mode === 'partial' && (
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={onClose} disabled={status === 'loading'}>
              Cancel
            </button>
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
          </div>
        )}
      </div>
    </div>
  )
}
