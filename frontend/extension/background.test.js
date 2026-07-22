import { describe, it, expect, vi } from 'vitest'
import {
  handleMessage,
  handleProviderMessage,
  handleWindowRemoved,
  handleActiveAccountChanged,
  shouldReactToStorageChange,
  isInternalSender,
  resolveWalletAddress,
} from './background.js'
import { resolveActiveAccount } from '../src/wallet/activeAccount.js'
import {
  CONSENT_KEY,
  consentId,
  createRequestSnapshot,
  validateRequestSnapshot,
} from '../src/wallet/consentStore.js'

describe('background router — action ceremony', () => {
  it('opens ceremony.html with the action and stashes params in session storage', async () => {
    const tabs = { create: vi.fn(async () => ({ id: 7 })) }
    const session = { set: vi.fn(async () => {}) }
    const pending = new Map()
    await handleMessage(
      { type: 'SIGN_REQUEST', action: 'deposit', params: { contractId: 'CACCT', amount: '1.5' } },
      { tabs, storageSession: session, pending },
      vi.fn()
    )
    expect(tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('action=deposit'), active: true })
    )
    expect(session.set).toHaveBeenCalledWith(
      expect.objectContaining({ ['vf_params_7']: { contractId: 'CACCT', amount: '1.5' } })
    )
  })

  it('persists CEREMONY_RESULT to session and forwards it to the popup', async () => {
    const session = { set: vi.fn(async () => {}) }
    const runtime = { sendMessage: vi.fn() }
    const pending = new Map()
    await handleMessage(
      {
        type: 'CEREMONY_RESULT',
        action: 'deposit',
        ok: true,
        hash: 'H',
        status: 'SUCCESS',
        sharesBefore: '0',
        sharesAfter: '5',
      },
      { storageSession: session, runtime, pending },
      vi.fn()
    )
    expect(session.set).toHaveBeenCalledWith(
      expect.objectContaining({ vf_last_result: expect.objectContaining({ ok: true, hash: 'H' }) })
    )
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SIGN_RESULT', ok: true, hash: 'H' })
    )
  })

  it('routes CEREMONY_RESULT reply to pending tab via reply callback', async () => {
    const session = { set: vi.fn(async () => {}) }
    const replyFn = vi.fn()
    const pending = new Map()
    pending.set(42, replyFn)
    await handleMessage(
      {
        type: 'CEREMONY_RESULT',
        tabId: 42,
        action: 'deposit',
        ok: true,
        hash: 'H',
        status: 'SUCCESS',
        sharesBefore: '0',
        sharesAfter: '5',
      },
      { storageSession: session, pending },
      vi.fn()
    )
    expect(replyFn).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SIGN_RESULT', ok: true, hash: 'H' })
    )
    expect(pending.has(42)).toBe(false)
  })

  it('passes through result fields for the generic wallet-kit actions (connect/signTransaction/signAuthEntry) without a fixed allow-list', async () => {
    const session = { set: vi.fn(async () => {}) }
    const replyFn = vi.fn()
    const pending = new Map()
    pending.set(7, replyFn)
    await handleMessage(
      {
        type: 'CEREMONY_RESULT',
        tabId: 7,
        action: 'signTransaction',
        ok: true,
        signedTxXdr: 'SXDR',
        address: 'CACCT',
      },
      { storageSession: session, pending },
      vi.fn()
    )
    expect(replyFn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SIGN_RESULT',
        ok: true,
        signedTxXdr: 'SXDR',
        address: 'CACCT',
      })
    )
    // tabId is routing metadata only — never leaks into the result payload the caller sees.
    expect(replyFn.mock.calls[0][0]).not.toHaveProperty('tabId')
  })
})

