/* ============================================
   VIBING FARMER — v2 shared components & icons
   ============================================ */
import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { getSidebarPath } from './router.js';
import { t } from './settingsStore.js';

/* ---------- Icons (Lucide-style, stroke 1.5) ---------- */
const Icon = ({ name, size = 16, className = "" }) => {
  const paths = {
    home: <><path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1V9.5z" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.2" /><rect x="14" y="3" width="7" height="7" rx="1.2" /><rect x="3" y="14" width="7" height="7" rx="1.2" /><rect x="14" y="14" width="7" height="7" rx="1.2" /></>,
    layers: <><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>,
    bell: <><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></>,
    refresh: <><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    arrow: <><path d="M5 12h14M13 5l7 7-7 7" /></>,
    check: <><path d="M20 6L9 17l-5-5" /></>,
    x: <><path d="M18 6L6 18M6 6l12 12" /></>,
    copy: <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
    external: <><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14L21 3" /></>,
    logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></>,
    chev: <><path d="M9 6l6 6-6 6" /></>,
    chevDown: <><path d="M6 9l6 6 6-6" /></>,
    network: <><circle cx="12" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" /><path d="M12 7v3M12 10l-6 7M12 10l6 7" /></>,
    code: <><path d="M16 18l6-6-6-6M8 6l-6 6 6 6" /></>,
    edit: <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></>,
    brain: <><path d="M9.5 2a2.5 2.5 0 0 1 2.5 2.5V20a2 2 0 0 1-4 0 2 2 0 0 1-2-2 2 2 0 0 1-1-3.732 2 2 0 0 1 .732-3 2.5 2.5 0 0 1 1-4.268A2.5 2.5 0 0 1 9.5 2zM14.5 2a2.5 2.5 0 0 0-2.5 2.5V20a2 2 0 0 0 4 0 2 2 0 0 0 2-2 2 2 0 0 0 1-3.732 2 2 0 0 0-.732-3 2.5 2.5 0 0 0-1-4.268A2.5 2.5 0 0 0 14.5 2z" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    panelLeftOpen: <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18M14 9l3 3-3 3" /></>,
    panelLeftClose: <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18M17 15l-3-3 3-3" /></>,
    panelRightOpen: <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18M10 15l-3-3 3-3" /></>,
    panelRightClose: <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18M7 9l3 3-3 3" /></>,
  };
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {paths[name] || null}
    </svg>
  );
};

/* ---------- Sidebar (self-contained with React Router) ---------- */
const Sidebar = ({ extended, onToggle }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const activePath = getSidebarPath(location.pathname);

  const items = [
    { key: "home",     icon: "home",     path: "/home",     label: "Home" },
    { key: "vaults",   icon: "grid",     path: "/strategy", label: "Strategy" },
    { key: "agent",    icon: "network",  path: "/agent",    label: "Dashboard" },
    { key: "history",  icon: "layers",   path: "/history",  label: "History" },
    { key: "settings", icon: "settings", path: "/settings", label: "Settings" },
  ];

  return (
    <nav className="sidebar" aria-label="Primary">
      <div className="sb-logo" title="vibing/farmer">
        <img src="/vibing_farmer.logo.svg" alt="logo" style={{ width: 18, height: 18 }} />
        <span className="sb-logo-text">vibing/farmer</span>
      </div>
      {items.map((it) => (
        <button
          key={it.key}
          className={`sb-item ${activePath === it.path ? "active" : ""}`}
          title={it.label}
          aria-label={it.label}
          onClick={() => navigate(it.path)}
        >
          <Icon name={it.icon} />
          <span className="sb-label">{it.label}</span>
        </button>
      ))}
      <div className="sb-spacer" style={{ flex: 1 }} />
      
      <button className="sb-item sb-toggle" onClick={onToggle} title={extended ? "Collapse Sidebar" : "Expand Sidebar"}>
        <Icon name={extended ? "panelLeftClose" : "panelLeftOpen"} style={{ transition: 'all 0.15s ease' }} />
        <span className="sb-label">Collapse</span>
      </button>
    </nav>
  );
};

/* ---------- Top bar — minimal, no chip soup ---------- */
const TopBar = ({ walletConnected, onReset, railCollapsed, onToggleRail, notifications = null }) => {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand">
          <span>vibing</span>
          <span className="slash">/</span>
          <span className="vibing">farmer</span>
        </div>
        <span className="brand-net mono">
          <span className="dot" />sepolia
        </span>
      </div>
      <div className="topbar-right">
        <span className="topbar-meta">
          relayer&nbsp;<b>1Shot</b>&nbsp;·&nbsp;gas&nbsp;<b>0</b>
        </span>
        <button className="icon-btn" title="restart flow" aria-label="restart flow" onClick={onReset}><Icon name="refresh" /></button>
        {notifications}
        <button className="icon-btn" title="new deposit" aria-label="new deposit" onClick={onReset}><Icon name="plus" /></button>
        <button className="icon-btn" title={railCollapsed ? "Show Info Panel" : "Hide Info Panel"} aria-label="toggle info panel" onClick={onToggleRail}>
          <Icon name={railCollapsed ? "panelRightOpen" : "panelRightClose"} style={{ transition: 'all 0.15s ease' }} />
        </button>
      </div>
    </header>
  );
};

/* ---------- Step rail (subtle numeric, no wizard chrome) ---------- */
const STEPS = [
  { id: "strategy", label: "AI Strategy" },
  { id: "connect", label: "Connect & Upgrade" },
  { id: "skills", label: "Review Skills" },
  { id: "permission", label: "Grant Permission" },
  { id: "execute", label: "Auto-Execute" },
  { id: "done", label: "Complete" },
];

const StepRail = ({ stage, furthest = 0, onStepClick, lang = "en" }) => {
  const idx = STEPS.findIndex((s) => s.id === stage);
  return (
    <div className="step-rail" role="progressbar" aria-valuenow={idx + 1} aria-valuemax={STEPS.length}>
      {STEPS.map((s, i) => {
        const state = i < idx ? "done" : i === idx ? "active" : "idle";
        const clickable = i !== idx && i <= furthest; // navigate to any reached step (back/forward); never beyond
        return (
          <div
            key={s.id}
            className={`step-rail-item ${state}${clickable ? " clickable" : ""}`}
            onClick={clickable ? () => onStepClick?.(s.id) : undefined}
            role={clickable ? "button" : undefined}
            tabIndex={clickable ? 0 : undefined}
            onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onStepClick?.(s.id); } } : undefined}
            title={clickable ? `Ke ${s.label}` : undefined}
          >
            <span className="num">{String(i + 1).padStart(2, "0")}</span>
            <span>{t(lang, s.id)}</span>
          </div>
        );
      })}
    </div>
  );
};

export { Icon, Sidebar, TopBar, StepRail, STEPS };
