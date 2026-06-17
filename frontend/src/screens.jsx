/* ============================================
   VIBING FARMER — screens (multi-agent edition)
   ============================================ */
import React, { useState, useEffect } from 'react';
import { Icon } from './components.jsx';
import { loadSettings, t } from './settingsStore.js';

const shortAddr = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";

const RISK_OPTIONS = [
  { id: "low", label: "Low", sub: "1 agent · single vault" },
  { id: "med", label: "Medium", sub: "2 agents · balanced" },
  { id: "high", label: "High", sub: "3 agents · diversified" },
];

/* ============================================
   01a — INPUT
   ============================================ */
const InputScreen = ({ amount, setAmount, risk, setRisk, onSubmit }) => {
  const { language: lang } = loadSettings()
  const valid = Number(amount) > 0 && risk;
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,.04)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 14px', marginBottom: 16, fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
          <span style={{ color: 'var(--ok)', fontSize: 9 }}>●</span>
          <span style={{ color: 'var(--text-muted)' }}>
            Farming <strong style={{ color: 'inherit', fontWeight: 600, fontFamily: 'inherit' }}>{prefill.name}</strong> · {Number(prefill.apy).toFixed(1)}% APY
          </span>
        </div>
      )}
      <div className="eyebrow">
        <span className="num">01</span>
        <span>AI Strategy · live RAG · multi-agent</span>
        <span className="rule" />
        <span>06 steps</span>
      </div>

      <h1 className="h-display">
        Set your deposit · let the orchestrator spawn the agents.
      </h1>
      <p className="lede">
        AI generates the strategy: how many worker agents are needed, which vault each agent handles,
        and which skills they run. All transactions are relayed via 1Shot, so you pay zero gas. The permissions you grant
        are scoped per agent · no agent can act outside its designated vault boundaries.
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
                className={`risk-opt ${risk === r.id ? "selected" : ""}`}
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
        <div className="foot-note">
          <span className="ai-attribution">
            ● AI · live data
          </span>
        </div>
        <button className="btn btn-primary btn-lg" disabled={!valid} onClick={onSubmit}>
          {t(lang, 'getReco')} <Icon name="arrow" size={14} />
        </button>
      </div>
    </section>
  );
};

/* ============================================
   01b — AI Thinking (strategy generation)
   ============================================ */
const THINK_STEPS = [
  { label: "Scanning 24 active vaults on Base Sepolia" },
  { label: "Structuring allocation per risk profile" },
  { label: "Generating strategy via AI" },
];

const THINK_MSGS = [
  "AI is analyzing vault strategy…",
  "Determining the optimal vault strategy…",
  "Calculating optimal allocation per risk profile…",
  "Validating vault addresses & expected APY…",
];

const ThinkingCard = ({ phase, times = [] }) => {
  // Live count-up for the active step — the AI step keeps ticking until generateStrategy resolves
  const [live, setLive] = React.useState(0);
  React.useEffect(() => {
    setLive(0);
    const start = performance.now();
    const iv = setInterval(() => setLive((performance.now() - start) / 1000), 80);
    return () => clearInterval(iv);
  }, [phase]);

  const [msgI, setMsgI] = React.useState(0);
  React.useEffect(() => {
    if (phase !== 2) return;            // only while strategy generation is running
    setMsgI(0);
    const iv = setInterval(() => setMsgI((i) => (i + 1) % THINK_MSGS.length), 2500);
    return () => clearInterval(iv);
  }, [phase]);

  return (
    <section className="thinking enter">
      <div className="eyebrow">
        <span className="num">01</span>
        <span>AI Swarm · deepseek-v4-flash · orchestrator planning</span>
      </div>
      <h2 className="thinking-title">Formulating multi-agent strategy…</h2>

      <div className="thinking-list">
        {THINK_STEPS.map((s, i) => {
          const state = i < phase ? "done" : i === phase ? "active" : "idle";
          const t = i === phase ? live : times[i];
          return (
            <div key={i} className={`think-step ${state}`}>
              <span className="marker" />
              <span>{s.label}</span>
              <span className="time">
                {state === "idle" ? "-" : `${(t ?? 0).toFixed(1)}s`}
                {state === "active" && <span className="think-spin" aria-hidden="true" />}
              </span>
            </div>
          );
        })}
      </div>

      {phase === 2 && <div key={msgI} className="thinking-status">{THINK_MSGS[msgI]}</div>}
    </section>
  );
};

/* ============================================
   02 — Connect & EIP-7702 upgrade
   ============================================ */
