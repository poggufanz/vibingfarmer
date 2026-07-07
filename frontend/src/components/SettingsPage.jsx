// SettingsPage.jsx
// Full settings panel. Agent config lives in app state (yv_agent_settings); the rest
// persists via settingsStore (individual yv_* keys). Renders when view === 'settings'.
import React, { useState } from 'react'
import {
  AGENT_VAULT_DEPOSITOR_ADDRESS,
  MOCK_VAULT_A_ADDRESS,
  MOCK_VAULT_B_ADDRESS,
  MOCK_VAULT_C_ADDRESS,
  MOCK_VAULT_D_ADDRESS,
  SEPOLIA_CHAIN_ID,
  VENICE_BASE_URL,
  DEEPSEEK_BASE_URL,
} from '../config.js'
import { loadSettings, saveSetting, SETTINGS_DEFAULTS } from '../settingsStore.js'
import {
  getHistorySummary,
  clearTransactions,
  clearStrategies,
  clearReasoningLog,
  clearAllHistory,
} from '../history.js'
import { fmtRemaining } from '../ui.js'
import { signSiweForVenice } from '../wallet.js'
import { getX402Balance } from '../x402.js'

const X402_DOCS_URL = 'https://docs.venice.ai/guides/integrations/x402-venice-api'

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '-')
const eyebrow = {
  fontSize: 11,
  letterSpacing: '0.01em',
  color: 'var(--text-muted)',
  textTransform: 'capitalize',
  fontWeight: 500,
}
const card = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: '16px 18px',
}
const miniBtn = {
  appearance: 'none',
  border: '.5px solid var(--border-strong)',
  borderRadius: 5,
  background: 'rgba(255,255,255,.06)',
  color: 'inherit',
  font: 'inherit',
  fontSize: 11,
  padding: '5px 10px',
  cursor: 'pointer',
}
const dangerBtn = { ...miniBtn, borderColor: 'var(--danger)', color: 'var(--danger)' }
const inputStyle = {
  background: 'var(--bg-input)',
  border: '1px solid var(--border-strong)',
  borderRadius: 6,
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  padding: '6px 9px',
}

// Category tabs — replaces the single long scroll with one panel per click.
const TABS = [
  { id: 'agent', label: 'Agent' },
  { id: 'strategy', label: 'Strategy' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'wallet', label: 'Wallet' },
  { id: 'data', label: 'Data & Privacy' },
  { id: 'about', label: 'About' },
]
const tabBtn = (active) => ({
  appearance: 'none',
  border: 0,
  background: 'transparent',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 12.5,
  padding: '10px 14px',
  whiteSpace: 'nowrap',
  color: active ? 'inherit' : 'var(--text-muted)',
  fontWeight: active ? 600 : 500,
  borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
  marginBottom: -1,
})

