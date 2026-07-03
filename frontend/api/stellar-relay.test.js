import { describe, it, expect, beforeEach, vi } from 'vitest'
import { feeBumpAndSubmit, RelayError, _clearSeen, assertVaultDeposit } from './stellar-relay.js'

const PASS = 'Test SDF Network ; September 2015'
const SECRET = 'SABCD' // never parsed — Keypair.fromSecret is faked below

// Fake SDK. fromXDR returns a fake inner Transaction; buildFeeBumpTransaction returns a fake
// fee-bump with a sign() spy; instanceof FeeBumpTransaction is used to reject already-bumped tx.
class FakeFeeBump {}
function makeSdk({
  innerFee = '100000',
  innerHashHex = 'aa',
  alreadyBumped = false,
  innerSource = undefined,
} = {}) {
  const signSpy = vi.fn()
  const innerSignSpy = vi.fn()
  const builtFeeBump = { sign: signSpy }
  const buildFeeBumpTransaction = vi.fn(() => builtFeeBump)
  const inner = alreadyBumped
    ? new FakeFeeBump()
    : {
        fee: innerFee,
        source: innerSource,
        operations: [],
        hash: () => Buffer.from(innerHashHex, 'hex'),
        sign: innerSignSpy,
      }
  return {
    sdk: {
      TransactionBuilder: { fromXDR: vi.fn(() => inner), buildFeeBumpTransaction },
      FeeBumpTransaction: FakeFeeBump,
      Keypair: { fromSecret: () => ({ publicKey: () => 'GREL' }) },
      Address: {},
    },
    signSpy,
    innerSignSpy,
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
      xdr: 'INNERXDR',
      secret: SECRET,
      passphrase: PASS,
      vaultAddr: '',
      sdk,
      rpcServer: rpc,
    })
    expect(out).toEqual({ hash: 'OUTERHASH', status: 'SUCCESS', relayer: 'GREL' })
    expect(buildFeeBumpTransaction).toHaveBeenCalledOnce()
    expect(signSpy).toHaveBeenCalledOnce()
    expect(rpc.sendTransaction).toHaveBeenCalledOnce()
  })

  it('signs the inner tx when the relayer is its source (agent-deposit path), then fee-bumps', async () => {
    const { sdk, innerSignSpy, signSpy, buildFeeBumpTransaction } = makeSdk({
      innerHashHex: '55',
      innerSource: 'GREL', // inner source == relayer pubkey → relay must sign the inner envelope
    })
    const rpc = makeRpc({ getStatuses: ['SUCCESS'] })
    const out = await feeBumpAndSubmit({
      xdr: 'INNERXDR',
      secret: SECRET,
      passphrase: PASS,
      vaultAddr: '',
      sdk,
      rpcServer: rpc,
    })
    expect(out.status).toBe('SUCCESS')
    expect(innerSignSpy).toHaveBeenCalledOnce() // the new branch: relayer signs the inner tx
    expect(signSpy).toHaveBeenCalledOnce() // still fee-bumped + signed
    expect(buildFeeBumpTransaction).toHaveBeenCalledOnce()
  })

  it('does NOT sign the inner tx when its source differs from the relayer (separate funded source)', async () => {
    const { sdk, innerSignSpy } = makeSdk({ innerHashHex: '56', innerSource: 'GOTHER' })
    const rpc = makeRpc({ getStatuses: ['SUCCESS'] })
    await feeBumpAndSubmit({
      xdr: 'INNERXDR',
      secret: SECRET,
      passphrase: PASS,
      vaultAddr: '',
      sdk,
      rpcServer: rpc,
    })
    expect(innerSignSpy).not.toHaveBeenCalled() // client already signed it; relay only fee-bumps
  })

  it('rejects an already-fee-bumped inner tx (the relay must be the fee source)', async () => {
    const { sdk } = makeSdk({ alreadyBumped: true })
    const rpc = makeRpc()
    await expect(
      feeBumpAndSubmit({
        xdr: 'X',
        secret: SECRET,
        passphrase: PASS,
        vaultAddr: '',
        sdk,
        rpcServer: rpc,
      })
    ).rejects.toBeInstanceOf(RelayError)
    expect(rpc.sendTransaction).not.toHaveBeenCalled()
  })

  it('throws when the RPC rejects the submission (status ERROR)', async () => {
    const { sdk } = makeSdk({ innerHashHex: '22' })
    const rpc = makeRpc({ sendStatus: 'ERROR' })
    await expect(
      feeBumpAndSubmit({
        xdr: 'X',
        secret: SECRET,
        passphrase: PASS,
        vaultAddr: '',
        sdk,
        rpcServer: rpc,
      })
    ).rejects.toBeInstanceOf(RelayError)
  })

  it('short-circuits a replayed inner tx without re-broadcasting (same inner hash)', async () => {
    const a = makeSdk({ innerHashHex: '33' })
    const rpcA = makeRpc({ getStatuses: ['SUCCESS'] })
    await feeBumpAndSubmit({
      xdr: 'X',
      secret: SECRET,
      passphrase: PASS,
      vaultAddr: '',
      sdk: a.sdk,
      rpcServer: rpcA,
    })
    const b = makeSdk({ innerHashHex: '33' }) // same inner hash → duplicate
    const rpcB = makeRpc({ getStatuses: ['SUCCESS'] })
    const out = await feeBumpAndSubmit({
      xdr: 'X',
      secret: SECRET,
      passphrase: PASS,
      vaultAddr: '',
      sdk: b.sdk,
      rpcServer: rpcB,
    })
    expect(out.status).toBe('duplicate')
    expect(rpcB.sendTransaction).not.toHaveBeenCalled()
  })

  it('returns PENDING (not an error) when the tx is still NOT_FOUND after the poll budget', async () => {
    const { sdk } = makeSdk({ innerHashHex: '44' })
    const rpc = makeRpc({ getStatuses: [] }) // always NOT_FOUND
    const out = await feeBumpAndSubmit({
      xdr: 'X',
      secret: SECRET,
      passphrase: PASS,
      vaultAddr: '',
      sdk,
      rpcServer: rpc,
      pollTries: 2,
      pollIntervalMs: 0,
    })
    expect(out.status).toBe('PENDING')
    expect(out.hash).toBe('OUTERHASH')
  })
})

