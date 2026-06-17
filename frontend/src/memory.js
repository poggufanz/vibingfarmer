// Agent memory: write after execution, read on next run, display in graph detail

const MEMORY_STORAGE_KEY = 'yv_memory'

/**
 * Create a memory entry.
 * @param {string} step - 'swap' | 'approve' | 'deposit'
 * @param {'success'|'failed'} status
 * @param {object} data - arbitrary step data
 * @param {string} [lesson] - optional lesson learned
 * @returns {object} memory entry
 */
export function createEntry(step, status, data = {}, lesson = '') {
  return {
    timestamp: Math.floor(Date.now() / 1000),
    step,
    status,
    ...data,
    ...(lesson ? { lesson } : {})
  }
}

/**
 * Append entries to agent memory.
 * @param {string} agentId
 * @param {string} sessionId
 * @param {string} vault
 * @param {object[]} entries
 */
export function writeMemory(agentId, sessionId, vault, entries) {
  const all = loadAllMemory()
  if (!all[agentId]) {
    all[agentId] = { agentId, sessionId, vault, entries: [] }
  }
  all[agentId].entries.push(...entries)
  all[agentId].sessionId = sessionId
  all[agentId].vault = vault
  localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(all))
}

/**
 * Load memory for agent.
 * @param {string} agentId
 * @returns {{ agentId, sessionId, vault, entries }|null}
 */
export function readMemory(agentId) {
  return loadAllMemory()[agentId] || null
}

/**
 * Load all agent memories.
 * @returns {object} map of agentId → memory object
 */
export function loadAllMemory() {
  try {
    return JSON.parse(localStorage.getItem(MEMORY_STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}

/**
 * Build lesson string from execution result.
 * @param {string} vault
 * @param {object} result - { shares, gasUsed, error }
 * @returns {string}
 */
export function buildLesson(vault, result) {
  if (result.error) return `Vault ${vault.slice(0, 8)} failed: ${result.error}`
  return `Vault ${vault.slice(0, 8)} accepted deposit — ${result.shares} shares received`
}

/** Clear all memory from localStorage. */
export function clearMemory() {
  localStorage.removeItem(MEMORY_STORAGE_KEY)
}