function fakeEnv({ allowlist = {}, address = null, classic = {}, now } = {}) {
  const local = {
    vf_allowlist: allowlist,
    vf_wallet_contract: address,
    vf_classic_wallets: classic,
  }
  const session = {}
  return {
    env: {
      storageLocal: {
        get: vi.fn(async (k) => ({ [k]: local[k] })),
        set: vi.fn(async (obj) => Object.assign(local, obj)),
        remove: vi.fn(async (k) => delete local[k]),
      },
      storageSession: {
        get: vi.fn(async (k) => ({ [k]: session[k] })),
        set: vi.fn(async (obj) => Object.assign(session, obj)),
        remove: vi.fn(async (k) => delete session[k]),
      },
      windows: { create: vi.fn(async () => ({ id: 900 })) },
      uuid: vi.fn(() => 'rid-1'),
      dappPending: new Map(),
      queueHolder: { p: Promise.resolve() },
      ...(now ? { now } : {}),
    },
    local,
    session,
  }
}
const SENDER = { origin: 'https://vibing-farmer.pages.dev', tab: { id: 3 } }
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('background router — PROVIDER_REQUEST (dapp path)', () => {
  it('answers isConnected silently: false for an unknown origin, no window', async () => {
    const { env } = fakeEnv({ address: 'CACCT' })
    const reply = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'isConnected' },
      SENDER,
      env,
      reply
    )
    expect(reply).toHaveBeenCalledWith({ ok: true, connected: false, address: null })
    expect(env.windows.create).not.toHaveBeenCalled()
  })

  it('answers getAddress silently for an allowlisted origin with a stored wallet', async () => {
    const { env } = fakeEnv({
      allowlist: { 'https://vibing-farmer.pages.dev': { addedAt: 1 } },
      address: 'CACCT',
    })
    const reply = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'getAddress' },
      SENDER,
      env,
      reply
    )
    expect(reply).toHaveBeenCalledWith({ ok: true, address: 'CACCT' })
    expect(env.windows.create).not.toHaveBeenCalled()
  })

  it('isConnected for an allowlisted origin with ONLY a classic wallet reports connected via the classic address', async () => {
    const { env } = fakeEnv({
      allowlist: { 'https://vibing-farmer.pages.dev': { addedAt: 1 } },
      classic: { G1: { publicKey: 'G1', createdAt: 1 } },
    })
    const reply = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'isConnected' },
      SENDER,
      env,
      reply
    )
    expect(reply).toHaveBeenCalledWith({ ok: true, connected: true, address: 'G1' })
  })

  it('answers getAddress silently for an allowlisted origin with ONLY a classic wallet', async () => {
    const { env } = fakeEnv({
      allowlist: { 'https://vibing-farmer.pages.dev': { addedAt: 1 } },
      classic: { G1: { publicKey: 'G1', createdAt: 1 } },
    })
    const reply = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'getAddress' },
      SENDER,
      env,
      reply
    )
    expect(reply).toHaveBeenCalledWith({ ok: true, address: 'G1' })
  })

  it('rejects a request without a verifiable http(s) sender origin', async () => {
    const { env } = fakeEnv({ address: 'CACCT' })
    const reply = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'getAddress' },
      { origin: null },
      env,
      reply
    )
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: -3 }))
  })

  it('opens an approval popup for getAddress from a new origin and stashes vf_req_<rid>', async () => {
    const { env, session } = fakeEnv({ address: 'CACCT' })
    const reply = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'getAddress', params: {} },
      SENDER,
      env,
      reply
    )
    await flush()
    expect(env.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('rid=rid-1'), type: 'popup' })
    )
    expect(session['vf_req_rid-1']).toMatchObject({
      version: 1,
      rid: 'rid-1',
      method: 'getAddress',
      params: {},
      requester: {
        origin: 'https://vibing-farmer.pages.dev',
        tabId: 3,
        frameId: null,
        documentId: null,
      },
      account: {
        id: 'stellar-testnet:CACCT',
        address: 'CACCT',
        kind: 'C',
        signer: 'passkey-secp256r1',
      },
    })
    expect(session['vf_req_rid-1'].expiresAt).toBeGreaterThan(session['vf_req_rid-1'].createdAt)
    expect(reply).not.toHaveBeenCalled() // pending until the ceremony answers
  })

  it('CEREMONY_RESULT with rid resolves the pending dapp request and grants origin+account consent', async () => {
    const { env, local, session } = fakeEnv({ address: 'CACCT' })
    const reply = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'getAddress' },
      SENDER,
      env,
      reply
    )
    await flush()
    await handleMessage(
      { type: 'CEREMONY_RESULT', rid: 'rid-1', ok: true, address: 'CACCT' },
      env,
      vi.fn()
    )
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: true, address: 'CACCT' }))
    const id = consentId('https://vibing-farmer.pages.dev', 'stellar-testnet:CACCT')
    expect(local[CONSENT_KEY][id]).toMatchObject({
      version: 2,
      origin: 'https://vibing-farmer.pages.dev',
      accountId: 'stellar-testnet:CACCT',
      accountAddress: 'CACCT',
      accountKind: 'C',
    })
    expect(env.dappPending.size).toBe(0)
    // consumed once — the stashed snapshot cannot be replayed to grant consent again
    expect(session['vf_req_rid-1']).toBeUndefined()
  })

  it('a replayed CEREMONY_RESULT for an already-settled rid is a silent no-op (never double-grants)', async () => {
    const { env, local } = fakeEnv({ address: 'CACCT' })
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'getAddress' },
      SENDER,
      env,
      vi.fn()
    )
    await flush()
    await handleMessage(
      { type: 'CEREMONY_RESULT', rid: 'rid-1', ok: true, address: 'CACCT' },
      env,
      vi.fn()
    )
    const id = consentId('https://vibing-farmer.pages.dev', 'stellar-testnet:CACCT')
    const grantedAtFirst = local[CONSENT_KEY][id].grantedAt
    const replayReply = vi.fn()
    await handleMessage(
      { type: 'CEREMONY_RESULT', rid: 'rid-1', ok: true, address: 'CACCT' },
      env,
      replayReply
    )
    expect(replayReply).not.toHaveBeenCalled() // settleDappRequest finds no pending entry
    expect(local[CONSENT_KEY][id].grantedAt).toBe(grantedAtFirst)
  })

  it('a CEREMONY_RESULT for an account that changed since the snapshot was taken fails closed (-3), grants no consent', async () => {
    const { env, local } = fakeEnv({ address: 'CACCT' })
    const reply = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'getAddress' },
      SENDER,
      env,
      reply
    )
    await flush()
    // Active account switches to a different passkey contract between snapshot and result.
    local.vf_wallet_contract = 'COTHER'
    await handleMessage(
      { type: 'CEREMONY_RESULT', rid: 'rid-1', ok: true, address: 'CACCT' },
      env,
      vi.fn()
    )
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: -3 }))
    expect(local[CONSENT_KEY]).toBeUndefined()
  })

  it('a CEREMONY_RESULT arriving after its snapshot expired fails closed (-3), grants no consent', async () => {
    let clock = 1000
    const { env, local } = fakeEnv({ address: 'CACCT', now: () => clock })
    const reply = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'getAddress' },
      SENDER,
      env,
      reply
    )
    await flush()
    clock += 5 * 60 * 1000 + 1 // past the five-minute TTL
    await handleMessage(
      { type: 'CEREMONY_RESULT', rid: 'rid-1', ok: true, address: 'CACCT' },
      env,
      vi.fn()
    )
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, code: -3, error: expect.stringMatching(/expired/i) })
    )
    expect(local[CONSENT_KEY]).toBeUndefined()
  })

  it('closing the approval window rejects the pending request with SEP-43 -4', async () => {
    const { env } = fakeEnv({ address: 'CACCT' })
    const reply = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'signTransaction', params: { xdr: 'X' } },
      SENDER,
      env,
      reply
    )
    await flush()
    handleWindowRemoved(900, env)
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, code: -4, error: 'User rejected the request' })
    )
  })

  it('serializes approval windows: the second opens only after the first settles', async () => {
    const { env } = fakeEnv({ address: 'CACCT' })
    env.uuid = vi.fn().mockReturnValueOnce('rid-1').mockReturnValueOnce('rid-2')
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'getAddress' },
      SENDER,
      env,
      vi.fn()
    )
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'signAuthEntry', params: { authEntry: 'E' } },
      SENDER,
      env,
      vi.fn()
    )
    await flush()
    expect(env.windows.create).toHaveBeenCalledTimes(1)
    await handleMessage(
      { type: 'CEREMONY_RESULT', rid: 'rid-1', ok: true, address: 'CACCT' },
      env,
      vi.fn()
    )
    await flush()
    expect(env.windows.create).toHaveBeenCalledTimes(2)
  })

  it('a failed windows.create settles the request with -1 and does not wedge the queue', async () => {
    const { env } = fakeEnv({ address: 'CACCT' })
    env.uuid = vi.fn().mockReturnValueOnce('rid-1').mockReturnValueOnce('rid-2')
    env.windows.create = vi
      .fn()
      .mockRejectedValueOnce(new Error('popup blocked'))
      .mockResolvedValueOnce({ id: 901 })
    const reply1 = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'getAddress' },
      SENDER,
      env,
      reply1
    )
    await flush()
    expect(reply1).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: -1 }))
    const reply2 = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'getAddress' },
      SENDER,
      env,
      reply2
    )
    await flush()
    expect(env.windows.create).toHaveBeenCalledTimes(2)
  })
})

