import { describe, it, expect, vi, beforeEach } from 'vitest'
import handler, { dispenseToken, CAP_BASE_UNITS } from './faucet.js'

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(s) { this.body = s ?? ''; return this },
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
    await handler(mockReq({ action: 'dispense', to: 'CACCT' }, { origin: 'https://evil.example' }), res)
    expect(res.statusCode).toBe(403)
  })

  it('405 on non-POST', async () => {
    const res = mockRes()
    await handler(mockReq({}, { method: 'GET' }), res)
    expect(res.statusCode).toBe(405)
  })
})

describe('dispenseToken (cap + transfer)', () => {
  const sdk = {
    Keypair: { fromSecret: () => ({ publicKey: () => 'GDEPLOYER', sign: vi.fn() }) },
    TransactionBuilder: vi.fn(() => ({
      addOperation() { return this },
      setTimeout() { return this },
      build: () => ({ sign: vi.fn() }),
    })),
    Contract: vi.fn(() => ({ call: vi.fn(() => ({})) })),
    Address: { fromString: () => ({ toScVal: () => ({}) }) },
    xdr: { ScVal: { scvI128: () => ({}) }, Int128Parts: vi.fn(), Int64: { fromString: () => 0n }, Uint64: { fromString: vi.fn(() => 0n) } },
    BASE_FEE: '100',
    rpc: { Api: { isSimulationError: () => false }, assembleTransaction: () => ({ build: () => ({ sign: vi.fn() }) }) },
  }
  const rpcServer = {
    getAccount: vi.fn(async () => ({})),
    simulateTransaction: vi.fn(async () => ({ minResourceFee: '1', transactionData: { build: () => ({}) }, result: {} })),
    sendTransaction: vi.fn(async () => ({ status: 'PENDING', hash: 'FHASH' })),
    getTransaction: vi.fn(async () => ({ status: 'SUCCESS' })),
  }

  it('caps the dispensed amount at CAP_BASE_UNITS', async () => {
    const out = await dispenseToken({
      secret: 'SSECRET', token: 'CTOKEN', to: 'CACCT', amount: 10n ** 18n, // absurdly large
      passphrase: 'Test SDF Network ; September 2015', sdk, rpcServer,
    })
    expect(out.hash).toBe('FHASH')
    // The i128 op was built with the capped value, not the requested one:
    expect(sdk.xdr.Uint64.fromString).toHaveBeenCalledWith(CAP_BASE_UNITS.toString())
  })
})
