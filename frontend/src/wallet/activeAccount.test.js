// frontend/src/wallet/activeAccount.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import { installChromeMock } from './testUtils.js'
import {
  ACTIVE_ACCOUNT_KEY,
  listWalletAccounts,
  resolveActiveAccount,
  selectActiveAccount,
  clearActiveAccount,
  sameAccount,
} from './activeAccount.js'

let bags
beforeEach(() => {
  bags = installChromeMock()
})

function fakeLegacyStorage(values = {}) {
  return { getItem: (k) => values[k] ?? null }
}

async function seedClassic(publicKey, createdAt = 1) {
  const all =
    (await globalThis.chrome.storage.local.get('vf_classic_wallets'))['vf_classic_wallets'] ?? {}
  all[publicKey] = { label: 'x', publicKey, blob: {}, createdAt }
  await globalThis.chrome.storage.local.set({ vf_classic_wallets: all })
}
async function seedPasskey(contractId) {
  await globalThis.chrome.storage.local.set({ vf_wallet_contract: contractId })
}

const G1 = 'GAAA1111111111111111111111111111111111111111111111111'
const G2 = 'GBBB2222222222222222222222222222222222222222222222222'
const C1 = 'CCCC1111111111111111111111111111111111111111111111111'

describe('listWalletAccounts', () => {
  it('is empty when no accounts exist', async () => {
    await expect(
      listWalletAccounts({ storageLocal: globalThis.chrome.storage.local })
    ).resolves.toEqual([])
  })

  it('lists a single classic wallet as kind G', async () => {
    await seedClassic(G1)
    const accounts = await listWalletAccounts({ storageLocal: globalThis.chrome.storage.local })
    expect(accounts).toEqual([
      {
        version: 1,
        id: `stellar-testnet:${G1}`,
        network: 'stellar-testnet',
        address: G1,
        kind: 'G',
        signer: 'classic-ed25519',
      },
    ])
  })

  it('picks the OLDEST classic wallet by createdAt when more than one record exists', async () => {
    await seedClassic(G2, 200)
    await seedClassic(G1, 100)
    const accounts = await listWalletAccounts({ storageLocal: globalThis.chrome.storage.local })
    expect(accounts).toHaveLength(1)
    expect(accounts[0].address).toBe(G1)
  })

  it('lists the cached passkey wallet as kind C', async () => {
    await seedPasskey(C1)
    const accounts = await listWalletAccounts({ storageLocal: globalThis.chrome.storage.local })
    expect(accounts).toEqual([
      {
        version: 1,
        id: `stellar-testnet:${C1}`,
        network: 'stellar-testnet',
        address: C1,
        kind: 'C',
        signer: 'passkey-secp256r1',
      },
    ])
  })

  it('lists both when a classic and a passkey wallet coexist', async () => {
    await seedClassic(G1)
    await seedPasskey(C1)
    const accounts = await listWalletAccounts({ storageLocal: globalThis.chrome.storage.local })
    expect(accounts.map((a) => a.kind).sort()).toEqual(['C', 'G'])
  })
})

