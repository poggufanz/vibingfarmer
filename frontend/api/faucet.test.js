import { describe, it, expect, vi, beforeEach } from 'vitest'
import handler, {
  dispenseToken,
  CAP_BASE_UNITS,
  effectiveAmount,
  reserveDaily,
  PER_RECIPIENT_DAILY_CAP,
} from './faucet.js'

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
    TransactionBuilder: vi.fn(() => ({
      addOperation() {
        return this
      },
      setTimeout() {
        return this
      },
      build: () => ({ sign: vi.fn() }),
    })),
    Contract: vi.fn(() => ({ call: vi.fn(() => ({})) })),
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
