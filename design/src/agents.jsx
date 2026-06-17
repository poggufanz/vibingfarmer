/* ============================================
   VIBING FARMER — Agent Graph + Memory (step 05)
   Hierarchical vis.js Network:
     Orchestrator → Worker Agents → Step nodes (Swap/Approve/Deposit) → Vault nodes
   Node colors driven by state: idle / running / confirmed / failed
   ============================================ */

const { useState: useAg, useEffect: useEAg, useRef: useRAg, useMemo: useMAg } = React;

/* ---------- Strategy data — generated per-flow ---------- */
const AGENT_PROTOCOLS = [
  { name: "MockVault USDC",     protocol: "aave-v3",    apy: "8.2",  drawdown: "-1.8", addr: "0xABCD7e8F3a2c91D5e6f0B842c1234567890aBcDe", role: "Conservative · lending" },
  { name: "BalancedVault USDC", protocol: "morpho-blue", apy: "12.4", drawdown: "-3.6", addr: "0xDEF12345678aBcDeF09876b1234c98765abcDEf12", role: "Balanced · liquidity provision" },
  { name: "LeveredVault USDC",  protocol: "pendle-v2",   apy: "21.5", drawdown: "-7.2", addr: "0x9876b1234c987abc6543defa87654321bDeF1234", role: "Aggressive · leveraged yield" },
];

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
  return {
    agents,
    total,
    blendedApy: blendedApy.toFixed(1),
    risk,
  };
};

/* ---------- Agent execution state model ---------- */
const STEP_IDS = ["swap", "approve", "deposit"];
const STEP_LABELS = { swap: "Swap", approve: "Approve", deposit: "Deposit" };

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
   Agent Graph (vis.js Network)
   ============================================ */
const NODE_COLOR = {
  idle:      { bg: "#22231d", border: "#56564f", font: "#95958a" },
  running:   { bg: "#3a2d12", border: "#f0b54a", font: "#ecebe1" },
  confirmed: { bg: "#1a3322", border: "#6fe39a", font: "#ecebe1" },
  failed:    { bg: "#3a1a1c", border: "#ff7479", font: "#ecebe1" },
};

// Light-palette adjustments
const NODE_COLOR_LIGHT = {
  idle:      { bg: "#e3dfd2", border: "#95928a", font: "#6a675c" },
  running:   { bg: "#f6e3b8", border: "#b07a1a", font: "#1a180f" },
  confirmed: { bg: "#cfe9d6", border: "#2d7a4a", font: "#1a180f" },
  failed:    { bg: "#f0c8c8", border: "#a83a3a", font: "#1a180f" },
};

const computeOrchestratorState = (execMap) => {
  const vals = Object.values(execMap);
  if (vals.some((a) => a.status === "failed")) return "failed";
  if (vals.every((a) => a.status === "confirmed")) return "confirmed";
  if (vals.some((a) => a.status === "running")) return "running";
  return "idle";
};

