// RightRail.jsx — right-rail components extracted from app.jsx
import React, { useState as useS } from 'react'
import { Icon } from '../components.jsx'
import { shortAddr } from '../screens.jsx'
import { fmtRemaining } from '../ui.js'

/* ---------- Right rail panels ---------- */
const WalletPanel = ({ phase, address }) => {
  const [copied, setCopied] = useS(false)
  if (phase === 'none') {
    return (
      <div
        className="panel"
        style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}
      >
        <div
          className="panel-head"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginBottom: 12,
          }}
        >
          <div
            className="panel-title"
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--text)',
            }}
          >
            Wallet
          </div>
          <span
            className="panel-meta"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '10.5px',
              color: 'var(--text-faint)',
            }}
          >
            Not connected
          </span>
        </div>
        <div
          className="empty"
          style={{
            padding: '14px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            color: 'var(--text-faint)',
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            textAlign: 'center',
          }}
        >
          Not connected yet
        </div>
      </div>
    )
  }
  const isSmart = phase === 'upgraded'
  return (
    <div
      className="panel"
      style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}
    >
      <div
        className="panel-head"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 12,
        }}
      >
        <div
          className="panel-title"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--text)',
          }}
        >
          Wallet
        </div>
        <span
          className="panel-meta"
          style={{ fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--text-faint)' }}
        >
          {isSmart ? 'Session keys bound' : 'Standard wallet'}
        </span>
      </div>
      <div
        className="wallet-row"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 14px',
          borderRadius: 'var(--radius-md)',
          background: 'linear-gradient(135deg, var(--bg-card) 0%, var(--bg-base) 100%)',
          border: '1px solid var(--border-strong)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}
      >
        <div>
          <div
            className="wallet-addr"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              fontWeight: 600,
              background: 'linear-gradient(90deg, var(--accent) 0%, var(--ok) 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              letterSpacing: '-0.01em',
            }}
          >
            {shortAddr(address)}
          </div>
          <div
            className={`wallet-type ${isSmart ? 'active' : ''}`}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '10.5px',
              marginTop: 2,
              color: isSmart ? 'var(--accent)' : 'var(--text-faint)',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: '50%',
                background: isSmart ? 'var(--accent)' : 'var(--text-faint)',
                display: 'inline-block',
                boxShadow: isSmart ? '0 0 6px var(--accent)' : 'none',
              }}
            />
            {isSmart ? 'Session keys active' : 'Standard wallet'}
          </div>
        </div>
        <div className="wallet-actions" style={{ display: 'flex', gap: 4 }}>
          <button
            className="wallet-action"
            title={copied ? 'Copied' : 'Copy address'}
            aria-label="Copy address"
            style={{
              width: 28,
              height: 28,
              borderRadius: 'var(--radius-sm)',
              display: 'grid',
              placeItems: 'center',
              border: '1px solid var(--border)',
              backgroundColor: copied ? 'var(--accent-soft)' : 'var(--bg-elev)',
              color: copied ? 'var(--accent)' : 'var(--text-muted)',
              cursor: 'pointer',
              transition:
                'background-color 150ms ease, color 150ms ease, border-color 150ms ease, transform 160ms var(--ease-out)',
            }}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(address)
                setCopied(true)
                setTimeout(() => setCopied(false), 1200)
              } catch (e) {
                console.warn('[wallet] clipboard failed:', e)
              }
            }}
          >
            <Icon name={copied ? 'check' : 'copy'} />
          </button>
          <a
            className="wallet-action"
            title="View on Stellar Expert"
            aria-label="View on Stellar Expert"
            href={`https://stellar.expert/explorer/testnet/account/${address}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              width: 28,
              height: 28,
              borderRadius: 'var(--radius-sm)',
              display: 'grid',
              placeItems: 'center',
              border: '1px solid var(--border)',
              backgroundColor: 'var(--bg-elev)',
              color: 'var(--text-muted)',
              transition:
                'background-color 150ms ease, color 150ms ease, border-color 150ms ease, transform 160ms var(--ease-out)',
            }}
          >
            <Icon name="external" />
          </a>
        </div>
      </div>
    </div>
  )
}

const PermissionPanel = ({ active, strategy, onRevoke, expiresAt }) => {
  const agents = strategy?.agents || []
  return (
    <div
      className="panel"
      style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}
    >
      <div
        className="panel-head"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 12,
        }}
      >
        <div
          className="panel-title"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--text)',
          }}
        >
          Active permissions
        </div>
        <span
          className="panel-meta"
          style={{ fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--text-faint)' }}
        >
          Session scope · Batch
        </span>
      </div>
      <div
        className={`perm-status ${active ? 'active' : ''}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: 'var(--font-mono)',
          fontSize: '11.5px',
          color: active ? 'var(--accent)' : 'var(--text-faint)',
          marginBottom: active ? 12 : 0,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: active ? 'var(--accent)' : 'var(--text-faint)',
            boxShadow: active ? '0 0 6px var(--accent)' : 'none',
          }}
        />
        {active
          ? `${agents.length} permission${agents.length > 1 ? 's' : ''} · ${fmtRemaining(expiresAt) || '-'}`
          : 'No active permission'}
      </div>
      {active && agents.length > 0 && (
        <div
          style={{
            background: 'linear-gradient(135deg, var(--bg-card) 0%, var(--bg-base) 100%)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-md)',
            padding: '12px 14px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          }}
        >
          <div
            className="perm-agent-list"
            style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            {agents.map((a) => (
              <div
                key={a.id}
                className="perm-agent-row"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                }}
              >
                <span
                  className="idx mono"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--text-faint)',
                    minWidth: 16,
                  }}
                >
                  {a.idx}
                </span>
                <div className="meta-col" style={{ flex: 1, minWidth: 0 }}>
                  <div
                    className="agent-name"
                    style={{ fontSize: '12.5px', fontWeight: 500, color: 'var(--text)' }}
                  >
                    {a.id}
                  </div>
                  <div
                    className="mono agent-vault"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color: 'var(--text-muted)',
                    }}
                  >
                    {a.vault.addr.slice(0, 8)}…{a.vault.addr.slice(-4)}
                  </div>
                </div>
                <div
                  className="mono amount tnum"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    fontWeight: 500,
                    color: 'var(--text)',
                  }}
                >
                  {a.allocation} USDC
                </div>
              </div>
            ))}
          </div>
          <button
            className="perm-revoke"
            onClick={onRevoke}
            style={{
              marginTop: 12,
              width: '100%',
              padding: '8px 12px',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--bg-elev)',
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              cursor: 'pointer',
            }}
          >
            Revoke all permissions
          </button>
        </div>
      )}
    </div>
  )
}

