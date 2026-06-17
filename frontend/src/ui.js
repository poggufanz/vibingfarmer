// DOM helpers, step tracker, activity log

const STEP_IDS = ['connect', 'generate', 'approve', 'execute', 'done']

// Escape HTML before interpolating ANY untrusted value into innerHTML. Agent
// labels, memory lessons, log messages, and skill JSON originate from LLM output
// or user-edited input — unescaped they enable DOM XSS (e.g. <img onerror=...>).
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Set step status.
 * @param {string} stepId - one of STEP_IDS
 * @param {'pending'|'active'|'done'|'error'} status
 */
export function setStep(stepId, status) {
  const el = document.getElementById(`step-${stepId}`)
  if (!el) return
  el.dataset.status = status
}

/**
 * Log a message to the activity log.
 * @param {string} message
 * @param {'info'|'success'|'error'|'warn'} type
 */
const MARKER = { success: '✓', error: '✕', warn: '!', info: '·' }
const MARKER_CLASS = { success: 'ok', error: 'danger', warn: 'warn', info: 'info' }

export function logActivity(message, type = 'info') {
  const container = document.getElementById('log-entries')
  if (!container) return
  const row = document.createElement('div')
  row.className = 'act-row'
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  row.innerHTML = `
    <span class="act-marker ${MARKER_CLASS[type] || 'info'}">${MARKER[type] || '·'}</span>
    <span class="act-text">${esc(message)}</span>
    <span class="act-time">${esc(time)}</span>
  `
  container.appendChild(row)
  container.scrollTop = container.scrollHeight
}

/**
 * Show agent detail in right rail.
 * @param {object} agent - { id, label, status, vault, skills, memory }
 */
export function showAgentDetail(agent) {
  const panel = document.getElementById('detail-panel')
  if (!panel) return
  panel.innerHTML = `
    <div class="detail-header">
      <span class="detail-label">${esc(agent.label)}</span>
      <span class="detail-status detail-status--${esc(agent.status)}">${esc(agent.status)}</span>
    </div>
    <div class="detail-section">
      <div class="detail-key">Agent ID</div>
      <div class="detail-val mono">${esc(String(agent.id).slice(0, 18))}...</div>
    </div>
    <div class="detail-section">
      <div class="detail-key">Vault</div>
      <div class="detail-val mono">${esc(agent.vault || '-')}</div>
    </div>
    <div class="detail-section">
      <div class="detail-key">Skills</div>
      ${agent.skills
        ? `<pre class="detail-code">${esc(JSON.stringify(agent.skills, null, 2))}</pre>`
        : `<div class="detail-empty">Generated when agent dispatches</div>`}
    </div>
    <div class="detail-section">
      <div class="detail-key">Memory${agent.memory && agent.memory.length > 0 ? ` (${agent.memory.length})` : ''}</div>
      ${agent.memory && agent.memory.length > 0
        ? agent.memory.map(e => {
            const t = new Date(e.timestamp * 1000).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
            return `
              <div class="memory-entry memory-entry--${esc(e.status)}">
                <div class="memory-entry-row">
                  <span class="memory-step">${esc(e.step)}</span>
                  <span class="memory-status">${e.status === 'success' ? '✓' : '✕'}</span>
                  <span class="memory-time">${esc(t)}</span>
                </div>
                ${e.lesson ? `<div class="memory-lesson">${esc(e.lesson)}</div>` : ''}
              </div>
            `
          }).join('')
        : `<div class="detail-empty">No entries yet</div>`}
    </div>
  `
}

/**
 * Show orchestrator detail in right rail.
 * @param {object} data - { totalAgents, completed, failed, totalShares }
 */
export function showOrchestratorDetail(data) {
  const panel = document.getElementById('detail-panel')
  if (!panel) return
  panel.innerHTML = `
    <div class="detail-header">
      <span class="detail-label">Orchestrator</span>
    </div>
    <div class="detail-section">
      <div class="detail-key">Total Agents</div>
      <div class="detail-val">${data.totalAgents}</div>
    </div>
    <div class="detail-section">
      <div class="detail-key">Completed</div>
      <div class="detail-val detail-val--success">${data.completed}</div>
    </div>
    <div class="detail-section">
      <div class="detail-key">Failed</div>
      <div class="detail-val detail-val--error">${data.failed}</div>
    </div>
    <div class="detail-section">
      <div class="detail-key">Total Shares</div>
      <div class="detail-val">${data.totalShares}</div>
    </div>
  `
}

/** Enable/disable a button by ID */
export function setButtonEnabled(id, enabled) {
  const btn = document.getElementById(id)
  if (btn) btn.disabled = !enabled
}

/** Show/hide a button by ID */
export function setButtonVisible(id, visible) {
  const btn = document.getElementById(id)
  if (btn) btn.style.display = visible ? '' : 'none'
}

/** Format remaining time until expiresAtMs as "Xh Ym" */
export const fmtRemaining = (expiresAtMs) => {
  if (!expiresAtMs) return null;
  const ms = expiresAtMs - Date.now();
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
};
