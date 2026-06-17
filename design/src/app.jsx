/* ============================================
   VIBING FARMER — AI Yield Farming Swarm (multi-agent)
   App state machine + right rail panels
   ============================================ */

const { useState: useS, useEffect: useE, useRef: useR, useMemo: useM } = React;

/* ---------- Right rail panels ---------- */
const WalletPanel = ({ phase, address }) => {
  if (phase === "none") {
    return (
      <div className="panel">
        <div className="panel-head">
          <div className="panel-title">Wallet</div>
          <span className="panel-meta">not connected</span>
        </div>
        <div className="empty">— belum connect</div>
      </div>
    );
  }
  const isSmart = phase === "upgraded";
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title">Wallet</div>
        <span className="panel-meta">{isSmart ? "smart account" : "eoa"}</span>
      </div>
      <div className="wallet-row">
        <div>
          <div className="wallet-addr">{shortAddr(address)}</div>
          <div className={`wallet-type ${isSmart ? "active" : ""}`}>
            {isSmart ? "eip-7702 active" : "regular eoa"}
          </div>
        </div>
        <div className="wallet-actions">
          <button className="wallet-action" title="copy" aria-label="copy"><Icon name="copy" /></button>
          <button className="wallet-action" title="etherscan" aria-label="etherscan"><Icon name="external" /></button>
          <button className="wallet-action" title="disconnect" aria-label="disconnect"><Icon name="logout" /></button>
        </div>
      </div>
      <div className="balance-row">
        <div className="balance-cell">
          <div className="label">USDC</div>
          <div className="val tnum">2,481<span className="unit">.32</span></div>
        </div>
        <div className="balance-cell">
          <div className="label">Sepolia ETH</div>
          <div className="val tnum">0.18<span className="unit">ETH</span></div>
        </div>
      </div>
    </div>
  );
};

/* Now lists permissions per agent */
const PermissionPanel = ({ active, strategy, onRevoke }) => {
  const agents = strategy?.agents || [];
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title">Active permissions</div>
        <span className="panel-meta">erc-7715 · batch</span>
      </div>
      <div className={`perm-status ${active ? "active" : ""}`}>
        {active ? `${agents.length} permission · 23h 59m` : "no active permission"}
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
            revoke all permissions
          </button>
        </>
      )}
    </div>
  );
};

/* Activity panel — agent-level events */
const EVENT_STYLES = {
  AgentStarted:    { icon: "●", color: "var(--warn)" },
  SwapExecuted:    { icon: "↻", color: "var(--info)" },
  ApproveExecuted: { icon: "✓", color: "var(--info)" },
  DepositExecuted: { icon: "↓", color: "var(--info)" },
  AgentCompleted:  { icon: "✓", color: "var(--ok)" },
  AgentFailed:     { icon: "✕", color: "var(--danger)" },
  OrchestratorPlanned: { icon: "·", color: "var(--text-muted)" },
  PermissionGranted:   { icon: "·", color: "var(--text-muted)" },
  Connected:           { icon: "·", color: "var(--text-muted)" },
  Authorized:          { icon: "·", color: "var(--text-muted)" },
  PermissionRevoked:   { icon: "·", color: "var(--danger)" },
  SkillApproved:       { icon: "·", color: "var(--text-muted)" },
};

