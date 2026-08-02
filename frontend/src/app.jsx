/* ============================================
   VIBING FARMER — App (multi-agent + real Web3)
   Design state machine wired to real wallet.js / strategist.js / orchestrator.js
   ============================================ */
import React, {
  useState as useS,
  useEffect as useE,
  useRef as useR,
  useMemo as useM,
  useReducer as useRed,
} from 'react'
import { lazy, Suspense } from 'react'
import { isDevMode } from './devFlag.js'

import { Icon, Sidebar, TopBar, STEPS } from './components.jsx'
// Strategy Task 13 (Pocket Crew redesign, Wave 5) — the production `/strategy` route.
//
// Fix loop 1 (I1, Strategy Task 13 review): this used to duplicate StrategyRoute.jsx's
// `.pc-route`/`.pc-route-stack` + StrategyProgress wrapper markup verbatim in a local
// `renderStrategyRoute()`, because StrategyRoute.jsx was outside Task 13's authorized file list
// and only wired the Plan branch. The owner has since authorized StrategyRoute.jsx as a scoped
// exception (now wiring Plan/Protect/Start), so app.jsx renders `<StrategyRoute>` instead of
// keeping its own copy — one wrapper definition, not two that can drift.
import { StrategyRoute } from './components/strategy/StrategyRoute.jsx'
import { strategyFlowReducer, initialStrategyFlowState } from './strategy/flowState.js'
import { preflightPermission, toPermissionDecisionView } from './strategy/reusePreflight.js'
import { PermissionPhaseError } from './strategy/permissionError.js'
import { buildDispatchReceipt } from './strategy/dispatchSummary.js'
import { buildStrategyViewModel } from './strategy/planModel.js'
import { AGENT_KIND_DEPOSIT, AGENT_KIND_BRIDGE } from './stellar/grant.js'
import { RouteFocus, SkipLink } from './components/pocket/RouteFocus.jsx'
import { resolveDocumentTitle } from './appShellTitle.js'
import { shortAddr } from './screens.jsx'
import { MemoryModal, makeInitialExecState } from './agents.jsx'
import { useTweaks, TweaksPanel, TweakSection, TweakRadio } from './tweaks-panel.jsx'
import { applyTheme, isLightTheme, normalizeTheme } from './design/theme.js'

import {
  connectActiveAccount,
  onActiveAccountChange,
  revokeAgentOnChain,
  subscribeAgentRevoked,
} from './stellar/index.js'
import { generateStrategy } from './strategist.js'
import { toDisplay, toBaseUnits } from './stellar/format.js'
import {
  queryAgentsByOwner,
  discoverAgentsFromHorizon,
  discoverAgentsFromVault,
} from './stellar/events.js'
import { saveResume, loadResume, clearResume } from './strategy/sessionResume.js'
import OnboardingFlow from './components/OnboardingFlow.jsx'
import { OrchestratorAgent } from './orchestrator.js'
import {
  readRecoveryReceipt,
  requestRecoveryAction,
  resolveRecoveryCredential,
} from './strategy/recoveryClient.js'
import { projectRecoveryReceipt } from './strategy/receiptProjection.js'
import { readContract } from './stellar/client.js'
import { VAULT_CATALOG, VENICE_TIMEOUT_MS, BASE_POOL_CATALOG } from './config.js'
import {
  SOROBAN_ACTIVE_VAULT_ADDRESS,
  SOROBAN_RPC_URL,
  SOROBAN_AUTOFARM_VAULT_ADDRESS,
  SOROBAN_DECIMALS,
} from './stellar/config.js'
import { fetchKeeperEvents } from './stellar/keeperEvents.js'
import { rehydrateScopes } from './stellar/scopeRehydrate.js'
import { readPricePerShare, readLifeboatState, readTotalShares } from './stellar/vaultReads.js'
import { grantMandate } from './stellar/lifeboat.js'
import { signWithTimeout } from './stellar/agentSetup.js'
import {
  resolveBaseAvailability,
  checkCircleUsdcFunding,
  setupBaseMandate,
  buildBaseLegContext,
  applyBaseLegOutcome,
  mapBaseLegEvent,
  baseMandateProbeAllocation,
  baseMandateAllocationsForPlan,
  baseMandateRequiresReview,
} from './mergeFlowHelpers.js'
import { getMandateStatus } from './base/relayerClient.js'
import { readBaseOwner, baseOwnerStorageKey, readBaseMandate } from './wallet/baseBinding.js'
import { readTokenBalance } from './stellar/agentDeposit.js'
import {
  STELLAR_USDC_SAC,
  STELLAR_TOKEN_MESSENGER_MINTER,
  CCTP_BASE_DOMAIN,
  ZERO32,
  evmAddrToBytes32,
} from './stellar/cctpBurn.js'
import {
  loadPersistedPositions,
  persistPositions,
  loadDeployedAgents,
  saveDeployedAgents,
  reconcilePositionsFromChain,
  pickRecoverableVaultAgents,
  mergePositions,
  applyChainPositions,
} from './positionsStore.js'
import { getViewAsAddress } from './dev/viewAs.js'
import {
  diffMarket,
  fastReeval,
  loadLatestSnapshot,
  saveSnapshot,
} from './strategy/councilMonitor.js'
import SkillDrawer from './components/SkillDrawer.jsx'
import HistoryPanel from './components/HistoryPanel.jsx'
import { saveTransaction } from './history.js'
import {
  startBackgroundAgent,
  stopBackgroundAgent,
  updateAgentConfig,
  onAgentEvent,
  withdrawAllFromVault,
} from './agents/agentController.js'
const Withdraw = lazy(() => import('./screens/Withdraw.jsx'))
import NotificationCenter from './components/NotificationCenter.jsx'
import { loadDeviceBasePositions, loadIndexedBasePositions } from './base/dashboardPositions.js'
import { readIdleUsdc } from './base/readPositions.js'
// Task 10 (IA remap) — HomePage is retired; `/home` now mounts MyMoneyRoute directly (the one
// portfolio authority), and `/agent` becomes the crew's own live console below.
// My Money Task 13 (Pocket Crew redesign, Wave 5) — the production My money route. Replaces
// OpsConsole (retired from every production route below; its files stay for rollback/tests, see
// this task's report for the bundle-scan proof that no production route imports console.css).
import { MyMoneyRoute } from './components/money/MyMoneyRoute.jsx'
import { WithdrawDialog } from './components/money/WithdrawDialog.jsx'
import { StopAccessDialog } from './components/money/StopAccessDialog.jsx'
import { RecoveryPanel } from './components/money/RecoveryPanel.jsx'
import { CrewRoute } from './components/crew/CrewRoute.jsx'
import { selectCrewDecisions } from './components/crew/selectCrewDecisions.js'
import { discoverOwnerScopes } from './stellar/ownerDiscovery.js'
import { readOwnerMoney, aggregateOwnerPositions } from './money/readOwnerMoney.js'
import { buildMyMoneyModel } from './money/myMoneyModel.js'
// planFullExit/planPartialExit/planRevoke are NOT called here -- AgentTeam.jsx/WithdrawDialog.jsx/
// StopAccessDialog.jsx already compute the plan and hand it back via onConfirmFull/onConfirmPartial/
// onConfirmRevoke/onRecoverAgent; this controller only ever EXECUTES a plan it's given and
// reconciles the aftermath.
import { reconcileOwnerAction } from './money/ownerActions.js'
import {
  classifyKeeperAutomation,
  classifyStrategyConfiguration,
  classifyLifeboatAutomation,
  describeRiskWatchProvenance,
} from './money/automationEvidence.js'
import { nextReconciliationToken, isReconciliationCurrent } from './money/freshness.js'
import { sweepAgents } from './stellar/exit.js'
import { ensureExitSigner, partialWithdraw } from './stellar/partialWithdraw.js'
import { assertCurrentActiveAccount } from './stellar/activeAccount.js'
const LandingHero = lazy(() => import('./components/LandingHero.jsx'))
const ExplorerPage = lazy(() => import('./components/ExplorerPage.jsx'))
const EcosystemPage = lazy(() => import('./components/EcosystemPage.jsx'))
const ReplayPage = lazy(() => import('./components/ReplayPage.jsx'))
const DevelopersLayout = lazy(() => import('./developers/DevelopersLayout.jsx'))
import SettingsPage from './components/SettingsPage.jsx'
import {
  WalletPanel,
  PermissionPanel,
  ActivityPanel,
  SkillPanel,
  PalettePicker,
  PALETTES,
} from './components/RightRail.jsx'
import { loadSettings, saveSetting } from './settingsStore.js'
import { clearUserSkill } from './skillLoader.js'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import VaultDetailPage from './components/VaultDetailPage.jsx'
import TxDetailPage from './components/TxDetailPage.jsx'

import { toSummary as scopeSummary } from './strategy/permissionScope.js'
import { buildStrategyState, enforceActionSpace, scoreReward } from './strategy/mdp.js'
import { runSimulation, allocationsFromStrategy } from './strategy/simulation.js'
import { evaluateGates } from './strategy/gates.js'
import { createMonitorLoop } from './strategy/monitorLoop.js'
import { primeVaultFacts } from './strategy/vaultFactsLive.js'
import { councilVerdict } from './strategy/council.js'
import { reflect } from './strategy/reflector.js'
import { increment as playbookIncrement, weight as playbookWeight } from './strategy/playbook.js'
import { saveCycle } from './strategy/cycleJournal.js'
import { computeBasket, slugFor } from './strategy/basketFilter.js'
import { buildEligibilityReview } from './strategy/eligibilityReview.js'
import { buildEligibilitySentence, vaultEligibilityLabel } from './strategy/eligibilitySentence.js'
import { SNAPSHOT } from './strategy/vaultFacts.js'
import { recordDecision } from './strategy/decisionLog.js'
import {
  resolveCouncilConflict,
  councilSpecialistVerdict,
  proposerVerdict,
  riskComplianceVerdict,
  validatorVerdict,
  askStrategistJson,
} from './strategist.js'
import {
  councilReview,
  buildCouncilInput,
  councilDebate,
  buildDebateInput,
} from './strategy/councilReview.js'
import { councilOutcome } from './strategy/outcome.js'
import { proposeRule } from './strategy/curator.js'
import { upsertSeeds, getRules, addRule, replaceAll } from './strategy/ruleStore.js'

/* ---------- Background agent settings (localStorage: yv_agent_settings) ---------- */
const AGENT_SETTINGS_DEFAULTS = {
  autoHarvest: false,
  harvestMinUsdc: 1.0,
  apyDropPct: 20,
  rebalanceThresholdPct: 1.5,
  emergencyFull: false,
  emergencyPct: 50,
  riskMonitoring: true,
  positionInterval: 5,
  apyInterval: 2,
  riskInterval: 15,
  rewardInterval: 5,
  maxDrawdownPct: 10.0,
  discordWebhookUrl: '',
  telegramToken: '',
  telegramChatId: '',
}
const loadAgentSettings = () => {
  try {
    return {
      ...AGENT_SETTINGS_DEFAULTS,
      ...JSON.parse(localStorage.getItem('yv_agent_settings') || '{}'),
    }
  } catch {
    return { ...AGENT_SETTINGS_DEFAULTS }
  }
}

