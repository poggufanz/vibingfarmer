// frontend/src/money/legacyAutoExit.test.js
// Pocket Crew "My money" Task 10: legacyAutoExit.js is READ-ONLY inspection + explicit local
// deletion over the four localStorage families the (now-deleted) autonomous auto-exit path used
// to write. It must never redeem, transfer, relay, or sign anything, and it must never silently
// treat an unreadable legacy key as "nothing to clean up".
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  scanLegacyAutoExit,
  isLegacyAutoExitKey,
  deleteLegacyAutoExitKeys,
} from './legacyAutoExit.js'

const MODULE_PATH = fileURLToPath(new URL('./legacyAutoExit.js', import.meta.url))
const APP_PATH = fileURLToPath(new URL('../app.jsx', import.meta.url))

function stubStorage() {
  const store = {}
  const api = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v)
    },
    removeItem: (k) => {
      delete store[k]
    },
    key: (i) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length
    },
  }
  globalThis.localStorage = api
  return store
}

describe('legacyAutoExit — production-safety invariants', () => {
  it('has zero imports — a pure localStorage inspector, nothing capable of signing or relaying', () => {
    const src = readFileSync(MODULE_PATH, 'utf8')
    expect(src).not.toMatch(/^\s*import /m)
  })

  it('exposes exactly the three safe exports — no redeem/transfer/relay/sign capability', async () => {
    const mod = await import('./legacyAutoExit.js')
    expect(Object.keys(mod).sort()).toEqual(
      ['deleteLegacyAutoExitKeys', 'isLegacyAutoExitKey', 'scanLegacyAutoExit'].sort()
    )
  })

  it('app.jsx no longer imports or calls the deleted autonomous-exit execution path', () => {
    const src = readFileSync(APP_PATH, 'utf8')
    expect(src).not.toMatch(/runAutonomousExit/)
    expect(src).not.toMatch(/from ['"]\.\/strategy\/autoExit\/engine\.js['"]/)
    expect(src).not.toMatch(/from ['"]\.\/agents\/exitExecutor\.js['"]/)
    expect(src).not.toMatch(/\bcheckExit\b/)
  })
})

describe('scanLegacyAutoExit', () => {
  beforeEach(() => {
    stubStorage()
  })

  it('reports nothing when no legacy keys exist, ignoring unrelated storage', () => {
    localStorage.setItem('yv_agent_settings', '{"autoHarvest":false}')
    localStorage.setItem('vf.manualExitKey.v2|stellar-testnet|GOWNER|CAGENT', '{"owner":"GOWNER"}')
    const { rows, count } = scanLegacyAutoExit()
    expect(rows).toEqual([])
    expect(count).toBe(0)
  })

  it('detects yv_exit_rules_<owner> and reports authorized + enabled triggers', () => {
    localStorage.setItem(
      'yv_exit_rules_GOWNER1',
      JSON.stringify({
        authorized: true,
        expiryAt: 5000,
        utilization: { enabled: true, threshold: 0.95 },
        apyCollapse: { enabled: false },
        protocolRisk: { enabled: true },
        drawdown: { enabled: false },
      })
    )
    const { rows } = scanLegacyAutoExit({ now: 6000 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      key: 'yv_exit_rules_GOWNER1',
      kind: 'exitRules',
      owner: 'GOWNER1',
      readable: true,
      authorized: true,
      expiryAt: 5000,
      expired: true,
      enabledTriggers: ['utilization', 'protocolRisk'],
    })
  })

  it('marks unparseable exit rules as unreadable — never silently "nothing to clean up"', () => {
    localStorage.setItem('yv_exit_rules_GBAD', 'not json')
    const { rows, count } = scanLegacyAutoExit()
    expect(count).toBe(1)
    expect(rows[0]).toMatchObject({ kind: 'exitRules', owner: 'GBAD', readable: false })
  })

  it('detects yv_last_exit_trip_<owner> as a numeric timestamp', () => {
    localStorage.setItem('yv_last_exit_trip_GOWNER1', String(1234))
    const { rows } = scanLegacyAutoExit()
    expect(rows[0]).toMatchObject({
      kind: 'lastExitTrip',
      owner: 'GOWNER1',
      readable: true,
      lastTrippedAt: 1234,
    })
  })

  it('marks a non-numeric last-trip value as unreadable', () => {
    localStorage.setItem('yv_last_exit_trip_GOWNER1', 'garbage')
    const { rows } = scanLegacyAutoExit()
    expect(rows[0]).toMatchObject({ kind: 'lastExitTrip', readable: false })
  })

  it('detects yv_exit_key_<agent>, exposes the public key only — never the secret', () => {
    localStorage.setItem(
      'yv_exit_key_cagent1',
      JSON.stringify({ publicKey: 'GEXITPUB', secret: 'SVERYSECRET' })
    )
    const { rows } = scanLegacyAutoExit()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'exitKey',
      agent: 'cagent1',
      readable: true,
      publicKey: 'GEXITPUB',
    })
    expect(rows[0]).not.toHaveProperty('secret')
    expect(JSON.stringify(rows[0])).not.toMatch(/SVERYSECRET/)
  })

  it('labels an exit key as superseded when a v2 manual exit key exists for the same agent', () => {
    localStorage.setItem('yv_exit_key_cagent1', JSON.stringify({ publicKey: 'GPUB', secret: 'S' }))
    localStorage.setItem(
      'vf.manualExitKey.v2|stellar-testnet|GOWNER|CAGENT1',
      JSON.stringify({ owner: 'GOWNER', agent: 'CAGENT1', publicKey: 'GNEW', secret: 'SNEW' })
    )
    const { rows } = scanLegacyAutoExit()
    const row = rows.find((r) => r.kind === 'exitKey')
    expect(row.supersededByManualKey).toBe(true)
    expect(row.onChainStatus).toBe('superseded')
  })

  it('never claims a legacy exit key is superseded when no v2 manual key is on record — honest unknown', () => {
    localStorage.setItem('yv_exit_key_cagent1', JSON.stringify({ publicKey: 'GPUB', secret: 'S' }))
    const { rows } = scanLegacyAutoExit()
    const row = rows.find((r) => r.kind === 'exitKey')
    expect(row.supersededByManualKey).toBe(false)
    expect(row.onChainStatus).toBe('unknown')
  })

  it('marks a corrupt exit key as unreadable', () => {
    localStorage.setItem('yv_exit_key_cagent1', 'not json')
    const { rows } = scanLegacyAutoExit()
    expect(rows[0]).toMatchObject({ kind: 'exitKey', readable: false })
  })

  it('detects vf_exit_inflight_<agent> and flags an expired vs live lock by TTL', () => {
    localStorage.setItem('vf_exit_inflight_CAGENT1', `${1000}:abc`)
    const live = scanLegacyAutoExit({ now: 1000 + 60_000 }) // 60s < 120s TTL
    expect(live.rows[0]).toMatchObject({ kind: 'exitInflight', agent: 'CAGENT1', expired: false })

    const expired = scanLegacyAutoExit({ now: 1000 + 200_000 }) // 200s > 120s TTL
    expect(expired.rows[0]).toMatchObject({ kind: 'exitInflight', expired: true })
  })

  it('marks a corrupt in-flight lock value as unreadable', () => {
    localStorage.setItem('vf_exit_inflight_CAGENT1', 'garbage:abc')
    const { rows } = scanLegacyAutoExit()
    expect(rows[0]).toMatchObject({ kind: 'exitInflight', readable: false })
  })

  it('never enumerates vf.manualExitKey.v2 rows as legacy data', () => {
    localStorage.setItem(
      'vf.manualExitKey.v2|stellar-testnet|GOWNER|CAGENT1',
      JSON.stringify({ owner: 'GOWNER', agent: 'CAGENT1' })
    )
    const { rows } = scanLegacyAutoExit()
    expect(rows).toEqual([])
  })
})

describe('scanLegacyAutoExit — storage failure must never read as "found nothing"', () => {
  afterEach(() => {
    delete globalThis.localStorage
  })

  it('reports failed:true and an empty row list when localStorage itself throws on access', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: storage disabled')
      },
    })
    const { rows, count, failed } = scanLegacyAutoExit()
    expect(rows).toEqual([])
    expect(count).toBe(0)
    expect(failed).toBe(true)
  })

  it('reports failed:false when the scan genuinely ran and found nothing', () => {
    stubStorage()
    const { rows, failed } = scanLegacyAutoExit()
    expect(rows).toEqual([])
    expect(failed).toBe(false)
  })
})

