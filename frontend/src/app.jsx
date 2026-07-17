/* ============================================
   VIBING FARMER — App (multi-agent + real Web3)
   Design state machine wired to real wallet.js / strategist.js / orchestrator.js
   ============================================ */
import React, { useState as useS, useEffect as useE, useRef as useR, useMemo as useM } from 'react'
import { lazy, Suspense } from 'react'
import { isDevMode } from './devFlag.js'

import { Icon, Sidebar, TopBar, StepRail, STEPS } from './components.jsx'
import {
  InputScreen,
  ThinkingCard,
  ConnectCard,
  PermissionCard,
  SuccessCard,
  shortAddr,
} from './screens.jsx'
import { SkillReviewCard } from './skills.jsx'
import {
  StrategyCard,
  ExecuteCard,
  MemoryModal,
  DecisionLogPanel,
  buildAutofarmGraphData,
  rebalancePulseKey,
  buildStrategy,
  makeInitialExecState,
} from './agents.jsx'
import { useTweaks, TweaksPanel, TweakSection, TweakRadio } from './tweaks-panel.jsx'

import {
  connectWallet,
  getUserAddress,
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
import { attestStrategyOnChain, formatAttestation } from './attestation.js'
import OnboardingFlow from './components/OnboardingFlow.jsx'
import CrossChainFarmFlow from './screens/CrossChainFarmFlow.jsx'
import { OrchestratorAgent } from './orchestrator.js'
import { makeAgentId } from './worker.js'
import { readContract } from './stellar/client.js'
import { VAULT_CATALOG, VENICE_TIMEOUT_MS } from './config.js'
import {
  SOROBAN_ACTIVE_VAULT_ADDRESS,
  SOROBAN_RPC_URL,
  SOROBAN_AUTOFARM_VAULT_ADDRESS,
  SOROBAN_STRATEGY_1_ADDRESS,
  SOROBAN_BLEND_POOL_ADDRESS,
  SOROBAN_KEEPER_ADDRESS,
  SOROBAN_DECIMALS,
  USE_FUNDING_ROUTER,
} from './stellar/config.js'
import GrantPanel from './components/GrantPanel.jsx'
import { revokeGrant } from './stellar/grant.js'
import { fetchKeeperEvents } from './stellar/keeperEvents.js'
import { rehydrateScopes } from './stellar/scopeRehydrate.js'
import {
  readPricePerShare,
  readStrategies,
  readSupplyAprBps,
  readLifeboatState,
} from './stellar/vaultReads.js'
import { grantMandate } from './stellar/lifeboat.js'
import { evaluateExit } from './strategy/autoExit/engine.js'
import { runAutonomousExit } from './agents/exitExecutor.js'
import {
  loadPersistedPositions,
  persistPositions,
  loadDeployedAgents,
  saveDeployedAgents,
  reconcilePositionsFromChain,
  pickPositionsAgents,
  pickVaultAgents,
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
const OpsConsole = lazy(() => import('./components/console/OpsConsole.jsx'))
import NotificationCenter from './components/NotificationCenter.jsx'
import HomePage from './components/HomePage.jsx'
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
import { saveCycle, getCycles, getJournalSummary } from './strategy/cycleJournal.js'
import { computeBasket } from './strategy/basketFilter.js'
import { mintToken } from './strategy/eligibilityGate.js'
import { buildEligibilitySentence, vaultEligibilityLabel } from './strategy/eligibilitySentence.js'
import { SNAPSHOT } from './strategy/vaultFacts.js'
import { recordDecision, getDecisions, getDecisionSummary } from './strategy/decisionLog.js'
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

// vf-autofarm: strategy address → { label, poolAddress, poolLabel } for the KeeperPanel APR
// display + the force-graph's strategy→pool edge. Static because the vault contract exposes no
// strategy→pool lookup and only ONE strategy is live today (Task 1 spike found a self-deployed
// second pool can't reach Active status on testnet — see
// docs/superpowers/plans/2026-07-03-vf-autofarm-progress.md). Extend this map when strategy #2 ships.
const AUTOFARM_STRATEGY_META = {
  [SOROBAN_STRATEGY_1_ADDRESS]: {
    label: 'Strategy 1',
    poolAddress: SOROBAN_BLEND_POOL_ADDRESS,
    poolLabel: 'TestnetV2 pool',
  },
}

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
  palette: 'acid-yield',
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
  const byLive = (v) =>
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
        addr:
          cat.address ||
          VAULT_CATALOG.find((c) => c.protocol === (v.protocol || ''))?.address ||
          v.address,
        tvl: v.tvlFormatted || live.tvlFormatted || 'N/A',
        isLiveData: live.source === 'defiLlama',
        defillamaPool: live.defillamaPool || null,
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

/* ---------- App ---------- */
const App = () => {
  const devMode = isDevMode()
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS)

  // stage: 'strategy' | 'connect' | 'skills' | 'permission' | 'execute' | 'done'
  const [stage, setStage] = useS('strategy')
  const [furthest, setFurthest] = useS(0) // furthest step index reached → rail can navigate to visited steps
  const navigate = useNavigate()
  const location = useLocation()
  const [language, setLanguage] = useS(() => loadSettings().language) // UI i18n (labels only)
  const [amount, setAmount] = useS('100')
  const [risk, setRisk] = useS('med')
  const [devApiKey, setDevApiKey] = useS('')

  // strategy sub-state
  const [strategyPhase, setStrategyPhase] = useS('input') // input | thinking | ready
  const [thinkingPhase, setThinkingPhase] = useS(0)
  const [thinkTimes, setThinkTimes] = useS([]) // real measured per-step durations (seconds)
  const [slowConfirm, setSlowConfirm] = useS(false) // AI exceeded timeout → ask keep waiting / fallback
  const genAbortRef = useR(null)
  const slowTimerRef = useR(null)
  const [strategy, setStrategy] = useS(null)
  const [council, setCouncil] = useS(undefined) // undefined = no strategy yet, null = deliberating
  const [councilRetry, setCouncilRetry] = useS(0) // bump to re-run deliberation
  const councilCitedRef = useR({ citedRules: [], verdict: null })
  const [debateResult, setDebateResult] = useS(null) // debate council result
  const [debateRunning, setDebateRunning] = useS(false) // debate in progress

  // Continuous monitor state
  const [monitorStatus, setMonitorStatus] = useS({
    lastCheck: null,
    level: 'idle',
    score: 0,
    reason: '',
  })
  const monitorTimerRef = useR(null)
  const [rawStrategy, setRawStrategy] = useS(null) // raw Venice result (carries strategyHash) for on-chain attestation
  const [strategyAttestation, setStrategyAttestation] = useS(null)
  const [attesting, setAttesting] = useS(false)
  const [skillSource, setSkillSource] = useS('default')
  const [marketLive, setMarketLive] = useS(null) // Tavily live market context used? null until first generation
  const [vaultLive, setVaultLive] = useS(null) // DeFiLlama live vault data used? null until first generation
  const [skillDrawerOpen, setSkillDrawerOpen] = useS(false)

  const [connectPhase, setConnectPhase] = useS('idle')
  const [connectError, setConnectError] = useS(null)

  // skills
  const [skillStates, setSkillStates] = useS({})
  const [editingTexts, setEditingTexts] = useS({})

  const [permPhase, setPermPhase] = useS('idle')
  const [permError, setPermError] = useS(null)
  // Single-signature grant flow (router path). grantPhase drives the GrantPanel button label; the chosen
  // budget/duration are stashed in a ref so startExecution reads them synchronously when it builds
  // the orchestrator (state updates are async).
  const [grantPhase, setGrantPhase] = useS('idle')
  const [grantError, setGrantError] = useS(null)
  const grantCfgRef = useR(null)
  const [permActive, setPermActive] = useS(false)
  // Per-agent on-chain scopes (single-source summary + Revoke). Keyed by worker agent address.
  const [scopes, setScopes] = useS([])
  const [permExpiresAt, setPermExpiresAt] = useS(null)

  // True when a refresh re-entered an active session (drives the Home banner).
  const [sessionResumed, setSessionResumed] = useS(false)

  // Wallet reconnect + session resume on page load. Without this, a refresh drops
  // realAddress/stage/strategy (all in-memory) so the app looks logged-out and the monitor loop
  // never reboots even with an active vault. We ask the wallet kit for its current address; if a
  // resume snapshot exists we restore stage='done' + strategy, which makes the loop effect (below)
  // start the monitor loop again. If no wallet is selected yet (fresh reload) getUserAddress
  // rejects and the catch leaves the app logged-out until the user reconnects. Mount-only.
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
    getUserAddress()
      .then((addr) => {
        if (!alive || !addr) return
        setRealAddress(addr)
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
  // Which agents' vault shares a "position" reads. Priority:
  //   view-as (dev) → the impersonated address's OWN shares;
  //   real run      → the per-run agents the router deployed (scopes[].agent, non-revoked),
  //                   which is where deposit mints the shares.
  // Falling back to reconcile's default (the fixed demo agent) is the bug that emptied the
  // positions card ~15s after a real run: the poll read demo-agent = 0 shares and pruned the
  // vault. Shares sum across agents; withdrawn/other-run agents read 0 and drop out harmlessly.
  // ponytail: N non-revoked agents = N readVaultShares per 15s poll; fine for a handful of
  // runs, revisit if an owner accumulates dozens of live grants.
  const positionsAgents = pickPositionsAgents(scopes, viewAsAddress)
  // Reconcile effects capture this closure keyed on realAddress, but scopes rehydrate async
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

  // Strategy Attestation — NON-BLOCKING, best-effort. Fires once a wallet provider
  // exists (post-connect) and the AI strategy carries a deterministic hash. Any
  // failure/rejection is swallowed by attestStrategyOnChain → strategy still executes.
  useE(() => {
    if (!rawStrategy?.strategyHash || strategyAttestation || attesting) return
    setAttesting(true)
    attestStrategyOnChain(rawStrategy, { attester: realAddress })
      .then((a) => setStrategyAttestation(formatAttestation(a)))
      .finally(() => setAttesting(false))
  }, [rawStrategy, realAddress])

  // Background agent
  const [agentEnabled, setAgentEnabled] = useS(
    () => localStorage.getItem('yv_agent_enabled') !== 'false'
  )
  const [agentSettings, setAgentSettings] = useS(loadAgentSettings)
  const [agentData, setAgentData] = useS({ positions: {}, alerts: [], lastUpdated: null })
  // vf-autofarm KeeperPanel state — populated by the SAME 15s poll that already fetches
  // keeper events below (keeperLedgerRef), never a second interval.
  const [keeperActivity, setKeeperActivity] = useS([]) // newest-first, capped — feeds KeeperPanel
  // vf-lifeboat Task 8 — separate from keeperActivity: KeeperPanel's LastAction assumes every
  // item is a compound/rebalance alert shape (it treats anything without kind==='compound_executed'
  // as a rebalance row), so mixing derisk/resume/mandate items into that array would render a
  // broken "Rebalanced" row whenever a lifeboat event became the newest entry.
  const [lifeboatState, setLifeboatState] = useS(null) // {derisked, mandateExpiry, authority} | null
  const [lifeboatActivity, setLifeboatActivity] = useS([]) // newest-first, capped — feeds LifeboatPanel
  const [lifeboatBusy, setLifeboatBusy] = useS(false)
  const [autofarmReads, setAutofarmReads] = useS({ pricePerShare: null, strategies: [] })
  const [rebalancePulse, setRebalancePulse] = useS(null) // { key, ts } — force-graph edge pulse

  const [sbExtended, setSbExtended] = useS(() => localStorage.getItem('yv_sb_extended') === 'true')
  const [railCollapsed, setRailCollapsed] = useS(
    () => localStorage.getItem('yv_rail_collapsed') === 'true'
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
    document.documentElement.dataset.palette = tweaks.palette
    document.documentElement.dataset.density = tweaks.density
  }, [tweaks.palette, tweaks.density])

  // Redirect old hash URLs (bookmarks like /#/home → /home)
  useE(() => {
    if (window.location.hash?.startsWith('#/')) {
      const path = window.location.hash.replace('#', '')
      window.history.replaceState(null, '', path)
    }
  }, [])

  // Document title per route
  useE(() => {
    const titles = {
      '/home': 'vibing / farmer',
      '/strategy': 'New strategy | Vibing Farmer',
      '/agent': 'Autonomous agent | Vibing Farmer',
      '/history': 'History | Vibing Farmer',
      '/settings': 'Settings | Vibing Farmer',
    }
    document.title = titles[location.pathname] || 'Vibing Farmer'
  }, [location.pathname])

  // Record the furthest step reached so the rail can navigate to visited steps (and only those)
  useE(() => {
    setFurthest((f) =>
      Math.max(
        f,
        STEPS.findIndex((s) => s.id === stage)
      )
    )
  }, [stage])

  const paletteIsLight = tweaks.palette === 'bone-paper'
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
    if (!realAddress) return
    const restored = loadPersistedPositions(realAddress)
    if (Object.keys(restored).length) {
      setAgentData((d) => ({ ...d, positions: { ...restored, ...d.positions } }))
    }
    // Mark hydrated after this render+effect flush (setTimeout 0), so the restored cache
    // is committed before the persist effect is allowed to write an empty map. Pre-hydration
    // empties stay skipped (anti-clobber); post-hydration empties = real withdraws → persist.
    const hydrateTimer = setTimeout(() => {
      hydratedRef.current = realAddress
    }, 0)
    let alive = true
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
        if (agents.length) {
          saveDeployedAgents(realAddress, agents)
          deployedAgentsRef.current = agents
        }
      }
      if (!alive) return
      // Prefer the scope-derived agent list (per-run grant agents — the authoritative
      // source once scopes rehydrate); discovered agents cover the fresh-browser case.
      const scopeAgents = positionsAgentsRef.current
      const useAgents = scopeAgents?.length ? scopeAgents : agents
      const chain = await reconcilePositionsFromChain(
        realAddress,
        useAgents.length ? { agents: useAgents } : undefined
      ).catch(() => null)
      if (!alive || !chain) return // null = no RPC / all reads failed → keep cache
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
  }, [realAddress])

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
    if (!realAddress) return
    let alive = true
    const sync = async () => {
      const startedAt = Date.now()
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
      if (alive && chain) {
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
        if (!alive) return
        // KeeperPanel activity feed — separate from the deduped/capped-at-8 alerts list above
        // (handleAgentEvent keeps only the LATEST of each kind for notifications; the panel
        // wants its own short history of real keeper actions).
        const newActivity = []
        const newLifeboatActivity = []
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
            }
            handleAgentEvent(item)
            newActivity.push(item)
            // Pulse the force-graph edge between the two strategies/vault this rebalance moved
            // funds between (rebalancePulseKey is direction-independent — see agents.jsx).
            setRebalancePulse({ key: rebalancePulseKey(ev.from, ev.to), ts: Date.now() })
          } else if (ev.type === 'derisk' || ev.type === 'resume' || ev.type === 'mandate') {
            // Lifeboat activity feed (vf-lifeboat) — kept in decodeKeeperEvent's own shape
            // (type/reasonCode/drainedTotal/txHash) rather than remapped into keeperActivity's
            // kind-based alert objects; see lifeboatActivity state comment above for why.
            newLifeboatActivity.push({ ...ev, timestamp: Date.now() })
          }
        }
        if (newActivity.length) {
          setKeeperActivity((prev) => [...newActivity.reverse(), ...prev].slice(0, 20))
        }
        if (newLifeboatActivity.length) {
          setLifeboatActivity((prev) => [...newLifeboatActivity.reverse(), ...prev].slice(0, 20))
        }
      } catch (e) {
        // transient RPC failure — the next 15s tick retries
        console.warn('[app] keeper event read failed:', e)
      }
      // Live autofarm vault reads for the KeeperPanel: price-per-share + registered strategies,
      // each paired with a best-effort Blend supply-APR estimate. Best-effort end to end — a
      // failed read leaves the panel showing "--", never a fake number.
      try {
        const [pps, strategyAddrs] = await Promise.all([
          readPricePerShare(SOROBAN_AUTOFARM_VAULT_ADDRESS),
          readStrategies(SOROBAN_AUTOFARM_VAULT_ADDRESS),
        ])
        if (!alive) return
        const strategies = await Promise.all(
          strategyAddrs.map(async (addr) => {
            const meta = AUTOFARM_STRATEGY_META[addr] || {}
            const aprBps = meta.poolAddress ? await readSupplyAprBps(meta.poolAddress) : null
            return {
              address: addr,
              label: meta.label || shortAddr(addr),
              poolAddress: meta.poolAddress || null,
              poolLabel: meta.poolLabel || null,
              aprPct: aprBps == null ? null : aprBps / 100,
            }
          })
        )
        if (alive) {
          setAutofarmReads({
            pricePerShare: pps == null ? null : toDisplay(pps).toFixed(4),
            strategies,
          })
        }
      } catch (e) {
        // transient RPC failure — the next 15s tick retries; panel keeps its last-known reads
        console.warn('[app] keeper vault read failed:', e)
      }
      // Lifeboat state (vf-lifeboat) — same 15s poll tick. readLifeboatState() never throws (it
      // already returns null on RPC failure internally); this catch is defensive only.
      try {
        const s = await readLifeboatState(SOROBAN_AUTOFARM_VAULT_ADDRESS)
        if (alive) setLifeboatState(s)
      } catch {
        if (alive) setLifeboatState(null)
      }
      // Council monitor — check market drift setiap 15s tick.
      if (alive && agentSettings.riskMonitoring && Object.keys(agentData.positions).length) {
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
  }, [realAddress])

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
      if (!settings.monitorEnabled) {
        setMonitorStatus((s) => ({ ...s, lastCheck: ev.timestamp, level: 'disabled' }))
        return
      }
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

  // ── Autonomous Auto-Exit monitor loop ──
  useE(() => {
    if (!realAddress || stage !== 'done' || !agentEnabled) return
    let active = true

    const checkExit = async () => {
      const storedRules = localStorage.getItem(`yv_exit_rules_${realAddress}`)
      if (!storedRules) return
      const rules = JSON.parse(storedRules)
      if (!rules.authorized) return

      const stateForExit = {
        portfolio: { holdings: agentData.positions },
        universe: Object.keys(agentData.positions).map((addr) => {
          const cat = VAULT_CATALOG.find((v) => v.addr.toLowerCase() === addr.toLowerCase()) || {}
          const pos = agentData.positions[addr] || {}
          return {
            address: addr,
            protocol: cat.protocol || 'blend',
            apy: Number(cat.apy || 6.5),
            tvl: cat.tvl || 25_000_000,
            drawdown: Number(pos.drawdown || 0),
          }
        }),
        market: {
          utilization: 0.96, // default utilization for simulation
          signals: [],
        },
      }

      const result = evaluateExit(rules, stateForExit, {
        nowMs: Date.now(),
        lastExitTripAt: Number(localStorage.getItem(`yv_last_exit_trip_${realAddress}`) || '0'),
      })

      if (result.tripped && active) {
        localStorage.setItem(`yv_last_exit_trip_${realAddress}`, String(Date.now()))
        addLog({
          event: 'AgentFailed',
          meta: `Auto-Exit Triggered: ${result.reason}`,
          detail: `Trigger: ${result.trigger}. Launching autonomous exit...`,
        })

        // Surface a critical risk alert
        setAgentData((d) => ({
          ...d,
          alerts: [
            {
              id: `exit-alert-${Date.now()}`,
              kind: 'risk_alert',
              severity: 'critical',
              vaultName: 'VFUSD Yield Vault',
              vaultAddress: SOROBAN_ACTIVE_VAULT_ADDRESS,
              message: `Auto-Exit Triggered: ${result.reason}`,
              timestamp: Date.now(),
            },
            ...d.alerts,
          ],
        }))

        // Every per-run agent holds its own slice of the position and its own exit key, so the
        // autonomous exit is one run per agent. Agents whose exit signer was never registered throw
        // "No exit key is authorized" — surfaced, not swallowed, because the funds stay at risk.
        const exitAgents = pickVaultAgents(scopes, SOROBAN_ACTIVE_VAULT_ADDRESS)
        const exited = []
        const exitFailed = []
        for (const agentAddress of exitAgents) {
          try {
            exited.push(await runAutonomousExit({ agentAddress, ownerAddress: realAddress }))
          } catch (err) {
            console.error('[AutoExit] Autonomous exit failed for', agentAddress, err)
            exitFailed.push({ agentAddress, error: err.message })
          }
        }

        if (!exitAgents.length) {
          addLog({
            event: 'AgentFailed',
            meta: 'Automatic exit stopped. No active agent holds this position.',
            detail: 'Please execute emergency withdraw manually.',
          })
        }
        if (exited.length) {
          addLog({
            event: 'AgentCompleted',
            meta: `Autonomous exit swept ${exited.length} of ${exitAgents.length} agents. Transaction: ${exited[0].hash.slice(0, 8)}...`,
            detail: 'Vault shares redeemed and USDC principal returned to owner wallet.',
          })
          const chain = await reconcileWithRetry(realAddress)
          if (chain) {
            setAgentData((d) => ({
              ...d,
              positions: applyChainPositions(d.positions, chain),
              lastUpdated: Date.now(),
            }))
          }
        }
        if (exitFailed.length) {
          addLog({
            event: 'AgentFailed',
            meta: `Automatic exit failed for ${exitFailed.length} of ${exitAgents.length} agents: ${exitFailed[0].error}`,
            detail: 'Please execute emergency withdraw manually for the agents that did not exit.',
          })
        }
      }
    }

    const intervalId = setInterval(checkExit, 15000)
    checkExit()

    return () => {
      active = false
      clearInterval(intervalId)
    }
  }, [realAddress, stage, agentEnabled, agentData.positions])

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
    const fusedSentence = firstSurvivor
      ? buildEligibilitySentence(verdictBySlug[firstSurvivor.vault.protocol], {
          targetMaxLossPct: 5,
          protocolLabel:
            SNAPSHOT[firstSurvivor.vault.protocol]?.meta?.label || firstSurvivor.vault.protocol,
        })
      : null
    const rows = strategy.agents.map((a) => {
      const v = verdictBySlug[a.vault.protocol]
      const asOf = new Date(SNAPSHOT[a.vault.protocol]?.facts?.tvl?.asOf || 0)
        .toISOString()
        .slice(0, 10)
      return {
        id: a.id,
        eligible: !!v?.eligible,
        isFixture: !!v?.isFixture,
        protocolLabel: SNAPSHOT[a.vault.protocol]?.meta?.label || a.vault.protocol,
        label: vaultEligibilityLabel(v),
        mainnetLine: `Protocol credibility: ${SNAPSHOT[a.vault.protocol]?.meta?.label || a.vault.protocol}. Audited, TVL from snapshot`,
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
  // verdict. For the new debate council, see handleRunCouncil below.
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
  }, [strategy, strategyPhase, amount, risk, councilRetry, debateRunning, debateResult])

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
    const agents = pickVaultAgents(scopes, alert.vaultAddress)
    if (!agents.length) {
      addLog({
        event: 'AgentFailed',
        meta: 'Emergency withdrawal stopped. No active agent holds this position.',
        detail: 'Agent permissions may still be loading, or every scope for this vault is revoked.',
      })
      return
    }
    try {
      const results = await withdrawAllFromVault(alert.vaultAddress, realAddress, agents)
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
          detail: failed[0].error,
        })
        return
      }
      dismissAlert(alert.id)
    } catch (e) {
      addLog({ event: 'AgentFailed', meta: `Withdrawal failed: ${e.message}` })
    }
  }

  const handleReviewRebalance = (alert) =>
    addLog({
      event: 'OrchestratorPlanned',
      meta: `Rebalance review: ${alert.fromVault} → ${alert.toProtocol} (+${alert.apyGain}%).`,
      detail: `Venice AI flagged ${alert.toProtocol} at ${alert.toApy}% vs ${alert.fromVault} at ${alert.fromApy}% (+${alert.apyGain}%). Rebalancing authorizes a fresh Soroban session-key scope for the new vault.`,
    })

  // Kill switch — user-signed Registry.revoke (works even if the relayer is down).
  // Optimistically flip the row; the on-chain agent_revoked subscription confirms it.
  const handleRevokeAgent = async (agent) => {
    try {
      // Revoke is a kill switch, not an exit: on-chain it only flips the flag and clears the
      // allowance — it never redeems shares. Every withdraw list filters revoked agents out, so
      // revoking a still-funded agent strands its deposit with no in-app way back. Refuse and
      // point at the exit that actually moves the money. Fails OPEN on a read failure: an RPC
      // hiccup must not disable the kill switch — a stranded deposit has a second chance
      // (withdraw first), a live rogue key does not.
      const scope = scopes.find((r) => r.agent?.toLowerCase() === agent.toLowerCase())
      const shares = await readContract({
        contract: scope?.vault || SOROBAN_ACTIVE_VAULT_ADDRESS,
        method: 'balance',
        args: [{ addr: agent }],
      }).catch(() => 0n)
      if (BigInt(shares ?? 0) > 0n) {
        addLog({
          event: 'AgentFailed',
          meta: `Revocation blocked: agent ${shortAddr(agent)} still holds ${toDisplay(shares).toFixed(2)} vault shares.`,
          detail:
            'Withdraw first — a revoked agent disappears from every withdraw list, which would strand these funds.',
        })
        return
      }
      const { hash: tx } = await revokeAgentOnChain({ owner: realAddress, agent })
      setScopes((prev) =>
        prev.map((s) =>
          s.agent?.toLowerCase() === agent.toLowerCase() ? { ...s, revoked: true } : s
        )
      )
      addLog({
        event: 'PermissionRevoked',
        meta: `Revoked agent ${shortAddr(agent)}. Transaction ${shortAddr(tx)}.`,
        txHash: tx,
        detail:
          'Agent scope revoked on-chain. Further deposits by this key now revert (ScopeInactive).',
      })
    } catch (e) {
      addLog({ event: 'AgentFailed', meta: `Revocation failed: ${e.message}` })
    }
  }

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
  const onGrantMandate = async () => {
    if (!realAddress) return
    setLifeboatBusy(true)
    try {
      await grantMandate({ owner: realAddress })
      const s = await readLifeboatState()
      setLifeboatState(s)
    } catch (e) {
      console.error('mandate grant failed', e)
    } finally {
      setLifeboatBusy(false)
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
        if (rows && pickVaultAgents(rows, vaultAddress).length === 0) return
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

  /* ----- STRATEGY (step 01) ----- */
  const handleSubmitPreference = () => {
    setStrategyPhase('thinking')
    setThinkingPhase(0)
    addLog({
      event: 'OrchestratorPlanned',
      meta: `${amount} USDC, ${risk} risk. Planning started.`,
    })
  }

  useE(() => {
    if (stage !== 'strategy' || strategyPhase !== 'thinking') return
    let cancelled = false
    setThinkTimes([])
    setThinkingPhase(0)
    setStrategyAttestation(null)
    setRawStrategy(null)
    const delay = (ms) => new Promise((r) => setTimeout(r, ms))
    const freeze = (i, st) =>
      setThinkTimes((a) => {
        const n = [...a]
        n[i] = (performance.now() - st) / 1000
        return n
      })

    ;(async () => {
      let st = performance.now()
      await delay(speed * 0.6) // step 0: scan vaults
      if (cancelled) return
      freeze(0, st)
      setThinkingPhase(1)

      st = performance.now()
      await delay(speed * 1.1) // step 1: allocation
      if (cancelled) return
      freeze(1, st)
      setThinkingPhase(2)

      // step 2: real AI call — ThinkingCard ticks a live timer + spinner until this resolves.
      // App owns the timeout: after VENICE_TIMEOUT_MS, ask the user to keep waiting or fall back.
      let s = null
      const ctrl = new AbortController()
      genAbortRef.current = ctrl
      slowTimerRef.current = setTimeout(() => {
        if (!cancelled) setSlowConfirm(true)
      }, VENICE_TIMEOUT_MS)
      try {
        const numVaults = { low: 1, med: 2, high: 3 }[risk] || 2
        const riskLevel = risk === 'med' ? 'medium' : risk
        const veniceResult = await generateStrategy({
          amount: Number(amount),
          riskLevel,
          numVaults,
          veniceAuth: null, // wallet not connected yet at step 1
          devApiKey: devApiKey || null,
          signal: ctrl.signal,
          address: realAddress || null, // positions node runs only when connected
        })
        setSkillSource(veniceResult.skillSource || 'default')
        setMarketLive(!!veniceResult.marketContextUsed)
        setVaultLive(veniceResult.vaultDataSource === 'defiLlama')
        if (veniceResult.mdpState?.gasLevel) {
          latestGasRef.current = {
            level: veniceResult.mdpState.gasLevel,
            gwei: veniceResult.mdpState.gasGwei,
          }
          addLog({
            event: 'OrchestratorPlanned',
            meta: `Market data fetched in parallel. Gas: ${veniceResult.mdpState.gasGwei} gwei (${veniceResult.mdpState.gasLevel}).`,
          })
        }
        if (veniceResult.dagTimings) {
          const breakdown = Object.entries(veniceResult.dagTimings)
            .map(([id, ms]) => `${id} ${Math.round(ms)}ms`)
            .join(', ')
          addLog({
            event: 'OrchestratorPlanned',
            meta: `Strategy graph completed in ${veniceResult.dagWallMs}ms.`,
            detail: breakdown,
          })
        }
        setRawStrategy(veniceResult) // carries strategyHash → attestation effect picks it up once a provider exists
        if (veniceResult.generatedBy !== 'fallback') {
          s = mapVeniceToStrategy(veniceResult, amount, risk)
          addLog({
            event: 'OrchestratorPlanned',
            meta: `Strategy generated by ${veniceResult.generatedBy}. ${(veniceResult.strategy_summary || veniceResult.rationale)?.slice(0, 60)}`,
          })
        }
      } catch (e) {
        console.warn('[app] Strategy AI failed:', e)
      }
      clearTimeout(slowTimerRef.current)
      setSlowConfirm(false)
      if (cancelled) return
      if (!s) s = buildStrategy(amount, risk)
      setStrategy(s)
      setStrategyPhase('ready')
      const sk = {}
      s.agents.forEach((a) => {
        sk[a.id] = { state: 'pending', skill: null }
      })
      setSkillStates(sk)
      addLog({
        event: 'OrchestratorPlanned',
        meta: `${s.agents.length} worker spawned, ${s.blendedApy}% blended apy`,
      })
    })()

    return () => {
      cancelled = true
    }
  }, [stage, strategyPhase])

  const handleAcceptStrategy = () => setStage('connect')

  const handleRunCouncil = async () => {
    if (!strategy?.agents?.length || debateRunning) return
    // Stay on strategyPhase 'ready' so the stage key does not remount StrategyCard
    // (key used to flip ready→council and felt like a full page refresh).
    setDebateRunning(true)
    setDebateResult(null)
    const ctrl = new AbortController()
    try {
      const state = buildStrategyState({
        amountUsdc: Number(amount) || 0,
        riskLevel: risk,
        numVaults: strategy.agents.length,
        vaultData: VAULT_CATALOG,
        marketContext: marketLive,
        positions: agentData.positions,
        gas: latestGasRef.current,
      })
      const sim = runSimulation(allocationsFromStrategy(strategy), state, {
        runs: 200,
        horizonDays: 30,
        seed: 1,
        context: {
          turbulence: strategy.mdpState?.turbulence || state.market.turbulence,
          apyTrendPct: 0,
          gasGwei: latestGasRef.current?.gwei || null,
        },
      })
      const settings = await loadSettings()
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
      setDebateResult(result)
      setCouncil(result)
      addLog({
        event: 'OrchestratorPlanned',
        meta: `Debate Council, ${result.verdict}, ${result.iterations} iters, converged: ${result.converged}`,
      })
    } catch (e) {
      console.warn('[app] Debate council failed:', e)
      addLog({
        event: 'OrchestratorPlanned',
        meta: `Debate Council failed, ${e?.message || 'unknown error'}`,
      })
    } finally {
      setDebateRunning(false)
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
    setMonitorStatus({
      lastCheck: Date.now(),
      level: safeLevel,
      score: diff.score,
      reason: diff.reasons[0] || '',
    })

    if (safeLevel === 'skip') return

    if (safeLevel === 'fast') {
      const result = await fastReeval(strategy, snapshot?.result || null, currentData, {
        devApiKey: devApiKey || null,
      })
      if (result.passed) {
        saveSnapshot(result, currentData)
        if (settings.autoApprove) return
        setMonitorStatus((s) => ({
          ...s,
          result: 'approved',
          permissionSentence: result.permissionSentence,
        }))
        addLog({
          event: 'OrchestratorPlanned',
          meta: `Monitor re-eval, fast pass, confidence ${(result.confidence * 100).toFixed(0)}%`,
        })
      } else {
        setMonitorStatus((s) => ({ ...s, result: 'violation', error: result.error }))
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
        setMonitorStatus((s) => ({
          ...s,
          result: result.verdict === 'keep' ? 'approved' : 'rejected',
          debateResultId: Date.now(),
        }))
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

  const handleRegenerate = () => {
    setStrategy(null)
    setSkillStates({})
    setStrategyPhase('thinking')
    setThinkingPhase(0)
    setDebateResult(null)
    setCouncil(undefined)
    addLog({ event: 'OrchestratorPlanned', meta: `Replanning: ${amount} USDC, ${risk} risk.` })
  }

  const handleKeepWaiting = () => {
    setSlowConfirm(false)
    slowTimerRef.current = setTimeout(() => setSlowConfirm(true), VENICE_TIMEOUT_MS) // ask again next minute
  }
  const handleStopWaiting = () => {
    setSlowConfirm(false)
    clearTimeout(slowTimerRef.current)
    genAbortRef.current?.abort() // → generateStrategy returns fallback → default strategy
  }

  /* ----- CONNECT (step 02) ----- */
  const handleConnect = async () => {
    setConnectPhase('connecting')
    setConnectError(null)
    try {
      const addr = await connectWallet()
      setRealAddress(addr)
      setConnectPhase('connected')
      addLog({ event: 'Connected', meta: shortAddr(addr) })
    } catch (err) {
      setConnectPhase('idle')
      setConnectError(err.message)
      addLog({ event: 'AgentFailed', meta: `Connection failed: ${err.message}` })
    }
  }

  const handleUpgrade = async () => {
    // ponytail: Venice x402 wallet-funded inference removed (single-chain Stellar; no EVM SIWE).
    // AI strategist runs via Settings keys / host proxy / deterministic fallback. veniceAuth stays
    // null — resolveProvider degrades cleanly. Re-add a Stellar-native paid-inference path here later.
    setConnectPhase('upgrading')
    setTimeout(() => {
      setConnectPhase('upgraded')
      addLog({ event: 'Authorized', meta: 'Session ready. The relayer sponsors network fees.' })
    }, speed * 0.8)
  }

  const handleConnectDone = () => setStage('skills')

  /* ----- SKILLS (step 03) ----- */
  const updateSkillState = (id, patch) => {
    setSkillStates((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }

  const handleSkillApprove = (id) => {
    updateSkillState(id, { state: 'approved' })
    addLog({ event: 'SkillApproved', agent: id, meta: 'Skill JSON approved and ready to bind.' })
  }

  const handleApproveAll = () => {
    const next = {}
    Object.entries(skillStates).forEach(([id, s]) => {
      next[id] = { ...s, state: 'approved' }
    })
    setSkillStates(next)
    addLog({
      event: 'SkillApproved',
      meta: `${Object.keys(next).length} skills approved in this batch.`,
    })
  }

  const handleSkillEdit = (id, text, start = false) => {
    let err = null
    try {
      JSON.parse(text)
    } catch (e) {
      err = e.message.replace(/^.*: /, '')
    }
    setEditingTexts((prev) => ({ ...prev, [id]: { text, error: err } }))
    if (start) updateSkillState(id, { state: 'editing' })
  }

  const handleSkillSave = (id) => {
    const entry = editingTexts[id]
    if (!entry || entry.error) return
    try {
      const parsed = JSON.parse(entry.text)
      updateSkillState(id, { state: 'pending', skill: parsed })
    } catch {
      /* guarded above */
    }
  }

  const handleSkillReset = (id) => {
    updateSkillState(id, { state: 'pending' })
    setEditingTexts((prev) => ({ ...prev, [id]: { text: '', error: null } }))
  }

  const handleSkillUpdate = (id, skillObj) => {
    updateSkillState(id, { state: 'pending', skill: skillObj })
  }

  const handleSkillsContinue = () => {
    setStage('permission')
  }

  /* ----- GRANT (step 04, router single-signature path) ----- */
  // "Grant & run": stash the user's budget + window, then advance to execute. The SINGLE wallet
  // wallet signature (router.grant) fires inside orchestrator.dispatch → setupViaRouter; every later worker
  // funding is a relayed router.pull (0 further signatures).
  const handleGrantAndRun = ({ budget, durationSeconds }) => {
    grantCfgRef.current = { budgetUsdc: budget, durationSeconds }
    setGrantError(null)
    setGrantPhase('granting')
    setPermActive(true)
    setPermExpiresAt(Date.now() + durationSeconds * 1000)
    addLog({
      event: 'PermissionGranted',
      meta: `Router grant: ${budget} USDC for ${durationSeconds}s.`,
    })
    setStage('execute')
    startExecution()
  }

  // Kill switch — zero the on-chain allowance in one signature (works even if the relayer is down).
  const handleRevokeGrant = async () => {
    if (!realAddress) return
    setGrantError(null)
    setGrantPhase('revoking')
    try {
      const { hash } = await revokeGrant({ owner: realAddress })
      addLog({
        event: 'PermissionRevoked',
        meta: `Router allowance set to 0. Transaction ${hash?.slice(0, 10)}...`,
      })
    } catch (err) {
      setGrantError(err?.message || 'revoke failed')
    } finally {
      setGrantPhase('idle')
    }
  }

  /* ----- PERMISSION (step 04) ----- */
  const handleGrant = () => setPermPhase('prompting')

  const handlePermReject = () => {
    setPermPhase('idle')
    addLog({ event: 'PermissionRevoked', meta: 'Permission request rejected by the user.' })
  }

  const handlePermConfirm = async () => {
    setPermPhase('idle')
    setPermError(null)
    // Stellar path: there is no EVM-style permission-grant step. The per-agent authorize + fund (one
    // user-signed wallet-kit tx per agent) happens inside orchestrator.dispatch. Just advance
    // to execute and let the orchestrator prompt the wallet.
    const expiresAtMs = Date.now() + 86400 * 1000
    setPermActive(true)
    setPermExpiresAt(expiresAtMs)
    addLog({
      event: 'PermissionGranted',
      meta: 'Stellar authorization will fund each agent during execution.',
    })
    setTimeout(() => {
      setStage('execute')
      startExecution()
    }, 600)
  }

  /* ----- EXECUTE (step 05) — real parallel agents ----- */
  const updateExecMap = (agentId, patch) => {
    setExecMap((prev) => ({
      ...prev,
      [agentId]: {
        ...(prev[agentId] || {
          status: 'idle',
          activeStep: null,
          steps: { swap: 'idle', approve: 'idle', deposit: 'idle' },
          hashes: {},
          memory: [],
          metrics: {},
        }),
        ...patch,
      },
    }))
  }

  const startExecution = () => {
    if (!strategy) return
    setMonitorStatus({
      level: 'skip',
      score: 0,
      reason: 'Starting execution...',
      lastCheck: Date.now(),
      result: 'approved',
    })

    // Pre-compute sessionId and build hex→designId map BEFORE orchestrator starts.
    // Orchestrator uses makeAgentId(index, sessionId) — same function, same sessionId = same hex.
    const sessionId = `session-${Date.now()}`
    const agentMap = {}
    strategy.agents.forEach((a, i) => {
      const hexId = makeAgentId(i, sessionId)
      agentMap[hexId] = a.id // 'worker-1', 'worker-2', etc.
    })
    agentMapRef.current = agentMap

    const init = makeInitialExecState(strategy.agents)
    setExecMap(init)

    // Enforcement A — eligibility gate. Drop ineligible protocols BEFORE dispatch; all-fail = hard stop.
    const { verdictBySlug, survivors, dropped, allFailed } = computeBasket(strategy.agents)
    dropped.forEach((d) =>
      addLog({
        event: 'VaultRejected',
        agent: d.agent.id,
        meta: (d.verdict.reasons || []).join('; '),
      })
    )
    if (allFailed) {
      addLog({ event: 'ExecutionBlocked', meta: 'No eligible vault. Nothing will run.' })
      setStage('permission') // stay on the approval card; do NOT dispatch
      return
    }
    // dispatchSet ⊆ survivors: only survivors get a plan; allocations re-normalized to sum 1.
    // Each survivor carries a freshly-minted eligibility token (Enforcement B asserts it worker-side).
    const yvStrategy = {
      vaults: survivors.map((a, i) => ({
        address: a.vault.addr,
        allocation: a.allocationFraction,
        protocolSlug: a.vault.protocol,
        eligibilityToken: mintToken(verdictBySlug[a.vault.protocol], i),
      })),
    }

    // Router path: pass the user's chosen grant budget (USDC → base units) + window so the ONE
    // grant signature sizes the allowance. null on the legacy path → orchestrator defaults (budget =
    // run total, window = SCOPE_TTL_SECONDS).
    const grantCfg = grantCfgRef.current
    const grantBudgetUnits =
      grantCfg?.budgetUsdc != null
        ? BigInt(Math.floor(grantCfg.budgetUsdc * 10 ** SOROBAN_DECIMALS))
        : null

    const orch = new OrchestratorAgent({
      user: realAddress,
      veniceAuth: veniceAuth,
      devApiKey: devApiKey || null,
      sessionId,
      grantBudgetUnits,
      grantDurationSeconds: grantCfg?.durationSeconds || null,
      onEvent: (evName, data) => {
        if (evName === 'skill-gen-failed') {
          const dId = agentMapRef.current?.[data.agentId] || data.agentId
          addLog({
            event: 'AgentFailed',
            agent: dId,
            meta: `Skill generation failed: ${data.error}. Using the fallback skill.`,
          })
          return
        }

        if (evName === 'AgentScopeAuthorized') {
          // Single source: derive the human summary (cap + max-at-risk) from the SAME scope
          // object the orchestrator authorized on-chain. UI numbers cannot diverge from chain.
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

        const agentId = data?.agentId
        if (!agentId) return

        // Resolve hex agentId → design worker id ('worker-1', etc.)
        const dId = agentMapRef.current?.[agentId] || agentId

        if (evName === 'started') {
          setExecMap((prev) => {
            const cur = prev[dId] || prev[agentId] || makeInitialExecState([{ id: dId }])[dId]
            return {
              ...prev,
              [dId]: {
                ...cur,
                status: 'running',
                activeStep: 'swap',
                memory: [
                  ...(cur.memory || []),
                  {
                    status: 'running',
                    title: 'Agent started',
                    meta: `Vault ${shortAddr(data.vault)}`,
                    t: nowT(),
                  },
                ],
                metrics: {
                  ...(cur.metrics || {}),
                  startedAt: Date.now(),
                  totalRuns: (cur.metrics?.totalRuns || 0) + 1,
                },
              },
            }
          })
          addLog({ event: 'AgentStarted', agent: dId, meta: `Vault: ${shortAddr(data.vault)}` })
        }

        if (evName === 'step') {
          const stepName = WORKER_STEP_MAP[data.step]
          if (!stepName) return // skip 'grant-permission' internal step
          const stepStatus =
            data.status === 'done' ? 'confirmed' : data.status === 'skipped' ? 'skipped' : 'running'
          setExecMap((prev) => {
            const cur = prev[dId] || prev[agentId] || {}
            return {
              ...prev,
              [dId]: {
                ...cur,
                activeStep: stepName,
                gasMethod: data.gasMethod || cur.gasMethod || null,
                steps: { ...(cur.steps || {}), [stepName]: stepStatus },
                hashes: data.txHash
                  ? { ...(cur.hashes || {}), [stepName]: data.txHash }
                  : cur.hashes || {},
                memory: [
                  ...(cur.memory || []),
                  {
                    status: stepStatus,
                    title: `${stepName.replace(/^./, (c) => c.toUpperCase())} ${data.status === 'done' ? 'confirmed' : 'executing'}`,
                    meta: data.txHash
                      ? `Tx ${shortAddr(data.txHash)}${data.gasMethod === 'user-signed' ? ', user-signed' : ''}`
                      : 'Via fee-bump relayer',
                    hash: data.txHash || null,
                    t: nowT(),
                  },
                ],
              },
            }
          })
          if (data.status === 'skipped' && stepName === 'swap') {
            addLog({
              event: 'SwapExecuted',
              agent: dId,
              meta: data.reason || 'Skipped. No swap is required.',
            })
          }
          if (data.status === 'done') {
            const evMap = {
              swap: 'SwapExecuted',
              approve: 'ApproveExecuted',
              deposit: 'DepositExecuted',
            }
            if (stepName === 'deposit') {
              const gasLabel =
                data.gasMethod === 'relayer'
                  ? 'Gas paid by relayer'
                  : data.gasMethod === 'user-signed'
                    ? 'Gas paid by user, relay not configured'
                    : ''
              addLog({
                event: 'DepositExecuted',
                agent: dId,
                meta: `${data.txHash ? `Transaction ${shortAddr(data.txHash)}` : 'No transaction hash'}${gasLabel ? `. ${gasLabel}.` : '.'}`,
              })
            } else if (evMap[stepName]) {
              addLog({
                event: evMap[stepName],
                agent: dId,
                meta: data.txHash ? `Transaction ${shortAddr(data.txHash)}` : 'No transaction hash',
              })
            }
          }
        }

        if (evName === 'completed') {
          setExecMap((prev) => {
            const cur = prev[dId] || prev[agentId] || {}
            return {
              ...prev,
              [dId]: {
                ...cur,
                status: 'confirmed',
                activeStep: null,
                // The de-simulated worker only emits swap (skipped) + deposit, so the discrete
                // "approve" step never fires — it was satisfied by the orchestrator's batched
                // USDC approve + authorizeSessionKey. Mark it confirmed on completion so the
                // step count reaches 3/3 (else allDone never trips → "waiting for relayer" hangs).
                steps: { ...(cur.steps || {}), approve: 'confirmed', deposit: 'confirmed' },
                memory: [
                  ...(cur.memory || []),
                  {
                    status: 'confirmed',
                    title: 'Agent completed',
                    meta: `Tx ${shortAddr(data.txHash)}`,
                    hash: data.txHash,
                    lesson: 'Vault deposit completed. The strategy executed.',
                    t: nowT(),
                  },
                ],
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
          const ag = strategy?.agents?.find((a) => a.id === dId)
          if (ag && data.txHash)
            saveTransaction({
              txHash: data.txHash,
              vaultName: ag.vault.name,
              vaultAddress: ag.vault.addr,
              protocol: ag.vault.protocol,
              amountUsdc: ag.allocation,
              apy: ag.vault.apy,
              workerLabel: ag.name,
              workerId: ag.id,
              network: 'stellar-testnet',
            })
        }

        if (evName === 'failed') {
          setExecMap((prev) => {
            const cur = prev[dId] || prev[agentId] || {}
            return {
              ...prev,
              [dId]: {
                ...cur,
                status: 'failed',
                activeStep: null,
                memory: [
                  ...(cur.memory || []),
                  {
                    status: 'failed',
                    title: 'Agent failed',
                    meta: data.error || 'Unknown error',
                    t: nowT(),
                  },
                ],
                metrics: { ...(cur.metrics || {}), completedAt: Date.now(), successRate: 0 },
              },
            }
          })
          addLog({ event: 'AgentFailed', agent: dId, meta: data.error })
        }
      },
    })

    orch
      .dispatch(yvStrategy, strategy.total)
      .then((summary) => {
        addLog({
          event: 'OrchestratorPlanned',
          meta: `Completed: ${summary.completed} deposited, ${summary.failed} failed.`,
        })
        const addrs = summary.agentAddresses || []
        deployedAgentsRef.current = addrs
        if (addrs.length) saveDeployedAgents(realAddress, addrs)
      })
      .catch((err) => {
        console.warn('[app] orchestrator dispatch failed (simulation mode):', err?.message || err)
        addLog({
          event: 'AgentFailed',
          meta: `Orchestrator simulation failed: ${err?.message || err}`,
        })
        setExecMap((prev) => {
          const next = { ...prev }
          Object.keys(next).forEach((id) => {
            if (next[id]?.status === 'running' || next[id]?.status === 'idle') {
              next[id] = { ...next[id], status: 'failed', activeStep: null }
            }
          })
          return next
        })
        setMonitorStatus({
          level: 'skip',
          score: 0,
          reason: 'Stellar relayer offline. Simulation mode. Council Monitor badge visible.',
          lastCheck: Date.now(),
          result: 'approved',
        })
      })
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
  const handleExecDone = async () => {
    setStage('done')
    // ACE loop: credit/debit the rules the council cited at review time, based on
    // how the deposit actually went. Closes review → deposit → reflect end-to-end.
    const { citedRules, verdict } = councilCitedRef.current
    if (verdict === 'keep' && citedRules.length) {
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
    setRawStrategy(null)
    setStrategyAttestation(null)
    setAttesting(false)
    setSkillStates({})
    setEditingTexts({})
    setConnectPhase('idle')
    setConnectError(null)
    setPermActive(false)
    setPermError(null)
    setPermExpiresAt(null)
    clearResume(realAddress)
    setSessionResumed(false)
    setVeniceAuth(null)
    setMarketLive(null)
    setVaultLive(null)
    setExecMap({})
    setLogs([])
    agentMapRef.current = {}

    if (
      overrideAmount !== undefined &&
      overrideAmount !== null &&
      (typeof overrideAmount === 'number' ||
        typeof overrideAmount === 'string' ||
        !isNaN(Number(overrideAmount)))
    ) {
      setAmount(String(overrideAmount))
      setStrategyPhase('thinking')
      setThinkingPhase(0)
      addLog({
        event: 'OrchestratorPlanned',
        meta: `${overrideAmount} usdc, ${risk} risk, planning`,
      })
    } else {
      setStrategyPhase('input')
      setThinkingPhase(0)
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
    setRealAddress(null)
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

  /* ----- Step rail: navigate back to a completed step (state preserved) ----- */
  const goBack = (id) => {
    if (id === 'strategy') setStrategyPhase('ready')
    setStage(id)
  }

  /* ----- Jump to step (tweaks panel) ----- */
  const jumpTo = (id) => {
    if (id === 'strategy') {
      setStage('strategy')
      setStrategyPhase('input')
      setThinkingPhase(0)
      return
    }
    const ensured = strategy || buildStrategy(amount, risk)
    if (!strategy) {
      setStrategy(ensured)
      const sk = {}
      ensured.agents.forEach((a) => {
        sk[a.id] = { state: 'approved', skill: null }
      })
      setSkillStates(sk)
    }
    if (id === 'connect') {
      setStage('connect')
      setConnectPhase('idle')
      return
    }
    if (id === 'skills') {
      setStage('skills')
      setConnectPhase('upgraded')
      return
    }
    if (id === 'permission') {
      setStage('permission')
      setPermPhase('idle')
      setConnectPhase('upgraded')
      const sk = {}
      ensured.agents.forEach((a) => {
        sk[a.id] = { state: 'approved', skill: null }
      })
      setSkillStates(sk)
      return
    }
    if (id === 'execute') {
      setStage('execute')
      setConnectPhase('upgraded')
      setPermActive(true)
      const sk = {}
      ensured.agents.forEach((a) => {
        sk[a.id] = { state: 'approved', skill: null }
      })
      setSkillStates(sk)
      startExecution(null)
      return
    }
    if (id === 'done') {
      setStage('done')
      setConnectPhase('upgraded')
      setPermActive(true)
      // Preserve real execution state. Navigating back to "done" must NOT fabricate
      // tx hashes — only fill a confirmed shell (no hashes) for agents the user
      // genuinely reached but whose live exec map was lost (e.g. after reload).
      setExecMap((prev) => {
        const map = { ...(prev || {}) }
        ensured.agents.forEach((a) => {
          const cur = map[a.id]
          const alreadyReal = cur && cur.hashes && cur.hashes.deposit
          if (alreadyReal) return // keep real, event-sourced state untouched
          map[a.id] = {
            status: 'confirmed',
            activeStep: null,
            steps: { swap: 'skipped', approve: 'confirmed', deposit: 'confirmed' },
            hashes: cur?.hashes || {}, // no fabricated hash — empty if no real tx
            gasMethod: cur?.gasMethod || null,
            memory: cur?.memory?.length
              ? cur.memory
              : [
                  {
                    status: 'confirmed',
                    title: 'Agent completed',
                    meta: 'Position confirmed on-chain',
                    t: nowT(),
                    lesson: 'Vault deposit complete',
                  },
                ],
            metrics: cur?.metrics || {
              totalRuns: 1,
              successRate: 100,
              startedAt: Date.now(),
              completedAt: Date.now(),
            },
          }
        })
        return map
      })
    }
  }

  const renderStage = () => {
    switch (stage) {
      case 'strategy':
        if (strategyPhase === 'input')
          return (
            <InputScreen
              amount={amount}
              setAmount={setAmount}
              risk={risk}
              setRisk={setRisk}
              onSubmit={handleSubmitPreference}
            />
          )
        if (strategyPhase === 'thinking')
          return <ThinkingCard phase={thinkingPhase} times={thinkTimes} />
        return (
          <StrategyCard
            strategy={strategy}
            skillSource={skillSource}
            onProceed={handleAcceptStrategy}
            onRegenerate={handleRegenerate}
            strategyHash={rawStrategy?.strategyHash}
            attestation={strategyAttestation}
            attesting={attesting}
            simulation={simulation}
            council={debateResult || council}
            onCouncilRetry={handleRunCouncil}
            onRunCouncil={handleRunCouncil}
            debateRunning={debateRunning}
            showRunCouncil={!debateResult}
          />
        )
      case 'connect':
        return (
          <ConnectCard
            phase={connectPhase}
            error={connectError}
            onConnect={handleConnect}
            onUpgrade={handleUpgrade}
            onDone={handleConnectDone}
            onCancel={() => {
              setConnectPhase('idle')
              setStage('strategy')
            }}
          />
        )
      case 'skills':
        return (
          <SkillReviewCard
            agents={strategy?.agents || []}
            riskProfile={risk}
            skillStates={skillStates}
            onApprove={handleSkillApprove}
            onApproveAll={handleApproveAll}
            onSkillUpdate={handleSkillUpdate}
            onContinue={handleSkillsContinue}
          />
        )
      case 'permission':
        // Router path: ONE grant signature (budget + window) replaces the per-agent batch. Legacy path
        // (router unset / VITE_LEGACY_AGENT_SETUP=1) keeps the original PermissionCard flow.
        return USE_FUNDING_ROUTER ? (
          <GrantPanel
            defaultBudget={strategy?.total ?? 100}
            agentCount={strategy?.agents?.length ?? 0}
            phase={grantPhase}
            error={grantError}
            onGrant={handleGrantAndRun}
            onRevoke={handleRevokeGrant}
          />
        ) : (
          <PermissionCard
            strategy={strategy}
            eligibility={eligibility}
            phase={permPhase}
            error={permError}
            onGrant={handleGrant}
            onConfirm={handlePermConfirm}
            onReject={handlePermReject}
          />
        )
      case 'execute':
        return (
          <ExecuteCard
            strategy={strategy}
            execMap={execMap}
            paletteIsLight={paletteIsLight}
            onOpenMemory={setOpenAgentId}
            onDone={handleExecDone}
          />
        )
      case 'done':
        return <SuccessCard strategy={strategy} onAgain={handleAgain} address={realAddress} />
      default:
        return null
    }
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

  // vf-autofarm keeper/strategy/pool force-graph cluster (Task 15). Memoized on the strategy
  // address list (not the whole `autofarmReads.strategies` array, which gets a new reference
  // every 15s poll even when addresses are unchanged) so the canvas physics don't reheat/jitter
  // on every tick — only when the registered strategy set actually changes.
  const autofarmStrategyKey = autofarmReads.strategies
    .map((s) => `${s.address}:${s.poolAddress || ''}`)
    .join(',')
  const autofarmGraphData = useM(
    () =>
      buildAutofarmGraphData({
        vaultAddress: SOROBAN_AUTOFARM_VAULT_ADDRESS,
        keeperAddress: SOROBAN_KEEPER_ADDRESS,
        strategies: autofarmReads.strategies,
      }),
    [autofarmStrategyKey]
  )

  // Public pages — standalone full-bleed, own NavBar, no wallet required.
  // Checked before every gate so judges and visitors can browse without connecting.
  if (location.pathname === '/explorer') {
    return (
      <Suspense fallback={<div className="route-loading" aria-busy="true" />}>
        <ExplorerPage />
      </Suspense>
    )
  }
  if (location.pathname === '/ecosystem') {
    return (
      <Suspense fallback={<div className="route-loading" aria-busy="true" />}>
        <EcosystemPage />
      </Suspense>
    )
  }
  if (location.pathname === '/replay') {
    return (
      <Suspense fallback={<div className="route-loading" aria-busy="true" />}>
        <ReplayPage />
      </Suspense>
    )
  }

  // Landing takeover — first-time, not-yet-connected visitors see the scroll
  // hero before anything else. "Start farming" persists yv_skip_landing and
  // sets the URL to /strategy, which surfaces once onboarding (connect) completes.
  if (!skipLanding && !realAddress) {
    return (
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
      </Suspense>
    )
  }

  // APY-first onboarding — full-screen takeover for first-time users (not yet onboarded).
  // Screen 1 (value prop, no wallet) → connect → Screen 2 (how it works) → main app.
  // "Skip intro" or "Got it" persists yv_onboarded=true so it never shows again.
  if (!onboarded) {
    return (
      <OnboardingFlow
        connected={!!realAddress}
        onConnect={handleConnect}
        onComplete={() => {
          localStorage.setItem('yv_onboarded', 'true')
          setOnboarded(true)
        }}
      />
    )
  }

  return (
    <div
      className={`app ${sbExtended ? 'sb-extended' : 'sb-minimized'} ${railCollapsed ? 'rail-collapsed' : ''}`}
    >
      <Sidebar extended={sbExtended} onToggle={toggleSb} />
      <main className="main">
        <TopBar
          walletConnected={walletPhase !== 'none'}
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
              <HomePage
                userAddress={realAddress}
                positions={agentData.positions}
                alerts={agentData.alerts}
                vaultMeta={agentVaultMeta}
                lastUpdated={agentData.lastUpdated}
                agentActive={agentEnabled && stage === 'done'}
                autoHarvest={agentSettings.autoHarvest}
                sessionResumed={sessionResumed}
                onDismissResumed={() => setSessionResumed(false)}
                onConnect={handleConnect}
                onStartStrategy={handleAgain}
                onOpenAgent={() => navigate('/agent')}
                onViewHistory={() => navigate('/history')}
                onWithdrawSuccess={handleWithdrawSuccess}
                scopes={scopes}
              />
            }
          />
          <Route
            path="/strategy"
            element={
              <>
                <StepRail stage={stage} furthest={furthest} onStepClick={goBack} lang={language} />
                {/* Key only major strategy sub-views so "Run risk review" (stays on ready)
                    does not remount the whole card like a page refresh. */}
                <div
                  className="stage"
                  key={`${stage}-${strategyPhase === 'thinking' || strategyPhase === 'input' ? strategyPhase : 'plan'}`}
                >
                  {renderStage()}
                </div>
              </>
            }
          />
          <Route
            path="/agent"
            element={
              <div className="stage">
                <Suspense fallback={<div className="route-loading" aria-busy="true" />}>
                  <OpsConsole
                    positions={agentData.positions}
                    vaultMeta={agentVaultMeta}
                    lastUpdated={agentData.lastUpdated}
                    userAddress={realAddress}
                    withdrawEnabled={stage !== 'execute' && stage !== 'permission'}
                    onWithdrawSuccess={handleWithdrawSuccess}
                    onNewStrategy={handleAgain}
                    monitorStatus={monitorStatus}
                    loop={
                      agentEnabled
                        ? {
                            running: loopRef.current?.isRunning() || false,
                            phase: loopPhase,
                            cycle: loopRef.current?.getCycle() || 0,
                            nextTickAt: loopRef.current?.getNextTickAt() || null,
                            heartbeatMs:
                              loopRef.current?.getHeartbeatMs() ||
                              (agentSettings.apyInterval || 10) * 60 * 1000,
                            rows: getCycles().slice(0, 40),
                            summary: getJournalSummary(),
                            decisionsRows: getDecisions().slice(0, 30),
                            decisionsSummary: getDecisionSummary(),
                          }
                        : null
                    }
                    keeper={{
                      events: keeperActivity,
                      pricePerShare: autofarmReads.pricePerShare,
                      strategies: autofarmReads.strategies,
                    }}
                    lifeboat={{
                      state: lifeboatState,
                      events: lifeboatActivity,
                      busy: lifeboatBusy,
                      onGrant: onGrantMandate,
                    }}
                    scopes={scopes}
                    onRevoke={handleRevokeAgent}
                    graph={{
                      data: autofarmGraphData,
                      paletteIsLight,
                      pulseEdge: rebalancePulse,
                    }}
                  />
                </Suspense>
              </div>
            }
          />
          <Route path="/history" element={<HistoryPanel />} />
          <Route
            path="/settings"
            element={
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
            }
          />
          <Route
            path="/vault/:protocol"
            element={<VaultDetailPage positions={agentData.positions} />}
          />
          <Route path="/tx/:txHash" element={<TxDetailPage />} />
          <Route
            path="/developers/*"
            element={
              <Suspense fallback={<div className="route-loading" aria-busy="true" />}>
                <DevelopersLayout />
              </Suspense>
            }
          />
          <Route path="/farm" element={<CrossChainFarmFlow />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
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

      {slowConfirm && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true">
            <div className="modal-eyebrow">AI timeout</div>
            <h3 className="modal-title">AI is still processing. Keep waiting?</h3>
            <p className="lede" style={{ marginTop: 8 }}>
              Generation has exceeded {Math.round(VENICE_TIMEOUT_MS / 1000)} seconds. Do you want to
              keep waiting or use the default strategy instead?
            </p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={handleStopWaiting}>
                Use default
              </button>
              <button className="btn btn-primary" onClick={handleKeepWaiting}>
                Keep waiting
              </button>
            </div>
          </div>
        </div>
      )}

      {devMode && (
        <TweaksPanel title="Tweaks">
          <TweakSection label="Brand palette" />
          <PalettePicker value={tweaks.palette} onChange={(v) => setTweak('palette', v)} />

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

          <TweakSection label="Jump to step, dev only" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            {STEPS.map((s, i) => (
              <button
                key={s.id}
                type="button"
                onClick={() => jumpTo(s.id)}
                style={{
                  appearance: 'none',
                  border: '.5px solid rgba(0,0,0,.08)',
                  borderRadius: 6,
                  background: stage === s.id ? 'rgba(0,0,0,.08)' : 'rgba(255,255,255,.4)',
                  color: 'inherit',
                  font: 'inherit',
                  fontSize: 10.5,
                  fontWeight: stage === s.id ? 600 : 500,
                  padding: '6px 8px',
                  textAlign: 'left',
                  cursor: 'pointer',
                  letterSpacing: '-0.01em',
                }}
              >
                <span
                  style={{
                    color: 'rgba(41,38,27,.45)',
                    marginRight: 5,
                    fontFamily: 'ui-monospace, monospace',
                  }}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                {s.label}
              </button>
            ))}
          </div>
        </TweaksPanel>
      )}
    </div>
  )
}

export default App
