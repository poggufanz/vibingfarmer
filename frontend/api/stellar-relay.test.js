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
  it('passes a single deposit op to the configured vault', async () => {
    await expect(
      assertVaultDeposit(depositTx(VAULT, 'deposit'), VAULT, sdkAddr)
    ).resolves.toBeUndefined()
  })
  it('passes a vault redeem (F11 exit leg 1)', async () => {
    await expect(
      assertVaultDeposit(depositTx(VAULT, 'redeem'), VAULT, sdkAddr)
    ).resolves.toBeUndefined()
  })
  it('rejects a call to a different contract', async () => {
    await expect(
      assertVaultDeposit(depositTx('CWRONG', 'deposit'), VAULT, sdkAddr)
    ).rejects.toThrow(RelayError)
  })
  it('rejects a non-deposit/redeem vault function', async () => {
    await expect(assertVaultDeposit(depositTx(VAULT, 'withdraw'), VAULT, sdkAddr)).rejects.toThrow(
      RelayError
    )
  })
  it('passes a token transfer from an allowlisted agent address when tokenAddr is set', async () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'CAGENT' }, { __addr: 'GOWNER' }])
    await expect(assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN, 'CAGENT')).resolves.toBeUndefined()
  })
  it('rejects a token transfer from a G account (relayer is not a public gas faucet)', async () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'GSOMEONE' }, { __addr: 'GOWNER' }])
    await expect(assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN, 'CAGENT')).rejects.toThrow(
      RelayError
    )
  })
  it('rejects a token transfer when tokenAddr is not configured (fail closed)', async () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'CAGENT' }, { __addr: 'GOWNER' }])
    await expect(assertVaultDeposit(tx, VAULT, sdkAddr, '', 'CAGENT')).rejects.toThrow(RelayError)
  })
  it('rejects a non-allowlisted contract address (attacker custom account, was the free-sponsorship hole)', async () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'CATTACKER' }, { __addr: 'GOWNER' }])
    await expect(assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN, 'CAGENT')).rejects.toThrow(
      RelayError
    )
  })
  it('rejects every transfer when the allowlist is empty but tokenAddr is set (fail closed)', async () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'CAGENT' }, { __addr: 'GOWNER' }])
    await expect(assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN, '')).rejects.toThrow(RelayError)
    await expect(assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN)).rejects.toThrow(RelayError) // default param
  })
  it('accepts a multi-entry allowlist, matching any listed agent (trims whitespace, ignores empty segments)', async () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'CAGENT2' }, { __addr: 'GOWNER' }])
    const list = ' CAGENT1 , CAGENT2 ,,CAGENT3 '
    await expect(assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN, list)).resolves.toBeUndefined()
  })
  it('rejects a G-address even when the allowlist string coincidentally contains it as a substring', async () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'GOWNER' }, { __addr: 'GOTHER' }])
    await expect(assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN, 'CAGENT,GOWNERX')).rejects.toThrow(
      RelayError
    )
  })
  it('rejects non-transfer token functions', async () => {
    const tx = depositTx(TOKEN, 'approve', [{ __addr: 'CAGENT' }])
    await expect(assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN)).rejects.toThrow(RelayError)
  })
  it('rejects a multi-operation tx', async () => {
    const tx = depositTx(VAULT, 'deposit')
    tx.operations.push(tx.operations[0])
    await expect(assertVaultDeposit(tx, VAULT, sdkAddr)).rejects.toThrow(RelayError)
  })
  it('rejects a non-invoke op', async () => {
    await expect(
      assertVaultDeposit({ operations: [{ type: 'payment' }] }, VAULT, sdkAddr)
    ).rejects.toThrow(RelayError)
  })
  it('is a no-op when vaultAddr is empty (pre-wiring / smoke bypass)', async () => {
    await expect(
      assertVaultDeposit(depositTx('CANY', 'anything'), '', sdkAddr)
    ).resolves.toBeUndefined()
  })

  const AGENT_HASH = 'd61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba'

  it('sponsors a transfer from a NON-allowlisted agent whose wasm hash matches the pin', async () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'CDYNAMIC' }, { __addr: 'GOWNER' }])
    const getWasmHash = vi.fn(async () => AGENT_HASH)
    await expect(
      assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN, '', '', [], [AGENT_HASH], getWasmHash)
    ).resolves.toBeUndefined()
    expect(getWasmHash).toHaveBeenCalledWith('CDYNAMIC')
  })

  it('rejects when the wasm hash does not match', async () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'CEVIL' }, { __addr: 'GOWNER' }])
    const getWasmHash = async () => 'deadbeef'.repeat(8)
    await expect(
      assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN, '', '', [], [AGENT_HASH], getWasmHash)
    ).rejects.toThrow(RelayError)
  })

  it('rejects (fail closed) when the wasm lookup itself fails', async () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'CDYNAMIC' }, { __addr: 'GOWNER' }])
    const getWasmHash = async () => {
      throw new Error('rpc down')
    }
    await expect(
      assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN, '', '', [], [AGENT_HASH], getWasmHash)
    ).rejects.toThrow(RelayError)
  })

  it('rejects when no pin and no allowlist (unchanged fail-closed default)', async () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'CDYNAMIC' }, { __addr: 'GOWNER' }])
    await expect(
      assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN, '', '', [], [], null)
    ).rejects.toThrow(RelayError)
  })

  it('env-allowlisted agent still passes WITHOUT a wasm lookup', async () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'CDEMO' }, { __addr: 'GOWNER' }])
    const getWasmHash = vi.fn()
    await expect(
      assertVaultDeposit(tx, VAULT, sdkAddr, TOKEN, 'CDEMO', '', [], [AGENT_HASH], getWasmHash)
    ).resolves.toBeUndefined()
    expect(getWasmHash).not.toHaveBeenCalled()
  })

  it('accepts a transfer whose wasm hash is ANY entry of a multi-value agentWasmHashes list (dual v1/v3 support)', async () => {
    const tx = depositTx(TOKEN, 'transfer', [{ __addr: 'CDYNAMIC2' }, { __addr: 'GOWNER' }])
    const OTHER_HASH = 'deadbeef'.repeat(8)
    const getWasmHash = vi.fn(async () => AGENT_HASH)
    await expect(
      assertVaultDeposit(
        tx,
        VAULT,
        sdkAddr,
        TOKEN,
        '',
        '',
        [],
        [OTHER_HASH, AGENT_HASH],
        getWasmHash
      )
    ).resolves.toBeUndefined()
  })
})

