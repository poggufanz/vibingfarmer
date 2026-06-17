import { useEffect, useRef, useState } from "react";

const T = {
  bgBase: "#0e0f0c",
  bgCanvas: "#131410",
  bgCard: "#1a1b16",
  bgElev: "#22231d",
  bgElev2: "#2b2c25",
  border: "rgba(236,235,225,0.06)",
  borderStrong: "rgba(236,235,225,0.13)",
  text: "#ecebe1",
  textMuted: "#95958a",
  textFaint: "#56564f",
  accent: "#cfff3d",
  accentFg: "#0e0f0c",
  info: "#7ab7ff",
  warn: "#f0b54a",
  danger: "#ff7479",
  ok: "#6fe39a",
};

const mono: React.CSSProperties = {
  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
  fontVariantNumeric: "tabular-nums",
  fontFeatureSettings: '"tnum" 1, "lnum" 1',
  letterSpacing: "-0.01em",
};
const geist: React.CSSProperties = { fontFamily: '"Geist", system-ui, sans-serif' };

type SectionId =
  | "state"
  | "loop"
  | "fetch"
  | "gates"
  | "sim"
  | "council"
  | "verdict"
  | "memory"
  | "execution"
  | "eval"
  | "reflector"
  | "curator"
  | "bullet";

type StageState = "idle" | "running" | "done";
type CycleState = "idle" | "running";