const ActivityPanel = ({ logs }) => {
  return (
    <div className="panel" style={{ borderBottom: "none", flex: 1 }}>
      <div className="panel-head">
        <div className="panel-title">Activity</div>
        <span className="panel-meta">agent events · realtime</span>
      </div>
      {logs.length === 0 ? (
        <div className="empty">no events yet</div>
      ) : (
        <div className="activity">
          {logs.slice().reverse().map((l) => {
            const sty = EVENT_STYLES[l.event] || EVENT_STYLES.OrchestratorPlanned;
            return (
              <div key={l.id} className="act-row">
                <span className="act-marker mono" style={{ color: sty.color }}>{sty.icon}</span>
                <div>
                  <div className="act-title">
                    <span className="act-event mono">{l.event}</span>
                    {l.agent && <span className="act-agent mono">{l.agent}</span>}
                  </div>
                  <div className="act-meta">{l.meta}</div>
                </div>
                <span className="act-time">{l.time}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/* ---------- Palette picker ---------- */
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
            cursor: "default",
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

/* ---------- Tweak defaults ---------- */
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "palette": "acid-yield",
  "density": "comfortable",
  "speed": "medium"
}/*EDITMODE-END*/;

const SPEED_MS = { fast: 220, medium: 600, slow: 1100 };
const MOCK_ADDR = "0xA36f3c8e2B7f124d9a8E4D2F1C5b7e0d8a9b126a4";

/* ---------- App ---------- */
const App = () => {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // stage: 'strategy' | 'connect' | 'skills' | 'permission' | 'execute' | 'done'
  const [stage, setStage] = useS("strategy");
  const [amount, setAmount] = useS("100");
  const [risk, setRisk] = useS("med");

  // strategy sub-state
  const [strategyPhase, setStrategyPhase] = useS("input"); // input | thinking | ready
  const [thinkingPhase, setThinkingPhase] = useS(0);
  const [strategy, setStrategy] = useS(null);

  const [connectPhase, setConnectPhase] = useS("idle");

  // skills
  const [skillStates, setSkillStates] = useS({}); // id -> { state, skill }
  const [editingTexts, setEditingTexts] = useS({}); // id -> { text, error }

  const [permPhase, setPermPhase] = useS("idle");
  const [permActive, setPermActive] = useS(false);

  // execution: map agentId -> { status, steps, hashes, memory, metrics }
  const [execMap, setExecMap] = useS({});
  const [openAgentId, setOpenAgentId] = useS(null);

  const [logs, setLogs] = useS([]);
  const logIdRef = useR(0);

  useE(() => {
    document.documentElement.dataset.palette = tweaks.palette;
    document.documentElement.dataset.density = tweaks.density;
  }, [tweaks.palette, tweaks.density]);

  const paletteIsLight = tweaks.palette === "bone-paper";
  const speed = SPEED_MS[tweaks.speed] || SPEED_MS.medium;

  const addLog = (entry) => {
    logIdRef.current += 1;
    setLogs((l) => [...l, { id: logIdRef.current, time: "just now", ...entry }]);
  };

  /* ----- STRATEGY (step 01) ----- */
  const handleSubmitPreference = () => {
    setStrategyPhase("thinking");
    setThinkingPhase(0);
    addLog({ event: "OrchestratorPlanned", meta: `${amount} usdc · ${risk} risk · planning` });
  };

  useE(() => {
    if (stage !== "strategy" || strategyPhase !== "thinking") return;
    if (thinkingPhase < 2) {
      const t = setTimeout(() => setThinkingPhase((p) => p + 1), speed * 1.2);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      const s = buildStrategy(amount, risk);
      setStrategy(s);
      setStrategyPhase("ready");
      // Initialize skill states as pending
      const sk = {};
      s.agents.forEach((a) => { sk[a.id] = { state: "pending", skill: null }; });
      setSkillStates(sk);
      addLog({ event: "OrchestratorPlanned", meta: `${s.agents.length} worker spawned · ${s.blendedApy}% blended apy` });
    }, speed * 1.5);
    return () => clearTimeout(t);
  }, [stage, strategyPhase, thinkingPhase, speed]);

  const handleAcceptStrategy = () => setStage("connect");

  /* ----- CONNECT (step 02) ----- */
  const handleConnect = () => {
    setConnectPhase("connecting");
    setTimeout(() => {
      setConnectPhase("connected");
      addLog({ event: "Connected", meta: shortAddr(MOCK_ADDR) });
    }, speed * 1.4);
  };

  const handleUpgrade = () => {
    setConnectPhase("upgrading");
    setTimeout(() => {
      setConnectPhase("upgraded");
      addLog({ event: "Authorized", meta: `eip-7702 · tx ${shortAddr(fakeHash())}` });
    }, speed * 1.8);
  };

  const handleConnectDone = () => setStage("skills");

  /* ----- SKILLS (step 03) ----- */
  const updateSkillState = (id, patch) => {
    setSkillStates((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  const handleSkillApprove = (id) => {
    updateSkillState(id, { state: "approved" });
    addLog({ event: "SkillApproved", agent: id, meta: "skill JSON approved · ready to bind" });
  };

  const handleApproveAll = () => {
    const next = {};
    Object.entries(skillStates).forEach(([id, s]) => {
      next[id] = { ...s, state: "approved" };
    });
    setSkillStates(next);
    addLog({ event: "SkillApproved", meta: `${Object.keys(next).length} skills approved · batch` });
  };

  const handleSkillEdit = (id, text, start = false) => {
    let err = null;
    try { JSON.parse(text); } catch (e) { err = e.message.replace(/^.*: /, ""); }
    setEditingTexts((prev) => ({ ...prev, [id]: { text, error: err } }));
    if (start) {
      updateSkillState(id, { state: "editing" });
    }
  };

  const handleSkillSave = (id) => {
    const entry = editingTexts[id];
    if (!entry || entry.error) return;
    try {
      const parsed = JSON.parse(entry.text);
      updateSkillState(id, { state: "pending", skill: parsed });
    } catch {
      // shouldn't happen — guarded above
    }
  };

  const handleSkillReset = (id) => {
    updateSkillState(id, { state: "pending" });
    setEditingTexts((prev) => ({ ...prev, [id]: { text: "", error: null } }));
  };

  const handleSkillsContinue = () => setStage("permission");

  /* ----- PERMISSION (step 04) ----- */
  const handleGrant = () => setPermPhase("prompting");

  const handlePermConfirm = () => {
    setPermPhase("idle");
    setPermActive(true);
    const ag = strategy?.agents || [];
    ag.forEach((a) => addLog({ event: "PermissionGranted", agent: a.id, meta: `vault ${shortAddr(a.vault.addr)} · ${a.allocation} usdc max` }));
    setTimeout(() => {
      setStage("execute");
      startExecution();
    }, 600);
  };

  /* ----- EXECUTE (step 05) — parallel agents ----- */
  const startExecution = () => {
    if (!strategy) return;
    const init = makeInitialExecState(strategy.agents);
    setExecMap(init);

    // Stagger agent starts slightly so the graph reads better
    strategy.agents.forEach((a, idx) => {
      setTimeout(() => runAgent(a), idx * speed * 0.6);
    });
  };

  const runAgent = (agent) => {
    // Agent started
    setExecMap((prev) => ({
      ...prev,
      [agent.id]: {
        ...prev[agent.id],
        status: "running",
        activeStep: "swap",
        steps: { swap: "running", approve: "idle", deposit: "idle" },
        memory: [
          ...(prev[agent.id]?.memory || []),
          { status: "running", title: "agent started", meta: `vault ${shortAddr(agent.vault.addr)}`, t: nowT() },
        ],
        metrics: { ...prev[agent.id]?.metrics, startedAt: Date.now(), totalRuns: (prev[agent.id]?.metrics?.totalRuns || 0) + 1 },
      },
    }));
    addLog({ event: "AgentStarted", agent: agent.id, meta: `${agent.vault.protocol} · ${agent.allocation} usdc` });

    runStep(agent, 0);
  };

  const STEP_FLOW = [
    { id: "swap",    event: "SwapExecuted",    title: "swap usdc → usdc (slippage 0.05%)", lesson: "slippage within bounds — pool depth ok" },
    { id: "approve", event: "ApproveExecuted", title: "erc-20 approve vault spender",       lesson: "approval cached on smart account · reuse next run" },
    { id: "deposit", event: "DepositExecuted", title: "erc-4626 deposit · mint shares",      lesson: "share price 1.0241 · vault healthy" },
  ];

  const runStep = (agent, i) => {
    if (i >= STEP_FLOW.length) {
      // Agent done
      setTimeout(() => {
        setExecMap((prev) => ({
          ...prev,
          [agent.id]: {
            ...prev[agent.id],
            status: "confirmed",
            activeStep: null,
            memory: [
              ...(prev[agent.id]?.memory || []),
              { status: "confirmed", title: "agent completed", meta: `3 of 3 steps confirmed`, t: nowT(), lesson: `routed ${agent.allocation} USDC → ${agent.vault.protocol}, target apy ${agent.vault.apy}%` },
            ],
            metrics: { ...prev[agent.id]?.metrics, completedAt: Date.now(), successRate: 100 },
          },
        }));
        addLog({ event: "AgentCompleted", agent: agent.id, meta: `${agent.allocation} usdc → ${agent.vault.name}` });
      }, speed * 0.5);
      return;
    }

    const step = STEP_FLOW[i];

    // Mark step as running (after small delay to feel sequential)
    setTimeout(() => {
      setExecMap((prev) => ({
        ...prev,
        [agent.id]: {
          ...prev[agent.id],
          activeStep: step.id,
          steps: { ...prev[agent.id].steps, [step.id]: "running" },
          memory: [
            ...(prev[agent.id]?.memory || []),
            { status: "running", title: step.title, meta: "broadcasting via 1Shot", t: nowT() },
          ],
        },
      }));

      // Then confirm
      setTimeout(() => {
        const hash = fakeHash();
        setExecMap((prev) => ({
          ...prev,
          [agent.id]: {
            ...prev[agent.id],
            steps: { ...prev[agent.id].steps, [step.id]: "confirmed" },
            hashes: { ...prev[agent.id].hashes, [step.id]: hash },
            memory: [
              ...(prev[agent.id]?.memory || []),
              { status: "confirmed", title: step.title, meta: `confirmed onchain`, hash, lesson: step.lesson, t: nowT() },
            ],
          },
        }));
        addLog({ event: step.event, agent: agent.id, meta: `tx ${shortAddr(hash)}` });
        runStep(agent, i + 1);
      }, speed * 1.4);
    }, 80);
  };

  /* ----- DONE (step 06) ----- */
  const handleExecDone = () => {
    setStage("done");
    addLog({ event: "OrchestratorPlanned", meta: `multi-agent deployment finalized · ${strategy.agents.length} positions opened` });
  };

  const handleAgain = () => {
    setStage("strategy");
    setStrategyPhase("input");
    setThinkingPhase(0);
    setStrategy(null);
    setSkillStates({});
    setEditingTexts({});
    setConnectPhase("idle");
    setPermActive(false);
    setExecMap({});
  };

  const handleRevoke = () => {
    setPermActive(false);
    (strategy?.agents || []).forEach((a) =>
      addLog({ event: "PermissionRevoked", agent: a.id, meta: "agent halted · scope cleared" })
    );
  };

  /* ----- Jump to step (tweaks panel) ----- */
  const jumpTo = (id) => {
    if (id === "strategy") {
      setStage("strategy");
      setStrategyPhase("input");
      setThinkingPhase(0);
      return;
    }
    // Ensure strategy exists for downstream stages
    const ensured = strategy || buildStrategy(amount, risk);
    if (!strategy) {
      setStrategy(ensured);
      const sk = {};
      ensured.agents.forEach((a) => { sk[a.id] = { state: "approved", skill: null }; });
      setSkillStates(sk);
    }
    if (id === "connect") { setStage("connect"); setConnectPhase("idle"); return; }
    if (id === "skills")  { setStage("skills"); setConnectPhase("upgraded"); return; }
    if (id === "permission") {
      setStage("permission"); setPermPhase("idle"); setConnectPhase("upgraded");
      const sk = {};
      ensured.agents.forEach((a) => { sk[a.id] = { state: "approved", skill: null }; });
      setSkillStates(sk);
      return;
    }
    if (id === "execute") {
      setStage("execute"); setConnectPhase("upgraded"); setPermActive(true);
      const sk = {};
      ensured.agents.forEach((a) => { sk[a.id] = { state: "approved", skill: null }; });
      setSkillStates(sk);
      startExecution();
      return;
    }
    if (id === "done") {
      setStage("done");
      setConnectPhase("upgraded");
      setPermActive(true);
      // Force all confirmed
      const map = {};
      ensured.agents.forEach((a) => {
        map[a.id] = {
          status: "confirmed",
          activeStep: null,
          steps: { swap: "confirmed", approve: "confirmed", deposit: "confirmed" },
          hashes: { swap: fakeHash(), approve: fakeHash(), deposit: fakeHash() },
          memory: [],
          metrics: { totalRuns: 1, successRate: 100, startedAt: Date.now(), completedAt: Date.now() },
        };
      });
      setExecMap(map);
    }
  };

  const renderStage = () => {
    switch (stage) {
      case "strategy":
        if (strategyPhase === "input") {
          return <InputScreen amount={amount} setAmount={setAmount} risk={risk} setRisk={setRisk} onSubmit={handleSubmitPreference} />;
        }
        if (strategyPhase === "thinking") {
          return <ThinkingCard phase={thinkingPhase} />;
        }
        return <StrategyCard strategy={strategy} onProceed={handleAcceptStrategy} />;
      case "connect":
        return <ConnectCard phase={connectPhase} onConnect={handleConnect} onUpgrade={handleUpgrade} onDone={handleConnectDone} />;
      case "skills":
        return (
          <SkillReviewCard
            agents={strategy?.agents || []}
            riskProfile={risk}
            skillStates={skillStates}
            editingTexts={editingTexts}
            onApprove={handleSkillApprove}
            onApproveAll={handleApproveAll}
            onEdit={handleSkillEdit}
            onSave={handleSkillSave}
            onReset={handleSkillReset}
            onContinue={handleSkillsContinue}
          />
        );
      case "permission":
        return <PermissionCard strategy={strategy} phase={permPhase} onGrant={handleGrant} onConfirm={handlePermConfirm} />;
      case "execute":
        return (
          <ExecuteCard
            strategy={strategy}
            execMap={execMap}
            paletteIsLight={paletteIsLight}
            onOpenMemory={setOpenAgentId}
            onDone={handleExecDone}
          />
        );
      case "done":
        return <SuccessCard strategy={strategy} onAgain={handleAgain} />;
      default:
        return null;
    }
  };

  const walletPhase =
    connectPhase === "idle" || connectPhase === "connecting" ? "none" :
    connectPhase === "upgraded" ? "upgraded" : "eoa";

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <TopBar walletConnected={walletPhase !== "none"} />
        <StepRail stage={stage} />
        <div className="stage" key={`${stage}-${strategyPhase}`}>
          {renderStage()}
        </div>
      </main>
      <aside className="rail">
        <WalletPanel phase={walletPhase} address={MOCK_ADDR} />
        <PermissionPanel active={permActive} strategy={strategy} onRevoke={handleRevoke} />
        <ActivityPanel logs={logs} />
      </aside>

      {openAgentId && strategy && (
        <MemoryModal
          agentId={openAgentId}
          strategy={strategy}
          execMap={execMap}
          onClose={() => setOpenAgentId(null)}
        />
      )}

      <TweaksPanel title="Tweaks">
        <TweakSection label="Brand palette" />
        <PalettePicker value={tweaks.palette} onChange={(v) => setTweak("palette", v)} />

        <TweakSection label="Demo speed" />
        <TweakRadio
          label="Speed"
          value={tweaks.speed}
          options={[
            { value: "fast", label: "Fast" },
            { value: "medium", label: "Med" },
            { value: "slow", label: "Slow" },
          ]}
          onChange={(v) => setTweak("speed", v)}
        />

        <TweakSection label="Density" />
        <TweakRadio
          label="Layout"
          value={tweaks.density}
          options={[
            { value: "comfortable", label: "Comfy" },
            { value: "compact", label: "Compact" },
          ]}
          onChange={(v) => setTweak("density", v)}
        />

        <TweakSection label="Jump to step" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => jumpTo(s.id)}
              style={{
                appearance: "none",
                border: ".5px solid rgba(0,0,0,.08)",
                borderRadius: 6,
                background: stage === s.id ? "rgba(0,0,0,.08)" : "rgba(255,255,255,.4)",
                color: "inherit",
                font: "inherit",
                fontSize: 10.5,
                fontWeight: stage === s.id ? 600 : 500,
                padding: "6px 8px",
                textAlign: "left",
                cursor: "default",
                letterSpacing: "-0.01em",
              }}
            >
              <span style={{ color: "rgba(41,38,27,.45)", marginRight: 5, fontFamily: "ui-monospace, monospace" }}>
                {String(i + 1).padStart(2, "0")}
              </span>
              {s.label}
            </button>
          ))}
        </div>
      </TweaksPanel>
    </div>
  );
};

const nowT = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
};

Object.assign(window, { App, WalletPanel, PermissionPanel, ActivityPanel, MOCK_ADDR, PALETTES, PalettePicker });