const Section = ({ title, children }) => (
  <div style={{ marginBottom: 28 }}>
    <div style={eyebrow}>{title}</div>
    <div style={{ ...card, marginTop: 10 }}>{children}</div>
  </div>
)
const Divider = () => <div style={{ borderTop: '1px solid var(--border)', margin: '14px 0' }} />
const SubLabel = ({ children }) => (
  <div style={{ fontSize: 12, fontWeight: 600, margin: '2px 0 6px' }}>{children}</div>
)
const Row = ({ label, desc, children }) => (
  <div
    style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: 16,
      padding: '8px 0',
    }}
  >
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 13 }}>{label}</div>
      {desc && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            marginTop: 3,
            lineHeight: 1.5,
            maxWidth: 430,
          }}
        >
          {desc}
        </div>
      )}
    </div>
    <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>{children}</div>
  </div>
)
const Toggle = ({ on, onChange, onLabel = 'ON', offLabel = 'OFF' }) => (
  <div
    style={{
      display: 'inline-flex',
      border: '1px solid var(--border-strong)',
      borderRadius: 6,
      overflow: 'hidden',
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
    }}
  >
    {[
      [true, onLabel],
      [false, offLabel],
    ].map(([v, l]) => (
      <button
        key={l}
        type="button"
        onClick={() => onChange(v)}
        style={{
          appearance: 'none',
          border: 0,
          padding: '5px 12px',
          cursor: 'pointer',
          font: 'inherit',
          background: on === v ? 'var(--accent)' : 'transparent',
          color: on === v ? 'var(--accent-fg)' : 'var(--text-muted)',
        }}
      >
        {l}
      </button>
    ))}
  </div>
)
const Radio = ({ sel, onClick, title, desc }) => (
  <button
    type="button"
    className={`skill-opt ${sel ? 'sel' : ''}`}
    onClick={onClick}
    style={{ marginBottom: 6 }}
  >
    <span className="skill-radio" />
    <span className="skill-opt-main">
      <span className="skill-opt-title">{title}</span>
      {desc && <span className="skill-opt-desc">{desc}</span>}
    </span>
  </button>
)
const Num = ({ value, onChange, suffix, step = '1', width = 64 }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
    <input
      type="number"
      className="mono"
      value={value}
      step={step}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...inputStyle, width, textAlign: 'right' }}
    />
    {suffix && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{suffix}</span>}
  </span>
)
const Check = ({ on, onChange, label }) => (
  <button
    type="button"
    onClick={() => onChange(!on)}
    style={{
      appearance: 'none',
      border: 0,
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      display: 'flex',
      alignItems: 'center',
      gap: 9,
      cursor: 'pointer',
      padding: '5px 0',
      textAlign: 'left',
      width: '100%',
    }}
  >
    <span
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        border: '1px solid var(--border-strong)',
        background: on ? 'var(--accent)' : 'transparent',
        color: 'var(--accent-fg)',
        display: 'grid',
        placeItems: 'center',
        fontSize: 11,
        flex: 'none',
      }}
    >
      {on ? '✓' : ''}
    </span>
    <span style={{ fontSize: 12.5 }}>{label}</span>
  </button>
)
const ApiKeyField = ({ value, onChange, onClear, onTest, testState }) => {
  const [reveal, setReveal] = useState(false)
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type={reveal ? 'text' : 'password'}
          value={value}
          placeholder="••••••••••••"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          className="mono"
          style={{ ...inputStyle, flex: 1, minWidth: 0 }}
        />
        <button type="button" style={miniBtn} onClick={() => setReveal((r) => !r)}>
          {reveal ? 'hide' : 'show'}
        </button>
        <button type="button" style={miniBtn} onClick={onClear}>
          Clear
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        <button type="button" style={miniBtn} onClick={onTest} disabled={testState === 'testing'}>
          {testState === 'testing' ? 'Testing…' : 'Test connection'}
        </button>
        {testState === 'ok' && (
          <span style={{ fontSize: 11, color: 'var(--ok)' }}>✓ connected</span>
        )}
        {testState === 'fail' && (
          <span style={{ fontSize: 11, color: 'var(--danger)' }}>✗ rejected (check key)</span>
        )}
        {testState === 'unreachable' && (
          <span style={{ fontSize: 11, color: 'var(--warn)' }}>
            ⚠ unreachable from browser (CORS/network)
          </span>
        )}
      </div>
    </div>
  )
}
const ContractRow = ({ name, addr }) => (
  <div
    style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 10,
      padding: '6px 0',
      fontSize: 12,
    }}
  >
    <span style={{ color: 'var(--text-muted)' }}>{name}</span>
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className="mono">{short(addr)}</span>
      <a
        href={`https://sourcify.dev/#/lookup/${addr}`}
        target="_blank"
        rel="noopener noreferrer"
        style={{ ...miniBtn, textDecoration: 'none' }}
      >
        ↗ Sourcify
      </a>
    </span>
  </div>
)

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
  onSwitchNetwork,
  onRevoke,
}) {
  const [s, setS] = useState(loadSettings)
  const [tab, setTab] = useState('agent')
  const [test, setTest] = useState({ venice: 'idle', deepseek: 'idle', tavily: 'idle' })
  const [confirmClear, setConfirmClear] = useState(false)
  const [copied, setCopied] = useState(false)
  const [, setTick] = useState(0)
  const [x402, setX402] = useState({ state: 'idle', bal: null }) // idle | checking | done | error
  const refresh = () => setTick((x) => x + 1)

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
      label: 'no key → host demo key, or deterministic fallback if the deploy has none',
      tone: 'warn',
    }
    if (pref === 'venice')
      return hasV
        ? { label: 'Venice · your key', tone: 'ok' }
        : { label: `Venice selected, ${noKey.label}`, tone: 'warn' }
    if (pref === 'deepseek')
      return hasD
        ? { label: 'DeepSeek · your key', tone: 'ok' }
        : { label: `DeepSeek selected, ${noKey.label}`, tone: 'warn' }
    if (hasV) return { label: 'Venice · your key', tone: 'ok' }
    if (hasD) return { label: 'DeepSeek · your key', tone: 'ok' }
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
  // x402 balance: sign a fresh SIWE header (MetaMask) then read the prepaid balance.
  // Read-only — no funds move. Needs a connected wallet.
  const checkX402 = async () => {
    if (!userAddress) return
    setX402({ state: 'checking', bal: null })
    try {
      const auth = await signSiweForVenice(userAddress)
      const bal = await getX402Balance(userAddress, auth)
      setX402({ state: bal ? 'done' : 'error', bal })
    } catch (e) {
      console.warn('[settings] x402 balance check failed:', e.message)
      setX402({ state: 'error', bal: null })
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

  const sum = getHistorySummary()
  const skillSet = !!localStorage.getItem('yv_user_skill')
  const agentSet = !!localStorage.getItem('yv_agent_settings')
  const total =
    sum.transactions + sum.strategies + sum.reasoning + (agentSet ? 1 : 0) + (skillSet ? 1 : 0)
  const ghUrl = import.meta.env.VITE_GITHUB_URL || '#'

  return (
    <div
      className="enter"
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <div style={{ borderBottom: '1px solid var(--border)', padding: '18px 28px 0' }}>
        <div
          style={{
            maxWidth: 820,
            margin: '0 auto',
            width: '100%',
            display: 'flex',
            gap: 2,
            overflowX: 'auto',
          }}
        >
          {TABS.map((tb) => (
            <button
              key={tb.id}
              type="button"
              onClick={() => setTab(tb.id)}
              style={tabBtn(tab === tb.id)}
            >
              {tb.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 28 }}>
        <div style={{ maxWidth: 820, margin: '0 auto', width: '100%' }}>
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
              <Row
                label="Auto-harvest"
                desc="Automatically claim and compound rewards when threshold is reached. If OFF, agent notifies you and you harvest manually."
              >
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
              <Divider />
              <SubLabel>Emergency Withdraw</SubLabel>
              <div style={{ marginBottom: 6 }}>
                <Radio
                  sel={!!agentSettings.emergencyFull}
                  onClick={() => setAgent('emergencyFull', true)}
                  title="Full position (100%)"
                />
                <div
                  className="skill-opt"
                  style={{ cursor: 'default' }}
                  onClick={() => setAgent('emergencyFull', false)}
                >
                  <span
                    className={`skill-radio ${!agentSettings.emergencyFull ? '' : ''}`}
                    style={{
                      borderColor: !agentSettings.emergencyFull ? 'var(--accent)' : undefined,
                    }}
                  >
                    {!agentSettings.emergencyFull && (
                      <span
                        style={{
                          position: 'absolute',
                          inset: 3,
                          borderRadius: '50%',
                          background: 'var(--accent)',
                        }}
                      />
                    )}
                  </span>
                  <span
                    className="skill-opt-main"
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
                  >
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
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
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
                    ? 'Custom strategy · user-defined'
                    : 'Default Strategy by Vibing Farmer'
                }
              >
                <button type="button" style={miniBtn} onClick={onChangeSkill}>
                  Change skill →
                </button>
              </Row>
              <Divider />
              <SubLabel>AI Model · Strategy model</SubLabel>
              <Radio
                sel={s.modelPreference === 'auto'}
                onClick={() => set('modelPreference', 'auto')}
                title="Auto (recommended)"
                desc="Your Venice key → your DeepSeek key → host demo key → fallback"
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
              <div
                style={{
                  fontSize: 11,
                  color: `var(--${activeProvider.tone})`,
                  margin: '2px 0 8px',
                  lineHeight: 1.5,
                }}
              >
                Active: {activeProvider.label}
                {userAddress ? ' · a funded x402 wallet overrides this.' : ''}
              </div>
              <Row
                label="Venice API Key"
                desc="Routes strategy to api.venice.ai (Bearer auth). Alternative to the x402 wallet path — not required for it. Stored in this tab's sessionStorage, never sent to our servers."
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
              <Row
                label="x402 wallet balance"
                desc="Prepaid USDC on Base mainnet for wallet-paid inference. Top-up runs from a funded wallet/agent, not this UI — see the Venice x402 docs."
              >
                <button
                  type="button"
                  style={miniBtn}
                  disabled={!userAddress || x402.state === 'checking'}
                  onClick={checkX402}
                >
                  {x402.state === 'checking' ? 'Checking…' : 'Check balance'}
                </button>
              </Row>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                  marginTop: 2,
                }}
              >
                {!userAddress && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Connect a wallet to check x402 balance.
                  </span>
                )}
                {x402.state === 'done' &&
                  x402.bal &&
                  (x402.bal.canConsume ? (
                    <span style={{ fontSize: 11, color: 'var(--ok)' }}>
                      ✓ ${x402.bal.balanceUsd.toFixed(2)} spendable · ready for x402
                    </span>
                  ) : (
                    <span style={{ fontSize: 11, color: 'var(--warn)' }}>
                      ⚠ ${x402.bal.balanceUsd.toFixed(2)} · not enough to consume — top up
                      {x402.bal.suggestedTopUpUsd ? ` ~$${x402.bal.suggestedTopUpUsd}` : ''}
                    </span>
                  ))}
                {x402.state === 'error' && (
                  <span style={{ fontSize: 11, color: 'var(--warn)' }}>
                    ⚠ couldn’t read balance (unfunded wallet or CORS)
                  </span>
                )}
                <a
                  href={X402_DOCS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ ...miniBtn, textDecoration: 'none' }}
                >
                  How to top up ↗
                </a>
              </div>
              <Divider />
              <SubLabel>Vault Data Source</SubLabel>
              <Radio
                sel={s.vaultDataSource === 'live'}
                onClick={() => set('vaultDataSource', 'live')}
                title="Live (DeFiLlama · updated every 10 min)"
                desc="Venice AI receives real APY and TVL from Ethereum mainnet protocols."
              />
              <Radio
                sel={s.vaultDataSource === 'static'}
                onClick={() => set('vaultDataSource', 'static')}
                title="Static (hardcoded catalog · no network)"
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
              <SubLabel>Alert Severity Filter · Show alerts for</SubLabel>
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
              <SubLabel>Display · Timestamp format</SubLabel>
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
              {userAddress ? (
                <>
                  <Row
                    label="Connected Wallet"
                    desc={
                      walletPhase === 'upgraded' ? 'eip-7702 active · smart account' : 'regular eoa'
                    }
                  >
                    <span className="mono" style={{ fontSize: 12 }}>
                      {short(userAddress)}
                    </span>
                    <button type="button" style={miniBtn} onClick={copyAddr}>
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                    <button type="button" style={miniBtn} onClick={onDisconnect}>
                      Disconnect
                    </button>
                  </Row>
                  <Divider />
                  <Row
                    label={
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: 'var(--ok)',
                          }}
                        />
                        Base Sepolia testnet
                      </span>
                    }
                    desc={`Chain ID: ${SEPOLIA_CHAIN_ID}`}
                  >
                    <button type="button" style={miniBtn} onClick={onSwitchNetwork}>
                      Switch network
                    </button>
                  </Row>
                  <Divider />
                  <Row
                    label="Active Permissions"
                    desc={
                      permActive
                        ? `${permissionCount} permission · ${fmtRemaining(permExpiresAt) || '-'} remaining · erc-7715 · batch`
                        : 'no active permission'
                    }
                  >
                    {permActive && (
                      <button type="button" style={dangerBtn} onClick={onRevoke}>
                        Revoke all
                      </button>
                    )}
                  </Row>
                  <Divider />
                  <Row label="Relayer" desc="1Shot permissionless relay · gas cost to user: 0 USDC">
                    <span />
                  </Row>
                </>
              ) : (
                <Row label="Wallet" desc="Not connected.">
                  <button type="button" style={miniBtn} onClick={onConnect}>
                    Connect Wallet
                  </button>
                </Row>
              )}
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
                ['Agent settings', agentSet ? '1 entry' : 'not set'],
                ['User skill', skillSet ? 'set' : 'not set'],
              ].map(([k, v]) => (
                <div
                  key={k}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 12,
                    padding: '4px 0',
                    color: 'var(--text-muted)',
                  }}
                >
                  <span>{k}</span>
                  <span className="mono">{v}</span>
                </div>
              ))}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 12,
                  padding: '6px 0',
                  borderTop: '1px solid var(--border)',
                  marginTop: 4,
                }}
              >
                <span>Total</span>
                <span className="mono">~{total} entries</span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button type="button" style={miniBtn} onClick={exportData}>
                  Export all data
                </button>
                {confirmClear ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 }}>
                    This clears all history and resets settings. Continue?
                    <button type="button" style={miniBtn} onClick={() => setConfirmClear(false)}>
                      Cancel
                    </button>
                    <button type="button" style={dangerBtn} onClick={clearAll}>
                      Yes, clear all
                    </button>
                  </span>
                ) : (
                  <button type="button" style={dangerBtn} onClick={() => setConfirmClear(true)}>
                    Clear all data
                  </button>
                )}
              </div>
              <Divider />
              <SubLabel>Clear Individual Stores</SubLabel>
              <Row label="Transaction history">
                <button
                  type="button"
                  style={miniBtn}
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
                  style={miniBtn}
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
                  style={miniBtn}
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
                  style={miniBtn}
                  onClick={() => {
                    onResetSkill?.()
                    refresh()
                  }}
                >
                  Reset to default
                </button>
              </Row>
              <Row label="Agent settings">
                <button type="button" style={miniBtn} onClick={() => onResetAgentSettings?.()}>
                  Reset to defaults
                </button>
              </Row>
              <Divider />
              <SubLabel>Privacy Notes</SubLabel>
              {[
                'API keys (Venice / DeepSeek / Tavily) · stored in this tab’s sessionStorage, cleared on close, never sent to our servers.',
                'Venice AI · no data retention. Queries not stored.',
                'DeepSeek · with your key, prompts go straight to api.deepseek.com.',
                'Host demo key · used only if you set no key AND the deploy configured one; otherwise the app uses a deterministic fallback.',
                'Tavily · search queries sent to Tavily API.',
                'DeFiLlama · public API, no wallet data sent.',
                '1Shot relay · transaction data visible on-chain.',
                'All other data stored locally in your browser only.',
              ].map((n) => (
                <div
                  key={n}
                  style={{
                    fontSize: 11.5,
                    color: 'var(--text-muted)',
                    padding: '3px 0',
                    display: 'flex',
                    gap: 8,
                  }}
                >
                  <span style={{ color: 'var(--text-faint)' }}>●</span>
                  {n}
                </div>
              ))}
            </Section>
          )}

          {/* ── SECTION 6: About ── */}
          {tab === 'about' && (
            <Section title="About">
              <div className="brand" style={{ fontSize: 18 }}>
                <span>vibing</span>
                <span className="slash">/</span>
                <span className="vibing">farmer</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                Autonomous DeFi yield farming agent
              </div>
              <div style={{ marginTop: 12 }}>
                {[
                  ['Version', '1.0.0-beta'],
                  ['Network', 'Base Sepolia'],
                  ['Contracts', 'verified on Sourcify'],
                ].map(([k, v]) => (
                  <div
                    key={k}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 12,
                      padding: '3px 0',
                    }}
                  >
                    <span style={{ color: 'var(--text-muted)' }}>{k}</span>
                    <span className="mono">{v}</span>
                  </div>
                ))}
              </div>
              <Divider />
              <ContractRow name="AgentVaultDepositor" addr={AGENT_VAULT_DEPOSITOR_ADDRESS} />
              <ContractRow name="MockVault A" addr={MOCK_VAULT_A_ADDRESS} />
              <ContractRow name="MockVault B" addr={MOCK_VAULT_B_ADDRESS} />
              <ContractRow name="MockVault C" addr={MOCK_VAULT_C_ADDRESS} />
              <ContractRow name="MockVault D" addr={MOCK_VAULT_D_ADDRESS} />
              <Divider />
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                Powered by: MetaMask Smart Accounts Kit × 1Shot API × Venice AI
              </div>
              <div style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.8 }}>
                {[
                  '1Shot Gasless Gas Abstraction',
                  'Venice AI Strategy Generator',
                  'Multi-Agent Smart Swarm',
                  'Parallel Swarm Coordination',
                  'ERC-7715 Scoped Cryptographic Boundaries',
                ].map((p) => (
                  <div key={p}>
                    <span style={{ color: 'var(--ok)' }}>✓</span> {p}
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                {ghUrl !== '#' && (
                  <a
                    href={ghUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ ...miniBtn, textDecoration: 'none' }}
                  >
                    View on GitHub
                  </a>
                )}
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}
