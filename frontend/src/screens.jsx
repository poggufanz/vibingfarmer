/* ============================================
   VIBING FARMER — screens (multi-agent edition)
   ============================================ */
import React, { useState, useEffect } from 'react'
import { Icon } from './components.jsx'
import { loadSettings, t } from './settingsStore.js'

const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')

const RISK_OPTIONS = [
  { id: 'low', label: 'Low', sub: '1 vault, conservative' },
  { id: 'med', label: 'Medium', sub: '2 vaults, balanced' },
  { id: 'high', label: 'High', sub: '3 vaults, diversified' },
]

/* ============================================
   INPUT — money-app: amount + risk only
   ============================================ */
const InputScreen = ({ amount, setAmount, risk, setRisk, onSubmit }) => {
  const { language: lang } = loadSettings()
  const valid = Number(amount) > 0 && risk
  const [prefill, setPrefill] = useState(null)
  useEffect(() => {
    const protocol = sessionStorage.getItem('yv_prefill_protocol')
    const name = sessionStorage.getItem('yv_prefill_name')
    const apy = sessionStorage.getItem('yv_prefill_apy')
    if (protocol) {
      setPrefill({ protocol, name, apy })
      sessionStorage.removeItem('yv_prefill_protocol')
      sessionStorage.removeItem('yv_prefill_name')
      sessionStorage.removeItem('yv_prefill_apy')
    }
  }, [])
  return (
    <section className="card enter">
      {prefill && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'rgba(255,255,255,.04)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '9px 14px',
            marginBottom: 16,
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
          }}
        >
          <span className="ui-dot" style={{ color: 'var(--ok)' }} aria-hidden="true" />
          <span style={{ color: 'var(--text-muted)' }}>
            Selected{' '}
            <strong style={{ color: 'inherit', fontWeight: 600, fontFamily: 'inherit' }}>
              {prefill.name}
            </strong>
            , {Number(prefill.apy).toFixed(1)}% APY
          </span>
        </div>
      )}
      <p className="grant-kicker mono">Deposit on Stellar testnet</p>

      <h1 className="h-display">How much do you want to put to work?</h1>
      <p className="lede">
        Pick an amount and risk level. We build a plan, you review it, then sign once. Network fees
        are covered. You can revoke anytime.
      </p>

      <div className="amount-block">
        <div>
          <div className="amount-label">{t(lang, 'depositAmount')}</div>
          <div className="amount-input-row">
            <input
              type="number"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label="USDC Amount"
              inputMode="decimal"
            />
            <span className="ticker">USDC</span>
          </div>
        </div>

        <div>
          <div className="amount-label">{t(lang, 'riskLevel')}</div>
          <div className="risk-row" role="radiogroup">
            {RISK_OPTIONS.map((r) => (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={risk === r.id}
                className={`risk-opt ${risk === r.id ? 'selected' : ''}`}
                onClick={() => setRisk(r.id)}
              >
                <span className="risk-opt-label">{r.label}</span>
                <span className="risk-opt-sub">{r.sub}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="action-row">
        <div className="foot-note">Live market data. One signature comes next.</div>
        <button className="btn btn-primary btn-lg" disabled={!valid} onClick={onSubmit}>
          Continue
        </button>
      </div>
    </section>
  )
}

/* ============================================
   01b — AI Thinking (strategy generation)
   ============================================ */
const THINK_STEPS = [
  { label: 'Scanning active vaults on Stellar testnet' },
  { label: 'Structuring allocation per risk profile' },
  { label: 'Generating strategy via AI' },
]

const THINK_MSGS = [
  'Reviewing vault strategy…',
  'Comparing vault options…',
  'Calculating the allocation for your risk level…',
  'Validating vault addresses and expected APY…',
]

const ThinkingCard = ({ phase, times = [] }) => {
  // Live count-up for the active step — the AI step keeps ticking until generateStrategy resolves
  const [live, setLive] = React.useState(0)
  React.useEffect(() => {
    setLive(0)
    const start = performance.now()
    const iv = setInterval(() => setLive((performance.now() - start) / 1000), 80)
    return () => clearInterval(iv)
  }, [phase])

  const [msgI, setMsgI] = React.useState(0)
  React.useEffect(() => {
    if (phase !== 2) return // only while strategy generation is running
    setMsgI(0)
    const iv = setInterval(() => setMsgI((i) => (i + 1) % THINK_MSGS.length), 2500)
    return () => clearInterval(iv)
  }, [phase])

  return (
    <section className="thinking enter">
      <p className="grant-kicker mono">Building your plan with live market data</p>
      <h2 className="thinking-title">Finding vaults that fit your amount and risk…</h2>

      <div className="thinking-list">
        {THINK_STEPS.map((s, i) => {
          const state = i < phase ? 'done' : i === phase ? 'active' : 'idle'
          const t = i === phase ? live : times[i]
          return (
            <div key={i} className={`think-step ${state}`}>
              <span className="marker" />
              <span>{s.label}</span>
              <span className="time">
                {state === 'idle' ? 'Pending' : `${(t ?? 0).toFixed(1)}s`}
                {state === 'active' && <span className="think-spin" aria-hidden="true" />}
              </span>
            </div>
          )
        })}
      </div>

      {phase === 2 && (
        <div key={msgI} className="thinking-status">
          {THINK_MSGS[msgI]}
        </div>
      )}
    </section>
  )
}

/* ============================================
   02 — Connect & authorize agent session
   ============================================ */
const ConnectCard = ({ phase, error, onConnect, onUpgrade, onDone, onCancel }) => {
  return (
    <section className="card enter">
      <p className="grant-kicker mono">Stellar testnet wallet</p>

      <h1 className="h-display">Connect your wallet</h1>
      <p className="lede">
        Use Freighter, xBull, or Albedo. Next you will set a spending budget with one signature.
        Network fees stay covered.
      </p>

      {phase === 'idle' && (
        <div className="action-row">
          <div className="foot-note">
            Connect Freighter, xBull, or Albedo on <b>Stellar testnet</b>.
          </div>
          <button className="btn btn-primary btn-lg" onClick={onConnect}>
            Connect wallet
          </button>
        </div>
      )}

      {phase === 'connecting' && (
        <MmDialog
          domain="vibing-farmer.app"
          title="Connection request"
          rows={[
            { k: 'Request', v: 'getPublicKey' },
            { k: 'Network', v: 'Stellar testnet' },
            { k: 'Status', v: 'Awaiting user…' },
          ]}
          pending
        />
      )}

      {phase === 'connected' && (
        <>
          <MmDialog
            domain="vibing-farmer.app"
            title="Authorize agent session"
            rows={[
              { k: 'Grant', v: 'Ed25519 session-key scope', accent: true },
              { k: 'Network', v: 'Stellar testnet' },
              { k: 'Cap', v: 'Capped per agent' },
              { k: 'Expiry', v: 'Time-limited' },
            ]}
          />
          <div className="action-row">
            <div className="foot-note">
              The relayer fee-bumps the authorization transaction. You pay <b>0 XLM</b>.
            </div>
            <div className="flex gap-2">
              <button className="btn btn-ghost" onClick={onCancel}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={onUpgrade}>
                Sign authorization
              </button>
            </div>
          </div>
        </>
      )}

      {phase === 'upgrading' && (
        <MmDialog
          domain="Stellar Wallet"
          title="Agent session active"
          rows={[
            { k: 'Type', v: 'Ed25519 session key', accent: true },
            { k: 'Relayer', v: 'Fee-bump relayer' },
            { k: 'Network fee', v: '0 XLM, paid by relayer', accent: true },
            { k: 'Status', v: 'Confirming…' },
          ]}
          pending
        />
      )}

      {phase === 'upgraded' && <UpgradedCallout onDone={onDone} />}

      {error && (
        <div role="alert" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 10 }}>
          {error}
        </div>
      )}
    </section>
  )
}