describe('resolveWalletAddress', () => {
  it('fails closed (null) when both a passkey and a classic wallet exist with no active-account selection — never silently prefers the passkey', async () => {
    const { env } = fakeEnv({
      address: 'CPASSKEY',
      classic: { G1: { publicKey: 'G1', createdAt: 1 } },
    })
    await expect(resolveWalletAddress(env.storageLocal)).resolves.toBeNull()
  })

  it('honors an explicit vf_active_account_v1 selection even when the other kind also exists', async () => {
    const { env, local } = fakeEnv({
      address: 'CPASSKEY',
      classic: { G1: { publicKey: 'G1', createdAt: 1 } },
    })
    local.vf_active_account_v1 = {
      version: 1,
      id: 'stellar-testnet:G1',
      network: 'stellar-testnet',
      address: 'G1',
      kind: 'G',
      signer: 'classic-ed25519',
      selectedAt: 1,
    }
    await expect(resolveWalletAddress(env.storageLocal)).resolves.toBe('G1')
  })

  it('ignores a stale vf_active_account_v1 selection pointing at a removed account (fails closed, falls back to the remaining wallet)', async () => {
    const { env, local } = fakeEnv({
      classic: { G1: { publicKey: 'G1', createdAt: 1 } },
    })
    local.vf_active_account_v1 = {
      version: 1,
      id: 'stellar-testnet:CGONE',
      network: 'stellar-testnet',
      address: 'CGONE',
      kind: 'C',
      signer: 'passkey-secp256r1',
      selectedAt: 1,
    }
    await expect(resolveWalletAddress(env.storageLocal)).resolves.toBe('G1')
  })

  it('falls back to the oldest classic wallet by createdAt when there is no passkey', async () => {
    const { env } = fakeEnv({
      classic: {
        G2: { publicKey: 'G2', createdAt: 200 },
        G1: { publicKey: 'G1', createdAt: 100 },
      },
    })
    await expect(resolveWalletAddress(env.storageLocal)).resolves.toBe('G1')
  })

  it('returns null when neither a passkey nor a classic wallet exists', async () => {
    const { env } = fakeEnv({})
    await expect(resolveWalletAddress(env.storageLocal)).resolves.toBeNull()
  })
})

