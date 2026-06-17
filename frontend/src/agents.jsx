/* ============================================
   VIBING FARMER — Agent Graph + Memory (step 05)
   Hierarchical vis.js Network:
     Orchestrator → Worker Agents → Step nodes (Swap/Approve/Deposit) → Vault nodes
   Node colors driven by state: idle / running / confirmed / failed
   ============================================ */
import React, {
  useEffect as useEAg, useMemo as useMAg, useCallback as useCAg,
  useRef as useRAg, useState as useSAg,
} from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { Icon } from './components.jsx';
import { shortAddr } from './screens.jsx';
import { VAULT_CATALOG } from './config.js';
import { buildStrategyState, scoreReward, riskCeiling } from './strategy/mdp.js';

/* ---------- Strategy data — generated per-flow ---------- */
// Derived from VAULT_CATALOG so addresses stay in sync with config automatically.
const ROLES = ["Conservative · lending", "Balanced · liquidity provision", "Aggressive · leveraged yield"];
const AGENT_PROTOCOLS = VAULT_CATALOG.slice(0, 3).map((v, i) => ({
  name: v.name,
  protocol: v.protocol,
  apy: String(v.apy),
  drawdown: v.drawdown,
  addr: v.address,
  role: ROLES[i],
}));

const buildStrategy = (amount, risk) => {
  const total = Number(amount) || 100;
  // Allocation profile per risk
  const splitMap = {
    low:    [{ pct: 1.00, agents: 1 }],
    med:    [{ pct: 0.60, agents: 1 }, { pct: 0.40, agents: 1 }],
    high:   [{ pct: 0.40, agents: 1 }, { pct: 0.35, agents: 1 }, { pct: 0.25, agents: 1 }],
  };
  const config = splitMap[risk] || splitMap.low;
  const agents = config.map((c, i) => {
    const proto = AGENT_PROTOCOLS[i];
    const allocation = +(total * c.pct).toFixed(2);
    return {
      id: `worker-${i + 1}`,
      idx: String(i + 1).padStart(2, "0"),
      name: `Worker ${i + 1} · ${proto.role.split(" · ")[0]}`,
      role: proto.role,
      allocation,
      skillName: "yield_vault_deposit",
      vault: proto,
    };
  });
  const blendedApy = agents.reduce((acc, a, i) => acc + Number(a.vault.apy) * (a.allocation / total), 0);
  // Formal MDP reward for the offline fallback strategy (no AI / no live market).
  const mdpFullState = buildStrategyState({ amountUsdc: total, riskLevel: risk, numVaults: agents.length, vaultData: VAULT_CATALOG, marketContext: null });
  const fallbackAllocations = agents.map((a) => ({ address: a.vault.addr || a.vault.address, allocation: a.allocation / total, apy: Number(a.vault.apy), risk_tier: a.vault.risk }));
  const reward = scoreReward(fallbackAllocations, mdpFullState);
  return {
    agents,
    total,
    blendedApy: blendedApy.toFixed(1),
    risk,
    reward,
    mdpState: { turbulence: 'calm', signals: [], universeSize: VAULT_CATALOG.length, riskCeiling: riskCeiling(mdpFullState), profileRisk: mdpFullState.profile.riskLevel, capitalUsdc: total, actionViolations: [] },
  };
};

/* ---------- Agent execution state model ---------- */
const STEP_IDS = ["swap", "approve", "deposit"];
const STEP_LABELS = { swap: "Swap", approve: "Approve", deposit: "Deposit" };
const STEP_NOTE = { swap: "skipped · USDC→USDC needs no swap" };

const makeInitialExecState = (agents) => {
  const map = {};
  agents.forEach((a) => {
    map[a.id] = {
      status: "idle",      // idle | running | confirmed | failed
      activeStep: null,
      steps: { swap: "idle", approve: "idle", deposit: "idle" },
      hashes: {},
      memory: [],          // run log
      metrics: { totalRuns: 0, successRate: null, avgGasCost: 0, startedAt: null, completedAt: null },
    };
  });
  return map;
};

/* ============================================
   Agent Graph — state palette + helpers
   ============================================ */
const GRAPH_COLOR = {
  idle:      "#3a3b33",
  running:   "#f0b54a",
  confirmed: "#6fe39a",
  skipped:   "#6b7280",
  failed:    "#ff7479",
};
const GRAPH_COLOR_LIGHT = {
  idle:      "#b8b5aa",
  running:   "#b07a1a",
  confirmed: "#2d7a4a",
  skipped:   "#6b7280",
  failed:    "#a83a3a",
};
const GROUP_BASE = { orchestrator: "#cfff3d", vault: "#6366f1" };

const computeOrchestratorState = (execMap) => {
  const vals = Object.values(execMap);
  if (vals.some((a) => a.status === "failed")) return "failed";
  if (vals.every((a) => a.status === "confirmed")) return "confirmed";
  if (vals.some((a) => a.status === "running")) return "running";
  return "idle";
};