// ── Pipeline marker (in left gutter) ──────────────────────────
function PipeMarker({
  state,
  num,
  first,
  last,
}: {
  state: StageState;
  num: string;
  first?: boolean;
  last?: boolean;
}) {
  const color =
    state === "running" ? T.accent : state === "done" ? T.text : T.textFaint;
  return (
    <div
      style={{
        width: 56,
        position: "relative",
        flexShrink: 0,
        display: "flex",
        justifyContent: "center",
      }}
    >
      {/* connector line */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: first ? 30 : 0,
          bottom: last ? "calc(100% - 30px)" : 0,
          width: 1,
          background: T.border,
          transform: "translateX(-0.5px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 22,
          width: 18,
          height: 18,
          borderRadius: 999,
          background: T.bgCanvas,
          border: `1px solid ${state === "idle" ? T.borderStrong : color}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {state === "done" && (
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke={T.text} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l5 5 9-12" />
          </svg>
        )}
        {state === "running" && (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: T.accent,
              animation: "vf-blink 1.1s ease-in-out infinite",
            }}
          />
        )}
        {state === "idle" && (
          <span style={{ ...mono, fontSize: 9, color: T.textFaint }}>{num}</span>
        )}
      </div>
    </div>
  );
}

function Eyebrow({
  num,
  label,
  meta,
  state,
}: {
  num: string;
  label: string;
  meta: string;
  state: StageState;
}) {
  const metaColor =
    state === "running" ? T.accent : state === "done" ? T.ok : T.textMuted;
  return (
    <div
      style={{
        ...mono,
        fontSize: 11,
        textTransform: "lowercase",
        color: T.textMuted,
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
      }}
    >
      <span style={{ color: state === "idle" ? T.textFaint : T.accent }}>{num}</span>
      <span>·</span>
      <span style={{ color: T.text }}>{label}</span>
      <span style={{ flex: 1, height: 1, background: T.border, marginInline: 4 }} />
      <span style={{ color: metaColor }}>{meta}</span>
    </div>
  );
}

function Stage({
  id,
  num,
  label,
  meta,
  collapsed,
  expanded,
  open,
  onToggle,
  state,
  first,
  last,
}: {
  id: SectionId;
  num: string;
  label: string;
  meta: string;
  collapsed: React.ReactNode;
  expanded: React.ReactNode;
  open: boolean;
  onToggle: (id: SectionId) => void;
  state: StageState;
  first?: boolean;
  last?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "stretch" }}>
      <PipeMarker num={num} state={state} first={first} last={last} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          borderTop: first ? `1px solid ${T.border}` : "none",
          borderBottom: `1px solid ${T.border}`,
          background: state === "running" ? T.bgCard : "transparent",
          transition: "background 200ms ease-out",
        }}
      >
        <button
          onClick={() => onToggle(id)}
          aria-expanded={open}
          style={{
            all: "unset",
            cursor: "pointer",
            display: "block",
            width: "100%",
            padding: "20px 28px 16px",
            boxSizing: "border-box",
          }}
        >
          <Eyebrow num={num} label={label} meta={meta} state={state} />
          <div style={{ marginTop: 14 }}>{collapsed}</div>
        </button>
        <div
          style={{
            maxHeight: open ? 2400 : 0,
            transition: "max-height 200ms ease-out, opacity 200ms ease-out",
            opacity: open ? 1 : 0,
            overflow: "hidden",
          }}
        >
          <div style={{ borderTop: `1px solid ${T.border}`, padding: "22px 28px 26px" }}>
            {expanded}
          </div>
        </div>
      </div>
    </div>
  );
}

function Marker({ state }: { state: "idle" | "running" | "done" | "fail" }) {
  const color =
    state === "running" ? T.warn : state === "done" ? T.ok : state === "fail" ? T.danger : T.textFaint;
  return (
    <span
      aria-hidden
      style={{
        width: 10,
        height: 10,
        borderRadius: 999,
        border: `1px solid ${color}`,
        background: state === "done" ? color : "transparent",
        display: "inline-block",
        position: "relative",
        flexShrink: 0,
      }}
    >
      {state === "running" && (
        <span
          style={{
            position: "absolute",
            inset: 2,
            background: color,
            borderRadius: 999,
            animation: "vf-blink 1.1s ease-in-out infinite",
          }}
        />
      )}
    </span>
  );
}

function Row({ children, last }: { children: React.ReactNode; last?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "12px 0",
        borderBottom: last ? "none" : `1px solid ${T.border}`,
      }}
    >
      {children}
    </div>
  );
}

// ── 01 Agent Loop ──────────────────────────────────────────────
function LoopCollapsed({ stage }: { stage: StageState }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 22 }}>
      <span style={{ ...mono, fontSize: 36, color: T.text }}>#1284</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ ...geist, fontSize: 14, color: T.text }}>
          stage · {stage === "running" ? "monitor" : stage === "done" ? "complete" : "idle"}
        </span>
        <span style={{ ...mono, fontSize: 11, color: T.textMuted }}>
          uptime 18h 24m · last cycle 4.2s
        </span>
      </div>
    </div>
  );
}
function LoopExpanded() {
  const stages = [
    { name: "monitor", gate: "pass · pool depth ok", state: "done" as const },
    { name: "fetch", gate: "pass · 8/8 streams", state: "done" as const },
    { name: "decide", gate: "running · quorum pending", state: "running" as const },
    { name: "act", gate: "queued", state: "idle" as const },
    { name: "track", gate: "queued", state: "idle" as const },
  ];
  return (
    <div>
      <InspiredBy src='autoresearch · Andrej Karpathy · "NEVER STOP"' />
      <Narrative>
        Loop tak terbatas: fetch state → run gates → simulate → council → execute → sleep →
        ulangi. Yang penting: loop <b style={{ color: T.text }}>tidak boleh crash</b> karena satu
        error. Setiap error dicatat dan loop lanjut ke cycle berikutnya — persis seperti
        autoresearch yang punya crash recovery di program.md.
      </Narrative>
      <div style={{ ...mono, fontSize: 11, color: T.textFaint, marginBottom: 12 }}>
        stage pipeline · fast-fail gate per stage
      </div>
      {stages.map((s, i) => (
        <Row key={s.name} last={i === stages.length - 1}>
          <Marker state={s.state} />
          <span style={{ ...mono, fontSize: 11, color: T.textFaint, width: 28 }}>
            {String(i + 1).padStart(2, "0")}
          </span>
          <span style={{ ...geist, fontSize: 14, color: T.text, width: 110 }}>{s.name}</span>
          <span style={{ ...mono, fontSize: 12, color: T.textMuted, flex: 1 }}>{s.gate}</span>
        </Row>
      ))}
      <div
        style={{
          marginTop: 18,
          padding: "14px 16px",
          background: T.bgElev,
          borderRadius: 8,
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span style={{ ...mono, fontSize: 11, color: T.textMuted }}>async outcome tracker</span>
        <span style={{ ...mono, fontSize: 12, color: T.text }}>12 open · 4 settled · 0 stalled</span>
      </div>
    </div>
  );
}

// ── 02 Parallel Fetch ──────────────────────────────────────────
function FetchCollapsed() {
  const sources = ["aave-v3", "compound", "1inch", "uniswap-v3", "chain.gas", "venice.ai", "defillama", "etherscan"];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ ...mono, fontSize: 36, color: T.text }}>08</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {sources.map((s) => (
          <span
            key={s}
            style={{
              ...mono,
              fontSize: 11,
              color: T.textMuted,
              padding: "4px 8px",
              border: `1px solid ${T.border}`,
              borderRadius: 4,
            }}
          >
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}
function FetchExpanded() {
  const nodes = [
    { id: "aave-v3", lat: 142, state: "done" as const, deps: [] },
    { id: "compound", lat: 188, state: "done" as const, deps: [] },
    { id: "1inch", lat: 96, state: "done" as const, deps: ["aave-v3"] },
    { id: "uniswap-v3", lat: 211, state: "done" as const, deps: ["compound"] },
    { id: "chain.gas", lat: 64, state: "done" as const, deps: [] },
    { id: "venice.ai", lat: 412, state: "running" as const, deps: ["aave-v3", "compound"] },
    { id: "defillama", lat: 287, state: "done" as const, deps: [] },
    { id: "etherscan", lat: 122, state: "done" as const, deps: ["chain.gas"] },
  ];
  return (
    <div>
      <InspiredBy src="EvoAgentX · DAG workflow · nodes run concurrently" />
      <Narrative>
        DAG di mana nodes yang gak saling bergantung jalan paralel. Fetch pools, gas, positions,
        on-chain signals — semua via <span style={mono}>Promise.all</span>. Sequential = 4 × 500ms
        = 2 detik. Parallel = max(500ms) = 500ms. Non-trivial untuk DeFi timing.
      </Narrative>
      <div style={{ ...mono, fontSize: 11, color: T.textFaint, marginBottom: 12 }}>
        dag · 8 nodes · 3 dependency edges
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        {nodes.map((n) => (
          <div
            key={n.id}
            style={{
              border: `1px solid ${n.state === "running" ? T.warn : T.border}`,
              borderRadius: 8,
              padding: 12,
              background: T.bgElev,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Marker state={n.state} />
              <span style={{ ...mono, fontSize: 11, color: T.text }}>{n.id}</span>
            </div>
            <div style={{ ...mono, fontSize: 18, color: T.text, marginTop: 8 }}>
              {n.lat}
              <span style={{ fontSize: 11, color: T.textFaint, marginLeft: 4 }}>ms</span>
            </div>
            <div style={{ ...mono, fontSize: 10, color: T.textFaint, marginTop: 4 }}>
              deps · {n.deps.length === 0 ? "root" : n.deps.join(", ")}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 03 AI Council ──────────────────────────────────────────────
const COUNCIL = [
  { name: "Risk Analyst", stance: "hold", conf: 72 },
  { name: "Yield Optimizer", stance: "rotate to aave-v3", conf: 84 },
  { name: "Gas Strategist", stance: "wait 6 blocks", conf: 91 },
];
function CouncilCollapsed() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
      {COUNCIL.map((a) => (
        <div
          key={a.name}
          style={{
            border: `1px solid ${T.border}`,
            borderRadius: 8,
            padding: 14,
            background: T.bgElev,
          }}
        >
          <div style={{ ...mono, fontSize: 10, color: T.textFaint, marginBottom: 6 }}>agent</div>
          <div style={{ ...geist, fontSize: 13, color: T.text, marginBottom: 10 }}>{a.name}</div>
          <div style={{ ...mono, fontSize: 11, color: T.textMuted, marginBottom: 8 }}>{a.stance}</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ ...mono, fontSize: 10, color: T.textFaint }}>conf</span>
            <span style={{ ...mono, fontSize: 18, color: T.text }}>{a.conf}%</span>
          </div>
        </div>
      ))}
    </div>
  );
}
function CouncilExpanded() {
  const debate = [
    { who: "Risk Analyst", text: "drawdown profile on aave-v3 widened 1.4σ over 24h. recommend hold." },
    { who: "Yield Optimizer", text: "blended apy uplift is 218bps. risk-adjusted still positive." },
    { who: "Gas Strategist", text: "base fee trending down. wait 6 blocks saves ~38% gas." },
    { who: "Risk Analyst", text: "concede on gas timing. maintain hold on size." },
  ];
  return (
    <div>
      <InspiredBy src="TradingAgents · TauricResearch · Bull/Bear debate pattern" />
      <Narrative>
        Tiga specialist agents jalan parallel, masing-masing punya system prompt dan data yang
        beda. Bukan "nanya hal yang sama 3 kali" — tiap agent liat dimensi berbeda, punya subset
        playbook yang relevan, dan output-nya compressed verdict. Setiap verdict include{" "}
        <span style={mono}>citedRules</span> — playbook mana yang dipakai.
      </Narrative>
      <div style={{ ...mono, fontSize: 11, color: T.textFaint, marginBottom: 12 }}>
        debate log · 4 turns · 12.4s
      </div>
      {debate.map((d, i) => (
        <Row key={i} last={i === debate.length - 1}>
          <span style={{ ...mono, fontSize: 11, color: T.textFaint, width: 28 }}>
            {String(i + 1).padStart(2, "0")}
          </span>
          <span style={{ ...geist, fontSize: 13, color: T.text, width: 140 }}>{d.who}</span>
          <span style={{ ...geist, fontSize: 13, color: T.textMuted, flex: 1 }}>{d.text}</span>
        </Row>
      ))}
    </div>
  );
}

// ── 04 Simulation — with thinking skeleton ────────────────────
const TIMELINES = [
  {
    id: "A",
    name: "Timeline A",
    label: "stress",
    prob: 22,
    yield: "−4.8%",
    conf: 0.69,
    tone: T.danger,
    headline: "vault under stress · market unwinding",
    facts: [
      { k: "news.sentiment", v: "panic · 18 negative headlines / 24h" },
      { k: "market.btc", v: "−9.4% · 4h candle" },
      { k: "vault.tvl", v: "1.2M usdc · ↓ 38% from 7d high" },
      { k: "pool.depth", v: "thin · slippage risk on exit" },
      { k: "gas.base", v: "62 gwei · congestion spike" },
    ],
  },
  {
    id: "B",
    name: "Timeline B",
    label: "favorable",
    prob: 31,
    yield: "+12.6%",
    conf: 0.74,
    tone: T.ok,
    headline: "supportive macro · vault accreting",
    facts: [
      { k: "news.sentiment", v: "constructive · etf inflows confirmed" },
      { k: "market.btc", v: "+4.1% · steady bid" },
      { k: "vault.tvl", v: "3.4M usdc · ↑ 12% week-on-week" },
      { k: "pool.depth", v: "deep · 0.05% slippage at 50k" },
      { k: "gas.base", v: "14 gwei · quiet block space" },
    ],
  },
  {
    id: "C",
    name: "Timeline C",
    label: "neutral",
    prob: 47,
    yield: "+5.2%",
    conf: 0.86,
    tone: T.info,
    headline: "range-bound · vault stable",
    facts: [
      { k: "news.sentiment", v: "mixed · no dominant narrative" },
      { k: "market.btc", v: "−0.4% · chop within range" },
      { k: "vault.tvl", v: "2.1M usdc · flat 7d" },
      { k: "pool.depth", v: "ok · normal liquidity" },
      { k: "gas.base", v: "22 gwei · baseline" },
    ],
  },
  {
    id: "D",
    name: "Timeline D",
    label: "volatile",
    prob: 18,
    yield: "+8.1%",
    conf: 0.61,
    tone: T.warn,
    headline: "high vol · whipsaw conditions",
    facts: [
      { k: "news.sentiment", v: "noisy · conflicting signals" },
      { k: "market.btc", v: "±6% intraday · expanding range" },
      { k: "vault.tvl", v: "2.8M usdc · oscillating" },
      { k: "pool.depth", v: "patchy · MEV-active blocks" },
      { k: "gas.base", v: "48 gwei · uneven spikes" },
    ],
  },
  {
    id: "E",
    name: "Timeline E",
    label: "breakout",
    prob: 14,
    yield: "+18.4%",
    conf: 0.58,
    tone: T.accent,
    headline: "regime shift · upside breakout",
    facts: [
      { k: "news.sentiment", v: "euphoric · narrative locks in" },
      { k: "market.btc", v: "+11.2% · trend day" },
      { k: "vault.tvl", v: "4.6M usdc · ↑ 26% intraday" },
      { k: "pool.depth", v: "deep · institutional bid" },
      { k: "gas.base", v: "31 gwei · steady" },
    ],
  },
  {
    id: "F",
    name: "Timeline F",
    label: "drawdown",
    prob: 12,
    yield: "−9.4%",
    conf: 0.66,
    tone: T.danger,
    headline: "broad risk-off · capitulation tail",
    facts: [
      { k: "news.sentiment", v: "fear · forced liquidation chatter" },
      { k: "market.btc", v: "−14.7% · breakdown" },
      { k: "vault.tvl", v: "0.9M usdc · ↓ 52% from high" },
      { k: "pool.depth", v: "evaporating · wide spreads" },
      { k: "gas.base", v: "84 gwei · liquidation gas war" },
    ],
  },
  {
    id: "G",
    name: "Timeline G",
    label: "grind-up",
    prob: 28,
    yield: "+6.8%",
    conf: 0.78,
    tone: T.ok,
    headline: "slow accumulation · low vol drift",
    facts: [
      { k: "news.sentiment", v: "quietly positive · no surprises" },
      { k: "market.btc", v: "+1.8% · low-realized-vol" },
      { k: "vault.tvl", v: "2.6M usdc · ↑ 4% week" },
      { k: "pool.depth", v: "deep · passive flow" },
      { k: "gas.base", v: "12 gwei · cheap blocks" },
    ],
  },
  {
    id: "H",
    name: "Timeline H",
    label: "sideways",
    prob: 24,
    yield: "+2.1%",
    conf: 0.72,
    tone: T.info,
    headline: "compression · waiting for catalyst",
    facts: [
      { k: "news.sentiment", v: "flat · low desk activity" },
      { k: "market.btc", v: "+0.3% · tight range" },
      { k: "vault.tvl", v: "2.0M usdc · unchanged 14d" },
      { k: "pool.depth", v: "thin but stable" },
      { k: "gas.base", v: "16 gwei · quiet" },
    ],
  },
];

const MAX_BRANCHES = TIMELINES.length; // 8
const MAX_WORKERS = 8;
const MIN_BRANCHES = 1;
const MIN_WORKERS = 1;

function SkeletonLine({ w, h = 10, delay = 0 }: { w: number | string; h?: number; delay?: number }) {
  return (
    <span
      style={{
        display: "block",
        width: typeof w === "number" ? `${w}%` : w,
        height: h,
        background: T.bgElev2,
        borderRadius: 3,
        animation: `vf-skeleton 1.6s ease-in-out ${delay}ms infinite`,
      }}
    />
  );
}

function InspiredBy({ src }: { src: string }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 10px",
        border: `1px solid ${T.border}`,
        borderRadius: 4,
        ...mono,
        fontSize: 10.5,
        color: T.textFaint,
        marginBottom: 14,
        textTransform: "lowercase",
      }}
    >
      <span style={{ color: T.textMuted }}>inspired by</span>
      <span style={{ color: T.text }}>{src}</span>
    </div>
  );
}

function Narrative({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        ...geist,
        fontSize: 14,
        color: T.textMuted,
        lineHeight: 1.6,
        maxWidth: 580,
        margin: "0 0 18px",
      }}
    >
      {children}
    </p>
  );
}

// ── Step 1 · Formalize State/Action/Reward ────────────────────
function StateCollapsed() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24 }}>
      {[
        { k: "state.dim", v: "42" },
        { k: "action.space", v: "5" },
        { k: "reward.fn", v: "net.usd − gas − il" },
      ].map((c) => (
        <div key={c.k}>
          <div style={{ ...mono, fontSize: 10, color: T.textFaint, marginBottom: 6 }}>{c.k}</div>
          <span style={{ ...mono, fontSize: c.v.length > 10 ? 14 : 28, color: T.text }}>{c.v}</span>
        </div>
      ))}
    </div>
  );
}
function StateExpanded() {
  const fields = [
    { k: "S · tvl[]", v: "per-vault total value locked · 7d series" },
    { k: "S · apy[]", v: "current + 24h average apy per protocol" },
    { k: "S · gas.base", v: "rolling gwei · 1h median" },
    { k: "S · positions", v: "user open positions · vault + share" },
    { k: "S · sentiment", v: "news score · scalar [−1, +1]" },
    { k: "A · hold", v: "no-op · sleep one cycle" },
    { k: "A · rotate", v: "swap vault X → vault Y · amount" },
    { k: "A · deposit", v: "open new position · amount + vault" },
    { k: "A · withdraw", v: "close position · amount + vault" },
    { k: "A · split", v: "rebalance across N vaults · weights" },
    { k: "R", v: "net usd realised − gas − impermanent loss · 7d window" },
  ];
  return (
    <div>
      <InspiredBy src="FinRL · AI4Finance Foundation" />
      <Narrative>
        Trading sebagai RL problem: <b style={{ color: T.text }}>State</b> (apa yang diamati),{" "}
        <b style={{ color: T.text }}>Action</b> (apa yang bisa dilakukan),{" "}
        <b style={{ color: T.text }}>Reward</b> (gimana ngukur sukses). Vibing Farmer butuh
        formalisasi yang sama biar agent punya bahasa yang jelas — bukan sekadar "fetch data →
        tanya AI".
      </Narrative>
      <div style={{ borderTop: `1px solid ${T.border}` }}>
        {fields.map((f) => (
          <div
            key={f.k}
            style={{
              display: "grid",
              gridTemplateColumns: "180px 1fr",
              gap: 12,
              padding: "10px 0",
              borderBottom: `1px solid ${T.border}`,
            }}
          >
            <span style={{ ...mono, fontSize: 11, color: T.textFaint }}>{f.k}</span>
            <span style={{ ...mono, fontSize: 12, color: T.text }}>{f.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Step 4 · Fast-fail Gates ──────────────────────────────────
function GatesCollapsed() {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 22 }}>
      <span style={{ ...mono, fontSize: 36, color: T.text }}>4/5</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ ...geist, fontSize: 14, color: T.text }}>gates passed</span>
        <span style={{ ...mono, fontSize: 11, color: T.textMuted }}>
          1 soft-fail · turbulence elevated
        </span>
      </div>
    </div>
  );
}
function GatesExpanded() {
  const gates = [
    { name: "turbulence.index", expr: "rolling_chaos < 0.62", state: "soft", val: "0.71" },
    { name: "gas.ceiling", expr: "base_fee < 80 gwei", state: "pass", val: "22 gwei" },
    { name: "balance.min", expr: "wallet.usdc ≥ 25", state: "pass", val: "1 248.42" },
    { name: "drawdown.cap", expr: "7d_drawdown > −12%", state: "pass", val: "−3.4%" },
    { name: "cooldown", expr: "since_last_act > 90s", state: "pass", val: "612s" },
  ];
  return (
    <div>
      <InspiredBy src="FinRL · Turbulence Index + hard constraints" />
      <Narrative>
        Garis pertahanan pertama. Semua pure functions — input → boolean. Gak ada AI call, gak ada
        network request. Kalau gate fail, loop langsung sleep tanpa buang Venice AI credit.
      </Narrative>
      <div style={{ borderTop: `1px solid ${T.border}` }}>
        {gates.map((g) => {
          const c = g.state === "pass" ? T.ok : g.state === "soft" ? T.warn : T.danger;
          return (
            <div
              key={g.name}
              style={{
                display: "grid",
                gridTemplateColumns: "24px 180px 1fr auto auto",
                gap: 12,
                alignItems: "baseline",
                padding: "12px 0",
                borderBottom: `1px solid ${T.border}`,
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  border: `1px solid ${c}`,
                  background: g.state === "pass" ? c : "transparent",
                }}
              />
              <span style={{ ...mono, fontSize: 12, color: T.text }}>{g.name}</span>
              <span style={{ ...mono, fontSize: 11, color: T.textFaint }}>{g.expr}</span>
              <span style={{ ...mono, fontSize: 12, color: T.text }}>{g.val}</span>
              <span style={{ ...mono, fontSize: 10, color: c, textTransform: "uppercase" }}>
                {g.state}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Step 9 · Execution Layer ──────────────────────────────────
function ExecutionCollapsed() {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 22 }}>
      <span style={{ ...mono, fontSize: 36, color: T.text }}>02</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ ...geist, fontSize: 14, color: T.text }}>tx in flight</span>
        <span style={{ ...mono, fontSize: 11, color: T.textMuted }}>
          session key · valid 23h 47m · 1shot · ready
        </span>
      </div>
    </div>
  );
}
function ExecutionExpanded() {
  const session = [
    { k: "session.key", v: "0x71f3…aa02" },
    { k: "session.max.gas", v: "200 000 wei" },
    { k: "session.max.amount", v: "100 USDC · per tx" },
    { k: "session.whitelist", v: "aave-v3 · compound · uniswap-v3" },
    { k: "session.expires", v: "23h 47m" },
    { k: "1shot.route", v: "rotate · compound → aave-v3 · via uniswap-v3" },
    { k: "1shot.steps", v: "approve → swap → approve → deposit" },
    { k: "1shot.eta", v: "≈ 18s · 4 tx batched" },
  ];
  return (
    <div>
      <InspiredBy src="MetaMask Smart Accounts (ERC-4337) + 1Shot API" />
      <Narrative>
        Yang bedain "autonomous agent" sama "assistant yang butuh konfirmasi" adalah kemampuan
        execute tanpa human approval per-tx. User sign sekali untuk authorize agent dalam batas
        tertentu — habis itu, 1Shot handle routing dan execution.
      </Narrative>
      <div style={{ borderTop: `1px solid ${T.border}` }}>
        {session.map((s) => (
          <div
            key={s.k}
            style={{
              display: "grid",
              gridTemplateColumns: "180px 1fr",
              gap: 12,
              padding: "10px 0",
              borderBottom: `1px solid ${T.border}`,
            }}
          >
            <span style={{ ...mono, fontSize: 11, color: T.textFaint }}>{s.k}</span>
            <span style={{ ...mono, fontSize: 12, color: T.text }}>{s.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Step 12 · Curator ─────────────────────────────────────────
function CuratorCollapsed() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24 }}>
      {[
        { k: "rules.added", v: "+3", d: "today" },
        { k: "dedup.hits", v: "7", d: "counter ++ instead" },
        { k: "rules.total", v: "47", d: "active" },
      ].map((c) => (
        <div key={c.k}>
          <div style={{ ...mono, fontSize: 10, color: T.textFaint, marginBottom: 6 }}>{c.k}</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ ...mono, fontSize: 28, color: T.text }}>{c.v}</span>
            <span style={{ ...mono, fontSize: 10, color: T.textFaint }}>{c.d}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
function CuratorExpanded() {
  const ops = [
    { op: "ADD", rule: "defi-048 · if turbulence > 0.7 wait 2 cycles", res: "new · risk" },
    { op: "DEDUP", rule: "defi-012 · gas ceiling pattern", res: "counter ++ · helpful 7→8" },
    { op: "ADD", rule: "defi-049 · favor deep-pool exits in stress timeline", res: "new · strategy" },
    { op: "ADD", rule: "defi-050 · revisit if vault tvl drops 30% in 24h", res: "new · risk" },
    { op: "DEDUP", rule: "defi-031 · session reuse approval", res: "counter ++ · helpful 4→5" },
  ];
  return (
    <div>
      <InspiredBy src="ACE Stanford · Curator Agent · ICLR 2026" />
      <Narrative>
        Curator nambahin rules secara incremental — gak rewrite seluruh playbook (itu yang
        nyebabin "context collapse"). Sebelum ADD, cek duplikat via Jaccard. Kalau mirip, increment
        counter aja daripada tambah rule baru yang redundant.
      </Narrative>
      <div style={{ borderTop: `1px solid ${T.border}` }}>
        {ops.map((o, i) => (
          <div
            key={i}
            style={{
              display: "grid",
              gridTemplateColumns: "60px 1fr auto",
              gap: 12,
              padding: "12px 0",
              borderBottom: `1px solid ${T.border}`,
              alignItems: "baseline",
            }}
          >
            <span
              style={{
                ...mono,
                fontSize: 10,
                color: o.op === "ADD" ? T.accent : T.textMuted,
              }}
            >
              {o.op}
            </span>
            <span style={{ ...mono, fontSize: 12, color: T.text }}>{o.rule}</span>
            <span style={{ ...mono, fontSize: 11, color: T.textFaint }}>{o.res}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Step 13 · BulletpointAnalyzer ─────────────────────────────
function BulletCollapsed() {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 22 }}>
      <span style={{ ...mono, fontSize: 36, color: T.text }}>0.74</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ ...geist, fontSize: 14, color: T.text }}>
          top jaccard pair · 2 candidates pending merge
        </span>
        <span style={{ ...mono, fontSize: 11, color: T.textMuted }}>
          venice.ai · simplified from faiss + sentence-transformers
        </span>
      </div>
    </div>
  );
}
function BulletExpanded() {
  const pairs = [
    { a: "defi-014", b: "defi-027", j: 0.74, action: "merge · sum counters → helpful 9" },
    { a: "defi-008", b: "defi-041", j: 0.62, action: "merge candidate · awaiting venice" },
    { a: "defi-019", b: "defi-033", j: 0.38, action: "below threshold · skip" },
  ];
  return (
    <div>
      <InspiredBy src="ACE Stanford · BulletpointAnalyzer (Jaccard + Venice AI)" />
      <Narrative>
        ACE pakai FAISS + sentence-transformers untuk detect rules yang mirip secara semantik,
        terus merge via LLM. Vibing Farmer simplify: Jaccard buat detect kandidat, Venice AI buat
        merge. Pas merge, <b style={{ color: T.text }}>sum the counters</b> — empirical evidence
        gak hilang.
      </Narrative>
      <div style={{ borderTop: `1px solid ${T.border}` }}>
        {pairs.map((p, i) => {
          const above = p.j >= 0.6;
          return (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: "120px 80px 1fr",
                gap: 12,
                padding: "12px 0",
                borderBottom: `1px solid ${T.border}`,
                alignItems: "baseline",
              }}
            >
              <span style={{ ...mono, fontSize: 12, color: T.text }}>
                {p.a} ↔ {p.b}
              </span>
              <span style={{ ...mono, fontSize: 12, color: above ? T.accent : T.textMuted }}>
                j={p.j.toFixed(2)}
              </span>
              <span style={{ ...mono, fontSize: 11, color: T.textMuted }}>{p.action}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SimCollapsed({ thinking, n = 3 }: { thinking: boolean; n?: number }) {
  const count = Math.max(1, Math.min(MAX_BRANCHES, n));
  const list = TIMELINES.slice(0, count);

  // Compact fan-out tree — single SVG so branches truly emanate from "now".
  const W = 420;
  const rowH = 17;
  const padTop = 10;
  const padBot = 10;
  const innerH = Math.max(rowH, (count - 1) * rowH);
  const H = padTop + padBot + innerH;
  const nowX = 18;
  const nowY = H / 2;
  const endX = W - 96; // leave room for label + yield text
  const endYs =
    count === 1
      ? [nowY]
      : Array.from({ length: count }, (_, i) => padTop + (i * innerH) / (count - 1));

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <svg width={W} height={H} style={{ flexShrink: 0, display: "block" }}>
        {list.map((s, i) => {
          const ey = endYs[i];
          const d = `M ${nowX} ${nowY} C ${nowX + 80} ${nowY}, ${endX - 70} ${ey}, ${endX} ${ey}`;
          return (
            <g key={s.id}>
              <path
                d={d}
                stroke={s.tone}
                strokeWidth={1.2}
                fill="none"
                opacity={thinking ? 0.55 : 0.9}
                strokeDasharray={thinking ? "3 3" : "0"}
              />
              <circle cx={endX} cy={ey} r={3} fill={s.tone} />
              <text
                x={endX + 8}
                y={ey + 3.5}
                fill={T.textFaint}
                fontSize={10}
                fontFamily="JetBrains Mono"
              >
                {s.id}
              </text>
              {!thinking && (
                <text
                  x={endX + 22}
                  y={ey + 3.5}
                  fill={s.tone}
                  fontSize={10}
                  fontFamily="JetBrains Mono"
                >
                  {s.yield}
                </text>
              )}
            </g>
          );
        })}
        {/* now anchor */}
        <circle cx={nowX} cy={nowY} r={7} fill="none" stroke={T.text} strokeWidth={1} opacity={0.25} />
        <circle cx={nowX} cy={nowY} r={4} fill={T.text} />
        <text
          x={nowX + 10}
          y={nowY - 8}
          fill={T.textFaint}
          fontSize={10}
          fontFamily="JetBrains Mono"
        >
          now
        </text>
      </svg>
      <span style={{ ...mono, fontSize: 11, color: T.textFaint }}>×{count}</span>
      {thinking && (
        <span
          style={{
            ...mono,
            fontSize: 10,
            color: T.textFaint,
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: T.accent,
              animation: "vf-blink 1.1s ease-in-out infinite",
            }}
          />
          branching
        </span>
      )}
    </div>
  );
}
// Branch SVG paths from "now" (x=40,y=140) to terminal (x=W-40, branch-specific y)
const SIM_W = 560;
const SIM_H = 280;
const NOW_X = 44;
const NOW_Y = SIM_H / 2;
const END_X = SIM_W - 110;

function distributeEndYs(n: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [NOW_Y];
  const top = 36;
  const bot = SIM_H - 36;
  const step = (bot - top) / (n - 1);
  return Array.from({ length: n }, (_, i) => top + i * step);
}

function branchPath(endY: number) {
  // Smooth cubic from (NOW_X, NOW_Y) → (END_X, endY)
  const c1x = NOW_X + 140;
  const c1y = NOW_Y;
  const c2x = END_X - 200;
  const c2y = endY;
  return `M ${NOW_X} ${NOW_Y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${END_X} ${endY}`;
}

function SimExpanded({ thinking, n = 3 }: { thinking: boolean; n?: number }) {
  const count = Math.max(1, Math.min(MAX_BRANCHES, n));
  const endYs = distributeEndYs(count);
  const branches = TIMELINES.slice(0, count).map((s, i) => ({
    ...s,
    endY: endYs[i],
  }));
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const selBranch = branches.find((b) => b.id === selected) ?? null;

  return (
    <div>
      {!thinking && (
        <>
          <InspiredBy src="Concept ZX · alternate timeline simulation · DeFi-adapted" />
          <Narrative>
            Dari satu "now" moment, venice.ai bercabang ke {count} alternate future
            {count === 1 ? "" : "s"} dengan asumsi berbeda — divergent trajectories menuju terminal
            yield.
          </Narrative>
        </>
      )}

      <div
        style={{
          position: "relative",
          width: "100%",
          background: T.bgElev,
          border: `1px solid ${T.border}`,
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <svg
          viewBox={`0 0 ${SIM_W} ${SIM_H}`}
          width="100%"
          style={{ display: "block" }}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* time axis ticks */}
          {[0.25, 0.5, 0.75].map((p) => {
            const x = NOW_X + (END_X - NOW_X) * p;
            return (
              <line
                key={p}
                x1={x}
                y1={20}
                x2={x}
                y2={SIM_H - 20}
                stroke={T.border}
                strokeWidth={1}
                strokeDasharray="2 6"
                opacity={0.5}
              />
            );
          })}
          <text x={NOW_X} y={SIM_H - 6} fill={T.textFaint} fontSize={9} fontFamily="JetBrains Mono">
            t=0
          </text>
          <text x={END_X} y={SIM_H - 6} fill={T.textFaint} fontSize={9} fontFamily="JetBrains Mono" textAnchor="end">
            t=Δ
          </text>

          {/* Branches */}
          {branches.map((b, idx) => {
            const d = branchPath(b.endY);
            const branchDelay = idx * 420;
            const pathLen = 700; // approx length for dash
            const isActive = selected === b.id || hovered === b.id;
            const dimmed = (selected || hovered) && !isActive;
            return (
              <g
                key={b.id}
                style={{
                  cursor: "pointer",
                  opacity: dimmed ? 0.35 : 1,
                  transition: "opacity 180ms ease",
                }}
                onClick={() => setSelected((s) => (s === b.id ? null : b.id))}
                onMouseEnter={() => setHovered(b.id)}
                onMouseLeave={() => setHovered(null)}
              >
                {/* invisible thick hitbox for easier clicking */}
                <path d={d} stroke="transparent" strokeWidth={20} fill="none" />
                {/* faint ghost path */}
                <path d={d} stroke={b.tone} strokeWidth={1} fill="none" opacity={0.12} />
                {/* drawing path */}
                <path
                  d={d}
                  stroke={b.tone}
                  strokeWidth={1.6}
                  fill="none"
                  strokeLinecap="round"
                  strokeDasharray={pathLen}
                  strokeDashoffset={pathLen}
                  style={{
                    animation: `vf-draw 1100ms ease-out ${branchDelay}ms forwards`,
                  }}
                />

                {/* Moment nodes along path */}
                {b.facts.map((_, i) => {
                  const t = (i + 1) / (b.facts.length + 1);
                  // sample bezier at t
                  const cx = bezierX(t);
                  const cy = bezierY(t, b.endY);
                  const nodeDelay = branchDelay + 250 + i * 170;
                  return (
                    <g key={i} style={{ opacity: 0, animation: `vf-fadein 320ms ease-out ${nodeDelay}ms forwards` }}>
                      {thinking && (
                        <circle
                          cx={cx}
                          cy={cy}
                          r={4}
                          fill="none"
                          stroke={b.tone}
                          strokeWidth={1}
                          style={{ animation: `vf-pulse-ring 1.4s ease-out ${nodeDelay}ms infinite` }}
                        />
                      )}
                      <circle cx={cx} cy={cy} r={3.5} fill={T.bg} stroke={b.tone} strokeWidth={1.5} />
                    </g>
                  );
                })}

                {/* Traveling pulse during thinking */}
                {thinking && (
                  <circle r={3.5} fill={b.tone} opacity={0.9}>
                    <animateMotion dur="1.8s" repeatCount="indefinite" begin={`${branchDelay}ms`} path={d} />
                  </circle>
                )}

                {/* Terminal node */}
                <g style={{ opacity: 0, animation: `vf-fadein 420ms ease-out ${branchDelay + 1100}ms forwards` }}>
                  <circle cx={END_X} cy={b.endY} r={6} fill={b.tone} />
                  <circle cx={END_X} cy={b.endY} r={9} fill="none" stroke={b.tone} strokeWidth={1} opacity={0.4} />
                  <text
                    x={END_X + 14}
                    y={b.endY - 4}
                    fill={b.tone}
                    fontSize={12}
                    fontFamily="JetBrains Mono"
                  >
                    {b.yield}
                  </text>
                  <text
                    x={END_X + 14}
                    y={b.endY + 10}
                    fill={T.textFaint}
                    fontSize={9}
                    fontFamily="JetBrains Mono"
                  >
                    {b.id} · {b.label}
                  </text>
                </g>

                {/* probability bar at start of branch */}
                <g style={{ opacity: 0, animation: `vf-fadein 400ms ease-out ${branchDelay + 1400}ms forwards` }}>
                  <rect
                    x={NOW_X - 24}
                    y={b.endY > NOW_Y ? NOW_Y + 6 + idx * 4 : NOW_Y - 10 - (2 - idx) * 4}
                    width={(b.prob / 100) * 22}
                    height={2}
                    fill={b.tone}
                    opacity={0.6}
                  />
                </g>
              </g>
            );
          })}

          {/* "now" trunk node — always pulsing */}
          <circle cx={NOW_X} cy={NOW_Y} r={10} fill="none" stroke={T.text} strokeWidth={1} opacity={0.25} />
          <circle cx={NOW_X} cy={NOW_Y} r={5} fill={T.text}>
            <animate attributeName="r" values="5;7;5" dur="1.8s" repeatCount="indefinite" />
          </circle>
          <text x={NOW_X} y={NOW_Y - 16} fill={T.textFaint} fontSize={10} fontFamily="JetBrains Mono" textAnchor="middle">
            now
          </text>
        </svg>

        {/* Bottom-right thinking indicator */}
        {thinking && (
          <div
            style={{
              position: "absolute",
              right: 12,
              top: 10,
              ...mono,
              fontSize: 10,
              color: T.textFaint,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: 999,
                background: T.accent,
                animation: "vf-blink 1.1s ease-in-out infinite",
              }}
            />
            forking
          </div>
        )}
      </div>

      {/* Detail panel: revealed on branch click */}
      {selBranch ? (
        <div
          key={selBranch.id}
          style={{
            marginTop: 12,
            border: `1px solid ${T.border}`,
            borderLeft: `2px solid ${selBranch.tone}`,
            borderRadius: 8,
            background: T.bgElev,
            padding: 14,
            animation: "vf-slideup 220ms ease-out",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ ...geist, fontSize: 13, color: T.text }}>
              {selBranch.name}
              <span style={{ ...mono, fontSize: 11, color: selBranch.tone, marginLeft: 10 }}>
                · {selBranch.label}
              </span>
            </span>
            <button
              onClick={() => setSelected(null)}
              style={{
                ...mono,
                fontSize: 10,
                color: T.textFaint,
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: 0,
              }}
            >
              close ×
            </button>
          </div>
          <div style={{ ...geist, fontSize: 12, color: T.textMuted, marginBottom: 12 }}>
            {selBranch.headline}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "150px 1fr",
              rowGap: 6,
              ...mono,
              fontSize: 11,
            }}
          >
            {selBranch.facts.flatMap((f) => [
              <span key={`k-${f.k}`} style={{ color: T.textFaint }}>{f.k}</span>,
              <span key={`v-${f.k}`} style={{ color: T.text }}>{f.v}</span>,
            ])}
            <span style={{ color: T.textFaint }}>p · prob</span>
            <span style={{ color: T.text }}>{selBranch.prob}% · conf {selBranch.conf.toFixed(2)}</span>
            <span style={{ color: T.textFaint }}>→ projected.yield</span>
            <span style={{ color: selBranch.tone }}>{selBranch.yield}</span>
          </div>
        </div>
      ) : (
        !thinking && (
          <div style={{ ...mono, fontSize: 10, color: T.textFaint, marginTop: 8, display: "flex", justifyContent: "space-between" }}>
            <span>click a branch to inspect timeline</span>
            <span>venice.ai · 1.84s</span>
          </div>
        )
      )}
    </div>
  );
}

// Cubic bezier sampler — control points match branchPath() above
function bezierX(t: number) {
  const p0 = NOW_X, p1 = NOW_X + 140, p2 = END_X - 200, p3 = END_X;
  const mt = 1 - t;
  return mt ** 3 * p0 + 3 * mt ** 2 * t * p1 + 3 * mt * t ** 2 * p2 + t ** 3 * p3;
}
function bezierY(t: number, endY: number) {
  const p0 = NOW_Y, p1 = NOW_Y, p2 = endY, p3 = endY;
  const mt = 1 - t;
  return mt ** 3 * p0 + 3 * mt ** 2 * t * p1 + 3 * mt * t ** 2 * p2 + t ** 3 * p3;
}

// ── 05 Verdict ────────────────────────────────────────────────
function VerdictCollapsed() {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 22 }}>
      <span style={{ ...mono, fontSize: 36, color: T.text }}>0.82</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ ...geist, fontSize: 14, color: T.text }}>rotate 40 usdc · aave-v3</span>
        <span style={{ ...mono, fontSize: 11, color: T.textMuted }}>
          quorum 3/3 · confidence 82%
        </span>
      </div>
    </div>
  );
}
function VerdictExpanded() {
  return (
    <div>
      <InspiredBy src="EvoDS · ACC pattern · compressed verdicts → manager" />
      <Narrative>
        Manager nerima 3 compressed verdicts (bukan raw log) dan mutusin. Logic-nya deterministic:
        butuh <b style={{ color: T.text }}>2/3 majority</b> DAN minimum confidence. Kalau salah
        satu gak terpenuhi → HOLD. Setiap decision di-log dengan citedRules buat Reflector update
        counters nanti.
      </Narrative>
      <div style={{ ...mono, fontSize: 11, color: T.textFaint, marginBottom: 12 }}>
        verdict · cycle #1284
      </div>
      <p
        style={{
          ...geist,
          fontSize: 14,
          color: T.text,
          lineHeight: 1.6,
          maxWidth: 580,
          margin: 0,
        }}
      >
        Rotate 40 USDC from compound to aave-v3 in 6 blocks. Yield Optimizer and Gas Strategist agree
        on direction and timing. Risk Analyst concedes after gas argument, maintains size cap.
      </p>
      <div
        style={{
          marginTop: 18,
          padding: "14px 16px",
          background: T.bgElev,
          borderRadius: 8,
          ...mono,
          fontSize: 11,
          color: T.textMuted,
        }}
      >
        dissent · Risk Analyst flags revisit if pool depth drops below 1.2M.
      </div>
      <div
        style={{
          marginTop: 22,
          paddingTop: 22,
          borderTop: `1px solid ${T.border}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ ...mono, fontSize: 11, color: T.textFaint }}>
          commit · sends 1 tx to scoped worker
        </span>
        <button
          style={{
            ...geist,
            fontSize: 14,
            fontWeight: 500,
            padding: "11px 22px",
            background: T.accent,
            color: T.accentFg,
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          Commit verdict
        </button>
      </div>
    </div>
  );
}

// ── 06 Memory ─────────────────────────────────────────────────
function MemoryCollapsed() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24 }}>
      {[
        { k: "vectors", v: "8 412", d: "+184" },
        { k: "rules", v: "47", d: "+3" },
        { k: "patterns", v: "126", d: "+12" },
      ].map((c) => (
        <div key={c.k}>
          <div style={{ ...mono, fontSize: 10, color: T.textFaint, marginBottom: 6 }}>{c.k}</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ ...mono, fontSize: 28, color: T.text }}>{c.v}</span>
            <span style={{ ...mono, fontSize: 11, color: T.ok }}>{c.d}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
function MemoryExpanded() {
  const entries = [
    { t: "vector", desc: "swap slippage outcome · usdc/usdc 0.05% pool", tag: "fresh" },
    { t: "rule", desc: "if base_fee > 40 gwei wait min 4 blocks", tag: "promoted" },
    { t: "pattern", desc: "aave-v3 apy spikes precede 3-block gas drop", tag: "validated" },
    { t: "vector", desc: "vault share price drift on deposit · 1.0241", tag: "fresh" },
  ];
  return (
    <div>
      <InspiredBy src="ACE Stanford · Evolving Playbook · ICLR 2026" />
      <Narrative>
        Playbook sebagai <b style={{ color: T.text }}>living document</b> — bukan static prompt,
        tapi collection of rules yang tumbuh, di-refine, dan di-prune berdasarkan empirical
        evidence. Tiap rule punya counters <span style={mono}>helpful</span> dan{" "}
        <span style={mono}>harmful</span> yang di-update tiap kali outcome diketahui.
      </Narrative>
      <div style={{ ...mono, fontSize: 11, color: T.textFaint, marginBottom: 12 }}>
        recent entries · curator last ran 6m ago
      </div>
      {entries.map((e, i) => (
        <Row key={i} last={i === entries.length - 1}>
          <span style={{ ...mono, fontSize: 10, color: T.textFaint, width: 64 }}>{e.t}</span>
          <span style={{ ...geist, fontSize: 13, color: T.text, flex: 1 }}>{e.desc}</span>
          <span style={{ ...mono, fontSize: 10, color: T.textMuted }}>{e.tag}</span>
        </Row>
      ))}
    </div>
  );
}

// ── 07 Outcome Eval ───────────────────────────────────────────
function EvalCollapsed() {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 22 }}>
      <span style={{ ...mono, fontSize: 36, color: T.text }}>78.4%</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ ...geist, fontSize: 14, color: T.text }}>accuracy · 7d</span>
        <span style={{ ...mono, fontSize: 11, color: T.textMuted }}>47 hit · 13 miss</span>
      </div>
    </div>
  );
}
function EvalExpanded() {
  const rows = [
    { id: "#1283", pred: "+8.4%", act: "+8.1%", d: "−0.3", st: "hit" },
    { id: "#1282", pred: "hold", act: "hold", d: "0", st: "hit" },
    { id: "#1281", pred: "+6.2%", act: "+5.8%", d: "−0.4", st: "hit" },
    { id: "#1280", pred: "+11.0%", act: "+3.2%", d: "−7.8", st: "miss" },
    { id: "#1279", pred: "rotate", act: "rotate", d: "0", st: "hit" },
    { id: "#1278", pred: "+7.4%", act: "+7.1%", d: "−0.3", st: "hit" },
    { id: "#1277", pred: "hold", act: "rotate", d: "—", st: "miss" },
  ];
  return (
    <div>
      <InspiredBy src="autoresearch · results.tsv + FinRL · backtesting" />
      <Narrative>
        Komponen <b style={{ color: T.text }}>terpisah</b> yang jalan async — bukan di main loop.
        Evaluate keputusan yang udah dibuat 7 hari lalu: bener-bener profitable setelah gas dan
        IL? Hasilnya jadi ground truth buat Reflector. DeFi evaluate delayed (butuh 7 hari) —
        makanya ini cron job terpisah.
      </Narrative>
      <div style={{ ...mono, fontSize: 11, color: T.textFaint, marginBottom: 12 }}>
        last 7 decisions
      </div>
      <div
        style={{
          ...mono,
          fontSize: 10,
          color: T.textFaint,
          display: "grid",
          gridTemplateColumns: "80px 1fr 1fr 80px 80px",
          padding: "8px 0",
          borderBottom: `1px solid ${T.border}`,
        }}
      >
        <span>id</span>
        <span>prediction</span>
        <span>actual</span>
        <span>delta</span>
        <span>status</span>
      </div>
      {rows.map((r, i) => (
        <div
          key={r.id}
          style={{
            ...mono,
            fontSize: 12,
            display: "grid",
            gridTemplateColumns: "80px 1fr 1fr 80px 80px",
            padding: "10px 0",
            borderBottom: i === rows.length - 1 ? "none" : `1px solid ${T.border}`,
            color: T.text,
          }}
        >
          <span style={{ color: T.textMuted }}>{r.id}</span>
          <span>{r.pred}</span>
          <span>{r.act}</span>
          <span style={{ color: T.textMuted }}>{r.d}</span>
          <span style={{ color: r.st === "hit" ? T.ok : T.danger }}>{r.st}</span>
        </div>
      ))}
    </div>
  );
}