// Drift guard: background.js necessarily duplicates activeAccount.js's persisted-selection
// validation (MV3 service workers can't `import` — see background.js's own docstring), so run the
// SAME matrix fixtures through both resolvers and assert identical outcomes per case. A corrupt
// record (wrong version/network/signer, but a matching id+kind) must fail closed in BOTH — never
// accepted by one context and rejected by the other.
describe('resolveWalletAddress stays in lockstep with resolveActiveAccount (drift guard)', () => {
  const G1 = 'G1'
  const validId = 'stellar-testnet:G1'
  const validPersisted = {
    version: 1,
    id: validId,
    network: 'stellar-testnet',
    address: G1,
    kind: 'G',
    signer: 'classic-ed25519',
    selectedAt: 1,
  }

  const cases = {
    'no persisted record': null,
    'valid persisted G': validPersisted,
    'wrong version': { ...validPersisted, version: 2 },
    'wrong network': { ...validPersisted, network: 'stellar-pubnet' },
    'corrupt signer (id + kind still match)': { ...validPersisted, signer: 'passkey-secp256r1' },
    'wrong kind for this id': { ...validPersisted, kind: 'C' },
    'wrong address for this id': { ...validPersisted, address: 'GSOMETHINGELSE' },
    'missing signer field': { ...validPersisted, signer: undefined },
  }

  for (const [label, persisted] of Object.entries(cases)) {
    it(`${label}: background and the module of record agree`, async () => {
      const { env, local } = fakeEnv({
        address: 'CPASSKEY',
        classic: { [G1]: { publicKey: G1, createdAt: 1 } },
      })
      if (persisted) local.vf_active_account_v1 = persisted

      const bgAddress = await resolveWalletAddress(env.storageLocal)
      const moduleResult = await resolveActiveAccount({ storageLocal: env.storageLocal })
      const moduleAddress = moduleResult.status === 'ready' ? moduleResult.account.address : null

      expect(bgAddress).toBe(moduleAddress)
    })
  }
})

