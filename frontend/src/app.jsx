/* ============================================
   VIBING FARMER — App (multi-agent + real Web3)
   Design state machine wired to real wallet.js / venice.js / orchestrator.js
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
  LoopStatusPanel,
  DecisionLogPanel,
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
import { generateStrategy } from './venice.js'
import { toDisplay, toBaseUnits } from './stellar/format.js'
import { saveResume, loadResume, clearResume } from './strategy/sessionResume.js'
import { attestStrategyOnChain, formatAttestation } from './attestation.js'
import OnboardingFlow from './components/OnboardingFlow.jsx'
import { OrchestratorAgent } from './orchestrator.js'
import { makeAgentId } from './worker.js'
import { ownerWithdraw } from './stellar/exit.js'
import { VAULT_CATALOG, VENICE_TIMEOUT_MS } from './config.js'
import { SOROBAN_VAULT_ADDRESS, SOROBAN_DEMO_AGENT } from './stellar/config.js'
import { evaluateExit } from './strategy/autoExit/engine.js'
import { runAutonomousExit } from './agents/exitExecutor.js'
import {
  loadPersistedPositions,
  persistPositions,
  reconcilePositionsFromChain,
  mergePositions,
  applyChainPositions,
} from './positionsStore.js'
import SkillDrawer from './components/SkillDrawer.jsx'
import HistoryPanel from './components/HistoryPanel.jsx'
import { saveTransaction } from './history.js'
import {
  startBackgroundAgent,
  stopBackgroundAgent,
  updateAgentConfig,
  onAgentEvent,
  emergencyWithdraw,
} from './agents/agentController.js'
const AgentDashboard = lazy(() => import('./components/AgentDashboard.jsx'))
import NotificationCenter from './components/NotificationCenter.jsx'
import HomePage from './components/HomePage.jsx'
const LandingHero = lazy(() => import('./components/LandingHero.jsx'))
const ExplorerPage = lazy(() => import('./components/ExplorerPage.jsx'))
const EcosystemPage = lazy(() => import('./components/EcosystemPage.jsx'))
const ReplayPage = lazy(() => import('./components/ReplayPage.jsx'))
const DevelopersPage = lazy(() => import('./developers/DevelopersPage.jsx'))
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
import { councilVerdict } from './strategy/council.js'
import { reflect } from './strategy/reflector.js'
import { increment as playbookIncrement, weight as playbookWeight } from './strategy/playbook.js'
import { saveCycle, getCycles, getJournalSummary } from './strategy/cycleJournal.js'
import { computeBasket } from './strategy/basketFilter.js'
import { mintToken } from './strategy/eligibilityGate.js'
import { buildEligibilitySentence, vaultEligibilityLabel } from './strategy/eligibilitySentence.js'
import { SNAPSHOT } from './strategy/vaultFacts.js'
import { recordDecision, getDecisions, getDecisionSummary } from './strategy/decisionLog.js'
import { resolveCouncilConflict, councilSpecialistVerdict, askVeniceJson } from './venice.js'
import { councilReview, buildCouncilInput } from './strategy/councilReview.js'
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
  apyInterval: 10,
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
  const isAlert = ['risk_alert', 'apy_drift', 'rebalance_proposal', 'harvest_ready'].includes(
    ev.kind
  )
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

  let title = 'Vibing Farmer · Alert'
  let detail = ''

  if (ev.kind === 'rebalance_proposal') {
    title = '🔄 Rebalance Opportunity Detected'
    detail = `Venice AI flagged ${ev.toProtocol} at ${ev.toApy}% vs your current ${ev.fromVault} at ${ev.fromApy}% (potential gain: +${ev.apyGain}%).`
  } else if (ev.kind === 'risk_alert') {
    title = `🚨 Risk Alert [Severity: ${ev.severity.toUpperCase()}]`
    detail = `Signal on ${ev.vaultName}: ${ev.searchAnswer || 'Security concern detected.'}`
  } else if (ev.kind === 'apy_drift') {
    title = '⚠ APY Drop Detected'
    detail = `APY on ${ev.vaultName} dropped from ${ev.baselineApy}% to ${ev.currentApy}% (${ev.driftPct}%).`
  } else if (ev.kind === 'harvest_ready') {
    title = '🟢 Yield Harvest Ready'
    detail = `${ev.rewardsUsdc} USDC accrued on ${ev.vaultName} is ready to claim.`
  }

  const messageText = `*${title}*\n\n${detail}\n\n_Time: ${new Date(ev.timestamp || Date.now()).toLocaleString()}_`

  // Send Discord notification
  if (settings.discordWebhookUrl) {
    try {
      await fetch(settings.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `🚨 **${title}**\n${detail}`,
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
    'Conservative · lending',
    'Balanced · liquidity provision',
    'Aggressive · leveraged yield',
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
      name: `Worker ${i + 1} · ${ROLES[i]?.split(' · ')[0] || 'Conservative'}`,
      role: ROLES[i] || 'Conservative · lending',
      allocation: +(total * v.allocation).toFixed(2),
      skillName: 'yield_vault_deposit',
      reasoning: v.reasoning, // AI metadata → UI
      riskTier: v.risk_tier, // AI metadata → UI
      yieldSource: v.yield_source_type, // AI metadata → UI
      vault: {
        name: v.name || live.name || cat.name || `MockVault ${i + 1}`,
        protocol: v.protocol || live.protocol || cat.protocol || PROTOCOLS[i] || 'aave-v3',
        apy: String(v.expected_apy ?? live.apy ?? cat.apy ?? 4.8),
        drawdown: live.drawdown || cat.drawdown || '-1.8',
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

  // execution: map agentId -> { status, steps, hashes, memory, metrics }
  const [execMap, setExecMap] = useS({})
  const [openAgentId, setOpenAgentId] = useS(null)

  const [logs, setLogs] = useS([])
  const logIdRef = useR(0)
  const agentMapRef = useR({})

  // Real Web3 state
  const [realAddress, setRealAddress] = useS(null)
  const loopRef = useR(null)
  const latestGasRef = useR(null) // last live gas snapshot { level, gwei } for the monitor loop
  const hydratedRef = useR(null) // address whose cached positions have finished restoring
  // Tracks which user addresses have had session key setup done (survives re-renders).
  const [loopTick, setLoopTick] = useS(0)
  const [loopPhase, setLoopPhase] = useS(null) // live pipeline phase from monitorLoop onPhase
  const [veniceAuth, setVeniceAuth] = useS(null)
  const [onboarded, setOnboarded] = useS(() => localStorage.getItem('yv_onboarded') === 'true')
  const [skipLanding, setSkipLanding] = useS(
    () => localStorage.getItem('yv_skip_landing') === 'true'
  )

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
      '/strategy': 'New Strategy · vibing / farmer',
      '/agent': 'Autonomous Agent · vibing / farmer',
      '/history': 'History · vibing / farmer',
      '/settings': 'Settings · vibing / farmer',
    }
    document.title = titles[location.pathname] || 'vibing / farmer'
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
    reconcilePositionsFromChain(realAddress)
      .then((chain) => {
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
      })
      .catch(() => {})
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
      const chain = await reconcilePositionsFromChain(realAddress).catch(() => null)
      if (!alive || !chain) return
      setAgentData((d) => ({
        ...d,
        positions: applyChainPositions(d.positions, chain),
        lastUpdated: Date.now(),
      }))
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
    if (ev.kind === 'harvest_executed') {
      addLog({
        event: 'DepositExecuted',
        meta: `auto-harvest ${ev.vaultName} · tx ${shortAddr(ev.txHash)}`,
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
        ? `Venice AI flagged ${ev.toProtocol} at ${ev.toApy}% vs your ${ev.fromVault} at ${ev.fromApy}% · capture +${ev.apyGain}% by rebalancing.`
        : ev.kind === 'risk_alert'
          ? `Severity ${ev.severity} · classified by Venice AI. Signal on ${ev.vaultName}. Action: alert surfaced, awaiting your decision.`
          : ev.kind === 'apy_drift'
            ? `APY on ${ev.vaultName} dropped to ${ev.currentApy}% (from ${ev.baselineApy}%, ${ev.driftPct}%).`
            : ev.kind === 'harvest_ready'
              ? `${ev.rewardsUsdc} USDC accrued on ${ev.vaultName} · ready to claim.`
              : ''
    addLog({
      event: ev.kind === 'risk_alert' ? 'AgentFailed' : 'OrchestratorPlanned',
      meta: `${ev.kind.replace(/_/g, ' ')} · ${ev.vaultName || ev.fromVault || ''}`,
      detail,
    })
  }

  // Start after deposit (positions exist), stop on disable / disconnect / leaving 'done'
  useE(() => {
    if (stage !== 'done' || !agentEnabled || !realAddress || !strategy?.agents?.length) return
    upsertSeeds() // ACE: install seed rules + fold any legacy counters once
    // Monitor EVERY held position (accumulated across deposits), not just the latest
    // strategy — otherwise a new deposit would stop the agent watching earlier vaults.
    let activeVaults = buildActiveVaults(agentData.positions, strategy)
    if (!activeVaults.length)
      activeVaults = strategy.agents.map((a) => ({
        address: a.vault.addr,
        name: a.vault.name,
        protocol: a.vault.protocol,
        depositApy: Number(a.vault.apy),
      }))
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
    addLog({ event: 'OrchestratorPlanned', meta: 'background agent · monitoring started' })

    // ── Autonomous monitor loop — NEVER-STOP spine + TradingAgents council ──
    const loop = createMonitorLoop({
      getState: async () =>
        buildStrategyState({
          amountUsdc: Number(amount) || 0,
          riskLevel: risk,
          numVaults: strategy.agents.length,
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
          meta: `proposal · ${idea.kind} ${idea.vaultName || idea.fromVault || ''}`.trim(),
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
            const out = await askVeniceJson({ system: sys, user, devApiKey: devApiKey || null })
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
      heartbeatMs: (agentSettings.apyInterval || 10) * 60 * 1000,
      onPhase: (p) => setLoopPhase(p === 'sleep' ? null : p),
    })
    loopRef.current = loop
    loop.start()

    return () => {
      unsub()
      stopBackgroundAgent()
      loop.stop()
      loopRef.current = null
      setLoopPhase(null)
    }
  }, [stage, agentEnabled, realAddress, strategy])

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
          meta: `🚨 Auto-Exit Triggered: ${result.reason}`,
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
              vaultAddress: SOROBAN_VAULT_ADDRESS,
              message: `Auto-Exit Triggered: ${result.reason}`,
              timestamp: Date.now(),
            },
            ...d.alerts,
          ],
        }))

        try {
          const txRes = await runAutonomousExit({
            agentAddress: SOROBAN_DEMO_AGENT,
            ownerAddress: realAddress,
          })
          addLog({
            event: 'AgentCompleted',
            meta: `✓ Autonomous Exit Succeeded! Tx: ${txRes.hash.slice(0, 8)}...`,
            detail: 'All vault shares redeemed and USDC principal returned to owner wallet.',
          })

          const chain = await reconcileWithRetry(realAddress)
          if (chain) {
            setAgentData((d) => ({
              ...d,
              positions: applyChainPositions(d.positions, chain),
              lastUpdated: Date.now(),
            }))
          }
        } catch (err) {
          console.error('[AutoExit] Autonomous exit failed:', err)
          addLog({
            event: 'AgentFailed',
            meta: `✗ Auto-Exit Failed: ${err.message}`,
            detail: 'Please execute emergency withdraw manually.',
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
        mainnetLine: `Protocol credibility: ${SNAPSHOT[a.vault.protocol]?.meta?.label || a.vault.protocol} — audited, TVL from snapshot`,
        testnetLine: 'This deposit: testnet — APR illustrative, realized yield may be ~0',
        asOf,
      }
    })
    return { fusedSentence, rows }
  }, [strategy])

  // AI Council deliberation for the proposed allocation. Async (3 parallel AI
  // calls + possible synthesis call) so it runs as an effect, not a useMemo. Uses
  // the SAME live signals as the simulation panel. AI-only: each specialist retries
  // once; if the provider still fails, the council reports 'unavailable' and the
  // panel offers a retry — no fabricated verdict.
  useE(() => {
    if (!strategy?.agents?.length) {
      setCouncil(undefined)
      return
    }
    let cancelled = false
    setCouncil(null) // → panel shows "deliberating"
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
          meta: `AI Council · ${result.verdict} · ${result.resolvedBy}${result.citedRules?.length ? ` · ${result.citedRules.join(', ')}` : ''}`,
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
  }, [strategy, amount, risk, councilRetry])

  const handleEmergencyWithdraw = async (alert) => {
    const pos = agentData.positions[alert.vaultAddress]
    const bal = BigInt(pos?.balance || '0')
    const amt = agentSettings.emergencyFull
      ? bal
      : (bal * BigInt(Math.round(agentSettings.emergencyPct))) / 100n
    if (amt <= 0n) {
      addLog({ event: 'AgentFailed', meta: 'emergency withdraw · no balance tracked yet' })
      return
    }
    try {
      const tx = await emergencyWithdraw(alert.vaultAddress, amt.toString(), realAddress)
      addLog({
        event: 'PermissionRevoked',
        meta: `emergency withdraw ${alert.vaultName} · tx ${shortAddr(tx)}`,
        txHash: tx,
        detail: `Emergency withdrew from ${alert.vaultName} to your wallet.`,
      })
      dismissAlert(alert.id)
    } catch (e) {
      addLog({ event: 'AgentFailed', meta: `withdraw failed: ${e.message}` })
    }
  }

  const handleReviewRebalance = (alert) =>
    addLog({
      event: 'OrchestratorPlanned',
      meta: `rebalance review · ${alert.fromVault} → ${alert.toProtocol} (+${alert.apyGain}%)`,
      detail: `Venice AI flagged ${alert.toProtocol} at ${alert.toApy}% vs ${alert.fromVault} at ${alert.fromApy}% (+${alert.apyGain}%). Rebalancing authorizes a fresh Soroban session-key scope for the new vault.`,
    })

  // Kill switch — user-signed Registry.revoke (works even if the relayer is down).
  // Optimistically flip the row; the on-chain agent_revoked subscription confirms it.
  const handleRevokeAgent = async (agent) => {
    try {
      const { hash: tx } = await revokeAgentOnChain({ owner: realAddress, agent })
      setScopes((prev) =>
        prev.map((s) =>
          s.agent?.toLowerCase() === agent.toLowerCase() ? { ...s, revoked: true } : s
        )
      )
      addLog({
        event: 'PermissionRevoked',
        meta: `revoked agent ${shortAddr(agent)} · tx ${shortAddr(tx)}`,
        txHash: tx,
        detail:
          'Agent scope revoked on-chain. Further deposits by this key now revert (ScopeInactive).',
      })
    } catch (e) {
      addLog({ event: 'AgentFailed', meta: `revoke failed: ${e.message}` })
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

  // After a withdraw: reduce/remove the position, sync the worker, stop the agent if empty
  const handleWithdrawSuccess = (vaultAddress, withdrawnUnits) => {
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
      meta: `withdrew ${shortAddr(vaultAddress)} · position updated`,
      detail: 'Position balance updated after withdraw; agent monitoring config synced.',
    })
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
        const chain = await reconcilePositionsFromChain(realAddress).catch(() => null)
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
    addLog({ event: 'OrchestratorPlanned', meta: `${amount} usdc · ${risk} risk · planning` })
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
            meta: `parallel fetch · gas ${veniceResult.mdpState.gasGwei} gwei (${veniceResult.mdpState.gasLevel})`,
          })
        }
        if (veniceResult.dagTimings) {
          const breakdown = Object.entries(veniceResult.dagTimings)
            .map(([id, ms]) => `${id} ${Math.round(ms)}ms`)
            .join(' · ')
          addLog({
            event: 'OrchestratorPlanned',
            meta: `dag · wall ${veniceResult.dagWallMs}ms`,
            detail: breakdown,
          })
        }
        setRawStrategy(veniceResult) // carries strategyHash → attestation effect picks it up once a provider exists
        if (veniceResult.generatedBy !== 'fallback') {
          s = mapVeniceToStrategy(veniceResult, amount, risk)
          addLog({
            event: 'OrchestratorPlanned',
            meta: `strategy via ${veniceResult.generatedBy} · ${(veniceResult.strategy_summary || veniceResult.rationale)?.slice(0, 60)}`,
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
        meta: `${s.agents.length} worker spawned · ${s.blendedApy}% blended apy`,
      })
    })()

    return () => {
      cancelled = true
    }
  }, [stage, strategyPhase])

  const handleAcceptStrategy = () => setStage('connect')

  const handleRegenerate = () => {
    setStrategy(null)
    setSkillStates({})
    setStrategyPhase('thinking')
    setThinkingPhase(0)
    addLog({ event: 'OrchestratorPlanned', meta: `re-planning · ${amount} usdc · ${risk} risk` })
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
      addLog({ event: 'AgentFailed', meta: `connect failed: ${err.message}` })
    }
  }

  const handleUpgrade = async () => {
    // ponytail: Venice x402 wallet-funded inference removed (single-chain Stellar; no EVM SIWE).
    // AI strategist runs via Settings keys / host proxy / deterministic fallback. veniceAuth stays
    // null — resolveProvider degrades cleanly. Re-add a Stellar-native paid-inference path here later.
    setConnectPhase('upgrading')
    setTimeout(() => {
      setConnectPhase('upgraded')
      addLog({ event: 'Authorized', meta: 'session ready · gas sponsored by relayer' })
    }, speed * 0.8)
  }

  const handleConnectDone = () => setStage('skills')

  /* ----- SKILLS (step 03) ----- */
  const updateSkillState = (id, patch) => {
    setSkillStates((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }

  const handleSkillApprove = (id) => {
    updateSkillState(id, { state: 'approved' })
    addLog({ event: 'SkillApproved', agent: id, meta: 'skill JSON approved · ready to bind' })
  }

  const handleApproveAll = () => {
    const next = {}
    Object.entries(skillStates).forEach(([id, s]) => {
      next[id] = { ...s, state: 'approved' }
    })
    setSkillStates(next)
    addLog({ event: 'SkillApproved', meta: `${Object.keys(next).length} skills approved · batch` })
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

  /* ----- PERMISSION (step 04) ----- */
  const handleGrant = () => setPermPhase('prompting')

  const handlePermReject = () => {
    setPermPhase('idle')
    addLog({ event: 'PermissionRevoked', meta: 'permission request rejected by user' })
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
    addLog({ event: 'PermissionGranted', meta: 'stellar · authorize + fund per agent at execute' })
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
      addLog({ event: 'ExecutionBlocked', meta: 'No eligible vault — nothing will run.' })
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

    const orch = new OrchestratorAgent({
      user: realAddress,
      veniceAuth: veniceAuth,
      devApiKey: devApiKey || null,
      sessionId,
      onEvent: (evName, data) => {
        if (evName === 'skill-gen-failed') {
          const dId = agentMapRef.current?.[data.agentId] || data.agentId
          addLog({
            event: 'AgentFailed',
            agent: dId,
            meta: `skill gen failed · ${data.error} · using fallback skill`,
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
                    title: 'agent started',
                    meta: `vault ${shortAddr(data.vault)}`,
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
          addLog({ event: 'AgentStarted', agent: dId, meta: `vault ${shortAddr(data.vault)}` })
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
                    title: `${stepName} ${data.status === 'done' ? 'confirmed' : 'executing'}`,
                    meta: data.txHash
                      ? `tx ${shortAddr(data.txHash)}${data.gasMethod === 'user-signed' ? ' · ⚠ user-signed' : ''}`
                      : 'via fee-bump relayer',
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
              meta: data.reason || 'skipped · no swap required',
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
                  ? 'gas paid by relayer'
                  : data.gasMethod === 'user-signed'
                    ? '⚠ gas paid by user · relay not configured'
                    : ''
              addLog({
                event: 'DepositExecuted',
                agent: dId,
                meta: `${data.txHash ? `tx ${shortAddr(data.txHash)}` : 'no tx hash'}${gasLabel ? ' · ' + gasLabel : ''}`,
              })
            } else if (evMap[stepName]) {
              addLog({
                event: evMap[stepName],
                agent: dId,
                meta: data.txHash ? `tx ${shortAddr(data.txHash)}` : 'no tx hash',
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
                    title: 'agent completed',
                    meta: `tx ${shortAddr(data.txHash)}`,
                    hash: data.txHash,
                    lesson: `vault deposit complete · strategy executed`,
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
            meta: data.txHash ? `tx ${shortAddr(data.txHash)}` : 'completed · no tx hash',
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
                    title: 'agent failed',
                    meta: data.error || 'unknown error',
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
          meta: `done · ${summary.completed} deposited, ${summary.failed} failed`,
        })
      })
      .catch((err) => {
        console.error('[app] orchestrator dispatch failed:', err)
        addLog({ event: 'AgentFailed', meta: `orchestrator error: ${err?.message || err}` })
        setExecMap((prev) => {
          const next = { ...prev }
          Object.keys(next).forEach((id) => {
            if (next[id]?.status === 'running' || next[id]?.status === 'idle') {
              next[id] = { ...next[id], status: 'failed', activeStep: null }
            }
          })
          return next
        })
      })
  }

  // Chain balances can lag 1-2 blocks after a deposit. Retry until at least one
  // vault reports a non-zero balance, then trust the on-chain numbers.
  async function reconcileWithRetry(address, maxAttempts = 3, delayMs = 3000) {
    for (let i = 0; i < maxAttempts; i++) {
      let result = null
      try {
        result = await reconcilePositionsFromChain(address)
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
        meta: `Council reflect · ${outcome} · ${citedRules.join(', ')}`,
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
    const chain = await reconcileWithRetry(realAddress)
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
    addLog({
      event: 'OrchestratorPlanned',
      meta: `multi-agent deployment finalized · ${strategy?.agents?.length} positions opened`,
    })
  }

  const handleAgain = () => {
    setStage('strategy')
    navigate('/strategy')
    setFurthest(0)
    setStrategyPhase('input')
    setThinkingPhase(0)
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
  }

  const handleRevoke = () => {
    setPermActive(false)
    setPermExpiresAt(null)
    clearResume(realAddress)
    setSessionResumed(false)
    ;(strategy?.agents || []).forEach((a) =>
      addLog({ event: 'PermissionRevoked', agent: a.id, meta: 'agent halted · scope cleared' })
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
    setVeniceAuth(null)
    clearResume(realAddress)
    setSessionResumed(false)
    addLog({ event: 'PermissionRevoked', meta: 'wallet disconnected · session cleared' })
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
                    title: 'agent completed',
                    meta: 'position confirmed on-chain',
                    t: nowT(),
                    lesson: 'vault deposit complete',
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
            council={council}
            onCouncilRetry={() => setCouncilRetry((n) => n + 1)}
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
        return (
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
              />
            }
          />
          <Route
            path="/strategy"
            element={
              <>
                <StepRail stage={stage} furthest={furthest} onStepClick={goBack} lang={language} />
                <div className="stage" key={`${stage}-${strategyPhase}`}>
                  {renderStage()}
                </div>
              </>
            }
          />
          <Route
            path="/agent"
            element={
              <div className="stage">
                <div style={{ maxWidth: 820, margin: '0 auto', width: '100%' }}>
                  {scopes.length > 0 && (
                    <div className="surface-card" style={{ padding: 14, marginBottom: 14 }}>
                      <div
                        style={{
                          fontSize: 11,
                          letterSpacing: '.04em',
                          textTransform: 'uppercase',
                          opacity: 0.6,
                          marginBottom: 8,
                        }}
                      >
                        Agent permissions · scoped on-chain
                      </div>
                      {scopes.map((s) => (
                        <div
                          key={s.agent}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 12,
                            padding: '6px 0',
                            borderTop: '.5px solid rgba(255,255,255,.06)',
                          }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div className="mono" style={{ fontSize: 12 }}>
                              {shortAddr(s.agent)}
                            </div>
                            <div style={{ fontSize: 10.5, opacity: 0.6 }}>
                              cap {toDisplay(s.capPerPeriod).toFixed(2)} · max-at-risk{' '}
                              {toDisplay(s.maxAtRisk).toFixed(2)} USDC
                            </div>
                          </div>
                          {s.revoked ? (
                            <span style={{ fontSize: 11, color: 'var(--danger)' }}>revoked</span>
                          ) : (
                            <button
                              className="btn btn-ghost"
                              style={{ fontSize: 11, padding: '4px 10px' }}
                              onClick={() => handleRevokeAgent(s.agent)}
                            >
                              Revoke
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <Suspense fallback={<div className="route-loading" aria-busy="true" />}>
                    <AgentDashboard
                      active={agentEnabled && stage === 'done'}
                      positions={agentData.positions}
                      alerts={agentData.alerts}
                      vaultMeta={agentVaultMeta}
                      lastUpdated={agentData.lastUpdated}
                      userAddress={realAddress}
                      settings={agentSettings}
                      withdrawEnabled={stage !== 'execute' && stage !== 'permission'}
                      onEmergencyWithdraw={handleEmergencyWithdraw}
                      onReview={handleReviewRebalance}
                      onDismiss={dismissAlert}
                      onWithdrawSuccess={handleWithdrawSuccess}
                      onNewStrategy={handleAgain}
                      loopStatus={
                        agentEnabled
                          ? {
                              running: loopRef.current?.isRunning() || false,
                              phase: loopPhase,
                              cycle: loopRef.current?.getCycle() || 0,
                            }
                          : null
                      }
                      // loopTick re-renders the parent on each journal write; no key remount
                      // so the panel's internal 1s countdown clock and CSS animations persist.
                      loopPanel={
                        agentEnabled && (
                          <LoopStatusPanel
                            running={loopRef.current?.isRunning() || false}
                            summary={getJournalSummary()}
                            rows={getCycles().slice(0, 8)}
                            phase={loopPhase}
                            nextTickAt={loopRef.current?.getNextTickAt() || null}
                            heartbeatMs={
                              loopRef.current?.getHeartbeatMs() ||
                              (agentSettings.apyInterval || 10) * 60 * 1000
                            }
                          />
                        )
                      }
                      decisionPanel={
                        agentEnabled && (
                          <DecisionLogPanel
                            rows={getDecisions().slice(0, 8)}
                            summary={getDecisionSummary()}
                          />
                        )
                      }
                    />
                  </Suspense>
                </div>
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
            path="/developers"
            element={
              <Suspense fallback={<div className="route-loading" aria-busy="true" />}>
                <DevelopersPage />
              </Suspense>
            }
          />
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
            <div className="modal-eyebrow">AI · timeout</div>
            <h3 className="modal-title">AI is still processing · continue waiting?</h3>
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

          <TweakSection label="Jump to step · dev only" />
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