// ── 08 Reflector ──────────────────────────────────────────────
function ReflectorCollapsed() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ ...geist, fontSize: 14, color: T.text }}>
        overshot bull projection by 7.8% on #1280
      </span>
      <span style={{ ...mono, fontSize: 11, color: T.textMuted }}>
        self-patch · staged · awaiting curator
      </span>
    </div>
  );
}
function ReflectorExpanded() {
  return (
    <div>
      <InspiredBy src="ACE Stanford · Reflector Agent · tag helpful/harmful" />
      <Narrative>
        Jalan async setelah Outcome Tracker selesai evaluasi. Profitable → semua cited rules dapet{" "}
        <span style={mono}>helpful++</span>. Loss → <span style={mono}>harmful++</span>. Plus
        Reflector coba extract rule baru dari kegagalan — apa yang harusnya diketahui agent
        sebelum keputusan itu dibuat?
      </Narrative>
      <div style={{ ...mono, fontSize: 11, color: T.textFaint, marginBottom: 12 }}>
        post-mortem · cycle #1280
      </div>
      <p
        style={{
          ...geist,
          fontSize: 14,
          color: T.text,
          lineHeight: 1.6,
          maxWidth: 580,
          margin: 0,
        }}
      >
        Bull scenario weight was 0.42 when realised gas profile matched bear. Yield Optimizer
        anchored on stale 1h apy. Gas Strategist's signal was suppressed by quorum tiebreak rule.
      </p>
      <div
        style={{
          marginTop: 18,
          ...mono,
          fontSize: 12,
          display: "grid",
          gridTemplateColumns: "180px 1fr",
          rowGap: 8,
        }}
      >
        <span style={{ color: T.textFaint }}>what.changed</span>
        <span style={{ color: T.text }}>quorum tiebreak now favours gas signal under load</span>
        <span style={{ color: T.textFaint }}>lesson.promoted</span>
        <span style={{ color: T.text }}>
          "apy stale &gt; 15m must downweight scenario by 0.2"
        </span>
        <span style={{ color: T.textFaint }}>patch.status</span>
        <span style={{ color: T.warn }}>staged · awaiting curator</span>
      </div>
    </div>
  );
}