// Drift guard for the consent/snapshot mirror — same convention as resolveWalletAddress's own
// drift-guard suite above. validateRequestSnapshot is pure/sync so it's cheap to run the exact
// same fixtures through background's private copy (exercised indirectly via handleProviderMessage
// + handleMessage, both exported) and the module of record.
describe('background consent/snapshot logic stays in lockstep with src/wallet/consentStore.js (drift guard)', () => {
  const ACCOUNT_C = {
    id: 'stellar-testnet:CACCT',
    address: 'CACCT',
    kind: 'C',
    signer: 'passkey-secp256r1',
  }
  const ACCOUNT_G = {
    id: 'stellar-testnet:G1',
    address: 'G1',
    kind: 'G',
    signer: 'classic-ed25519',
  }
  const SNAP_SENDER = { origin: 'https://vibing-farmer.pages.dev', tab: { id: 3 } }

  function moduleSnapshot(overrides = {}) {
    return createRequestSnapshot({
      rid: 'rid-1',
      method: 'getAddress',
      params: {},
      sender: SNAP_SENDER,
      account: ACCOUNT_C,
      now: 1000,
      ...overrides,
    })
  }

  // Only cases background.js's exported CEREMONY_RESULT{rid} path can actually exercise:
  // that call site deliberately validates WITHOUT a `sender` (the incoming message's sender is
  // approve.js's own internal page, not the dapp's — see background.js's docstring on that call),
  // so origin/tab/frame/document mismatches aren't comparable here; they're covered directly by
  // consentStore.test.js's own matrix.
  const cases = {
    'fresh, matching account': { activeAccount: ACCOUNT_C, now: 1001 },
    'expired (past TTL)': { activeAccount: ACCOUNT_C, now: 10_000_000 },
    'account switched': { activeAccount: ACCOUNT_G, now: 1001 },
    'no active account': { activeAccount: null, now: 1001 },
  }

  for (const [label, ctx] of Object.entries(cases)) {
    it(`${label}: background's validation and the module of record agree`, async () => {
      const snapshot = moduleSnapshot()
      // Drive background's private validateRequestSnapshotLocal indirectly through the exported
      // CEREMONY_RESULT{rid} path: seed the exact snapshot, seed storage so resolveActiveAccountLocal
      // resolves to ctx.activeAccount (or nothing), then compare the two ok/code outcomes.
      const { env, session, local } = fakeEnv({ now: () => ctx.now })
      session[`vf_req_rid-1`] = snapshot
      if (ctx.activeAccount?.kind === 'C') local.vf_wallet_contract = ctx.activeAccount.address
      if (ctx.activeAccount?.kind === 'G') {
        local.vf_classic_wallets = {
          [ctx.activeAccount.address]: { publicKey: ctx.activeAccount.address, createdAt: 1 },
        }
      }
      local.vf_allowlist_migration_v1 = { at: 0, migrated: 0, skipped: 0 } // no legacy migration noise

      const reply = vi.fn()
      await handleMessage(
        { type: 'CEREMONY_RESULT', rid: 'rid-1', ok: true, address: ACCOUNT_C.address },
        env,
        reply
      )
      const bgOk = Boolean(local[CONSENT_KEY]?.[consentId(snapshot.requester.origin, ACCOUNT_C.id)])

      const moduleResult = validateRequestSnapshot(snapshot, ctx)

      expect(bgOk).toBe(moduleResult.ok)
    })
  }
})