const ROUTER = 'CROUTER'
const ROUTER_V1 = 'CROUTERV1'
const ROUTER_V2 = 'CROUTERV2'

describe('assertVaultDeposit - funding_router grant/pull (single-signature grant flow)', () => {
  it('rejects router.grant when no router is configured (fail closed, unchanged)', async () => {
    const tx = depositTx(ROUTER, 'grant')
    await expect(assertVaultDeposit(tx, VAULT, sdkAddr)).rejects.toThrow(RelayError) // default param
    await expect(assertVaultDeposit(tx, VAULT, sdkAddr, '', '', '', [])).rejects.toThrow(RelayError)
  })
  it('rejects router.pull when no router is configured (fail closed, unchanged)', async () => {
    await expect(assertVaultDeposit(depositTx(ROUTER, 'pull'), VAULT, sdkAddr)).rejects.toThrow(
      RelayError
    )
  })
  it('passes router.grant when the router address is configured', async () => {
    const tx = depositTx(ROUTER, 'grant')
    await expect(
      assertVaultDeposit(tx, VAULT, sdkAddr, '', '', '', [ROUTER])
    ).resolves.toBeUndefined()
  })
  it('passes router.pull when the router address is configured', async () => {
    const tx = depositTx(ROUTER, 'pull')
    await expect(
      assertVaultDeposit(tx, VAULT, sdkAddr, '', '', '', [ROUTER])
    ).resolves.toBeUndefined()
  })
  it('rejects any other function on the configured router (no wider loosening)', async () => {
    const tx = depositTx(ROUTER, 'sweep')
    await expect(assertVaultDeposit(tx, VAULT, sdkAddr, '', '', '', [ROUTER])).rejects.toThrow(
      RelayError
    )
  })
  it('rejects grant/pull on a different contract even with the router configured', async () => {
    await expect(
      assertVaultDeposit(depositTx('COTHER', 'pull'), VAULT, sdkAddr, '', '', '', [ROUTER])
    ).rejects.toThrow(RelayError)
    await expect(
      assertVaultDeposit(depositTx('COTHER', 'grant'), VAULT, sdkAddr, '', '', '', [ROUTER])
    ).rejects.toThrow(RelayError)
  })
  it('leaves the vault-deposit branch untouched when the router is configured', async () => {
    const tx = depositTx(VAULT, 'deposit')
    await expect(
      assertVaultDeposit(tx, VAULT, sdkAddr, '', '', '', [ROUTER])
    ).resolves.toBeUndefined()
  })

  it('passes grant/pull on EITHER router when v1 and v2 are both listed (dual-support migration)', async () => {
    const routers = [ROUTER_V1, ROUTER_V2]
    await expect(
      assertVaultDeposit(depositTx(ROUTER_V1, 'grant'), VAULT, sdkAddr, '', '', '', routers)
    ).resolves.toBeUndefined()
    await expect(
      assertVaultDeposit(depositTx(ROUTER_V2, 'grant'), VAULT, sdkAddr, '', '', '', routers)
    ).resolves.toBeUndefined()
    await expect(
      assertVaultDeposit(depositTx(ROUTER_V1, 'pull'), VAULT, sdkAddr, '', '', '', routers)
    ).resolves.toBeUndefined()
    await expect(
      assertVaultDeposit(depositTx(ROUTER_V2, 'pull'), VAULT, sdkAddr, '', '', '', routers)
    ).resolves.toBeUndefined()
  })
})

