import { describe, test, expect, vi } from 'vitest'
import { sharesForAmount, ensureExitSigner, partialWithdraw } from './partialWithdraw.js'

const PPS_SCALE = 10_000_000n
const ownerBoundary = (owner = 'GOWNER', epoch = 1) => {
  const activeAccount = Object.freeze({
    version: 1,
    kind: owner.startsWith('C') ? 'C' : 'G',
    address: owner,
    networkPassphrase: 'Test SDF Network ; September 2015',
    connectorId: owner.startsWith('C') ? 'vf-wallet' : 'freighter',
    epoch,
  })
  return { activeAccount, getCurrentActiveAccount: () => activeAccount }
}

describe('sharesForAmount', () => {
  test('pps 1.0: 1:1, exact', () => {
    expect(sharesForAmount(20_000_000n, PPS_SCALE, 100_000_000n)).toBe(20_000_000n)
  })
  test('rounds shares UP so the user gets at least the requested amount', () => {
    // pps = 1.5 → 2000 units needs ceil(2000/1.5) = 1334 shares (1333 would under-deliver)
    expect(sharesForAmount(2000n, 15_000_000n, 1_000_000n)).toBe(1334n)
  })
  test('clamps to the agent balance', () => {
    expect(sharesForAmount(99_999_999n, PPS_SCALE, 500n)).toBe(500n)
  })
  test('rejects non-positive amounts', () => {
    expect(() => sharesForAmount(0n, PPS_SCALE, 500n)).toThrow()
  })
})

describe('ensureExitSigner', () => {
  test('returns the stored key without registering again', async () => {
    const deps = {
      loadExitKey: () => ({ publicKey: 'GPUB', secret: 'SSEC' }),
      registerExitSigner: vi.fn(),
    }
    const key = await ensureExitSigner({
      owner: 'GOWNER',
      agentAddress: 'CAGENT',
      ...ownerBoundary(),
      deps,
    })
    expect(key.publicKey).toBe('GPUB')
    expect(deps.registerExitSigner).not.toHaveBeenCalled()
  })
  test('generates, registers on-chain, and saves ONLY after SUCCESS', async () => {
    const calls = []
    const deps = {
      loadExitKey: () => null,
      generateExitKey: async () => ({ publicKey: 'GNEW', secret: 'SNEW' }),
      registerExitSigner: async () => (calls.push('register'), { status: 'SUCCESS' }),
      saveExitKey: ({ publicKey }) => calls.push(`save:${publicKey}`),
    }
    const key = await ensureExitSigner({
      owner: 'GOWNER',
      agentAddress: 'CAGENT',
      ...ownerBoundary(),
      deps,
    })
    expect(key.publicKey).toBe('GNEW')
    expect(calls).toEqual(['register', 'save:GNEW'])
  })
  test('does NOT save when registration fails', async () => {
    const save = vi.fn()
    const deps = {
      loadExitKey: () => null,
      generateExitKey: async () => ({ publicKey: 'GNEW', secret: 'SNEW' }),
      registerExitSigner: async () => ({ status: 'FAILED' }),
      saveExitKey: save,
    }
    await expect(
      ensureExitSigner({ owner: 'G', agentAddress: 'C', ...ownerBoundary('G'), deps })
    ).rejects.toThrow()
    expect(save).not.toHaveBeenCalled()
  })

  // Pocket Crew "My money" Task 9: the exit key is a MANUAL partial-exit key (see
  // wallet/exitKey.js's v2 owner-scoped namespace) — load/save must be threaded BOTH the owner and
  // the agent, never the agent alone, so an account switch in the same browser cannot hand a
  // different owner's flow a stale signer keypair.
  test('threads {owner, agent} to loadExitKey and {owner, agent, publicKey, secret} to saveExitKey', async () => {
    const loadExitKey = vi.fn(async () => null)
    const saveExitKey = vi.fn()
    const deps = {
      loadExitKey,
      generateExitKey: async () => ({ publicKey: 'GNEW', secret: 'SNEW' }),
      registerExitSigner: async () => ({ status: 'SUCCESS' }),
      saveExitKey,
    }
    await ensureExitSigner({
      owner: 'GOWNER',
      agentAddress: 'CAGENT',
      ...ownerBoundary(),
      deps,
    })
    expect(loadExitKey).toHaveBeenCalledWith({ owner: 'GOWNER', agent: 'CAGENT' })
    expect(saveExitKey).toHaveBeenCalledWith({
      owner: 'GOWNER',
      agent: 'CAGENT',
      publicKey: 'GNEW',
      secret: 'SNEW',
    })
  })

  test('forwards activeAccount/getRelayerAddress/kit to registerExitSigner (owner-model routing)', async () => {
    const getRelayerAddress = vi.fn()
    const kit = {}
    const { activeAccount, getCurrentActiveAccount } = ownerBoundary('CAGENTOWNER')
    const registerExitSigner = vi.fn(async () => ({ status: 'SUCCESS' }))
    const deps = {
      loadExitKey: () => null,
      generateExitKey: async () => ({ publicKey: 'GNEW', secret: 'SNEW' }),
      registerExitSigner,
      saveExitKey: vi.fn(),
    }
    await ensureExitSigner({
      owner: 'CAGENTOWNER',
      agentAddress: 'CAGENT',
      activeAccount,
      getCurrentActiveAccount,
      getRelayerAddress,
      kit,
      deps,
    })
    expect(registerExitSigner).toHaveBeenCalledWith(
      expect.objectContaining({
        activeAccount,
        getCurrentActiveAccount,
        getRelayerAddress,
        kit,
      })
    )
  })

  test('fails closed when the browser owner capability is missing', async () => {
    const registerExitSigner = vi.fn(async () => ({ status: 'SUCCESS' }))
    const deps = {
      loadExitKey: () => null,
      generateExitKey: async () => ({ publicKey: 'GNEW', secret: 'SNEW' }),
      registerExitSigner,
      saveExitKey: vi.fn(),
    }
    await expect(
      ensureExitSigner({ owner: 'GOWNER', agentAddress: 'CAGENT', deps })
    ).rejects.toMatchObject({ code: 'ACTIVE_ACCOUNT_CHANGED' })
    expect(registerExitSigner).not.toHaveBeenCalled()
  })

  test('does not persist an exit key when the account changes during registration', async () => {
    const captured = ownerBoundary()
    let current = captured.activeAccount
    const saveExitKey = vi.fn()
    const deps = {
      loadExitKey: async () => null,
      generateExitKey: async () => ({ publicKey: 'GNEW', secret: 'SNEW' }),
      registerExitSigner: async () => {
        current = ownerBoundary('GOTHER', 2).activeAccount
        return { status: 'SUCCESS' }
      },
      saveExitKey,
    }
    await expect(
      ensureExitSigner({
        owner: 'GOWNER',
        agentAddress: 'CAGENT',
        activeAccount: captured.activeAccount,
        getCurrentActiveAccount: () => current,
        deps,
      })
    ).rejects.toMatchObject({ code: 'ACTIVE_ACCOUNT_CHANGED' })
    expect(saveExitKey).not.toHaveBeenCalled()
  })
})

