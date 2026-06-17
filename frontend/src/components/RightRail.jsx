// RightRail.jsx — right-rail components extracted from app.jsx
import React, { useState as useS } from 'react';
import { Icon } from '../components.jsx';
import { shortAddr } from '../screens.jsx';
import { fmtRemaining } from '../ui.js';

/* ---------- Right rail panels ---------- */
const WalletPanel = ({ phase, address }) => {
  const [copied, setCopied] = useS(false);
  if (phase === "none") {
    return (
      <div className="panel">
        <div className="panel-head">
          <div className="panel-title">Wallet</div>
          <span className="panel-meta">Not connected</span>
        </div>
        <div className="empty">Not connected yet</div>
      </div>
    );
  }
  const isSmart = phase === "upgraded";
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title">Wallet</div>
        <span className="panel-meta">{isSmart ? "Smart account" : "EOA"}</span>
      </div>
      <div className="wallet-row">
        <div>
          <div className="wallet-addr">{shortAddr(address)}</div>
          <div className={`wallet-type ${isSmart ? "active" : ""}`}>
            {isSmart ? "EIP-7702 active" : "Regular EOA"}
          </div>
        </div>
        <div className="wallet-actions">
          <button
            className="wallet-action"
            title={copied ? "Copied" : "Copy address"}
            aria-label="Copy address"
            onClick={async () => {
              try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1200); }
              catch (e) { console.warn("[wallet] clipboard failed:", e); }
            }}
          >
            <Icon name={copied ? "check" : "copy"} />
          </button>
          <a
            className="wallet-action"
            title="View on Basescan"
            aria-label="View on Basescan"
            href={`https://sepolia.basescan.org/address/${address}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="external" />
          </a>
        </div>
      </div>
    </div>
  );
};

const PermissionPanel = ({ active, strategy, onRevoke, expiresAt }) => {
  const agents = strategy?.agents || [];
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title">Active permissions</div>
        <span className="panel-meta">ERC-7715 · batch</span>
      </div>
      <div className={`perm-status ${active ? "active" : ""}`}>
        {active ? `${agents.length} permission · ${fmtRemaining(expiresAt) || '-'}` : "No active permission"}
      </div>
      {active && agents.length > 0 && (
        <>
          <div className="perm-agent-list">
            {agents.map((a) => (
              <div key={a.id} className="perm-agent-row">
                <span className="idx mono">{a.idx}</span>
                <div className="meta-col">
                  <div className="agent-name">{a.id}</div>
                  <div className="mono agent-vault">{a.vault.addr.slice(0, 8)}…{a.vault.addr.slice(-4)}</div>
                </div>
                <div className="mono amount tnum">{a.allocation} USDC</div>
              </div>
            ))}
          </div>
          <button className="perm-revoke" onClick={onRevoke}>
            Revoke all permissions
          </button>
        </>
      )}
    </div>
  );
};

const EVENT_STYLES = {
  AgentStarted:        { icon: "●", color: "var(--warn)" },
  SwapExecuted:        { icon: "↻", color: "var(--info)" },
  ApproveExecuted:     { icon: "✓", color: "var(--info)" },
  DepositExecuted:     { icon: "↓", color: "var(--info)" },
  AgentCompleted:      { icon: "✓", color: "var(--ok)" },
  AgentFailed:         { icon: "✕", color: "var(--danger)" },
  RedelegationCreated:  { icon: "⇄", color: "var(--info)" },
  RedelegationRedeemed: { icon: "✓", color: "var(--ok)" },
  OrchestratorPlanned: { icon: "·", color: "var(--text-muted)" },
  PermissionGranted:   { icon: "·", color: "var(--text-muted)" },
  Connected:           { icon: "·", color: "var(--text-muted)" },
  Authorized:          { icon: "·", color: "var(--text-muted)" },
  PermissionRevoked:   { icon: "·", color: "var(--danger)" },
  SkillApproved:       { icon: "·", color: "var(--text-muted)" },
};

const ActivityPanel = ({ logs }) => {
  const [openId, setOpenId] = useS(null);
  const [page, setPage] = useS(1);

  const pageSize = 5;
  const totalPages = Math.ceil(logs.length / pageSize) || 1;
  const currentPage = Math.min(page, totalPages);

  const reversedLogs = logs.slice().reverse();
  const startIndex = (currentPage - 1) * pageSize;
  const pagedLogs = reversedLogs.slice(startIndex, startIndex + pageSize);

  return (
    <div className="panel" style={{ borderBottom: "none", flex: 1, display: "flex", flexDirection: "column" }}>
      <div className="panel-head">
        <div className="panel-title">Activity</div>
        <span className="panel-meta">{logs.length ? `${logs.length} events · realtime` : "Agent events · realtime"}</span>
      </div>
      {logs.length === 0 ? (
        <div className="empty">No events yet</div>
      ) : (
        <>
          <div className="activity" style={{ flex: 1 }}>
            {pagedLogs.map((l) => {
              const sty = EVENT_STYLES[l.event] || EVENT_STYLES.OrchestratorPlanned;
              const open = openId === l.id;
              return (
                <div key={l.id}>
                  <div className="act-row" style={{ cursor: "pointer" }} role="button" tabIndex={0} aria-expanded={open}
                    onClick={() => setOpenId(open ? null : l.id)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenId(open ? null : l.id); } }}>
                    <span className="act-marker mono" aria-hidden="true" style={{ color: sty.color }}>{sty.icon}</span>
                    <div>
                      <div className="act-title">
                        <span className="act-event mono">{l.event}</span>
                        {l.agent && <span className="act-agent mono">{l.agent}</span>}
                      </div>
                      <div className="act-meta">{l.meta}</div>
                    </div>
                    <span className="act-time">{l.time} {open ? "▴" : "▾"}</span>
                  </div>
                  {open && (
                    <div className="act-meta" style={{ padding: "2px 0 8px 22px", fontSize: 10.5, lineHeight: 1.5, opacity: .85 }}>
                      {l.detail || l.meta}
                      {l.txHash && (
                        <div style={{ marginTop: 3 }}>
                          TX: <a href={`https://sepolia.basescan.org/tx/${l.txHash}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--info)" }}>{shortAddr(l.txHash)} ↗</a>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 0 4px 0',
              borderTop: '1px solid var(--border)',
              marginTop: 'auto'
            }}>
              <button
                className="btn btn-ghost"
                style={{
                  padding: '4px 10px',
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.04em'
                }}
                disabled={currentPage === 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ← Prev
              </button>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                Page {currentPage} of {totalPages}
              </span>
              <button
                className="btn btn-ghost"
                style={{
                  padding: '4px 10px',
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.04em'
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
  );
};

const SkillPanel = ({ skillSource, marketLive, vaultLive, onCustomize }) => {
  const custom = skillSource === "user-local" || skillSource === "user-file";
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title">Vault Advisor Skill</div>
        <button className="panel-meta skill-customize" onClick={onCustomize}>Customize →</button>
      </div>
      <div className="perm-status active">
        {custom ? "Custom strategy" : "Default strategy by Vibing Farmer"}
      </div>
      <div className="skill-sub">
        {custom ? "Active · user-defined" : "4 vaults · expert framework"}
        {marketLive != null && ` · ${marketLive ? "Live market data" : "Static context"}`}
        {vaultLive != null && ` · ${vaultLive ? "Live vault data" : "Cached vaults"}`}
      </div>
    </div>
  );
};

