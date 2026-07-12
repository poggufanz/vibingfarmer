// frontend/src/components/AutoExitSettings.jsx
// UI configuration panel for F11 Auto-Exit rules and scoped exit signer key authorization.

import React, { useState, useEffect } from 'react'
import { DEFAULT_EXIT_RULES, validateRules } from '../strategy/autoExit/rules.js'
import {
  generateExitKey,
  saveExitKey,
  loadExitKey,
  clearExitKey,
  registerExitSigner,
} from '../wallet/exitKey.js'
import { SOROBAN_DEMO_AGENT } from '../stellar/config.js'

const card = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: '16px 18px',
}

const eyebrow = {
  fontSize: 11,
  letterSpacing: '0.01em',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  fontWeight: 500,
  marginBottom: 10,
}

const inputStyle = {
  background: 'var(--bg-input)',
  border: '1px solid var(--border-strong)',
  borderRadius: 6,
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  padding: '6px 9px',
  width: '80px',
  textAlign: 'right',
}

const btnStyle = {
  appearance: 'none',
  border: '.5px solid var(--border-strong)',
  borderRadius: 5,
  background: 'rgba(255,255,255,.06)',
  color: 'inherit',
  font: 'inherit',
  fontSize: 11,
  padding: '5px 12px',
  cursor: 'pointer',
  fontWeight: 500,
}

const primaryBtnStyle = {
  ...btnStyle,
  background: 'var(--accent)',
  borderColor: 'var(--accent)',
  color: '#fff',
}

const toggleStyle = (active) => ({
  appearance: 'none',
  border: '1px solid var(--border-strong)',
  borderRadius: 12,
  width: 40,
  height: 20,
  backgroundColor: active ? 'var(--accent)' : 'rgba(255,255,255,.06)',
  position: 'relative',
  cursor: 'pointer',
  outline: 'none',
  transition: 'background-color 160ms ease',
})

const toggleThumb = (active) => ({
  position: 'absolute',
  top: 2,
  left: 2,
  width: 14,
  height: 14,
  borderRadius: '50%',
  background: '#fff',
  transform: `translateX(${active ? 20 : 0}px)`,
  transition: 'transform 160ms var(--ease-out)',
})

const rowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '10px 0',
  borderBottom: '1px solid rgba(255,255,255,.03)',
}