/* ============================================
   Agent Graph — force-directed network (Obsidian-style)
   Topology: Orchestrator → Workers → Steps (Swap/Approve/Deposit) → Vault
   ============================================ */
const NODE_R = { orchestrator: 9, worker: 6.5, step: 4, vault: 6.5 };

// Stable node/link objects — only rebuilt when the strategy changes,
// so the physics simulation keeps positions across exec-state updates.
const buildGraphData = (strategy) => {
  const nodes = [{ id: "orchestrator", name: "Orchestrator", kind: "orchestrator" }];
  const links = [];
  strategy.agents.forEach((a) => {
    nodes.push({ id: a.id, name: `W${a.idx} · ${a.vault.protocol}`, kind: "worker", agentId: a.id });
    links.push({ source: "orchestrator", target: a.id });
    let prev = a.id;
    STEP_IDS.forEach((sid) => {
      const id = `${a.id}-${sid}`;
      nodes.push({ id, name: STEP_LABELS[sid], kind: "step", agentId: a.id, stepId: sid });
      links.push({ source: prev, target: id });
      prev = id;
    });
    const vId = `${a.id}-vault`;
    nodes.push({ id: vId, name: `Vault · ${a.vault.apy}%`, kind: "vault", agentId: a.id });
    links.push({ source: prev, target: vId });
  });
  return { nodes, links };
};

const stepState = (ex) => {
  const d = ex.steps?.deposit;
  return d === "confirmed" ? "confirmed" : d === "running" ? "running" : d === "failed" ? "failed" : "idle";
};

const nodeColor = (node, execMap, palette) => {
  if (node.kind === "orchestrator") {
    const s = computeOrchestratorState(execMap);
    return s === "idle" ? GROUP_BASE.orchestrator : (palette[s] || palette.idle);
  }
  const ex = execMap[node.agentId] || { status: "idle", steps: {} };
  if (node.kind === "worker") return palette[ex.status] || palette.idle;
  if (node.kind === "step") return palette[ex.steps?.[node.stepId] || "idle"] || palette.idle;
  const s = stepState(ex);
  return s === "idle" ? GROUP_BASE.vault : (palette[s] || palette.idle);
};

const nodeRunning = (node, execMap) => {
  if (node.kind === "orchestrator") return computeOrchestratorState(execMap) === "running";
  const ex = execMap[node.agentId] || { status: "idle", steps: {} };
  if (node.kind === "worker") return ex.status === "running";
  if (node.kind === "step") return ex.steps?.[node.stepId] === "running";
  return stepState(ex) === "running";
};

const AgentGraph = ({ strategy, execMap, onAgentClick, paletteIsLight }) => {
  const fgRef = useRAg(null);
  const wrapRef = useRAg(null);
  const execRef = useRAg(execMap);
  const fittedRef = useRAg(false);
  const [size, setSize] = useSAg({ w: 0, h: 0 });
  execRef.current = execMap;
  const palette = paletteIsLight ? GRAPH_COLOR_LIGHT : GRAPH_COLOR;
  const data = useMAg(() => buildGraphData(strategy), [strategy]);

  // Measure container so the canvas fills it
  useEAg(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setSize({ w: width, h: height });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // Spread the layout a bit wider than the default
  useEAg(() => {
    const fg = fgRef.current;
    if (!fg || !size.w) return;
    fg.d3Force("charge")?.strength(-90);
    fg.d3Force("link")?.distance(30);
  }, [data, size.w]);

  // Repaint when execution state changes (also gives an Obsidian-like nudge)
  useEAg(() => { fgRef.current?.d3ReheatSimulation(); }, [execMap]);

  const drawNode = useCAg((node, ctx) => {
    const color = nodeColor(node, execRef.current, palette);
    const r = NODE_R[node.kind] || 5;
    if (nodeRunning(node, execRef.current)) { ctx.shadowColor = color; ctx.shadowBlur = 16; }
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = paletteIsLight ? "rgba(0,0,0,0.15)" : "rgba(255,255,255,0.18)";
    ctx.stroke();
    ctx.font = "600 4px Geist, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = paletteIsLight ? "#4a4840" : "#cfcdc4";
    ctx.fillText(node.name, node.x, node.y + r + 1.5);
  }, [palette, paletteIsLight]);

  return (
    <div className="agent-graph" ref={wrapRef}>
      {size.w > 0 && (
        <ForceGraph2D
          ref={fgRef}
          width={size.w}
          height={size.h}
          graphData={data}
          backgroundColor="rgba(0,0,0,0)"
          nodeCanvasObject={drawNode}
          nodePointerAreaPaint={(node, color, ctx) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(node.x, node.y, (NODE_R[node.kind] || 5) + 2, 0, 2 * Math.PI);
            ctx.fill();
          }}
          linkColor={() => (paletteIsLight ? "#c4c1b8" : "#3a3a32")}
          linkWidth={1}
          cooldownTicks={120}
          onEngineStop={() => {
            if (!fittedRef.current && fgRef.current) {
              fgRef.current.zoomToFit(400, 24);
              fittedRef.current = true;
            }
          }}
          onNodeClick={(node) => { if (node.kind === "worker") onAgentClick?.(node.id); }}
        />
      )}
    </div>
  );
};