const ConnectCard = ({ phase, error, mmVersion, onConnect, onUpgrade, onDone, onCancel }) => {
  return (
    <section className="card enter">
      <div className="eyebrow">
        <span className="num">02</span>
        <span>Connect · EIP-7702 upgrade</span>
        <span className="rule" />
        <span>required for ERC-7715</span>
      </div>

      <h1 className="h-display">
        Upgrade your account to a smart account · single signature, reversible.
      </h1>
      <p className="lede">
        Your MetaMask account is currently a standard EOA. EIP-7702 sets delegation code on your existing account,
        activating it as a smart account without changing wallets. Afterwards, the orchestrator can spawn worker
        agents, each with scoped permissions.
      </p>

      {mmVersion && mmVersion.type !== "none" && (
        <div className="mono" style={{ fontSize: 11, marginTop: 14, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", color: mmVersion.supportsERC7715 ? "var(--ok)" : "var(--warn)" }}>
          <span style={{ fontSize: 8 }}>●</span>
          {mmVersion.isFlask ? (
            <span>MetaMask Flask {mmVersion.version} ✓ · ERC-7715 supported</span>
          ) : (
            <>
              <span>MetaMask stable detected · Flask required for permissions</span>
              <a href="https://metamask.io/flask/" target="_blank" rel="noopener noreferrer" className="accent" style={{ textDecoration: "none" }}>Switch to Flask →</a>
            </>
          )}
        </div>
      )}

      {phase === "idle" && (
        <div className="action-row">
          <div className="foot-note">Ensure MetaMask Flask is connected to the <b>Base Sepolia</b> testnet.</div>
          <button className="btn btn-primary btn-lg" onClick={onConnect}>
            Connect MetaMask <Icon name="arrow" size={14} />
          </button>
        </div>
      )}

      {phase === "connecting" && (
        <MmDialog
          domain="vibing-farmer.app"
          title="Connection request"
          rows={[
            { k: "request", v: "eth_requestAccounts" },
            { k: "network", v: "Base Sepolia · 84532" },
            { k: "status", v: "awaiting user…" },
          ]}
          pending
        />
      )}

      {phase === "connected" && (
        <>
          <MmDialog
            domain="vibing-farmer.app"
            title="EIP-7702 authorization"
            rows={[
              { k: "delegate to", v: "MetaMask Smart Account v1.2", accent: true },
              { k: "chainId", v: "84532" },
              { k: "nonce", v: "7" },
              { k: "expiry", v: "ephemeral · single tx" },
            ]}
          />
          <div className="action-row">
            <div className="foot-note">Authorization transaction will be relayed via 1Shot · gas <b>0</b>.</div>
            <div className="flex gap-2">
              <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
              <button className="btn btn-primary" onClick={onUpgrade}>
                Sign authorization <Icon name="arrow" size={14} />
              </button>
            </div>
          </div>
        </>
      )}

      {phase === "upgrading" && (
        <MmDialog
          domain="MetaMask Flask"
          title="Smart account active"
          rows={[
            { k: "type", v: "EIP-7702 · delegated EOA", accent: true },
            { k: "relayer", v: "1Shot Permissionless · EIP-7710" },
            { k: "gas paid", v: "by relayer · user 0 ETH", accent: true },
            { k: "status", v: "confirming…" },
          ]}
          pending
        />
      )}

      {phase === "upgraded" && (
        <UpgradedCallout onDone={onDone} />
      )}

      {error && <div role="alert" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 10 }}>{error}</div>}
    </section>
  );
};

const MmDialog = ({ domain, title, rows, pending }) => (
  <div className="mm-pop enter">
    <div className="mm-pop-head">
      <div className="mm-brand">
        <div className="mm-mark">
          <img 
            src="https://images.ctfassets.net/clixtyxoaeas/4ES1xXFPTzqLsOumTgHcMd/e5bcf8648eeea657850731684ee4942b/MetaMask-icon-fox-developer.svg" 
            alt="MetaMask Logo" 
            style={{ width: 14, height: 14, display: "block" }} 
          />
        </div>
        <span className="mm-name">MetaMask</span>
      </div>
      <span className="mm-domain">{domain}</span>
    </div>
    <div className="mono" style={{ fontSize: 12, color: "var(--text)", marginBottom: 12, letterSpacing: "-0.01em" }}>
      {title}{pending ? "…" : ""}
    </div>
    <div className="mm-body">
      {rows.map((r, i) => (
        <div key={i} className="row">
          <span className="k">{r.k}</span>
          <span className={`v ${r.accent ? "accent" : ""}`}>{r.v}</span>
        </div>
      ))}
    </div>
  </div>
);