const MmDialog = ({ domain, title, rows, pending }) => (
  <div className="mm-pop enter">
    <div className="mm-pop-head">
      <div className="mm-brand">
        <div className="mm-mark">
          <span aria-hidden="true" style={{ fontSize: 9, lineHeight: '14px' }}>
            VF
          </span>
        </div>
        <span className="mm-name">Stellar Wallet</span>
      </div>
      <span className="mm-domain">{domain}</span>
    </div>
    <div
      className="mono"
      style={{ fontSize: 12, color: 'var(--text)', marginBottom: 12, letterSpacing: '-0.01em' }}
    >
      {title}
      {pending ? '…' : ''}
    </div>
    <div className="mm-body">
      {rows.map((r, i) => (
        <div key={i} className="row">
          <span className="k">{r.k}</span>
          <span className={`v ${r.accent ? 'accent' : ''}`}>{r.v}</span>
        </div>
      ))}
    </div>
  </div>
)

const UpgradedCallout = ({ onDone }) => (
  <div className="enter" style={{ marginTop: 28 }}>
    <div
      style={{
        borderTop: '1px solid var(--border)',
        borderBottom: '1px solid var(--border)',
        padding: '24px 0',
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 18,
        alignItems: 'center',
      }}
    >
      <div>
        <div
          className="mono"
          style={{
            fontSize: 11,
            color: 'var(--accent)',
            letterSpacing: '-0.01em',
            marginBottom: 8,
          }}
        >
          Agent session active
        </div>
        <div className="h-sub">
          Wallet connected. Ed25519 session keys are authorized on the registry.
        </div>
        <div
          className="mono"
          style={{
            fontSize: 12,
            color: 'var(--text-muted)',
            marginTop: 6,
            letterSpacing: '-0.01em',
          }}
        >
          Ed25519 session keys. You pay 0 XLM; the fee-bump relayer covers the network fee.
        </div>
      </div>
      <button className="btn btn-primary" onClick={onDone}>
        Review skills
      </button>
    </div>
  </div>
)