const EVENT_STYLES = {
  AgentStarted: { icon: '●', color: 'var(--warn)' },
  SwapExecuted: { icon: '↻', color: 'var(--info)' },
  ApproveExecuted: { icon: '✓', color: 'var(--info)' },
  DepositExecuted: { icon: '↓', color: 'var(--info)' },
  AgentCompleted: { icon: '✓', color: 'var(--ok)' },
  AgentFailed: { icon: '✕', color: 'var(--danger)' },
  RedelegationCreated: { icon: '⇄', color: 'var(--info)' },
  RedelegationRedeemed: { icon: '✓', color: 'var(--ok)' },
  OrchestratorPlanned: { icon: '·', color: 'var(--text-muted)' },
  PermissionGranted: { icon: '·', color: 'var(--text-muted)' },
  Connected: { icon: '·', color: 'var(--text-muted)' },
  Authorized: { icon: '·', color: 'var(--text-muted)' },
  PermissionRevoked: { icon: '·', color: 'var(--danger)' },
  SkillApproved: { icon: '·', color: 'var(--text-muted)' },
}

const ActivityPanel = ({ logs }) => {
  const [openId, setOpenId] = useS(null)
  const [page, setPage] = useS(1)

  const pageSize = 5
  const totalPages = Math.ceil(logs.length / pageSize) || 1
  const currentPage = Math.min(page, totalPages)

  const reversedLogs = logs.slice().reverse()
  const startIndex = (currentPage - 1) * pageSize
  const pagedLogs = reversedLogs.slice(startIndex, startIndex + pageSize)

  return (
    <div
      className="panel"
      style={{
        borderBottom: 'none',
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        padding: '16px 20px',
      }}
    >
      <div
        className="panel-head"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 12,
        }}
      >
        <div
          className="panel-title"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--text)',
          }}
        >
          Activity
        </div>
        <span
          className="panel-meta"
          style={{ fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--text-faint)' }}
        >
          {logs.length ? `${logs.length} events · realtime` : 'Agent events · realtime'}
        </span>
      </div>
      {logs.length === 0 ? (
        <div
          className="empty"
          style={{
            padding: '14px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            color: 'var(--text-faint)',
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            textAlign: 'center',
          }}
        >
          No events yet
        </div>
      ) : (
        <>
          <div
            className="activity"
            style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}
          >
            {pagedLogs.map((l) => {
              const sty = EVENT_STYLES[l.event] || EVENT_STYLES.OrchestratorPlanned
              const open = openId === l.id
              return (
                <div
                  key={l.id}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 'var(--radius-sm)',
                    background: open ? 'var(--bg-card)' : 'transparent',
                    border: open ? '1px solid var(--border)' : '1px solid transparent',
                    transition: 'background-color 150ms ease, border-color 150ms ease',
                  }}
                >
                  <div
                    className="act-row"
                    style={{
                      cursor: 'pointer',
                      display: 'grid',
                      gridTemplateColumns: '18px 1fr auto',
                      gap: 8,
                      alignItems: 'start',
                    }}
                    role="button"
                    tabIndex={0}
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : l.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setOpenId(open ? null : l.id)
                      }
                    }}
                  >
                    <span
                      className="act-marker mono"
                      aria-hidden="true"
                      style={{
                        color: sty.color,
                        fontFamily: 'var(--font-mono)',
                        fontSize: 13,
                        fontWeight: 'bold',
                      }}
                    >
                      {sty.icon}
                    </span>
                    <div>
                      <div
                        className="act-title"
                        style={{ fontSize: '12.5px', fontWeight: 500, color: 'var(--text)' }}
                      >
                        <span className="act-event mono" style={{ fontFamily: 'var(--font-mono)' }}>
                          {l.event}
                        </span>
                        {l.agent && (
                          <span
                            className="act-agent mono"
                            style={{
                              marginLeft: 6,
                              padding: '1px 5px',
                              borderRadius: 4,
                              background: 'var(--bg-elev)',
                              color: 'var(--text-muted)',
                              fontSize: 10,
                            }}
                          >
                            {l.agent}
                          </span>
                        )}
                      </div>
                      <div
                        className="act-meta"
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          color: 'var(--text-muted)',
                          marginTop: 2,
                        }}
                      >
                        {l.meta}
                      </div>
                    </div>
                    <span
                      className="act-time"
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '10px',
                        color: 'var(--text-faint)',
                        alignSelf: 'start',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {l.time} <span style={{ marginLeft: 3 }}>{open ? '▲' : '▼'}</span>
                    </span>
                  </div>
                  {open && (
                    <div
                      className="act-meta"
                      style={{
                        padding: '6px 0 2px 26px',
                        fontSize: 11,
                        lineHeight: 1.5,
                        color: 'var(--text-muted)',
                        borderTop: '1px dashed var(--border)',
                      }}
                    >
                      {l.detail || l.meta}
                      {l.txHash && (
                        <div style={{ marginTop: 4 }}>
                          TX:{' '}
                          <a
                            href={`https://stellar.expert/explorer/testnet/tx/${l.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: 'var(--accent)', textDecoration: 'underline' }}
                          >
                            {shortAddr(l.txHash)} ↗
                          </a>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {totalPages > 1 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 0 4px 0',
                borderTop: '1px solid var(--border)',
                marginTop: 'auto',
              }}
            >
              <button
                className="btn btn-ghost"
                style={{
                  padding: '4px 10px',
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.04em',
                }}
                disabled={currentPage === 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ← Prev
              </button>
              <span
                className="mono"
                style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}
              >
                Page {currentPage} of {totalPages}
              </span>
              <button
                className="btn btn-ghost"
                style={{
                  padding: '4px 10px',
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.04em',
                }}
                disabled={currentPage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

const SkillPanel = ({ skillSource, marketLive, vaultLive, onCustomize }) => {
  const custom = skillSource === 'user-local' || skillSource === 'user-file'
  return (
    <div
      className="panel"
      style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}
    >
      <div
        className="panel-head"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 12,
        }}
      >
        <div
          className="panel-title"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--text)',
          }}
        >
          Vault Advisor Skill
        </div>
        <button
          className="panel-meta skill-customize"
          onClick={onCustomize}
          style={{
            backgroundColor: 'transparent',
            border: 'none',
            color: 'var(--accent)',
            cursor: 'pointer',
            fontFamily: 'var(--font-mono)',
            fontSize: '10.5px',
          }}
        >
          Customize →
        </button>
      </div>
      <div
        style={{
          background: 'linear-gradient(135deg, var(--bg-card) 0%, var(--bg-base) 100%)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-md)',
          padding: '12px 14px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}
      >
        <div
          className="perm-status active"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontFamily: 'var(--font-mono)',
            fontSize: '11.5px',
            color: 'var(--text)',
            marginBottom: 4,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--accent)',
              boxShadow: '0 0 6px var(--accent)',
            }}
          />
          {custom ? 'Custom strategy' : 'Default strategy'}
        </div>
        <div className="skill-sub" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          {custom ? 'Active · user-defined' : '4 vaults · expert framework'}
          {marketLive != null && ` · ${marketLive ? 'Live market' : 'Static context'}`}
          {vaultLive != null && ` · ${vaultLive ? 'Live vaults' : 'Cached'}`}
        </div>
      </div>
    </div>
  )
}

const PALETTES = [
  {
    id: 'acid-yield',
    name: 'Acid Yield',
    swatch: ['#cfff3d', '#1a1b16', '#ecebe1'],
    desc: 'Default · warm dark + acid lime',
  },
  {
    id: 'mono-slate',
    name: 'Mono Slate',
    swatch: ['#e6edff', '#16182e', '#e8ebf3'],
    desc: 'Refined · cool slate, no chroma',
  },
  {
    id: 'liquid-mint',
    name: 'Liquid Mint',
    swatch: ['#5ee6c5', '#11201b', '#ecebe1'],
    desc: 'Teal undertone · mint accent',
  },
  {
    id: 'bone-paper',
    name: 'Bone Paper',
    swatch: ['#1a180f', '#e3dfd2', '#f4f1e9'],
    desc: 'Light · editorial paper feel',
  },
]

const PalettePicker = ({ value, onChange }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    {PALETTES.map((p) => {
      const on = p.id === value
      return (
        <button
          key={p.id}
          type="button"
          onClick={() => onChange(p.id)}
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto',
            alignItems: 'center',
            gap: 10,
            padding: '8px 10px',
            border: on ? '1px solid var(--border-accent)' : '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            background: on ? 'var(--bg-elev)' : 'var(--bg-card)',
            cursor: 'pointer',
            textAlign: 'left',
            font: 'inherit',
            color: 'inherit',
            transition:
              'background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease, transform 160ms var(--ease-out)',
            boxShadow: on ? '0 0 12px var(--accent-soft)' : 'none',
          }}
        >
          <div style={{ display: 'flex', gap: 3 }}>
            {p.swatch.map((c, i) => (
              <span
                key={i}
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  background: c,
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              />
            ))}
          </div>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontWeight: 600,
                fontSize: 11.5,
                color: on ? 'var(--accent)' : 'var(--text)',
              }}
            >
              {p.name}
            </div>
            <div
              style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.3 }}
            >
              {p.desc}
            </div>
          </div>
          <span
            style={{
              fontSize: 12,
              fontWeight: 'bold',
              color: on ? 'var(--accent)' : 'transparent',
            }}
          >
            ✓
          </span>
        </button>
      )
    })}
  </div>
)

export { WalletPanel, PermissionPanel, ActivityPanel, SkillPanel, PalettePicker, PALETTES }