describe('resolveActiveAccount — resolution matrix', () => {
  it('empty storage -> status empty', async () => {
    const r = await resolveActiveAccount({ storageLocal: globalThis.chrome.storage.local })
    expect(r).toEqual({ status: 'empty' })
  })

  it('one usable G selects G', async () => {
    await seedClassic(G1)
    const r = await resolveActiveAccount({ storageLocal: globalThis.chrome.storage.local })
    expect(r.status).toBe('ready')
    expect(r.account.kind).toBe('G')
    expect(r.account.address).toBe(G1)
    // auto-selection persists, so a second resolve is stable without re-deciding
    expect(bags.local[ACTIVE_ACCOUNT_KEY].id).toBe(r.account.id)
  })

  it('one usable C selects C', async () => {
    await seedPasskey(C1)
    const r = await resolveActiveAccount({ storageLocal: globalThis.chrome.storage.local })
    expect(r.status).toBe('ready')
    expect(r.account.kind).toBe('C')
    expect(r.account.address).toBe(C1)
  })

  it('both without a valid preference require selection — never silently prefers C', async () => {
    await seedClassic(G1)
    await seedPasskey(C1)
    const r = await resolveActiveAccount({ storageLocal: globalThis.chrome.storage.local })
    expect(r.status).toBe('selection-required')
    expect(r.accounts.map((a) => a.kind).sort()).toEqual(['C', 'G'])
  })

  it('both, with an unrelated/invalid legacy hint, still requires selection (no default toward C)', async () => {
    await seedClassic(G1)
    await seedPasskey(C1)
    const legacyStorage = fakeLegacyStorage({ vf_wallet_type: 'bogus' })
    const r = await resolveActiveAccount({
      storageLocal: globalThis.chrome.storage.local,
      legacyStorage,
    })
    expect(r.status).toBe('selection-required')
  })

  it('explicit persisted G remains G even when a C also exists', async () => {
    await seedClassic(G1)
    await seedPasskey(C1)
    await selectActiveAccount({
      accountId: `stellar-testnet:${G1}`,
      storageLocal: globalThis.chrome.storage.local,
    })
    const r = await resolveActiveAccount({ storageLocal: globalThis.chrome.storage.local })
    expect(r.status).toBe('ready')
    expect(r.account.kind).toBe('G')
    expect(r.account.address).toBe(G1)
  })

  it('explicit persisted C remains C even when a G also exists', async () => {
    await seedClassic(G1)
    await seedPasskey(C1)
    await selectActiveAccount({
      accountId: `stellar-testnet:${C1}`,
      storageLocal: globalThis.chrome.storage.local,
    })
    const r = await resolveActiveAccount({ storageLocal: globalThis.chrome.storage.local })
    expect(r.status).toBe('ready')
    expect(r.account.kind).toBe('C')
    expect(r.account.address).toBe(C1)
  })

  it('creation/import/restore selects only the account just created/restored', async () => {
    await seedClassic(G1)
    await selectActiveAccount({
      accountId: `stellar-testnet:${G1}`,
      storageLocal: globalThis.chrome.storage.local,
    })
    // A second (passkey) account shows up later — selecting it moves the pointer to exactly
    // that account, not some blend/merge of the two.
    await seedPasskey(C1)
    await selectActiveAccount({
      accountId: `stellar-testnet:${C1}`,
      storageLocal: globalThis.chrome.storage.local,
    })
    const r = await resolveActiveAccount({ storageLocal: globalThis.chrome.storage.local })
    expect(r.account.address).toBe(C1)
  })

  it('switching never deletes the other account credentials', async () => {
    await seedClassic(G1)
    await seedPasskey(C1)
    await selectActiveAccount({
      accountId: `stellar-testnet:${G1}`,
      storageLocal: globalThis.chrome.storage.local,
    })
    await selectActiveAccount({
      accountId: `stellar-testnet:${C1}`,
      storageLocal: globalThis.chrome.storage.local,
    })
    const accounts = await listWalletAccounts({ storageLocal: globalThis.chrome.storage.local })
    expect(accounts.map((a) => a.kind).sort()).toEqual(['C', 'G']) // both still resolvable
    // ...and switching back to G still works — its record was never touched.
    await selectActiveAccount({
      accountId: `stellar-testnet:${G1}`,
      storageLocal: globalThis.chrome.storage.local,
    })
    const r = await resolveActiveAccount({ storageLocal: globalThis.chrome.storage.local })
    expect(r.account.address).toBe(G1)
  })

  it('a persisted selection pointing at a REMOVED account clears and fails closed (falls back to the remaining one)', async () => {
    await seedClassic(G1)
    await seedPasskey(C1)
    await selectActiveAccount({
      accountId: `stellar-testnet:${C1}`,
      storageLocal: globalThis.chrome.storage.local,
    })
    await globalThis.chrome.storage.local.remove('vf_wallet_contract') // C disappears
    const r = await resolveActiveAccount({ storageLocal: globalThis.chrome.storage.local })
    expect(r.status).toBe('ready')
    expect(r.account.address).toBe(G1) // only G left, safely auto-selected
    expect(bags.local[ACTIVE_ACCOUNT_KEY].id).toBe(`stellar-testnet:${G1}`) // stale pointer overwritten, not left dangling
  })

  it('a corrupt persisted record clears and fails closed', async () => {
    await seedClassic(G1)
    await globalThis.chrome.storage.local.set({ [ACTIVE_ACCOUNT_KEY]: { garbage: true } })
    const r = await resolveActiveAccount({ storageLocal: globalThis.chrome.storage.local })
    expect(r.status).toBe('ready')
    expect(r.account.address).toBe(G1)
  })

  it('a mismatched persisted record (claims a kind the address does not have) clears and fails closed', async () => {
    await seedClassic(G1)
    await globalThis.chrome.storage.local.set({
      [ACTIVE_ACCOUNT_KEY]: {
        version: 1,
        id: `stellar-testnet:${G1}`,
        network: 'stellar-testnet',
        address: G1,
        kind: 'C', // wrong — this address is the classic wallet, not the passkey
        signer: 'passkey-secp256r1',
        selectedAt: 1,
      },
    })
    const r = await resolveActiveAccount({ storageLocal: globalThis.chrome.storage.local })
    expect(r.status).toBe('ready')
    expect(r.account.kind).toBe('G') // recomputed from source of truth, not trusted blindly
  })

  it('popup migration honors a valid legacy vf_wallet_type when ambiguous', async () => {
    await seedClassic(G1)
    await seedPasskey(C1)
    const legacyStorage = fakeLegacyStorage({ vf_wallet_type: 'passkey' })
    const r = await resolveActiveAccount({
      storageLocal: globalThis.chrome.storage.local,
      legacyStorage,
    })
    expect(r.status).toBe('ready')
    expect(r.account.kind).toBe('C')
    // migration persists so future resolves (including background, with no legacyStorage) stay ready
    const r2 = await resolveActiveAccount({ storageLocal: globalThis.chrome.storage.local })
    expect(r2.status).toBe('ready')
    expect(r2.account.kind).toBe('C')
  })

  it('migrate:false ignores legacyStorage even if present — background never depends on it', async () => {
    await seedClassic(G1)
    await seedPasskey(C1)
    const legacyStorage = fakeLegacyStorage({ vf_wallet_type: 'passkey' })
    const r = await resolveActiveAccount({
      storageLocal: globalThis.chrome.storage.local,
      legacyStorage,
      migrate: false,
    })
    expect(r.status).toBe('selection-required')
  })

  it('no code path silently prefers C because a passkey record exists', async () => {
    await seedClassic(G1)
    await seedPasskey(C1)
    const r = await resolveActiveAccount({ storageLocal: globalThis.chrome.storage.local })
    expect(r.status).not.toBe('ready') // not silently ready-as-C
  })
})

describe('selectActiveAccount', () => {
  it('throws for an unknown account id', async () => {
    await expect(
      selectActiveAccount({
        accountId: 'stellar-testnet:GUNKNOWN',
        storageLocal: globalThis.chrome.storage.local,
      })
    ).rejects.toThrow(/unknown account/)
  })
})

describe('clearActiveAccount', () => {
  it('removes the persisted selection', async () => {
    await seedClassic(G1)
    await selectActiveAccount({
      accountId: `stellar-testnet:${G1}`,
      storageLocal: globalThis.chrome.storage.local,
    })
    await clearActiveAccount({ storageLocal: globalThis.chrome.storage.local })
    expect(bags.local[ACTIVE_ACCOUNT_KEY]).toBeUndefined()
  })
})

describe('sameAccount', () => {
  it('compares by id + kind', () => {
    const a = { id: 'x', kind: 'G' }
    const b = { id: 'x', kind: 'G' }
    const c = { id: 'x', kind: 'C' }
    expect(sameAccount(a, b)).toBe(true)
    expect(sameAccount(a, c)).toBe(false)
    expect(sameAccount(a, null)).toBe(false)
  })
})