function fmtTime(d: Date) {
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

function buildCouncilEvent(
  id: SectionId | undefined,
  cycleNum: number,
  base: Date,
): CouncilEvent | null {
  const t = fmtTime(new Date(base.getTime() + Math.floor(Math.random() * 5_000)));
  switch (id) {
    case "state":
      return { marker: "·", color: T.textMuted, ev: "StateObserved", src: "loop", meta: "42 dims · action space=5", t };
    case "loop":
      return { marker: "↻", color: T.info, ev: "LoopTick", src: "loop", meta: "world stable · 1 anomaly flagged to sim", t };
    case "fetch":
      return { marker: "·", color: T.textMuted, ev: "StreamsIngested", src: "loop", meta: "8/8 sources · venice 412ms", t };
    case "gates":
      return { marker: "!", color: T.warn, ev: "TurbulenceNoted", src: "loop", meta: "0.71 · soft-fail · sim asked to widen bear", t };
    case "sim":
      return { marker: "≈", color: T.info, ev: "TimelinesDrafted", src: "sim", meta: "A stress · B favorable · C neutral · feedback to loop", t };
    case "council":
      return { marker: "●", color: T.warn, ev: "DeliberationOpened", src: "council", meta: "3 agents · cited 7 playbook rules", t };
    case "verdict":
      return { marker: "✓", color: T.accent, ev: "CouncilDecided", src: "council", meta: "rotate 40 usdc → aave-v3 · quorum 3/3 · conf 0.82", t, decided: true };
    case "memory":
      return { marker: "·", color: T.textMuted, ev: "CitedRulesStored", src: "memory", meta: "defi-014 · defi-027 · defi-031", t };
    case "execution":
      return { marker: "↓", color: T.info, ev: "CouncilGreenlit", src: "council", meta: "1shot route confirmed · session key valid", t };
    case "eval":
      return { marker: "·", color: T.textMuted, ev: "OutcomeScored", src: "memory", meta: `#${cycleNum - 4} hit · #${cycleNum - 5} missed by 7.8%`, t };
    case "reflector":
      return { marker: "✦", color: T.ok, ev: "CouncilLearned", src: "council", meta: "downweight stale apy by 0.2 · promoted to playbook", t };
    case "curator":
      return { marker: "+", color: T.accent, ev: "RulesPromoted", src: "memory", meta: "2 added · 1 deduped · helpful 4→5", t };
    case "bullet":
      return { marker: "↔", color: T.info, ev: "RulesMerged", src: "memory", meta: "defi-014 ↔ defi-027 · jaccard 0.74 · counters summed", t };
    default:
      return null;
  }
}

// ── Council activity types ────────────────────────────────────
type CouncilEvent = {
  marker: string;
  color: string;
  ev: string;
  src?: "loop" | "sim" | "council" | "memory";
  meta: string;
  t: string;
  decided?: boolean;
};

// ── Right rail ────────────────────────────────────────────────
function RightRail({
  cycleNum,
  iq,
  councilFeed,
  currentStageId,
  numWorkers,
}: {
  cycleNum: number;
  iq: number;
  councilFeed: CouncilEvent[];
  currentStageId: SectionId | null;
  numWorkers: number;
}) {
  const PAGE_SIZE = 5;
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(councilFeed.length / PAGE_SIZE));
  // Snap to first page when new events arrive
  useEffect(() => {
    setPage(0);
  }, [councilFeed.length === 0]);
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * PAGE_SIZE;
  const pageItems = councilFeed.slice(start, start + PAGE_SIZE);

  const WORKER_POOL = [
    { vault: "0xABCD…aBcDe", amt: "40 USDC" },
    { vault: "0xDEF1…Ef12", amt: "35 USDC" },
    { vault: "0x9876…1234", amt: "25 USDC" },
    { vault: "0x2A4F…7c1B", amt: "30 USDC" },
    { vault: "0x55E0…904F", amt: "22 USDC" },
    { vault: "0x71BA…0CD3", amt: "18 USDC" },
    { vault: "0x6F2C…ab90", amt: "28 USDC" },
    { vault: "0xC11D…5e22", amt: "15 USDC" },
  ];
  const wCount = Math.max(MIN_WORKERS, Math.min(MAX_WORKERS, numWorkers));
  const perms = WORKER_POOL.slice(0, wCount).map((w, i) => ({
    id: String(i + 1).padStart(2, "0"),
    name: `worker-${i + 1}`,
    ...w,
  }));
  const deliberating =
    currentStageId === "council" || currentStageId === "verdict" || currentStageId === "sim";
  const trigger =
    currentStageId === "loop"
      ? "loop · monitoring world state"
      : currentStageId === "sim"
      ? "sim · branching timelines · feeds council"
      : currentStageId === "council"
      ? "council · 3 agents deliberating"
      : currentStageId === "verdict"
      ? "council · forming consensus"
      : currentStageId === "reflector"
      ? "council · introspecting last miss"
      : currentStageId === "curator"
      ? "council · promoting lessons"
      : "council · idle";
  return (
    <aside
      style={{
        width: 360,
        flexShrink: 0,
        background: T.bgCanvas,
        borderLeft: `1px solid ${T.border}`,
        overflowY: "auto",
      }}
    >
      <div style={{ padding: 20, borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ ...geist, fontSize: 13, color: T.text }}>Wallet</span>
          <span style={{ ...mono, fontSize: 10.5, color: T.textFaint }}>sepolia</span>
        </div>
        <div style={{ ...mono, fontSize: 12, color: T.textMuted, marginTop: 10 }}>0xA36f3c…26a4</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 14 }}>
          <span style={{ ...mono, fontSize: 10, color: T.textFaint }}>balance</span>
          <span style={{ ...mono, fontSize: 18, color: T.text }}>
            1 248.42 <span style={{ fontSize: 11, color: T.textFaint }}>USDC</span>
          </span>
        </div>
      </div>

      <div style={{ padding: 20, borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ ...geist, fontSize: 13, color: T.text }}>Active permissions</span>
          <span style={{ ...mono, fontSize: 10.5, color: T.textFaint }}>erc-7715 · batch</span>
        </div>
        <div style={{ ...mono, fontSize: 11, color: T.textMuted, marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: T.accent }} />
          3 permission · 23h 59m
        </div>
        <div style={{ marginTop: 14 }}>
          {perms.map((p) => (
            <div
              key={p.id}
              style={{
                display: "grid",
                gridTemplateColumns: "24px 1fr auto",
                gap: 10,
                padding: "12px 0",
                borderTop: `1px solid ${T.border}`,
                alignItems: "baseline",
              }}
            >
              <span style={{ ...mono, fontSize: 11, color: T.accent }}>{p.id}</span>
              <div>
                <div style={{ ...geist, fontSize: 13, color: T.text }}>{p.name}</div>
                <div style={{ ...mono, fontSize: 10.5, color: T.textFaint, marginTop: 3 }}>{p.vault}</div>
              </div>
              <span style={{ ...mono, fontSize: 12, color: T.text }}>{p.amt}</span>
            </div>
          ))}
        </div>
        <button
          style={{
            ...geist,
            fontSize: 13,
            color: T.textMuted,
            background: "transparent",
            border: `1px solid ${T.border}`,
            borderRadius: 8,
            padding: "9px 14px",
            marginTop: 14,
            cursor: "pointer",
            width: "100%",
          }}
        >
          revoke all permissions
        </button>
      </div>

      {/* Council intelligence */}
      <div style={{ padding: 20, borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ ...geist, fontSize: 13, color: T.text }}>Council intelligence</span>
          <span style={{ ...mono, fontSize: 10.5, color: T.textFaint }}>iq · evolving</span>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 12 }}>
          <span style={{ ...mono, fontSize: 28, color: T.text }}>{iq.toLocaleString()}</span>
          <span style={{ ...mono, fontSize: 11, color: T.ok }}>+{12 + (cycleNum % 5)} cycle</span>
        </div>
        <div
          style={{
            ...mono,
            fontSize: 10.5,
            color: T.textFaint,
            marginTop: 10,
            lineHeight: 1.5,
          }}
        >
          learns from loop ↔ sim introspection · grows when reflector promotes a lesson.
        </div>
      </div>

      {/* Council activity */}
      <div style={{ padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ ...geist, fontSize: 13, color: T.text }}>Activity of council</span>
          <span style={{ ...mono, fontSize: 10.5, color: T.textFaint }}>
            {deliberating ? "deliberating" : "watching"}
          </span>
        </div>
        <div
          style={{
            ...mono,
            fontSize: 11,
            color: T.textMuted,
            marginTop: 10,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: deliberating ? T.accent : T.textFaint,
              animation: deliberating ? "vf-blink 1.1s ease-in-out infinite" : "none",
            }}
          />
          {trigger}
        </div>
        <div style={{ marginTop: 14 }}>
          {councilFeed.length === 0 && (
            <div
              style={{
                ...mono,
                fontSize: 11,
                color: T.textFaint,
                padding: "20px 0",
                textAlign: "center",
              }}
            >
              council activity will appear here once loop begins
            </div>
          )}
          {pageItems.map((f, i) => (
            <div
              key={start + i}
              style={{
                padding: "10px 0",
                borderTop: i === 0 ? "none" : `1px solid ${T.border}`,
                display: "grid",
                gridTemplateColumns: "16px 1fr auto",
                gap: 10,
                alignItems: "baseline",
                animation: safePage === 0 && i === 0 ? "vf-reveal 320ms ease-out both" : "none",
              }}
            >
              <span style={{ ...mono, fontSize: 12, color: f.color }}>{f.marker}</span>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span
                    style={{
                      ...mono,
                      fontSize: 12,
                      color: f.decided ? T.accent : T.text,
                    }}
                  >
                    {f.ev}
                  </span>
                  {f.src && (
                    <span
                      style={{
                        ...mono,
                        fontSize: 10,
                        color: T.textMuted,
                        border: `1px solid ${T.border}`,
                        borderRadius: 3,
                        padding: "1px 5px",
                      }}
                    >
                      {f.src}
                    </span>
                  )}
                </div>
                <div style={{ ...mono, fontSize: 10.5, color: T.textFaint, marginTop: 3, lineHeight: 1.5 }}>
                  {f.meta}
                </div>
              </div>
              <span style={{ ...mono, fontSize: 10, color: T.textFaint }}>{f.t}</span>
            </div>
          ))}
        </div>
        {councilFeed.length > PAGE_SIZE && (
          <div
            style={{
              marginTop: 14,
              paddingTop: 12,
              borderTop: `1px solid ${T.border}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              ...mono,
              fontSize: 11,
              color: T.textFaint,
            }}
          >
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              style={{
                ...mono,
                fontSize: 11,
                color: safePage === 0 ? T.textFaint : T.text,
                background: "transparent",
                border: `1px solid ${T.border}`,
                borderRadius: 4,
                padding: "4px 10px",
                cursor: safePage === 0 ? "not-allowed" : "pointer",
                opacity: safePage === 0 ? 0.45 : 1,
              }}
            >
              ← prev
            </button>
            <span>
              {start + 1}–{Math.min(start + PAGE_SIZE, councilFeed.length)} of {councilFeed.length}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
              style={{
                ...mono,
                fontSize: 11,
                color: safePage >= totalPages - 1 ? T.textFaint : T.text,
                background: "transparent",
                border: `1px solid ${T.border}`,
                borderRadius: 4,
                padding: "4px 10px",
                cursor: safePage >= totalPages - 1 ? "not-allowed" : "pointer",
                opacity: safePage >= totalPages - 1 ? 0.45 : 1,
              }}
            >
              next →
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

// ── Sidebar ───────────────────────────────────────────────────
function Sidebar() {
  const Ic = (d: string) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
  const items = [
    { label: "home", path: "M3 12 12 4l9 8M5 10v10h14V10" },
    { label: "grid", path: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z", active: true },
    { label: "layers", path: "M12 3 3 8l9 5 9-5zM3 13l9 5 9-5M3 18l9 5 9-5" },
    { label: "settings", path: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-.9c.6.5 1.3.9 2 1.2L10 21h4l.6-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" },
  ];
  return (
    <nav
      style={{
        width: 58,
        flexShrink: 0,
        background: T.bgCanvas,
        borderRight: `1px solid ${T.border}`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "14px 0",
        gap: 6,
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 4,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          ...mono,
          fontSize: 14,
          color: T.text,
          marginBottom: 18,
        }}
      >
        v/
      </div>
      {items.map((it) => (
        <button
          key={it.label}
          aria-label={it.label}
          style={{
            all: "unset",
            cursor: "pointer",
            width: 36,
            height: 36,
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: it.active ? T.bgElev : "transparent",
            color: it.active ? T.text : T.textMuted,
          }}
        >
          {Ic(it.path)}
        </button>
      ))}
    </nav>
  );
}

function StepRail() {
  const steps = [
    { n: "01", l: "AI Strategy", st: "done" },
    { n: "02", l: "Connect & Upgrade", st: "done" },
    { n: "03", l: "Review Skills", st: "done" },
    { n: "04", l: "Grant", st: "done" },
    { n: "05", l: "Auto-Execute", st: "active" },
    { n: "06", l: "Complete", st: "idle" },
  ];
  return (
    <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, padding: "0 22px" }}>
      {steps.map((s) => {
        const isActive = s.st === "active";
        const isDone = s.st === "done";
        const numColor = isActive ? T.accent : isDone ? T.textMuted : T.textFaint;
        const textColor = isActive ? T.text : isDone ? T.textMuted : T.textFaint;
        return (
          <div
            key={s.n}
            style={{
              padding: "14px 18px",
              borderBottom: isActive ? `1px solid ${T.accent}` : "1px solid transparent",
              marginBottom: -1,
              display: "flex",
              alignItems: "center",
              gap: 8,
              ...mono,
              fontSize: 11,
            }}
          >
            <span style={{ color: numColor }}>{s.n}</span>
            <span style={{ ...geist, fontSize: 12, color: textColor }}>{s.l}</span>
          </div>
        );
      })}
    </div>
  );
}

function Topbar() {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "16px 28px",
        borderBottom: `1px solid ${T.border}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
        <span style={{ ...geist, fontSize: 19, fontWeight: 500, color: T.text }}>vibing</span>
        <span style={{ color: T.textFaint, fontSize: 19 }}>/</span>
        <span style={{ fontFamily: '"Instrument Serif", "Times New Roman", serif', fontStyle: "italic", fontSize: 19, color: T.text }}>
          farmer
        </span>
      </div>
      <div style={{ ...mono, fontSize: 11, color: T.textMuted, display: "flex", gap: 18 }}>
        <span>agent · brain</span>
        <span style={{ color: T.textFaint }}>cycle #1284</span>
      </div>
    </header>
  );
}

function StatusBar({ msg }: { msg: string }) {
  return (
    <div
      style={{
        ...mono,
        fontSize: 12,
        color: T.textMuted,
        borderTop: `1px solid ${T.border}`,
        background: T.bgCanvas,
        padding: "10px 28px",
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 999, background: T.accent, flexShrink: 0 }} />
      <span>{msg}</span>
    </div>
  );
}

// ── Run control ───────────────────────────────────────────────
function RunControl({
  cycleState,
  activeIdx,
  total,
  cycleNum,
  onStart,
  onStop,
}: {
  cycleState: CycleState;
  activeIdx: number;
  total: number;
  cycleNum: number;
  onStart: () => void;
  onStop: () => void;
}) {
  const progress = cycleState === "running" ? Math.round(((activeIdx + 1) / total) * 100) : 0;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "22px 28px",
        borderBottom: `1px solid ${T.border}`,
        background: T.bgCanvas,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ ...mono, fontSize: 11, color: T.textFaint, textTransform: "lowercase" }}>
          run · cycle #{cycleNum}
        </span>
        <span style={{ ...geist, fontSize: 14, color: T.text }}>
          {cycleState === "idle"
            ? "Pipeline idle · 8 stages queued · autonomous when started"
            : `Stage ${String(activeIdx + 1).padStart(2, "0")} of ${String(total).padStart(2, "0")} running · autonomous loop`}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <div
          style={{
            width: 160,
            height: 4,
            background: T.bgElev,
            borderRadius: 2,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${progress}%`,
              height: "100%",
              background: T.accent,
              transition: "width 300ms ease-out",
            }}
          />
        </div>
        <span style={{ ...mono, fontSize: 12, color: T.textMuted, width: 44, textAlign: "right" }}>
          {progress}%
        </span>
        {cycleState === "idle" && (
          <button
            onClick={onStart}
            style={{
              ...geist,
              fontSize: 14,
              fontWeight: 500,
              padding: "11px 22px",
              background: T.accent,
              color: T.accentFg,
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            Start cycle
          </button>
        )}
        {cycleState === "running" && (
          <button
            onClick={onStop}
            style={{
              ...geist,
              fontSize: 14,
              fontWeight: 500,
              padding: "11px 22px",
              background: "transparent",
              color: T.text,
              border: `1px solid ${T.borderStrong}`,
              borderRadius: 8,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: T.danger,
                animation: "vf-blink 1.1s ease-in-out infinite",
              }}
            />
            Stop
          </button>
        )}
      </div>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────
const STATUS_MSGS = [
  "Pipeline idle · press Start to begin cycle #1284",
  "Worker 2 is waiting for swap confirmation on Aave v3 · tx 0x9f3…a124",
  "Council reaching quorum on cycle #1284 · 2/3 stances locked",
  "Venice AI returning Base scenario · 412ms",
  "Worker 1 deposit confirmed · 40 USDC → MockVault",
];

export function AgentBrain() {
  const [open, setOpen] = useState<SectionId | null>(null);
  const [cycleState, setCycleState] = useState<CycleState>("idle");
  const [activeIdx, setActiveIdx] = useState(0);
  const [completed, setCompleted] = useState<Set<number>>(new Set());
  const [statusIdx, setStatusIdx] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cycleNum, setCycleNum] = useState(1284);
  const [revealedCount, setRevealedCount] = useState(0);
  const [councilFeed, setCouncilFeed] = useState<CouncilEvent[]>([]);
  const [iq, setIq] = useState(1247);
  const [decisionToast, setDecisionToast] = useState<string | null>(null);
  const [numBranches, setNumBranches] = useState(3);
  const [numWorkers, setNumWorkers] = useState(3);
  // Draft values shown in modal — committed to live state on Authorize.
  const [draftBranches, setDraftBranches] = useState(3);
  const [draftWorkers, setDraftWorkers] = useState(3);

  const stages: { id: SectionId; num: string; label: string }[] = [
    { id: "state", num: "01", label: "state · action · reward" },
    { id: "loop", num: "02", label: "autonomous monitor loop" },
    { id: "fetch", num: "03", label: "parallel data fetch" },
    { id: "gates", num: "04", label: "fast-fail gates" },
    { id: "sim", num: "05", label: "simulation engine" },
    { id: "council", num: "06", label: "ai council" },
    { id: "verdict", num: "07", label: "consensus gate" },
    { id: "memory", num: "08", label: "playbook storage" },
    { id: "execution", num: "09", label: "execution layer" },
    { id: "eval", num: "10", label: "outcome tracker" },
    { id: "reflector", num: "11", label: "reflector" },
    { id: "curator", num: "12", label: "curator" },
    { id: "bullet", num: "13", label: "bulletpoint analyzer" },
  ];

  // drive the cycle
  useEffect(() => {
    if (cycleState !== "running") return;
    const id = stages[activeIdx]?.id;
    const dur =
      id === "sim"
        ? 6800
        : id === "council"
        ? 5800
        : id === "verdict"
        ? 4600
        : id === "execution"
        ? 5200
        : id === "state"
        ? 3200
        : 4000;

    const now = new Date();
    const t = setTimeout(() => {
      // emit a council event for this stage completion
      const ev = buildCouncilEvent(id, cycleNum, now);
      if (ev) setCouncilFeed((f) => [ev, ...f].slice(0, 40));

      // IQ grows on reflector + bullet + curator stages
      if (id === "reflector") setIq((q) => q + 7);
      if (id === "curator") setIq((q) => q + 3);
      if (id === "bullet") setIq((q) => q + 2);

      // Council "has decided" effect — pauses pipeline briefly
      if (id === "verdict") {
        setDecisionToast(
          "Council has decided · rotate 40 USDC → aave-v3 · quorum 3/3 · confidence 0.82",
        );
        setTimeout(() => setDecisionToast(null), 2200);
      }

      setCompleted((c) => new Set(c).add(activeIdx));
      if (activeIdx + 1 >= stages.length) {
        setTimeout(() => {
          setCompleted(new Set());
          setActiveIdx(0);
          setCycleNum((n) => n + 1);
          setOpen(stages[0].id);
        }, 2400);
      } else {
        const extra = id === "verdict" ? 2400 : 0;
        setTimeout(() => {
          setActiveIdx((i) => i + 1);
          setRevealedCount((r) => Math.max(r, activeIdx + 2));
          setOpen(stages[activeIdx + 1].id);
        }, extra);
      }
    }, dur);
    return () => clearTimeout(t);
  }, [cycleState, activeIdx]);

  useEffect(() => {
    const id = setInterval(
      () => setStatusIdx((i) => (i + 1) % STATUS_MSGS.length),
      3200
    );
    return () => clearInterval(id);
  }, []);

  const stageStateFor = (i: number): StageState => {
    if (cycleState === "idle") return "idle";
    if (completed.has(i)) return "done";
    if (cycleState === "running" && i === activeIdx) return "running";
    return "idle";
  };

  const handleStartRequest = () => {
    setDraftBranches(numBranches);
    setDraftWorkers(numWorkers);
    setConfirmOpen(true);
  };
  const handleConfirm = () => {
    setConfirmOpen(false);
    setNumBranches(draftBranches);
    setNumWorkers(draftWorkers);
    setCompleted(new Set());
    setActiveIdx(0);
    setRevealedCount(1);
    setCycleState("running");
    setOpen(stages[0].id);
  };
  const handleStop = () => {
    setCycleState("idle");
    setActiveIdx(0);
    setCompleted(new Set());
    setRevealedCount(0);
    setOpen(null);
    setDecisionToast(null);
  };

  const meta = (id: SectionId, st: StageState): string => {
    const live = st === "running" ? "── running" : st === "done" ? "── done" : "── queued";
    const map: Record<SectionId, string> = {
      state: st === "running" ? "── formalizing" : live,
      loop: st === "running" ? "── live" : live,
      fetch: st === "running" ? "── 8 streams" : live,
      gates: st === "running" ? "── checking" : live,
      sim: st === "running" ? "── branching timelines" : st === "done" ? `── ×${numBranches} timelines` : live,
      council: st === "running" ? "── deliberating" : live,
      verdict: st === "running" ? "── consensus" : live,
      memory: st === "running" ? "── writing" : live,
      execution: st === "running" ? "── broadcasting" : live,
      eval: st === "running" ? "── scoring" : live,
      reflector: st === "running" ? "── post-mortem" : live,
      curator: st === "running" ? "── adding rules" : live,
      bullet: st === "running" ? "── merging" : live,
    };
    return map[id];
  };

  return (
    <div
      style={{
        height: "100vh",
        width: "100%",
        background: T.bgBase,
        color: T.text,
        ...geist,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <style>{`
        @keyframes vf-blink { 0%, 100% { opacity: 1 } 50% { opacity: 0.3 } }
        @keyframes vf-skeleton { 0%, 100% { opacity: 0.4 } 50% { opacity: 0.9 } }
        @keyframes vf-fadein { from { opacity: 0 } to { opacity: 1 } }
        @keyframes vf-slideup { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: translateY(0) } }
        @keyframes vf-reveal { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: translateY(0) } }
        @keyframes vf-draw { to { stroke-dashoffset: 0 } }
        @keyframes vf-pop { 0% { transform: scale(0); opacity: 0 } 60% { transform: scale(1.4); opacity: 1 } 100% { transform: scale(1); opacity: 1 } }
        @keyframes vf-pulse-ring { 0% { stroke-width: 1; opacity: 0.8 } 100% { stroke-width: 10; opacity: 0 } }
        @keyframes vf-trunk-pulse { 0%, 100% { r: 5; opacity: 1 } 50% { r: 7; opacity: 0.6 } }
        .vf-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
        .vf-scroll::-webkit-scrollbar-thumb { background: ${T.borderStrong}; border-radius: 4px; }
        .vf-scroll::-webkit-scrollbar-track { background: transparent; }
      `}</style>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <Sidebar />
        <main style={{ flex: 1, minWidth: 0, background: T.bgCanvas, display: "flex", flexDirection: "column" }}>
          <Topbar />
          <RunControl
            cycleState={cycleState}
            activeIdx={activeIdx}
            total={stages.length}
            cycleNum={cycleNum}
            onStart={handleStartRequest}
            onStop={handleStop}
          />
          <div
            className="vf-scroll"
            style={{ flex: 1, overflowY: "auto", padding: "12px 28px 32px" }}
          >
            <div style={{ maxWidth: 880 }}>
              {cycleState === "idle" && (
                <div
                  style={{
                    padding: "48px 24px",
                    border: `1px dashed ${T.borderStrong}`,
                    borderRadius: 14,
                    textAlign: "center",
                    color: T.textMuted,
                    ...geist,
                    fontSize: 14,
                    lineHeight: 1.6,
                  }}
                >
                  <div style={{ ...mono, fontSize: 11, color: T.textFaint, marginBottom: 10 }}>
                    13 stages · queued
                  </div>
                  Klik <span style={{ color: T.accent }}>Start cycle</span> di atas untuk konfirmasi
                  autonomous run. Stage akan muncul satu per satu seiring loop jalan.
                </div>
              )}
              {cycleState === "running" &&
                stages.slice(activeIdx, activeIdx + 1).map((s) => {
                  const i = activeIdx;
                  const st: StageState = "running";
                  const isSimThinking = s.id === "sim";
                  const collMap: Record<SectionId, React.ReactNode> = {
                    state: <StateCollapsed />,
                    loop: <LoopCollapsed stage={st} />,
                    fetch: <FetchCollapsed />,
                    gates: <GatesCollapsed />,
                    sim: <SimCollapsed thinking={isSimThinking} n={numBranches} />,
                    council: <CouncilCollapsed />,
                    verdict: <VerdictCollapsed />,
                    memory: <MemoryCollapsed />,
                    execution: <ExecutionCollapsed />,
                    eval: <EvalCollapsed />,
                    reflector: <ReflectorCollapsed />,
                    curator: <CuratorCollapsed />,
                    bullet: <BulletCollapsed />,
                  };
                  const expMap: Record<SectionId, React.ReactNode> = {
                    state: <StateExpanded />,
                    loop: <LoopExpanded />,
                    fetch: <FetchExpanded />,
                    gates: <GatesExpanded />,
                    sim: <SimExpanded thinking={isSimThinking} n={numBranches} />,
                    council: <CouncilExpanded />,
                    verdict: <VerdictExpanded />,
                    memory: <MemoryExpanded />,
                    execution: <ExecutionExpanded />,
                    eval: <EvalExpanded />,
                    reflector: <ReflectorExpanded />,
                    curator: <CuratorExpanded />,
                    bullet: <BulletExpanded />,
                  };
                  return (
                    <div
                      key={`${cycleNum}-${s.id}`}
                      style={{ animation: "vf-reveal 360ms ease-out both" }}
                    >
                      <Stage
                        id={s.id}
                        num={s.num}
                        label={s.label}
                        meta={meta(s.id, st)}
                        collapsed={collMap[s.id]}
                        expanded={expMap[s.id]}
                        open={true}
                        onToggle={() => {}}
                        state={st}
                        first={true}
                        last={true}
                      />
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          marginTop: 18,
                          padding: "0 4px",
                          ...mono,
                          fontSize: 11,
                          color: T.textFaint,
                        }}
                      >
                        <span>
                          stage {String(i + 1).padStart(2, "0")} / {String(stages.length).padStart(2, "0")}
                          {i > 0 && (
                            <>
                              {" · prev "}
                              <span style={{ color: T.textMuted }}>{stages[i - 1].label}</span>
                            </>
                          )}
                        </span>
                        <span>
                          {i + 1 < stages.length ? (
                            <>
                              next{" "}
                              <span style={{ color: T.textMuted }}>{stages[i + 1].label}</span>
                              {" →"}
                            </>
                          ) : (
                            <span style={{ color: T.accent }}>cycle complete · loop restart</span>
                          )}
                        </span>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </main>
        <RightRail
          cycleNum={cycleNum}
          iq={iq}
          councilFeed={councilFeed}
          currentStageId={cycleState === "running" ? stages[activeIdx]?.id ?? null : null}
          numWorkers={numWorkers}
        />
      </div>
      <StatusBar msg={STATUS_MSGS[statusIdx]} />
      {decisionToast && (
        <div
          style={{
            position: "fixed",
            left: "50%",
            bottom: 60,
            transform: "translateX(-50%)",
            background: T.bgCard,
            border: `1px solid ${T.accent}`,
            borderRadius: 14,
            padding: "16px 22px",
            display: "flex",
            alignItems: "center",
            gap: 14,
            maxWidth: 620,
            zIndex: 40,
            animation: "vf-slideup 220ms ease-out",
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              background: T.accent,
              animation: "vf-blink 1.1s ease-in-out infinite",
              flexShrink: 0,
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ ...mono, fontSize: 10, color: T.accent, textTransform: "lowercase" }}>
              council · verdict
            </span>
            <span style={{ ...geist, fontSize: 14, color: T.text, lineHeight: 1.4 }}>
              {decisionToast}
            </span>
          </div>
        </div>
      )}
      {confirmOpen && (
        <ConfirmModal
          cycleNum={cycleNum}
          branches={draftBranches}
          workers={draftWorkers}
          setBranches={setDraftBranches}
          setWorkers={setDraftWorkers}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={handleConfirm}
        />
      )}
    </div>
  );
}

function Stepper({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  const dec = () => onChange(Math.max(min, value - 1));
  const inc = () => onChange(Math.min(max, value + 1));
  const btn = (disabled: boolean): React.CSSProperties => ({
    ...mono,
    fontSize: 14,
    width: 28,
    height: 28,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    color: disabled ? T.textFaint : T.text,
    border: `1px solid ${T.border}`,
    borderRadius: 6,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.45 : 1,
  });
  return (
    <div
      style={{
        border: `1px solid ${T.border}`,
        borderRadius: 8,
        padding: 12,
        background: T.bgElev,
      }}
    >
      <div style={{ ...mono, fontSize: 11, color: T.textFaint, marginBottom: 6 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <button onClick={dec} disabled={value <= min} style={btn(value <= min)} aria-label="decrement">
          −
        </button>
        <span
          style={{
            ...mono,
            fontSize: 18,
            color: T.text,
            minWidth: 28,
            textAlign: "center",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {value}
        </span>
        <button onClick={inc} disabled={value >= max} style={btn(value >= max)} aria-label="increment">
          +
        </button>
      </div>
      <div style={{ ...mono, fontSize: 10.5, color: T.textFaint, lineHeight: 1.4 }}>{hint}</div>
    </div>
  );
}

function ConfirmModal({
  cycleNum,
  branches,
  workers,
  setBranches,
  setWorkers,
  onCancel,
  onConfirm,
}: {
  cycleNum: number;
  branches: number;
  workers: number;
  setBranches: (n: number) => void;
  setWorkers: (n: number) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const scope = [
    { k: "loop.mode", v: "autonomous · continuous", note: "runs until you click stop" },
    {
      k: "simulation",
      v: `venice.ai · ×${branches} parallel`,
      note: branches === 1 ? "single deterministic timeline" : `${branches} alternate timelines per cycle`,
    },
    { k: "council", v: "3 agents · quorum 2/3", note: "risk · yield · gas deliberation" },
    {
      k: "workers",
      v: `${workers} scoped account${workers === 1 ? "" : "s"}`,
      note: "erc-4337 smart accounts · per-worker cap",
    },
    { k: "memory.writes", v: "auto-promote", note: "rules + patterns curated post-cycle" },
    { k: "stop.control", v: "user · anytime", note: "halts after current stage settles" },
  ];
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        animation: "vf-fadein 140ms ease-out",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: "calc(100% - 48px)",
          background: T.bgCard,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 18,
          padding: 28,
          animation: "vf-slideup 180ms ease-out",
        }}
      >
        <div
          style={{
            ...mono,
            fontSize: 11,
            color: T.textMuted,
            textTransform: "lowercase",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span style={{ color: T.accent }}>00</span>
          <span>·</span>
          <span style={{ color: T.text }}>confirm autonomous run</span>
          <span style={{ flex: 1, height: 1, background: T.border, marginInline: 4 }} />
          <span>cycle #{cycleNum}</span>
        </div>

        <h2
          style={{
            ...geist,
            fontSize: 22,
            fontWeight: 500,
            color: T.text,
            margin: "16px 0 8px",
            letterSpacing: "-0.02em",
          }}
        >
          Mulai loop autonomous?
        </h2>
        <p
          style={{
            ...geist,
            fontSize: 14,
            color: T.textMuted,
            lineHeight: 1.55,
            margin: 0,
            maxWidth: 460,
          }}
        >
          Agent bakal jalanin simulation, council deliberation, dan eksekusi verdict secara
          continuous. Loop gak berhenti sampe kamu klik stop.
        </p>

        {/* Run sizing */}
        <div
          style={{
            marginTop: 22,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
          }}
        >
          <Stepper
            label="alternate timelines"
            hint={`branches simulated per cycle · ${MIN_BRANCHES}–${MAX_BRANCHES}`}
            value={branches}
            min={MIN_BRANCHES}
            max={MAX_BRANCHES}
            onChange={setBranches}
          />
          <Stepper
            label="scoped workers"
            hint={`smart accounts authorized · ${MIN_WORKERS}–${MAX_WORKERS}`}
            value={workers}
            min={MIN_WORKERS}
            max={MAX_WORKERS}
            onChange={setWorkers}
          />
        </div>

        <div
          style={{
            marginTop: 14,
            border: `1px solid ${T.border}`,
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {scope.map((r, i) => (
            <div
              key={r.k}
              style={{
                display: "grid",
                gridTemplateColumns: "150px 1fr",
                gap: 12,
                padding: "12px 14px",
                borderBottom: i === scope.length - 1 ? "none" : `1px solid ${T.border}`,
                background: i % 2 === 0 ? "transparent" : T.bgElev,
              }}
            >
              <span style={{ ...mono, fontSize: 11, color: T.textFaint }}>{r.k}</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ ...mono, fontSize: 12, color: T.text }}>{r.v}</span>
                <span style={{ ...mono, fontSize: 11, color: T.textFaint }}>{r.note}</span>
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            marginTop: 22,
            paddingTop: 18,
            borderTop: `1px solid ${T.border}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 14,
          }}
        >
          <span style={{ ...mono, fontSize: 11, color: T.textFaint }}>
            scope locked by erc-7715 · revocable
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onCancel}
              style={{
                ...geist,
                fontSize: 14,
                fontWeight: 500,
                padding: "11px 18px",
                background: "transparent",
                color: T.textMuted,
                border: `1px solid ${T.border}`,
                borderRadius: 8,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              style={{
                ...geist,
                fontSize: 14,
                fontWeight: 500,
                padding: "11px 22px",
                background: T.accent,
                color: T.accentFg,
                border: "none",
                borderRadius: 8,
                cursor: "pointer",
              }}
            >
              Authorize &amp; start
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
