// SettingsPage.jsx
// Full settings panel. Agent config lives in app state (yv_agent_settings); the rest
// persists via settingsStore (individual yv_* keys). Renders when view === 'settings'.
import React, { useEffect, useRef, useState } from 'react'
import { VENICE_BASE_URL, DEEPSEEK_BASE_URL } from '../config.js'
import {
  SOROBAN_REGISTRY_ADDRESS,
  SOROBAN_VAULT_ADDRESS,
  SOROBAN_ACTIVE_VAULT_ADDRESS,
  SOROBAN_TOKEN_ADDRESS,
} from '../stellar/config.js'
import { loadSettings, saveSetting, SETTINGS_DEFAULTS, t } from '../settingsStore.js'
import {
  getHistorySummary,
  clearTransactions,
  clearStrategies,
  clearReasoningLog,
  clearAllHistory,
} from '../history.js'
import { fmtRemaining } from '../ui.js'
import { NETWORK_IDS } from '../design/networks.js'
import LegacyAutoExitCleanup from './settings/LegacyAutoExitCleanup.jsx'
import { getTokenUsageHistory, clearTokenUsageHistory } from '../strategist.js'
import { BrandLockup } from './pocket/BrandLockup.jsx'
import { CreditsAbout } from './pocket/CreditsAbout.jsx'
import { Dialog } from './pocket/Primitives.jsx'
import { NetworkBadge } from './pocket/NetworkIdentity.jsx'
import BaseMandateManager from './settings/BaseMandateManager.jsx'
import './settings/settings.css'

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '-')

// Category tabs — replaces the single long scroll with one panel per click.
const TABS = [
  { id: 'agent', label: 'Agent' },
  { id: 'strategy', label: 'Strategy' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'wallet', label: 'Wallet' },
  { id: 'data', label: 'Data & Privacy' },
  { id: 'about', label: 'About' },
]
const Section = ({ title, children }) => (
  <section className="pc-settings-section">
    <div className="pc-settings-eyebrow">{title}</div>
    <div className="pc-settings-card">{children}</div>
  </section>
)
const Divider = () => <div className="pc-settings-divider" />
const SubLabel = ({ children }) => <div className="pc-settings-label">{children}</div>
const Row = ({ label, desc, children }) => (
  <div className="pc-settings-row">
    <div className="pc-settings-row-copy">
      <div className="pc-settings-row-title">{label}</div>
      {desc && <div className="pc-settings-row-description">{desc}</div>}
    </div>
    <div className="pc-settings-row-control">{children}</div>
  </div>
)
const Toggle = ({ on, onChange, onLabel = 'ON', offLabel = 'OFF' }) => (
  <div className="pc-settings-toggle">
    {[
      [true, onLabel],
      [false, offLabel],
    ].map(([v, l]) => (
      <button
        key={l}
        type="button"
        onClick={() => onChange(v)}
        className={`pc-settings-toggle-option ${on === v ? 'pc-settings-toggle-option--active' : ''}`}
      >
        {l}
      </button>
    ))}
  </div>
)
const Radio = ({ sel, onClick, title, desc }) => (
  <button
    type="button"
    className={`skill-opt pc-settings-radio ${sel ? 'sel' : ''}`}
    onClick={onClick}
  >
    <span className="skill-radio" />
    <span className="skill-opt-main">
      <span className="skill-opt-title">{title}</span>
      {desc && <span className="skill-opt-desc">{desc}</span>}
    </span>
  </button>
)
const Num = ({ value, onChange, suffix, step = '1', width = 64 }) => (
  <span className="pc-settings-number-group" data-size={width > 64 ? 'wide' : 'compact'}>
    <input
      type="number"
      className="mono pc-settings-number"
      value={value}
      step={step}
      onChange={(e) => onChange(e.target.value)}
    />
    {suffix && <span className="pc-settings-number-suffix">{suffix}</span>}
  </span>
)
const Check = ({ on, onChange, label }) => (
  <button type="button" onClick={() => onChange(!on)} className="pc-settings-check">
    <span className={`pc-settings-checkbox ${on ? 'pc-settings-checkbox--checked' : ''}`} />
    <span>{label}</span>
  </button>
)
const ApiKeyField = ({ value, onChange, onClear, onTest, testState }) => {
  const [reveal, setReveal] = useState(false)
  return (
    <div className="pc-settings-api-key">
      <div className="pc-settings-api-key-row">
        <input
          type={reveal ? 'text' : 'password'}
          value={value}
          placeholder="••••••••••••"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          className="mono pc-settings-api-input"
        />
        <button type="button" className="pc-settings-button" onClick={() => setReveal((r) => !r)}>
          {reveal ? 'Hide' : 'Show'}
        </button>
        <button type="button" className="pc-settings-button" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="pc-settings-api-key-status">
        <button
          type="button"
          className="pc-settings-button"
          onClick={onTest}
          disabled={testState === 'testing'}
        >
          {testState === 'testing' ? 'Testing…' : 'Test connection'}
        </button>
        {testState === 'ok' && (
          <span className="pc-settings-status pc-settings-status--ok">Connected</span>
        )}
        {testState === 'fail' && (
          <span className="pc-settings-status pc-settings-status--danger">
            Rejected. Check the key.
          </span>
        )}
        {testState === 'unreachable' && (
          <span className="pc-settings-status pc-settings-status--warn">
            Unreachable from browser (CORS/network)
          </span>
        )}
      </div>
    </div>
  )
}
const ContractRow = ({ name, addr }) => (
  <div className="pc-settings-contract-row">
    <span className="pc-settings-muted">{name}</span>
    <span className="pc-settings-contract-value">
      <span className="mono">{short(addr)}</span>
      <a
        href={`https://stellar.expert/explorer/testnet/contract/${addr}`}
        target="_blank"
        rel="noopener noreferrer"
        className="pc-settings-button"
      >
        Explorer
      </a>
    </span>
  </div>
)

