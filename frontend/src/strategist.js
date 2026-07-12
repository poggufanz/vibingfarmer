// strategist.js — multi-provider AI strategist (role module, not a vendor brand).
// Providers are pluggable: Venice (optional BYOK/x402) → DeepSeek (BYOK/host proxy) →
// deterministic equal-split fallback. Naming the file after one vendor implied sponsorship;
// the product role is "strategist". Venice-specific URLs/constants remain under VENICE_* in config.

import {
  VENICE_BASE_URL,
  VENICE_MODEL,
  VENICE_TIMEOUT_MS,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  AI_PROXY_URL,
  VAULT_CATALOG,
  BASE_POOL_CATALOG,
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

const DISPLAY_PROSE_RULE =
  'Write user-facing prose as one plain sentence in sentence case. Do not use em dashes, en dashes, middle dots, emoji, headings, hype, or filler.'
const HYPE_REPLACEMENTS = [
  [/\b(?:cutting-edge|game-changing|groundbreaking|revolutionary|transformative)\b/gi, 'useful'],
  [/\bseamless\b/gi, 'straightforward'],
  [/\brobust\b/gi, 'reliable'],
  [/\bpivotal\b/gi, 'important'],
  [/\b(?:leverage|utilize|harness)\b/gi, 'use'],
  [/\bunlock\b/gi, 'allow'],
]

export function normalizeDisplayProse(value) {
  let text = String(value ?? '')
    .replace(/\s*[\u2014\u2013]\s*/g, '. ')
    .replace(/\s*\u00b7\s*/g, ', ')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]/gu, '')
  for (const [pattern, replacement] of HYPE_REPLACEMENTS) {
    text = text.replace(pattern, replacement)
  }
  text = text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
  return text
    .replace(/[A-Za-z]/, (c) => c.toUpperCase())
    .replace(/([.!?]\s+)([a-z])/g, (_, prefix, c) => prefix + c.toUpperCase())
}

const withDisplayProseRule = (prompt) => `${prompt}\n\n${DISPLAY_PROSE_RULE}`

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
 * @param {number} [temperature] - optional temperature override
 */
