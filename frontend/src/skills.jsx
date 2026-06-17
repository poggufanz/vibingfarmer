/* ============================================
   VIBING FARMER — Skill Review (step 03)
   Human-readable skill cards. No raw JSON shown to user.
   ============================================ */
import React, { useState, useMemo } from 'react';
import SkillDetailModal from './components/SkillDetailModal.jsx';
import SkillEditModal from './components/SkillEditModal.jsx';

/* ---------- Protocol display names ---------- */
const PROTOCOL_NAMES = {
  'pendle':      'Pendle PT-USDC',
  'pendle-v2':   'Pendle v2 USDC',
  'morpho-blue': 'Morpho Blue USDC',
  'aave-v3':     'Aave v3 USDC',
  'fluid':       'Fluid USDC',
  'compound-v3': 'Compound v3 USDC',
  'spark':       'Spark USDC',
};

export function formatProtocol(protocol) {
  return PROTOCOL_NAMES[protocol] || protocol || 'Vault';
}

/* ---------- Translate skill JSON → human readable fields ---------- */
export function translateSkill(agent, skill) {
  const amountVal = agent.allocation
    ? `${agent.allocation} USDC`
    : skill.guards?.maxAmount || '-';

  const action = `Deposit ${amountVal} to ${formatProtocol(agent.vault?.protocol)}`;
  const steps = `${skill.steps?.length || 3} automated steps`;

  const rawExpiry = String(skill.guards?.expiresIn || '86400').replace(/[^0-9]/g, '');
  const expiresInSec = parseInt(rawExpiry, 10) || 86400;
  const hours = Math.floor(expiresInSec / 3600);
  const expiry = `${hours} hour${hours !== 1 ? 's' : ''}`;
  const revocable = skill.guards?.revocable ? '· revocable' : '';
  const risk = skill.guards?.riskProfile || agent.vault?.risk || 'medium';

  return { action, steps, expiry, revocable, risk, amountVal };
}

/* ---------- Skill template generator ---------- */
export const buildSkillForAgent = (agent, riskProfile) => {
  const max = `${agent.allocation} USDC`;
  return {
    name: agent.skillName,
    version: "1.2.0",
    agent: agent.id,
    description: `${agent.role} · single-vault deposit via ERC-7715 scoped permission`,
    target: {
      vault: agent.vault.addr,
      protocol: agent.vault.protocol,
      chain: "sepolia",
    },
    steps: [
      { id: "swap",    action: "uniswap_v3_swap",  params: { tokenIn: "USDC", tokenOut: "USDC", maxSlippageBps: 5 } },
      { id: "approve", action: "erc20_approve",     params: { spender: agent.vault.addr, amount: "exact" } },
      { id: "deposit", action: "erc4626_deposit",   params: { asset: "USDC", shares: "auto" } },
    ],
    guards: {
      maxAmount: max,
      maxGas: "200000",
      expiresIn: "86400",
      revocable: true,
      riskProfile: riskProfile,
    },
  };
};

/* ---------- Single skill card ---------- */
const SkillCard = ({ agent, skill, state, onApprove, onViewDetail }) => {
  const info = translateSkill(agent, skill);
  const isApproved = state === 'approved';

  return (
    <div className={`skill-card2 ${isApproved ? 'approved' : 'pending'}`}>
      <div className="skill-card2-head">
        <span className="skill-card2-idx">{agent.idx}</span>
        <div className="skill-card2-title">
          <div className="skill-card2-name">{agent.name}</div>
          <div className="skill-card2-risk">{info.risk}</div>
        </div>
        <span
          className={`skill-card2-dot ${isApproved ? 'approved' : 'pending'}`}
          aria-label={isApproved ? 'approved' : 'needs review'}
        />
      </div>

      <div className="skill-card2-action">{info.action}</div>

      <div className="skill-card2-steps">{info.steps}</div>

      <div className="skill-card2-meta">
        {info.expiry} {info.revocable}
      </div>

      <div className={`skill-card2-status ${isApproved ? 'approved' : 'pending'}`}>
        {isApproved ? '✓ approved' : '● needs review'}
      </div>

      <div className="skill-card2-actions">
        <button
          className="btn btn-text skill-card2-detail-btn"
          onClick={() => onViewDetail(agent.id)}
        >
          View details
        </button>
        {isApproved ? (
          <button className="btn skill-card2-approve approved" disabled>
            ✓ Approved
          </button>
        ) : (
          <button
            className="btn btn-ghost skill-card2-approve"
            onClick={() => onApprove(agent.id)}
          >
            ✓ Approve
          </button>
        )}
      </div>
    </div>
  );
};

/* ---------- Delegation Chain (A2A hierarchy) ---------- */
const VAULT_LETTERS = ["A", "B", "C", "D", "E"];

