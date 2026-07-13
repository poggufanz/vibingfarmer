import { describe, it, expect, vi } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import { rehydrateScopes } from './scopeRehydrate.js'

const OWNER = Keypair.random().publicKey()
const VAULT = 'CB5VKYDUIYX3RZWGVLKKNBPG7V7Z5JIHF2QPNQKWKAHVA3IPSLFZJDYU'
const TOKEN = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'
const AGENT_A = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const AGENT_B = 'CDDOW2FZ7ALBWBXF22TPMPDHPXSKTMLQGGQWUYX7YOJZAHICD7DUO2K6'
const NOW = 1_800_000_000

// scope_of() return shape: snake_case, BigInt-as-string for i128, Number for u64.
function scope({ expiry = NOW + 3600, revoked = false } = {}) {
  return {
    owner: OWNER,
    vault: VAULT,
    token: TOKEN,
    cap_per_period: '1000000',
    period_duration: 3600,
    period_start: 0,
    spent_in_period: '0',
    expiry,
    revoked,
  }
}

const HEALTHY = { getHealth: async () => ({ oldestLedger: 1, ledgerRetentionWindow: 120960 }) }

function seams({ events = [], cache = [], scopes = {} } = {}) {
  return {
    server: HEALTHY,
    fetchEvents: async () => events.map((agent) => ({ agent, owner: OWNER, cap: 1n })),
    loadCache: () => cache.map((agentAddress) => ({ agentAddress })),
    readScope: async (agent) => (agent in scopes ? scopes[agent] : null),
  }
}

describe('rehydrateScopes', () => {
  it('builds a row matching the live AgentScopeAuthorized shape', async () => {
    const rows = await rehydrateScopes({
      owner: OWNER,
      nowSec: NOW,
      ...seams({ events: [AGENT_A], scopes: { [AGENT_A]: scope() } }),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      agent: AGENT_A,
      vault: VAULT,
      token: TOKEN,
      capPerPeriod: 1000000n, // bigint — same type the on-chain arg uses
      periodDuration: 3600,
      expiry: NOW + 3600,
      agentId: null,
      revoked: false,
      authorized: true,
    })
    expect(typeof rows[0].maxAtRisk).toBe('bigint')
  })

  it('dedupes the union of events and cache by agent address', async () => {
    const rows = await rehydrateScopes({
      owner: OWNER,
      nowSec: NOW,
      // AGENT_A in both sources, AGENT_B only in cache → 2 rows, not 3
      ...seams({
        events: [AGENT_A],
        cache: [AGENT_A, AGENT_B],
        scopes: { [AGENT_A]: scope(), [AGENT_B]: scope() },
      }),
    })
    expect(rows.map((r) => r.agent).sort()).toEqual([AGENT_A, AGENT_B].sort())
  })

  it('skips an agent whose scope read fails (null) - never fabricates a row', async () => {
    const rows = await rehydrateScopes({
      owner: OWNER,
      nowSec: NOW,
      ...seams({ events: [AGENT_A, AGENT_B], scopes: { [AGENT_A]: scope() } }), // B → null
    })
    expect(rows.map((r) => r.agent)).toEqual([AGENT_A])
  })

  it('hides expired grants (includeExpired=false) but keeps revoked (includeRevoked=true)', async () => {
    const rows = await rehydrateScopes({
      owner: OWNER,
      nowSec: NOW,
      ...seams({
        events: [AGENT_A, AGENT_B],
        scopes: {
          [AGENT_A]: scope({ expiry: NOW - 10 }), // expired → hidden
          [AGENT_B]: scope({ revoked: true }), // revoked but live → shown
        },
      }),
    })
    expect(rows.map((r) => r.agent)).toEqual([AGENT_B])
    expect(rows[0].revoked).toBe(true)
  })

  it('can include expired and exclude revoked when flags flip', async () => {
    const rows = await rehydrateScopes({
      owner: OWNER,
      nowSec: NOW,
      includeExpired: true,
      includeRevoked: false,
      ...seams({
        events: [AGENT_A, AGENT_B],
        scopes: {
          [AGENT_A]: scope({ expiry: NOW - 10 }), // expired → now shown
          [AGENT_B]: scope({ revoked: true }), // revoked → now hidden
        },
      }),
    })
    expect(rows.map((r) => r.agent)).toEqual([AGENT_A])
  })

  it('returns [] with no owner and [] when both sources are empty', async () => {
    expect(await rehydrateScopes({ owner: null })).toEqual([])
    expect(await rehydrateScopes({ owner: OWNER, nowSec: NOW, ...seams() })).toEqual([])
  })

  it('warns (does not throw) when RPC retention is shorter than the 7d max grant', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = seams({ events: [AGENT_A], scopes: { [AGENT_A]: scope() } })
    // ~1 day retention (17280 ledgers × 5s) — well under the 7d preset ceiling.
    s.server = { getHealth: async () => ({ oldestLedger: 1, ledgerRetentionWindow: 17280 }) }
    const rows = await rehydrateScopes({ owner: OWNER, nowSec: NOW, ...s })
    expect(rows).toHaveLength(1) // still rehydrates
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toMatch(/retention/i)
    warn.mockRestore()
  })
})