describe('SEP-43 account-switch cancellation (handleActiveAccountChanged)', () => {
  it('cancels a queued/open dapp request whose snapshot account no longer matches, with code -3, and closes its window', async () => {
    const { env } = fakeEnv({ address: 'CACCT' })
    const reply = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'signTransaction', params: { xdr: 'X' } },
      SENDER,
      env,
      reply
    )
    await flush()
    env.windows.remove = vi.fn(async () => {})
    env.tabs = { query: vi.fn(async () => []), sendMessage: vi.fn() }
    // account switches away from CACCT
    env.storageLocal.set({ vf_wallet_contract: 'CNEW' })

    await handleActiveAccountChanged(env)

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        code: -3,
        error: expect.stringMatching(/account changed/i),
      })
    )
    expect(env.windows.remove).toHaveBeenCalledWith(900)
    expect(env.dappPending.size).toBe(0)
  })

  it('leaves a request matching the new active account untouched', async () => {
    const { env } = fakeEnv({ address: 'CACCT' })
    const reply = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'signTransaction', params: { xdr: 'X' } },
      SENDER,
      env,
      reply
    )
    await flush()
    env.windows.remove = vi.fn(async () => {})
    env.tabs = { query: vi.fn(async () => []), sendMessage: vi.fn() }

    await handleActiveAccountChanged(env) // no storage change — same account still active

    expect(reply).not.toHaveBeenCalled()
    expect(env.windows.remove).not.toHaveBeenCalled()
    expect(env.dappPending.size).toBe(1)
  })

  it('cancels a still-queued request that never got a window (windowId still null) without calling windows.remove', async () => {
    const { env } = fakeEnv({ address: 'CACCT' })
    env.uuid = vi.fn().mockReturnValueOnce('rid-1').mockReturnValueOnce('rid-2')
    const reply1 = vi.fn()
    const reply2 = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'getAddress' },
      SENDER,
      env,
      reply1
    )
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'signAuthEntry', params: { authEntry: 'E' } },
      SENDER,
      env,
      reply2
    )
    await flush()
    // rid-1's approval window opened; rid-2 is still queued behind it (queue.p), windowId null.
    expect(env.dappPending.get('rid-2').windowId).toBeNull()
    env.windows.remove = vi.fn(async () => {})
    env.tabs = { query: vi.fn(async () => []), sendMessage: vi.fn() }
    env.storageLocal.set({ vf_wallet_contract: 'CNEW' })

    await handleActiveAccountChanged(env)

    expect(reply2).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: -3 }))
    // rid-1 (open, window 900) is also cancelled and does get its window closed; rid-2 (still
    // queued, windowId null) must never trigger a windows.remove(null/undefined) call for itself.
    expect(env.windows.remove).toHaveBeenCalledTimes(1)
    expect(env.windows.remove).toHaveBeenCalledWith(900)
  })

  // The broadcast reaches EVERY open tab, not just consented origins — carrying the real address
  // would let any site the user never connected to learn it on every account switch (cross-site
  // identity linking), which is exactly what this task's origin+account consent binding exists to
  // prevent. address is always null; a page that wants the real one calls getAddress(), which
  // stays consent-gated (background.js's readConsentLocal).
  it('broadcasts VF_ACCOUNT_CHANGED with address always null, even to a non-consented origin, so it never leaks the real address', async () => {
    const { env } = fakeEnv({ address: 'CACCT' })
    env.tabs = {
      query: vi.fn(async () => [{ id: 11 }, { id: 12 }]),
      sendMessage: vi.fn(() => ({ catch: () => {} })),
    }
    await handleActiveAccountChanged(env)
    expect(env.tabs.sendMessage).toHaveBeenCalledWith(11, {
      type: 'VF_ACCOUNT_CHANGED',
      address: null,
    })
    expect(env.tabs.sendMessage).toHaveBeenCalledWith(12, {
      type: 'VF_ACCOUNT_CHANGED',
      address: null,
    })
  })

  it('still broadcasts (address null) when the account becomes ambiguous/empty', async () => {
    const { env } = fakeEnv({
      address: 'CACCT',
      classic: { G1: { publicKey: 'G1', createdAt: 1 } },
    })
    env.tabs = {
      query: vi.fn(async () => [{ id: 11 }]),
      sendMessage: vi.fn(() => ({ catch: () => {} })),
    }
    await handleActiveAccountChanged(env)
    expect(env.tabs.sendMessage).toHaveBeenCalledWith(11, {
      type: 'VF_ACCOUNT_CHANGED',
      address: null,
    })
  })
})

describe('shouldReactToStorageChange', () => {
  it('reacts to the explicit active-account selection key', () => {
    expect(shouldReactToStorageChange({ vf_active_account_v1: {} }, 'local')).toBe(true)
  })

  it('reacts to either underlying wallet-set key changing, not just the explicit selection', () => {
    expect(shouldReactToStorageChange({ vf_wallet_contract: {} }, 'local')).toBe(true)
    expect(shouldReactToStorageChange({ vf_classic_wallets: {} }, 'local')).toBe(true)
  })

  it('ignores unrelated keys and non-local storage areas', () => {
    expect(shouldReactToStorageChange({ vf_allowlist: {} }, 'local')).toBe(false)
    expect(shouldReactToStorageChange({ vf_active_account_v1: {} }, 'sync')).toBe(false)
    expect(shouldReactToStorageChange({ vf_active_account_v1: {} }, 'session')).toBe(false)
  })
})