const sendPushNotification = async (ev, passedSettings) => {
  const isAlert = [
    'risk_alert',
    'apy_drift',
    'rebalance_proposal',
    'harvest_ready',
    'compound_executed',
    'rebalance_executed',
  ].includes(ev.kind)
  if (!isAlert) return

  let settings = passedSettings
  if (!settings) {
    try {
      settings = {
        ...AGENT_SETTINGS_DEFAULTS,
        ...JSON.parse(localStorage.getItem('yv_agent_settings') || '{}'),
      }
    } catch {
      settings = { ...AGENT_SETTINGS_DEFAULTS }
    }
  }

  let title = 'Vibing Farmer alert'
  let detail = ''

  if (ev.kind === 'rebalance_proposal') {
    title = 'Rebalance opportunity detected'
    detail = `Venice AI flagged ${ev.toProtocol} at ${ev.toApy}% vs your current ${ev.fromVault} at ${ev.fromApy}% (potential gain: +${ev.apyGain}%).`
  } else if (ev.kind === 'risk_alert') {
    title = `Risk alert: ${ev.severity}`
    detail = `Signal on ${ev.vaultName}: ${ev.searchAnswer || 'Security concern detected.'}`
  } else if (ev.kind === 'apy_drift') {
    title = 'APY drop detected'
    detail = `APY on ${ev.vaultName} dropped from ${ev.baselineApy}% to ${ev.currentApy}% (${ev.driftPct}%).`
  } else if (ev.kind === 'harvest_ready') {
    title = 'Yield ready to claim'
    detail = `${ev.rewardsUsdc} USDC accrued on ${ev.vaultName} is ready to claim.`
  } else if (ev.kind === 'compound_executed') {
    title = 'Keeper compounded'
    detail = `${ev.vaultName}, +${ev.totalGainUsdc} USDC reinvested, price/share ${ev.pricePerShare}. No action needed.`
  } else if (ev.kind === 'rebalance_executed') {
    title = 'Keeper rebalanced'
    detail = `${ev.vaultName}, ${ev.fromLabel} → ${ev.toLabel}, ${ev.amountUsdc} USDC moved. No action needed.`
  }

  const messageText = `*${title}*\n\n${detail}\n\n_Time: ${new Date(ev.timestamp || Date.now()).toLocaleString()}_`

  // Send Discord notification
  if (settings.discordWebhookUrl) {
    try {
      await fetch(settings.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `**${title}**\n${detail}`,
        }),
      })
    } catch (e) {
      console.warn('[Notification] Discord failed:', e.message)
    }
  }

  // Send Telegram notification
  if (settings.telegramToken && settings.telegramChatId) {
    try {
      await fetch(`https://api.telegram.org/bot${settings.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: settings.telegramChatId,
          text: messageText,
          parse_mode: 'Markdown',
        }),
      })
    } catch (e) {
      console.warn('[Notification] Telegram failed:', e.message)
    }
  }
}

/* ---------- Right rail panels ---------- */

/* ---------- Palette picker ---------- */

/* ---------- Helpers ---------- */
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/ {
  palette: 'forest',
  density: 'comfortable',
  speed: 'medium',
} /*EDITMODE-END*/

const SPEED_MS = { fast: 220, medium: 600, slow: 1100 }

const nowT = () => {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

// Map real worker step names → design's 3-step model
const WORKER_STEP_MAP = { swap: 'swap', approve: 'approve', deposit: 'deposit' }

// Map Venice strategy output (selected_vaults schema) → design strategy format
const mapVeniceToStrategy = (veniceResult, amount, risk) => {
  const total = Number(amount)
  const PROTOCOLS = ['aave-v3', 'morpho-blue', 'pendle-v2']
  const ROLES = [
    'Conservative, lending',
    'Balanced, liquidity provision',
    'Aggressive, leveraged yield',
  ]
  const byAddr = (addr) =>
    VAULT_CATALOG.find((c) => c.address.toLowerCase() === String(addr).toLowerCase()) || {}
  const usedVaults = veniceResult.vaultsUsed || []
  // Chain-aware first: 'aave-v3'/'morpho-blue' exist on BOTH chains in usedVaults (the merged
  // catalog), so a bare protocol match alone would silently resolve to the Stellar entry even
  // when v.chain (stamped by strategist.js's validateStrategyResponse) says 'base' — dropping
  // factSlug/chain off the built vault below and re-colliding with the wrong eligibility facts.
  const byLive = (v) =>
    usedVaults.find((x) => x.protocol === v.protocol && x.chain === v.chain) ||
    usedVaults.find((x) => x.protocol === v.protocol) ||
    usedVaults.find((x) => x.address?.toLowerCase() === String(v.address).toLowerCase()) ||
    {}
  const list = veniceResult.selected_vaults || []
  const agents = list.map((v, i) => {
    const cat = byAddr(v.address)
    const live = byLive(v)
    return {
      id: `worker-${i + 1}`,
      idx: String(i + 1).padStart(2, '0'),
      name: `Worker ${i + 1}, ${ROLES[i]?.split(', ')[0] || 'Conservative'}`,
      role: ROLES[i] || 'Conservative, lending',
      allocation: +(total * v.allocation).toFixed(2),
      skillName: 'yield_vault_deposit',
      reasoning: v.reasoning, // AI metadata → UI
      riskTier: v.risk_tier, // AI metadata → UI
      yieldSource: v.yield_source_type, // AI metadata → UI
      vault: {
        name: v.name || live.name || cat.name || `Pool ${i + 1}`,
        protocol: v.protocol || live.protocol || cat.protocol || PROTOCOLS[i] || 'aave-v3',
        apy: String(v.expected_apy ?? live.apy ?? cat.apy ?? 4.8),
        drawdown: live.drawdown || cat.drawdown || '-1.8',
        risk: v.risk_tier || cat.risk || 'medium',
        // v.address first: it is the AI's actual selected address, already allowlist-validated
        // against the merged catalog (validateStrategyResponse) — always present/correct. The
        // VAULT_CATALOG protocol fallback below is Stellar-only lookup; for a base vault whose
        // protocol string also exists on Stellar (aave-v3/morpho-blue) it would otherwise
        // silently substitute the STELLAR contract address for the real Base 0x pool address.
        addr:
          v.address ||
          cat.address ||
          VAULT_CATALOG.find((c) => c.protocol === (v.protocol || ''))?.address,
        tvl: v.tvlFormatted || live.tvlFormatted || 'N/A',
        isLiveData: live.source === 'defiLlama',
        defillamaPool: live.defillamaPool || null,
        // Base pools disambiguate their eligibility-fact lookup via factSlug (basketFilter.js's
        // slugFor); chain drives the orchestrator's Stellar/Base dispatch split.
        factSlug: v.factSlug || live.factSlug || cat.factSlug || null,
        chain: v.chain || live.chain || cat.chain || 'stellar',
      },
    }
  })
  const blended = agents.reduce((acc, a) => acc + Number(a.vault.apy) * (a.allocation / total), 0)
  return {
    agents,
    total,
    blendedApy: blended.toFixed(1),
    risk,
    rationale: veniceResult.strategy_summary || veniceResult.rationale,
    reward: veniceResult.reward || null,
    mdpState: veniceResult.mdpState || null,
  }
}

// Worker monitoring list from ALL held positions (not just the latest strategy), enriched
// with protocol/APY meta from the current strategy first, then the static catalog — so the
// background agent keeps watching earlier deposits after a new one is added.
const buildActiveVaults = (positions, strategy) => {
  const meta = {}
  ;(strategy?.agents || []).forEach((a) => {
    meta[a.vault.addr.toLowerCase()] = {
      name: a.vault.name,
      protocol: a.vault.protocol,
      depositApy: Number(a.vault.apy),
    }
  })
  VAULT_CATALOG.forEach((v) => {
    const k = v.address.toLowerCase()
    if (!meta[k]) meta[k] = { name: v.name, protocol: v.protocol, depositApy: Number(v.apy) }
  })
  return Object.entries(positions || {})
    .map(([address, p]) => {
      const m = meta[address.toLowerCase()] || {}
      return {
        address,
        name: p.vaultName || m.name,
        protocol: m.protocol,
        depositApy: m.depositApy || 0,
      }
    })
    .filter((v) => v.protocol)
}

/* ---------- My Money Task 13: pure money-controller helpers ----------
 * Exported for direct unit testing (app.money.test.jsx) — same convention as
 * mergeFlowHelpers.js/app.strategy.merge.test.jsx: extract the logic that actually needs
 * adversarial proof (race conditions, cache assembly, projection) into plain functions app.jsx's
 * own effects/handlers call, rather than trying to render the whole stateful App in a test. None
 * of these touch React state, a wallet, or a secret — they only ever see {kind,address} account
 * shapes and the same read-only envelopes ownerDiscovery.js/readOwnerMoney.js already produce. */

const moneyCacheKey = (owner) => `yv_my_money_cache_${String(owner).toLowerCase()}`

/** Restore the last-known {money, discovery, protection} cache for `owner` (sync, instant) —
 * same convention as positionsStore.js's loadPersistedPositions. */
/**
 * A tiny owner-state gate used by the React controller and its async callbacks. Installing a
 * replacement clears every owner-scoped surface before exposing the next immutable capability.
 */
export function createActiveAccountEpochStore({ initial = null, clear = () => {} } = {}) {
  let active = initial
  return {
    current: () => active,
    capture: () => active,
    assertCurrent: (captured) => assertCurrentActiveAccount({ captured, current: active }),
    install(next) {
      if (active) clear(active)
      active = next || null
      return active
    },
  }
}

/** One orchestration's cancellation + render gate. Stale callbacks are dropped; custody code can
 * call assertCurrent() to stop the underlying async pipeline at its next boundary. */
export function createEpochBoundRun({ captured, getCurrent, onEvent = () => {} }) {
  const controller = new AbortController()
  const assertCurrent = () => {
    if (controller.signal.aborted)
      throw Object.assign(new Error('The active wallet account changed.'), {
        code: 'ACTIVE_ACCOUNT_CHANGED',
      })
    return assertCurrentActiveAccount({ captured, current: getCurrent() })
  }
  const commit = (callback) => {
    try {
      assertCurrent()
    } catch {
      return false
    }
    callback()
    return true
  }
  return {
    signal: controller.signal,
    assertCurrent,
    cancel: () => controller.abort(),
    commit,
    onEvent: (...args) => commit(() => onEvent(...args)),
  }
}

/** Account-epoch-scoped constructor input for the raw recovery orchestrator. Keeping this guard at
 * the App boundary prevents a late recorder callback from reaching React even if an internal
 * orchestrator event source is added later without its own account assertion. */
export function createAccountScopedRecoveryConfig({ captured, getCurrent, onEvent, sessionId }) {
  const epochRun = createEpochBoundRun({ captured, getCurrent, onEvent })
  return {
    user: captured.address,
    activeAccount: captured,
    getCurrentActiveAccount: getCurrent,
    sessionId,
    signal: epochRun.signal,
    onEvent: epochRun.onEvent,
  }
}

/**
 * Recoverable Stellar rows are reconstructed only from the confirmed address vector and the same
 * ordered top-level plan that produced it. Base parents/children are intentionally absent: their
 * current result evidence is display-only until a durable Base receipt producer exists.
 */
export function buildRecoveryAllocationMappings({
  plan,
  confirmedPermission,
  reviewedPermission,
  owner,
}) {
  const agents = Array.isArray(plan?.agents) ? plan.agents : []
  const addresses = confirmedPermission?.agentAddresses
  if (
    !owner ||
    !plan?.runId ||
    !Array.isArray(addresses) ||
    addresses.length !== agents.length ||
    addresses.some((address) => typeof address !== 'string' || address.length === 0)
  ) {
    throw new Error('The confirmed agent address order is incomplete for recovery.')
  }
  if (
    reviewedPermission?.mode &&
    confirmedPermission?.mode &&
    reviewedPermission.mode !== confirmedPermission.mode
  ) {
    throw new Error('The reviewed permission mode does not match confirmed recovery evidence.')
  }
  const reviewedRows =
    reviewedPermission?.version === 3 ? reviewedPermission.executions : reviewedPermission?.agents
  const mappings = new Map()
  agents.forEach((agent, index) => {
    if (agent?.kind === 'bridge') return
    const agentAddress = addresses[index]
    if (Array.isArray(reviewedRows)) {
      const reviewed = reviewedRows.find((row) => row?.allocationId === agent.allocationId)
      if (
        reviewedPermission?.mode === 'reuse' &&
        (!reviewed || reviewed.agentAddress !== agentAddress)
      ) {
        throw new Error(`Reviewed agent evidence disagrees for ${agent.allocationId}.`)
      }
    }
    // Orchestrator workers execute `agent.cap.units` verbatim (buildFreshWorkers/
    // buildReuseWorkers); recovery must journal and call the identical amount source.
    const amount = agent?.cap
    if (
      !amount ||
      typeof amount.token !== 'string' ||
      typeof amount.units !== 'string' ||
      !/^\d+$/.test(amount.units) ||
      !Number.isInteger(amount.decimals) ||
      amount.decimals < 0
    ) {
      throw new Error(`Recovery amount is malformed for ${agent?.allocationId || 'allocation'}.`)
    }
    mappings.set(agent.allocationId, {
      networkId: 'stellar-testnet',
      owner,
      executionId: `${plan.runId}:exec:${agent.allocationId}`,
      allocationId: agent.allocationId,
      childId: null,
      runId: plan.runId,
      agentAddress,
      amount: { token: amount.token, units: amount.units, decimals: amount.decimals },
    })
  })
  return mappings
}

const RECOVERY_MANUAL_REVIEW_CODES = new Set([
  'RECOVERY_POLL_TX_HASH_REQUIRED',
  'RECOVERY_POLL_SHARE_BASELINE_REQUIRED',
])

function canonicalRecoveryValue(value) {
  if (Array.isArray(value)) return value.map(canonicalRecoveryValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalRecoveryValue(value[key])])
    )
  }
  return value
}

function sameRecoveryReceipt(left, right) {
  return (
    JSON.stringify(canonicalRecoveryValue(left)) === JSON.stringify(canonicalRecoveryValue(right))
  )
}

function latestRealRecoveryAttempt(receipt, phase) {
  const attempts = Array.isArray(receipt?.attempts) ? receipt.attempts : []
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index]
    if (attempt?.kind === 'phase' && attempt.phase === phase) return attempt
  }
  return null
}

function currentPollProofError(projection) {
  if (projection.action !== 'poll') return null
  const attempt = latestRealRecoveryAttempt(projection.receipt, projection.phase)
  if (typeof attempt?.evidence?.txHash !== 'string' || attempt.evidence.txHash.length === 0) {
    return {
      code: 'RECOVERY_POLL_TX_HASH_REQUIRED',
      phase: projection.phase,
      message: `Recovery poll for ${projection.phase} has no durable transaction hash`,
    }
  }
  if (
    projection.phase === 'stellar_deposit' &&
    (typeof attempt.evidence.preShareUnits !== 'string' ||
      !/^\d+$/.test(attempt.evidence.preShareUnits))
  ) {
    return {
      code: 'RECOVERY_POLL_SHARE_BASELINE_REQUIRED',
      phase: projection.phase,
      message: 'Deposit poll has no durable pre-submission share baseline',
    }
  }
  return null
}

/**
 * Project the one current authoritative recovery row after a poll-proof failure. A known claim is
 * the local monotonic floor: an absent, malformed, lower, or same-version-but-different reread
 * cannot replace it. Poll is exposed only from proof carried by the current phase's latest real
 * attempt; stale errors never override newer terminal/manual states or safe newer work.
 */
function projectRecoveryAuthority({ authoritative, claim, error, identity, projectReceipt }) {
  const claimHasReceipt = claim?.receipt != null && Number.isSafeInteger(claim?.version)
  const currentVersion = authoritative?.version
  const currentReceipt = authoritative?.receipt
  const currentRowValid =
    Number.isSafeInteger(currentVersion) &&
    currentVersion >= 0 &&
    ((currentReceipt == null && currentVersion === 0) || currentReceipt?.version === currentVersion)
  const violatesClaimFloor =
    claimHasReceipt &&
    (!currentRowValid ||
      currentReceipt == null ||
      currentVersion < claim.version ||
      (currentVersion === claim.version && !sameRecoveryReceipt(currentReceipt, claim.receipt)))
  const selected = violatesClaimFloor
    ? { receipt: claim.receipt, version: claim.version }
    : authoritative
  const next = projectReceipt({ ...selected, identity })
  const proofError = currentPollProofError(next)
  if (proofError) {
    return {
      ...next,
      action: 'manual-review',
      phase: proofError.phase,
      reasonCode: proofError.code,
      reason: proofError.message,
    }
  }
  if (violatesClaimFloor) {
    return {
      ...next,
      action: 'manual-review',
      phase: error?.phase ?? claim.phase ?? next.phase,
      reasonCode: error?.code ?? 'RECOVERY_RECEIPT_CHANGED',
      reason:
        error?.primaryError?.message ??
        error?.message ??
        'Recovery reread did not preserve the claimed receipt; manual reconciliation is required.',
    }
  }
  if (!RECOVERY_MANUAL_REVIEW_CODES.has(error?.code)) return next
  if (
    next.action === 'complete' ||
    next.action === 'manual-review' ||
    next.action === 'blocked-reconcile' ||
    next.action === 'poll' ||
    (Number.isSafeInteger(currentVersion) && currentVersion > claim.version)
  ) {
    return next
  }
  return {
    ...next,
    action: 'manual-review',
    phase: error.phase ?? claim.phase ?? next.phase,
    reasonCode: error.code,
    reason: error.primaryError?.message ?? error.message,
  }
}

/** Stable, dependency-injected controller shared by App and app.recovery.test.jsx. */
export function createRecoveryActionRunner({
  getActiveAccount,
  getProjection,
  getMapping,
  getPermission,
  resolveCredential = resolveRecoveryCredential,
  requestAction = requestRecoveryAction,
  readReceipt = readRecoveryReceipt,
  projectReceipt = projectRecoveryReceipt,
  recoverAllocation,
  onProjection = () => {},
  onPending = () => {},
  onError = () => {},
  leaseOwner,
  vault,
}) {
  const pending = new Set()
  const assertCurrent = (captured) =>
    assertCurrentActiveAccount({ captured, current: getActiveAccount() })
  const projectAuthoritative = async (mapping, captured) => {
    const authoritative = await readReceipt({
      networkId: mapping.networkId,
      owner: mapping.owner,
      executionId: mapping.executionId,
      allocationId: mapping.allocationId,
    })
    assertCurrent(captured)
    const next = projectReceipt({
      ...authoritative,
      identity: mapping,
    })
    assertCurrent(captured)
    onProjection(mapping.allocationId, next)
    return authoritative
  }

  return {
    async run(allocationId) {
      if (pending.has(allocationId)) return { skipped: 'pending' }
      const projected = getProjection(allocationId)
      if (
        projected?.action === 'blocked-reconcile' ||
        projected?.route?.source === 'base-child-result'
      ) {
        return { skipped: 'blocked-reconcile' }
      }
      const mapping = getMapping(allocationId)
      const captured = getActiveAccount()
      if (
        !projected?.requestIdentity ||
        !mapping ||
        captured?.version !== 1 ||
        captured.address !== mapping.owner ||
        projected.route?.allocationId !== allocationId
      ) {
        throw new Error(`Recovery is unavailable for allocation ${allocationId}.`)
      }
      pending.add(allocationId)
      onPending(allocationId, true)
      let claim = null
      try {
        assertCurrent(captured)
        const credential = await resolveCredential({
          networkId: mapping.networkId,
          owner: mapping.owner,
          vault,
          agentAddress: mapping.agentAddress,
        })
        assertCurrent(captured)
        claim = await requestAction({
          ...projected.requestIdentity,
          networkId: mapping.networkId,
          owner: mapping.owner,
          receipt: projected.receipt,
          agentAddress: mapping.agentAddress,
          allocationMapping: mapping,
          leaseOwner,
          vault,
          resolveCredential: () => credential,
        })
        assertCurrent(captured)
        const result = await recoverAllocation({
          claim,
          credential,
          allocationMapping: mapping,
          permissionEvidence: getPermission(),
        })
        assertCurrent(captured)
        const next = projectRecoveryAuthority({
          authoritative: result,
          claim,
          error: result.error,
          identity: mapping,
          projectReceipt,
        })
        onProjection(allocationId, next)
        if (result.error) onError(result.error, allocationId)
        return result
      } catch (error) {
        try {
          assertCurrent(captured)
          if (RECOVERY_MANUAL_REVIEW_CODES.has(error?.code) && claim) {
            let authoritative = { receipt: claim.receipt, version: claim.version }
            try {
              authoritative = await readReceipt({
                networkId: mapping.networkId,
                owner: mapping.owner,
                executionId: mapping.executionId,
                allocationId: mapping.allocationId,
              })
            } catch {
              // The claimed receipt/version remains the authoritative input for this local,
              // disabled projection when both post-action reads are unavailable.
            }
            assertCurrent(captured)
            const next = projectRecoveryAuthority({
              authoritative,
              claim,
              error,
              identity: mapping,
              projectReceipt,
            })
            assertCurrent(captured)
            onProjection(allocationId, next)
          } else {
            try {
              await projectAuthoritative(mapping, captured)
            } catch {
              // A refresh failure leaves the existing projection untouched. Re-check the epoch
              // below so a wallet switch is still silent rather than becoming a stale error toast.
            }
          }
          assertCurrent(captured)
          onError(error, allocationId)
        } catch {
          // A stale account owns none of the next account's recovery UI.
        }
        throw error
      } finally {
        pending.delete(allocationId)
        try {
          assertCurrent(captured)
          onPending(allocationId, false)
        } catch {
          // installActiveWalletAccount clears the old owner's pending surface atomically.
        }
      }
    },
  }
}

// Final review, Fix 2: the cached envelope's SHAPE, not just its data, can go stale across a
// deploy. A pre-Task-10 cache stamped `discovery.agents[].baseChildren` nowhere at all; under the
// current `sourceUnknown = discovery?.status !== 'complete'` predicate (readOwnerMoney.js:635) a
// `status:'complete'` cache like that reads as a POSITIVELY CONFIRMED EMPTY Base source rather
// than an unread one, and Fix 1 just wired that field to the rendered headline total for the first
// time. Bump this whenever a landed task changes what a cached `discovery`/`money` row is allowed
// to look like; a reader that doesn't recognize the stamped version treats the whole cache as a
// miss (never partially trusts it) and falls back to a live read instead.
const MONEY_CACHE_SCHEMA_VERSION = 2

export function loadMoneyCache(owner) {
  if (!owner) return {}
  try {
    const parsed = JSON.parse(localStorage.getItem(moneyCacheKey(owner)) || '{}') || {}
    return parsed.__schemaVersion === MONEY_CACHE_SCHEMA_VERSION ? parsed : {}
  } catch {
    return {}
  }
}

/** Persist the {money, discovery, protection} cache for `owner`. Safe to call with an empty object. */
export function saveMoneyCache(owner, cache) {
  if (!owner) return
  try {
    localStorage.setItem(
      moneyCacheKey(owner),
      JSON.stringify({ ...(cache || {}), __schemaVersion: MONEY_CACHE_SCHEMA_VERSION })
    )
  } catch {
    // localStorage unavailable/full — non-fatal, the in-memory cache ref still serves this session.
  }
}

/**
 * Assemble the MoneySnapshot shape myMoneyModel.js documents (its own header JSDoc) from a raw
 * readOwnerMoney() envelope — the exact `{ ...aggregateOwnerPositions(reads), agents, checkedAt,
 * confirmedLedger, confirmedBlock, source }` shape buildMyMoneyModel's caller is responsible for
 * assembling. Pure; never re-fetches.
 */
export function buildMoneySnapshot(reads) {
  if (!reads) return null
  return {
    ...aggregateOwnerPositions(reads),
    agents: reads.agents ?? [],
    checkedAt: reads.checkedAt ?? null,
    confirmedLedger: reads.confirmedLedger ?? null,
    confirmedBlock: reads.confirmedBlock ?? null,
    source: reads.source ?? null,
  }
}

/**
 * Wallet-switch identity guard (brief Step 2, hazard 1): a resolved fetch is only safe to commit
 * if the owner it was fetched FOR still matches the owner currently connected — a wallet switch
 * mid-flight must never let the PRIOR owner's discovery/money/risk journal repaint over the new
 * owner's (or a disconnect's) state.
 */
export function isMoneyFetchForCurrentOwner({ fetchOwner, currentOwner }) {
  return Boolean(fetchOwner) && fetchOwner === currentOwner
}

/**
 * Post-action revision guard (brief Step 2, hazard 3): reuses freshness.js's own monotonic
 * reconciliation token — the SAME primitive money/ownerActions.js's reconcileOwnerAction already
 * uses for the identical hazard — so a read that STARTED before a mutating action
 * (withdraw/revoke/recovery) resolved can never repaint the model over the action's own fresher
 * reconciliation.
 *
 * Both guards are collapsed into ONE decision here (rather than checked separately at each call
 * site) so there is exactly one place that can get this wrong, and exactly one place mutation
 * testing has to prove right.
 */
export function shouldCommitMoneyFetch({ fetchOwner, currentOwner, readToken, currentToken }) {
  return (
    isMoneyFetchForCurrentOwner({ fetchOwner, currentOwner }) &&
    isReconciliationCurrent({ readToken, currentToken })
  )
}

/**
 * Read-only: discovery -> money -> assembled snapshot for `owner`. No submit/sign/write seam
 * exists on this function's signature at all — a reload/reconnect that calls this can, by
 * construction, never replay a transaction (brief Step 2, hazard 2). Injectable seams mirror
 * ownerDiscovery.js/readOwnerMoney.js's own convention (tests never touch the real network).
 */
export async function fetchMyMoneySnapshot({
  owner,
  now = Date.now(),
  discoverScopes = discoverOwnerScopes,
  readMoney = readOwnerMoney,
}) {
  const discovery = await discoverScopes({ owner })
  const reads = await readMoney({ owner, discovery, now })
  return { discovery, money: buildMoneySnapshot(reads) }
}

/**
 * Fix loop 1, I1: the exact guard-then-commit sequence `refreshMoney` runs in production, factored
 * out to a plain exported function so a controller-level test can inject a slow `fetchSnapshot` and
 * mutate `currentOwnerRef`/`revisionRef` OUT FROM UNDER IT mid-flight — proving THIS call site
 * keeps wiring LIVE ref values into `shouldCommitMoneyFetch`. The pure-function tests above already
 * prove `shouldCommitMoneyFetch` is correct in isolation in both directions; the reviewer proved by
 * mutation (replacing `currentOwner: currentOwnerRef.current` / `currentToken: revisionRef.current`
 * with the tautological `currentOwner: owner` / `currentToken: readToken`) that nothing verified the
 * CALLER still passed it live values — the whole 181-test suite stayed green. `refreshMoney` below
 * is a thin wrapper with no guard logic of its own left to drift out of sync with this.
 * @param {{owner: string, now: number, fetchSnapshot: Function, currentOwnerRef: {current},
 *   revisionRef: {current}, onCommit: Function}} p
 * @returns {Promise<boolean>} whether onCommit ran
 */
export async function guardedMoneyFetch({
  owner,
  now,
  fetchSnapshot,
  currentOwnerRef,
  revisionRef,
  onCommit,
}) {
  const readToken = nextReconciliationToken(revisionRef.current)
  revisionRef.current = readToken
  let snapshot
  try {
    snapshot = await fetchSnapshot({ owner, now })
  } catch {
    return false // a failed read leaves the last-good state in place; buildMyMoneyModel's own cache
    // fallback (still fed from moneyCacheRef) is what downgrades it to stale over time.
  }
  if (
    !shouldCommitMoneyFetch({
      fetchOwner: owner,
      currentOwner: currentOwnerRef.current,
      readToken,
      currentToken: revisionRef.current,
    })
  ) {
    return false
  }
  onCommit(snapshot)
  return true
}

/**
 * Fix round 1 (I1, MM13 M5 blind spot): hoists the argument object `refreshMoney` builds into a
 * single exported, identity-preserving function, rather than an inline object literal duplicated
 * at the one real call site. Proves ONLY that whatever refs it is handed pass through to
 * `guardedMoneyFetch` untouched (`Object.is`, not just deep equality) -- it cannot, on its own,
 * prove `refreshMoney` hands it the REAL `realAddressRef`/`moneyRevisionRef`: those are per-render
 * React refs with ~10 other read/write sites throughout this component (wallet-switch sync, five
 * separate action handlers bumping the revision), so forcing them to module scope purely to make
 * that provable without ever reading source would be a much larger, riskier refactor of this
 * file's state ownership than a test-robustness fix warrants. The one remaining line at the real
 * call site is covered by the comment-stripped, negative-matching source-scan immediately below
 * instead (see the REFRESH-MONEY-WIRING markers) -- ~app.money.test.jsx has both tests.
 * @param {string} owner
 * @param {{currentOwnerRef: {current}, revisionRef: {current}, fetchSnapshot?: Function}} refs
 */
export function moneyFetchArgs(
  owner,
  { currentOwnerRef, revisionRef, fetchSnapshot = fetchMyMoneySnapshot }
) {
  return { owner, now: Date.now(), fetchSnapshot, currentOwnerRef, revisionRef }
}

// Task 10, carried finding C1: classifyKeeperAutomation (money/automationEvidence.js:18,33) only
// counts events shaped {type: 'compound'|'rebalance', closedAt: <ms>} — but this file's own keeper
// event producer (below, `keeperActivity`/`setKeeperActivity`) stores items shaped
// {kind: 'compound_executed'|'rebalance_executed', timestamp: <ms>, closedAt: <ms|undefined>}.
// Unadapted, the HEARTBEAT_TYPES filter matches nothing and `moneyKeeper.label` pins to
// 'unavailable' forever.
//
// Fix round 1 (reviewer C1-FIX): this adapter used to map `closedAt: e.timestamp` -- but
// `timestamp` is `Date.now()` stamped when the poll loop first SAW the event (read time), while
// automationEvidence.js:21-23 documents the real contract in as many words: "carries a real
// ledger-close-derived closedAt, never a Date.now() stamped at read time". That was worse than
// the bug it replaced: `keeperLedgerRef` starts `undefined` (below), so the first poll after every
// page load falls back to an ~8000-ledger/~11h lookback window (keeperEvents.js's own
// DEFAULT_LOOKBACK_LEDGERS), and every historical compound/rebalance in it would have been
// stamped "now" -- reading 'healthy' for up to 35 minutes after load even if the keeper cron died
// half a day ago. The producer below now carries the REAL ledger-close time as its own `closedAt`
// (keeperEvents.js's `decodeKeeperEvent` already decodes `ledgerClosedAt` for exactly this), so
// this adapter reads that field instead -- an event whose record had no `ledgerClosedAt` degrades
// to `undefined` here, which classifyKeeperAutomation's own `Number.isFinite` filter already drops
// (-> 'unavailable', an honest gap, never a manufactured 'healthy').
//
// Adapted at THIS call site only — automationEvidence.js is shared by the My Money route and
// stays untouched (frozen-system constraint); `keeperActivity` itself keeps carrying BOTH
// `timestamp` (CrewActivity.jsx's own "x ago" display, which legitimately wants read-recency) and
// `closedAt` (this adapter's freshness evidence) — two different questions, two different fields.
const KEEPER_HEARTBEAT_KIND_TO_TYPE = {
  compound_executed: 'compound',
  rebalance_executed: 'rebalance',
}
export function toKeeperHeartbeatEvents(keeperActivity) {
  return (keeperActivity || [])
    .filter((e) => e && KEEPER_HEARTBEAT_KIND_TO_TYPE[e.kind])
    .map((e) => ({ ...e, type: KEEPER_HEARTBEAT_KIND_TO_TYPE[e.kind], closedAt: e.closedAt }))
}

/**
 * My Money Task 13 Part B item 5: is any NON-revoked agent still live for `vaultAddress` in `rows`
 * (rehydrateScopes()'s own plain-scope shape -- {agent, vault, revoked}, NOT an OwnerDiscoveryV1
 * envelope)? Extracted from the withdraw-success scope-catch-up poll below, whose termination
 * condition this is: "has the post-sweep on-chain revoke landed on RPC yet". Deliberately NOT
 * `pickRecoverableVaultAgents` (the discovery-based replacement for the deleted `pickVaultAgents`)
 * -- that picker expects a completely different shape (`.address`, not `.agent`; no `.kind`) built
 * for a different question ("who must a sweep target", inclusive of revoked-but-funded agents),
 * and forcing `rows` through it would silently return every row's `.address` as `undefined`.
 */
export function hasLiveScopeForVault(rows, vaultAddress) {
  const want = (vaultAddress || '').toLowerCase()
  if (!want) return false
  return (rows || []).some(
    (s) => s && !s.revoked && s.agent && (s.vault || '').toLowerCase() === want
  )
}

// Task 5 chunk C -- compose the final permissionDecision. `proveReusablePermission`'s own return
// (`raw.version === 3`) carries NONE of `planFingerprint`/`reviewedBudgets`/`reviewedAgentInits`
// (see permissionGrantV3.js's base object) -- but `dispatchPermissioned`'s entry checks
// (`assertPermissionMatchesPlan` + the canonical reviewed-budget check, orchestrator.js, both
// unconditional on mode) require all three on EVERY permissionDecision or throw
// `VF_PLAN_FINGERPRINT_MISMATCH` before any dispatch code runs. This merges the SAME
// `planFingerprint`/`reviewedBudgets`/`agentInits` `onRetryPreflight` already built to CALL
// `preflightPermission` onto its result -- mirroring exactly what reusePreflight.js's own
// (V2-only) `baseDecision` already assembles internally from the same three inputs. `agentInits`
// (`planAgentToAgentInit`'s own shape: allocationId, kind, token, target, cap{token,units,decimals},
// periodSeconds, expiry, plus mintRecipient/destinationDomain) already matches what
// `assertPermissionMatchesPlan` structurally checks a `reviewedAgentInits[i]` against -- no
// separate projection needed, and unlike V2's own `reviewedAgentInits` this carries no
// signer/salt material to leak (V3's agentInits never had any to begin with). Identity return for
// a V2 decision (`raw.version !== 3`): reusePreflight.js already carries all three there, so this
// is a no-op on that path.
// Inert under dormancy: `preflightPermission`'s default `resolveSchema` (`resolveRouterSchema`)
// resolves no V3 address today, so `raw.version` is never 3 in production -- this is forward
// wiring for the day a V3 router is registered, not a reachable path now.
// `checkedAt` mirrors V2's own `baseDecision.checkedAt` (reusePreflight.js's `nowSec`) -- the
// prover carries no timestamp of its own, and ProtectStage's V3 review renders an "As of"
// freshness stamp exactly like V2's does. Captured at the moment this check resolves, the same
// point V2's own timestamp is taken.
export function composeV3Decision(raw, { plan, reviewedBudgets, agentInits }) {
  if (raw.version !== 3) return raw
  return {
    ...raw,
    planFingerprint: plan.planFingerprint,
    reviewedBudgets,
    reviewedAgentInits: agentInits,
    checkedAt: Math.floor(Date.now() / 1000),
  }
}

/* ---------- App ---------- */
const App = () => {
  const devMode = isDevMode()
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS)
  const normalizedTheme = normalizeTheme(tweaks.palette)

  // stage: 'strategy' | 'connect' | 'skills' | 'permission' | 'execute' | 'done'
  const [stage, setStage] = useS('strategy')
  const [furthest, setFurthest] = useS(0) // furthest step index reached → rail can navigate to visited steps
  const navigate = useNavigate()
  const location = useLocation()
  const [language, setLanguage] = useS(() => loadSettings().language) // UI i18n (labels only)
  const [amount, setAmount] = useS('100')
  const [risk, setRisk] = useS('med')
  const [devApiKey, setDevApiKey] = useS('')

  const [strategy, setStrategy] = useS(null)
  const [council, setCouncil] = useS(undefined) // undefined = no strategy yet, null = deliberating
  const [councilRetry, setCouncilRetry] = useS(0) // bump to re-run deliberation
  const councilCitedRef = useR({ citedRules: [], verdict: null })
  const [debateResult, setDebateResult] = useS(null) // debate council result
  const [debateRunning, setDebateRunning] = useS(false) // debate in progress

  // My Money Task 13 Part B: `monitorStatus`/`monitorTimerRef` (the council re-eval loop's own
  // display state) had no reader anywhere in this file -- OpsConsole's own MonitorPanel was the
  // only consumer, and it is retired from every production route. The monitor LOOP itself
  // (runCouncilMonitorCheck below, and the `market_signal` branch in handleAgentEvent) keeps
  // running and doing its real work (fastReeval/councilDebate/saveSnapshot/addLog) -- only the
  // now-unread status snapshot is removed, not the automation it was reporting on.
  const [skillSource, setSkillSource] = useS('default')
  const [settingUpBaseMandate, setSettingUpBaseMandate] = useS(false)
  const [baseMandateError, setBaseMandateError] = useS(null)
  const [marketLive, setMarketLive] = useS(null) // Tavily live market context used? null until first generation
  const [vaultLive, setVaultLive] = useS(null) // DeFiLlama live vault data used? null until first generation
  const [skillDrawerOpen, setSkillDrawerOpen] = useS(false)

  const [connectPhase, setConnectPhase] = useS('idle')
  const [connectError, setConnectError] = useS(null)

  // skills
  const [skillStates, setSkillStates] = useS({})

  const [permActive, setPermActive] = useS(false)
  // Per-agent on-chain scopes (single-source summary + Revoke). Keyed by worker agent address.
  const [scopes, setScopes] = useS([])
  const [permExpiresAt, setPermExpiresAt] = useS(null)

  // ===== Strategy Task 13 (Pocket Crew redesign, Wave 5) — Plan/Protect/Start integration =====
  // The production `/strategy` route's state machine. `strategyFlowReducer` (flowState.js) is
  // Foundation-owned and pure; the wrapper below adds exactly ONE app-local event, 'STRATEGY_RESET'
  // (start a brand new run), which flowState.js's own authorized-edit scope (decision log #22)
  // does not cover — resetting to `initialStrategyFlowState` is an app.jsx integration concern,
  // not a reducer invariant.
  const [strategyFlow, dispatchFlow] = useRed((state, event) => {
    if (event.type === 'STRATEGY_RESET') return initialStrategyFlowState
    return strategyFlowReducer(state, event)
  }, initialStrategyFlowState)
  const strategyFlowRef = useR(strategyFlow)
  strategyFlowRef.current = strategyFlow
  const [strategyReached, setStrategyReached] = useS(['plan'])
  const [runId, setRunId] = useS(() => `run-${Date.now()}`)
  // Base availability for the Plan surface — CONSUMED by PlanStage as the `base` prop, never
  // re-derived there (PlanStage.jsx's own header comment). Refreshed on connect and after the
  // 1-tap mandate setup ceremony.
  const [baseView, setBaseView] = useS({
    connected: false,
    healthy: null,
    mandateView: null,
    action: null,
  })
  // PlanStage's amount-validation gate (strategy/amountValidation.js) needs the vault's real total
  // share supply (null while unknown -- distinct from 0n, a genuine first-deposit state).
  const [vaultTotalShares, setVaultTotalShares] = useS(null)
  useE(() => {
    let alive = true
    readTotalShares()
      .then((shares) => {
        if (alive) setVaultTotalShares(shares)
      })
      .catch(() => {
        if (alive) setVaultTotalShares(null)
      })
    return () => {
      alive = false
    }
  }, [])
  const baseSetupSucceededRef = useR(false)
  // Raw orchestrator/worker/bridge events for THIS run, in arrival order — StartStage's own pure
  // lane-phase adapters (depositLanePhase/bridgeLanePhase) fold these; never cleared mid-run.
  const [runEvents, setRunEvents] = useS([])
  const [runReceipt, setRunReceipt] = useS(null)
  const [recoveryByAllocation, setRecoveryByAllocation] = useS({})
  const recoveryByAllocationRef = useR(recoveryByAllocation)
  recoveryByAllocationRef.current = recoveryByAllocation
  const [recoveryPendingAllocations, setRecoveryPendingAllocations] = useS(() => new Set())
  const recoveryMappingsRef = useR(new Map())
  const recoveryRunnerRef = useR(null)
  const recoveryLeaseOwnerRef = useR(
    `vf-recovery-${globalThis.crypto?.randomUUID?.() || Date.now()}`
  )
  // In-flight onRequestGrant/onConfirmReuse promise settlers — resolved by the shared orchestrator
  // event handler the instant 'grant-confirmed'/'reuse-confirmed' fires (ProtectStage must resolve
  // BEFORE the whole run settles, since Start renders live while dispatch continues in the
  // background), rejected if the underlying dispatch promise rejects first.
  const pendingConfirmRef = useR(null)

  // True when a refresh re-entered an active session (drives the Home banner).
  const [sessionResumed, setSessionResumed] = useS(false)

  // Wallet reconnect + session resume on page load. Without this, a refresh drops
  // realAddress/stage/strategy (all in-memory) so the app looks logged-out and the monitor loop
  // never reboots even with an active vault. Resume the wallet kit's already-selected module
  // without opening its modal, installing the same complete epoch capability as an interactive
  // connect. If no wallet is selected yet, the catch leaves the app logged-out. Mount-only.
  useE(() => {
    window.triggerTestAlert = () => {
      handleAgentEvent({
        kind: 'risk_alert',
        severity: 'high',
        reason: 'drawdown_exceeded',
        vaultName: 'VFUSD Yield Vault',
        vaultAddress: 'CBZNITAPHCLSPEXC3UKIERYRUJR56GISM2G2Z5XD6KZH3U4ZZ76XNQOU',
        protocol: 'aave-v3',
        searchAnswer: 'Drawdown of aave-v3 (15.0%) exceeds your configured limit of 10.0%!',
        timestamp: Date.now(),
      })
    }

    let alive = true
    connectActiveAccount({ prompt: false })
      .then((account) => {
        if (!alive || !account) return
        const addr = installActiveWalletAccount(account).address
        setConnectPhase('connected')
        const snap = loadResume(addr)
        if (snap?.strategy?.agents?.length) {
          setStrategy(snap.strategy)
          if (snap.amount != null) setAmount(String(snap.amount))
          if (snap.risk) setRisk(snap.risk)
          setStage('done')
          setFurthest(STEPS.length - 1)
          setSessionResumed(true)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
      delete window.triggerTestAlert
    }
  }, [])

  // 30-second tick to refresh countdown displays
  const [, setClock] = useS(0)
  useE(() => {
    const id = setInterval(() => setClock((c) => c + 1), 30000)
    return () => clearInterval(id)
  }, [])

  // Prime live DeFiLlama numerics for the eligibility gate (fire-and-forget; the gate falls back
  // to the curated snapshot until it lands). Cached 6h in localStorage — ≤1 fetch burst/session.
  useE(() => {
    primeVaultFacts()
  }, [])

  // execution: map agentId -> { status, steps, hashes, memory, metrics }
  const [execMap, setExecMap] = useS({})
  const [openAgentId, setOpenAgentId] = useS(null)

  const [logs, setLogs] = useS([])
  const logIdRef = useR(0)
  const agentMapRef = useR({})
  // Latest agent list for reconcile (see positionsAgents below) — read by poll closures that
  // were captured before scopes finished rehydrating.
  const positionsAgentsRef = useR(undefined)
  // Agent addresses saved from the last orchestrator run (dev-branch discovery path) —
  // fallback source when scopes haven't rehydrated and localStorage cache is empty.
  const deployedAgentsRef = useR([])

  // Real Web3 state
  // Dev-only read-as override: /agent?as=G... opens the console with that address's chain
  // state (read paths only — signing still needs a real wallet). DEV builds only; the whole
  // branch is dead-code-eliminated in prod and scripts/assert-no-dev-dispatch.mjs asserts the
  // __vfDevViewAs marker never ships in dist/.
  const viewAsAddress = getViewAsAddress()
  // My Money Task 13's own discovery envelope, hoisted up from its controller block (below) --
  // Part B item 5's `positionsAgents` migration (immediately below) needs it this early, and a
  // `useState` call's textual position doesn't affect hook order/correctness as long as it fires
  // unconditionally every render, same as every other hook in this component.
  const [moneyDiscovery, setMoneyDiscovery] = useS(null)
  // Which agents' vault shares a "position" reads. Priority:
  //   view-as (dev) → the impersonated address's OWN shares;
  //   real run      → every agent this owner's discovery envelope has proven belongs to this
  //                   vault, where deposit mints the shares.
  // Falling back to reconcile's default (the fixed demo agent) is the bug that emptied the
  // positions card ~15s after a real run: the poll read demo-agent = 0 shares and pruned the
  // vault. Shares sum across agents; withdrawn/other-run agents read 0 and drop out harmlessly.
  //
  // My Money Task 13 Part B item 5: this used to read `pickPositionsAgents(scopes, viewAsAddress)`
  // -- deleted (positionsStore.js's own comment) because it silently dropped revoked-but-funded
  // agents, which the full-exit enumeration rule forbids: a revoked agent that still holds vault
  // shares is exactly the one this reconcile must keep summing, or NotificationCenter/
  // VaultDetailPage/handleEmergencyWithdraw (all fed by the `agentData.positions` this reconcile
  // builds) silently under-report the true position. `pickRecoverableVaultAgents` (My Money Task
  // 6's discovery-based replacement) never drops a revoked-but-funded candidate.
  // ponytail: N candidate agents = N readVaultShares per 15s poll; fine for a handful of runs,
  // revisit if an owner accumulates dozens of live grants.
  const positionsAgents = viewAsAddress
    ? [viewAsAddress]
    : pickRecoverableVaultAgents(moneyDiscovery, { vault: SOROBAN_ACTIVE_VAULT_ADDRESS })
  // Reconcile effects capture this closure keyed on realAddress, but discovery rehydrates async
  // AFTER connect. A latest-value ref lets the already-subscribed poll (and the cold-reconcile
  // that must not prune restored cache) read the current agent list without re-mounting.
  positionsAgentsRef.current = positionsAgents
  // Wall-clock of the last withdraw per vault (lowercased address). The worker 'position'
  // handler drops snapshots read at or before this — see the guard there for why.
  const lastWithdrawAtRef = useR({})
  // Monotonic token for scope rehydrates. Two call sites (connect effect, post-withdraw retry
  // loop) resolve in any order, and setScopes REPLACES — without this, a slow pre-withdraw
  // snapshot landing last would revive a just-swept agent as active. Newest request wins.
  const scopeGenRef = useR(0)

  const reconcilePositions = (addr) => {
    const agents = positionsAgentsRef.current
    return reconcilePositionsFromChain(addr, agents ? { agents } : undefined)
  }
  const [realAddress, setRealAddress] = useS(() => {
    if (import.meta.env.DEV && viewAsAddress)
      console.info('[dev] view-as read override active:', viewAsAddress)
    return viewAsAddress
  })
  const [activeAccount, setActiveAccount] = useS(null)
  const activeAccountRef = useR(activeAccount)
  activeAccountRef.current = activeAccount
  const activeOrchestrationRef = useR(null)
  const loopRef = useR(null)
  const latestGasRef = useR(null) // last live gas snapshot { level, gwei } for the monitor loop
  const hydratedRef = useR(null) // address whose cached positions have finished restoring
  // Ledger cursor for the vf-autofarm keeper event feed (Compound/Rebalance) — undefined until
  // the first successful fetch, after which it advances past every event we've already alerted
  // on so the same 15s poll never re-notifies for the same keeper action.
  const keeperLedgerRef = useR(undefined)
  // Tracks which user addresses have had session key setup done (survives re-renders).
  const [loopTick, setLoopTick] = useS(0)
  const [loopRestartTick, setLoopRestartTick] = useS(0) // incremented to force loop restart after discovery
  const [loopPhase, setLoopPhase] = useS(null) // live pipeline phase from monitorLoop onPhase
  const [veniceAuth, setVeniceAuth] = useS(null)
  const [onboarded, setOnboarded] = useS(() => localStorage.getItem('yv_onboarded') === 'true')
  const [skipLanding, setSkipLanding] = useS(
    () => localStorage.getItem('yv_skip_landing') === 'true'
  )

  // Synchronize localStorage flags on router pathname change to prevent
  // navigation locks from public pages back to strategy layout.
  useE(() => {
    const isSkip = localStorage.getItem('yv_skip_landing') === 'true'
    if (isSkip !== skipLanding) {
      setSkipLanding(isSkip)
    }
    const isOnboard = localStorage.getItem('yv_onboarded') === 'true'
    if (isOnboard !== onboarded) {
      setOnboarded(isOnboard)
    }
  }, [location.pathname])

  // Background agent
  const [agentEnabled, setAgentEnabled] = useS(
    () => localStorage.getItem('yv_agent_enabled') !== 'false'
  )
  const [agentSettings, setAgentSettings] = useS(loadAgentSettings)
  const [agentData, setAgentData] = useS({ positions: {}, alerts: [], lastUpdated: null })
  // vf-autofarm KeeperPanel state — populated by the SAME 15s poll that already fetches
  // keeper events below (keeperLedgerRef), never a second interval.
  const [keeperActivity, setKeeperActivity] = useS([]) // newest-first, capped — feeds KeeperPanel
  const [lifeboatState, setLifeboatState] = useS(null) // {derisked, mandateExpiry, authority} | null
  // My Money Task 13 Part B: `lifeboatActivity` (a second, derisk/resume/mandate-only activity
  // log) and `lifeboatBusy`/`rebalancePulse` (a mandate-grant spinner and a force-graph edge pulse)
  // are removed -- OpsConsole's LifeboatPanel/AgentGraph were their only readers, both retired.
  // derisk/resume/mandate events are now routed straight into the alert bell (see the keeper poll
  // below); the mandate-grant pending state is now `moneyActionPending` (handleMoneyPrimaryAction).
  const [autofarmReads, setAutofarmReads] = useS({ pricePerShare: null })
  // vf-base-dashboard Task 10 — read-only Base positions (own poll piggyback, see the 15s
  // sync() below). Stays [] for Stellar-only users; loadDeviceBasePositions never throws.
  const [basePositions, setBasePositions] = useS([])
  // Set only once the user actually clicks Withdraw on a Base position: { position,
  // ownerKernelAccount, publicClient } after the one-tap ensureBaseOwner login ceremony.
  const [baseWithdraw, setBaseWithdraw] = useS(null)
  const [baseWithdrawError, setBaseWithdrawError] = useS(null)

  // 2026-08-02 polish (audit items #10/#11): for a first-time user the shell used to open with an
  // icon-ONLY sidebar (labels rendered but opacity-hidden until the toggle was discovered) AND the
  // legacy right rail OPEN (jargon panels competing with the Pocket Crew route composition --
  // 2026-07-22 spec §13.1: no persistent right rail beside the current decision). New sessions now
  // default to labeled navigation and a collapsed rail; both toggles remain, and any explicitly
  // stored choice still wins (nothing here rewrites an existing preference).
  const [sbExtended, setSbExtended] = useS(() => localStorage.getItem('yv_sb_extended') !== 'false')
  const [railCollapsed, setRailCollapsed] = useS(
    () => localStorage.getItem('yv_rail_collapsed') !== 'false'
  )

  const toggleSb = () => {
    setSbExtended((prev) => {
      localStorage.setItem('yv_sb_extended', String(!prev))
      return !prev
    })
  }

  const toggleRail = () => {
    setRailCollapsed((prev) => {
      localStorage.setItem('yv_rail_collapsed', String(!prev))
      return !prev
    })
  }

  useE(() => {
    applyTheme(normalizedTheme)
    document.documentElement.dataset.density = tweaks.density
  }, [normalizedTheme, tweaks.density])

  // Redirect old hash URLs (bookmarks like /#/home → /home)
  useE(() => {
    if (window.location.hash?.startsWith('#/')) {
      const path = window.location.hash.replace('#', '')
      window.history.replaceState(null, '', path)
    }
  }, [])

  // Document title per route (resolveDocumentTitle mirrors this component's own render branch
  // order -- see appShellTitle.js).
  useE(() => {
    document.title = resolveDocumentTitle({
      pathname: location.pathname,
      skipLanding,
      realAddress,
      onboarded,
    })
  }, [location.pathname, skipLanding, realAddress, onboarded])

  // Record the furthest step reached so the rail can navigate to visited steps (and only those)
  useE(() => {
    setFurthest((f) =>
      Math.max(
        f,
        STEPS.findIndex((s) => s.id === stage)
      )
    )
  }, [stage])

  const paletteIsLight = isLightTheme(normalizedTheme)
  const speed = SPEED_MS[tweaks.speed] || SPEED_MS.medium

  const addLog = (entry) => {
    logIdRef.current += 1
    const uid = `${logIdRef.current}-${Date.now()}`
    setLogs((l) => [...l, { id: uid, time: nowT(), ...entry }])
  }

  /* ----- Background agent: persistence + lifecycle + handlers ----- */
  // Restore positions on connect (instant from cache) then reconcile against chain.
  // Fixes home resetting to "no positions" after reload/reconnect with same wallet.
  useE(() => {
    if (!realAddress || !activeAccount) return
    const captured = activeAccount
    const isCurrent = () => activeAccountRef.current === captured
    const restored = loadPersistedPositions(realAddress)
    if (isCurrent() && Object.keys(restored).length) {
      setAgentData((d) => ({ ...d, positions: { ...restored, ...d.positions } }))
    }
    // Mark hydrated after this render+effect flush (setTimeout 0), so the restored cache
    // is committed before the persist effect is allowed to write an empty map. Pre-hydration
    // empties stay skipped (anti-clobber); post-hydration empties = real withdraws → persist.
    let alive = true
    const hydrateTimer = setTimeout(() => {
      if (alive && isCurrent()) hydratedRef.current = realAddress
    }, 0)
    const persistedAgents = loadDeployedAgents(realAddress)
    ;(async () => {
      let agents = persistedAgents
      // No cached agents → discover from on-chain events.
      // Strategy: Registry first (fast, single call), then vault deposit event scan
      // (fallback for agents deployed with registryAuthorize=false, the default).
      if (!agents.length) {
        agents = await queryAgentsByOwner(realAddress).catch(() => [])
        if (!agents.length) {
          agents = await discoverAgentsFromHorizon(realAddress).catch(() => [])
        }
        if (!agents.length) {
          agents = await discoverAgentsFromVault(realAddress).catch(() => [])
        }
        if (!alive || !isCurrent()) return
        if (agents.length) {
          saveDeployedAgents(realAddress, agents)
          deployedAgentsRef.current = agents
        }
      }
      if (!alive || !isCurrent()) return
      // Prefer the scope-derived agent list (per-run grant agents — the authoritative
      // source once scopes rehydrate); discovered agents cover the fresh-browser case.
      const scopeAgents = positionsAgentsRef.current
      const useAgents = scopeAgents?.length ? scopeAgents : agents
      const chain = await reconcilePositionsFromChain(
        realAddress,
        useAgents.length ? { agents: useAgents } : undefined
      ).catch(() => null)
      if (!alive || !isCurrent() || !chain) return // null = no RPC / all reads failed → keep cache
      // Cold reconnect: cached positions are from a PRIOR session, so they're mined and
      // the chain is authoritative. applyChainPositions replaces balances and PRUNES any
      // vault the chain reports as '0' (withdrawn) — this is what heals a stale cached
      // balance that lingered after a withdraw. Failed reads stay absent (not '0'), so a
      // transient RPC error can't wipe a real position. The persist effect writes the result.
      setAgentData((d) => ({
        ...d,
        positions: applyChainPositions(d.positions, chain),
        lastUpdated: Date.now(),
      }))
    })()
    return () => {
      alive = false
      clearTimeout(hydrateTimer)
      hydratedRef.current = null
    }
  }, [realAddress, activeAccount])

  // Persist in-session position changes (deposits, withdraws). Pre-hydration empties are
  // skipped so a fresh-connect {} can't clobber the cached snapshot before restore runs.
  // Once hydrated, an empty map means a real withdraw emptied positions → MUST persist so
  // the cache clears; otherwise a stale balance restores on the next reload/reconnect.
  useE(() => {
    if (!realAddress) return
    const isEmpty = Object.keys(agentData.positions || {}).length === 0
    if (isEmpty && hydratedRef.current !== realAddress) return
    persistPositions(realAddress, agentData.positions)
  }, [agentData.positions, realAddress])

  // Position reconcile against Stellar. The autonomous deposit lands via the relayer
  // (no browser-visible depositor event to listen for, unlike the EVM log), so we poll
  // the agent's vault-share balance and apply it authoritatively. applyChainPositions
  // can lower a balance (after owner_withdraw) and prune a fully-swept vault. The worker
  // also emits a 'position' event on deposit — this is the cold-reconcile cross-check.
  useE(() => {
    if (!realAddress || !activeAccount) return
    let alive = true
    const captured = activeAccount
    const isCurrent = () => activeAccountRef.current === captured
    const sync = async () => {
      const startedAt = Date.now()
      // vf-base-dashboard Task 10 — piggybacks this SAME 15s poll (never a second interval).
      // loadDeviceBasePositions never throws (see its own guard/catch); [] for Stellar-only users.
      loadDeviceBasePositions({ stellarOwner: realAddress }).then((bp) => {
        if (alive && isCurrent()) setBasePositions(bp)
      })
      // Prefer the scope-derived agent list (per-run grant agents — kept fresh via
      // positionsAgentsRef); fall back to saved/discovered agents (fresh-browser case),
      // then to reconcilePositions' default (demo agent) when nothing is known.
      const scopeAgents = positionsAgentsRef.current
      let pollAgents = scopeAgents?.length
        ? scopeAgents
        : (() => {
            const stored = loadDeployedAgents(realAddress)
            return stored.length ? stored : deployedAgentsRef.current || []
          })()
      // Discover from on-chain events when no cached agent addresses.
      // Strategy: Registry first (fast, single call), then vault deposit event scan
      // (fallback for agents deployed with registryAuthorize=false, the default).
      if (!pollAgents.length) {
        let discovered = await queryAgentsByOwner(realAddress).catch(() => [])
        if (!discovered.length) {
          discovered = await discoverAgentsFromHorizon(realAddress).catch(() => [])
        }
        if (!discovered.length) {
          discovered = await discoverAgentsFromVault(realAddress).catch(() => [])
        }
        if (!alive || !isCurrent()) return
        if (discovered.length) {
          saveDeployedAgents(realAddress, discovered)
          deployedAgentsRef.current = discovered
          pollAgents = discovered
        }
      }
      const chain = await reconcilePositionsFromChain(
        realAddress,
        pollAgents.length ? { agents: pollAgents } : undefined
      ).catch(() => null)
      if (alive && isCurrent() && chain) {
        // A tick's reads can straddle a withdraw: dispatched before the sweep, resolved after
        // the withdraw's own reconcile corrected the vault — and applyChainPositions REPLACES,
        // so the stale snapshot would repaint the swept balance for a tick. While a vault's
        // withdraw is newer than this tick's start, that reconcile owns the key; skip it here.
        for (const k of Object.keys(chain)) {
          if ((lastWithdrawAtRef.current[k.toLowerCase()] || 0) >= startedAt) delete chain[k]
        }
        setAgentData((d) => ({
          ...d,
          positions: applyChainPositions(d.positions, chain),
          lastUpdated: Date.now(),
        }))
      }
      // vf-autofarm keeper event feed (Compound/Rebalance) — piggybacks this SAME 15s poll
      // rather than opening a second interval. keeperLedgerRef advances past every ledger
      // already alerted on, so a re-poll never re-notifies for the same keeper action.
      try {
        const events = await fetchKeeperEvents(
          SOROBAN_RPC_URL,
          SOROBAN_AUTOFARM_VAULT_ADDRESS,
          keeperLedgerRef.current
        )
        if (!alive || !isCurrent()) return
        // KeeperPanel activity feed — separate from the deduped/capped-at-8 alerts list above
        // (handleAgentEvent keeps only the LATEST of each kind for notifications; the panel
        // wants its own short history of real keeper actions).
        const newActivity = []
        for (const ev of events) {
          keeperLedgerRef.current = Math.max(keeperLedgerRef.current || 0, ev.ledger + 1)
          if (ev.type === 'compound') {
            const item = {
              id: `compound:${ev.ledger}`,
              kind: 'compound_executed',
              vaultName: 'Autofarm vault',
              totalGainUsdc: toDisplay(ev.totalGain).toFixed(2),
              pricePerShare: toDisplay(ev.pricePerShare).toFixed(4),
              txHash: ev.txHash,
              timestamp: Date.now(),
              // Task 10 C1-FIX: the real ledger-close time (keeperEvents.js's own `closedAt`,
              // decoded from `ledgerClosedAt` -- "the ONLY source for closedAt"), kept alongside
              // `timestamp` (read time, still used by CrewActivity.jsx's own "x ago" display) so
              // classifyKeeperAutomation can judge freshness from when the keeper actually acted,
              // not from whenever this poll happened to first see a historical event.
              closedAt: ev.closedAt,
            }
            handleAgentEvent(item)
            newActivity.push(item)
          } else if (ev.type === 'rebalance') {
            const item = {
              id: `rebalance:${ev.ledger}`,
              kind: 'rebalance_executed',
              vaultName: 'Autofarm vault',
              from: ev.from,
              to: ev.to,
              fromLabel: shortAddr(ev.from),
              toLabel: shortAddr(ev.to),
              amountUsdc: toDisplay(ev.amount).toFixed(2),
              txHash: ev.txHash,
              timestamp: Date.now(),
              closedAt: ev.closedAt, // Task 10 C1-FIX -- see the compound branch's comment above.
            }
            handleAgentEvent(item)
            newActivity.push(item)
          } else if (
            ev.type === 'derisk' ||
            ev.type === 'resume' ||
            ev.type === 'mandate' ||
            ev.type === 'upgrade_scheduled' ||
            ev.type === 'upgrade_executed' ||
            ev.type === 'upgrade_cancelled'
          ) {
            // My Money Task 13 Part B: derisk/resume/mandate used to feed a dedicated
            // `lifeboatActivity` log array, which had no reader once MyMoneyRoute replaced
            // OpsConsole's own LifeboatPanel -- VaultProtection/HowMoneyWorks (this task's own
            // classifyLifeboatAutomation) already surface the CURRENT protection state, but the
            // EVENT itself (an emergency de-risk is exactly the kind of action an owner must not
            // miss) would otherwise become fully invisible. Routed into the SAME generic alert-bell
            // path upgrade_scheduled/upgrade_executed/upgrade_cancelled already use below, rather
            // than a second, now-readerless log.
            handleAgentEvent({
              id: `${ev.type}:${ev.ledger}`,
              kind: `vault_${ev.type}`,
              vaultName: 'Autofarm vault',
              wasmHashHex: ev.wasmHashHex,
              eta: ev.eta,
              reasonCode: ev.reasonCode,
              drainedTotal: ev.drainedTotal,
              txHash: ev.txHash,
              timestamp: Date.now(),
            })
          }
        }
        if (newActivity.length) {
          setKeeperActivity((prev) => [...newActivity.reverse(), ...prev].slice(0, 20))
        }
      } catch (e) {
        // transient RPC failure — the next 15s tick retries
        console.warn('[app] keeper event read failed:', e)
      }
      // Live autofarm vault read for HowMoneyWorks' classifyStrategyConfiguration: price-per-share
      // only. My Money Task 13 Part B: this used to also fetch registered strategies + a
      // per-strategy Blend supply-APR estimate for the force-graph cluster below (buildAutofarmGraphData)
      // -- that graph had no reader once MyMoneyRoute replaced OpsConsole, so the strategies/APR
      // fetch is dropped too (it existed only to feed that graph; leaving it would mean an RPC call
      // every 15s for data nothing renders). Best-effort — a failed read leaves the panel showing
      // "--", never a fake number.
      try {
        const pps = await readPricePerShare(SOROBAN_AUTOFARM_VAULT_ADDRESS)
        if (alive && isCurrent()) {
          setAutofarmReads({ pricePerShare: pps == null ? null : toDisplay(pps).toFixed(4) })
        }
      } catch (e) {
        // transient RPC failure — the next 15s tick retries; panel keeps its last-known reads
        console.warn('[app] keeper vault read failed:', e)
      }
      // Lifeboat state (vf-lifeboat) — same 15s poll tick. readLifeboatState() never throws (it
      // already returns null on RPC failure internally); this catch is defensive only.
      try {
        const s = await readLifeboatState(SOROBAN_AUTOFARM_VAULT_ADDRESS)
        if (alive && isCurrent()) setLifeboatState(s)
      } catch {
        if (alive && isCurrent()) setLifeboatState(null)
      }
      // Council monitor — check market drift setiap 15s tick.
      if (
        alive &&
        isCurrent() &&
        agentSettings.riskMonitoring &&
        Object.keys(agentData.positions).length
      ) {
        try {
          const apyByVault = {}
          for (const addr of Object.keys(agentData.positions)) {
            const meta = VAULT_CATALOG.find((v) => v.addr.toLowerCase() === addr.toLowerCase())
            if (meta?.apy) apyByVault[addr] = meta.apy
          }
          await runCouncilMonitorCheck(agentSettings, apyByVault)
        } catch (e) {
          console.warn('[council] monitor check failed:', e)
        }
      }
    }
    sync() // once on connect
    // ponytail: 15s poll. A Soroban event subscription would make it instant if needed.
    const id = setInterval(sync, 15000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [realAddress, activeAccount])

  useE(() => {
    localStorage.setItem('yv_agent_enabled', String(agentEnabled))
  }, [agentEnabled])
  useE(() => {
    localStorage.setItem('yv_agent_settings', JSON.stringify(agentSettings))
  }, [agentSettings])
  // Push threshold changes live (no worker restart → avoids polling churn on each keystroke)
  useE(() => {
    updateAgentConfig({ thresholds: agentSettings })
  }, [agentSettings])

  const handleAgentEvent = (ev) => {
    if (loopRef.current) {
      if (ev.kind === 'harvest_ready') {
        loopRef.current.submitIdea({
          kind: 'harvest',
          vaultAddress: ev.vaultAddress,
          vaultName: ev.vaultName,
        })
      } else if (ev.kind === 'rebalance_proposal') {
        const from = VAULT_CATALOG.find((v) => v.name === ev.fromVault)
        const to = VAULT_CATALOG.find((v) => v.protocol === ev.toProtocol)
        if (from && to) {
          loopRef.current.submitIdea({
            kind: 'rebalance',
            fromVaultAddress: from.address,
            apyGain: Number(ev.apyGain),
            proposed: [{ address: to.address, allocation: 1, risk_tier: to.risk }],
            currentAllocations: [{ address: from.address, allocation: 1, risk_tier: from.risk }],
          })
        }
      }
    }

    if (ev.kind === 'position') {
      // A monitor read STARTED before a withdraw can be DELIVERED after it. mergePositions only
      // ever raises balances, so committing that snapshot resurrects the swept position as a
      // ghost balance — and the chain's later 0 can never lower it back down. Drop anything read
      // at or before the vault's last withdraw; the authoritative chain poll owns the truth.
      const sweptAt = lastWithdrawAtRef.current[(ev.vaultAddress || '').toLowerCase()]
      if (sweptAt && (ev.timestamp || 0) <= sweptAt) return
      setAgentData((d) => ({
        ...d,
        lastUpdated: ev.timestamp,
        positions: mergePositions(d.positions, {
          [ev.vaultAddress]: {
            vaultName: ev.vaultName,
            balance: ev.balance,
            unclaimedRewards: ev.unclaimedRewards,
          },
        }),
      }))
      return
    }
    if (ev.kind === 'market_signal') {
      const settings = loadSettings()
      if (!settings.monitorEnabled) return
      // 15s poll handles council monitor even without strategy (page refresh).
      // Only run the check here when a strategy exists (normal session flow).
      if (strategy?.agents?.length) {
        runCouncilMonitorCheck(settings, ev.apyByVault)
      }
      return
    }
    if (ev.kind === 'harvest_executed') {
      addLog({
        event: 'DepositExecuted',
        meta: `Auto-harvested ${ev.vaultName}. Transaction ${shortAddr(ev.txHash)}.`,
        txHash: ev.txHash,
        detail: `Auto-harvest claimed rewards from ${ev.vaultName}.`,
      })
      setAgentData((d) => ({
        ...d,
        alerts: d.alerts.filter(
          (a) => !(a.kind === 'harvest_ready' && a.vaultAddress === ev.vaultAddress)
        ),
      }))
      return
    }
    // Alert kinds — dedupe by kind+vault, newest first, cap at 8
    const key = `${ev.kind}:${ev.vaultAddress || ev.vaultName || ''}`
    const id = `${key}:${ev.timestamp || Date.now()}`
    const isNew = !agentData.alerts.some(
      (a) => `${a.kind}:${a.vaultAddress || a.vaultName || ''}` === key
    )
    setAgentData((d) => ({
      ...d,
      alerts: [
        { id, ...ev },
        ...d.alerts.filter((a) => `${a.kind}:${a.vaultAddress || a.vaultName || ''}` !== key),
      ].slice(0, 8),
    }))
    if (isNew) {
      sendPushNotification(ev, agentSettings)
    }
    const detail =
      ev.kind === 'rebalance_proposal'
        ? `Venice AI flagged ${ev.toProtocol} at ${ev.toApy}% vs your ${ev.fromVault} at ${ev.fromApy}%, capture +${ev.apyGain}% by rebalancing.`
        : ev.kind === 'risk_alert'
          ? `Severity ${ev.severity}, classified by Venice AI. Signal on ${ev.vaultName}. Action: alert surfaced, awaiting your decision.`
          : ev.kind === 'apy_drift'
            ? `APY on ${ev.vaultName} dropped to ${ev.currentApy}% (from ${ev.baselineApy}%, ${ev.driftPct}%).`
            : ev.kind === 'harvest_ready'
              ? `${ev.rewardsUsdc} USDC accrued on ${ev.vaultName}, ready to claim.`
              : ev.kind === 'compound_executed'
                ? `Keeper compounded ${ev.vaultName}, +${ev.totalGainUsdc} USDC, price/share ${ev.pricePerShare}.`
                : ev.kind === 'rebalance_executed'
                  ? `Keeper rebalanced ${ev.vaultName}, ${ev.fromLabel} → ${ev.toLabel}, ${ev.amountUsdc} USDC moved.`
                  : ''
    addLog({
      event:
        ev.kind === 'risk_alert'
          ? 'AgentFailed'
          : ev.kind === 'compound_executed'
            ? 'AgentCompleted'
            : ev.kind === 'rebalance_executed'
              ? 'RedelegationCreated'
              : 'OrchestratorPlanned',
      meta: `${ev.kind.replace(/_/g, ' ')}, ${ev.vaultName || ev.fromVault || ''}${ev.txHash ? `, tx ${shortAddr(ev.txHash)}` : ''}`,
      txHash: ev.txHash,
      detail,
    })
  }

  // Start when positions exist (cached from a previous deposit) OR stage is 'done' (just finished
  // a strategy). Stops on disable / disconnect. Page refresh resets stage → 'strategy' but the
  // positions cache (loadPersistedPositions) restores the active vault list, so we check that.
  useE(() => {
    if (!agentEnabled || !realAddress) return
    const hasPositions = Object.keys(agentData.positions).length > 0
    if (!hasPositions && stage !== 'done') return
    upsertSeeds() // ACE: install seed rules + fold any legacy counters once
    // Monitor EVERY held position (accumulated across deposits), not just the latest
    // strategy — otherwise a new deposit would stop the agent watching earlier vaults.
    let activeVaults = buildActiveVaults(agentData.positions, strategy)
    if (!activeVaults.length)
      activeVaults = (strategy?.agents || []).map((a) => ({
        address: a.vault.addr,
        name: a.vault.name,
        protocol: a.vault.protocol,
        depositApy: Number(a.vault.apy),
      }))
    // Orphan positions (vault matches neither the current strategy nor VAULT_CATALOG) on cold
    // boot with strategy still null — nothing resolvable to monitor, so bail before starting.
    if (!activeVaults.length) return
    // v2: the depositor is deposit-only and the MockVault is plain ERC-4626 — there is no
    // on-chain harvest, so no server-wallet session-key setup. The monitor loop observes +
    // proposes; any execution (withdraw/revoke) is a user-signed tx initiated from the UI.

    startBackgroundAgent({
      userAddress: realAddress,
      activeVaults,
      // Tavily key no longer passed to client — risk scan routes through /api/search proxy.
      supportedProtocols: ['aave-v3', 'morpho-blue', 'spark', 'fluid'],
      thresholds: { ...agentSettings, autoHarvest: false },
    })
    const unsub = onAgentEvent(handleAgentEvent)
    addLog({ event: 'OrchestratorPlanned', meta: 'Background monitoring started.' })

    // ── Autonomous monitor loop — NEVER-STOP spine + TradingAgents council ──
    const loop = createMonitorLoop({
      getState: async () =>
        buildStrategyState({
          amountUsdc: Number(amount) || 0,
          riskLevel: risk,
          numVaults: strategy?.agents?.length || Object.keys(agentData.positions).length || 1,
          vaultData: VAULT_CATALOG,
          marketContext: marketLive,
          positions: agentData.positions,
          gas: latestGasRef.current,
          maxDrawdownPct: agentSettings.maxDrawdownPct,
        }),
      runGates: (proposed, state) => enforceActionSpace(proposed, state),
      gates: (state, idea) => evaluateGates(state, idea),
      simulate: (allocations, state) => scoreReward(allocations, state),
      council: (input) =>
        councilVerdict(input, {
          weight: playbookWeight,
          resolveConflict: resolveCouncilConflict,
        }),
      execute: async (idea) => {
        // v2 is observe + propose only. The deposit-only depositor + plain ERC-4626 vault
        // have no relayer harvest/rebalance path, so the loop never moves funds autonomously.
        // Surface the proposal; the user acts via the UI (user-signed withdraw / revoke).
        addLog({
          event: 'OrchestratorPlanned',
          meta: `Proposal: ${idea.kind} ${idea.vaultName || idea.fromVault || ''}`.trim(),
        })
        return null
      },
      reflect: (cycle) => reflect(cycle, { increment: playbookIncrement }),
      curate: (ctx) => {
        // One Venice call → {role, text} delta. Fire-and-forget; proposeRule swallows failures.
        const ask = async (c) => {
          try {
            const sys =
              'You are the Curator of a DeFi yield-farming AI Council playbook. Given a notable cycle outcome, propose ONE concise, generalizable rule for the named role that would have prevented the failure or resolved the disagreement. Output JSON ONLY: {"role":"yield|risk|market","text":"..."}.'
            const user = `Role: ${c.role}\nOutcome: ${c.outcome}\nResolved by: ${c.resolvedBy || 'n/a'}\nReason: ${c.reason || 'n/a'}\nRegime: ${c.turbulence || 'n/a'}\nCited rules: ${(c.citedRules || []).join(', ') || 'none'}\n\nPropose one new rule as JSON.`
            const out = await askStrategistJson({ system: sys, user, devApiKey: devApiKey || null })
            return out && out.role && out.text ? { role: out.role, text: String(out.text) } : null
          } catch {
            return null
          }
        }
        proposeRule(ctx, { ask, store: { getRules, addRule, replaceAll } })
      },
      journal: {
        saveCycle: (row) => {
          saveCycle(row)
          setLoopTick((t) => t + 1)
        },
      },
      recordDecision: (ctx) => {
        recordDecision(ctx)
        setLoopTick((t) => t + 1)
      },
      heartbeatMs: 120000, // 2 min — testing; TODO: agentSettings.apyInterval * 60 * 1000
      onPhase: (p) => setLoopPhase(p === 'sleep' ? null : p),
    })
    loopRef.current = loop
    loop.start()
    console.log('[app] monitor loop started — heartbeat', loop.getHeartbeatMs(), 'ms')

    return () => {
      unsub()
      stopBackgroundAgent()
      loop.stop()
      loopRef.current = null
      setLoopPhase(null)
    }
  }, [stage, agentEnabled, realAddress, strategy, loopRestartTick])

  // Restart loop when positions appear after on-chain discovery (page refresh scenario).
  // The main loop effect skips when positions are empty; this catches the transition.
  useE(() => {
    if (!agentEnabled || !realAddress) return
    const hasPositions = Object.keys(agentData.positions).length > 0
    if (!hasPositions) return
    if (loopRef.current?.isRunning()) return
    setLoopRestartTick((t) => t + 1)
  }, [agentData.positions, agentEnabled, realAddress])

  // The browser-driven autonomous Auto-Exit monitor loop (a 15s polling effect) that used to live
  // here has been removed — risk watch is observe-only (money/riskWatchStore.js) and no legacy
  // local rule may autonomously move production funds. Any leftover yv_exit_rules_*,
  // yv_last_exit_trip_*, yv_exit_key_*, or vf_exit_inflight_* browser data from that removed
  // feature is inspected (never auto-deleted) by money/legacyAutoExit.js, surfaced under Settings
  // → Data & Privacy → "Legacy auto-exit data" (components/settings/LegacyAutoExitCleanup.jsx).
  // Manual partial withdrawal is unaffected — it goes through stellar/partialWithdraw.js and the
  // owner-scoped v2 exit-key namespace, which this removal never touches.

  // Persist a resume snapshot whenever the user is in an active ('done') session, so a
  // refresh can re-enter it (the mount effect reads this back). Only 'done' sessions —
  // an in-progress wizard isn't worth resuming and would jump the user past their steps.
  useE(() => {
    if (!realAddress) return
    if (stage === 'done' && strategy?.agents?.length) {
      saveResume(realAddress, { stage, amount, risk, strategy })
    }
  }, [stage, strategy, realAddress, amount, risk])

  const dismissAlert = (id) =>
    setAgentData((d) => ({ ...d, alerts: d.alerts.filter((a) => a.id !== id) }))

  // Monte Carlo "alternate futures" for the proposed allocation. Recomputes only when
  // the strategy / inputs change. Uses the SAME live signals shown in the review panel —
  // turbulence regime (mdpState) + live gas — so the distribution reflects real context.
  const simulation = useM(() => {
    if (!strategy?.agents?.length) return null
    const state = buildStrategyState({
      amountUsdc: Number(amount) || 0,
      riskLevel: risk,
      numVaults: strategy.agents.length,
      vaultData: VAULT_CATALOG,
      marketContext: marketLive,
      positions: agentData.positions,
      gas: latestGasRef.current,
    })
    return runSimulation(allocationsFromStrategy(strategy), state, {
      runs: 200,
      horizonDays: 30,
      seed: 1,
      context: {
        turbulence: strategy.mdpState?.turbulence || state.market.turbulence,
        apyTrendPct: 0,
        gasGwei: latestGasRef.current?.gwei || null,
      },
    })
  }, [strategy, amount, risk])

  // F8 Enforcement-A view-model: per-protocol eligibility verdicts for the approval card. Pure +
  // snapshot-backed (no live call). The fused sentence anchors on the first survivor.
  const eligibility = useM(() => {
    if (!strategy?.agents) return null
    const { verdictBySlug, survivors } = computeBasket(strategy.agents)
    const firstSurvivor = survivors[0]
    // Keyed by slugFor (factSlug || protocol) — SAME function computeBasket used to populate
    // verdictBySlug. Indexing by bare a.vault.protocol here would look up the wrong verdict (or
    // none) for any base vault once factSlug disambiguates aave-v3/morpho-blue from their Base
    // counterparts, crashing buildEligibilitySentence/vaultEligibilityLabel on an undefined verdict.
    const fusedSentence = firstSurvivor
      ? buildEligibilitySentence(verdictBySlug[slugFor(firstSurvivor)], {
          targetMaxLossPct: 5,
          protocolLabel:
            SNAPSHOT[slugFor(firstSurvivor)]?.meta?.label || firstSurvivor.vault.protocol,
        })
      : null
    const rows = strategy.agents.map((a) => {
      const slug = slugFor(a)
      const v = verdictBySlug[slug]
      const asOf = new Date(SNAPSHOT[slug]?.facts?.tvl?.asOf || 0).toISOString().slice(0, 10)
      return {
        id: a.id,
        eligible: !!v?.eligible,
        isFixture: !!v?.isFixture,
        protocolLabel: SNAPSHOT[slug]?.meta?.label || a.vault.protocol,
        label: vaultEligibilityLabel(v),
        mainnetLine: `Protocol credibility: ${SNAPSHOT[slug]?.meta?.label || a.vault.protocol}. Audited, TVL from snapshot`,
        testnetLine: 'This deposit: testnet. APR illustrative; realized yield may be ~0',
        asOf,
      }
    })
    return { fusedSentence, rows }
  }, [strategy])

  // Auto-run legacy council when strategy becomes ready (backward compat) — async (3 parallel
  // AI calls + possible synthesis call) so it runs as an effect, not a useMemo. Uses the SAME
  // live signals as the simulation panel. AI-only: each specialist retries once; if the provider
  // still fails, the council reports 'unavailable' and the panel offers a retry — no fabricated
  // verdict. (The manual debate-council retry this comment used to point at, `handleRunCouncil`,
  // was only ever wired to the old ceremony's StrategyCard button and was deleted in fix loop 1.)
  useE(() => {
    if (!strategy?.agents?.length) {
      setCouncil(undefined)
      return
    }
    // Debate UI runs in-place on the ready card — skip while debate is active/done.
    if (debateRunning || !!debateResult) return
    let cancelled = false
    setCouncil(null)
    const ctrl = new AbortController()
    const state = buildStrategyState({
      amountUsdc: Number(amount) || 0,
      riskLevel: risk,
      numVaults: strategy.agents.length,
      vaultData: VAULT_CATALOG,
      marketContext: marketLive,
      positions: agentData.positions,
      gas: latestGasRef.current,
    })
    const input = buildCouncilInput(strategy, state)
    councilReview(input, {
      specialist: councilSpecialistVerdict,
      resolveConflict: resolveCouncilConflict,
      weight: playbookWeight,
      devApiKey: devApiKey || null,
      signal: ctrl.signal,
    })
      .then((result) => {
        if (cancelled) return
        setCouncil(result)
        councilCitedRef.current = { citedRules: result.citedRules || [], verdict: result.verdict }
        addLog({
          event: 'OrchestratorPlanned',
          meta: `AI Council, ${result.verdict}, ${result.resolvedBy}${result.citedRules?.length ? `, ${result.citedRules.join(', ')}` : ''}`,
        })
      })
      .catch((e) => {
        if (!cancelled) {
          console.warn('[app] council failed:', e)
          setCouncil(undefined)
        }
      })
    return () => {
      cancelled = true
      ctrl.abort()
    }
  }, [strategy, amount, risk, councilRetry, debateRunning, debateResult])

  const handleEmergencyWithdraw = async (alert) => {
    const pos = agentData.positions[alert.vaultAddress]
    const bal = BigInt(pos?.balance || '0')
    if (bal <= 0n) {
      addLog({ event: 'AgentFailed', meta: 'Emergency withdrawal stopped. No balance is tracked.' })
      return
    }
    // NOTE: agentSettings.emergencyPct cannot be honoured — owner_withdraw takes no amount and
    // always sweeps the agent whole. A partial emergency exit needs a vault-level partial redeem;
    // until then this is full-exit only, and the settings copy overpromises.
    //
    // My Money Task 13 Part B item 5: migrated off the deleted `pickVaultAgents` (dropped
    // revoked-but-funded agents -- exactly the ones an emergency sweep must not skip).
    // `pickRecoverableVaultAgents` (the discovery-based replacement) keeps every candidate this
    // envelope has proven belongs to this owner for this vault, active or revoked.
    const agents = pickRecoverableVaultAgents(moneyDiscovery, { vault: alert.vaultAddress })
    if (!agents.length) {
      addLog({
        event: 'AgentFailed',
        meta: 'Emergency withdrawal stopped. No active agent holds this position.',
        detail: 'Agent permissions may still be loading, or every scope for this vault is revoked.',
      })
      return
    }
    try {
      const captured = activeAccount
      assertActiveAccount(captured)
      const results = await withdrawAllFromVault(
        alert.vaultAddress,
        realAddress,
        agents,
        undefined,
        {
          activeAccount: captured,
          getCurrentActiveAccount: () => activeAccountRef.current,
        }
      )
      assertActiveAccount(captured)
      const ok = results.filter((r) => r.ok)
      const failed = results.filter((r) => !r.ok)
      if (ok.length) {
        saveTransaction({
          txHash: ok[0].txHash,
          vaultName: 'Emergency Exit',
          vaultAddress: alert.vaultAddress,
          workerLabel: 'RiskWatcher',
          network: 'stellar-testnet',
        })
        addLog({
          event: 'PermissionRevoked',
          meta: `Emergency withdrawal from ${alert.vaultName}. Transaction ${shortAddr(ok[0].txHash)}.`,
          txHash: ok[0].txHash,
          detail: `Swept ${ok.length} of ${results.length} agents to your wallet.`,
        })
      }
      if (failed.length) {
        // The risk that raised this alert is still live for the un-swept agents — leave it standing.
        addLog({
          event: 'AgentFailed',
          meta: `Emergency withdrawal incomplete: ${failed.length} of ${results.length} agents failed.`,
          detail: failed[0].error?.message ?? failed[0].error,
        })
        return
      }
      dismissAlert(alert.id)
    } catch (e) {
      if (e?.code === 'ACTIVE_ACCOUNT_CHANGED') return
      addLog({ event: 'AgentFailed', meta: `Withdrawal failed: ${e.message}` })
    }
  }

  const handleReviewRebalance = (alert) =>
    addLog({
      event: 'OrchestratorPlanned',
      meta: `Rebalance review: ${alert.fromVault} → ${alert.toProtocol} (+${alert.apyGain}%).`,
      detail: `Venice AI flagged ${alert.toProtocol} at ${alert.toApy}% vs ${alert.fromVault} at ${alert.fromApy}% (+${alert.apyGain}%). Rebalancing authorizes a fresh Soroban session-key scope for the new vault.`,
    })

  // My Money Task 13: the old OpsConsole-only revoke handler that lived here is DELETED, not
  // merely orphaned — it was Part B item 1's named defect ("the live revoke treats an unreadable
  // balance as zero", `.catch(() => 0n)` above the old `shares` read), superseded by
  // handleConfirmRevoke (StopAccessDialog -> ownerActions.js's planRevoke, which reports an
  // unreadable balance as a WARNING, never a safe-to-revoke zero). It had zero callers left once
  // OpsConsole stopped being the production /agent route — confirmed via grep before deletion.

  // Live agent_revoked subscription — flips a scope row to "revoked" the instant the event lands,
  // whether revoked from this UI or elsewhere. subscribeAgentRevoked already filters to the owner.
  useE(() => {
    if (!realAddress) return
    const off = subscribeAgentRevoked(realAddress, (agent) => {
      setScopes((prev) =>
        prev.map((s) =>
          s.agent?.toLowerCase() === String(agent).toLowerCase() ? { ...s, revoked: true } : s
        )
      )
    })
    return off
  }, [realAddress])

  // Rehydrate the on-chain agent scopes on connect / auto-reconnect / wallet switch. `scopes` is
  // in-memory (filled live from AgentScopeAuthorized), so a refresh empties the "Agent permissions"
  // panel while the grants stay live on-chain. This re-enumerates the owner's router-deployed
  // agents (getEvents ∪ agent cache) and re-reads each scope, then REPLACES the whole list —
  // idempotent under StrictMode's double-fire, and safe against a racing live grant (that handler
  // dedupes by agent). Keyed on realAddress, not mount, so it also runs on manual reconnect.
  useE(() => {
    if (!realAddress) return
    let alive = true
    const gen = ++scopeGenRef.current
    rehydrateScopes({ owner: realAddress })
      .then((rows) => {
        if (alive && gen === scopeGenRef.current) setScopes(rows)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [realAddress])

  // Lifeboat mandate grant (vf-lifeboat) — user-signed, time-boxed 24h authority. Re-reads
  // lifeboat_state() right after the tx lands so the panel's countdown updates immediately
  // instead of waiting for the next 15s poll tick.
  //
  // My Money Task 13 Part B: this used to toggle its own `lifeboatBusy` flag, which had no reader
  // once MyMoneyRoute replaced OpsConsole's own LifeboatPanel. `handleMoneyPrimaryAction`'s
  // 'renew-protection' case (below) now wraps this SAME call in `moneyActionPending` -- the
  // pending flag MoneyHero's primary action button already disables on -- so this call still gets
  // a real pending indicator, using the mechanism the new route actually renders.
  const onGrantMandate = async () => {
    if (!realAddress) return
    try {
      await grantMandate({ owner: realAddress })
      const s = await readLifeboatState()
      setLifeboatState(s)
    } catch (e) {
      console.error('mandate grant failed', e)
    }
  }

  // After a withdraw: reduce/remove the position, sync the worker, stop the agent if empty
  const handleWithdrawSuccess = (vaultAddress, withdrawnUnits) => {
    lastWithdrawAtRef.current[(vaultAddress || '').toLowerCase()] = Date.now()
    const pos = agentData.positions[vaultAddress]
    const positions = { ...agentData.positions }
    if (pos) {
      const newBal = BigInt(pos.balance || '0') - BigInt(withdrawnUnits || '0')
      if (newBal <= 0n) delete positions[vaultAddress]
      else positions[vaultAddress] = { ...pos, balance: newBal.toString() }
    }
    setAgentData((d) => ({ ...d, positions }))
    const remaining = (strategy?.agents || [])
      .filter((a) => positions[a.vault.addr])
      .map((a) => ({
        address: a.vault.addr,
        name: a.vault.name,
        protocol: a.vault.protocol,
        depositApy: Number(a.vault.apy),
      }))
    if (remaining.length === 0) stopBackgroundAgent()
    else updateAgentConfig({ activeVaults: remaining })
    addLog({
      event: 'PermissionRevoked',
      meta: `Withdrew from ${shortAddr(vaultAddress)}. Position updated.`,
      detail: 'Position balance updated after withdraw; agent monitoring config synced.',
    })
    // owner_withdraw is terminal: every swept agent is now revoked ON-CHAIN, but `scopes` is
    // in-memory and nothing re-reads it until the next reconnect — so the permissions panel
    // kept showing dead agents as active after the funds had already left. And ONE immediate
    // re-read is not enough: RPC can serve the PRE-sweep scope state for a few ledgers (the
    // same lag the position reconcile below polls through), which re-showed the swept agents
    // as alive until a full reload. Same cadence as that reconcile: bounded retries, commit
    // every pass, stop once no live agent remains for this vault.
    if (realAddress) {
      let scopeTries = 0
      const refreshScopes = async () => {
        scopeTries++
        const gen = ++scopeGenRef.current
        const rows = await rehydrateScopes({ owner: realAddress }).catch(() => null)
        if (rows && gen === scopeGenRef.current) setScopes(rows)
        if (scopeTries >= 6) return
        // My Money Task 13 Part B item 5: `rows` is rehydrateScopes()'s own plain-scope shape
        // ({agent, vault, revoked}), NOT an OwnerDiscoveryV1 envelope -- forcing it through the
        // discovery-based `pickRecoverableVaultAgents` would silently break (that picker reads
        // `.address`, which this shape doesn't have). This is also a genuinely different question
        // than item 5's exit-enumeration concern: it's asking "has the post-sweep revoke landed on
        // RPC yet", not "who must a sweep target" -- so it deliberately keeps excluding revoked
        // rows via the extracted `hasLiveScopeForVault` rather than switching pickers.
        if (rows && !hasLiveScopeForVault(rows, vaultAddress)) return
        setTimeout(refreshScopes, 2000)
      }
      refreshScopes()
    }
    // Optimistic subtract above can drift (partial fills, share-price). Chain = truth — but the
    // Soroban RPC read can lag the ledger that just settled the withdraw, returning the PRE-withdraw
    // balance. Committing that stale read would bounce the UI right back up to the old number
    // (the bug: "balance doesn't update after withdraw") — and there's no withdraw event
    // listener to re-correct it. So we poll, and only commit the chain snapshot once it
    // actually reflects the withdraw (target vault balance <= our optimistic value). The
    // optimistic value stays on screen the whole time, so the drop is instant and stable.
    if (realAddress) {
      const targetBal = positions[vaultAddress]
        ? BigInt(positions[vaultAddress].balance || '0')
        : 0n
      let attempts = 0
      const reconcile = async () => {
        attempts++
        const chain = await reconcilePositions(realAddress).catch(() => null)
        if (chain) {
          const entry = Object.entries(chain).find(
            ([k]) => k.toLowerCase() === vaultAddress.toLowerCase()
          )
          const chainBal = entry ? BigInt(entry[1].balance || '0') : 0n
          // Trust the chain only once it has caught up to (or below) the post-withdraw value,
          // or after a bounded number of tries so we never spin forever on a real drift.
          if (chainBal <= targetBal || attempts >= 6) {
            setAgentData((d) => ({
              ...d,
              positions: applyChainPositions(d.positions, chain),
              lastUpdated: Date.now(),
            }))
            return
          }
        }
        if (attempts < 6) setTimeout(reconcile, 2000)
      }
      reconcile()
    }
  }

  // vf-base-dashboard Task 10 — Withdraw button on a Base position row. ensureBaseOwner is
  // login-mode after the first-ever ceremony (see passkeyBridge.js), so this is one WebAuthn
  // tap, not a fresh registration. Mounts the existing Withdraw screen (screens/Withdraw.jsx)
  // once the owner kernel account resolves. Dynamic import: keeps passkeyBridge.js (and the
  // ZeroDev/viem chain behind it) out of the eager bundle — mirrors orchestrator.js's
  // baseLeg.js gating (Task 8).
  const handleBaseWithdrawClick = async () => {
    const captured = activeAccount
    assertActiveAccount(captured)
    setBaseWithdrawError(null)
    // The positions on screen belong to THIS account; the ceremony below is discoverable, and
    // a user with several look-alike passkeys can pick one that derives a different (empty)
    // kernel — the withdraw userOp then reverts in simulation with an unreadable AA error, and
    // ensureBaseOwner's persist clobbers the good marker with the wrong address (seen live
    // 2026-07-20). Guard: mismatch → restore the marker + a retry-with-another-passkey message.
    //
    // VF Wallet Task 6: `expected` is sourced from the owner-scoped v2 record (readBaseOwner)
    // instead of the blind global vf_base_owner_address key — a different connected wallet's
    // leftover ceremony must never be read as "expected" here. ensureBaseOwner (unchanged)
    // still dual-writes BOTH the legacy keys and the v2 record on every resolution, so a
    // mismatch/failure restore must put BOTH back, or one storage location would keep the
    // wrong-passkey clobber even after "restoring" the other.
    const ownerRecordBefore = readBaseOwner(realAddress)
    const expected = ownerRecordBefore?.kernelAddress || null
    const restoreOwnerRecord = () => {
      if (!realAddress) return
      if (expected) localStorage.setItem('vf_base_owner_address', expected)
      if (ownerRecordBefore) {
        localStorage.setItem(baseOwnerStorageKey(realAddress), JSON.stringify(ownerRecordBefore))
      }
    }
    try {
      const { ensureBaseOwner } = await import('./wallet/passkeyBridge.js')
      assertActiveAccount(captured)
      const owner = await ensureBaseOwner({ connectedAddress: realAddress })
      assertActiveAccount(captured)
      if (expected && owner.address?.toLowerCase() !== expected.toLowerCase()) {
        restoreOwnerRecord()
        setBaseWithdrawError(
          `That passkey opens a different Base account (${owner.address.slice(0, 6)}…) than the one holding these positions (${expected.slice(0, 6)}…). Retry and pick another passkey.`
        )
        return
      }
      // Full exit: every open Base position, not the row that was clicked. The
      // sweeper reads live balances, so this list is only used for the pool
      // addresses, the per-pool slippage floors, and the pre-signature summary.
      const idleUsdc = await readIdleUsdc({
        account: owner.address,
        publicClient: owner.publicClient,
      })
      assertActiveAccount(captured)
      setBaseWithdraw({
        positions: basePositions,
        idleUsdc,
        ownerKernelAccount: owner.kernelAccount,
        publicClient: owner.publicClient,
        activeAccount: captured,
      })
    } catch (err) {
      restoreOwnerRecord()
      if (err?.code === 'ACTIVE_ACCOUNT_CHANGED') return
      setBaseWithdrawError(err.message)
    }
  }

  // Fix loop 1, I2: `handleBaseRecover` restored, re-sited on MyMoneyRoute (not RecoveryPanel --
  // see MyMoneyRoute.jsx's own header comment for why RecoveryPanel cannot be the trigger: it only
  // opens via openMoneyRecoveryFromOutcomes, i.e. AFTER an owner action already ran, so it is
  // unreachable on exactly the brand-new-device/zero-local-state case this fixes). Same shape the
  // review asked for: a discoverable passkey login (`preferLogin: true` -- an existing account is
  // PRESUMED, so this never mints a fresh, empty kernel on a device that already has real custody)
  // followed by the OWNER-WIDE `loadIndexedBasePositions` reader (Part B item 4), never
  // `loadDeviceBasePositions`'s own local-record gate -- that gate is exactly the device-scoped
  // assumption this whole gap traces back to. Enrichment (pool name/apy) is the same small map
  // `loadDeviceBasePositions` itself applies, inlined here rather than exported from
  // base/dashboardPositions.js, which is outside this fix loop's authorized file list. Never
  // fabricates a position: `positions` is exactly what this read returns, [] when the ceremony
  // succeeds but nothing is found there.
  async function handleRecoverBaseAccount() {
    if (!realAddress || !activeAccount) return
    const captured = activeAccount
    assertActiveAccount(captured)
    setMoneyActionPending(true)
    setBaseWithdrawError(null)
    try {
      const { ensureBaseOwner } = await import('./wallet/passkeyBridge.js')
      assertActiveAccount(captured)
      const account = await ensureBaseOwner({ connectedAddress: realAddress, preferLogin: true })
      assertActiveAccount(captured)
      const result = await loadIndexedBasePositions({
        stellarOwner: realAddress,
        indexedBaseAccounts: [account.address],
      })
      assertActiveAccount(captured)
      const positions = (result.accounts?.[0]?.positions ?? []).map((pos) => {
        const cat = BASE_POOL_CATALOG.find(
          (p) => p.address.toLowerCase() === pos.pool.toLowerCase()
        )
        return { ...pos, poolName: cat?.name || pos.pool, apy: cat?.apy || 0 }
      })
      setBasePositions(positions)
    } catch (err) {
      if (err?.code === 'ACTIVE_ACCOUNT_CHANGED') return
      setBaseWithdrawError(err.message)
    } finally {
      try {
        assertActiveAccount(captured)
        setMoneyActionPending(false)
      } catch {
        // The account-transition reset already cleared this pending flag.
      }
    }
  }

  const runCouncilMonitorCheck = async (settings, apyByVault = {}) => {
    if (!strategy?.agents?.length && Object.keys(agentData.positions).length === 0) return
    const snapshot = loadLatestSnapshot()
    const currentData = {
      apyByVault,
      turbulence: strategy?.mdpState?.turbulence || marketLive?.turbulence || 'calm',
      gasGwei: latestGasRef.current?.gwei ?? null,
      estimatedVaR: snapshot?.result?.VaR ?? null,
      estimatedCVaR: snapshot?.result?.CVaR ?? null,
      blendedApy: snapshot?.marketData?.blendedApy ?? null,
    }
    const diff = diffMarket(currentData, snapshot, settings)
    // Full debate requires strategy object — cap to fast re-eval on page refresh (strategy null)
    const safeLevel = !strategy?.agents?.length && diff.level === 'full' ? 'fast' : diff.level
    if (safeLevel === 'skip') return

    if (safeLevel === 'fast') {
      const result = await fastReeval(strategy, snapshot?.result || null, currentData, {
        devApiKey: devApiKey || null,
      })
      if (result.passed) {
        saveSnapshot(result, currentData)
        if (settings.autoApprove) return
        addLog({
          event: 'OrchestratorPlanned',
          meta: `Monitor re-eval, fast pass, confidence ${(result.confidence * 100).toFixed(0)}%`,
        })
      } else {
        addLog({
          event: 'AgentFailed',
          meta: `Monitor re-eval, ${result.error}`,
          detail: (result.violations || []).join('; '),
        })
      }
    }

    if (safeLevel === 'full') {
      setDebateRunning(true)
      const ctrl = new AbortController()
      try {
        const state = buildStrategyState({
          amountUsdc: Number(amount) || 0,
          riskLevel: risk,
          numVaults: strategy?.agents?.length || Object.keys(agentData.positions).length || 1,
          vaultData: VAULT_CATALOG,
          marketContext: marketLive,
          positions: agentData.positions,
          gas: latestGasRef.current,
          maxDrawdownPct: agentSettings.maxDrawdownPct,
        })
        const sim = runSimulation(allocationsFromStrategy(strategy), state, {
          runs: 200,
          horizonDays: 30,
          seed: 1,
          context: {
            turbulence: currentData.turbulence,
            apyTrendPct: 0,
            gasGwei: currentData.gasGwei,
          },
        })
        const input = buildDebateInput(strategy, sim, state)
        const result = await councilDebate(input, {
          proposer: proposerVerdict,
          riskCompliance: riskComplianceVerdict,
          validator: validatorVerdict,
          devApiKey: devApiKey || null,
          signal: ctrl.signal,
          maxIterations: settings.maxIterations || 5,
          convergenceThreshold: 0.15,
        })
        saveSnapshot(result, currentData)
        addLog({
          event: result.verdict === 'keep' ? 'OrchestratorPlanned' : 'AgentFailed',
          meta: `Monitor full debate, ${result.verdict}, ${result.iterations} iters, converged: ${result.converged}`,
        })
      } finally {
        ctrl.abort()
        setDebateRunning(false)
      }
    }
  }

  const handleConnect = async () => {
    setConnectPhase('connecting')
    setConnectError(null)
    try {
      const addr = installActiveWalletAccount(await connectActiveAccount()).address
      setConnectPhase('connected')
      addLog({ event: 'Connected', meta: shortAddr(addr) })
    } catch (err) {
      setConnectPhase('idle')
      setConnectError(err.message)
      addLog({ event: 'AgentFailed', meta: `Connection failed: ${err.message}` })
    }
  }

  // ========================================================================================
  // My Money Task 13 (Pocket Crew redesign, Wave 5) — the production `/agent` route (MyMoneyRoute)
  // + the compact `/home` launcher's projection. This controller owns discovery/money/protection
  // state, applies the request generation/revision guards (shouldCommitMoneyFetch, above) on
  // wallet change and post-action refresh, and passes a normalized model + real action handlers
  // to MyMoneyRoute/WithdrawDialog/StopAccessDialog/RecoveryPanel. It never puts a raw secret or
  // session key into React state: `moneyAccountValue` below is only `{kind, address}` —
  // signing itself stays inside stellar/exit.js, stellar/revoke.js, stellar/partialWithdraw.js
  // (wallet-kit popup / relayer ceremony), which this controller only calls, never inspects.
  const [moneyModel, setMoneyModel] = useS(() => buildMyMoneyModel({ owner: null }))
  // moneyDiscovery is declared earlier in this component now (My Money Task 13 Part B item 5's
  // positionsAgents needs it before this block runs) -- see that declaration's own comment.
  const [moneyRead, setMoneyRead] = useS(null) // readOwnerMoney-derived MoneySnapshot (buildMoneySnapshot)
  const [moneyActionPending, setMoneyActionPending] = useS(false)
  const [moneyWithdrawOpen, setMoneyWithdrawOpen] = useS(false)
  const [moneyStopAccessAddress, setMoneyStopAccessAddress] = useS(null)
  const [moneyRecovery, setMoneyRecovery] = useS(null)
  const moneyRevisionRef = useR(null) // freshness.js's nextReconciliationToken/isReconciliationCurrent
  const realAddressRef = useR(realAddress)
  const moneyCacheRef = useR({})

  function installActiveWalletAccount(next) {
    const previous = activeAccountRef.current
    if (previous && previous !== next) {
      const changed = Object.assign(new Error('The active wallet account changed.'), {
        code: 'ACTIVE_ACCOUNT_CHANGED',
      })
      pendingConfirmRef.current?.reject(changed)
      pendingConfirmRef.current = null
      activeOrchestrationRef.current?.cancel()
      activeOrchestrationRef.current = null
      dispatchFlow({ type: 'STRATEGY_RESET' })
      setStrategy(null)
      setRunReceipt(null)
      setRecoveryByAllocation({})
      setRecoveryPendingAllocations(new Set())
      recoveryMappingsRef.current = new Map()
      setExecMap({})
      setOpenAgentId(null)
      setRunEvents([])
      setLogs([])
      agentMapRef.current = {}
      deployedAgentsRef.current = []
      setPermActive(false)
      setPermExpiresAt(null)
      setBaseView({ connected: false, healthy: null, mandateView: null, action: null })
      setBasePositions([])
      setBaseWithdraw(null)
      setBaseWithdrawError(null)
      setBaseMandateError(null)
      setSettingUpBaseMandate(false)
      baseSetupSucceededRef.current = false
      setMoneyDiscovery(null)
      setMoneyRead(null)
      setMoneyModel(buildMyMoneyModel({ owner: null }))
      setMoneyActionPending(false)
      setMoneyWithdrawOpen(false)
      setMoneyStopAccessAddress(null)
      setMoneyRecovery(null)
      moneyCacheRef.current = {}
      setScopes([])
      setAgentData({ positions: {}, alerts: [], lastUpdated: null })
      positionsAgentsRef.current = undefined
      hydratedRef.current = null
      moneyRevisionRef.current = nextReconciliationToken(moneyRevisionRef.current)
    }
    activeAccountRef.current = next || null
    setActiveAccount(next || null)
    setRealAddress(next?.address || null)
    return next
  }

  useE(() => onActiveAccountChange(installActiveWalletAccount), [])

  const assertActiveAccount = (captured) =>
    assertCurrentActiveAccount({ captured, current: activeAccountRef.current })

  useE(() => {
    realAddressRef.current = realAddress
  }, [realAddress])

  const moneyAccountValue = useM(
    () => (activeAccount ? { kind: activeAccount.kind, address: activeAccount.address } : null),
    [activeAccount]
  )

  // Final-review fix, M7: `selectCrewDecisions(logs)` used to be called inline in the render body,
  // unmemoized, over `logs` -- an array that grows without bound (appended at :951-955, cleared
  // only at flow reset) and is re-derived on every render, including every 15s poll tick, even on
  // routes other than /agent. Memoized on the only input that can change its output.
  const crewDecisions = useM(() => selectCrewDecisions(logs), [logs])

  function moneyProtectionSnapshot() {
    if (!lifeboatState) return null
    return classifyLifeboatAutomation({
      derisked: lifeboatState.derisked,
      mandateExpiry: lifeboatState.mandateExpiry,
      authority: lifeboatState.authority,
      now: Date.now(),
    })
  }

  // Read-only refresh: discovery -> money -> model, guarded by guardedMoneyFetch/
  // shouldCommitMoneyFetch so a wallet switch or a newer mutating action (bumped moneyRevisionRef)
  // can never let this stale attempt repaint the screen, however late it resolves. Fix loop 1, I1:
  // ALL of the guard-then-commit decision now lives in the exported guardedMoneyFetch above — this
  // is a thin wrapper, not a second copy, so a controller-level test on guardedMoneyFetch IS a test
  // of this call site.
  async function refreshMoney(owner) {
    // REFRESH-MONEY-WIRING:START -- MM13 M5, fix round 2: pinned by a source-scan test
    // (app.money.test.jsx) asserting this call passes the LIVE ref objects, not dead literals, and
    // that nothing after the spread overrides them. moneyFetchArgs itself (exported above) is
    // unit-tested for identity-preservation directly; the marker spans the WHOLE guardedMoneyFetch
    // call, through its closing `})`, not just the spread line -- fix round 1's narrower block
    // (spread line only) left `currentOwnerRef: { current: owner }, revisionRef: { current: null }`
    // keys ADDED AFTER the spread completely unreachable by construction (a later key wins over an
    // earlier spread; no-dupe-keys does not flag spread-then-key), so that exact mutation passed
    // 39/39 green. Comments are stripped before matching; the negative assertion (an inline
    // `{ current: ... }` literal anywhere in this whole block) now actually covers the space a
    // plausible "add an override" refactor would use.
    await guardedMoneyFetch({
      ...moneyFetchArgs(owner, { currentOwnerRef: realAddressRef, revisionRef: moneyRevisionRef }),
      onCommit: (snapshot) => {
        const protection = moneyProtectionSnapshot()
        const nextCache = { money: snapshot.money, discovery: snapshot.discovery, protection }
        moneyCacheRef.current = nextCache
        saveMoneyCache(owner, nextCache)
        setMoneyDiscovery(snapshot.discovery)
        setMoneyRead(snapshot.money)
        setMoneyModel(
          buildMyMoneyModel({
            owner,
            discovery: snapshot.discovery,
            money: snapshot.money,
            protection,
            cache: nextCache,
            now: Date.now(),
          })
        )
      },
    })
    // REFRESH-MONEY-WIRING:END
  }

  // Wallet change (connect/switch/disconnect): render the cache immediately, marked stale by
  // buildMyMoneyModel's own freshness math (never a confident 'current' from a cache alone) —
  // strictly read-only, no transaction replay — then kick off a fresh, guarded refresh. The
  // `alive` flag scopes every poll tick below to THIS owner's effect lifetime; combined with
  // shouldCommitMoneyFetch's own owner check inside refreshMoney, a switch mid-flight is guarded
  // twice over.
  // MONEY-RELOAD-EFFECT:START -- Fix loop 1, I1 (hazard 2). app.money.test.jsx source-scans
  // EXACTLY this block: it must prime state via buildMyMoneyModel and call refreshMoney (the
  // guarded read path), and must NEVER call a write-capable function (sweepAgents/partialWithdraw/
  // revokeAgentOnChain/ensureExitSigner/reconcileOwnerAction) — a reload/reconnect must render
  // cache-as-stale and reconcile read-only, never replay a transaction. Keep these markers directly
  // wrapping the effect if you touch it.
  useE(() => {
    let alive = true
    if (!realAddress) {
      moneyCacheRef.current = {}
      setMoneyDiscovery(null)
      setMoneyRead(null)
      setMoneyModel(buildMyMoneyModel({ owner: null }))
      return
    }
    const cached = loadMoneyCache(realAddress)
    moneyCacheRef.current = cached
    setMoneyDiscovery(cached.discovery ?? null)
    setMoneyRead(cached.money ?? null)
    setMoneyModel(
      buildMyMoneyModel({
        owner: realAddress,
        discovery: cached.discovery ?? null,
        money: cached.money ?? null,
        protection: cached.protection ?? null,
        cache: cached,
        now: Date.now(),
      })
    )
    refreshMoney(realAddress)
    const id = setInterval(() => {
      if (alive) refreshMoney(realAddress)
    }, 30_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [realAddress])
  // MONEY-RELOAD-EFFECT:END

  // Re-derives the model from an ALREADY-fresh read (an owner action's own reconcileOwnerAction
  // result) when one is available, avoiding a redundant extra readOwnerMoney round-trip; falls
  // back to a full refreshMoney() when the action's reconciliation never got a fresh read (e.g.
  // 'not-submitted'). Guarded the same way as refreshMoney — a wallet switch during a pending
  // action must not let its aftermath repaint the new owner's screen.
  async function refreshMoneyAfterAction(freshReads) {
    if (
      !isMoneyFetchForCurrentOwner({
        fetchOwner: realAddress,
        currentOwner: realAddressRef.current,
      })
    ) {
      return
    }
    if (!freshReads) {
      await refreshMoney(realAddress)
      return
    }
    const money = buildMoneySnapshot(freshReads)
    const protection = moneyProtectionSnapshot()
    const nextCache = { money, discovery: moneyDiscovery, protection }
    moneyCacheRef.current = nextCache
    saveMoneyCache(realAddress, nextCache)
    setMoneyRead(money)
    setMoneyModel(
      buildMyMoneyModel({
        owner: realAddress,
        discovery: moneyDiscovery,
        money,
        protection,
        cache: nextCache,
        now: Date.now(),
      })
    )
  }

  function boundReadOwnerMoney() {
    return readOwnerMoney({ owner: realAddress, discovery: moneyDiscovery, now: Date.now() })
  }

  async function handleMoneyPrimaryAction(action) {
    if (action === 'connect-wallet') return handleConnect()
    if (action === 'deposit' || action === 'add-money') {
      navigate('/strategy')
      return
    }
    if (action === 'renew-protection') {
      setMoneyActionPending(true)
      try {
        await onGrantMandate()
      } finally {
        setMoneyActionPending(false)
      }
      return
    }
    if (action === 'review-problem') {
      setMoneyWithdrawOpen(true)
      return
    }
  }

  function handleRecoverAgent(address, plan) {
    // AgentTeam.jsx already computed `plan` via planFullExit -- execute it directly (its own
    // dialog copy: "Owner withdrawal is always allowed by the contract"). Falls back to opening
    // the full withdraw dialog when discovery hadn't finished loading yet (plan is null there).
    if (plan?.ok) {
      handleConfirmFullExit(plan)
      return
    }
    setMoneyWithdrawOpen(true)
  }

  function openMoneyRecoveryFromOutcomes({ action, outcomes }) {
    const bad = outcomes.find((o) => o.outcome === 'unknown' || o.outcome === 'not-submitted')
    if (!bad) return
    setMoneyRecovery({ action, submission: bad, reconciled: null })
  }

  async function handleConfirmFullExit(plan) {
    if (!plan?.ok || !realAddress) return
    const captured = activeAccount
    assertActiveAccount(captured)
    setMoneyActionPending(true)
    try {
      const addresses = plan.targets.map((t) => t.address)
      const swept = await sweepAgents({
        owner: realAddress,
        agentAddresses: addresses,
        to: realAddress,
        activeAccount: captured,
        getCurrentActiveAccount: () => activeAccountRef.current,
      })
      assertActiveAccount(captured)
      const perAgent = addresses.map((address, i) => ({
        agentAddress: address,
        ok: swept.errors[i] == null,
        status: swept.errors[i] == null ? 'SUCCESS' : undefined,
        hash: swept.txHashes[i],
        error: swept.errors[i],
      }))
      const beforeRevision = moneyRevisionRef.current
      const action = { kind: 'full-exit', targets: plan.targets }
      const reconciled = await reconcileOwnerAction({
        action,
        result: perAgent,
        readOwnerMoney: boundReadOwnerMoney,
        beforeRevision,
      })
      assertActiveAccount(captured)
      moneyRevisionRef.current = reconciled.revision
      await refreshMoneyAfterAction(reconciled.fresh)
      assertActiveAccount(captured)
      if (reconciled.complete) setMoneyWithdrawOpen(false)
      else openMoneyRecoveryFromOutcomes({ action, outcomes: reconciled.outcomes })
    } finally {
      try {
        assertActiveAccount(captured)
        setMoneyActionPending(false)
      } catch {
        // The replacement account's transition already cleared this owner-scoped pending state.
      }
    }
  }

  async function handleConfirmPartialExit(plan) {
    if (!plan?.ok || plan.mode !== 'partial' || !realAddress) return
    setMoneyActionPending(true)
    const action = { kind: 'partial-exit', agentAddress: plan.agentAddress }
    const captured = activeAccount
    assertActiveAccount(captured)
    try {
      await ensureExitSigner({
        owner: realAddress,
        agentAddress: plan.agentAddress,
        activeAccount: captured,
        getCurrentActiveAccount: () => activeAccountRef.current,
      })
      assertActiveAccount(captured)
      await partialWithdraw({
        owner: realAddress,
        agentAddress: plan.agentAddress,
        amountUnits: BigInt(plan.amount.units),
        activeAccount: captured,
        getCurrentActiveAccount: () => activeAccountRef.current,
      })
      assertActiveAccount(captured)
      const beforeRevision = moneyRevisionRef.current
      const reconciled = await reconcileOwnerAction({
        action,
        result: {
          agentAddress: plan.agentAddress,
          ok: true,
          status: 'SUCCESS',
          amount: plan.amount,
        },
        readOwnerMoney: boundReadOwnerMoney,
        beforeRevision,
      })
      assertActiveAccount(captured)
      moneyRevisionRef.current = reconciled.revision
      await refreshMoneyAfterAction(reconciled.fresh)
      assertActiveAccount(captured)
      if (reconciled.complete) setMoneyWithdrawOpen(false)
      else openMoneyRecoveryFromOutcomes({ action, outcomes: reconciled.outcomes })
    } catch (err) {
      if (err?.code === 'ACTIVE_ACCOUNT_CHANGED') return
      const beforeRevision = moneyRevisionRef.current
      const reconciled = await reconcileOwnerAction({
        action,
        result: { agentAddress: plan.agentAddress, error: err },
        readOwnerMoney: boundReadOwnerMoney,
        beforeRevision,
      })
      assertActiveAccount(captured)
      moneyRevisionRef.current = reconciled.revision
      await refreshMoneyAfterAction(reconciled.fresh)
      assertActiveAccount(captured)
      openMoneyRecoveryFromOutcomes({ action, outcomes: reconciled.outcomes })
    } finally {
      try {
        assertActiveAccount(captured)
        setMoneyActionPending(false)
      } catch {
        // Cleared atomically by the account transition.
      }
    }
  }

  async function handleConfirmRevoke(plan) {
    if (!plan?.ok || !realAddress) return
    setMoneyActionPending(true)
    const action = { kind: 'revoke', agentAddress: plan.agentAddress }
    const captured = activeAccount
    assertActiveAccount(captured)
    try {
      const result = await revokeAgentOnChain({
        owner: realAddress,
        agent: plan.agentAddress,
        activeAccount: captured,
        getCurrentActiveAccount: () => activeAccountRef.current,
      })
      assertActiveAccount(captured)
      const beforeRevision = moneyRevisionRef.current
      const reconciled = await reconcileOwnerAction({
        action,
        result: {
          agentAddress: plan.agentAddress,
          ok: result.status === 'SUCCESS',
          status: result.status,
          hash: result.hash,
        },
        readOwnerMoney: boundReadOwnerMoney,
        beforeRevision,
      })
      assertActiveAccount(captured)
      moneyRevisionRef.current = reconciled.revision
      await refreshMoneyAfterAction(reconciled.fresh)
      assertActiveAccount(captured)
      if (reconciled.complete) setMoneyStopAccessAddress(null)
      else openMoneyRecoveryFromOutcomes({ action, outcomes: reconciled.outcomes })
    } finally {
      try {
        assertActiveAccount(captured)
        setMoneyActionPending(false)
      } catch {
        // Cleared atomically by the account transition.
      }
    }
  }

  function handleConfirmBaseWithdraw() {
    // Base's real unwind ceremony (passkey ceremony + screens/Withdraw.jsx's step-flow) already
    // exists and stays off-limits/unmodified for this task — this dialog action re-triggers that
    // SAME proven flow rather than re-implementing a second one inline.
    setMoneyWithdrawOpen(false)
    handleBaseWithdrawClick()
  }

  async function handleCheckSubmissionStatus() {
    if (!moneyRecovery?.action) return
    setMoneyActionPending(true)
    try {
      const beforeRevision = moneyRevisionRef.current
      const reconciled = await reconcileOwnerAction({
        action: moneyRecovery.action,
        result: moneyRecovery.submission,
        readOwnerMoney: boundReadOwnerMoney,
        beforeRevision,
      })
      moneyRevisionRef.current = reconciled.revision
      await refreshMoneyAfterAction(reconciled.fresh)
      setMoneyRecovery((prev) =>
        prev
          ? {
              ...prev,
              reconciled: reconciled.complete
                ? 'landed'
                : reconciled.retryAllowed
                  ? 'not-landed'
                  : null,
            }
          : prev
      )
    } finally {
      setMoneyActionPending(false)
    }
  }

  function handleRetrySubmission() {
    // Reconciliation already proved this never landed (retryEnabled gates on exactly that in
    // RecoveryPanel) -- route back to the SAME action's own dialog rather than resubmit blindly
    // from here.
    const kind = moneyRecovery?.action?.kind
    const agentAddress = moneyRecovery?.action?.agentAddress
    setMoneyRecovery(null)
    if (kind === 'revoke' && agentAddress) setMoneyStopAccessAddress(agentAddress)
    else setMoneyWithdrawOpen(true)
  }

  // ========================================================================================
  // Strategy Task 13 (Pocket Crew redesign, Wave 5) — the production Plan/Protect/Start route.
  // Everything below this line, down to renderStrategyRoute(), wires the pure
  // PlanStage/ProtectStage/StartStage/StrategyReceipt components (Tasks 10-12) to real
  // generation, wallet, preflight/grant, and orchestrator calls, via its own parallel
  // orchestrator dispatch (`runOrchestratorDispatch`/`handleNewRunEvent`). Every real producer
  // (worker.js's `emit()` wrapper, orchestrator.js's worker-queued/worker-started, baseLeg.js's
  // now-keyed leg events) already carries `allocationId` directly.
  //
  // Fix loop 1 (C1): the old six-step/fake-ceremony flow (StepRail stages connect/skills/
  // permission/execute/done, `renderStage()`, `jumpTo`/`goBack`, and the legacy `startExecution`
  // orchestrator dispatch it drove) has been deleted outright rather than re-gated — see the
  // report for the grep proof that nothing reachable from production still renders it.

  const STELLAR_VENUE_ENTRY = VAULT_CATALOG[0]
  const stellarVenueDisplay = {
    name: STELLAR_VENUE_ENTRY?.name,
    protocol: STELLAR_VENUE_ENTRY?.protocol,
    apy: STELLAR_VENUE_ENTRY?.apy,
    drawdown: STELLAR_VENUE_ENTRY?.drawdown,
    risk: STELLAR_VENUE_ENTRY?.risk,
    address: STELLAR_VENUE_ENTRY?.address,
    role: 'Conservative, lending',
    roleLabel: 'Conservative',
    destination: STELLAR_VENUE_ENTRY?.destination || STELLAR_VENUE_ENTRY?.name,
  }

  // ----- Base availability for the Plan surface -----
  // Composes the canonical `resolveBaseAvailability({mandate, connection, health})` contract
  // (mergeFlowHelpers.js, decision log #22 obligation D) with the Circle USDC funding gate that
  // contract does not itself check (Task 7's fail-closed rule: a mandate can be 'ready' with zero
  // burn-token balance) -- folded into `health` so a caller of the canonical contract still gets
  // the full fail-closed preflight the deleted legacy overload used to provide in one call.
  //
  // Known gap, disclosed rather than silently guessed: `toBaseMandateView`'s relayer-origin-drift
  // check compares `mandate.relayerOrigin` (the LOCAL record, captured once at setup) against
  // `connection.relayerOrigin` -- there is no second, independent LIVE source for "the relayer's
  // origin right now" anywhere in this codebase today (getMandateStatus's response only carries
  // one once a mandate already exists), so this passes the same stored value for both. The
  // mismatch branch therefore never trips in production yet; every other status (missing/expired/
  // revoked/owner+kernel-mismatch) is unaffected and still fail-closed. Flagged for a future task.
  async function resolveBaseForPlan({ stellarOwner, signal, setupSucceeded }) {
    if (!stellarOwner) return { connected: false, healthy: null, mandateView: null, action: null }
    const record = readBaseMandate(stellarOwner)
    let mandateEvidence = null
    if (record?.serializedApproval && record?.kernelAddress) {
      try {
        mandateEvidence = await getMandateStatus(record.serializedApproval, {
          stellarOwner,
          kernelAddress: record.kernelAddress,
          allocation: baseMandateProbeAllocation(),
        })
      } catch {
        mandateEvidence = null
      }
    }
    const { checkRelayerHealth } = await import('./strategy/mergedCatalog.js')
    const { baseAvailable, mandateView, action } = resolveBaseAvailability({
      mandate: mandateEvidence,
      connection: {
        connected: true,
        stellarOwner,
        kernelAddress: mandateEvidence?.kernelAddress ?? record?.kernelAddress ?? null,
        relayerOrigin: mandateEvidence?.relayerOrigin ?? record?.relayerOrigin ?? null,
        setupSucceeded,
      },
      health: async () => {
        const healthy = await checkRelayerHealth({ signal })
        if (!healthy) return false
        return checkCircleUsdcFunding({
          address: stellarOwner,
          readTokenBalance,
          token: STELLAR_USDC_SAC,
        })()
      },
    })
    const healthy = await baseAvailable
    return { connected: true, healthy, mandateView, action }
  }

  async function refreshBaseView(captured = activeAccount) {
    if (!captured) return null
    assertActiveAccount(captured)
    const result = await resolveBaseForPlan({
      stellarOwner: realAddress,
      setupSucceeded: baseSetupSucceededRef.current,
    })
    assertActiveAccount(captured)
    setBaseView(result)
    return result
  }

  useE(() => {
    refreshBaseView(activeAccount).catch(() => {
      // Fail closed; the Plan surface remains unavailable until the next guarded refresh.
    })
  }, [realAddress, activeAccount])

  async function onConnectForBase() {
    try {
      const addr = installActiveWalletAccount(await connectActiveAccount()).address
      setConnectPhase('connected')
    } catch {
      // PlanStage's own header comment: no richer connect-error surface belongs on this stage.
    }
  }

  async function onSetupBase() {
    if (!realAddress || !activeAccount) return
    const captured = activeAccount
    assertActiveAccount(captured)
    setSettingUpBaseMandate(true)
    setBaseMandateError(null)
    try {
      await setupBaseMandate({ connectedAddress: realAddress })
      assertActiveAccount(captured)
      baseSetupSucceededRef.current = true
      await refreshBaseView(captured)
    } catch (e) {
      if (e?.code === 'ACTIVE_ACCOUNT_CHANGED') return
      setBaseMandateError(e.message)
    } finally {
      try {
        assertActiveAccount(captured)
        setSettingUpBaseMandate(false)
      } catch {
        // The account-transition reset already cleared this pending flag.
      }
    }
  }

  function onRebuildPlan() {
    baseSetupSucceededRef.current = false
    refreshBaseView().catch(() => {
      // Fail closed; the Plan surface remains unavailable until the next guarded refresh.
    })
  }

  // ----- Plan generation (real strategist + council-eligibility, never a `speed * ...` timer) -----
  async function generateStrategyPlan({ amountUnits, risk, baseEligible }, reportPhase) {
    const riskLevel = risk === 'med' ? 'medium' : risk
    const numVaults = { low: 1, med: 2, high: 3 }[risk] || 2
    const ctrl = new AbortController()
    reportPhase('Checking destinations')
    const { checkRelayerHealth } = await import('./strategy/mergedCatalog.js')
    const healthPromise = baseEligible
      ? checkRelayerHealth({ signal: ctrl.signal })
      : Promise.resolve(false)
    reportPhase('Building bounded allocations')
    const veniceResult = await generateStrategy({
      amount: Number(amountUnits) / 10 ** SOROBAN_DECIMALS,
      riskLevel,
      numVaults,
      veniceAuth: null,
      devApiKey: devApiKey || null,
      signal: ctrl.signal,
      address: realAddress || null,
      baseAvailable: healthPromise,
    })
    const generatedBy = veniceResult.generatedBy || 'fallback'
    const source = generatedBy === 'fallback' ? 'fallback' : generatedBy
    const sourceState = generatedBy === 'fallback' ? 'deterministic' : 'live-ai'
    const selected = veniceResult.selected_vaults || []

    // Enforcement A (eligibility gate), run BEFORE the plan is even shown for review -- a
    // destination that fails eligibility is never offered, not merely dropped after the fact.
    // The Stellar leg has exactly one real venue (STELLAR_VENUE_ENTRY), so every Stellar-tagged
    // pick collapses onto the SAME verdict; a Base pick keys its own verdict via factSlug.
    const eligibilityAgents = selected.map((v) => {
      const isBase = baseEligible && v.chain === 'base'
      const cat = isBase
        ? BASE_POOL_CATALOG.find(
            (p) => p.address.toLowerCase() === String(v.address || '').toLowerCase()
          )
        : null
      return {
        allocation: Number(v.allocation) || 0,
        vault: {
          protocol: isBase ? cat?.protocol || v.protocol : stellarVenueDisplay.protocol,
          factSlug: isBase ? cat?.factSlug || v.factSlug : undefined,
          chain: isBase ? 'base' : 'stellar',
          addr: v.address,
        },
        __base: isBase,
        __cat: cat,
      }
    })
    const { survivors, dropped } = computeBasket(eligibilityAgents)
    dropped.forEach((d) =>
      addLog({
        event: 'VaultRejected',
        meta: (d.verdict.reasons || []).join('; '),
      })
    )
    reportPhase('Safety review')

    const amountFloat = Number(amountUnits) / 10 ** SOROBAN_DECIMALS
    const baseAllocations = []
    let baseUnits7Total = 0n
    for (const a of survivors.filter((s) => s.__base)) {
      if (!a.__cat) continue // never invent a bridge target outside the allowlisted catalog
      const units6 = BigInt(Math.max(0, Math.round(amountFloat * a.allocationFraction * 1e6)))
      if (units6 <= 0n) continue
      baseAllocations.push({
        address: a.__cat.address,
        proxyTarget: a.__cat.proxyTarget,
        factSlug: a.__cat.factSlug,
        venueKind: a.__cat.venueKind,
        chain: 'base',
        units: units6.toString(),
      })
      baseUnits7Total += units6 * 10n
    }
    // Defensive fail-closed clamp: a malformed AI response whose Base fractions alone exceed 1
    // must never produce a negative Stellar remainder.
    if (baseUnits7Total > amountUnits) {
      baseAllocations.length = 0
      baseUnits7Total = 0n
    }
    const stellarEligible = survivors.some((s) => !s.__base)
    // stellarUnits is DERIVED by subtraction, never independently re-estimated from its own
    // fraction -- guarantees stellarUnits + sum(baseAllocations.units)*10 === amountUnits exactly,
    // which is what PlanStage's own hard "did not match the amount you entered" check requires.
    const stellarUnits = stellarEligible ? (amountUnits - baseUnits7Total).toString() : '0'

    return {
      source,
      sourceState,
      stellarUnits,
      baseAllocations,
      review: { candidates: buildEligibilityReview({ survivors, dropped }) },
    }
  }

  async function onGenerate(input, reportPhase) {
    dispatchFlow({ type: 'PLAN_REQUESTED' })
    try {
      return await generateStrategyPlan(input, reportPhase)
    } catch (err) {
      dispatchFlow({ type: 'PLAN_FAILED', error: err?.message || 'Could not build a plan.' })
      throw err
    }
  }

  // Accepting a plan is the moment it becomes canonical AND opens Protect together (brief Step 2:
  // "Accepting plan enters Protect; current agent instructions are approved together") --
  // flowState.js's 3-moment granularity has no separate "reviewing" sub-phase, so PLAN_READY and
  // PROTECT_OPENED fire back to back here rather than at generation-resolve time (PlanStage builds
  // the canonical plan object internally; this is the first moment app.jsx ever sees it).
  function onAcceptPlan({ plan, fingerprint }) {
    const canonicalPlan = { ...plan, planFingerprint: fingerprint }
    dispatchFlow({ type: 'PLAN_READY', plan: canonicalPlan })
    dispatchFlow({ type: 'PROTECT_OPENED' })

    // Bridge into the surviving monitor-loop/resume/background-agent/agentVaultMeta cluster,
    // which all read the OLD per-agent `strategy` shape (mapVeniceToStrategy/buildStrategy's
    // shape) -- Task 13's "must not silently detach" obligation (app.jsx:659-3116) covers that
    // whole cluster, not just orchestrator events, and it is fed by `strategy` state, not `plan`.
    const viewModel = buildStrategyViewModel({
      plan: canonicalPlan,
      stellarVenue: stellarVenueDisplay,
    })
    const blended = viewModel.agents.reduce(
      (acc, a) => acc + (Number(a.vault.apy) || 0) * (a.allocation / (viewModel.total || 1)),
      0
    )
    setStrategy({
      agents: viewModel.agents,
      total: viewModel.total,
      blendedApy: blended.toFixed(1),
      risk: viewModel.risk,
      rationale: null,
      reward: null,
      mdpState: null,
    })
    const sk = {}
    viewModel.agents.forEach((a) => {
      sk[a.id] = { state: 'approved', skill: null }
    })
    setSkillStates(sk)
    setStrategyReached(['plan', 'protect'])
  }

  // ----- Protect: preflight, fresh grant, or reuse confirm -----
  function planAgentToAgentInit(agent, baseKernelAddress) {
    const isBridge = agent.kind === 'bridge'
    return {
      allocationId: agent.allocationId,
      cap: { token: agent.cap.token, units: agent.cap.units, decimals: agent.cap.decimals },
      token: agent.cap.token,
      target: isBridge ? STELLAR_TOKEN_MESSENGER_MINTER : SOROBAN_ACTIVE_VAULT_ADDRESS,
      kind: isBridge ? AGENT_KIND_BRIDGE : AGENT_KIND_DEPOSIT,
      mintRecipient: isBridge && baseKernelAddress ? evmAddrToBytes32(baseKernelAddress) : ZERO32,
      destinationDomain: isBridge ? CCTP_BASE_DOMAIN : 0,
      periodSeconds: agent.periodSeconds,
      expiry: agent.expiry,
    }
  }

  function planReviewedBudgets(planAgents) {
    const byToken = new Map()
    for (const agent of planAgents) {
      const cap = agent.cap
      const existing = byToken.get(cap.token)
      const existingUnits = existing ? BigInt(existing.units) : 0n
      byToken.set(cap.token, {
        token: cap.token,
        units: (existingUnits + BigInt(cap.units)).toString(),
        decimals: cap.decimals,
      })
    }
    return [...byToken.values()]
  }

  async function onConnectWallet() {
    const addr = installActiveWalletAccount(await connectActiveAccount()).address
    setConnectPhase('connected')
    return addr
  }

  async function onRetryPreflight({ durationSeconds }) {
    const plan = strategyFlowRef.current.plan
    const bridgeAgent = plan.agents.find((a) => a.kind === 'bridge')
    const baseKernel = bridgeAgent ? baseView.mandateView?.kernelAddress : null
    const agentInits = plan.agents.map((a) => planAgentToAgentInit(a, baseKernel))
    const reviewedBudgets = planReviewedBudgets(plan.agents)
    const captured = activeAccount
    try {
      const raw = await preflightPermission({
        runId: plan.runId,
        owner: realAddress,
        planFingerprint: plan.planFingerprint,
        agentInits,
        reviewedBudgets,
        durationSeconds,
        activeAccount: captured,
        getCurrentActiveAccount: () => activeAccountRef.current,
      })
      const composed = composeV3Decision(raw, { plan, reviewedBudgets, agentInits })
      const decision = toPermissionDecisionView(composed)
      dispatchFlow({ type: 'PREFLIGHT_READY', decision })
      return decision
    } catch (err) {
      dispatchFlow({
        type: 'PREFLIGHT_FAILED',
        error: err?.message || 'Could not check your permission. Try again.',
      })
      throw err
    }
  }

  function classifyPermissionFailure(err) {
    if (err instanceof PermissionPhaseError && err.phase !== 'fresh-grant') {
      // 'preflight' (structural plan/decision mismatch) and 'reuse-revalidation' (the world moved
      // since review) are both genuine staleness -- the reviewed decision no longer holds.
      return { kind: 'preflight', message: err.message }
    }
    // 'fresh-grant' PermissionPhaseErrors (grantFreshFromDecision wraps EVERYTHING, including a
    // real wallet rejection, as phase:'fresh-grant') and any plain Error are wallet-class from
    // ProtectStage's perspective: the reviewed permission is still good, only the signature/
    // submission attempt failed. Unwrapped to a plain Error so ProtectStage's own
    // `instanceof PermissionPhaseError` check (which only recognizes preflight/reuse-revalidation
    // staleness) never misclassifies a submission failure as staleness.
    const message = err?.message || 'The wallet request did not complete.'
    const rejected = /declin|reject|denied|cancel/i.test(message)
    return { kind: rejected ? 'rejected' : 'failed', message }
  }

  function requestPermissionConfirmation() {
    return new Promise((resolve, reject) => {
      pendingConfirmRef.current = { resolve, reject }
      runOrchestratorDispatch(strategyFlowRef.current.permission).catch((err) => {
        if (!pendingConfirmRef.current) return // already resolved via a grant-confirmed/reuse-confirmed event
        pendingConfirmRef.current = null
        const { kind, message } = classifyPermissionFailure(err)
        if (kind === 'preflight') {
          dispatchFlow({ type: 'PREFLIGHT_FAILED', error: message })
          // ProtectStage's own handleAuthorize distinguishes preflight-class staleness from a
          // plain wallet failure via `instanceof PermissionPhaseError` -- rejecting with a bare
          // Error here (as the wallet-class branches correctly do) would make EVERY failure look
          // wallet-class to ProtectStage, regardless of what classifyPermissionFailure decided.
          reject(
            err instanceof PermissionPhaseError
              ? err
              : new PermissionPhaseError({
                  phase: 'preflight',
                  code: 'VF_PERMISSION_STALE',
                  message,
                })
          )
        } else if (kind === 'rejected') {
          dispatchFlow({ type: 'WALLET_REJECTED', reason: message })
          reject(new Error(message))
        } else {
          dispatchFlow({ type: 'WALLET_FAILED', error: message })
          reject(new Error(message))
        }
      })
    })
  }

  function onRequestGrant() {
    dispatchFlow({ type: 'GRANT_REQUESTED' })
    return requestPermissionConfirmation()
  }

  function onConfirmReuse() {
    // No GRANT_REQUESTED here: REUSE_CONFIRMED's own gate only requires a reuse-mode
    // 'preflight-ready' decision, never a prior grant request (brief journey: "verified reuse
    // zero-confirmation path with no provider/grant builder call").
    return requestPermissionConfirmation()
  }

  // ----- Start: real orchestrator dispatch, live events, settled receipt -----
  function handleNewRunEvent(evName, data) {
    setRunEvents((prev) => [...prev, { name: evName, data }])

    // Custody-tracking translation (decision log #22, obligations A-C): the ONLY place real
    // producer event names/shapes get mapped onto flowState.js's vocabulary.
    if (evName === 'worker-queued') {
      dispatchFlow({ type: 'WORKER_QUEUED', allocationId: data.allocationId })
    } else if (evName === 'worker-started' || evName === 'started') {
      dispatchFlow({ type: 'WORKER_STARTED', allocationId: data.allocationId })
    } else if (evName === 'pull-confirmed') {
      dispatchFlow({ type: 'PULL_CONFIRMED', allocationId: data.allocationId })
    } else if (evName === 'completed') {
      dispatchFlow({ type: 'DEPOSIT_CONFIRMED', allocationId: data.allocationId })
    } else if (evName === 'failed') {
      dispatchFlow({ type: 'DEPOSIT_FAILED', allocationId: data.allocationId, error: data.error })
    } else if (evName === 'farm-burn-started') {
      dispatchFlow({
        type: 'BASE_JOB_UPDATED',
        allocationId: data.allocationId,
        status: 'submitted',
        jobId: null,
      })
    } else if (evName === 'farm-completed' && data.status === 'done') {
      dispatchFlow({
        type: 'BASE_JOB_UPDATED',
        allocationId: data.allocationId,
        status: 'bridged',
        jobId: data.jobId,
      })
    } else if (
      (evName === 'farm-completed' && data.status === 'error') ||
      evName === 'farm-failed' ||
      evName === 'baseleg-failed'
    ) {
      dispatchFlow({
        type: 'BASE_JOB_UPDATED',
        allocationId: data.allocationId,
        status: 'bridge-failed',
        jobId: data.jobId,
      })
    }

    // Resolves the ProtectStage-facing promise the INSTANT permission confirms -- before the run
    // settles, so Start can render live progress while dispatch continues in the background.
    if (evName === 'grant-confirmed' || evName === 'reuse-confirmed') {
      dispatchFlow({ type: evName === 'grant-confirmed' ? 'GRANT_CONFIRMED' : 'REUSE_CONFIRMED' })
      if (pendingConfirmRef.current) {
        pendingConfirmRef.current.resolve({ agentAddresses: data.agentAddresses || [] })
        pendingConfirmRef.current = null
      }
    }

    // Feeds the SAME surviving force-graph/memory/keeper cluster the legacy onEvent handler fed
    // (brief Step 2: "must not silently detach"). Keyed directly by allocationId -- every real
    // producer already carries it, so no hex-agentId translation layer is needed here.
    if (evName === 'AgentScopeAuthorized') {
      const summary = scopeSummary({
        agent: data.agent,
        vault: data.vault,
        token: data.token,
        capPerPeriod: BigInt(data.capPerPeriod),
        periodDuration: data.periodDuration,
        expiry: data.expiry,
        nowSec: Math.floor(Date.now() / 1000),
      })
      setScopes((prev) => {
        const next = prev.filter((s) => s.agent?.toLowerCase() !== data.agent?.toLowerCase())
        return [
          ...next,
          { ...summary, agentId: data.agentId, revoked: false, authorized: data.authorized },
        ]
      })
      return
    }
    const dId = data?.allocationId
    if (
      dId &&
      (evName === 'worker-queued' || evName === 'worker-started' || evName === 'started')
    ) {
      setExecMap((prev) => {
        const cur = prev[dId] || makeInitialExecState([{ id: dId }])[dId]
        return {
          ...prev,
          [dId]: { ...cur, status: 'running', activeStep: cur.activeStep || 'swap' },
        }
      })
    }
    if (dId && evName === 'step') {
      const stepName = WORKER_STEP_MAP[data.step]
      if (stepName) {
        const stepStatus =
          data.status === 'done' ? 'confirmed' : data.status === 'skipped' ? 'skipped' : 'running'
        setExecMap((prev) => {
          const cur = prev[dId] || {}
          return {
            ...prev,
            [dId]: {
              ...cur,
              activeStep: stepName,
              steps: { ...(cur.steps || {}), [stepName]: stepStatus },
            },
          }
        })
      }
    }
    if (dId && evName === 'completed') {
      setExecMap((prev) => {
        const cur = prev[dId] || {}
        return {
          ...prev,
          [dId]: {
            ...cur,
            status: 'confirmed',
            activeStep: null,
            steps: { ...(cur.steps || {}), approve: 'confirmed', deposit: 'confirmed' },
            metrics: { ...(cur.metrics || {}), completedAt: Date.now(), successRate: 100 },
          },
        }
      })
      addLog({
        event: 'AgentCompleted',
        agent: dId,
        meta: data.txHash
          ? `Transaction ${shortAddr(data.txHash)}`
          : 'Completed. No transaction hash.',
      })
    }
    if (dId && evName === 'failed') {
      setExecMap((prev) => {
        const cur = prev[dId] || {}
        return {
          ...prev,
          [dId]: {
            ...cur,
            status: 'failed',
            activeStep: null,
            metrics: { ...(cur.metrics || {}), completedAt: Date.now(), successRate: 0 },
          },
        }
      })
      addLog({ event: 'AgentFailed', agent: dId, meta: data.error })
    }
    if (dId && (evName.startsWith('baseleg-') || evName.startsWith('farm-'))) {
      const upd = mapBaseLegEvent(evName, data)
      if (upd) {
        setExecMap((prev) => {
          const cur = prev[dId] || makeInitialExecState([{ id: dId }])[dId]
          const terminal = upd.status === 'completed' || upd.status === 'failed'
          return {
            ...prev,
            [dId]: {
              ...cur,
              status: upd.status || cur.status || 'running',
              activeStep: terminal ? null : upd.step || cur.activeStep,
              steps: upd.step ? { ...(cur.steps || {}), [upd.step]: upd.stepStatus } : cur.steps,
              hashes: upd.hash
                ? { ...(cur.hashes || {}), [upd.step || 'swap']: upd.hash }
                : cur.hashes,
              memory: [...(cur.memory || []), { ...upd.memory, t: nowT() }],
            },
          }
        })
        if (upd.log)
          addLog({ event: upd.log, agent: dId, meta: `${upd.memory.title} — ${upd.memory.meta}` })
      }
    }
  }

  async function runOrchestratorDispatch(permissionDecision) {
    const plan = strategyFlowRef.current.plan
    const baseAllocations = baseMandateAllocationsForPlan(plan)
    if (baseAllocations.length > 0) {
      const record = readBaseMandate(realAddress)
      const reviewedEvidence = baseView.mandateView?.evidence ?? null
      for (const allocation of baseAllocations) {
        let currentEvidence = null
        try {
          currentEvidence = await getMandateStatus(record?.serializedApproval, {
            stellarOwner: realAddress,
            kernelAddress: record?.kernelAddress,
            allocation,
          })
        } catch {
          currentEvidence = null
        }
        if (baseMandateRequiresReview(reviewedEvidence, currentEvidence)) {
          setBaseView((previous) => ({
            ...previous,
            healthy: false,
            mandateView: {
              ...(previous?.mandateView || {}),
              ready: false,
              status: currentEvidence?.status || 'unavailable',
              evidence: currentEvidence,
            },
          }))
          setStrategyReached(['plan'])
          throw new PermissionPhaseError({
            phase: 'preflight',
            code: 'VF_BASE_MANDATE_CHANGED',
            message: 'Base mandate evidence changed. Rebuild and review the plan before granting.',
          })
        }
      }
    }
    const sessionId = `session-${runId}`
    const captured = activeAccount
    assertActiveAccount(captured)
    activeOrchestrationRef.current?.cancel()
    const epochRun = createEpochBoundRun({
      captured,
      getCurrent: () => activeAccountRef.current,
      onEvent: handleNewRunEvent,
    })
    activeOrchestrationRef.current = epochRun
    setExecMap((prev) => ({
      ...prev,
      ...makeInitialExecState(plan.agents.map((a) => ({ id: a.allocationId }))),
    }))
    setRunEvents([])
    setRecoveryByAllocation({})
    setRecoveryPendingAllocations(new Set())
    recoveryMappingsRef.current = new Map()

    const orch = new OrchestratorAgent({
      user: realAddress,
      activeAccount: captured,
      getCurrentActiveAccount: () => activeAccountRef.current,
      signal: epochRun.signal,
      veniceAuth,
      devApiKey: devApiKey || null,
      sessionId,
      baseLegContext: buildBaseLegContext({
        connectedAddress: realAddress,
        kitSignTransaction: (xdr) => signWithTimeout(xdr, 'cross-chain leg'),
      }),
      onEvent: epochRun.onEvent,
    })

    const dispatchPromise = orch.dispatch(plan, { permissionDecision }).then(async (summary) => {
      epochRun.assertCurrent()
      addLog({
        event: 'OrchestratorPlanned',
        meta: `Completed: ${summary.completed ?? 0} deposited, ${summary.failed ?? 0} failed.`,
      })
      const addrs = summary.permission?.agentAddresses || []
      deployedAgentsRef.current = addrs
      if (addrs.length) saveDeployedAgents(realAddress, addrs)
      // dispatchPermissioned's pure-Stellar branch never builds a receipt (only the mixed/bridge
      // branch does, via buildDispatchReceipt) -- build one here so StrategyReceipt always gets a
      // real DispatchReceiptV1, never a shape that only exists for runs with a Base leg.
      const receipt =
        summary.receipt ||
        buildDispatchReceipt({
          plan,
          permission: summary.permission,
          branches: {
            stellar: { results: summary.results || [] },
            base: { status: undefined, results: [] },
          },
        })
      try {
        recoveryMappingsRef.current = buildRecoveryAllocationMappings({
          plan,
          confirmedPermission: receipt.permission,
          reviewedPermission: permissionDecision,
          owner: realAddress,
        })
      } catch (error) {
        recoveryMappingsRef.current = new Map()
        addLog({
          event: 'AgentFailed',
          meta: `Recovery mapping unavailable: ${error?.message || error}`,
        })
      }
      setRunReceipt(receipt)
      if (summary.baseLeg) {
        const outcome = applyBaseLegOutcome(summary.baseLeg, { stellarOwner: realAddress })
        if (outcome) addLog(outcome)
        if (summary.baseLeg.success) {
          loadDeviceBasePositions({ stellarOwner: realAddress }).then((bp) =>
            epochRun.commit(() => setBasePositions(bp))
          )
        }
      }
      // Reuses the proven position-reconciliation/council-reflect logic (setStage('done') included)
      // rather than duplicating it -- the OLD per-agent `strategy` shape it reads is the same one
      // onAcceptPlan already bridged from the canonical plan.
      await handleExecDone(epochRun.assertCurrent)
      epochRun.assertCurrent()
      return summary
    })
    dispatchPromise.catch((err) => {
      if (!epochRun.commit(() => {})) return
      if (pendingConfirmRef.current) return // surfaced via requestPermissionConfirmation's own catch
      // A post-confirm failure (e.g. a relay outage mid-run) stays on Start and ends in an
      // aggregate receipt -- never bounces back to Protect (brief: "post-grant branch failures
      // stay Start and end in aggregate receipt").
      console.warn('[app] run failed after confirmation:', err?.message || err)
      addLog({ event: 'AgentFailed', meta: `Run failed: ${err?.message || err}` })
      setStage('done')
    })
    const clearActiveRun = () => {
      if (activeOrchestrationRef.current === epochRun) activeOrchestrationRef.current = null
    }
    dispatchPromise.then(clearActiveRun, clearActiveRun)
    return dispatchPromise
  }

  // Project every failed settled lane from durable evidence. Base children deliberately receive
  // only a blocked display projection; no Stellar identity mapping is ever created for them.
  useE(() => {
    const plan = strategyFlow.plan
    const captured = activeAccount
    if (!runReceipt || !plan || captured?.version !== 1) return undefined
    let alive = true
    const parentByChild = new Map()
    for (const agent of plan.agents || []) {
      if (agent.kind !== 'bridge') continue
      for (const child of agent.children || []) parentByChild.set(child.allocationId, agent)
    }
    Promise.all(
      (runReceipt.allocations || [])
        .filter((outcome) => outcome?.executionStatus === 'failed')
        .map(async (outcome) => {
          const parent = parentByChild.get(outcome.allocationId)
          if (parent) {
            return [
              outcome.allocationId,
              projectRecoveryReceipt({
                receipt: null,
                version: 0,
                identity: {
                  executionId: `${plan.runId}:exec:${outcome.allocationId}`,
                  allocationId: outcome.allocationId,
                  parentAllocationId: parent.allocationId,
                  childId: outcome.allocationId,
                },
                baseResult: {
                  allocationId: outcome.allocationId,
                  jobId: outcome.evidence?.jobId ?? null,
                },
                strandedBridge:
                  outcome.custody?.location === 'agent'
                    ? {
                        pulled: true,
                        bridgeAgentAddress: outcome.evidence?.bridgeAgentAddress ?? null,
                      }
                    : null,
              }),
            ]
          }
          const mapping = recoveryMappingsRef.current.get(outcome.allocationId)
          if (!mapping) {
            return [
              outcome.allocationId,
              {
                action: 'manual-review',
                phase: null,
                reason: 'The authoritative in-memory agent mapping is unavailable.',
                route: { allocationId: outcome.allocationId, source: 'unmapped' },
              },
            ]
          }
          try {
            const authoritative = await readRecoveryReceipt({
              networkId: mapping.networkId,
              owner: mapping.owner,
              executionId: mapping.executionId,
              allocationId: mapping.allocationId,
            })
            assertCurrentActiveAccount({ captured, current: activeAccountRef.current })
            return [
              outcome.allocationId,
              projectRecoveryReceipt({ ...authoritative, identity: mapping }),
            ]
          } catch (error) {
            return [
              outcome.allocationId,
              {
                action: 'manual-review',
                phase: null,
                reason: error?.message || 'Recovery evidence could not be read.',
                route: { allocationId: outcome.allocationId, source: 'read-failed' },
              },
            ]
          }
        })
    ).then((entries) => {
      if (!alive || activeAccountRef.current !== captured) return
      setRecoveryByAllocation(Object.fromEntries(entries))
    })
    return () => {
      alive = false
    }
  }, [runReceipt, strategyFlow.plan, activeAccount])

  if (!recoveryRunnerRef.current) {
    recoveryRunnerRef.current = createRecoveryActionRunner({
      getActiveAccount: () => activeAccountRef.current,
      getProjection: (allocationId) => recoveryByAllocationRef.current[allocationId],
      getMapping: (allocationId) => recoveryMappingsRef.current.get(allocationId),
      getPermission: () => strategyFlowRef.current.permission,
      recoverAllocation: async (args) => {
        const captured = activeAccountRef.current
        assertCurrentActiveAccount({ captured, current: activeAccountRef.current })
        const orchestrator = new OrchestratorAgent(
          createAccountScopedRecoveryConfig({
            captured,
            getCurrent: () => activeAccountRef.current,
            sessionId: `session-${strategyFlowRef.current.plan?.runId || runId}-recovery`,
            onEvent: handleNewRunEvent,
          })
        )
        return orchestrator.recoverAllocation(args)
      },
      onProjection: (allocationId, projected) =>
        setRecoveryByAllocation((previous) => ({
          ...previous,
          [allocationId]: projected,
        })),
      onPending: (allocationId, pending) =>
        setRecoveryPendingAllocations((previous) => {
          const next = new Set(previous)
          if (pending) next.add(allocationId)
          else next.delete(allocationId)
          return next
        }),
      onError: (error, allocationId) =>
        addLog({
          event: 'AgentFailed',
          agent: allocationId,
          meta: `Recovery: ${error?.message || error}`,
        }),
      leaseOwner: recoveryLeaseOwnerRef.current,
      vault: SOROBAN_ACTIVE_VAULT_ADDRESS,
    })
  }

  async function onRecoverAllocation(allocationId) {
    try {
      return await recoveryRunnerRef.current.run(allocationId)
    } catch {
      return null
    }
  }

  // Task 10, carried finding C2: /agent is now the crew route (below), so "Back to my money"
  // must land on /home -- leaving this pointed at /agent would put it on the exact same screen
  // "Watch the crew" (onViewCrew, below) already opens.
  function onViewMoney() {
    navigate('/home')
  }

  function onMakeAnotherDeposit() {
    handleAgain()
  }

  // ProtectStage's "Edit plan" -- flowState.js's moments only move forward by design (its own
  // header: "the moment machine's whole job is refusing to move forward"), so there is no
  // reducer-safe way to step Protect back to Plan while preserving the reviewed plan. Resetting to
  // a fresh Plan review is the one option that violates no invariant; STRATEGY_RESET is the
  // app-local wrapper event added above for exactly this.
  function onEditPlan() {
    dispatchFlow({ type: 'STRATEGY_RESET' })
    setStrategyReached(['plan'])
  }

  function onNavigateStrategyStage(stepId) {
    if (stepId === 'plan' && strategyFlowRef.current.moment !== 'plan') {
      onEditPlan()
    }
  }

  // The route's public state is only Plan, Protect, Start, or receipt (brief's Interfaces
  // section) — `strategyFlow.moment` drives which of the three stages renders; StartStage renders
  // StrategyReceipt itself once `receipt` is non-null (StartStage.jsx's own composition).
  // I1 fix (fix loop 1): the wrapper markup itself now lives in exactly one place,
  // StrategyRoute.jsx — this just supplies the real props per stage.
  function renderStrategyRoute() {
    return (
      <StrategyRoute
        stage={strategyFlow.moment}
        reached={strategyReached}
        onNavigateStage={onNavigateStrategyStage}
        plan={strategyFlow.plan}
        vaultTotalShares={vaultTotalShares}
        stellarVenue={stellarVenueDisplay}
        base={baseView}
        runId={runId}
        onGenerate={onGenerate}
        onRetryLive={onGenerate}
        onAcceptPlan={onAcceptPlan}
        onConnectForBase={onConnectForBase}
        onSetupBase={onSetupBase}
        onRebuildPlan={onRebuildPlan}
        protectProps={{
          owner: realAddress,
          baseMandateView: baseView.mandateView,
          onConnectWallet,
          onRetryPreflight,
          onRequestGrant,
          onConfirmReuse,
          onEditPlan,
        }}
        startProps={{
          permission: strategyFlow.permission,
          events: runEvents,
          receipt: runReceipt,
          runId,
          stellarVenue: stellarVenueDisplay,
          recoveryByAllocation,
          recoveryPendingAllocations,
          onRecoverAllocation,
          onViewMoney,
          onMakeAnotherDeposit,
          // Task 7 (Pocket Crew design alignment) -- the done-state "Watch the crew" action.
          // Task 10 makes /agent the crew route (below) and /home the money route (onViewMoney
          // above) -- the two buttons are genuinely distinct destinations now, not a duplicate.
          onViewCrew: () => navigate('/agent'),
        }}
      />
    )
  }

  // Chain balances can lag 1-2 blocks after a deposit. Retry until at least one
  // vault reports a non-zero balance, then trust the on-chain numbers.
  async function reconcileWithRetry(address, maxAttempts = 3, delayMs = 3000, agents) {
    const agentList = agents?.length ? agents : undefined
    for (let i = 0; i < maxAttempts; i++) {
      let result = null
      try {
        result = agentList
          ? await reconcilePositionsFromChain(address, { agents: agentList })
          : await reconcilePositions(address)
      } catch {
        result = null
      }
      if (result && Object.values(result).some((p) => BigInt(p.balance || '0') > 0n)) {
        return result
      }
      if (i < maxAttempts - 1) await new Promise((r) => setTimeout(r, delayMs))
    }
    return null
  }

  /* ----- DONE (step 06) ----- */
  const handleExecDone = async (assertCurrent = () => {}) => {
    assertCurrent()
    setStage('done')
    // ACE loop: credit/debit the rules the council cited at review time, based on
    // how the deposit actually went. Closes review → deposit → reflect end-to-end.
    const { citedRules, verdict } = councilCitedRef.current
    if (verdict === 'keep' && citedRules.length) {
      assertCurrent()
      const outcome = councilOutcome(execMap, strategy?.agents || [])
      reflect({ verdict, citedRules, outcome }, { increment: playbookIncrement })
      addLog({
        event: 'OrchestratorPlanned',
        meta: `Council reflect, ${outcome}, ${citedRules.join(', ')}`,
      })
    }
    // Allocation-based FALLBACK only — used when the chain read is unavailable (no RPC)
    // or a vault reads 0 (deposit tx not yet mined). Stored in raw token
    // 7-dp base units (allocation USDC * 1e7); display divides by 1e7 (toDisplay).
    const seedPositions = {}
    ;(strategy?.agents || []).forEach((a) => {
      if (execMap[a.id]?.status === 'confirmed') {
        const addr = a.vault.addr
        const prev = seedPositions[addr]
        const prevBal = BigInt(prev?.balance || '0')
        const newBal = toBaseUnits(a.allocation)
        seedPositions[addr] = {
          vaultName: a.vault.name,
          balance: (prevBal + newBal).toString(), // sum if multiple agents target same vault
          unclaimedRewards: prev?.unclaimedRewards || '0',
        }
      }
    })
    // SOURCE OF TRUTH: actual on-chain balanceOf -> convertToAssets (raw units).
    // If chain is available, use authoritative balances (can move up or down).
    // If chain unavailable (RPC down / tx not yet mined), ADD seed into existing
    // positions — these are confirmed new deposits, so we sum, not take max.
    const chain = await reconcileWithRetry(realAddress, 3, 3000, deployedAgentsRef.current)
    assertCurrent()
    if (chain) {
      const finalPositions = mergePositions(seedPositions, chain)
      if (Object.keys(finalPositions).length > 0) {
        setAgentData((d) => ({
          ...d,
          positions: applyChainPositions(d.positions, finalPositions),
          lastUpdated: Date.now(),
        }))
      }
    } else if (Object.keys(seedPositions).length > 0) {
      // Chain unavailable: sum new allocations into existing positions
      setAgentData((d) => {
        const positions = { ...(d.positions || {}) }
        for (const [addr, pos] of Object.entries(seedPositions)) {
          const key =
            Object.keys(positions).find((k) => k.toLowerCase() === addr.toLowerCase()) || addr
          const curBal = BigInt(positions[key]?.balance || '0')
          const newBal = BigInt(pos.balance || '0')
          positions[key] = {
            vaultName: pos.vaultName,
            unclaimedRewards: positions[key]?.unclaimedRewards || pos.unclaimedRewards || '0',
            balance: (curBal + newBal).toString(),
          }
        }
        return { ...d, positions, lastUpdated: Date.now() }
      })
    }
    const agentAddrs = deployedAgentsRef.current
    assertCurrent()
    if (agentAddrs?.length) saveDeployedAgents(realAddress, agentAddrs)

    addLog({
      event: 'OrchestratorPlanned',
      meta: `Multi-agent deployment completed. ${agentAddrs?.length || 0} agents saved, ${strategy?.agents?.length} positions opened.`,
    })
  }

  const handleAgain = (overrideAmount) => {
    setStage('strategy')
    navigate('/strategy')
    setFurthest(0)
    setStrategy(null)
    setSkillStates({})
    setConnectPhase('idle')
    setConnectError(null)
    setPermActive(false)
    setPermExpiresAt(null)
    clearResume(realAddress)
    setSessionResumed(false)
    setVeniceAuth(null)
    setMarketLive(null)
    setVaultLive(null)
    setExecMap({})
    setLogs([])
    agentMapRef.current = {}

    // Strategy Task 13 — reset the new Plan/Protect/Start machinery too, so "Start over"/"Make
    // another deposit" always begins a genuinely fresh run rather than reopening the settled one.
    dispatchFlow({ type: 'STRATEGY_RESET' })
    setStrategyReached(['plan'])
    setRunEvents([])
    setRunReceipt(null)
    setRecoveryByAllocation({})
    setRecoveryPendingAllocations(new Set())
    recoveryMappingsRef.current = new Map()
    setRunId(`run-${Date.now()}`)
    baseSetupSucceededRef.current = false
    pendingConfirmRef.current = null

    // Fix loop 1 (C1): the old ceremony's strategyPhase/thinkingPhase 'thinking'-timer kickoff for
    // an overridden amount was deleted along with the rest of that flow — PlanStage now owns
    // amount entry and generation. Still worth carrying a caller-supplied amount into the fresh
    // Plan surface rather than silently discarding it.
    if (
      overrideAmount !== undefined &&
      overrideAmount !== null &&
      (typeof overrideAmount === 'number' ||
        typeof overrideAmount === 'string' ||
        !isNaN(Number(overrideAmount)))
    ) {
      setAmount(String(overrideAmount))
    }
  }

  const handleRevoke = () => {
    setPermActive(false)
    setPermExpiresAt(null)
    clearResume(realAddress)
    setSessionResumed(false)
    ;(strategy?.agents || []).forEach((a) =>
      addLog({ event: 'PermissionRevoked', agent: a.id, meta: 'Agent halted. Scope cleared.' })
    )
  }

  /* ----- Settings handlers ----- */
  const handleLanguageChange = (lang) => {
    setLanguage(lang)
    saveSetting('language', lang)
  }
  const handleDisconnect = () => {
    stopBackgroundAgent()
    installActiveWalletAccount(null)
    setConnectPhase('idle')
    setPermActive(false)
    setPermExpiresAt(null)
    setScopes([]) // else wallet A's rehydrated rows linger when wallet B connects
    setVeniceAuth(null)
    clearResume(realAddress)
    setSessionResumed(false)
    addLog({ event: 'PermissionRevoked', meta: 'Wallet disconnected. Session cleared.' })
  }
  const handleResetAgentSettings = () => {
    setAgentSettings({ ...AGENT_SETTINGS_DEFAULTS })
    setAgentEnabled(true)
  }
  const handleResetSkill = () => {
    clearUserSkill()
    setSkillSource('default')
  }

  const walletPhase =
    connectPhase === 'idle' || connectPhase === 'connecting'
      ? 'none'
      : connectPhase === 'upgraded'
        ? 'upgraded'
        : 'eoa'

  // APY/meta per vault for the agent dashboard (positions events don't carry APY)
  const agentVaultMeta = {}
  ;(strategy?.agents || []).forEach((a) => {
    agentVaultMeta[a.vault.addr.toLowerCase()] = {
      apy: Number(a.vault.apy),
      protocol: a.vault.protocol,
    }
  })

  // My Money Task 13 Part B: the vf-autofarm keeper/strategy/pool force-graph cluster (Task 15,
  // buildAutofarmGraphData) that used to be memoized here fed OpsConsole's own AgentGraph only --
  // retired along with it (no reader anywhere in the production route tree). Item 8's real agent
  // network graph lives in TechnicalMoneyDetails.jsx instead, built from `agents`/`model` (props
  // that component already receives), not this vault-wide automation topology.

  // Public pages — standalone full-bleed, own NavBar, no wallet required.
  // Checked before every gate so judges and visitors can browse without connecting.
  if (location.pathname === '/explorer') {
    return (
      <>
        <SkipLink />
        {/* RouteFocus sits INSIDE the Suspense, after the lazy page -- both commit together only
            once the chunk resolves, so its effect never fires while <main> doesn't exist yet
            (the loading fallback has no landmark at all). Mounting it outside would run the
            focus effect immediately against the fallback and silently find nothing. */}
        <Suspense fallback={<div className="route-loading" aria-busy="true" />}>
          <ExplorerPage />
          <RouteFocus pathname={location.pathname} />
        </Suspense>
      </>
    )
  }
  if (location.pathname === '/ecosystem') {
    return (
      <>
        <SkipLink />
        <Suspense fallback={<div className="route-loading" aria-busy="true" />}>
          <EcosystemPage />
          <RouteFocus pathname={location.pathname} />
        </Suspense>
      </>
    )
  }
  if (location.pathname === '/replay') {
    return (
      <>
        <SkipLink />
        <Suspense fallback={<div className="route-loading" aria-busy="true" />}>
          <ReplayPage />
          <RouteFocus pathname={location.pathname} />
        </Suspense>
      </>
    )
  }

  // Landing takeover — first-time, not-yet-connected visitors see the scroll
  // hero before anything else. "Start farming" persists yv_skip_landing and
  // sets the URL to /strategy, which surfaces once onboarding (connect) completes.
  if (!skipLanding && !realAddress) {
    return (
      <>
        <SkipLink />
        <Suspense fallback={<div className="route-loading" aria-busy="true" />}>
          <LandingHero
            onStart={() => {
              localStorage.setItem('yv_skip_landing', 'true')
              localStorage.setItem('yv_onboarded', 'true')
              setSkipLanding(true)
              setOnboarded(true)
              navigate('/strategy')
            }}
          />
          <RouteFocus pathname={location.pathname} />
        </Suspense>
      </>
    )
  }

  // APY-first onboarding — full-screen takeover for first-time users (not yet onboarded).
  // Screen 1 (value prop, no wallet) → connect → Screen 2 (how it works) → main app.
  // "Skip intro" or "Got it" persists yv_onboarded=true so it never shows again.
  if (!onboarded) {
    return (
      <>
        <SkipLink />
        <RouteFocus pathname={location.pathname} />
        <OnboardingFlow
          connected={!!realAddress}
          onConnect={handleConnect}
          onComplete={() => {
            localStorage.setItem('yv_onboarded', 'true')
            setOnboarded(true)
          }}
        />
      </>
    )
  }

  // My Money Task 13: automation-evidence labels for HowMoneyWorks, and the Base withdraw preview
  // for WithdrawDialog's "base" tab -- all derived from state this app already polls every 15s,
  // never a second fetch of its own.
  const moneyKeeper = classifyKeeperAutomation({
    events: toKeeperHeartbeatEvents(keeperActivity),
    now: Date.now(),
  })
  const moneyStrategyConfig = classifyStrategyConfiguration({
    pricePerShare: autofarmReads.pricePerShare,
  })
  const moneyRiskWatch = describeRiskWatchProvenance({
    owner: realAddress,
    networkId: 'stellar-testnet',
  })
  const moneyBasePlan = { available: basePositions.length > 0, positions: basePositions }
  const moneyStopAccessAgent =
    moneyRead?.agents?.find((a) => a.address === moneyStopAccessAddress) ?? null
  // Fix round 1, M9: this MUST stay byte-identical to CrewRoute.jsx's own `activeCount` predicate
  // (`!a?.scope?.value?.revoked && !a?.problems?.length`) -- the badge used to count only
  // `!revoked`, so an agent with problems made the rail say one more than the crew page's own
  // "Working for you" stat for the exact same word, "active".
  const activeAgentCount = (moneyRead?.agents ?? []).filter(
    (a) => !a?.scope?.value?.revoked && !a?.problems?.length
  ).length

  return (
    <div
      className={`app ${sbExtended ? 'sb-extended' : 'sb-minimized'} ${railCollapsed ? 'rail-collapsed' : ''}`}
    >
      <SkipLink />
      <Sidebar extended={sbExtended} onToggle={toggleSb} agentCount={activeAgentCount} />
      <main id="main-content" className="main" tabIndex={-1}>
        <RouteFocus pathname={location.pathname} />
        <TopBar
          onReset={handleAgain}
          railCollapsed={railCollapsed}
          onToggleRail={toggleRail}
          notifications={
            <NotificationCenter
              alerts={agentData.alerts}
              settings={agentSettings}
              positions={agentData.positions}
              userAddress={realAddress}
              onEmergencyWithdraw={handleEmergencyWithdraw}
              onReview={handleReviewRebalance}
              onDismiss={dismissAlert}
            />
          }
        />
        <Routes>
          <Route path="/" element={<Navigate to="/home" replace />} />
          <Route
            path="/home"
            element={
              <>
                {sessionResumed && (
                  <div className="pc-resumed-banner" role="status">
                    <span>Session resumed — reconnected your wallet.</span>
                    {/* Fix round 1, F3: a classless <button> inherits style.css's `border: none;
                        background: none` reset -- no padding, no min-height, no visible
                        affordance, and no zero-specificity :where(...) 44px floor catches it here.
                        `.pc-button pc-button--secondary` is the same control class
                        StopAccessDialog.jsx:61 already uses, and MyMoneyRoute (my-money.css) is
                        always co-rendered with this banner on /home, so the class is guaranteed
                        loaded whenever this button is. */}
                    <button
                      type="button"
                      className="pc-button pc-button--secondary"
                      onClick={() => setSessionResumed(false)}
                    >
                      Dismiss
                    </button>
                  </div>
                )}
                <MyMoneyRoute
                  model={moneyModel}
                  agents={moneyRead?.agents ?? []}
                  discovery={moneyDiscovery}
                  account={moneyAccountValue}
                  keeper={moneyKeeper}
                  strategyConfig={moneyStrategyConfig}
                  riskWatch={moneyRiskWatch}
                  onAction={handleMoneyPrimaryAction}
                  onRecoverAgent={handleRecoverAgent}
                  onRecoverBase={handleRecoverBaseAccount}
                  actionPending={moneyActionPending}
                />
              </>
            }
          />
          <Route
            path="/strategy"
            element={
              // Fix loop 1 (C1): the old six-step StepRail/renderStage() ceremony used to be
              // gated here on isDevMode() — but isDevMode() resolves ?dev=1 from the live URL at
              // runtime (devFlag.js), so that gate was reachable on a deployed production build,
              // not just in dev. Deleted the ceremony outright (renderStage/goBack/jumpTo and
              // every handler that only they called) rather than re-gating it on a stricter
              // check — the route's only production output is the real Plan/Protect/Start
              // surface.
              renderStrategyRoute()
            }
          />
          <Route
            path="/agent"
            element={
              <CrewRoute
                agents={moneyRead?.agents ?? []}
                model={moneyModel}
                keeper={moneyKeeper}
                keeperEvents={keeperActivity}
                decisions={crewDecisions}
                onRenewMandate={() => handleMoneyPrimaryAction('renew-protection')}
                onCancelAgent={(address) => setMoneyStopAccessAddress(address)}
                onStartStrategy={() => navigate('/strategy')}
                actionPending={moneyActionPending}
              />
            }
          />
          {/* The legacy routes below opt into `.pc-route` (pocket-crew.css) so their content column
              is the same width, centred the same way and inset by the same gutter as My money,
              Put it to work and The crew -- until now each rendered at whatever width its own markup
              happened to produce. It also buys them scrolling: `.main` is `overflow: hidden`
              (style.css) and only `.main:has(.pc-route)` unclips it, which is why a tall legacy route
              could previously run past the viewport with nothing to scroll. */}
          <Route
            path="/history"
            element={
              <div className="pc-route">
                <HistoryPanel connectedAddress={realAddress} />
              </div>
            }
          />
          <Route
            path="/settings"
            element={
              <div className="pc-route-flush">
                <SettingsPage
                  userAddress={realAddress}
                  walletPhase={walletPhase}
                  permActive={permActive}
                  permExpiresAt={permExpiresAt}
                  permissionCount={strategy?.agents?.length || 0}
                  agentEnabled={agentEnabled}
                  setAgentEnabled={setAgentEnabled}
                  agentSettings={agentSettings}
                  setAgentSettings={setAgentSettings}
                  skillSource={skillSource}
                  language={language}
                  onLanguageChange={handleLanguageChange}
                  onChangeSkill={() => setSkillDrawerOpen(true)}
                  onResetSkill={handleResetSkill}
                  onResetAgentSettings={handleResetAgentSettings}
                  onConnect={handleConnect}
                  onDisconnect={handleDisconnect}
                  onRevoke={handleRevoke}
                  addLog={addLog}
                />
              </div>
            }
          />
          <Route
            path="/vault/:protocol"
            element={
              <div className="pc-route">
                <VaultDetailPage positions={agentData.positions} />
              </div>
            }
          />
          <Route
            path="/tx/:txHash"
            element={
              <div className="pc-route">
                <TxDetailPage />
              </div>
            }
          />
          <Route
            path="/developers/*"
            element={
              <Suspense fallback={<div className="route-loading" aria-busy="true" />}>
                {/* Inside the Suspense boundary, so the wrapper commits with the lazy chunk rather
                    than framing an empty fallback. */}
                <div className="pc-route">
                  <DevelopersLayout />
                </div>
              </Suspense>
            }
          />
          <Route path="/farm" element={<Navigate to="/home" replace />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
        {/* Task 10 (IA remap): these three overlays are open-state-driven, not route-scoped --
            hoisted out of any single Route so they work identically from /home (MyMoneyRoute) and
            /agent (CrewRoute); e.g. StopAccessDialog's "go to withdraw" and CrewRoute's cancel
            action both open them regardless of which route triggered it. */}
        <WithdrawDialog
          open={moneyWithdrawOpen}
          onClose={() => setMoneyWithdrawOpen(false)}
          agents={moneyRead?.agents ?? []}
          discovery={moneyDiscovery}
          account={moneyAccountValue}
          basePlan={moneyBasePlan}
          pending={moneyActionPending}
          onConfirmFull={handleConfirmFullExit}
          onConfirmPartial={handleConfirmPartialExit}
          onConfirmBase={handleConfirmBaseWithdraw}
        />
        <StopAccessDialog
          open={Boolean(moneyStopAccessAddress)}
          onClose={() => setMoneyStopAccessAddress(null)}
          agent={moneyStopAccessAgent}
          shareRead={moneyStopAccessAgent?.vaultShares}
          idleBalanceRead={moneyStopAccessAgent?.idleToken}
          account={moneyAccountValue}
          pending={moneyActionPending}
          onConfirmRevoke={handleConfirmRevoke}
          onGoToWithdraw={() => {
            setMoneyStopAccessAddress(null)
            setMoneyWithdrawOpen(true)
          }}
        />
        <RecoveryPanel
          open={Boolean(moneyRecovery)}
          onClose={() => setMoneyRecovery(null)}
          location={moneyRecovery?.location}
          amount={moneyRecovery?.amount}
          agentAddress={moneyRecovery?.action?.agentAddress}
          strandedBridge={moneyRecovery?.strandedBridge}
          submission={moneyRecovery?.submission}
          reconciled={moneyRecovery?.reconciled}
          pending={moneyActionPending}
          onRecoverViaFullExit={() => {
            setMoneyRecovery(null)
            setMoneyWithdrawOpen(true)
          }}
          onGoToBaseWithdraw={() => {
            setMoneyRecovery(null)
            handleBaseWithdrawClick()
          }}
          onCheckStatus={handleCheckSubmissionStatus}
          onRetry={handleRetrySubmission}
        />
      </main>
      <aside className="rail">
        <WalletPanel phase={walletPhase} address={realAddress} />
        <PermissionPanel
          active={permActive}
          strategy={strategy}
          onRevoke={handleRevoke}
          expiresAt={permExpiresAt}
        />
        <ActivityPanel logs={logs} />
        <SkillPanel
          skillSource={skillSource}
          marketLive={marketLive}
          vaultLive={vaultLive}
          onCustomize={() => setSkillDrawerOpen(true)}
        />
      </aside>

      <SkillDrawer
        open={skillDrawerOpen}
        onClose={() => setSkillDrawerOpen(false)}
        skillSource={skillSource}
        onSkillChange={(newSource) => setSkillSource(newSource)}
      />

      {openAgentId && strategy && (
        <MemoryModal
          agentId={openAgentId}
          strategy={strategy}
          execMap={execMap}
          onClose={() => setOpenAgentId(null)}
        />
      )}

      {baseWithdraw && (
        <Suspense fallback={<div className="route-loading" aria-busy="true" />}>
          <Withdraw
            positions={baseWithdraw.positions}
            idleUsdc={baseWithdraw.idleUsdc}
            ownerKernelAccount={baseWithdraw.ownerKernelAccount}
            publicClient={baseWithdraw.publicClient}
            stellarRecipient={realAddress}
            onClose={() => setBaseWithdraw(null)}
            onDone={() => {
              const captured = baseWithdraw.activeAccount
              loadDeviceBasePositions({ stellarOwner: realAddress }).then((bp) => {
                if (activeAccountRef.current === captured) setBasePositions(bp)
              })
            }}
          />
        </Suspense>
      )}

      {devMode && (
        <TweaksPanel title="Tweaks">
          <TweakSection label="Brand palette" />
          <PalettePicker value={normalizedTheme} onChange={(v) => setTweak('palette', v)} />

          <TweakSection label="Demo speed" />
          <TweakRadio
            label="Speed"
            value={tweaks.speed}
            options={[
              { value: 'fast', label: 'Fast' },
              { value: 'medium', label: 'Med' },
              { value: 'slow', label: 'Slow' },
            ]}
            onChange={(v) => setTweak('speed', v)}
          />

          <TweakSection label="Density" />
          <TweakRadio
            label="Layout"
            value={tweaks.density}
            options={[
              { value: 'comfortable', label: 'Comfy' },
              { value: 'compact', label: 'Compact' },
            ]}
            onChange={(v) => setTweak('density', v)}
          />

          <TweakSection label="Autonomous Agent" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11 }}>
            <label
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              Enable agent
              <input
                type="checkbox"
                checked={agentEnabled}
                onChange={(e) => setAgentEnabled(e.target.checked)}
              />
            </label>
            <label
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              Auto-harvest
              <input
                type="checkbox"
                checked={agentSettings.autoHarvest}
                onChange={(e) => setAgentSettings((s) => ({ ...s, autoHarvest: e.target.checked }))}
              />
            </label>
            <label
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              Min harvest (USDC)
              <input
                type="number"
                step="0.1"
                value={agentSettings.harvestMinUsdc}
                onChange={(e) =>
                  setAgentSettings((s) => ({ ...s, harvestMinUsdc: Number(e.target.value) }))
                }
                style={{ width: 56 }}
              />
            </label>
            <label
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              APY drop alert (%)
              <input
                type="number"
                value={agentSettings.apyDropPct}
                onChange={(e) =>
                  setAgentSettings((s) => ({ ...s, apyDropPct: Number(e.target.value) }))
                }
                style={{ width: 56 }}
              />
            </label>
            <label
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              Rebalance threshold (%)
              <input
                type="number"
                step="0.1"
                value={agentSettings.rebalanceThresholdPct}
                onChange={(e) =>
                  setAgentSettings((s) => ({ ...s, rebalanceThresholdPct: Number(e.target.value) }))
                }
                style={{ width: 56 }}
              />
            </label>
            <label
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              Emergency: full position
              <input
                type="checkbox"
                checked={agentSettings.emergencyFull}
                onChange={(e) =>
                  setAgentSettings((s) => ({ ...s, emergencyFull: e.target.checked }))
                }
              />
            </label>
            {!agentSettings.emergencyFull && (
              <label
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                Emergency: partial (%)
                <input
                  type="number"
                  value={agentSettings.emergencyPct}
                  onChange={(e) =>
                    setAgentSettings((s) => ({ ...s, emergencyPct: Number(e.target.value) }))
                  }
                  style={{ width: 56 }}
                />
              </label>
            )}
            <label
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              Risk monitoring
              <input
                type="checkbox"
                checked={agentSettings.riskMonitoring}
                onChange={(e) =>
                  setAgentSettings((s) => ({ ...s, riskMonitoring: e.target.checked }))
                }
              />
            </label>
          </div>
        </TweaksPanel>
      )}
    </div>
  )
}

export default App