const AgentGraph = ({ strategy, execMap, onAgentClick, paletteIsLight }) => {
  const containerRef = useRAg(null);
  const networkRef = useRAg(null);
  const dataRef = useRAg({ nodes: null, edges: null });
  const pulseRef = useRAg(null);

  const palette = paletteIsLight ? NODE_COLOR_LIGHT : NODE_COLOR;

  // Build nodes/edges (initial)
  useEAg(() => {
    if (!containerRef.current || !window.vis) return;

    const nodes = [];
    const edges = [];

    // Orchestrator (level 0)
    nodes.push({
      id: "orchestrator",
      label: "Orchestrator",
      level: 0,
      shape: "box",
      group: "orchestrator",
      margin: 12,
      widthConstraint: { minimum: 130 },
    });

    strategy.agents.forEach((a) => {
      // Worker (level 1)
      nodes.push({
        id: a.id,
        label: `${a.name}\n${a.allocation} USDC`,
        level: 1,
        shape: "box",
        group: "worker",
        margin: 10,
        widthConstraint: { minimum: 150 },
      });
      edges.push({ from: "orchestrator", to: a.id });

      // Steps (level 2)
      STEP_IDS.forEach((sid) => {
        const nid = `${a.id}-${sid}`;
        nodes.push({
          id: nid,
          label: STEP_LABELS[sid],
          level: 2,
          shape: "box",
          group: "step",
          margin: 8,
          widthConstraint: { minimum: 80 },
        });
        edges.push({ from: a.id, to: nid });
      });

      // Vault (level 3)
      const vid = `${a.id}-vault`;
      nodes.push({
        id: vid,
        label: `${a.vault.name}\n${a.vault.protocol}`,
        level: 3,
        shape: "box",
        group: "vault",
        margin: 10,
        widthConstraint: { minimum: 140 },
      });
      edges.push({ from: `${a.id}-deposit`, to: vid });
    });

    const visNodes = new window.vis.DataSet(nodes);
    const visEdges = new window.vis.DataSet(edges);
    dataRef.current = { nodes: visNodes, edges: visEdges };

    const options = {
      layout: {
        hierarchical: {
          direction: "UD",
          sortMethod: "directed",
          levelSeparation: 110,
          nodeSpacing: 130,
          treeSpacing: 60,
          parentCentralization: true,
        },
      },
      physics: { enabled: false },
      interaction: {
        hover: true,
        dragNodes: false,
        dragView: false,
        zoomView: false,
        selectConnectedEdges: false,
      },
      nodes: {
        shape: "box",
        font: {
          face: "JetBrains Mono, ui-monospace, monospace",
          size: 11,
          multi: false,
        },
        borderWidth: 1,
        borderWidthSelected: 1,
        shapeProperties: { borderRadius: 4 },
        labelHighlightBold: false,
      },
      edges: {
        color: { color: paletteIsLight ? "#aaa6a0" : "#3a3a35", highlight: paletteIsLight ? "#aaa6a0" : "#3a3a35" },
        smooth: { type: "cubicBezier", forceDirection: "vertical", roundness: 0.45 },
        arrows: { to: { enabled: true, scaleFactor: 0.4, type: "arrow" } },
        width: 1,
        selectionWidth: 0,
      },
      groups: {
        orchestrator: { font: { bold: true } },
        worker: {},
        step: {},
        vault: {},
      },
    };

    const network = new window.vis.Network(containerRef.current, { nodes: visNodes, edges: visEdges }, options);
    networkRef.current = network;

    network.on("click", (params) => {
      const id = params.nodes[0];
      if (!id) return;
      if (strategy.agents.find((a) => a.id === id)) {
        onAgentClick(id);
      }
    });

    return () => {
      if (pulseRef.current) clearInterval(pulseRef.current);
      network.destroy();
      networkRef.current = null;
    };
  }, [strategy, paletteIsLight]);

  // Apply state colors to nodes whenever execMap changes
  useEAg(() => {
    const ds = dataRef.current.nodes;
    if (!ds) return;

    const orchState = computeOrchestratorState(execMap);
    const updates = [];

    const styleFor = (state) => {
      const c = palette[state];
      return {
        color: { background: c.bg, border: c.border, hover: { background: c.bg, border: c.border }, highlight: { background: c.bg, border: c.border } },
        font: { color: c.font, face: "JetBrains Mono, ui-monospace, monospace", size: 11 },
        borderWidth: state === "running" ? 2 : 1,
      };
    };

    updates.push({ id: "orchestrator", ...styleFor(orchState) });

    strategy.agents.forEach((a) => {
      const ex = execMap[a.id] || { status: "idle", steps: {} };
      updates.push({ id: a.id, ...styleFor(ex.status) });
      STEP_IDS.forEach((sid) => {
        updates.push({ id: `${a.id}-${sid}`, ...styleFor(ex.steps?.[sid] || "idle") });
      });
      // Vault node turns confirmed once deposit confirmed
      const vaultState = ex.steps?.deposit === "confirmed" ? "confirmed"
        : ex.steps?.deposit === "running" ? "running"
        : ex.steps?.deposit === "failed" ? "failed" : "idle";
      updates.push({ id: `${a.id}-vault`, ...styleFor(vaultState) });
    });

    ds.update(updates);

    // Pulse running nodes: toggle borderWidth 2 ↔ 3
    if (pulseRef.current) clearInterval(pulseRef.current);
    let on = false;
    pulseRef.current = setInterval(() => {
      on = !on;
      const runningUpdates = [];
      const orch = computeOrchestratorState(execMap);
      if (orch === "running") {
        runningUpdates.push({ id: "orchestrator", borderWidth: on ? 3 : 2 });
      }
      strategy.agents.forEach((a) => {
        const ex = execMap[a.id] || { status: "idle", steps: {} };
        if (ex.status === "running") runningUpdates.push({ id: a.id, borderWidth: on ? 3 : 2 });
        STEP_IDS.forEach((sid) => {
          if (ex.steps?.[sid] === "running") runningUpdates.push({ id: `${a.id}-${sid}`, borderWidth: on ? 3 : 2 });
        });
        if (ex.steps?.deposit === "running") runningUpdates.push({ id: `${a.id}-vault`, borderWidth: on ? 3 : 2 });
      });
      if (runningUpdates.length) ds.update(runningUpdates);
    }, 550);

    return () => {
      if (pulseRef.current) clearInterval(pulseRef.current);
    };
  }, [execMap, strategy, paletteIsLight]);

  return <div ref={containerRef} className="agent-graph" />;
};

