import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import handler, {
  dispenseToken,
  CAP_BASE_UNITS,
  effectiveAmount,
  reserveDaily,
  reserveSpendDurable,
  faucetDayRetryAfter,
  FAUCET_GLOBAL_SPEND_KEY,
  GLOBAL_DAILY_CAP,
  PER_RECIPIENT_DAILY_CAP,
} from './faucet.js'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
const FAUCET_MIGRATION = readFileSync(
  new URL('../migrations/0011_faucet_daily_spend.sql', import.meta.url),
  'utf8'
)
// Handler-level tests also pass the durable per-IP gate, which needs the 0010 table.
const CROSS_MIGRATION = readFileSync(
  new URL('../migrations/0010_vf_cross_rate_limits.sql', import.meta.url),
  'utf8'
)

const tok = (n) => BigInt(n) * 10n ** 7n

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(s) {
      this.body = s ?? ''
      return this
    },
  }
}
function mockReq(body, { origin = 'http://localhost:5173', method = 'POST' } = {}) {
  return { method, headers: { origin, 'x-real-ip': '1.2.3.4' }, body }
}

beforeEach(() => {
  delete process.env.VF_FAUCET_SECRET
  process.env.ALLOWED_ORIGIN = 'http://localhost:5173'
  process.env.SOROBAN_TOKEN_ADDRESS = 'CTOKEN'
})

describe('/api/faucet handler', () => {
  it('returns 503 configured:false when VF_FAUCET_SECRET is unset', async () => {
    const res = mockRes()
    await handler(mockReq({ action: 'dispense', to: 'CACCT' }), res)
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toMatchObject({ configured: false })
  })

  it('rejects a disallowed origin (403)', async () => {
    process.env.VF_FAUCET_SECRET = 'SSECRET'
    const res = mockRes()
    await handler(
      mockReq({ action: 'dispense', to: 'CACCT' }, { origin: 'https://evil.example' }),
      res
    )
    expect(res.statusCode).toBe(403)
  })

  it('405 on non-POST', async () => {
    const res = mockRes()
    await handler(mockReq({}, { method: 'GET' }), res)
    expect(res.statusCode).toBe(405)
  })

  it('400 on a recipient that is neither a valid C nor G StrKey', async () => {
    process.env.VF_FAUCET_SECRET = 'SSECRET'
    const res = mockRes()
    await handler(mockReq({ action: 'dispense', to: 'not-an-address' }), res)
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Invalid recipient' })
  })

  it('does not log an arbitrary provider/request error', async () => {
    process.env.VF_FAUCET_SECRET = 'SSECRET'
    const poison = 'T16_PROVIDER_SECRET_FAUCET_RPC_BODY'
    const body = {}
    Object.defineProperty(body, 'action', {
      get() {
        throw new Error(poison)
      },
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = mockRes()
    await handler(mockReq(body), res)
    expect(res.statusCode).toBe(502)
    expect(JSON.stringify(JSON.parse(res.body))).not.toContain(poison)
    expect(log.mock.calls.flat().join(' ')).not.toContain(poison)
    log.mockRestore()
  })
})

// Recipient validation now accepts BOTH a Soroban contract (C, passkey wallet) and a classic
// ed25519 account (G, seed-phrase wallet). Asserted at the StrKey layer the handler uses, so it
// stays a pure check with no live RPC dispense (the handler's happy path needs a real network).
describe('recipient StrKey validation (G + C)', () => {
  it('accepts a classic G-address and a contract C-address; rejects junk', async () => {
    const { StrKey } = await import('@stellar/stellar-sdk')
    const G = 'GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56'
    const C = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'
    const okG = StrKey.isValidEd25519PublicKey(G) || StrKey.isValidContract(G)
    const okC = StrKey.isValidEd25519PublicKey(C) || StrKey.isValidContract(C)
    const okJunk =
      StrKey.isValidEd25519PublicKey('not-an-address') || StrKey.isValidContract('not-an-address')
    expect(okG).toBe(true)
    expect(okC).toBe(true)
    expect(okJunk).toBe(false)
  })
})

describe('effectiveAmount (clamp)', () => {
  it('defaults to 10 tokens when unset, zero, or non-positive', () => {
    expect(effectiveAmount(undefined)).toBe(tok(10))
    expect(effectiveAmount(0)).toBe(tok(10))
    expect(effectiveAmount(-5)).toBe(tok(10))
  })
  it('caps at CAP_BASE_UNITS and passes valid amounts through', () => {
    expect(effectiveAmount(10n ** 18n)).toBe(CAP_BASE_UNITS)
    expect(effectiveAmount(tok(25))).toBe(tok(25))
  })
})

describe('reserveDaily (daily caps)', () => {
  // Each test uses a `now` >1 day from the others so the global window resets at its first call,
  // isolating the shared module-level accounting.
  const T = 1_000_000_000_000
  const DAY = 24 * 60 * 60 * 1000

  it('rejects once a recipient exceeds the per-recipient daily cap', () => {
    expect(reserveDaily('rA', tok(100), T)).toBe(true)
    expect(reserveDaily('rA', tok(250), T)).toBe(false) // 100+250 > 300 cap
  })

  it('resets a recipient window after 24h', () => {
    const t = T + 10 * DAY
    expect(reserveDaily('rB', PER_RECIPIENT_DAILY_CAP, t)).toBe(true)
    expect(reserveDaily('rB', tok(1), t)).toBe(false) // at cap, same window
    expect(reserveDaily('rB', tok(1), t + DAY + 1)).toBe(true) // new window
  })

  it('rejects once the global daily cap is reached across recipients', () => {
    const t = T + 100 * DAY
    // 16 recipients × 300 = 4800 ≤ 5000 global cap; the 17th (5100) trips the global ceiling.
    for (let i = 0; i < 16; i++) {
      expect(reserveDaily(`g${i}`, PER_RECIPIENT_DAILY_CAP, t)).toBe(true)
    }
    expect(reserveDaily('g16', PER_RECIPIENT_DAILY_CAP, t)).toBe(false)
  })
})

describe('dispenseToken (cap + transfer)', () => {
  const sdk = {
    Keypair: { fromSecret: () => ({ publicKey: () => 'GDEPLOYER', sign: vi.fn() }) },
    TransactionBuilder: vi.fn(function () {
      return {
        addOperation() {
          return this
        },
        setTimeout() {
          return this
        },
        build: () => ({ sign: vi.fn() }),
      }
    }),
    Contract: vi.fn(function () { return { call: vi.fn(() => ({})) } }),
    Address: { fromString: () => ({ toScVal: () => ({}) }) },
    xdr: {
      ScVal: { scvI128: () => ({}) },
      Int128Parts: vi.fn(),
      Int64: { fromString: () => 0n },
      Uint64: { fromString: vi.fn(() => 0n) },
    },
    BASE_FEE: '100',
    rpc: {
      Api: { isSimulationError: () => false },
      assembleTransaction: () => ({ build: () => ({ sign: vi.fn() }) }),
    },
  }
  const rpcServer = {
    getAccount: vi.fn(async () => ({})),
    simulateTransaction: vi.fn(async () => ({
      minResourceFee: '1',
      transactionData: { build: () => ({}) },
      result: {},
    })),
    sendTransaction: vi.fn(async () => ({ status: 'PENDING', hash: 'FHASH' })),
    getTransaction: vi.fn(async () => ({ status: 'SUCCESS' })),
  }

  it('caps the dispensed amount at CAP_BASE_UNITS', async () => {
    const out = await dispenseToken({
      secret: 'SSECRET',
      token: 'CTOKEN',
      to: 'CACCT',
      amount: 10n ** 18n, // absurdly large
      passphrase: 'Test SDF Network ; September 2015',
      sdk,
      rpcServer,
    })
    expect(out.hash).toBe('FHASH')
    // The i128 op was built with the capped value, not the requested one:
    expect(sdk.xdr.Uint64.fromString).toHaveBeenCalledWith(CAP_BASE_UNITS.toString())
  })
})

// ─── Durable daily-spend accounting (D1, migration 0011) ───

// Minimal D1-shaped wrapper over node:sqlite (same idiom as durableRateLimit.test.js),
// exposing the raw handle for total assertions.
function faucetD1WithSqlite({ migrated = true } = {}) {
  const sqlite = new DatabaseSync(':memory:')
  if (migrated) sqlite.exec(CROSS_MIGRATION + '\n' + FAUCET_MIGRATION)
  return {
    sqlite,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              return sqlite.prepare(sql).get(...params)
            },
            async run() {
              return sqlite.prepare(sql).run(...params)
            },
          }
        },
      }
    },
  }
}