/* ============================================
   04 — Permission scope (multi-agent batched)
   ============================================ */
const PermissionCard = ({ strategy, eligibility, onGrant, phase, error, onConfirm, onReject }) => {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
  const expiresFmt = expiresAt.toLocaleString('en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  const agents = strategy?.agents || []
  const totalMax = agents.reduce((s, a) => s + a.allocation, 0)

  return (
    <section className="card enter">
      <p className="grant-kicker mono">Permission: Sign once</p>

      <h1 className="h-display">Review scoped permissions</h1>
      <p className="lede">
        One signature grants a capped, expiring limit. After that, deposits run without more wallet
        prompts. Outside this scope, the vault reverts.
      </p>

      <div className="perm-doc">
        <div className="perm-doc-row perm-doc-summary">
          <div className="perm-doc-k">batch.summary</div>
          <div className="perm-doc-v">
            {agents.length} permission{agents.length === 1 ? '' : 's'}, total maximum{' '}
            <span className="accent">{totalMax.toFixed(2)} USDC</span>
            <span className="annot">Expires {expiresFmt}</span>
          </div>
        </div>
        {agents.map((a) => (
          <div className="perm-doc-row perm-doc-agent" key={a.id}>
            <div className="perm-doc-k">
              <span className="perm-doc-agent-idx mono">{a.idx}</span> {a.id}
            </div>
            <div className="perm-doc-v">
              <div className="perm-doc-agent-line">
                <span className="mono perm-doc-agent-vault">
                  {a.vault.addr.slice(0, 14)}…{a.vault.addr.slice(-4)}
                </span>
                <span className="annot">{a.vault.protocol}</span>
              </div>
              <div className="perm-doc-agent-line">
                <span className="accent">{a.allocation} USDC max</span>
                <span className="annot">Hard cap. Transactions above it revert.</span>
              </div>
            </div>
          </div>
        ))}
        <div className="perm-doc-row">
          <div className="perm-doc-k">expires.at</div>
          <div className="perm-doc-v">
            {expiresFmt}
            <span className="annot">86,400 seconds from now</span>
          </div>
        </div>
        <div className="perm-doc-row">
          <div className="perm-doc-k">Revocable</div>
          <div className="perm-doc-v">
            Yes, per agent or as a batch
            <span className="annot">Anytime, in one on-chain action</span>
          </div>
        </div>
      </div>

      <div className="action-row">
        <div className="foot-note">
          Each agent <b>has no access</b> to other agents' vaults. The contract validates every
          call.
        </div>
        {phase === 'idle' && (
          <button className="btn btn-primary btn-lg" onClick={onGrant}>
            Grant {agents.length} permission{agents.length === 1 ? '' : 's'}
          </button>
        )}
        {phase === 'prompting' && <span className="foot-note mono">Awaiting wallet…</span>}
      </div>

      {phase === 'prompting' && (
        <MmPermissionModal
          strategy={strategy}
          eligibility={eligibility}
          onConfirm={onConfirm}
          onReject={onReject}
        />
      )}

      {error && (
        <div role="alert" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 10 }}>
          {error}
        </div>
      )}
    </section>
  )
}

