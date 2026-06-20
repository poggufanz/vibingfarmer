import { describe, it, expect, beforeEach, vi } from 'vitest'
import { feeBumpAndSubmit, RelayError, _clearSeen } from './stellar-relay.js'

const PASS = 'Test SDF Network ; September 2015'
const SECRET = 'SABCD' // never parsed — Keypair.fromSecret is faked below

// Fake SDK. fromXDR returns a fake inner Transaction; buildFeeBumpTransaction returns a fake
// fee-bump with a sign() spy; instanceof FeeBumpTransaction is used to reject already-bumped tx.
class FakeFeeBump {}
function makeSdk({ innerFee = '100000', innerHashHex = 'aa', alreadyBumped = false } = {}) {
  const signSpy = vi.fn()
  const builtFeeBump = { sign: signSpy }
  const buildFeeBumpTransaction = vi.fn(() => builtFeeBump)
  const inner = alreadyBumped
    ? new FakeFeeBump()
    : { fee: innerFee, operations: [], hash: () => Buffer.from(innerHashHex, 'hex') }
  return {
    sdk: {
      TransactionBuilder: { fromXDR: vi.fn(() => inner), buildFeeBumpTransaction },
      FeeBumpTransaction: FakeFeeBump,
      Keypair: { fromSecret: () => ({ publicKey: () => 'GREL' }) },
      Address: {},
    },
    signSpy,
    buildFeeBumpTransaction,
    builtFeeBump,
  }
}
function makeRpc({ sendStatus = 'PENDING', getStatuses = ['SUCCESS'] } = {}) {
  const queue = [...getStatuses]
  return {
    sendTransaction: vi.fn(async () => ({ status: sendStatus, hash: 'OUTERHASH' })),
    getTransaction: vi.fn(async () => ({ status: queue.shift() ?? 'NOT_FOUND' })),
  }
}

describe('feeBumpAndSubmit', () => {
  beforeEach(() => _clearSeen())

  it('fee-bumps, signs with the relayer key, submits, polls to SUCCESS', async () => {
    const { sdk, signSpy, buildFeeBumpTransaction } = makeSdk({ innerHashHex: '11' })
    const rpc = makeRpc({ getStatuses: ['NOT_FOUND', 'SUCCESS'] })
    const out = await feeBumpAndSubmit({
      xdr: 'INNERXDR', secret: SECRET, passphrase: PASS, vaultAddr: '', sdk, rpcServer: rpc,
    })
    expect(out).toEqual({ hash: 'OUTERHASH', status: 'SUCCESS', relayer: 'GREL' })
    expect(buildFeeBumpTransaction).toHaveBeenCalledOnce()
    expect(signSpy).toHaveBeenCalledOnce()
    expect(rpc.sendTransaction).toHaveBeenCalledOnce()
  })

  it('rejects an already-fee-bumped inner tx (the relay must be the fee source)', async () => {
    const { sdk } = makeSdk({ alreadyBumped: true })
    const rpc = makeRpc()
    await expect(
      feeBumpAndSubmit({ xdr: 'X', secret: SECRET, passphrase: PASS, vaultAddr: '', sdk, rpcServer: rpc })
    ).rejects.toBeInstanceOf(RelayError)
    expect(rpc.sendTransaction).not.toHaveBeenCalled()
  })

  it('throws when the RPC rejects the submission (status ERROR)', async () => {
    const { sdk } = makeSdk({ innerHashHex: '22' })
    const rpc = makeRpc({ sendStatus: 'ERROR' })
    await expect(
      feeBumpAndSubmit({ xdr: 'X', secret: SECRET, passphrase: PASS, vaultAddr: '', sdk, rpcServer: rpc })
    ).rejects.toBeInstanceOf(RelayError)
  })

  it('short-circuits a replayed inner tx without re-broadcasting (same inner hash)', async () => {
    const a = makeSdk({ innerHashHex: '33' })
    const rpcA = makeRpc({ getStatuses: ['SUCCESS'] })
    await feeBumpAndSubmit({ xdr: 'X', secret: SECRET, passphrase: PASS, vaultAddr: '', sdk: a.sdk, rpcServer: rpcA })
    const b = makeSdk({ innerHashHex: '33' }) // same inner hash → duplicate
    const rpcB = makeRpc({ getStatuses: ['SUCCESS'] })
    const out = await feeBumpAndSubmit({ xdr: 'X', secret: SECRET, passphrase: PASS, vaultAddr: '', sdk: b.sdk, rpcServer: rpcB })
    expect(out.status).toBe('duplicate')
    expect(rpcB.sendTransaction).not.toHaveBeenCalled()
  })

  it('returns PENDING (not an error) when the tx is still NOT_FOUND after the poll budget', async () => {
    const { sdk } = makeSdk({ innerHashHex: '44' })
    const rpc = makeRpc({ getStatuses: [] }) // always NOT_FOUND
    const out = await feeBumpAndSubmit({
      xdr: 'X', secret: SECRET, passphrase: PASS, vaultAddr: '', sdk, rpcServer: rpc,
      pollTries: 2, pollIntervalMs: 0,
    })
    expect(out.status).toBe('PENDING')
    expect(out.hash).toBe('OUTERHASH')
  })
})