describe('isLegacyAutoExitKey', () => {
  it('is true only for the four legacy prefixes', () => {
    expect(isLegacyAutoExitKey('yv_exit_rules_GOWNER')).toBe(true)
    expect(isLegacyAutoExitKey('yv_last_exit_trip_GOWNER')).toBe(true)
    expect(isLegacyAutoExitKey('yv_exit_key_cagent')).toBe(true)
    expect(isLegacyAutoExitKey('vf_exit_inflight_CAGENT')).toBe(true)
  })

  it('is false for the v2 manual exit key namespace and anything else', () => {
    expect(isLegacyAutoExitKey('vf.manualExitKey.v2|stellar-testnet|GOWNER|CAGENT')).toBe(false)
    expect(isLegacyAutoExitKey('yv_agent_settings')).toBe(false)
    expect(isLegacyAutoExitKey(null)).toBe(false)
    expect(isLegacyAutoExitKey(undefined)).toBe(false)
    expect(isLegacyAutoExitKey(42)).toBe(false)
  })
})

describe('deleteLegacyAutoExitKeys', () => {
  beforeEach(() => {
    stubStorage()
  })

  it('deletes only legit legacy keys, never a manual v2 key or an unrelated key, even if passed', () => {
    localStorage.setItem('yv_exit_rules_GOWNER', '{"authorized":true}')
    localStorage.setItem('yv_exit_key_cagent1', '{"publicKey":"G"}')
    localStorage.setItem('vf.manualExitKey.v2|stellar-testnet|GOWNER|CAGENT1', '{"owner":"GOWNER"}')
    localStorage.setItem('yv_agent_settings', '{}')

    const { deleted, skipped } = deleteLegacyAutoExitKeys([
      'yv_exit_rules_GOWNER',
      'yv_exit_key_cagent1',
      'vf.manualExitKey.v2|stellar-testnet|GOWNER|CAGENT1',
      'yv_agent_settings',
    ])

    expect(deleted.sort()).toEqual(['yv_exit_key_cagent1', 'yv_exit_rules_GOWNER'].sort())
    expect(skipped.sort()).toEqual(
      ['vf.manualExitKey.v2|stellar-testnet|GOWNER|CAGENT1', 'yv_agent_settings'].sort()
    )
    expect(localStorage.getItem('yv_exit_rules_GOWNER')).toBeNull()
    expect(localStorage.getItem('yv_exit_key_cagent1')).toBeNull()
    expect(localStorage.getItem('vf.manualExitKey.v2|stellar-testnet|GOWNER|CAGENT1')).not.toBeNull()
    expect(localStorage.getItem('yv_agent_settings')).not.toBeNull()
  })

  it('returns empty results for no input, and never throws', () => {
    expect(deleteLegacyAutoExitKeys()).toEqual({ deleted: [], skipped: [] })
    expect(deleteLegacyAutoExitKeys([])).toEqual({ deleted: [], skipped: [] })
  })

  it('skips (never crashes on) a key whose removeItem throws', () => {
    localStorage.setItem('yv_exit_rules_GOWNER', '{"authorized":true}')
    const originalRemoveItem = localStorage.removeItem
    localStorage.removeItem = (k) => {
      if (k === 'yv_exit_rules_GOWNER') throw new Error('QuotaExceededError')
      return originalRemoveItem(k)
    }
    const { deleted, skipped } = deleteLegacyAutoExitKeys(['yv_exit_rules_GOWNER'])
    expect(deleted).toEqual([])
    expect(skipped).toEqual(['yv_exit_rules_GOWNER'])
  })
})