const PALETTES = [
  { id: "acid-yield", name: "Acid Yield", swatch: ["#cfff3d", "#1a1b16", "#ecebe1"], desc: "Default · warm dark + acid lime" },
  { id: "mono-slate", name: "Mono Slate", swatch: ["#e6edff", "#16182e", "#e8ebf3"], desc: "Refined · cool slate, no chroma" },
  { id: "liquid-mint", name: "Liquid Mint", swatch: ["#5ee6c5", "#11201b", "#ecebe1"], desc: "Teal undertone · mint accent" },
  { id: "bone-paper", name: "Bone Paper", swatch: ["#1a180f", "#e3dfd2", "#f4f1e9"], desc: "Light · editorial paper feel" },
];

const PalettePicker = ({ value, onChange }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
    {PALETTES.map((p) => {
      const on = p.id === value;
      return (
        <button
          key={p.id}
          type="button"
          onClick={() => onChange(p.id)}
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr auto",
            alignItems: "center",
            gap: 10,
            padding: "7px 9px",
            border: on ? ".5px solid rgba(0,0,0,.35)" : ".5px solid rgba(0,0,0,.08)",
            borderRadius: 7,
            background: on ? "rgba(255,255,255,.85)" : "rgba(255,255,255,.4)",
            cursor: "pointer",
            textAlign: "left",
            font: "inherit",
            color: "inherit",
          }}
        >
          <div style={{ display: "flex", gap: 2 }}>
            {p.swatch.map((c, i) => (
              <span key={i} style={{
                width: 12, height: 12, borderRadius: 3,
                background: c, border: ".5px solid rgba(0,0,0,.1)",
              }} />
            ))}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500, fontSize: 11.5 }}>{p.name}</div>
            <div style={{ fontSize: 10, color: "rgba(41,38,27,.55)", marginTop: 1, lineHeight: 1.3 }}>
              {p.desc}
            </div>
          </div>
          <span style={{ fontSize: 11, color: on ? "rgba(41,38,27,.7)" : "transparent" }}>✓</span>
        </button>
      );
    })}
  </div>
);

export { WalletPanel, PermissionPanel, ActivityPanel, SkillPanel, PalettePicker, PALETTES };