const readSettingsLocation = () => {
  if (typeof window === 'undefined') return { tab: 'agent', deepLink: false, signature: '' }
  const requested = new URLSearchParams(window.location.search).get('tab')
  const tab = TABS.some((item) => item.id === requested) ? requested : 'agent'
  return {
    tab,
    deepLink: tab === 'wallet' && window.location.hash === '#base-mandate',
    signature: `${window.location.pathname}${window.location.search}${window.location.hash}`,
  }
}

const withTimeout = (ms) => {
  const c = new AbortController()
  const id = setTimeout(() => c.abort(), ms)
  return { signal: c.signal, done: () => clearTimeout(id) }
}

export default function SettingsPage({
  userAddress,
  walletPhase = 'none',
  permActive = false,
  permExpiresAt = null,
  permissionCount = 0,
  agentEnabled = true,
  setAgentEnabled,
  agentSettings = {},
  setAgentSettings,
  skillSource = 'default',
  language = 'en',
  onLanguageChange,
  onChangeSkill,
  onResetSkill,
  onResetAgentSettings,
  onConnect,
  onDisconnect,
  onRevoke,
  addLog,
  mandateView = null,
  connected = false,
  busy = false,
  error = null,
  onSetup,
  onRenew,
  onBaseRevoke,
  onRefresh,
}) {
  const [s, setS] = useState(loadSettings)
  const [location, setLocation] = useState(readSettingsLocation)
  const [tab, setTab] = useState(() => readSettingsLocation().tab)
  const [test, setTest] = useState({ venice: 'idle', deepseek: 'idle', tavily: 'idle' })
  const [confirmClear, setConfirmClear] = useState(false)
  const clearCancelRef = useRef(null)
  const [copied, setCopied] = useState(false)
  const [, setTick] = useState(0)
  const observedLocationSignature = useRef(null)
  const focusedDeepLinkSignature = useRef(null)
  const refresh = () => setTick((x) => x + 1)

  useEffect(() => {
    const updateLocation = () => setLocation(readSettingsLocation())
    window.addEventListener('popstate', updateLocation)
    window.addEventListener('hashchange', updateLocation)
    return () => {
      window.removeEventListener('popstate', updateLocation)
      window.removeEventListener('hashchange', updateLocation)
    }
  }, [])

  useEffect(() => {
    setTab(location.tab)
  }, [location])

  useEffect(() => {
    if (observedLocationSignature.current !== location.signature) {
      observedLocationSignature.current = location.signature
      focusedDeepLinkSignature.current = null
    }
    if (!location.deepLink || tab !== 'wallet') return
    if (focusedDeepLinkSignature.current === location.signature) return
    const target = document.getElementById('base-mandate')
    if (!target) return
    target.focus({ preventScroll: true })
    target.scrollIntoView?.({ block: 'start' })
    focusedDeepLinkSignature.current = location.signature
  }, [location, tab])

  const set = (key, val) => {
    setS((p) => ({ ...p, [key]: val }))
    saveSetting(key, val)
  }
  const setAgent = (k, v) => setAgentSettings?.((p) => ({ ...p, [k]: v }))
  const customSkill = skillSource === 'user-local' || skillSource === 'user-file'

  // Honest preview of which provider the current keys + preference will hit.
  // "host demo key" = the operator's key in the deploy env; on a BYOK lockdown
  // deploy that is unset, so it degrades to the deterministic fallback strategy.
  const activeProvider = (() => {
    const pref = s.modelPreference || 'auto'
    const hasV = !!s.veniceApiKey
    const hasD = !!s.deepseekApiKey
    const noKey = {
      label: 'No key. The app uses the host demo key or a deterministic fallback.',
      tone: 'warn',
    }
    if (pref === 'venice')
      return hasV
        ? { label: 'Venice, your key', tone: 'ok' }
        : { label: `Venice selected, ${noKey.label}`, tone: 'warn' }
    if (pref === 'deepseek')
      return hasD
        ? { label: 'DeepSeek, your key', tone: 'ok' }
        : { label: `DeepSeek selected, ${noKey.label}`, tone: 'warn' }
    if (hasV) return { label: 'Venice, your key', tone: 'ok' }
    if (hasD) return { label: 'DeepSeek, your key', tone: 'ok' }
    return noKey
  })()

  const testVenice = async () => {
    setTest((t) => ({ ...t, venice: 'testing' }))
    const to = withTimeout(8000)
    try {
      const res = await fetch(`${VENICE_BASE_URL}/models`, {
        headers: s.veniceApiKey ? { Authorization: `Bearer ${s.veniceApiKey}` } : {},
        signal: to.signal,
      })
      setTest((t) => ({ ...t, venice: res.ok ? 'ok' : 'fail' }))
    } catch (e) {
      setTest((t) => ({ ...t, venice: 'unreachable' }))
    } finally {
      to.done()
    }
  }
  const testDeepSeek = async () => {
    setTest((t) => ({ ...t, deepseek: 'testing' }))
    const to = withTimeout(8000)
    try {
      const res = await fetch(`${DEEPSEEK_BASE_URL}/models`, {
        headers: s.deepseekApiKey ? { Authorization: `Bearer ${s.deepseekApiKey}` } : {},
        signal: to.signal,
      })
      setTest((t) => ({ ...t, deepseek: res.ok ? 'ok' : 'fail' }))
    } catch (e) {
      setTest((t) => ({ ...t, deepseek: 'unreachable' }))
    } finally {
      to.done()
    }
  }
  const testTavily = async () => {
    setTest((t) => ({ ...t, tavily: 'testing' }))
    const to = withTimeout(8000)
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.tavilyApiKey}` },
        body: JSON.stringify({ query: 'defi yield', max_results: 1, include_answer: false }),
        signal: to.signal,
      })
      setTest((t) => ({ ...t, tavily: res.ok ? 'ok' : 'fail' }))
    } catch (e) {
      setTest((t) => ({ ...t, tavily: 'unreachable' }))
    } finally {
      to.done()
    }
  }

  const yvKeys = () => {
    const out = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('yv_')) out.push(k)
    }
    return out
  }
  const exportData = () => {
    const data = {}
    yvKeys().forEach((k) => {
      data[k] = localStorage.getItem(k)
    })
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    )
    const a = document.createElement('a')
    a.href = url
    a.download = 'vibing-farmer-export.json'
    a.click()
    URL.revokeObjectURL(url)
  }
  const clearAll = () => {
    clearAllHistory()
    clearTokenUsageHistory()
    yvKeys().forEach((k) => localStorage.removeItem(k))
    onResetAgentSettings?.()
    setS({ ...SETTINGS_DEFAULTS })
    setConfirmClear(false)
    refresh()
  }
  const copyAddr = async () => {
    try {
      await navigator.clipboard.writeText(userAddress)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch (e) {
      console.warn('[settings] clipboard failed')
    }
  }

  const telemetryHistory = getTokenUsageHistory()
  const telemetryStats = {
    prompt: telemetryHistory.reduce((acc, h) => acc + (h.promptTokens || 0), 0),
    completion: telemetryHistory.reduce((acc, h) => acc + (h.completionTokens || 0), 0),
    total: telemetryHistory.reduce((acc, h) => acc + (h.totalTokens || 0), 0),
    history: telemetryHistory,
  }

  const sum = getHistorySummary()
  const skillSet = !!localStorage.getItem('yv_user_skill')
  const agentSet = !!localStorage.getItem('yv_agent_settings')
  const total =
    sum.transactions +
    sum.strategies +
    sum.reasoning +
    (agentSet ? 1 : 0) +
    (skillSet ? 1 : 0) +
    telemetryHistory.length
  const ghUrl = import.meta.env.VITE_GITHUB_URL || '#'

  return (
    <div className="pc-settings enter">
      <header className="pc-settings-header">
        {/* 2026-08-02 polish (audit item #13): this route had no real page heading at all --
            the first text on screen was a tab strip. One h1 gives the page its identity. */}
        <h1 className="pc-settings-title">Settings</h1>
        <div className="pc-settings-tabs" role="tablist" aria-label="Settings sections">
          {TABS.map((tb) => (
            <button
              key={tb.id}
              type="button"
              onClick={() => setTab(tb.id)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                setTab(tb.id)
              }}
              className={`pc-settings-tab ${tab === tb.id ? 'pc-settings-tab--active' : ''}`}
              role="tab"
              id={`settings-tab-${tb.id}`}
              aria-controls={`settings-panel-${tb.id}`}
              aria-selected={tab === tb.id}
              tabIndex={0}
            >
              {tb.label}
            </button>
          ))}
        </div>
      </header>
      <div className="pc-settings-scroll">
        <div
          className="pc-settings-content"
          id={`settings-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`settings-tab-${tab}`}
        >
          {/* ── SECTION 1: Agent Configuration ── */}
          {tab === 'agent' && (
            <Section title="Agent Configuration">
              <Row
                label="Autonomous Agent"
                desc="When enabled, agent monitors positions and alerts you in the background automatically."
              >
                <Toggle
                  on={agentEnabled}
                  onChange={(v) => setAgentEnabled?.(v)}
                  onLabel="Enable"
                  offLabel="Disable"
                />
              </Row>
              <Divider />
              <SubLabel>Harvest Settings</SubLabel>
              <Row label={t(language, 'automationLabel')} desc={t(language, 'automationDesc')}>
                <Toggle
                  on={!!agentSettings.autoHarvest}
                  onChange={(v) => setAgent('autoHarvest', v)}
                />
              </Row>
              <Row
                label="Min reward to harvest"
                desc="Only harvest when unclaimed rewards exceed this. Prevents harvesting small amounts that waste gas."
              >
                <Num
                  value={agentSettings.harvestMinUsdc ?? 1}
                  step="0.1"
                  suffix="USDC"
                  onChange={(v) => setAgent('harvestMinUsdc', Number(v))}
                />
              </Row>
              <Divider />
              <SubLabel>Monitoring Intervals</SubLabel>
              <Row label="Position check">
                <Num
                  value={agentSettings.positionInterval ?? 5}
                  suffix="min"
                  onChange={(v) => setAgent('positionInterval', Number(v))}
                />
              </Row>
              <Row label="APY check">
                <Num
                  value={agentSettings.apyInterval ?? 10}
                  suffix="min"
                  onChange={(v) => setAgent('apyInterval', Number(v))}
                />
              </Row>
              <Row label="Risk scan">
                <Num
                  value={agentSettings.riskInterval ?? 15}
                  suffix="min"
                  onChange={(v) => setAgent('riskInterval', Number(v))}
                />
              </Row>
              <Row label="Reward check">
                <Num
                  value={agentSettings.rewardInterval ?? 5}
                  suffix="min"
                  onChange={(v) => setAgent('rewardInterval', Number(v))}
                />
              </Row>
              <Divider />
              <SubLabel>Alert Thresholds</SubLabel>
              <Row
                label="APY drop alert"
                desc="Alert when vault APY drops more than this % from baseline (your APY at deposit time)."
              >
                <Num
                  value={agentSettings.apyDropPct ?? 20}
                  suffix="%"
                  onChange={(v) => setAgent('apyDropPct', Number(v))}
                />
              </Row>
              <Row
                label="Rebalance opportunity"
                desc="Propose rebalance when another vault offers this much higher APY than your current position."
              >
                <Num
                  value={agentSettings.rebalanceThresholdPct ?? 1.5}
                  step="0.1"
                  suffix="%"
                  onChange={(v) => setAgent('rebalanceThresholdPct', Number(v))}
                />
              </Row>
              <Row
                label="Max drawdown alert"
                desc="Alert and trigger high-severity risk when absolute vault drawdown exceeds this threshold."
              >
                <Num
                  value={agentSettings.maxDrawdownPct ?? 10.0}
                  step="0.5"
                  suffix="%"
                  onChange={(v) => setAgent('maxDrawdownPct', Number(v))}
                />
              </Row>
              <Divider />
              <SubLabel>Emergency Withdraw</SubLabel>
              <div className="pc-settings-stack pc-settings-stack--tight">
                <Radio
                  sel={!!agentSettings.emergencyFull}
                  onClick={() => setAgent('emergencyFull', true)}
                  title="Full position (100%)"
                />
                <div
                  className="skill-opt"
                  role="presentation"
                  onClick={() => setAgent('emergencyFull', false)}
                >
                  <span className={`skill-radio ${!agentSettings.emergencyFull ? '' : ''}`}>
                    {!agentSettings.emergencyFull && <span className="pc-settings-radio-dot" />}
                  </span>
                  <span className="skill-opt-main pc-settings-inline-control">
                    <span className="skill-opt-title">Partial:</span>
                    <Num
                      value={agentSettings.emergencyPct ?? 50}
                      suffix="%"
                      onChange={(v) => {
                        setAgent('emergencyFull', false)
                        setAgent('emergencyPct', Number(v))
                      }}
                    />
                  </span>
                </div>
              </div>
              <div className="pc-settings-note">
                When RiskWatcher detects a high severity threat, emergency withdraw will use this
                setting.
              </div>
            </Section>
          )}

          {/* ── SECTION 1B: Council Continuous Monitor ── */}
          {tab === 'agent' && (
            <Section title="Council Monitor">
              <Row
                label="Continuous re-evaluation"
                desc="When enabled, Council re-evaluates your plan periodically against live market data. Pre-check and APY drift comparison cost $0; fast Risk/Compliance re-eval costs ~$0.0005 per check; full debate costs ~$0.001-0.003."
              >
                <Toggle
                  on={s.monitorEnabled}
                  onChange={(v) => set('monitorEnabled', v)}
                  onLabel="Enabled"
                  offLabel="Disabled"
                />
              </Row>
              {s.monitorEnabled && (
                <>
                  <Divider />
                  <SubLabel>Re-evaluation Thresholds</SubLabel>
                  <Row
                    label="APY drift"
                    desc="Min % APY drift from last council snapshot to trigger a re-evaluation."
                  >
                    <Num
                      value={s.apyDriftThreshold ?? 5}
                      step="1"
                      suffix="%"
                      onChange={(v) => set('apyDriftThreshold', Number(v))}
                    />
                  </Row>
                  <Row
                    label="VaR breach"
                    desc="Min % relative VaR change from last council snapshot to trigger a full debate."
                  >
                    <Num
                      value={s.varBreachThreshold ?? 10}
                      step="1"
                      suffix="%"
                      onChange={(v) => set('varBreachThreshold', Number(v))}
                    />
                  </Row>
                  <Divider />
                  <SubLabel>Autonomy</SubLabel>
                  <Row
                    label="Auto-approve"
                    desc="If fast re-eval passes, update snapshot silently without notification. Only use when you trust the council model after observing its decisions."
                  >
                    <Toggle
                      on={s.autoApprove}
                      onChange={(v) => set('autoApprove', v)}
                      onLabel="On (auto-update)"
                      offLabel="Off (notify)"
                    />
                  </Row>
                </>
              )}
            </Section>
          )}

          {/* ── SECTION 2: Vault Strategy ── */}
          {tab === 'strategy' && (
            <Section title="Vault Strategy">
              <Row
                label="Active Skill"
                desc={
                  customSkill
                    ? 'Custom strategy, user-defined'
                    : 'Default Strategy by Vibing Farmer'
                }
              >
                <button type="button" className="pc-settings-button" onClick={onChangeSkill}>
                  Change skill
                </button>
              </Row>
              <Divider />
              <SubLabel>AI Model, Strategy model</SubLabel>
              <Radio
                sel={s.modelPreference === 'auto'}
                onClick={() => set('modelPreference', 'auto')}
                title="Auto (recommended)"
                desc="Uses your Venice key first, then DeepSeek, the host demo key, or the fallback."
              />
              <Radio
                sel={s.modelPreference === 'venice'}
                onClick={() => set('modelPreference', 'venice')}
                title="Venice AI"
                desc="Prefer Venice (x402 wallet or your Venice key); skip DeepSeek"
              />
              <Radio
                sel={s.modelPreference === 'deepseek'}
                onClick={() => set('modelPreference', 'deepseek')}
                title="DeepSeek"
                desc="Prefer your DeepSeek key (OpenAI-compatible, direct call)"
              />
              <div className="pc-settings-note" data-tone={activeProvider.tone}>
                Active: {activeProvider.label}
                {userAddress ? ', a funded x402 wallet overrides this.' : ''}
              </div>
              <Row
                label="Venice API Key"
                desc="Routes strategy to api.venice.ai (Bearer auth). Alternative to the x402 wallet path; not required for it. Stored in this tab's sessionStorage, never sent to our servers."
              >
                <span />
              </Row>
              <ApiKeyField
                value={s.veniceApiKey}
                onChange={(v) => set('veniceApiKey', v)}
                onClear={() => set('veniceApiKey', '')}
                onTest={testVenice}
                testState={test.venice}
              />
              <Row
                label="DeepSeek API Key"
                desc="Routes strategy directly to api.deepseek.com (OpenAI-compatible Bearer auth). Bring your own key so the public demo never spends the operator's. Stored in this tab's sessionStorage, never sent to our servers."
              >
                <span />
              </Row>
              <ApiKeyField
                value={s.deepseekApiKey}
                onChange={(v) => set('deepseekApiKey', v)}
                onClear={() => set('deepseekApiKey', '')}
                onTest={testDeepSeek}
                testState={test.deepseek}
              />
              <Divider />
              <SubLabel>Vault Data Source</SubLabel>
              <Radio
                sel={s.vaultDataSource === 'live'}
                onClick={() => set('vaultDataSource', 'live')}
                title="Live (DeFiLlama, updated every 10 min)"
                desc="Venice AI receives real APY and TVL from Ethereum mainnet protocols."
              />
              <Radio
                sel={s.vaultDataSource === 'static'}
                onClick={() => set('vaultDataSource', 'static')}
                title="Static (hardcoded catalog, no network)"
              />
              <Divider />
              <SubLabel>Market Context</SubLabel>
              <Row
                label="Tavily web search"
                desc="Enriches AI strategy with real-time DeFi market news before vault selection."
              >
                <Toggle on={!!s.marketContext} onChange={(v) => set('marketContext', v)} />
              </Row>
              <Row label="Tavily API Key">
                <span />
              </Row>
              <ApiKeyField
                value={s.tavilyApiKey}
                onChange={(v) => set('tavilyApiKey', v)}
                onClear={() => set('tavilyApiKey', '')}
                onTest={testTavily}
                testState={test.tavily}
              />
            </Section>
          )}

          {/* ── SECTION 3: Alerts & Notifications ── */}
          {tab === 'alerts' && (
            <Section title="Alerts & Notifications">
              <SubLabel>Show alerts by severity</SubLabel>
              <Check
                on={s.alertSeverity.high}
                onChange={(v) => set('alertSeverity', { ...s.alertSeverity, high: v })}
                label="High severity (exploits, depegs, major APY crash)"
              />
              <Check
                on={s.alertSeverity.medium}
                onChange={(v) => set('alertSeverity', { ...s.alertSeverity, medium: v })}
                label="Medium severity (oracle concerns, APY compression)"
              />
              <Check
                on={s.alertSeverity.low}
                onChange={(v) => set('alertSeverity', { ...s.alertSeverity, low: v })}
                label="Low severity (minor fluctuations, speculation)"
              />
              <Divider />
              <SubLabel>Alert Behavior</SubLabel>
              <Row
                label="Risk alert persistence"
                desc="Per session: dismissed alerts reappear on page reload. Permanent: dismissed alerts never shown again."
              >
                <Toggle
                  on={s.alertPersistence === 'session'}
                  onChange={(v) => set('alertPersistence', v ? 'session' : 'permanent')}
                  onLabel="Per session"
                  offLabel="Permanent"
                />
              </Row>
              <Row
                label="Alert banner on home page"
                desc="Show risk alert banner at top of home page when high/medium threats are detected."
              >
                <Toggle on={!!s.alertBanner} onChange={(v) => set('alertBanner', v)} />
              </Row>
              <Divider />
              <SubLabel>Push Notifications (Telegram / Discord)</SubLabel>
              <div className="pc-settings-stack">
                <div>
                  <div className="pc-settings-field-label">Discord Webhook URL</div>
                  <input
                    type="text"
                    value={agentSettings.discordWebhookUrl || ''}
                    placeholder="https://discord.com/api/webhooks/..."
                    onChange={(e) => setAgent('discordWebhookUrl', e.target.value)}
                    className="pc-settings-text-input"
                  />
                </div>
                <div>
                  <div className="pc-settings-field-label">Telegram Bot Token</div>
                  <input
                    type="password"
                    value={agentSettings.telegramToken || ''}
                    placeholder="123456789:ABCdef..."
                    onChange={(e) => setAgent('telegramToken', e.target.value)}
                    className="pc-settings-text-input mono"
                  />
                </div>
                <div>
                  <div className="pc-settings-field-label">Telegram Chat ID</div>
                  <input
                    type="text"
                    value={agentSettings.telegramChatId || ''}
                    placeholder="Example: 987654321"
                    onChange={(e) => setAgent('telegramChatId', e.target.value)}
                    className="pc-settings-text-input mono"
                  />
                </div>
              </div>
              <Divider />
              <SubLabel>Display, Timestamp format</SubLabel>
              <Radio
                sel={s.timestampFormat === 'relative'}
                onClick={() => set('timestampFormat', 'relative')}
                title="Relative (2 min ago, 1 hr ago)"
              />
              <Radio
                sel={s.timestampFormat === 'absolute'}
                onClick={() => set('timestampFormat', 'absolute')}
                title="Absolute (17:00:18, 30 May 2026)"
              />
              <SubLabel>Language</SubLabel>
              <Radio
                sel={language === 'en'}
                onClick={() => onLanguageChange?.('en')}
                title="English"
              />
              <Radio
                sel={language === 'id'}
                onClick={() => onLanguageChange?.('id')}
                title="Indonesia"
                desc="changes UI labels only, not AI reasoning output."
              />
            </Section>
          )}

          {/* ── SECTION 4: Wallet & Network ── */}
          {tab === 'wallet' && (
            <Section title="Wallet & Network">
              <Row label="Network">
                <NetworkBadge networkId={NETWORK_IDS.STELLAR_TESTNET} />
              </Row>
              <Divider />
              {userAddress ? (
                <>
                  <Row
                    label="Connected Wallet"
                    desc={walletPhase === 'upgraded' ? 'Session keys active' : 'Standard wallet'}
                  >
                    <span className="mono pc-settings-wallet-address">{short(userAddress)}</span>
                    <button type="button" className="pc-settings-button" onClick={copyAddr}>
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                    <button type="button" className="pc-settings-button" onClick={onDisconnect}>
                      Disconnect
                    </button>
                  </Row>
                  <Divider />
                  <Row
                    label="Active Permissions"
                    desc={
                      permActive
                        ? `${permissionCount} permission, ${fmtRemaining(permExpiresAt) || '-'} remaining, session scope, batch`
                        : 'no active permission'
                    }
                  >
                    {permActive && (
                      <button
                        type="button"
                        className="pc-settings-button pc-settings-button--danger"
                        onClick={onRevoke}
                      >
                        Revoke all
                      </button>
                    )}
                  </Row>
                  <Divider />
                  <Row label="Network fee" desc="Sponsored by fee-bump relay.">
                    <span />
                  </Row>
                </>
              ) : (
                <Row label="Wallet" desc="Not connected.">
                  <button type="button" className="pc-settings-button" onClick={onConnect}>
                    Connect Wallet
                  </button>
                </Row>
              )}
              <Divider />
              <BaseMandateManager
                mandateView={mandateView}
                connected={connected}
                busy={busy}
                error={error}
                onSetup={onSetup}
                onRenew={onRenew}
                onRevoke={onBaseRevoke}
                onRefresh={onRefresh}
              />
            </Section>
          )}

          {/* ── SECTION 5: Data & Privacy ── */}
          {tab === 'data' && (
            <Section title="Data & Privacy">
              <SubLabel>Local Storage Usage</SubLabel>
              {[
                ['Transactions', `${sum.transactions} entries`],
                ['Strategy sessions', `${sum.strategies} entries`],
                ['AI reasoning logs', `${sum.reasoning} entries`],
                ['Agent settings', agentSet ? '1 entry' : 'Not set'],
                ['User skill', skillSet ? 'Set' : 'Not set'],
                ['AI telemetry log', `${telemetryHistory.length} entries`],
              ].map(([k, v]) => (
                <div key={k} className="pc-settings-data-row">
                  <span>{k}</span>
                  <span className="mono">{v}</span>
                </div>
              ))}
              <div className="pc-settings-data-row pc-settings-data-row--total">
                <span>Total</span>
                <span className="mono">~{total} entries</span>
              </div>
              <div className="pc-settings-actions">
                <button type="button" className="pc-settings-button" onClick={exportData}>
                  Export all data
                </button>
                <button
                  type="button"
                  className="pc-settings-button pc-settings-button--danger"
                  onClick={() => setConfirmClear(true)}
                >
                  Clear all data
                </button>
              </div>
              <Dialog
                open={confirmClear}
                title="Clear all data?"
                description="This clears all history and resets settings. Continue?"
                onClose={() => setConfirmClear(false)}
                initialFocusRef={clearCancelRef}
                actions={
                  <>
                    <button
                      ref={clearCancelRef}
                      type="button"
                      className="pc-settings-button"
                      onClick={() => setConfirmClear(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="pc-settings-button pc-settings-button--danger"
                      onClick={clearAll}
                    >
                      Yes, clear all
                    </button>
                  </>
                }
              />
              <Divider />
              <SubLabel>Clear Individual Stores</SubLabel>
              <Row label="Transaction history">
                <button
                  type="button"
                  className="pc-settings-button"
                  onClick={() => {
                    clearTransactions()
                    refresh()
                  }}
                >
                  Clear
                </button>
              </Row>
              <Row label="Strategy history">
                <button
                  type="button"
                  className="pc-settings-button"
                  onClick={() => {
                    clearStrategies()
                    refresh()
                  }}
                >
                  Clear
                </button>
              </Row>
              <Row label="AI reasoning log">
                <button
                  type="button"
                  className="pc-settings-button"
                  onClick={() => {
                    clearReasoningLog()
                    refresh()
                  }}
                >
                  Clear
                </button>
              </Row>
              <Row label="User skill (custom)">
                <button
                  type="button"
                  className="pc-settings-button"
                  onClick={() => {
                    onResetSkill?.()
                    refresh()
                  }}
                >
                  Reset to default
                </button>
              </Row>
              <Row label="Agent settings">
                <button
                  type="button"
                  className="pc-settings-button"
                  onClick={() => onResetAgentSettings?.()}
                >
                  Reset to defaults
                </button>
              </Row>
              <Divider />
              <SubLabel>AI Token Telemetry</SubLabel>
              <div className="pc-settings-telemetry">
                <div className="pc-settings-data-row">
                  <span>Total Prompt Tokens</span>
                  <span className="mono">{telemetryStats.prompt}</span>
                </div>
                <div className="pc-settings-data-row">
                  <span>Total Completion Tokens</span>
                  <span className="mono">{telemetryStats.completion}</span>
                </div>
                <div className="pc-settings-data-row">
                  <span>Total Tokens Used</span>
                  <span className="mono pc-settings-emphasis">{telemetryStats.total}</span>
                </div>
                {telemetryStats.history.length > 0 && (
                  <div className="pc-settings-telemetry-history">
                    <div className="pc-settings-small-label">Recent API Requests (last 5):</div>
                    <div className="pc-settings-telemetry-list">
                      {telemetryStats.history
                        .slice(-5)
                        .reverse()
                        .map((h, i) => (
                          <div key={i} className="pc-settings-telemetry-item">
                            <span className="pc-settings-muted">
                              {new Date(h.timestamp).toLocaleTimeString()} ({h.model})
                            </span>
                            <span className="mono">
                              P: {h.promptTokens} | C: {h.completionTokens} | T: {h.totalTokens}
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  className="pc-settings-button pc-settings-button--spaced"
                  onClick={() => {
                    clearTokenUsageHistory()
                    refresh()
                  }}
                >
                  Clear Telemetry History
                </button>
              </div>
              <Divider />
              <SubLabel>Legacy auto-exit data</SubLabel>
              <div className="pc-settings-legacy">
                <LegacyAutoExitCleanup addLog={addLog} />
              </div>
              <Divider />
              <SubLabel>Privacy Notes</SubLabel>
              {[
                'API keys for Venice, DeepSeek, and Tavily stay in this tab and are cleared when it closes.',
                'Venice AI does not retain queries.',
                'DeepSeek prompts go directly to api.deepseek.com when you provide a key.',
                'The hosted demo key is used only when you provide no key and the deployment has one configured.',
                'Tavily receives search queries.',
                'DeFiLlama receives no wallet data.',
                'The fee-bump relayer can see transaction data submitted on-chain.',
                'All other data stays in your browser.',
              ].map((n) => (
                <div key={n} className="pc-settings-privacy-note">
                  <span className="ui-dot" aria-hidden="true" />
                  {n}
                </div>
              ))}
            </Section>
          )}

          {/* ── SECTION 6: About ── */}
          {tab === 'about' && (
            <Section title="About">
              <div className="pc-settings-about">
                <BrandLockup variant="full" />
              </div>
              <div className="pc-settings-about-subtitle">Autonomous DeFi yield farming agent</div>
              <div className="pc-settings-about-meta">
                {[
                  ['Version', import.meta.env.VITE_APP_VERSION],
                  ['Network', 'Stellar testnet'],
                  ['Contracts', 'Verified on Sourcify'],
                ].map(([k, v]) => (
                  <div key={k} className="pc-settings-data-row pc-settings-data-row--compact">
                    <span className="pc-settings-muted">{k}</span>
                    <span className="mono">{v}</span>
                  </div>
                ))}
              </div>
              <Divider />
              <ContractRow name="AgentRegistry" addr={SOROBAN_REGISTRY_ADDRESS} />
              <ContractRow name="Autofarm Vault (vfVLT)" addr={SOROBAN_ACTIVE_VAULT_ADDRESS} />
              <ContractRow name="Legacy vault (1:1)" addr={SOROBAN_VAULT_ADDRESS} />
              <ContractRow name="VFUSD token" addr={SOROBAN_TOKEN_ADDRESS} />
              <Divider />
              <div className="pc-settings-about-copy">
                Uses Soroban session keys, fee-bump relaying, and Venice AI.
              </div>
              <div className="pc-settings-about-list">
                {[
                  'The fee-bump relayer pays transaction fees.',
                  'Venice AI can generate strategies.',
                  'Agent workers execute in parallel.',
                  'Soroban session keys limit each agent’s scope.',
                ].map((p) => (
                  <div key={p}>{p}</div>
                ))}
              </div>
              <div className="pc-settings-actions pc-settings-actions--about">
                {ghUrl !== '#' && (
                  <a
                    href={ghUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="pc-settings-button"
                  >
                    View on GitHub
                  </a>
                )}
              </div>
              <Divider />
              <CreditsAbout />
            </Section>
          )}
        </div>
        {TABS.filter((item) => item.id !== tab).map((item) => (
          <div
            key={`settings-panel-${item.id}`}
            id={`settings-panel-${item.id}`}
            role="tabpanel"
            aria-labelledby={`settings-tab-${item.id}`}
            hidden
          />
        ))}
      </div>
    </div>
  )
}