/* ============================================
   Agent execution legend + summary tiles
   ============================================ */
const AgentTiles = ({ strategy, execMap, onOpenMemory }) => {
  return (
    <div className="agent-tiles">
      {strategy.agents.map((a) => {
        const ex = execMap[a.id] || { status: "idle", steps: {}, memory: [] };
        const doneSteps = STEP_IDS.filter((sid) => ex.steps?.[sid] === "confirmed" || ex.steps?.[sid] === "skipped").length;
        return (
          <button
            key={a.id}
            type="button"
            className={`agent-tile ${ex.status}`}
            onClick={() => onOpenMemory(a.id)}
          >
            <div className="agent-tile-head">
              <span className="idx">{a.idx}</span>
              <span className="name">{a.name}</span>
              <span className={`dot ${ex.status}`} />
            </div>
            <div className="agent-tile-meta mono">
              {a.allocation} USDC · {a.vault.protocol} · {a.vault.apy}%
            </div>
            <div className="agent-tile-steps">
              {STEP_IDS.map((sid) => (
                <span key={sid} className={`agent-step-pip ${ex.steps?.[sid] || "idle"}`} title={ex.steps?.[sid] === "skipped" ? (STEP_NOTE[sid] || STEP_LABELS[sid]) : STEP_LABELS[sid]}>
                  {STEP_LABELS[sid].slice(0, 1).toLowerCase()}
                </span>
              ))}
              <span className="agent-tile-progress mono">{doneSteps}/{STEP_IDS.length}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
};

/* ============================================
   Memory Modal — per-agent execution history
   ============================================ */
const MemoryModal = ({ agentId, strategy, execMap, onClose }) => {
  const agent = strategy.agents.find((a) => a.id === agentId);
  if (!agent) return null;
  const ex = execMap[agentId] || { memory: [], metrics: {}, status: "idle" };
  const stateLabel = {
    idle: "queued · no runs yet",
    running: "running · live execution",
    confirmed: "completed · all steps confirmed",
    failed: "halted · last run failed",
  }[ex.status];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="memory-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="memory-modal-head">
          <div>
            <div className="modal-eyebrow">agent.memory · {agent.id}</div>
            <h3 className="modal-title">{agent.name}</h3>
            <div className="mono memory-modal-sub">{stateLabel}</div>
          </div>
          <button className="icon-btn" aria-label="close" onClick={onClose}><Icon name="x" /></button>
        </div>

        <div className="memory-metrics">
          <div className="memory-metric">
            <span className="label mono">runs</span>
            <span className="val tnum mono">{ex.metrics?.totalRuns ?? 0}</span>
          </div>
          <div className="memory-metric">
            <span className="label mono">success rate</span>
            <span className="val tnum mono">{ex.metrics?.successRate == null ? "-" : `${ex.metrics.successRate}%`}</span>
          </div>
          <div className="memory-metric">
            <span className="label mono">gas paid · user</span>
            <span className="val tnum mono">0 ETH</span>
          </div>
          <div className="memory-metric">
            <span className="label mono">vault apy</span>
            <span className="val tnum mono">{agent.vault.apy}%</span>
          </div>
        </div>

        <div className="memory-section-title mono">execution log</div>
        <div className="memory-log">
          {ex.memory.length === 0 ? (
            <div className="empty">no events yet · agent queued</div>
          ) : (
            ex.memory.map((m, i) => (
              <div key={i} className={`memory-row ${m.status}`}>
                <span className="memory-row-marker" />
                <div className="memory-row-body">
                  <div className="memory-row-title">
                    {m.title}
                    <span className="memory-row-tag mono">{m.status}</span>
                  </div>
                  <div className="memory-row-meta mono">
                    {m.meta}
                    {m.hash && (
                      <>
                        <span className="dot-sep">·</span>
                        <span className="memory-row-hash">tx {shortAddr(m.hash)}</span>
                      </>
                    )}
                  </div>
                  {m.lesson && (
                    <div className="memory-row-lesson mono">
                      <span className="memory-row-lesson-key">lesson</span> {m.lesson}
                    </div>
                  )}
                </div>
                <span className="memory-row-time mono tnum">{m.t}</span>
              </div>
            ))
          )}
        </div>

        <div className="memory-modal-foot">
          <div className="foot-note">
            Memory stored onchain via worker logs · auditable per skill version.
          </div>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};

/* ============================================
   Strategy card (step 02 result) — multi-agent
   ============================================ */

// Alternate-futures Monte Carlo distribution for the proposed allocation.
// Pure presentational — all numbers come pre-computed from runSimulation (simulation.js).
const SCENARIO_META = {
  bull: { label: 'Bull', tone: 'var(--ok)' },
  base: { label: 'Base', tone: 'var(--text)' },
  bear: { label: 'Bear', tone: 'var(--warn, #c87)' },
};

/* ============================================
   AI Council deliberation panel (step 01)
   Three Venice AI specialists deliberate in parallel on the proposed deposit;
   each emits a compressed verdict citing role-scoped playbook rules. Synthesis
   resolves them into keep/discard. (TradingAgents adaptation — see
   planning/inspiration/TradingAgents.md)
   ============================================ */
const COUNCIL_ROLE_META = {
  yield: { label: 'Yield Analyst', glyph: '📈' },
  risk: { label: 'Risk Analyst', glyph: '⚠️' },
  market: { label: 'Market Analyst', glyph: '🌊' },
};
const COUNCIL_SIGNAL_TONE = {
  DEPOSIT: 'var(--ok)',
  HOLD: 'var(--warn, #c87)',
  WITHDRAW: 'var(--bad, #ff7479)',
};
const COUNCIL_RESOLVED_LABEL = {
  veto: 'risk veto',
  unanimous: 'unanimous',
  weighted: 'weighted majority',
  'ai-conflict': 'AI synthesis (split)',
};

const CouncilPanel = ({ council, onRetry }) => {
  if (council === undefined) return null;
  const loading = council === null;
  const unavailable = !loading && council.verdict === 'unavailable';
  const order = ['yield', 'risk', 'market'];
  const specialists = (loading || unavailable) ? [] : [...(council.specialists || [])].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
  const keep = !loading && council.verdict === 'keep';
  return (
    <div className="council-panel">
      <div className="council-head mono">
        <span className="council-title">AI Council · three specialists deliberating</span>
        {!loading && !unavailable && (
          <span className={`council-verdict ${keep ? 'keep' : 'discard'}`}>
            {keep ? 'proceed' : 'caution'} · {COUNCIL_RESOLVED_LABEL[council.resolvedBy] || council.resolvedBy}
          </span>
        )}
      </div>

      {loading ? (
        <div className="council-loading mono">
          <span className="think-spin" /> specialists analyzing yield · risk · market in parallel…
        </div>
      ) : unavailable ? (
        <div className="council-loading mono">
          Council unavailable — the AI provider didn’t respond.
          {onRetry && <button type="button" className="btn btn-ghost council-retry" onClick={onRetry}>Retry deliberation</button>}
        </div>
      ) : (
        <>
          <div className="council-grid">
            {specialists.map((s) => {
              const meta = COUNCIL_ROLE_META[s.role] || { label: s.role, glyph: '•' };
              return (
                <div key={s.role} className="council-spec">
                  <div className="council-spec-head mono">
                    <span className="council-spec-role">{meta.glyph} {meta.label}</span>
                    <span className="council-spec-signal" style={{ color: COUNCIL_SIGNAL_TONE[s.signal] || 'var(--text)' }}>
                      {s.signal}
                    </span>
                  </div>
                  <div className="council-spec-conf mono">
                    <div className="council-conf-track"><div className="council-conf-fill" style={{ width: `${Math.round(s.confidence * 100)}%`, background: COUNCIL_SIGNAL_TONE[s.signal] || 'var(--text)' }} /></div>
                    <span className="tnum">{Math.round(s.confidence * 100)}%</span>
                    <span className="council-spec-src ai">AI</span>
                  </div>
                  {s.citedRules?.length > 0 && (
                    <div className="council-rules">
                      {s.citedRules.map((id) => <span key={id} className="council-rule-chip mono">{id}</span>)}
                    </div>
                  )}
                  {s.concerns?.length > 0 && (
                    <div className="council-concerns mono">⚠ {s.concerns.join(' · ')}</div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="council-foot mono">
            {keep
              ? `Council recommends proceeding (${Math.round(council.confidence * 100)}% confidence). Cited rules earn outcome feedback after deposit.`
              : `Council advises caution${council.reason ? ` · ${council.reason}` : ''}. You can still proceed — the decision is yours.`}
          </div>
        </>
      )}
    </div>
  );
};

const SimulationPanel = ({ simulation }) => {
  if (!simulation || !simulation.scenarios?.length) return null;
  const { scenarios, expectedValue, probProfit, horizonDays, runs, context } = simulation;
  const evTone = expectedValue >= 0 ? 'var(--ok)' : 'var(--warn, #c87)';
  const fmt = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
  return (
    <div className="sim-panel">
      <div className="sim-head mono">
        <span className="sim-title">Simulation engine · alternate futures</span>
        <span className="sim-meta">{runs} runs × {scenarios.length} scenarios · {horizonDays}d horizon · {context.turbulence} regime</span>
      </div>
      <div className="sim-ev">
        <div className="sim-ev-fig">
          <span className="figure figure-md tnum" style={{ color: evTone }}>{fmt(expectedValue)}<span className="unit"> USDC</span></span>
          <span className="label mono">expected value · probability-weighted net yield</span>
        </div>
        <div className="sim-ev-prob mono">
          <span className="tnum" style={{ color: 'var(--text)' }}>{Math.round(probProfit * 100)}%</span>
          <span className="label">chance of profit</span>
        </div>
      </div>
      <div className="sim-grid">
        {scenarios.map((s) => {
          const meta = SCENARIO_META[s.name] || { label: s.name, tone: 'var(--text)' };
          return (
            <div key={s.name} className="sim-scenario">
              <div className="sim-scenario-head mono">
                <span style={{ color: meta.tone }}>● {meta.label}</span>
                <span className="tnum" style={{ color: s.mean >= 0 ? 'var(--ok)' : 'var(--warn, #c87)' }}>{fmt(s.mean)}</span>
              </div>
              <div className="sim-band mono">
                <span className="tnum">{fmt(s.p5)}</span>
                <span className="sim-band-rule" />
                <span className="tnum">{fmt(s.p95)}</span>
              </div>
              <div className="sim-scenario-foot mono">p5–p95 · {Math.round(s.probProfit * 100)}% profit</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const StrategyCard = ({ strategy, skillSource, onProceed, onRegenerate, strategyHash, attestation, attesting, simulation, council, onCouncilRetry }) => {
  const customSkill = skillSource === "user-local" || skillSource === "user-file";
  const shortHash = (h) => h ? `${h.slice(0, 10)}...` : "";
  return (
    <section className="rec-card enter">
      <div className="eyebrow">
        <span className="num">01</span>
        <span>Strategy · {strategy.agents.length} worker{strategy.agents.length === 1 ? "" : "s"} · {strategy.risk} risk</span>
        <span className="rule" />
        <span>{strategy.agents.reduce((n) => n + 1, 0) * 3} on-chain steps</span>
        <span className={`skill-badge ${customSkill ? "custom" : "default"}`} title={`advisor skill: ${skillSource || "default"}`}>
          {customSkill ? "Custom Strategy" : "Default Strategy"}
        </span>
      </div>

      <div className="rec-hgroup">
        <div>
          <div className="rec-vault-name">
            Vibing Farmer · multi-agent
            <div className="strategy-sub mono">
              orchestrator · {strategy.agents.length} parallel workers · single signature
            </div>
          </div>
          <div className="rec-vault-addr">total deposit · {strategy.total} USDC · split across {strategy.agents.length} vault{strategy.agents.length === 1 ? "" : "s"}</div>
        </div>
        <div className="rec-hgroup-apy">
          <span className="figure figure-md tnum">{strategy.blendedApy}<span className="unit">% blended APY</span></span>
          <span className="label">weighted by allocation</span>
        </div>
      </div>

      <div className="strategy-agents">
        {strategy.agents.map((a) => (
          <div key={a.id} className="strategy-agent-row">
            <div className="strategy-agent-id">
              <span className="idx mono">{a.idx}</span>
              <div>
                <div className="strategy-agent-name">{a.name}</div>
                <div className="mono strategy-agent-meta">
                  {a.vault.name} · {a.vault.protocol}
                  {a.vault.tvl && a.vault.tvl !== "N/A" ? ` · TVL ${a.vault.tvl}` : ""}
                  {a.vault.isLiveData ? " · 🟢 live" : ""}
                </div>
              </div>
            </div>
            <div className="strategy-agent-cells">
              <div className="strategy-cell">
                <span className="k mono">allocation</span>
                <span className="v mono tnum">{a.allocation} USDC</span>
              </div>
              <div className="strategy-cell">
                <span className="k mono">apy</span>
                <span className="v mono tnum">{a.vault.apy}%</span>
              </div>
              <div className="strategy-cell">
                <span className="k mono">drawdown 30d</span>
                <span className="v mono tnum">{a.vault.drawdown}%</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {strategy.reward && strategy.mdpState && (
        <div className="mdp-panel" style={{ marginTop: 16, border: "1px solid var(--border)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
          <div className="mono" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", fontSize: 11 }}>
            <div style={{ padding: "12px 14px", borderRight: "1px solid var(--border)" }}>
              <div style={{ color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>State · observed</div>
              <div style={{ color: "var(--text)" }}>market · {strategy.mdpState.turbulence}</div>
              <div style={{ color: "var(--text-muted)" }}>universe · {strategy.mdpState.universeSize} vaults</div>
              <div style={{ color: "var(--text-muted)" }}>capital · {strategy.mdpState.capitalUsdc} USDC</div>
            </div>
            <div style={{ padding: "12px 14px", borderRight: "1px solid var(--border)" }}>
              <div style={{ color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Action · bounded</div>
              <div style={{ color: "var(--text)" }}>risk ceiling · {strategy.mdpState.riskCeiling}</div>
              <div style={{ color: "var(--text-muted)" }}>weights · sum to 1.0</div>
              <div style={{ color: strategy.mdpState.actionViolations && strategy.mdpState.actionViolations.length ? "var(--warn, #c87)" : "var(--text-muted)" }}>
                gated · {strategy.mdpState.actionViolations ? strategy.mdpState.actionViolations.length : 0}
              </div>
            </div>
            <div style={{ padding: "12px 14px" }}>
              <div style={{ color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Reward · projected</div>
              <div style={{ color: "var(--text)" }}>risk-adj · {strategy.reward.riskAdjustedScore}</div>
              <div style={{ color: "var(--text-muted)" }}>≈ {strategy.reward.projectedAnnualUsdc} USDC / yr</div>
              <div style={{ color: "var(--text-muted)" }}>risk penalty · {strategy.reward.riskPenalty}</div>
            </div>
          </div>
          {strategy.mdpState.actionViolations && strategy.mdpState.actionViolations.length > 0 && (
            <div className="mono" style={{ padding: "8px 14px", borderTop: "1px solid var(--border)", fontSize: 10, color: "var(--text-muted)" }}>
              {strategy.mdpState.actionViolations[0]}
            </div>
          )}
        </div>
      )}

      <CouncilPanel council={council} onRetry={onCouncilRetry} />

      <SimulationPanel simulation={simulation} />

      {(attestation || attesting || strategyHash) && (
        <div className="mono" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 16, padding: "9px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", fontSize: 11, color: "var(--text-muted)" }}>
          {attestation ? (
            <>
              <span style={{ color: "var(--ok)", fontSize: 8 }}>●</span>
              <span>Strategy attested on-chain</span>
              <span style={{ color: "var(--text-faint)" }}>·</span>
              <span>Hash: {attestation.hash}</span>
              <a href={attestation.etherscanUrl} target="_blank" rel="noopener noreferrer" className="accent" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 3 }}>
                Verify on Etherscan <Icon name="external" size={11} />
              </a>
              <span style={{ color: "var(--text-faint)", marginLeft: "auto" }}>Powered by ERC-8004 · tamper-proof AI reasoning</span>
            </>
          ) : attesting ? (
            <>
              <span style={{ color: "var(--text-faint)", fontSize: 8 }}>○</span>
              <span>Attesting strategy on-chain…</span>
            </>
          ) : (
            <>
              <span style={{ color: "var(--text-faint)", fontSize: 8 }}>○</span>
              <span>Strategy hash: {shortHash(strategyHash)} (local only)</span>
            </>
          )}
        </div>
      )}

      <div className="action-row">
        <div className="foot-note">
          <span className="ai-attribution">
            ● AI · live data
          </span>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-ghost" onClick={onRegenerate}>See alternatives</button>
          <button className="btn btn-primary" onClick={onProceed}>
            Proceed · connect wallet <Icon name="arrow" size={14} />
          </button>
        </div>
      </div>
    </section>
  );
};

/* ============================================
   ExecuteCard — uses AgentGraph + AgentTiles + Memory
   ============================================ */
const ExecuteCard = ({ strategy, execMap, paletteIsLight, onOpenMemory, onDone }) => {
  const totalSteps = strategy.agents.length * STEP_IDS.length;
  const doneSteps = strategy.agents.reduce((acc, a) => {
    const ex = execMap[a.id] || { steps: {} };
    return acc + STEP_IDS.filter((sid) => ex.steps?.[sid] === "confirmed" || ex.steps?.[sid] === "skipped").length;
  }, 0);
  const pct = totalSteps ? (doneSteps / totalSteps) * 100 : 0;
  const allDone = doneSteps === totalSteps;
  const runningCount = strategy.agents.filter((a) => (execMap[a.id] || {}).status === "running").length;
  const failedCount = strategy.agents.filter((a) => (execMap[a.id] || {}).status === "failed").length;
  // Nothing running + at least one failure + not everything done = the run stalled. Without
  // this the live banner says "waiting for relayer" forever (allDone never hits because failed
  // workers never confirm), which is what made the stuck screen look like it was still working.
  const stalled = runningCount === 0 && failedCount > 0 && !allDone;

  // Auto-advance to "done" only when execution finishes while viewing — NOT when the user
  // navigates back to an already-completed run via the step rail (would bounce to done).
  const wasDoneOnMount = useRAg(allDone);
  useEAg(() => {
    if (allDone && !wasDoneOnMount.current) {
      const t = setTimeout(onDone, 900);
      return () => clearTimeout(t);
    }
  }, [allDone]);

  // Real on-chain txs take time (relayer submit + block confirmation) — surface an
  // elapsed-time counter so the user knows the run is progressing, not stuck.
  const [elapsedMs, setElapsedMs] = useSAg(0);
  useEAg(() => {
    if (allDone) return;
    const startedAt = Date.now();
    const t = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(t);
  }, [allDone]);

  return (
    <section className="card enter exec-card-wrap">
      <div className="eyebrow">
        <span className="num">05</span>
        <span>Agents executing · 1Shot relayer · parallel</span>
        <span className="rule" />
        <span>gas paid by relayer</span>
      </div>

      <div className="exec-header">
        <div>
          <h1 className="h-display" style={{ fontSize: 30, marginTop: 6 }}>
            {strategy.agents.length} agents executing in parallel.
          </h1>
          <p className="lede" style={{ marginTop: 10, maxWidth: 540 }}>
            Each worker executes the skills you approved: <span className="mono">swap → approve → deposit</span>.
            Click an agent node on the graph or a card below to open its memory panel.
          </p>
          {!allDone && stalled && (
            <div className="exec-live-status mono" style={{ color: "var(--danger, #e5484d)" }}>
              <span>
                {failedCount} agent{failedCount > 1 ? "s" : ""} failed — see agent card / console for reason
                {" · "}{fmtCountdown(elapsedMs)} elapsed
              </span>
            </div>
          )}
          {!allDone && !stalled && (
            <div className="exec-live-status mono">
              <span className="think-spin" />
              <span>
                {runningCount > 0 ? `${runningCount} agent${runningCount > 1 ? "s" : ""} confirming on-chain` : "waiting for relayer"}
                {" · "}{fmtCountdown(elapsedMs)} elapsed
              </span>
            </div>
          )}
        </div>
        <div className="exec-progress">
          <span className="label">progress</span>
          <span className={`value ${allDone ? "done" : ""}`}>
            {doneSteps}/{totalSteps}
          </span>
          <div className="exec-progress-bar">
            <div className="exec-progress-bar-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>

      <AgentGraph
        strategy={strategy}
        execMap={execMap}
        onAgentClick={onOpenMemory}
        paletteIsLight={paletteIsLight}
      />

      <div className="agent-legend mono">
        <span className="legend-item"><span className="dot idle" /> idle</span>
        <span className="legend-item"><span className="dot running" /> running</span>
        <span className="legend-item"><span className="dot confirmed" /> confirmed</span>
        <span className="legend-item"><span className="dot failed" /> failed</span>
        <span className="legend-spacer" />
        <span className="legend-hint">click any agent node → open memory</span>
      </div>

      <AgentTiles strategy={strategy} execMap={execMap} onOpenMemory={onOpenMemory} />
    </section>
  );
};

// ── Autonomous monitor-loop status — NEVER-STOP loop + AI Council made visible ──
// Live panel: a 1s internal ticker drives the heartbeat countdown so the loop
// reads as alive between cycles (default heartbeat is minutes apart). The
// pipeline rail lights the phase reported by monitorLoop's onPhase hook.
// Props: { running, cycle, summary, rows, phase, nextTickAt, heartbeatMs }
// where rows are newest-first records from cycleJournal.getCycles().
const LOOP_PHASES = ['observe', 'gate', 'simulate', 'council', 'execute', 'reflect'];

const fmtCountdown = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const agoLabel = (ts, now) => {
  if (!ts) return 'just now';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

const loopRowDetail = (r) => {
  const rules = (r.citedRules || []).join(', ');
  if (r.verdict === 'crash') return r.error || 'crashed · loop recovered';
  if (r.verdict === 'gated') return `${r.gate || 'gate'} gate · ${r.reason || 'blocked before council'} · no AI credit spent`;
  if (r.verdict === 'discard') return `${r.reason || 'council declined'}${rules ? ` · ${rules}` : ''}`;
  if (r.verdict === 'keep') return `score ${r.score ?? '—'} · ${rules || '—'} · tx ${(r.txHash || '').slice(0, 10)}…`;
  return `observed market · ${r.turbulence || 'calm'} · no action needed`;
};

const LoopStatusPanel = ({ running, summary, rows, phase, nextTickAt, heartbeatMs }) => {
  // Internal 1s clock — the countdown and relative timestamps tick even when
  // the loop itself sleeps, which is what makes the panel feel alive.
  const [now, setNow] = useSAg(() => Date.now());
  useEAg(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const cycling = Boolean(phase && phase !== 'sleep');
  const remaining = running && nextTickAt ? Math.max(0, nextTickAt - now) : null;
  const pctElapsed = running && heartbeatMs && remaining != null
    ? Math.min(100, Math.max(0, 100 - (remaining / heartbeatMs) * 100))
    : 0;
  const lastTs = rows && rows.length ? rows[0].ts : null;
  const activeIdx = LOOP_PHASES.indexOf(phase);

  return (
    <div className={`loop-status embedded ${running ? 'is-running' : 'is-stopped'}`}>
      {running && (
        <div className="loop-vitals">
          <span className={`loop-countdown ${cycling ? 'busy' : ''}`}>
            {cycling ? 'cycle running now'
              : remaining != null ? `next cycle in ${fmtCountdown(remaining)}`
              : 'awaiting first heartbeat'}
          </span>
          <span className="loop-last">last activity {agoLabel(lastTs, now)}</span>
        </div>
      )}
      {running && (
        <div className={`loop-heartbeat-track ${cycling ? 'cycling' : ''}`}>
          <div className="loop-heartbeat-fill" style={{ width: `${cycling ? 100 : pctElapsed}%` }} />
        </div>
      )}

      <div className={`loop-rail ${!running ? 'off' : cycling ? 'cycling' : 'sleeping'}`}>
        {LOOP_PHASES.map((p, i) => (
          <React.Fragment key={p}>
            {i > 0 && <span className="loop-rail-link" aria-hidden="true" />}
            <span className={`loop-stage${phase === p ? ' active' : ''}${cycling && activeIdx > i ? ' done' : ''}`}>
              {p}
            </span>
          </React.Fragment>
        ))}
      </div>

      <div className="loop-chips">
        <span className="loop-chip keep">keep {summary.keep}</span>
        <span className="loop-chip discard">discard {summary.discard}</span>
        <span className="loop-chip gated">gated {summary.gated || 0}</span>
        <span className="loop-chip crash">crash {summary.crash}</span>
        <span className="loop-chip idle">observe {summary.idle}</span>
      </div>

      <div className="loop-rows">
        {(rows || []).map((r, i) => (
          <div className="loop-row" key={r.ts || i}>
            <span className="loop-row-num">#{String(r.cycle).padStart(2, '0')}</span>
            <span className={`loop-badge ${r.verdict}`}>{r.verdict === 'idle' ? 'observe' : r.verdict}</span>
            <span className="loop-row-detail" title={loopRowDetail(r)}>{loopRowDetail(r)}</span>
            <span className="loop-row-time">{agoLabel(r.ts, now)}</span>
          </div>
        ))}
        {(!rows || rows.length === 0) && (
          <div className="loop-empty">
            {running
              ? `No cycles journaled yet. First heartbeat ${remaining != null ? `in ${fmtCountdown(remaining)}` : 'arriving shortly'} — the loop observes, gates, simulates, asks the council, then acts only on a keep verdict.`
              : 'Loop is stopped. It starts automatically while the agent is enabled and positions are held.'}
          </div>
        )}
      </div>
    </div>
  );
};

const SIGNAL_CLASS = { DEPOSIT: 'keep', HOLD: 'gated', WITHDRAW: 'discard' };

const DecisionLogPanel = ({ rows, summary }) => {
  const [now, setNow] = useSAg(() => Date.now());
  const [open, setOpen] = useSAg(() => null);
  useEAg(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const byAgent = summary?.byAgent || {};
  return (
    <div className="decision-log">
      <div className="decision-agents">
        {['yield', 'risk', 'market'].map((role) => {
          const t = byAgent[role] || { DEPOSIT: 0, HOLD: 0, WITHDRAW: 0 };
          return (
            <div className="decision-agent" key={role}>
              <span className="decision-agent-role mono">{role}</span>
              <span className="decision-agent-tally mono">
                <span className="keep">{t.DEPOSIT}</span>·
                <span className="gated">{t.HOLD}</span>·
                <span className="discard">{t.WITHDRAW}</span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="decision-rows">
        {(rows || []).map((r) => (
          <div className={`decision-row ${open === r.id ? 'open' : ''}`} key={r.id}>
            <button className="decision-row-head" onClick={() => setOpen(open === r.id ? null : r.id)}>
              <span className="decision-row-num mono">#{String(r.cycle).padStart(2, '0')}</span>
              <span className={`decision-badge ${r.finalDecision === 'keep' ? 'keep' : 'discard'}`}>{r.finalDecision}</span>
              <span className="decision-row-maj mono">{r.majoritySignal} ×{r.majorityCount}</span>
              <span className="decision-row-conf tnum mono">{Math.round((r.avgConfidence || 0) * 100)}%</span>
              <span className="decision-row-by mono">{r.resolvedBy}</span>
              <span className="decision-row-time">{agoLabel(r.ts, now)}</span>
            </button>
            {open === r.id && (
              <div className="decision-verdicts">
                {(r.verdicts || []).map((v) => (
                  <div className={`decision-verdict ${SIGNAL_CLASS[v.signal] || ''}`} key={v.role}>
                    <span className="decision-verdict-role mono">{v.role}</span>
                    <span className="decision-verdict-conf tnum mono">{Math.round((v.confidence || 0) * 100)}%</span>
                    <span className="decision-verdict-summary">{v.summary}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {(!rows || rows.length === 0) && (
          <div className="decision-empty">No council decisions yet. Each keep or discard verdict from the autonomous loop is logged here with all three specialist opinions.</div>
        )}
      </div>
    </div>
  );
};

export {
  LoopStatusPanel,
  DecisionLogPanel,
  AgentGraph, AgentTiles, MemoryModal, StrategyCard, ExecuteCard,
  buildStrategy, makeInitialExecState, AGENT_PROTOCOLS, STEP_IDS, STEP_LABELS,
};