const DelegationChain = ({ agents }) => {
  const tree = { fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12, lineHeight: 1.95 };
  const muted = { color: "var(--text-muted, rgba(41,38,27,.55))" };
  return (
    <div style={{
      border: ".5px solid var(--line, rgba(0,0,0,.12))",
      borderRadius: 10,
      padding: "13px 16px",
      margin: "16px 0 20px",
      background: "var(--surface-2, rgba(0,0,0,.02))",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 12.5, letterSpacing: "-0.01em" }}>Delegation Chain</span>
        <span className="mono" style={{
          fontSize: 10, ...muted,
          border: ".5px solid var(--line, rgba(0,0,0,.12))", borderRadius: 5, padding: "2px 7px",
        }}>A2A · ERC-7710</span>
      </div>
      <div style={tree}>
        <div><span style={{ color: "var(--accent, #cfff3d)" }}>●</span> User (Alice)</div>
        <div style={{ paddingLeft: 12 }}>
          <span style={muted}>└─ root delegation →</span> <b>Orchestrator</b>
        </div>
        {agents.map((a, i) => (
          <div key={a.id} style={{ paddingLeft: 36 }}>
            <span style={muted}>{i === agents.length - 1 ? "└─" : "├─"} redelegation →</span>{" "}
            <b>Worker-{i + 1}</b>
            <span style={muted}> · {a.allocation} USDC · vault {VAULT_LETTERS[i] || i + 1}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 9, fontSize: 11, lineHeight: 1.5, ...muted }}>
        Each worker acts only within their delegated scope. Enforced on-chain by <b>DelegationManager</b>.
      </div>
    </div>
  );
};

/* ---------- Skill review screen ---------- */
const SkillReviewCard = ({
  agents, riskProfile, skillStates,
  onApprove, onSkillUpdate, onApproveAll, onContinue,
}) => {
  const [detailAgentId, setDetailAgentId] = useState(null);
  const [editAgentId, setEditAgentId] = useState(null);

  const skills = useMemo(() => {
    const map = {};
    agents.forEach((a) => { map[a.id] = buildSkillForAgent(a, riskProfile); });
    return map;
  }, [agents, riskProfile]);

  const effectiveSkills = useMemo(() => {
    const map = { ...skills };
    Object.entries(skillStates).forEach(([id, s]) => {
      if (s.skill) map[id] = s.skill;
    });
    return map;
  }, [skills, skillStates]);

  const approvedCount = agents.filter((a) => skillStates[a.id]?.state === 'approved').length;
  const allApproved = approvedCount === agents.length;

  const detailAgent = detailAgentId ? agents.find((a) => a.id === detailAgentId) : null;
  const detailSkill = detailAgentId ? effectiveSkills[detailAgentId] : null;
  const editAgent   = editAgentId   ? agents.find((a) => a.id === editAgentId)   : null;
  const editSkill   = editAgentId   ? effectiveSkills[editAgentId]                : null;

  const handleOpenEdit = () => {
    const id = detailAgentId;
    setDetailAgentId(null);
    setEditAgentId(id);
  };

  return (
    <section className="card enter">
      <div className="eyebrow">
        <span className="num">03</span>
        <span>Review skills · {agents.length} agent{agents.length === 1 ? '' : 's'}</span>
        <span className="rule" />
        <span>{approvedCount}/{agents.length} approved</span>
      </div>

      <h1 className="h-display">
        Review the skills each agent will run · before you grant permissions.
      </h1>
      <p className="lede">
        Each agent gets a skill defining exactly what it can do. Review the actions, adjust the limits, then approve. Approved skills are used verbatim at runtime.
      </p>

      <DelegationChain agents={agents} />

      <div className="skill-grid">
        {agents.map((a) => (
          <SkillCard
            key={a.id}
            agent={a}
            skill={effectiveSkills[a.id]}
            state={skillStates[a.id]?.state || 'pending'}
            onApprove={onApprove}
            onViewDetail={setDetailAgentId}
          />
        ))}
      </div>

      <div className="action-row">
        <div className="foot-note">
          Skills are signed by your smart account. Edit limits before approving if needed.
        </div>
        <div className="flex gap-2">
          {!allApproved && (
            <button className="btn btn-ghost" onClick={onApproveAll}>
              Approve all
            </button>
          )}
          <button className="btn btn-primary" disabled={!allApproved} onClick={onContinue}>
            Next · grant permission →
          </button>
        </div>
      </div>

      {detailAgent && detailSkill && (
        <SkillDetailModal
          agent={detailAgent}
          skill={detailSkill}
          state={skillStates[detailAgent.id]?.state || 'pending'}
          onClose={() => setDetailAgentId(null)}
          onApprove={() => { onApprove(detailAgent.id); setDetailAgentId(null); }}
          onEdit={handleOpenEdit}
        />
      )}

      {editAgent && editSkill && (
        <SkillEditModal
          agent={editAgent}
          skill={editSkill}
          onClose={() => setEditAgentId(null)}
          onSave={(updated) => { onSkillUpdate(editAgent.id, updated); setEditAgentId(null); }}
        />
      )}
    </section>
  );
};

export { SkillReviewCard };