const MmPermissionModal = ({ strategy, eligibility, onConfirm, onReject }) => {
  const agents = strategy?.agents || []
  const total = agents.reduce((s, a) => s + a.allocation, 0)
  return (
    <div className="modal-backdrop" onClick={onReject}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-eyebrow">Authorize agent sessions</div>
        <h3 className="modal-title">
          Approve {agents.length} execution permission{agents.length === 1 ? '' : 's'}?
        </h3>

        <div
          className="modal-scroll-content"
          style={{
            flex: 1,
            overflowY: 'auto',
            marginRight: '-12px',
            paddingRight: '12px',
            maxHeight: '55vh',
          }}
        >
          <div className="mm-pop" style={{ marginTop: 0 }}>
            <div className="mm-pop-head">
              <div className="mm-brand">
                <div className="mm-mark">
                  <span aria-hidden="true" style={{ fontSize: 9, lineHeight: '14px' }}>
                    VF
                  </span>
                </div>
                <span className="mm-name">Stellar Wallet</span>
              </div>
              <span className="mm-domain">vibing-farmer.app</span>
            </div>
            <div className="mm-body">
              <div className="row">
                <span className="k">Batch type</span>
                <span className="v accent">vault-deposit, {agents.length}x</span>
              </div>
              <div className="row">
                <span className="k">Total maximum</span>
                <span className="v accent">{total.toFixed(2)} USDC</span>
              </div>
              {agents.map((a) => (
                <div className="row" key={a.id}>
                  <span className="k">{a.id}</span>
                  <span className="v">
                    {a.allocation} USDC, {a.vault.addr.slice(0, 10)}…
                  </span>
                </div>
              ))}
              <div className="row">
                <span className="k">Expires</span>
                <span className="v">24 hours</span>
              </div>
            </div>
          </div>

          {eligibility?.rows?.length > 0 && (
            <div className="elig-panel">
              {eligibility.fusedSentence && (
                <p className="elig-sentence">{eligibility.fusedSentence}</p>
              )}
              <ul className="elig-rows">
                {eligibility.rows.map((row) => (
                  <li key={row.id} className={row.eligible ? 'elig-pass' : 'elig-reject'}>
                    <span className="elig-status">{row.eligible ? 'Pass' : 'Reject'}</span>
                    <span className={row.eligible ? '' : 'struck'}>{row.protocolLabel}</span>
                    <span className="elig-label">{row.label}</span>
                    {row.isFixture && (
                      <span className="elig-fixture">Demo fixture: Rejected by design.</span>
                    )}
                    {row.eligible && (
                      <>
                        <span className="elig-mainnet">{row.mainnetLine}</span>
                        <span className="elig-testnet">{row.testnetLine}</span>
                        <span className="elig-chip">DeFiLlama, as of {row.asOf}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onReject}>
            Reject
          </button>
          <button className="btn btn-primary" onClick={onConfirm}>
            Approve batch
          </button>
        </div>
      </div>
    </div>
  )
}

/* ============================================
   06 — Success (multi-agent summary)
   ============================================ */
const SuccessCard = ({ strategy, onAgain, address }) => {
  const total = strategy?.total ?? 100
  const apy = strategy?.blendedApy ?? '8.2'
  const monthly = ((total * (Number(apy) / 100)) / 12).toFixed(2)
  const agents = strategy?.agents || []
  return (
    <section className="success-card enter">
      <p className="grant-kicker mono">Done. Portfolio active.</p>

      <h1 className="success-title">
        Your USDC is deposited. Estimated blended APY is {apy}%, about {monthly} USDC per month.
      </h1>
      <p className="lede" style={{ marginTop: 8, maxWidth: 480 }}>
        Agents will compound and rebalance within your grant. You can withdraw or revoke anytime
        from the home page.
      </p>

      <div className="success-numbers">
        <div className="success-num-cell">
          <span className="label">Total deposited</span>
          <span className="figure tnum">
            {total}
            <span className="unit">USDC</span>
          </span>
        </div>
        <div className="success-num-cell">
          <span className="label">Estimated monthly yield</span>
          <span className="figure tnum" style={{ color: 'var(--accent)' }}>
            +{monthly}
            <span className="unit">USDC</span>
          </span>
        </div>
        <div className="success-num-cell">
          <span className="label">Your signatures</span>
          <span className="figure tnum">1</span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-faint)',
              letterSpacing: '-0.01em',
              marginTop: -4,
            }}
          >
            Grant only. Network fee covered.
          </span>
        </div>
      </div>

      <div className="success-agents">
        {agents.map((a) => (
          <div key={a.id} className="success-agent-row">
            <span className="mono idx">{a.idx}</span>
            <div>
              <div className="name">{a.vault.name}</div>
              <div className="meta mono">
                {a.vault.protocol}, {a.allocation} USDC
              </div>
            </div>
            <div className="value mono tnum">
              {a.vault.apy}% <span className="muted">APY</span>
            </div>
          </div>
        ))}
      </div>

      <div className="action-row" style={{ marginTop: 36 }}>
        <div className="foot-note">
          On-chain. The relayer pays network fees. Revoke from the home page anytime.
        </div>
        <div className="flex gap-2">
          <a
            className="btn btn-ghost"
            href={
              address
                ? `https://stellar.expert/explorer/testnet/account/${address}`
                : 'https://stellar.expert/explorer/testnet'
            }
            target="_blank"
            rel="noopener noreferrer"
          >
            View on Stellar Expert
          </a>
          <button className="btn btn-primary" onClick={onAgain}>
            Deposit more <Icon name="plus" size={14} />
          </button>
        </div>
      </div>
    </section>
  )
}

export {
  InputScreen,
  ThinkingCard,
  ConnectCard,
  PermissionCard,
  SuccessCard,
  shortAddr,
  THINK_STEPS,
  MmDialog,
}