/* ============================================
   Agent execution legend + summary tiles
   ============================================ */
const AgentTiles = ({ strategy, execMap, onOpenMemory }) => {
  return (
    <div className="agent-tiles">
      {strategy.agents.map((a) => {
        const ex = execMap[a.id] || { status: "idle", steps: {}, memory: [] };
        const doneSteps = STEP_IDS.filter((sid) => ex.steps?.[sid] === "confirmed").length;
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
                <span key={sid} className={`agent-step-pip ${ex.steps?.[sid] || "idle"}`} title={STEP_LABELS[sid]}>
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
            <span className="val tnum mono">{ex.metrics?.successRate == null ? "—" : `${ex.metrics.successRate}%`}</span>
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
            <div className="empty">no events yet — agent queued</div>
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
            Memory di-store onchain via worker logs · auditable per skill version.
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
const StrategyCard = ({ strategy, onProceed }) => {
  return (
    <section className="rec-card enter">
      <div className="eyebrow">
        <span className="num">01</span>
        <span>Strategy · {strategy.agents.length} worker{strategy.agents.length === 1 ? "" : "s"} · {strategy.risk} risk</span>
        <span className="rule" />
        <span>{strategy.agents.reduce((n) => n + 1, 0) * 3} on-chain steps</span>
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

      <div className="action-row">
        <span className="ai-attribution">
          ● AI · live data
        </span>
        <div className="flex gap-2">
          <button className="btn btn-ghost">Lihat alternatif</button>
          <button className="btn btn-primary" onClick={onProceed}>
            Lanjut · connect wallet <Icon name="arrow" size={14} />
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
    return acc + STEP_IDS.filter((sid) => ex.steps?.[sid] === "confirmed").length;
  }, 0);
  const pct = totalSteps ? (doneSteps / totalSteps) * 100 : 0;
  const allDone = doneSteps === totalSteps;

  useEAg(() => {
    if (allDone) {
      const t = setTimeout(onDone, 900);
      return () => clearTimeout(t);
    }
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
            {strategy.agents.length} agents running in parallel — orchestrated seamlessly.
          </h1>
          <p className="lede" style={{ marginTop: 10, maxWidth: 540 }}>
            Each worker executes the skills you approved: <span className="mono">swap → approve → deposit</span>.
            Click an agent node on the graph or a card below to open its memory panel.
          </p>
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

Object.assign(window, {
  AgentGraph, AgentTiles, MemoryModal, StrategyCard, ExecuteCard,
  buildStrategy, makeInitialExecState, AGENT_PROTOCOLS, STEP_IDS, STEP_LABELS,
});