describe('partialWithdraw', () => {
  const baseDeps = () => {
    const submitted = []
    return {
      submitted,
      getRelayerAddress: async () => 'GRELAYER',
      readVaultShares: async () => 100_000_000n, // 10 USDC of shares
      readPricePerShare: async () => PPS_SCALE, // 1.0
      // post-redeem agent token balance = what the transfer leg must move
      readTokenBalance: async () => 20_000_000n,
      // ponytail: brief's literal fixture secret has an invalid Stellar checksum (typo) and
      // Keypair.fromSecret rejects it — substituted a valid random ed25519 seed; no test
      // asserts on the derived public key, so this is inert everywhere else.
      loadExitKey: () => ({
        publicKey: 'GPUB',
        secret: 'SANNPHPONDNLIZ7DWOSNPUSVWJF7ILLMVQWGURVNYXHI6J6QFGXLNSQM',
      }),
      buildAgentAuthedInvoke: async ({ method }) => ({ xdr: `XDR:${method}` }),
      submitViaRelay: async ({ xdr }) => (
        submitted.push(xdr),
        { hash: `H:${xdr}`, status: 'SUCCESS' }
      ),
      waitForTx: async () => ({ status: 'SUCCESS' }),
    }
  }
  test('happy path: redeem leg then transfer leg of the ACTUAL balance', async () => {
    const deps = baseDeps()
    const out = await partialWithdraw({
      owner: 'GOWNER',
      agentAddress: 'CAGENT',
      amountUnits: 20_000_000n,
      ...ownerBoundary(),
      deps,
    })
    expect(deps.submitted).toEqual(['XDR:redeem', 'XDR:transfer'])
    expect(out.redeemed).toBe(20_000_000n)
    expect(out.redeemHash).toBe('H:XDR:redeem')
    expect(out.transferHash).toBe('H:XDR:transfer')
  })
  test('reads the exit key from the owner-scoped v2 namespace, not the agent alone', async () => {
    const deps = baseDeps()
    const loadExitKey = vi.fn(deps.loadExitKey)
    await partialWithdraw({
      owner: 'GOWNER',
      agentAddress: 'CAGENT',
      amountUnits: 20_000_000n,
      ...ownerBoundary(),
      deps: { ...deps, loadExitKey },
    })
    expect(loadExitKey).toHaveBeenCalledWith({ owner: 'GOWNER', agent: 'CAGENT' })
  })
  test('no relayer → throws, nothing submitted', async () => {
    const deps = { ...baseDeps(), getRelayerAddress: async () => null }
    await expect(
      partialWithdraw({
        owner: 'G',
        agentAddress: 'C',
        amountUnits: 1n,
        ...ownerBoundary('G'),
        deps,
      })
    ).rejects.toThrow(/relay/i)
    expect(deps.submitted).toEqual([])
  })
  test('amount above the agent max → throws before any tx', async () => {
    const deps = baseDeps()
    await expect(
      partialWithdraw({
        owner: 'G',
        agentAddress: 'C',
        amountUnits: 999_000_000n,
        ...ownerBoundary('G'),
        deps,
      })
    ).rejects.toThrow(/max/i)
    expect(deps.submitted).toEqual([])
  })
  test('redeem confirmed but transfer leg fails → error names the stranded amount', async () => {
    const deps = baseDeps()
    deps.submitViaRelay = async ({ xdr }) => {
      if (xdr === 'XDR:transfer') throw new Error('relay refused')
      deps.submitted.push(xdr)
      return { hash: 'H1', status: 'SUCCESS' }
    }
    await expect(
      partialWithdraw({
        owner: 'G',
        agentAddress: 'C',
        amountUnits: 20_000_000n,
        ...ownerBoundary('G'),
        deps,
      })
    ).rejects.toThrow(/agent/i)
  })
  test('vault/token overrides propagate to the balance reads and both invokes', async () => {
    const deps = baseDeps()
    const sharesOpts = []
    const balanceOpts = []
    const invokedContracts = []
    deps.readVaultShares = async (addr, opts) => (sharesOpts.push(opts), 100_000_000n)
    deps.readTokenBalance = async (addr, opts) => (balanceOpts.push(opts), 20_000_000n)
    deps.buildAgentAuthedInvoke = async ({ contract, method }) => (
      invokedContracts.push(contract),
      { xdr: `XDR:${method}` }
    )
    await partialWithdraw({
      owner: 'GOWNER',
      agentAddress: 'CAGENT',
      amountUnits: 20_000_000n,
      vault: 'CVAULT2',
      token: 'CTOKEN2',
      ...ownerBoundary(),
      deps,
    })
    expect(sharesOpts[0]).toMatchObject({ vault: 'CVAULT2' })
    expect(balanceOpts[0]).toMatchObject({ token: 'CTOKEN2' })
    expect(invokedContracts).toEqual(['CVAULT2', 'CTOKEN2'])
  })

  test('rejects an account transition after building and before relaying a session-key leg', async () => {
    const deps = baseDeps()
    const captured = ownerBoundary()
    let current = captured.activeAccount
    const submitViaRelay = vi.fn(deps.submitViaRelay)
    deps.buildAgentAuthedInvoke = async ({ method }) => {
      current = ownerBoundary('GOTHER', 2).activeAccount
      return { xdr: `XDR:${method}` }
    }
    deps.submitViaRelay = submitViaRelay

    await expect(
      partialWithdraw({
        owner: 'GOWNER',
        agentAddress: 'CAGENT',
        amountUnits: 20_000_000n,
        activeAccount: captured.activeAccount,
        getCurrentActiveAccount: () => current,
        deps,
      })
    ).rejects.toMatchObject({ code: 'ACTIVE_ACCOUNT_CHANGED' })
    expect(submitViaRelay).not.toHaveBeenCalled()
  })

  test('classifies a transition after redeem dispatch as unknown custody, not a clean cancellation', async () => {
    const deps = baseDeps()
    const captured = ownerBoundary()
    let current = captured.activeAccount
    deps.submitViaRelay = vi.fn(async ({ xdr }) => {
      deps.submitted.push(xdr)
      current = ownerBoundary('GOTHER', 2).activeAccount
      return { hash: `H:${xdr}`, status: 'SUCCESS' }
    })

    await expect(
      partialWithdraw({
        owner: 'GOWNER',
        agentAddress: 'CAGENT',
        amountUnits: 20_000_000n,
        activeAccount: captured.activeAccount,
        getCurrentActiveAccount: () => current,
        deps,
      })
    ).rejects.toMatchObject({
      code: 'VF_SUBMISSION_UNKNOWN',
      submission: 'unknown',
      stage: 'redeem',
      custody: { location: 'unknown', confirmed: false },
    })
    expect(deps.submitted).toEqual(['XDR:redeem'])
  })
})