export default function AutoExitSettings({ realAddress, addLog }) {
  const [rules, setRules] = useState(() => {
    const stored = localStorage.getItem(`yv_exit_rules_${realAddress}`)
    return stored ? JSON.parse(stored) : { ...DEFAULT_EXIT_RULES }
  })

  const [exitKey, setExitKey] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    if (realAddress) {
      setExitKey(loadExitKey(SOROBAN_DEMO_AGENT))
    }
  }, [realAddress])

  const saveRules = (newRules) => {
    const validated = validateRules(newRules)
    setRules(validated)
    localStorage.setItem(`yv_exit_rules_${realAddress}`, JSON.stringify(validated))
    if (addLog) {
      addLog({ event: 'OrchestratorPlanned', meta: 'Auto-exit rules updated' })
    }
  }

  const updateRuleField = (trigger, field, val) => {
    const updated = {
      ...rules,
      [trigger]: {
        ...rules[trigger],
        [field]: val,
      },
    }
    saveRules(updated)
  }

  const handleAuthorizeKey = async () => {
    setLoading(true)
    setError('')
    setSuccess('')
    try {
      if (addLog) addLog({ event: 'OrchestratorPlanned', meta: 'Generating ephemeral exit key...' })
      const keypair = await generateExitKey()

      if (addLog)
        addLog({
          event: 'OrchestratorPlanned',
          meta: 'Registering exit signer on-chain (wallet sign required)...',
        })
      await registerExitSigner({
        owner: realAddress,
        agentAddress: SOROBAN_DEMO_AGENT,
        exitPublicKey: keypair.publicKey,
      })

      // Save key pair locally
      saveExitKey(SOROBAN_DEMO_AGENT, keypair)
      setExitKey(keypair)

      const expiryAt = Date.now() + rules.expiryDays * 24 * 60 * 60 * 1000
      const updatedRules = {
        ...rules,
        authorized: true,
        authorizedAt: Date.now(),
        expiryAt,
      }
      saveRules(updatedRules)

      setSuccess('Scoped Exit Signer registered and saved successfully!')
      if (addLog)
        addLog({
          event: 'OrchestratorPlanned',
          meta: `Exit key ${keypair.publicKey.slice(0, 8)}... authorized on-chain`,
        })
    } catch (err) {
      console.error(err)
      setError(err.message || 'Authorization failed. Check wallet connection.')
      if (addLog)
        addLog({
          event: 'AgentFailed',
          meta: 'Failed to authorize scoped exit key',
          detail: err.message,
        })
    } finally {
      setLoading(false)
    }
  }

  const handleRevokeKey = () => {
    clearExitKey(SOROBAN_DEMO_AGENT)
    setExitKey(null)
    const updatedRules = {
      ...rules,
      authorized: false,
      authorizedAt: null,
      expiryAt: null,
    }
    saveRules(updatedRules)
    setSuccess(
      'Exit key removed from local cache. (Note: revoke on-chain via Registry to fully clear registry authorizations).'
    )
    if (addLog) addLog({ event: 'OrchestratorPlanned', meta: 'Exit key removed locally' })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* 1. KEY AUTHORIZATION SECTION */}
      <div style={card}>
        <div style={eyebrow}>Scoped exit signer (on-chain keeper)</div>
        <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '4px 0 16px' }}>
          Grant a strictly-scoped exit key permission to withdraw your funds to safety autonomously
          when triggers trip. The key has no permission to transfer to other addresses, approve
          spenders, or add signers.
        </p>

        {exitKey ? (
          <div
            style={{
              background: 'rgba(0,255,0,0.03)',
              border: '1px solid rgba(0,255,0,0.1)',
              borderRadius: 6,
              padding: 12,
              marginBottom: 12,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ color: '#00e676', fontWeight: 600, fontSize: 13 }}>
                  Scoped exit signer active
                </span>
                <div
                  style={{
                    fontSize: 11,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-muted)',
                    marginTop: 4,
                  }}
                >
                  G-Addr: {exitKey.publicKey.slice(0, 10)}...{exitKey.publicKey.slice(-8)}
                </div>
                {rules.expiryAt && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    Expires: {new Date(rules.expiryAt).toLocaleDateString()}
                  </div>
                )}
              </div>
              <button
                onClick={handleRevokeKey}
                style={{ ...btnStyle, borderColor: 'var(--danger)', color: 'var(--danger)' }}
              >
                Revoke locally
              </button>
            </div>
          </div>
        ) : (
          <div
            style={{
              background: 'rgba(255,255,255,0.02)',
              border: '1px dotted var(--border)',
              borderRadius: 6,
              padding: 12,
              marginBottom: 12,
              textAlign: 'center',
            }}
          >
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              No active scoped exit signer
            </span>
            <div style={{ marginTop: 12 }}>
              <button
                onClick={handleAuthorizeKey}
                disabled={loading || !realAddress}
                style={
                  realAddress
                    ? primaryBtnStyle
                    : { ...primaryBtnStyle, opacity: 0.5, cursor: 'not-allowed' }
                }
              >
                {loading ? 'Authorizing…' : 'Authorize scoped exit key'}
              </button>
            </div>
          </div>
        )}

        {error && (
          <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>Error: {error}</div>
        )}
        {success && <div style={{ color: '#00e676', fontSize: 12, marginTop: 8 }}>{success}</div>}

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 15 }}>
          <div style={{ display: 'flex', gap: 10, fontSize: 11.5, color: 'rgba(255,215,0,0.85)' }}>
            <span>
              <strong>Exit target, not a guarantee:</strong> If the Blend lending pool is 100%
              utilized (frozen), withdrawals will fail. The triggers are configured to exit before
              the pool locks, but cannot promise success during severe market gaps.
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              gap: 10,
              fontSize: 11.5,
              color: 'rgba(0,230,118,0.85)',
              marginTop: 8,
            }}
          >
            <span>
              <strong>Restricted by contract:</strong> The on-chain smart account guarantees that
              funds withdrawn with this session key can only return to your owner wallet. A stolen
              session key cannot redirect them.
            </span>
          </div>
        </div>
      </div>

      {/* 2. RULE TRIGGERS CONFIGURATION */}
      <div style={card}>
        <div style={eyebrow}>Exit trigger rules</div>

        {/* T1 - Utilization */}
        <div style={rowStyle}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>T1: Pool utilization limit</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
              Exit when vault's underlying Blend pool utilization exceeds this threshold (exits
              before locking).
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="number"
              value={Math.round(rules.utilization.threshold * 100)}
              onChange={(e) =>
                updateRuleField('utilization', 'threshold', Number(e.target.value) / 100)
              }
              style={inputStyle}
              min="1"
              max="100"
              disabled={!rules.utilization.enabled}
            />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>%</span>
            <button
              className="auto-exit-toggle"
              type="button"
              aria-label="Toggle utilization exit rule"
              aria-pressed={rules.utilization.enabled}
              onClick={() => updateRuleField('utilization', 'enabled', !rules.utilization.enabled)}
              style={toggleStyle(rules.utilization.enabled)}
            >
              <div
                className="auto-exit-toggle-thumb"
                style={toggleThumb(rules.utilization.enabled)}
              />
            </button>
          </div>
        </div>

        {/* T2 - APY Collapse */}
        <div style={rowStyle}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>T2: APY collapse threshold</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
              Exit autonomously if the supply yield APY falls below this rate.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="number"
              step="0.1"
              value={(rules.apyCollapse.threshold * 100).toFixed(1)}
              onChange={(e) =>
                updateRuleField('apyCollapse', 'threshold', Number(e.target.value) / 100)
              }
              style={inputStyle}
              min="0"
              max="100"
              disabled={!rules.apyCollapse.enabled}
            />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>%</span>
            <button
              className="auto-exit-toggle"
              type="button"
              aria-label="Toggle APY collapse exit rule"
              aria-pressed={rules.apyCollapse.enabled}
              onClick={() => updateRuleField('apyCollapse', 'enabled', !rules.apyCollapse.enabled)}
              style={toggleStyle(rules.apyCollapse.enabled)}
            >
              <div
                className="auto-exit-toggle-thumb"
                style={toggleThumb(rules.apyCollapse.enabled)}
              />
            </button>
          </div>
        </div>

        {/* T3 - Protocol Risk */}
        <div style={rowStyle}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>T3: TVL drop and exploit alert</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
              Exit if the protocol's TVL drops by this ratio in 24 hours, or if the market context
              flags an exploit or hack.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="number"
              value={Math.round(rules.protocolRisk.tvlDropThreshold * 100)}
              onChange={(e) =>
                updateRuleField('protocolRisk', 'tvlDropThreshold', Number(e.target.value) / 100)
              }
              style={inputStyle}
              min="1"
              max="100"
              disabled={!rules.protocolRisk.enabled}
            />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>%</span>
            <button
              className="auto-exit-toggle"
              type="button"
              aria-label="Toggle protocol risk exit rule"
              aria-pressed={rules.protocolRisk.enabled}
              onClick={() =>
                updateRuleField('protocolRisk', 'enabled', !rules.protocolRisk.enabled)
              }
              style={toggleStyle(rules.protocolRisk.enabled)}
            >
              <div
                className="auto-exit-toggle-thumb"
                style={toggleThumb(rules.protocolRisk.enabled)}
              />
            </button>
          </div>
        </div>

        {/* T4 - Drawdown (Dormant) */}
        <div style={{ ...rowStyle, borderBottom: 0 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>T4: Drawdown limit</span>
              <span
                style={{
                  fontSize: 9,
                  background: 'rgba(255,255,255,0.08)',
                  padding: '2px 4px',
                  borderRadius: 4,
                  color: 'var(--text-muted)',
                }}
              >
                Dormant
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
              Exit if position value drops by this much (only active on future volatile LP/yield
              vaults).
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="number"
              value={Math.round(rules.drawdown.threshold * 100)}
              onChange={(e) =>
                updateRuleField('drawdown', 'threshold', Number(e.target.value) / 100)
              }
              style={inputStyle}
              min="1"
              max="100"
              disabled={true}
            />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>%</span>
            <button
              className="auto-exit-toggle"
              type="button"
              aria-label="Slippage anomaly exit rule unavailable"
              aria-pressed={false}
              disabled={true}
              style={{ ...toggleStyle(false), opacity: 0.3, cursor: 'not-allowed' }}
            >
              <div className="auto-exit-toggle-thumb" style={toggleThumb(false)} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