function spendTotal(db, recipient) {
  return db.sqlite
    .prepare('SELECT total_base_units FROM vf_faucet_daily_spend WHERE recipient = ?')
    .get(recipient)?.total_base_units
}

describe('reserveSpendDurable (D1 daily caps)', () => {
  const DAY = 24 * 60 * 60 * 1000
  const T = 1_700_000_000_000 // a fixed instant; aligned UTC-day windows converge on it

  it('reserves within caps and converges on one counter across calls', async () => {
    const db = faucetD1WithSqlite()
    expect(await reserveSpendDurable('rD1', tok(100), { db, now: T })).toEqual({ ok: true })
    expect(await reserveSpendDurable('rD1', tok(200), { db, now: T })).toEqual({ ok: true })
    // A second "isolate" (fresh call, same D1) sees the same total: 100 + 200 = 300.
    expect(spendTotal(db, 'rD1')).toBe(Number(tok(300)))
    expect(spendTotal(db, FAUCET_GLOBAL_SPEND_KEY)).toBe(Number(tok(300)))
  })

  it('denies over the per-recipient cap and records nothing for the denied request', async () => {
    const db = faucetD1WithSqlite()
    expect(await reserveSpendDurable('rD2', tok(100), { db, now: T })).toEqual({ ok: true })
    const denied = await reserveSpendDurable('rD2', tok(250), { db, now: T })
    expect(denied.ok).toBe(false)
    expect(denied.scope).toBe('recipient')
    expect(denied.retryAfterSecs).toBeGreaterThanOrEqual(1)
    // Compensation rolled the denied 250 back: the recipient still holds exactly 100.
    expect(spendTotal(db, 'rD2')).toBe(Number(tok(100)))
    expect(spendTotal(db, FAUCET_GLOBAL_SPEND_KEY)).toBe(Number(tok(100)))
  })

  it('denies over the global cap and rolls back the recipient reservation', async () => {
    const db = faucetD1WithSqlite()
    for (let i = 0; i < 16; i++) {
      expect(await reserveSpendDurable(`gD${i}`, PER_RECIPIENT_DAILY_CAP, { db, now: T })).toEqual({
        ok: true,
      })
    }
    // 16 × 300 = 4800 ≤ 5000; one more 300 trips the global ceiling.
    const denied = await reserveSpendDurable('gD16', PER_RECIPIENT_DAILY_CAP, { db, now: T })
    expect(denied.ok).toBe(false)
    expect(denied.scope).toBe('global')
    // The denied recipient holds nothing (compensated back to zero) and the global total
    // is untouched at 4800.
    expect(spendTotal(db, 'gD16')).toBe(0)
    expect(spendTotal(db, FAUCET_GLOBAL_SPEND_KEY)).toBe(Number(tok(4800)))
  })

  it('starts a new aligned window on the next UTC day', async () => {
    const db = faucetD1WithSqlite()
    const windowStart = Math.floor(T / DAY) * DAY
    expect(await reserveSpendDurable('rD3', PER_RECIPIENT_DAILY_CAP, { db, now: T })).toEqual({
      ok: true,
    })
    expect(await reserveSpendDurable('rD3', tok(1), { db, now: T })).toMatchObject({ ok: false })
    // Next aligned day: the same recipient may spend the full cap again.
    expect(
      await reserveSpendDurable('rD3', PER_RECIPIENT_DAILY_CAP, { db, now: windowStart + DAY + 1 })
    ).toEqual({ ok: true })
  })

  it('fails closed (throws) when the 0011 migration has not run', async () => {
    const db = faucetD1WithSqlite({ migrated: false })
    await expect(reserveSpendDurable('rD4', tok(1), { db, now: T })).rejects.toThrow()
  })

  it('refuses the global key as a recipient (row-key collision guard)', async () => {
    const db = faucetD1WithSqlite()
    await expect(
      reserveSpendDurable(FAUCET_GLOBAL_SPEND_KEY, tok(1), { db, now: T })
    ).rejects.toThrow()
  })

  it('caps are unchanged: 100/tx, 300/recipient/day, 5000 global/day', () => {
    expect(CAP_BASE_UNITS).toBe(tok(100))
    expect(PER_RECIPIENT_DAILY_CAP).toBe(tok(300))
    expect(GLOBAL_DAILY_CAP).toBe(tok(5000))
    expect(faucetDayRetryAfter(T)).toBeGreaterThanOrEqual(1)
  })
})