const VAULT = 'CCTGGJVVY45DYDDXM3XBFEJ2OT2J2ZT6HIXZEQKXU7Z53TH3YSZJC3PF'

const TOKEN = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'

// A fake inner tx whose single op decodes to invokeContract(contractStr, fnStr, args).
function depositTx(contractStr, fnStr, args = []) {
  return {
    operations: [
      {
        type: 'invokeHostFunction',
        func: {
          switch: () => ({ name: 'hostFunctionTypeInvokeContract' }),
          invokeContract: () => ({
            contractAddress: () => ({ __sc: contractStr }),
            functionName: () => fnStr, // ScSymbol stringifies to the symbol
            args: () => args,
          }),
        },
      },
    ],
  }
}
// Fake Address decoders: read back the string our fixture tucked in.
const sdkAddr = {
  Address: {
    fromScAddress: (sc) => ({ toString: () => sc.__sc }),
    fromScVal: (v) => ({ toString: () => v.__addr }),
  },
}

describe('assertVaultDeposit', () => {
  it('passes a single deposit op to the configured vault', () => {
    expect(() => assertVaultDeposit(depositTx(VAULT, 'deposit'), VAULT, sdkAddr)).not.toThrow()
  })
  it('passes a vault redeem (F11 exit leg 1)', () => {
    expect(() => assertVaultDeposit(depositTx(VAULT, 'redeem'), VAULT, sdkAddr)).not.toThrow()
  })
  it('rejects a call to a different contract', () => {
    expect(() => assertVaultDeposit(depositTx('CWRONG', 'deposit'), VAULT, sdkAddr)).toThrow(
      RelayError
    )
  })
  it('rejects a non-deposit/redeem vault function', () => {
    expect(() => assertVaultDeposit(depositTx(VAULT, 'withdraw'), VAULT, sdkAddr)).toThrow(
      RelayError
    )
  })
  it('passes a token transfer from an allowlisted agent address when tokenAddr is set', () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'CAGENT' }, { __addr: 'GOWNER' }])
    expect(() => assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN, 'CAGENT')).not.toThrow()
  })
  it('rejects a token transfer from a G account (relayer is not a public gas faucet)', () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'GSOMEONE' }, { __addr: 'GOWNER' }])
    expect(() => assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN, 'CAGENT')).toThrow(RelayError)
  })
  it('rejects a token transfer when tokenAddr is not configured (fail closed)', () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'CAGENT' }, { __addr: 'GOWNER' }])
    expect(() => assertVaultDeposit(tx, VAULT, sdkAddr, '', 'CAGENT')).toThrow(RelayError)
  })
  it('rejects a non-allowlisted contract address (attacker custom account, was the free-sponsorship hole)', () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'CATTACKER' }, { __addr: 'GOWNER' }])
    expect(() => assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN, 'CAGENT')).toThrow(RelayError)
  })
  it('rejects every transfer when the allowlist is empty but tokenAddr is set (fail closed)', () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'CAGENT' }, { __addr: 'GOWNER' }])
    expect(() => assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN, '')).toThrow(RelayError)
    expect(() => assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN)).toThrow(RelayError) // default param
  })
  it('accepts a multi-entry allowlist, matching any listed agent (trims whitespace, ignores empty segments)', () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'CAGENT2' }, { __addr: 'GOWNER' }])
    const list = ' CAGENT1 , CAGENT2 ,,CAGENT3 '
    expect(() => assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN, list)).not.toThrow()
  })
  it('rejects a G-address even when the allowlist string coincidentally contains it as a substring', () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'GOWNER' }, { __addr: 'GOTHER' }])
    expect(() => assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN, 'CAGENT,GOWNERX')).toThrow(
      RelayError
    )
  })
  it('rejects non-transfer token functions', () => {
    const tx = depositTx(TOKEN, 'approve', [{ __addr: 'CAGENT' }])
    expect(() => assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN)).toThrow(RelayError)
  })
  it('rejects a multi-operation tx', () => {
    const tx = depositTx(VAULT, 'deposit')
    tx.operations.push(tx.operations[0])
    expect(() => assertVaultDeposit(tx, VAULT, sdkAddr)).toThrow(RelayError)
  })
  it('rejects a non-invoke op', () => {
    expect(() => assertVaultDeposit({ operations: [{ type: 'payment' }] }, VAULT, sdkAddr)).toThrow(
      RelayError
    )
  })
  it('is a no-op when vaultAddr is empty (pre-wiring / smoke bypass)', () => {
    expect(() => assertVaultDeposit(depositTx('CANY', 'anything'), '', sdkAddr)).not.toThrow()
  })
})