async function callChatCompletions(url, model, headers, messages, isVenice, signal, temperature) {
  const body = {
    model,
    response_format: { type: 'json_object' },
    messages,
  }
  if (temperature != null) body.temperature = temperature
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

  // EvoAgentX-style DAG: skill + market + pools + gas + positions fetch concurrently.
  // Cap wall time so a hung RPC/network node cannot freeze the thinking spinner.
  const DAG_TIMEOUT_MS = 15_000
  const fallbackSkill = () =>
    loadVaultSkill().catch(() => ({
      content:
        'You are a DeFi yield advisor. Recommend vaults from the provided catalog based on user risk level. Respond in JSON only.',
      source: 'fallback',
    }))

  if (signal?.aborted) {
    return {
      ...buildFallbackForParams(amount, Math.min(numVaults, VAULT_CATALOG.length)),
      skillSource: 'fallback',
      marketContextUsed: false,
      vaultDataSource: 'fallback',
      vaultsUsed: VAULT_CATALOG,
      dagTimings: { aborted: true },
      dagWallMs: 0,
    }
  }

  let dag
  let dagTimer
  try {
    dag = await Promise.race([
      runStrategyFetchDag({
        riskLevel,
        address,
        useStaticVaults,
        marketContextEnabled,
        loadVaultSkill,
        fetchMarketContext,
      }),
      new Promise((_, reject) => {
        dagTimer = setTimeout(
          () => reject(new Error(`strategy DAG exceeded ${DAG_TIMEOUT_MS}ms`)),
          DAG_TIMEOUT_MS
        )
      }),
    ])
  } catch (err) {
    console.warn(
      '[ai] Strategy DAG failed/timed out - continuing with static catalog:',
      err?.message || err
    )
    dag = {
      skill: await fallbackSkill(),
      marketContext: null,
      pools: null,
      gas: null,
      positions: null,
      signals: null,
      timings: { timedOut: true },
      wallMs: DAG_TIMEOUT_MS,
    }
  } finally {
    if (dagTimer) clearTimeout(dagTimer)
  }
  const skill = dag.skill
  const marketContext = dag.marketContext
  const liveVaults = dag.pools
  console.log(
    `[Venice] strategy DAG, wall ${Math.round(dag.wallMs)}ms, nodes ${JSON.stringify(dag.timings)}`
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
    console.log('[Venice] No market context - using static knowledge only')
  }
  systemPrompt = withDisplayProseRule(systemPrompt)

  const safeNumVaults = Math.min(numVaults, vaultData.length) // fixes high-risk fallback bug

  // BYOK-first: wallet x402 / Settings Venice key / Settings DeepSeek key / host proxy.
  const provider = resolveProviderFromSettings({ veniceAuth, devApiKey })
  if (!provider) {
    console.warn('[ai] No provider - using fallback strategy')
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

  // Always hard-timeout the AI call. Caller may also pass a signal (user "Use default");
  // link both so neither path can hang the thinking UI forever.
  const controller = new AbortController()
  const onExternalAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  const timeout = setTimeout(() => controller.abort(), VENICE_TIMEOUT_MS)
  const sig = controller.signal

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
    const parsed = validateStrategyResponse(JSON.parse(content), vaultData)
    console.log(
      `[ai] Strategy via ${provider.name}, skill: ${skill.source}, vaults: ${vaultDataSource}`
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
    clearTimeout(timeout)
    if (signal) signal.removeEventListener('abort', onExternalAbort)
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
    // Agents are deposit-only (no on-chain swap in the money path), so the fallback grants only a
    // deposit skill — no vestigial mock swap. The AI-generated path may still emit a swap skill for
    // the user to review, but nothing dereferences skills.swap at runtime.
    skills: {
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
    return { ...fallback, error: 'AI skill generation failed. The fallback skill will be used.' }
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
    rationale:
      'No model response was available, so funds are split evenly across available vaults.',
    generatedBy: 'fallback',
  }
}

const VALID_RISK_TIERS = new Set(['low', 'medium', 'high'])

/** Validate AI strategy JSON (allowlist addresses, allocation, risk_tier, APY). */
export function validateStrategyResponse(response, vaultData = VAULT_CATALOG) {
  const allowedAddresses = new Set(vaultData.map((v) => v.address.toLowerCase()))

  if (!response.selected_vaults || !Array.isArray(response.selected_vaults)) {
    throw new Error('Missing selected_vaults array')
  }
  for (const key of ['strategy_summary', 'rationale']) {
    if (typeof response[key] === 'string') response[key] = normalizeDisplayProse(response[key])
  }

  response.selected_vaults.forEach((v, i) => {
    if (!allowedAddresses.has(v.address?.toLowerCase())) {
      throw new Error(`Vault ${i}: hallucinated address ${v.address}`)
    }
    v.reasoning = normalizeDisplayProse(v.reasoning)
    if (v.reasoning.length < 20) {
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
 * validateStrategyResponse's address check). Throws on structural problems so the
 * caller can fall back to the deterministic specialist.
 * @param {object} raw parsed JSON from the model
 * @param {'yield'|'risk'|'market'} role
 * @param {string[]} allowedRuleIds rule ids this role may cite
 * @returns {import('./strategy/councilReview.js').SpecialistVerdict}
 */
export function parseSpecialistVerdict(raw, role, allowedRuleIds = []) {
  const signal = String(raw?.signal || '').toUpperCase()
  if (!VALID_SIGNALS.has(signal)) throw new Error(`invalid signal: ${raw?.signal}`)
  const reasoning = normalizeDisplayProse(raw?.reasoning)
  if (!reasoning) throw new Error('reasoning missing')
  const conf = Math.max(0, Math.min(1, +Number(raw.confidence).toFixed(3)))
  const allowed = new Set(allowedRuleIds)
  const citedRules = Array.isArray(raw.citedRules)
    ? raw.citedRules.filter((id) => allowed.has(id))
    : []
  const concerns = Array.isArray(raw.concerns)
    ? raw.concerns.map(normalizeDisplayProse).filter(Boolean).slice(0, 4)
    : []
  return {
    role,
    signal,
    confidence: Number.isFinite(conf) ? conf : 0,
    reasoning,
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
        { role: 'system', content: withDisplayProseRule(systemPrompt) },
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
 * Parse a proposer verdict: { proposal: {action, reasoning, confidence}, arguments, citedRules }.
 * @param {object} raw parsed JSON
 * @param {string[]} allowedRuleIds
 */
export function parseProposerVerdict(raw, allowedRuleIds = []) {
  const action = String(raw?.proposal?.action || '').toUpperCase()
  if (!VALID_SIGNALS.has(action))
    throw new Error(`invalid proposer action: ${raw?.proposal?.action}`)
  const reasoning = normalizeDisplayProse(raw?.proposal?.reasoning)
  if (!reasoning) throw new Error('proposer reasoning missing')
  const conf = Math.max(0, Math.min(1, +Number(raw.proposal.confidence).toFixed(3)))
  const allowed = new Set(allowedRuleIds)
  const citedRules = Array.isArray(raw.citedRules)
    ? raw.citedRules.filter((id) => allowed.has(id))
    : []
  const arguments_ = Array.isArray(raw.arguments)
    ? raw.arguments.map(normalizeDisplayProse).filter(Boolean).slice(0, 5)
    : []
  return {
    role: 'proposer',
    action,
    confidence: Number.isFinite(conf) ? conf : 0,
    reasoning,
    arguments: arguments_,
    citedRules,
    source: 'ai',
    temperature: 0.9,
  }
}

/**
 * Parse a risk-compliance assessment: { assessment: {action, confidence}, violationsFound, regulationsCited, concerns, compliancePass }.
 * @param {object} raw parsed JSON
 * @param {string[]} allowedRuleIds
 */
export function parseRiskComplianceVerdict(raw, allowedRuleIds = []) {
  const action = String(raw?.assessment?.action || '').toUpperCase()
  if (!VALID_SIGNALS.has(action))
    throw new Error(`invalid risk-compliance action: ${raw?.assessment?.action}`)
  const conf = Math.max(0, Math.min(1, +Number(raw.assessment.confidence).toFixed(3)))
  const allowed = new Set(allowedRuleIds)
  const citedRules = Array.isArray(raw.regulationsCited)
    ? raw.regulationsCited.filter((id) => allowed.has(id))
    : []
  const violations = Array.isArray(raw.violationsFound)
    ? raw.violationsFound.map(normalizeDisplayProse).filter(Boolean).slice(0, 5)
    : []
  const concerns = Array.isArray(raw.concerns)
    ? raw.concerns.map(normalizeDisplayProse).filter(Boolean).slice(0, 4)
    : []
  return {
    role: 'risk-compliance',
    action,
    confidence: Number.isFinite(conf) ? conf : 0,
    violationsFound: violations,
    regulationsCited: citedRules,
    concerns,
    compliancePass: raw.compliancePass === true,
    source: 'ai',
    temperature: 0.0,
  }
}

/**
 * Parse a validator verdict: { consistent, VaRAcceptable, CVaRAcceptable, simMatches, concerns, confidence }.
 * @param {object} raw parsed JSON
 */
export function parseValidatorVerdict(raw) {
  const conf = Math.max(0, Math.min(1, +Number(raw.confidence).toFixed(3)))
  const concerns = Array.isArray(raw.concerns)
    ? raw.concerns.map(normalizeDisplayProse).filter(Boolean).slice(0, 4)
    : []
  return {
    role: 'validator',
    consistent: raw.consistent === true,
    VaRAcceptable: raw.VaRAcceptable === true,
    CVaRAcceptable: raw.CVaRAcceptable === true,
    simMatches: raw.simMatches === true,
    concerns,
    confidence: Number.isFinite(conf) ? conf : 0,
    source: 'ai',
    temperature: 0.0,
  }
}

/**
 * Run the Proposer specialist — high temperature, creative yield-seeking.
 * Responds to risk-compliance feedback when retrying.
 * @param {{systemPrompt:string, userPrompt:string, allowedRuleIds:string[], devApiKey?:string|null, signal?:AbortSignal}} args
 * @returns {Promise<ProposerVerdict|null>}
 */
export async function proposerVerdict({
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
        { role: 'system', content: withDisplayProseRule(systemPrompt) },
        { role: 'user', content: userPrompt },
      ],
      provider.isVenice,
      sig,
      0.9
    )
    return parseProposerVerdict(JSON.parse(content), allowedRuleIds)
  } catch (err) {
    console.warn(`[council] proposer failed (${provider.name}):`, err.message)
    return null
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

/**
 * Run the Risk/Compliance specialist — temperature 0.0, strict regulator.
 * Receives proposer's output and RAG compliance rules.
 * @param {{systemPrompt:string, userPrompt:string, allowedRuleIds:string[], devApiKey?:string|null, signal?:AbortSignal}} args
 * @returns {Promise<RiskComplianceVerdict|null>}
 */
export async function riskComplianceVerdict({
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
        { role: 'system', content: withDisplayProseRule(systemPrompt) },
        { role: 'user', content: userPrompt },
      ],
      provider.isVenice,
      sig,
      0.0
    )
    return parseRiskComplianceVerdict(JSON.parse(content), allowedRuleIds)
  } catch (err) {
    console.warn(`[council] risk-compliance failed (${provider.name}):`, err.message)
    return null
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

/**
 * Run the Validator specialist — temperature 0.0, checks proposal vs simulation.
 * @param {{systemPrompt:string, userPrompt:string, devApiKey?:string|null, signal?:AbortSignal}} args
 * @returns {Promise<ValidatorVerdict|null>}
 */
export async function validatorVerdict({ systemPrompt, userPrompt, devApiKey = null, signal }) {
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
        { role: 'system', content: withDisplayProseRule(systemPrompt) },
        { role: 'user', content: userPrompt },
      ],
      provider.isVenice,
      sig,
      0.0
    )
    return parseValidatorVerdict(JSON.parse(content))
  } catch (err) {
    console.warn(`[council] validator failed (${provider.name}):`, err.message)
    return null
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

/**
 * Generic strategist JSON call — system + user prompt in, parsed JSON object out.
 * Resolves multi-provider chain (Venice / DeepSeek / host proxy). Used by the ACE
 * Curator to propose new playbook rules. Throws on any failure so callers can
 * fall back / no-op (mirrors the contract `proposeRule` expects).
 * @param {{system:string, user:string, devApiKey?:string|null, signal?:AbortSignal}} args
 * @returns {Promise<object>}
 */
export async function askStrategistJson({ system, user, devApiKey = null, signal }) {
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
        { role: 'system', content: withDisplayProseRule(system) },
        { role: 'user', content: user },
      ],
      provider.isVenice,
      sig
    )
    const parsed = JSON.parse(content)
    if (typeof parsed?.text === 'string') parsed.text = normalizeDisplayProse(parsed.text)
    return parsed
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

/** @deprecated Use {@link askStrategistJson} — kept as alias so external/old imports do not break. */
export const askVeniceJson = askStrategistJson

/** @deprecated Use {@link validateStrategyResponse} — kept as alias so external/old imports do not break. */
export const validateVeniceResponse = validateStrategyResponse

const BASE_MANDATE_TTL_SECONDS = 3600
// USDC-denominated ERC-4626 pools priced ~1:1 at deposit time; this is a STRATEGY-TIME estimate
// only. The authoritative minShares used in the real deposit call is recomputed live from the
// pool's convertToShares() right before dispatch (see base/quotes.js, Task 3.4) — pool share
// price can drift between allocation and execution, and this fallback does not track that.
const STRATEGY_TIME_SLIPPAGE_BPS = 50 // 0.5%

function estimateMinSharesAtStrategyTime(amount) {
  const units = BigInt(Math.round(amount * 1_000_000)) // 6dp, Base-side
  return (units * BigInt(10_000 - STRATEGY_TIME_SLIPPAGE_BPS)) / 10_000n
}

function buildBasePoolSkill(pool, amount) {
  const units = BigInt(Math.round(amount * 1_000_000))
  return {
    vaultAddress: pool,
    maxAmount: units.toString(),
    expiresAt: Math.floor(Date.now() / 1000) + BASE_MANDATE_TTL_SECONDS,
  }
}

/**
 * AI strategist allocation across the whitelisted Base pools (Approach C, SP3). Mirrors
 * generateStrategy's provider-resolution + fallback discipline, scoped to a much narrower job:
 * decide WHICH Base pools and HOW MUCH — not the full MDP/DAG/council machinery generateStrategy
 * runs for the Stellar advisor (that would be over-engineering for a 3-pool whitelist YAGNI
 * doesn't ask for here).
 * @param {{ amount: number, riskLevel: 'low'|'medium'|'high', nPools: number, veniceAuth?: string|null, devApiKey?: string|null, signal?: AbortSignal }} params
 * @returns {Promise<Array<{ pool: string, protocol: string, amount: number, minShares: bigint, expectedApy: number, riskTier: string, skill: object }>>}
 */
export async function allocateBasePools({
  amount,
  riskLevel,
  nPools,
  veniceAuth,
  devApiKey,
  signal,
}) {
  const safeNPools = Math.min(nPools, BASE_POOL_CATALOG.length)
  const provider = resolveProviderFromSettings({ veniceAuth, devApiKey })

  const buildFallback = () => {
    const pools = BASE_POOL_CATALOG.slice(0, safeNPools)
    const perPool = amount / pools.length
    return pools.map((p) => ({
      pool: p.address,
      protocol: p.protocol,
      amount: perPool,
      minShares: estimateMinSharesAtStrategyTime(perPool),
      expectedApy: p.apy,
      riskTier: p.risk,
      skill: buildBasePoolSkill(p.address, perPool),
    }))
  }

  if (!provider) return buildFallback()

  const controller = signal ? null : new AbortController()
  const timeout = controller ? setTimeout(() => controller.abort(), VENICE_TIMEOUT_MS) : null
  const sig = signal || controller.signal

  try {
    const systemPrompt = withDisplayProseRule(
      `You allocate USDC across a whitelisted set of Base-chain yield pools. Respond ONLY with JSON: {"allocations":[{"address":"0x...","allocation":0.0-1.0,"reasoning":"..."}]}. Only use addresses from the catalog provided.`
    )
    const userPrompt = `Catalog:\n${JSON.stringify(BASE_POOL_CATALOG, null, 2)}\n\nAllocate ${amount} USDC across up to ${safeNPools} pool(s) for a "${riskLevel}" risk investor. Allocations must sum to 1.0 across the pools you select.`
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
    const parsed = JSON.parse(content)
    const allowedAddresses = new Set(BASE_POOL_CATALOG.map((p) => p.address.toLowerCase()))
    if (!Array.isArray(parsed.allocations) || parsed.allocations.length === 0) {
      throw new Error('empty allocations')
    }
    const filtered = parsed.allocations.filter((a) =>
      allowedAddresses.has(String(a.address).toLowerCase())
    )
    if (filtered.length === 0) throw new Error('no valid (whitelisted) allocations returned')
    const total = filtered.reduce((s, a) => s + a.allocation, 0)
    if (total <= 0) throw new Error('allocation sum is not positive')

    return filtered.map((a) => {
      const catalogEntry = BASE_POOL_CATALOG.find(
        (p) => p.address.toLowerCase() === String(a.address).toLowerCase()
      )
      const poolAmount = amount * (a.allocation / total) // renormalize to 1.0, mirrors enforceActionSpace's spirit
      return {
        pool: catalogEntry.address,
        protocol: catalogEntry.protocol,
        amount: poolAmount,
        minShares: estimateMinSharesAtStrategyTime(poolAmount),
        expectedApy: catalogEntry.apy,
        riskTier: catalogEntry.risk,
        skill: buildBasePoolSkill(catalogEntry.address, poolAmount),
      }
    })
  } catch (err) {
    console.warn('[ai] Base pool allocation failed, using fallback:', err.message)
    return buildFallback()
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
