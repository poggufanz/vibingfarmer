// Skill file generator + localStorage persistence + editor UI

import { AGENT_VAULT_DEPOSITOR_ADDRESS } from './config.js'

const SKILLS_STORAGE_KEY = 'yv_skills'

// Single fund path: every generated skill's execution target is the depositor — never a
// worker EOA. Source the address from the deployed config (validated, real — NOT a
// placeholder), with an optional Vite env override. A non-address would be a runtime
// footgun, so resolve it loudly at module load.
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/
export const DEPOSITOR_TARGET =
  (import.meta.env?.VITE_DEPOSITOR_ADDRESS) || AGENT_VAULT_DEPOSITOR_ADDRESS
if (!DEPOSITOR_TARGET || !ADDR_RE.test(DEPOSITOR_TARGET)) {
  throw new Error('DEPOSITOR_TARGET missing or not a 20-byte address — check config.js / VITE_DEPOSITOR_ADDRESS')
}

// Escape before interpolating into innerHTML — skill JSON is user-editable and
// agentId is externally supplied; unescaped they enable DOM XSS.
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Build a skill whose ONLY execution target is the depositor. Funds can never route to a
 * worker EOA — the single-fund-path guarantee is structural here, not a convention.
 * @param {object} params
 * @param {string} params.vault - ERC-4626 vault the deposit lands in
 * @param {string} params.token - underlying asset (USDC)
 * @param {string|number} params.amount - deposit amount in token units (uint string)
 * @param {string} [params.worker] - MUST be undefined; present → throws (no worker target)
 * @returns {object} skill JSON
 */
export function buildSkill({ vault, token, amount, worker }) {
  // A caller must never be able to slip a worker EOA in as a fund target.
  if (worker !== undefined) {
    throw new Error('buildSkill does not accept a worker target — funds route through the depositor only')
  }
  const steps = [{ kind: 'deposit', target: DEPOSITOR_TARGET, vault, token, amount: String(amount) }]
  for (const s of steps) {
    if (s.target.toLowerCase() !== DEPOSITOR_TARGET.toLowerCase()) {
      throw new Error(`illegal skill target ${s.target} — only the depositor is allowed`)
    }
  }
  return { steps, vault, token, generatedBy: 'venice-ai', approvedByUser: false }
}

/**
 * Save skill to localStorage.
 * @param {string} agentId
 * @param {object} skill
 */
export function saveSkill(agentId, skill) {
  const all = loadAllSkills()
  all[agentId] = skill
  localStorage.setItem(SKILLS_STORAGE_KEY, JSON.stringify(all))
}

/**
 * Load skill for agent.
 * @param {string} agentId
 * @returns {object|null}
 */
export function loadSkill(agentId) {
  return loadAllSkills()[agentId] || null
}

/**
 * Load all skills.
 * @returns {object} map of agentId → skill
 */
export function loadAllSkills() {
  try {
    return JSON.parse(localStorage.getItem(SKILLS_STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}

/**
 * Mark skill as approved by user.
 * @param {string} agentId
 */
export function approveSkill(agentId) {
  const skill = loadSkill(agentId)
  if (!skill) return
  skill.approvedByUser = true
  saveSkill(agentId, skill)
}

/**
 * Render skill editor into a container element.
 * Shows JSON editor + approve button.
 * @param {string} agentId
 * @param {object} skill
 * @param {HTMLElement} container
 * @param {function} onApprove - called with updated skill on approval
 */
export function renderSkillEditor(agentId, skill, container, onApprove) {
  container.innerHTML = `
    <div class="skill-editor">
      <div class="skill-editor-header">Skills: ${esc(String(agentId).slice(0, 12))}...</div>
      <textarea class="skill-json-editor">${esc(JSON.stringify(skill, null, 2))}</textarea>
      <button class="btn-approve-skill">Approve Skills</button>
    </div>
  `
  container.querySelector('.btn-approve-skill').addEventListener('click', () => {
    try {
      const textarea = container.querySelector('.skill-json-editor')
      const updated = JSON.parse(textarea.value)
      updated.approvedByUser = true
      saveSkill(agentId, updated)
      onApprove(updated)
    } catch (e) {
      alert('Invalid JSON in skill editor: ' + e.message)
    }
  })
}

/**
 * Check if all skills for given agentIds are approved.
 * @param {string[]} agentIds
 * @returns {boolean}
 */
export function allSkillsApproved(agentIds) {
  return agentIds.every(id => {
    const s = loadSkill(id)
    return s && s.approvedByUser === true
  })
}

/** Clear all skills from localStorage. */
export function clearSkills() {
  localStorage.removeItem(SKILLS_STORAGE_KEY)
}