describe('faucet handler durable gating', () => {
  const OLD_ENV = { ...process.env }
  afterEach(() => {
    process.env = { ...OLD_ENV }
    vi.restoreAllMocks()
  })

  function pagesReq(db, { ip = '198.51.100.21', body } = {}) {
    return {
      method: 'POST',
      headers: { origin: 'http://localhost:5173', 'cf-connecting-ip': ip },
      body,
      env: { VF_DB: db, ALLOWED_ORIGIN: 'http://localhost:5173' },
    }
  }

  function pagesRes() {
    return {
      statusCode: 200,
      headers: {},
      body: '',
      setHeader(k, v) {
        this.headers[k] = v
      },
      end(s) {
        this.body = s ?? ''
        return this
      },
    }
  }

  it('429 + Retry-After when the durable daily cap is reached (no dispense attempted)', async () => {
    process.env.VF_FAUCET_SECRET = 'SSECRET'
    process.env.SOROBAN_TOKEN_ADDRESS = 'CTOKEN'
    const db = faucetD1WithSqlite()
    const to = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'
    const now = Date.now()
    // Prefill the recipient to its 300 cap directly in D1 (3 × 100).
    for (let i = 0; i < 3; i++) {
      expect(await reserveSpendDurable(to, tok(100), { db, now })).toEqual({ ok: true })
    }
    const res = pagesRes()
    await handler(pagesReq(db, { body: { action: 'dispense', to } }), res)
    expect(res.statusCode).toBe(429)
    expect(Number(res.headers['Retry-After'])).toBeGreaterThanOrEqual(1)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Daily faucet cap reached' })
  })

  it('503 + Retry-After fail-closed without D1 in production (no memory fallback)', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.VF_DB
    const res = pagesRes()
    // No VF_DB anywhere and no secret: the durable per-IP gate fails closed first.
    await handler(
      { method: 'POST', headers: { origin: 'http://localhost:5173', 'x-real-ip': '10.9.9.9' }, body: {} },
      res
    )
    expect(res.statusCode).toBe(503)
    expect(Number(res.headers['Retry-After'])).toBeGreaterThanOrEqual(1)
  })
})