const UpgradedCallout = ({ onDone }) => (
  <div className="enter" style={{ marginTop: 28 }}>
    <div style={{
      borderTop: "1px solid var(--border)",
      borderBottom: "1px solid var(--border)",
      padding: "24px 0",
      display: "grid",
      gridTemplateColumns: "1fr auto",
      gap: 18,
      alignItems: "center",
    }}>
      <div>
        <div className="mono" style={{ fontSize: 11, color: "var(--accent)", letterSpacing: "-0.01em", marginBottom: 8 }}>
          ✓ smart account active
        </div>
        <div className="h-sub">EOA successfully upgraded. EIP-7702 is active via MetaMask SAK.</div>
        <div className="mono" style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6, letterSpacing: "-0.01em" }}>
          eip-7702 · handled internally by MetaMask Flask · gas 0
        </div>
      </div>
      <button className="btn btn-primary" onClick={onDone}>
        Next · review skills <Icon name="arrow" size={14} />
      </button>
    </div>
  </div>
);

/* ============================================
   04 — Permission scope (multi-agent batched)
   ============================================ */
const PermissionCard = ({ strategy, onGrant, phase, error, onConfirm, onReject }) => {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const expiresFmt = expiresAt.toLocaleString("en-US", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const agents = strategy?.agents || [];
  const totalMax = agents.reduce((s, a) => s + a.allocation, 0);

  return (
    <section className="card enter">
      <div className="eyebrow">
        <span className="num">04</span>
        <span>Scoped permission · ERC-7715 · sign once</span>
        <span className="rule" />
        <span>then fully autonomous · ERC-7710 redemption</span>
      </div>

      <h1 className="h-display">
        Sign once. Every agent runs without another popup.
      </h1>
      <p className="lede">
        This single signature grants a scoped, expiring permission. From here, the orchestrator and every worker
        execute Swap → Approve → Deposit by <b>redeeming</b> this grant — no further MetaMask prompts. Outside the
        granted scope, <span className="mono">AgentVaultDepositor.sol</span> still <b>reverts</b>.
      </p>

      <div className="perm-doc">
        <div className="perm-doc-row perm-doc-summary">
          <div className="perm-doc-k">batch.summary</div>
          <div className="perm-doc-v">
            {agents.length} permission · total max <span className="accent">{totalMax.toFixed(2)} USDC</span>
            <span className="annot">expires {expiresFmt}</span>
          </div>
        </div>
        {agents.map((a) => (
          <div className="perm-doc-row perm-doc-agent" key={a.id}>
            <div className="perm-doc-k">
              <span className="perm-doc-agent-idx mono">{a.idx}</span> {a.id}
            </div>
            <div className="perm-doc-v">
              <div className="perm-doc-agent-line">
                <span className="mono perm-doc-agent-vault">{a.vault.addr.slice(0, 14)}…{a.vault.addr.slice(-4)}</span>
                <span className="annot">{a.vault.protocol}</span>
              </div>
              <div className="perm-doc-agent-line">
                <span className="accent">{a.allocation} USDC max</span>
                <span className="annot">hard cap · exceed = revert</span>
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
          <div className="perm-doc-k">revocable</div>
          <div className="perm-doc-v">
            yes · per-agent or batched
            <span className="annot">anytime · single click · on-chain</span>
          </div>
        </div>
      </div>

      <div className="action-row">
        <div className="foot-note">
          Each agent <b>has no access</b> to other agents' vaults. The contract validates every call.
        </div>
        {phase === "idle" && (
          <button className="btn btn-primary btn-lg" onClick={onGrant}>
            Grant {agents.length} permission{agents.length === 1 ? "" : "s"} <Icon name="arrow" size={14} />
          </button>
        )}
        {phase === "prompting" && (
          <span className="foot-note mono">awaiting metamask…</span>
        )}
      </div>

      {phase === "prompting" && (
        <MmPermissionModal strategy={strategy} onConfirm={onConfirm} onReject={onReject} />
      )}

      {error && <div role="alert" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 10 }}>{error}</div>}
    </section>
  );
};

const MmPermissionModal = ({ strategy, onConfirm, onReject }) => {
  const agents = strategy?.agents || [];
  const total = agents.reduce((s, a) => s + a.allocation, 0);
  return (
    <div className="modal-backdrop" onClick={onReject}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-eyebrow">wallet_requestExecutionPermissions · batch</div>
        <h3 className="modal-title">Approve {agents.length} execution permission{agents.length === 1 ? "" : "s"}?</h3>

        <div className="mm-pop" style={{ marginTop: 0 }}>
          <div className="mm-pop-head">
            <div className="mm-brand">
              <div className="mm-mark">
                <img 
                  src="https://images.ctfassets.net/clixtyxoaeas/4ES1xXFPTzqLsOumTgHcMd/e5bcf8648eeea657850731684ee4942b/MetaMask-icon-fox-developer.svg" 
                  alt="MetaMask Logo" 
                  style={{ width: 14, height: 14, display: "block" }} 
                />
              </div>
              <span className="mm-name">MetaMask</span>
            </div>
            <span className="mm-domain">vibing-farmer.app</span>
          </div>
          <div className="mm-body">
            <div className="row"><span className="k">batch type</span><span className="v accent">vault-deposit · {agents.length}x</span></div>
            <div className="row"><span className="k">total max</span><span className="v accent">{total.toFixed(2)} USDC</span></div>
            {agents.map((a) => (
              <div className="row" key={a.id}>
                <span className="k">{a.id}</span>
                <span className="v">{a.allocation} USDC · {a.vault.addr.slice(0, 10)}…</span>
              </div>
            ))}
            <div className="row"><span className="k">expires</span><span className="v">86 400s</span></div>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onReject}>Reject</button>
          <button className="btn btn-primary" onClick={onConfirm}>Approve batch</button>
        </div>
      </div>
    </div>
  );
};

/* ============================================
   06 — Success (multi-agent summary)
   ============================================ */
const SuccessCard = ({ strategy, onAgain, address }) => {
  const total = strategy?.total ?? 100;
  const apy = strategy?.blendedApy ?? "8.2";
  const monthly = (total * (Number(apy) / 100) / 12).toFixed(2);
  const agents = strategy?.agents || [];
  return (
    <section className="success-card enter">
      <div className="eyebrow">
        <span className="num">06</span>
        <span>{agents.length} agent · {agents.length * 3} tx confirmed</span>
        <span className="rule" />
        <span>≈ 42 detik total</span>
      </div>

      <h1 className="success-title">
        Multi-agent deployment confirmed. {agents.length} workers are now earning {apy}% blended APY.
      </h1>

      <div className="success-numbers">
        <div className="success-num-cell">
          <span className="label">total deposited</span>
          <span className="figure tnum">{total}<span className="unit">USDC</span></span>
        </div>
        <div className="success-num-cell">
          <span className="label">est. yield /month</span>
          <span className="figure tnum" style={{ color: "var(--accent)" }}>
            +{monthly}<span className="unit">USDC</span>
          </span>
        </div>
        <div className="success-num-cell">
          <span className="label">user signatures</span>
          <span className="figure tnum">2</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-faint)", letterSpacing: "-0.01em", marginTop: -4 }}>
            vs {agents.length * 3 + 2} traditional
          </span>
        </div>
      </div>

      <div className="success-agents">
        {agents.map((a) => (
          <div key={a.id} className="success-agent-row">
            <span className="mono idx">{a.idx}</span>
            <div>
              <div className="name">{a.name}</div>
              <div className="meta mono">{a.vault.name} · {a.vault.protocol}</div>
            </div>
            <div className="value mono tnum">{a.allocation} USDC <span className="muted">→ {a.vault.apy}%</span></div>
          </div>
        ))}
      </div>

      <div className="action-row" style={{ marginTop: 36 }}>
        <div className="foot-note">
          Basescan · <span style={{ color: "var(--text)" }}>{agents.length * 3} tx confirmed</span> ·
          gas paid by <b>1Shot relayer</b>
        </div>
        <div className="flex gap-2">
          <a
            className="btn btn-ghost"
            href={address ? `https://sepolia.basescan.org/address/${address}` : "https://sepolia.basescan.org"}
            target="_blank"
            rel="noopener noreferrer"
          >
            View on Basescan <Icon name="external" size={13} />
          </a>
          <button className="btn btn-primary" onClick={onAgain}>
            Deposit again <Icon name="plus" size={14} />
          </button>
        </div>
      </div>
    </section>
  );
};

export {
  InputScreen, ThinkingCard, ConnectCard,
  PermissionCard, SuccessCard, shortAddr,
  THINK_STEPS, MmDialog,
};
