import {
  VENICE_BASE_URL,
  VENICE_MODEL,
  VENICE_TIMEOUT_MS,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  AI_PROXY_URL,
  VAULT_CATALOG,
} from './config.js'
import { loadVaultSkill } from './skillLoader.js'
import { toBaseUnits } from './stellar/format.js'
import { fetchMarketContext } from './marketSearch.js'
import { fetchDeFiLlamaVaults } from './defiLlama.js'
import { runStrategyFetchDag } from './strategy/fetchDag.js'
import { saveStrategy, saveReasoning } from './history.js'
import { loadSettings } from './settingsStore.js'
import { hashStrategy } from './attestation.js'
import { buildStrategyState, enforceActionSpace, scoreReward, riskCeiling } from './strategy/mdp.js'

// AI provider priority (BYOK-first): Venice x402 → Venice key → DeepSeek key → host proxy → hardcoded
// Venice x402:    wallet SIWE auth, pays USDC on Base — no API key needed
// Venice key:     Settings-supplied Bearer token → real Venice endpoint (BYOK)
// DeepSeek key:   Settings-supplied OpenAI-compat key → direct DeepSeek call (BYOK)
// Host proxy:     operator's key in the deploy env, never bundled. Unset on a
//                 lockdown deploy → 503 → fallback (no stranger spends the host key)
// Fallback:       hardcoded equal split — always works (in generateStrategy catch)
// modelPreference (Settings) selects the order; see resolveProvider below.

/**
 * Call an OpenAI-compatible chat completions endpoint.
 * @param {string} baseUrl
 * @param {string} model
 * @param {object} headers - Authorization or X-Sign-In-With-X
 * @param {Array} messages
 * @param {boolean} isVenice - include venice_parameters when true
 * @param {AbortSignal} signal
 */
async function callChatCompletions(url, model, headers, messages, isVenice, signal) {
  const body = {
    model,
    response_format: { type: 'json_object' },
    messages,
  }
  if (isVenice) body.venice_parameters = { include_venice_system_prompt: false }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    signal,
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`API ${response.status}`)
  const data = await response.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('Empty response')
  return content
}

const veniceProvider = (headers, name) => ({
  url: `${VENICE_BASE_URL}/chat/completions`,
  model: VENICE_MODEL,
  headers,
  isVenice: true,
  name,
})
const veniceX402 = (veniceAuth) => veniceProvider({ 'X-Sign-In-With-X': veniceAuth }, 'venice-x402')
const veniceKey = (key) => veniceProvider({ Authorization: `Bearer ${key}` }, 'venice-key')
const deepseekKey = (key) => ({
  url: `${DEEPSEEK_BASE_URL}/chat/completions`,
  model: DEEPSEEK_MODEL,
  headers: { Authorization: `Bearer ${key}` },
  isVenice: false,
  name: 'deepseek-ai',
})
// Host-funded server proxy — last resort. The key lives ONLY in the deploy's
// env (api/ai.js). On a BYOK lockdown deploy that env var is unset, so this 503s
// and the caller degrades to the deterministic fallback — a stranger never spends
// the operator's key.
const hostProxy = () => ({
  url: AI_PROXY_URL,
  model: DEEPSEEK_MODEL,
  headers: {},
  isVenice: false,
  name: 'deepseek-proxy',
})

/**
 * Pick the AI provider from the caller's auth + user-supplied keys + preference.
 * Never returns null: the host proxy is always the final rung (and 503s cleanly on
 * a lockdown deploy → fallback). Honors modelPreference so the Settings radio is real.
 * @param {{veniceAuth?:string|null, veniceApiKey?:string|null, deepseekApiKey?:string|null, modelPreference?:'auto'|'venice'|'deepseek'}} args
 */
export function resolveProvider({
  veniceAuth = null,
  veniceApiKey = null,
  deepseekApiKey = null,
  modelPreference = 'auto',
} = {}) {
  // Wallet x402 always wins — it is the user paying in USDC, not anyone's API key.
  if (veniceAuth) return veniceX402(veniceAuth)

  // Forced Venice: prefer the user's Venice key; skip DeepSeek; degrade to host proxy.
  if (modelPreference === 'venice') return veniceApiKey ? veniceKey(veniceApiKey) : hostProxy()

  // Forced DeepSeek: prefer the user's DeepSeek key; degrade to host proxy.
  if (modelPreference === 'deepseek')
    return deepseekApiKey ? deepseekKey(deepseekApiKey) : hostProxy()

  // Auto: Venice key → DeepSeek key → host proxy.
  if (veniceApiKey) return veniceKey(veniceApiKey)
  if (deepseekApiKey) return deepseekKey(deepseekApiKey)
  return hostProxy()
}