const SAK_WASM = 'a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e'

// A fake inner tx whose single op decodes to createContractV2 with the given wasm executable.
function deployTx(hashHex, execKind = 'contractExecutableWasm') {
  return {
    operations: [
      {
        type: 'invokeHostFunction',
        func: {
          switch: () => ({ name: 'hostFunctionTypeCreateContractV2' }),
          createContractV2: () => ({
            executable: () => ({
              switch: () => ({ name: execKind }),
              wasmHash: () => Buffer.from(hashHex, 'hex'),
            }),
          }),
        },
      },
    ],
  }
}

describe('assertVaultDeposit - smart-account deploy sponsorship (SAK createWallet)', () => {
  it('passes a createContractV2 deploy of the pinned smart-account wasm', async () => {
    const tx = deployTx(SAK_WASM)
    await expect(assertVaultDeposit(tx, VAULT, sdkAddr, '', '', SAK_WASM)).resolves.toBeUndefined()
  })
  it('rejects a deploy of any other wasm (attacker contract gets no free deploy)', async () => {
    const tx = deployTx('deadbeef'.repeat(8))
    await expect(assertVaultDeposit(tx, VAULT, sdkAddr, '', '', SAK_WASM)).rejects.toThrow(
      RelayError
    )
  })
  it('rejects every deploy when no wasm hash is pinned (fail closed, default param)', async () => {
    const tx = deployTx(SAK_WASM)
    await expect(assertVaultDeposit(tx, VAULT, sdkAddr)).rejects.toThrow(RelayError)
    await expect(assertVaultDeposit(tx, VAULT, sdkAddr, '', '', '')).rejects.toThrow(RelayError)
  })
  it('rejects a non-wasm executable (stellar-asset SAC deploy is not a smart account)', async () => {
    const tx = deployTx(SAK_WASM, 'contractExecutableStellarAsset')
    await expect(assertVaultDeposit(tx, VAULT, sdkAddr, '', '', SAK_WASM)).rejects.toThrow(
      RelayError
    )
  })
  it('still rejects V1 createContract (SAK posts V2 only - anything else stays closed)', async () => {
    const tx = deployTx(SAK_WASM)
    tx.operations[0].func.switch = () => ({ name: 'hostFunctionTypeCreateContract' })
    await expect(assertVaultDeposit(tx, VAULT, sdkAddr, '', '', SAK_WASM)).rejects.toThrow(
      RelayError
    )
  })
})

// Realistic fixture value only (per plan constraint) — the relay reads the messenger address
// from SOROBAN_TOKEN_MESSENGER_ADDRESS at runtime; this is the live testnet TokenMessengerMinter.
const MESSENGER = 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP'
const AGENT_HASH_V3 = 'd61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba'