describe('legacy vf_allowlist migration (narrow, one-time)', () => {
  it('migrates when exactly one wallet exists on the device — grants origin+account consent, deletes the old allowlist', async () => {
    const { env, local } = fakeEnv({
      allowlist: { 'https://a.example': { addedAt: 1 }, 'https://b.example': { addedAt: 2 } },
      address: 'CACCT',
    })
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'isConnected' },
      { origin: 'https://a.example', tab: { id: 1 } },
      env,
      vi.fn()
    )
    const id = consentId('https://a.example', 'stellar-testnet:CACCT')
    expect(local[CONSENT_KEY][id]).toMatchObject({
      origin: 'https://a.example',
      accountId: 'stellar-testnet:CACCT',
    })
    expect(local.vf_allowlist).toBeUndefined()
    expect(local.vf_allowlist_migration_v1).toMatchObject({ migrated: 2, skipped: 0 })
    // consents + the migration record land in one atomic storageLocal.set, not two writes.
    expect(env.storageLocal.set).toHaveBeenCalledTimes(1)
    expect(env.storageLocal.set).toHaveBeenCalledWith(
      expect.objectContaining({
        [CONSENT_KEY]: expect.any(Object),
        vf_allowlist_migration_v1: expect.objectContaining({ migrated: 2, skipped: 0 }),
      })
    )
  })

  it('never migrates when both a classic and a passkey wallet exist — ambiguous, never grants every current account', async () => {
    const { env, local } = fakeEnv({
      allowlist: { 'https://a.example': { addedAt: 1 } },
      address: 'CACCT',
      classic: { G1: { publicKey: 'G1', createdAt: 1 } },
    })
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'isConnected' },
      { origin: 'https://a.example', tab: { id: 1 } },
      env,
      vi.fn()
    )
    expect(local[CONSENT_KEY]).toBeUndefined()
    expect(local.vf_allowlist_migration_v1).toMatchObject({ migrated: 0, skipped: 1 })
  })

  it('never migrates when there is no wallet at all', async () => {
    const { env, local } = fakeEnv({
      allowlist: { 'https://a.example': { addedAt: 1 } },
    })
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'isConnected' },
      { origin: 'https://a.example', tab: { id: 1 } },
      env,
      vi.fn()
    )
    expect(local[CONSENT_KEY]).toBeUndefined()
    expect(local.vf_allowlist_migration_v1).toMatchObject({ migrated: 0, skipped: 1 })
  })

  it('is idempotent — runs exactly once even across repeated requests', async () => {
    const { env, local } = fakeEnv({
      allowlist: { 'https://a.example': { addedAt: 1 } },
      address: 'CACCT',
    })
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'isConnected' },
      { origin: 'https://a.example', tab: { id: 1 } },
      env,
      vi.fn()
    )
    const firstMigration = local.vf_allowlist_migration_v1
    local.vf_allowlist = { 'https://c.example': { addedAt: 9 } } // reintroduce — must be ignored
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'isConnected' },
      { origin: 'https://c.example', tab: { id: 1 } },
      env,
      vi.fn()
    )
    expect(local.vf_allowlist_migration_v1).toEqual(firstMigration)
    expect(
      local[CONSENT_KEY][consentId('https://c.example', 'stellar-testnet:CACCT')]
    ).toBeUndefined()
  })
})

describe('isInternalSender', () => {
  it('accepts extension pages and rejects web pages / missing urls', () => {
    const base = 'chrome-extension://abcdefg/'
    expect(isInternalSender({ url: `${base}approve.html?rid=x` }, base)).toBe(true)
    expect(isInternalSender({ url: 'https://vibing-farmer.pages.dev/' }, base)).toBe(false)
    expect(isInternalSender({}, base)).toBe(false)
    expect(isInternalSender(undefined, base)).toBe(false)
    expect(isInternalSender({ url: `${base}popup.html` }, '')).toBe(false) // no base → fail closed
  })
})