/**
 * Resolve a provider from persisted Settings (BYOK keys + model preference),
 * letting an optional wallet auth or dev-panel key take precedence. Single source
 * of truth so every AI entry point — foreground strategy and background agents —
 * honors the user's keys instead of silently hitting the host proxy.
 * @param {{veniceAuth?:string|null, devApiKey?:string|null}} [over]
 */
function resolveProviderFromSettings({ veniceAuth = null, devApiKey = null } = {}) {
  const s = loadSettings()
  return resolveProvider({
    veniceAuth,
    veniceApiKey: s.veniceApiKey || null,
    deepseekApiKey: devApiKey || s.deepseekApiKey || null,
    modelPreference: s.modelPreference || 'auto',
  })
}

/**
 * Generate multi-vault allocation strategy.
 * @param {object} params
 * @param {number} params.amount
 * @param {'low'|'medium'|'high'} params.riskLevel
 * @param {number} params.numVaults
 * @param {string|null} params.veniceAuth - base64 SIWE header from signSiweForVenice()
 * @param {string|null} params.devApiKey - DeepSeek API key for dev mode
 */
export async function generateStrategy({
  amount,
  riskLevel,
  numVaults,
  veniceAuth,
  devApiKey,
  signal,
  address = null,
}) {
  const settings = loadSettings()
  const useStaticVaults = settings.vaultDataSource === 'static'
  const marketContextEnabled = settings.marketContext !== false

  // EvoAgentX-style DAG: skill + market + pools + gas + positions fetch concurrently
  // (one layer), then on-chain signals derive from market+gas. Replaces the old
  // 3-way Promise.all — same parallelism for skill/market/pools, plus two new real
  // nodes (gas, positions) and a real combined-signals node, with zero added latency.
  const dag = await runStrategyFetchDag({
    riskLevel,
    address,
    useStaticVaults,
    marketContextEnabled,
    loadVaultSkill,
    fetchMarketContext,
  })
  const skill = dag.skill
  const marketContext = dag.marketContext
  const liveVaults = dag.pools
  console.log(
    `[Venice] strategy DAG · wall ${Math.round(dag.wallMs)}ms · nodes ${JSON.stringify(dag.timings)}`
  )

  // Real DeFiLlama vaults when available, else the static VAULT_CATALOG
  const vaultData = liveVaults && liveVaults.length > 0 ? liveVaults : VAULT_CATALOG
  const vaultDataSource = liveVaults && liveVaults.length > 0 ? 'defiLlama' : 'fallback'
  const dataSource =
    vaultDataSource === 'defiLlama'
      ? `live DeFiLlama data (${new Date().toUTCString()})`
      : 'static fallback catalog'

  // System prompt: skill + real vault catalog + injected live market context (if available)
  let systemPrompt = skill.content.replace(
    '[VAULT_CATALOG_JSON]',
    JSON.stringify(vaultData, null, 2)
  )
  if (marketContext) {
    systemPrompt = systemPrompt + '\n\n' + marketContext
    console.log('[Venice] Market context injected from Tavily')
  } else {
    console.log('[Venice] No market context — using static knowledge only')
  }

  const safeNumVaults = Math.min(numVaults, vaultData.length) // fixes high-risk fallback bug

  // BYOK-first: wallet x402 / Settings Venice key / Settings DeepSeek key / host proxy.
  const provider = resolveProviderFromSettings({ veniceAuth, devApiKey })
  if (!provider) {
    console.warn('[ai] No provider — using fallback strategy')
    return {
      ...buildFallbackForParams(amount, safeNumVaults),
      skillSource: skill.source,
      marketContextUsed: marketContext !== null,
      vaultDataSource,
      vaultsUsed: vaultData,
      dagTimings: dag.timings,
      dagWallMs: Math.round(dag.wallMs),
    }
  }

  const userPrompt = `User profile:
- Amount: ${amount} USDC
- Risk tolerance: ${riskLevel}
- Requested vault count: ${safeNumVaults}
- Current date: ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
- Vault data source: ${dataSource}

Select optimal vault(s) from the catalog above. APY and TVL data are real-time from DeFiLlama. Consider live market context if present. Respond in JSON only.`

  // Caller may pass a signal (app-managed 1-min timeout + confirm); else use an internal timeout
  const controller = signal ? null : new AbortController()
  const timeout = controller ? setTimeout(() => controller.abort(), VENICE_TIMEOUT_MS) : null
  const sig = signal || controller.signal

  try {
    const content = await callChatCompletions(
      provider.url,
      provider.model,
      provider.headers,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      provider.isVenice,
      sig
    )
    const parsed = validateVeniceResponse(JSON.parse(content), vaultData)
    console.log(
      `[ai] Strategy via ${provider.name} · skill: ${skill.source} · vaults: ${vaultDataSource}`
    )

    // --- Formal MDP: State -> Action -> Reward (FinRL framing) ---
    // STATE: snapshot what the strategist observed.
    const mdpFullState = buildStrategyState({
      amountUsdc: amount,
      riskLevel,
      numVaults: safeNumVaults,
      vaultData,
      marketContext,
    })
    // ACTION: clamp the AI's proposed allocation to the risk ceiling, renormalize to 1.0.
    const { allocations, violations } = enforceActionSpace(parsed.selected_vaults, mdpFullState)
    parsed.selected_vaults = allocations.map((al) => {
      const orig =
        parsed.selected_vaults.find(
          (v) => String(v.address).toLowerCase() === String(al.address).toLowerCase()
        ) || {}
      return {
        ...orig,
        address: al.address,
        allocation: al.allocation,
        risk_tier: al.risk_tier || orig.risk_tier,
      }
    })
    // REWARD: project a risk-adjusted score for the enforced allocation.
    const reward = scoreReward(parsed.selected_vaults, mdpFullState)
    // Compact state summary for the UI (full universe is too heavy to carry/attest).
    // Prefer the DAG's combined on-chain signals (market context + live gas) over the
    // market-text-only turbulence baked into mdpFullState. Falls back to the baseline
    // when the signals node failed (null).
    const combined = dag.signals || {
      turbulence: mdpFullState.market.turbulence,
      signals: mdpFullState.market.signals,
    }
    const mdpState = {
      turbulence: combined.turbulence,
      signals: combined.signals,
      gasGwei: dag.gas ? dag.gas.gwei : null,
      gasLevel: dag.gas ? dag.gas.level : null,
      universeSize: mdpFullState.universe.length,
      riskCeiling: riskCeiling(mdpFullState),
      profileRisk: mdpFullState.profile.riskLevel,
      capitalUsdc: mdpFullState.capital.amountUsdc,
      actionViolations: violations,
    }
    if (violations.length) console.log('[mdp] action-space violations:', violations)

    // Deterministic tamper-proof hash of the ENFORCED strategy (for on-chain attestation)
    const strategyHash = hashStrategy({ ...parsed, generatedBy: provider.name })
    // Persist strategy session + per-vault AI reasoning to history (localStorage)
    saveStrategy({
      amountUsdc: amount,
      riskLevel,
      numVaults: safeNumVaults,
      vaultsSelected: parsed.selected_vaults.map((v) => ({
        name: v.name,
        protocol: v.protocol,
        apy: v.expected_apy,
        allocation: v.allocation,
      })),
      strategySource: provider.name,
      skillSource: skill.source,
      vaultDataSource,
      marketContextUsed: marketContext !== null,
      blendedApy: parsed.selected_vaults
        .reduce((sum, v) => sum + (v.expected_apy || 0) * (v.allocation || 0), 0)
        .toFixed(2),
      strategyHash,
      dagTimings: dag.timings,
      dagWallMs: Math.round(dag.wallMs),
    })
    parsed.selected_vaults.forEach((v) => {
      if (v.reasoning)
        saveReasoning({
          vaultName: v.name,
          protocol: v.protocol,
          riskTier: v.risk_tier,
          yieldSource: v.yield_source_type,
          reasoning: v.reasoning,
          expectedApy: v.expected_apy,
          amountUsdc: amount,
          riskLevel,
          modelUsed: provider.model,
        })
    })
    return {
      ...parsed,
      generatedBy: provider.name,
      skillSource: skill.source,
      marketContextUsed: marketContext !== null,
      vaultDataSource,
      vaultsUsed: vaultData,
      strategyHash,
      attestation: null,
      reward,
      mdpState,
      dagTimings: dag.timings,
      dagWallMs: Math.round(dag.wallMs),
    }
  } catch (err) {
    console.warn(`[ai] Strategy failed (${provider.name}), using fallback:`, err.message)
    return {
      ...buildFallbackForParams(amount, safeNumVaults),
      skillSource: skill.source,
      marketContextUsed: marketContext !== null,
      vaultDataSource,
      vaultsUsed: vaultData,
      dagTimings: dag.timings,
      dagWallMs: Math.round(dag.wallMs),
    }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

/**
 * Generate skill JSON for a single agent.
 * @param {object} params
 * @param {string} params.agentId
 * @param {string} params.vault
 * @param {number} params.amount
 * @param {string|null} params.veniceAuth
 * @param {string|null} params.devApiKey
 */
export async function generateAgentSkills({ agentId, vault, amount, veniceAuth, devApiKey }) {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600

  const fallback = {
    agentId,
    vaultAddress: vault,
    skills: {
      swap: {
        required: false,
        maxSlippage: 0.5,
        dexPreference: 'mock',
        maxRetries: 2,
        timeoutSeconds: 30,
      },
      deposit: { maxAmount: toBaseUnits(amount).toString(), vaultAddress: vault, expiresAt },
    },
    generatedBy: 'fallback',
    approvedByUser: false,
  }

  const provider = resolveProviderFromSettings({ veniceAuth, devApiKey })
  if (!provider) return fallback

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VENICE_TIMEOUT_MS)

  try {
    const content = await callChatCompletions(
      provider.url,
      provider.model,
      provider.headers,
      [
        {
          role: 'system',
          content: 'You generate DeFi agent skill configurations. Respond ONLY with valid JSON.',
        },
        {
          role: 'user',
          content: `Generate skill config for agent ${agentId} depositing ${amount} USDC to vault ${vault}.
Respond with JSON schema:
{
  "agentId": "${agentId}",
  "vaultAddress": "${vault}",
  "skills": {
    "swap": { "required": false, "maxSlippage": 0.5, "dexPreference": "uniswap-v3", "maxRetries": 2, "timeoutSeconds": 30 },
    "deposit": { "maxAmount": "${toBaseUnits(amount)}", "vaultAddress": "${vault}", "expiresAt": ${expiresAt} }
  },
  "generatedBy": "${provider.name}",
  "approvedByUser": false
}`,
        },
      ],
      provider.isVenice,
      controller.signal
    )
    const result = JSON.parse(content)
    console.log(`[ai] Skills via ${provider.name}`)
    return result
  } catch (err) {
    console.warn(`[ai] Skill gen failed (${provider.name}), using fallback:`, err.message)
    return { ...fallback, error: err.message }
  } finally {
    clearTimeout(timeout)
  }
}

function buildFallbackForParams(amount, numVaults) {
  const count = Math.min(numVaults, VAULT_CATALOG.length)
  const allocation = 1 / count
  return {
    vaults: VAULT_CATALOG.slice(0, count).map((v) => ({
      address: v.address,
      name: v.name,
      allocation,
      expectedApy: v.apy,
    })),
    rationale: 'Fallback: equal split across available vaults',
    generatedBy: 'fallback',
  }
}

const VALID_RISK_TIERS = new Set(['low', 'medium', 'high'])

export function validateVeniceResponse(response, vaultData = VAULT_CATALOG) {
  const allowedAddresses = new Set(vaultData.map((v) => v.address.toLowerCase()))

  if (!response.selected_vaults || !Array.isArray(response.selected_vaults)) {
    throw new Error('Missing selected_vaults array')
  }

  response.selected_vaults.forEach((v, i) => {
    if (!allowedAddresses.has(v.address?.toLowerCase())) {
      throw new Error(`Vault ${i}: hallucinated address ${v.address}`)
    }
    if (!v.reasoning || v.reasoning.length < 20) {
      throw new Error(`Vault ${i}: reasoning missing or too short`)
    }
    if (typeof v.expected_apy !== 'number' || v.expected_apy <= 0 || v.expected_apy > 100) {
      throw new Error(`Vault ${i}: invalid expected_apy: ${v.expected_apy}`)
    }
    if (typeof v.allocation !== 'number' || v.allocation <= 0 || v.allocation > 1) {
      throw new Error(`Vault ${i}: invalid allocation: ${v.allocation}`)
    }
    if (!VALID_RISK_TIERS.has(v.risk_tier)) {
      throw new Error(`Vault ${i}: invalid risk_tier: ${v.risk_tier}`)
    }
  })

  const total = response.selected_vaults.reduce((s, v) => s + v.allocation, 0)
  if (Math.abs(total - 1.0) > 0.01) {
    throw new Error(`Allocation sum ${total.toFixed(2)} !== 1.0`)
  }

  // Cap to catalog size
  if (response.selected_vaults.length > vaultData.length) {
    response.selected_vaults = response.selected_vaults.slice(0, vaultData.length)
  }

  return response
}

/**
 * Classify whether a security search result is a real threat to deposited funds.
 * Uses the default server-side AI proxy (no auth) so the background agent needs no keys.
 * Fail-safe: returns 'none' on any error — never alarms the user on a classification failure.
 * @param {string} searchAnswer - Tavily answer/summary text
 * @param {string} protocol - protocol name (e.g. 'morpho-blue')
 * @returns {Promise<'high'|'medium'|'low'|'none'>}
 */
export async function classifyRisk(searchAnswer, protocol) {
  if (!searchAnswer || searchAnswer.length < 20) return 'none'

  const provider = resolveProviderFromSettings() // BYOK key if set, else host proxy → fallback
  const messages = [
    {
      role: 'system',
      content:
        'You are a DeFi security analyst. Respond ONLY with JSON: {"severity":"high|medium|low|none"}.',
    },
    {
      role: 'user',
      content: `Search result about ${protocol}:
"${searchAnswer}"

Classify the threat level for a user with funds deposited in ${protocol}:
- high: active exploit, hack, or depeg happening now
- medium: vulnerability disclosed, governance concern, unusual activity
- low: minor concern, old news, speculation
- none: no real threat, positive news, or irrelevant`,
    },
  ]

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VENICE_TIMEOUT_MS)
  try {
    const content = await callChatCompletions(
      provider.url,
      provider.model,
      provider.headers,
      messages,
      provider.isVenice,
      controller.signal
    )
    const word = String(JSON.parse(content).severity || '').toLowerCase()
    return ['high', 'medium', 'low', 'none'].includes(word) ? word : 'none'
  } catch {
    return 'none'
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Council conflict resolution — TradingAgents synthesis fallback. Called ONLY
 * when the 3 deterministic specialists are split. Returns the deciding signal.
 * Mirrors classifyRisk: server proxy, JSON-only, timeout, safe fallback.
 * @param {Array<{role:string, signal:string, confidence:number, concerns:string[]}>} verdicts
 * @param {{turbulence:string}} market
 * @returns {Promise<'DEPOSIT'|'HOLD'|'WITHDRAW'>}
 */
export async function resolveCouncilConflict(verdicts, market) {
  const provider = resolveProviderFromSettings()
  const messages = [
    {
      role: 'system',
      content:
        'You are the synthesis agent of a DeFi AI Council. Three specialists disagree. Weigh them and respond ONLY with JSON: {"signal":"DEPOSIT|HOLD|WITHDRAW"}. Safety first: if risk is high, prefer HOLD or WITHDRAW.',
    },
    {
      role: 'user',
      content: `Market regime: ${market?.turbulence || 'unknown'}.
Specialist verdicts:
${verdicts.map((v) => `- ${v.role}: ${v.signal} (conf ${v.confidence}) concerns: ${(v.concerns || []).join('; ') || 'none'}`).join('\n')}

Pick the final signal for whether to proceed with the proposed rebalance/harvest.`,
    },
  ]
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VENICE_TIMEOUT_MS)
  try {
    const content = await callChatCompletions(
      provider.url,
      provider.model,
      provider.headers,
      messages,
      provider.isVenice,
      controller.signal
    )
    const sig = String(JSON.parse(content).signal || '').toUpperCase()
    return ['DEPOSIT', 'HOLD', 'WITHDRAW'].includes(sig) ? sig : 'HOLD'
  } catch {
    return 'HOLD' // safe default — conflict unresolved → discard
  } finally {
    clearTimeout(timeout)
  }
}

const VALID_SIGNALS = new Set(['DEPOSIT', 'HOLD', 'WITHDRAW'])

/**
 * Pure parser/validator for a council specialist's JSON verdict. Drops cited
 * rules that aren't in the role's allowed set (anti-hallucination, mirrors
 * validateVeniceResponse's address check). Throws on structural problems so the
 * caller can fall back to the deterministic specialist.
 * @param {object} raw parsed JSON from the model
 * @param {'yield'|'risk'|'market'} role
 * @param {string[]} allowedRuleIds rule ids this role may cite
 * @returns {import('./strategy/councilReview.js').SpecialistVerdict}
 */
export function parseSpecialistVerdict(raw, role, allowedRuleIds = []) {
  const signal = String(raw?.signal || '').toUpperCase()
  if (!VALID_SIGNALS.has(signal)) throw new Error(`invalid signal: ${raw?.signal}`)
  if (!raw?.reasoning || String(raw.reasoning).length < 1) throw new Error('reasoning missing')
  const conf = Math.max(0, Math.min(1, +Number(raw.confidence).toFixed(3)))
  const allowed = new Set(allowedRuleIds)
  const citedRules = Array.isArray(raw.citedRules)
    ? raw.citedRules.filter((id) => allowed.has(id))
    : []
  const concerns = Array.isArray(raw.concerns) ? raw.concerns.map(String).slice(0, 4) : []
  return {
    role,
    signal,
    confidence: Number.isFinite(conf) ? conf : 0,
    reasoning: String(raw.reasoning),
    citedRules,
    concerns,
    source: 'ai',
  }
}

/**
 * Run ONE council specialist as a Venice AI call. Server-proxy by default (the
 * wallet is not connected at wizard step 01). Returns null on any failure so the
 * caller substitutes the deterministic fallback — the council never blocks.
 * @param {{role:string, systemPrompt:string, userPrompt:string, allowedRuleIds:string[], devApiKey?:string|null, signal?:AbortSignal}} args
 * @returns {Promise<import('./strategy/councilReview.js').SpecialistVerdict|null>}
 */
export async function councilSpecialistVerdict({
  role,
  systemPrompt,
  userPrompt,
  allowedRuleIds,
  devApiKey = null,
  signal,
}) {
  const provider = resolveProviderFromSettings({ devApiKey })
  const controller = signal ? null : new AbortController()
  const timeout = controller ? setTimeout(() => controller.abort(), VENICE_TIMEOUT_MS) : null
  const sig = signal || controller.signal
  try {
    const content = await callChatCompletions(
      provider.url,
      provider.model,
      provider.headers,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      provider.isVenice,
      sig
    )
    return parseSpecialistVerdict(JSON.parse(content), role, allowedRuleIds)
  } catch (err) {
    console.warn(`[council] ${role} specialist failed (${provider.name}):`, err.message)
    return null
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

/**
 * Generic Venice JSON call — system + user prompt in, parsed JSON object out.
 * Used by the ACE Curator to propose new playbook rules. Throws on any
 * failure so callers can fall back / no-op (mirrors the contract `proposeRule` expects).
 * @param {{system:string, user:string, devApiKey?:string|null, signal?:AbortSignal}} args
 * @returns {Promise<object>}
 */
export async function askVeniceJson({ system, user, devApiKey = null, signal }) {
  const provider = resolveProviderFromSettings({ devApiKey })
  const controller = signal ? null : new AbortController()
  const timeout = controller ? setTimeout(() => controller.abort(), VENICE_TIMEOUT_MS) : null
  const sig = signal || controller.signal
  try {
    const content = await callChatCompletions(
      provider.url,
      provider.model,
      provider.headers,
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      provider.isVenice,
      sig
    )
    return JSON.parse(content)
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