describe('assertVaultDeposit - CCTP messenger deposit_for_burn (agent-initiated burn sponsorship)', () => {
  it('sponsors deposit_for_burn when from (args[0]) is a pinned agent_account wasm', async () => {
    const tx = depositTx(MESSENGER, 'deposit_for_burn', [{ __addr: 'CAGENTV3' }])
    const getWasmHash = vi.fn(async () => AGENT_HASH_V3)
    await expect(
      assertVaultDeposit(
        tx,
        VAULT,
        sdkAddr,
        '',
        '',
        '',
        [],
        [AGENT_HASH_V3],
        getWasmHash,
        MESSENGER
      )
    ).resolves.toBeUndefined()
    expect(getWasmHash).toHaveBeenCalledWith('CAGENTV3')
  })

  it('rejects deposit_for_burn when from runs a foreign (non-pinned) wasm', async () => {
    const tx = depositTx(MESSENGER, 'deposit_for_burn', [{ __addr: 'CFOREIGN' }])
    const getWasmHash = async () => 'deadbeef'.repeat(8)
    await expect(
      assertVaultDeposit(
        tx,
        VAULT,
        sdkAddr,
        '',
        '',
        '',
        [],
        [AGENT_HASH_V3],
        getWasmHash,
        MESSENGER
      )
    ).rejects.toThrow(RelayError)
  })

  it('rejects deposit_for_burn when the messenger env is unset (fail closed, default param)', async () => {
    const tx = depositTx(MESSENGER, 'deposit_for_burn', [{ __addr: 'CAGENTV3' }])
    const getWasmHash = vi.fn(async () => AGENT_HASH_V3)
    await expect(
      assertVaultDeposit(tx, VAULT, sdkAddr, '', '', '', [], [AGENT_HASH_V3], getWasmHash)
    ).rejects.toThrow(RelayError)
    expect(getWasmHash).not.toHaveBeenCalled() // never even reaches the lookup — branch is dead
  })

  it('rejects any other function on the messenger contract (only deposit_for_burn is relayable)', async () => {
    const tx = depositTx(MESSENGER, 'deposit', [{ __addr: 'CAGENTV3' }])
    const getWasmHash = vi.fn(async () => AGENT_HASH_V3)
    await expect(
      assertVaultDeposit(
        tx,
        VAULT,
        sdkAddr,
        '',
        '',
        '',
        [],
        [AGENT_HASH_V3],
        getWasmHash,
        MESSENGER
      )
    ).rejects.toThrow(RelayError)
    expect(getWasmHash).not.toHaveBeenCalled()
  })

  it('rejects (fail closed) when no wasm-lookup function is provided', async () => {
    const tx = depositTx(MESSENGER, 'deposit_for_burn', [{ __addr: 'CAGENTV3' }])
    await expect(
      assertVaultDeposit(tx, VAULT, sdkAddr, '', '', '', [], [AGENT_HASH_V3], null, MESSENGER)
    ).rejects.toThrow(RelayError)
  })

  it('rejects (fail closed) when the wasm lookup itself throws', async () => {
    const tx = depositTx(MESSENGER, 'deposit_for_burn', [{ __addr: 'CAGENTV3' }])
    const getWasmHash = async () => {
      throw new Error('rpc down')
    }
    await expect(
      assertVaultDeposit(
        tx,
        VAULT,
        sdkAddr,
        '',
        '',
        '',
        [],
        [AGENT_HASH_V3],
        getWasmHash,
        MESSENGER
      )
    ).rejects.toThrow(RelayError)
  })

  it('rejects deposit_for_burn from a wasm hash outside the pinned list, even with the messenger configured', async () => {
    const tx = depositTx(MESSENGER, 'deposit_for_burn', [{ __addr: 'CV1AGENT' }])
    const getWasmHash = async () => 'cafebabe'.repeat(8)
    await expect(
      assertVaultDeposit(
        tx,
        VAULT,
        sdkAddr,
        '',
        '',
        '',
        [],
        ['cafed00d'.repeat(8)],
        getWasmHash,
        MESSENGER
      )
    ).rejects.toThrow(RelayError)
  })
})
