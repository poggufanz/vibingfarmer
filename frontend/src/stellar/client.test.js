import { describe, it, expect, vi } from 'vitest'
import { Account, nativeToScVal, scValToNative } from '@stellar/stellar-sdk'
import { addrScVal, i128ScVal } from './scval.js'
import { buildCreateContractTx, encodeArgs, readContract, submitUserTx } from './client.js'

describe('soroban client', () => {
  it('encodeArgs passes a pre-built raw ScVal through unchanged', () => {
    // js-xdr puts every union-arm accessor on ScVal's prototype, so `'i128' in scval` is true
    // for ANY ScVal — without a raw-ScVal guard this Vec<i128> would hit the i128 branch and throw.
    const vec = nativeToScVal([1n, 2n], { type: 'i128' })
    const [out] = encodeArgs([vec])
    expect(out).toBe(vec)
  })

  it('readContract simulates a read-only call and decodes the retval to native', async () => {
    // fake server: simulateTransaction returns a successful sim carrying an i128 retval
    const fakeServer = {
      simulateTransaction: vi.fn(async () => ({ result: { retval: i128ScVal(7n) } })),
    }
    const out = await readContract({
      contract: 'CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5',
      method: 'decimals',
      args: [],
      server: fakeServer,
    })
    expect(fakeServer.simulateTransaction).toHaveBeenCalledOnce()
    expect(out).toBe(7n)
  })

  it('readContract throws when the simulation errors', async () => {
    const fakeServer = {
      simulateTransaction: vi.fn(async () => ({ error: 'boom' })),
    }
    await expect(
      readContract({
        contract: 'CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5',
        method: 'decimals',
        server: fakeServer,
      })
    ).rejects.toThrow(/simulation failed/i)
  })

  it('submitUserTx sends the signed xdr and returns the hash + status', async () => {
    const fakeServer = {
      sendTransaction: vi.fn(async () => ({ status: 'PENDING', hash: 'abc123' })),
      getTransaction: vi.fn(async () => ({ status: 'SUCCESS' })),
    }
    const out = await submitUserTx({
      signedXdr: 'AAAA==',
      server: fakeServer,
      pollIntervalMs: 0,
    })
    expect(fakeServer.sendTransaction).toHaveBeenCalledOnce()
    expect(out).toEqual({ hash: 'abc123', status: 'SUCCESS' })
  })

  it('submitUserTx throws when the tx lands FAILED on-chain', async () => {
    // A FAILED tx used to resolve like a successful one, so callers that forgot to check `status`
    // (4 of 7 did) reported a withdraw that moved no funds as a success. Fail closed here instead.
    const fakeServer = {
      sendTransaction: vi.fn(async () => ({ status: 'PENDING', hash: 'dead01' })),
      getTransaction: vi.fn(async () => ({ status: 'FAILED' })),
    }
    await expect(
      submitUserTx({ signedXdr: 'AAAA==', server: fakeServer, pollIntervalMs: 0 })
    ).rejects.toThrow(/failed on-chain/i)
  })

  it('submitUserTx still returns PENDING so callers can decide (it is not a confirmed failure)', async () => {
    const fakeServer = {
      sendTransaction: vi.fn(async () => ({ status: 'PENDING', hash: 'pend01' })),
      getTransaction: vi.fn(async () => ({ status: 'NOT_FOUND' })),
    }
    const out = await submitUserTx({
      signedXdr: 'AAAA==',
      server: fakeServer,
      pollTries: 2,
      pollIntervalMs: 0,
    })
    expect(out).toEqual({ hash: 'pend01', status: 'PENDING' })
  })
})

describe('buildCreateContractTx', () => {
  const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
  const CREATED = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
  const WASM_HASH = '8c607112ba93ff289d30f2c894ca586c745328e5cb2ae6139917c6df540dda62'

  function fakeDeployServer() {
    return {
      getAccount: vi.fn(async () => new Account(OWNER, '1')),
      // The create host fn's simulated retval IS the to-be-created contract address.
      simulateTransaction: vi.fn(async () => ({ result: { retval: addrScVal(CREATED) } })),
      prepareTransaction: vi.fn(async (raw) => raw),
    }
  }

  it('builds a createContractV2 op from the wasm hash with the encoded constructor args', async () => {
    const fakeServer = fakeDeployServer()
    const out = await buildCreateContractTx({
      source: OWNER,
      wasmHash: WASM_HASH,
      constructorArgs: [{ addr: OWNER }, { bytes32: '0x' + '07'.repeat(32) }],
      server: fakeServer,
    })
    expect(out.contractAddress).toBe(CREATED)
    expect(out.xdr).toEqual(expect.any(String))
    // Inspect the REAL op that was simulated: createContractV2 from the hash, args encoded.
    const raw = fakeServer.prepareTransaction.mock.calls[0][0]
    const op = raw.operations[0]
    expect(op.func.switch().name).toBe('hostFunctionTypeCreateContractV2')
    const create = op.func.createContractV2()
    expect(create.executable().wasmHash().toString('hex')).toBe(WASM_HASH)
    const args = create.constructorArgs()
    expect(scValToNative(args[0])).toBe(OWNER)
    expect(Buffer.from(scValToNative(args[1])).toString('hex')).toBe('07'.repeat(32))
    // Deployer address preimage = the source account (the user wallet signs + pays).
    expect(fakeServer.simulateTransaction).toHaveBeenCalledOnce()
    expect(fakeServer.prepareTransaction).toHaveBeenCalledOnce()
  })

  it('throws on a malformed wasm hash before touching the network', async () => {
    await expect(
      buildCreateContractTx({ source: OWNER, wasmHash: 'nothex', server: fakeDeployServer() })
    ).rejects.toThrow(/64-char hex/)
  })

  it('throws when the deploy simulation errors', async () => {
    const fakeServer = fakeDeployServer()
    fakeServer.simulateTransaction = vi.fn(async () => ({ error: 'no wasm for hash' }))
    await expect(
      buildCreateContractTx({ source: OWNER, wasmHash: WASM_HASH, server: fakeServer })
    ).rejects.toThrow(/Contract deployment simulation failed/)
  })
})
