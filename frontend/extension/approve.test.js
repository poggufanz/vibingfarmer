import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  screenModel,
  rejectionResult,
  screenKind,
  verifyStillValid,
  approveSignClassic,
  grantRows,
} from './approve.js'
import { installChromeMock } from '../src/wallet/testUtils.js'
import { createRequestSnapshot } from '../src/wallet/consentStore.js'
import { importFromSecret } from '../src/wallet/classicAccount.js'
import { Account, TransactionBuilder, Operation } from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE, SOROBAN_AUTOFARM_VAULT_ADDRESS } from '../src/stellar/config.js'

const ORIGIN = 'https://vibing-farmer.pages.dev'

describe('approve — screen model', () => {
  it('no wallet stored → no-wallet variant with an onboarding CTA', () => {
    const m = screenModel({ method: 'getAddress', params: {}, origin: ORIGIN }, { address: null })
    expect(m.variant).toBe('no-wallet')
    expect(m.origin).toBe(ORIGIN)
    expect(m.approveLabel).toBe('Open VF Wallet')
  })

  it('getAddress → connect variant showing account + network', () => {
    const m = screenModel(
      { method: 'getAddress', params: {}, origin: ORIGIN },
      { address: 'CDLVXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXK3QP' }
    )
    expect(m.variant).toBe('connect')
    expect(m.title).toBe('Connection request')
    expect(m.approveLabel).toBe('Connect')
    expect(m.rows).toContainEqual(['Network', 'TESTNET'])
    expect(m.rows.find(([k]) => k === 'Account')[1]).toMatch(/^CDLV…K3QP$/)
  })

  it('signTransaction with a decoded summary → sign variant with contract/function/args rows', () => {
    const m = screenModel(
      { method: 'signTransaction', params: { xdr: 'RAWXDR' }, origin: ORIGIN },
      {
        address: 'CACCT',
        summary: {
          network: 'TESTNET',
          contract: 'CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5',
          contractLabel: 'funding router',
          fn: 'grant',
          args: ['CDLV…K3QP', '5000000 (0.5)'],
          signer: null,
        },
      }
    )
    expect(m.variant).toBe('sign')
    expect(m.title).toBe('Signature request')
    expect(m.approveLabel).toBe('Approve')
    expect(m.raw).toBe('RAWXDR')
    expect(m.rows).toContainEqual(['Function', 'grant'])
    expect(m.rows.find(([k]) => k === 'Contract')[1]).toContain('funding router')
    expect(m.rows.filter(([k]) => k === 'Args' || k === '')).toHaveLength(2)
  })

  it('signAuthEntry with a null summary still renders a sign screen with the raw entry', () => {
    const m = screenModel(
      { method: 'signAuthEntry', params: { authEntry: 'RAWENTRY' }, origin: ORIGIN },
      { address: 'CACCT', summary: null }
    )
    expect(m.variant).toBe('sign')
    expect(m.raw).toBe('RAWENTRY')
    expect(m.rows).toContainEqual(['Network', 'TESTNET'])
  })

  it('classic wallet, locked, sign request → needsPassword: true', () => {
    const m = screenModel(
      { method: 'signTransaction', params: { xdr: 'RAWXDR' }, origin: ORIGIN },
      { address: 'GCLASSIC', kind: 'classic', unlocked: false }
    )
    expect(m.variant).toBe('sign')
    expect(m.needsPassword).toBe(true)
  })

  it('classic wallet sign request → note asks for wallet password, not Face ID', () => {
    const m = screenModel(
      { method: 'signTransaction', params: { xdr: 'RAWXDR' }, origin: ORIGIN },
      { address: 'GCLASSIC', kind: 'classic', unlocked: false }
    )
    expect(m.note).toBe('Approving asks for your wallet password.')
  })

  it('classic wallet, already unlocked, sign request → no needsPassword', () => {
    const m = screenModel(
      { method: 'signTransaction', params: { xdr: 'RAWXDR' }, origin: ORIGIN },
      { address: 'GCLASSIC', kind: 'classic', unlocked: true }
    )
    expect(m.variant).toBe('sign')
    expect(m.needsPassword).toBeFalsy()
  })

  it('classic wallet address (no passkey) on getAddress → connect variant, not no-wallet', () => {
    const m = screenModel(
      { method: 'getAddress', params: {}, origin: ORIGIN },
      { address: 'GCLASSIC', kind: 'classic' }
    )
    expect(m.variant).toBe('connect')
    expect(m.rows.find(([k]) => k === 'Account')[1]).toBe('GCLASSIC')
  })

  it('rejectionResult is the exact SEP-43 -4 CEREMONY_RESULT', () => {
    expect(rejectionResult('rid-9')).toEqual({
      type: 'CEREMONY_RESULT',
      rid: 'rid-9',
      ok: false,
      code: -4,
      error: 'User rejected the request',
    })
  })
})

describe('screenKind', () => {
  it('maps ActiveAccountV1 kind to the screen vocabulary', () => {
    expect(screenKind('G')).toBe('classic')
    expect(screenKind('C')).toBe('passkey')
    expect(screenKind(undefined)).toBeNull()
  })
})

// The reviewer's gate item on VFW2: approve.js must never re-derive an account locally (that was
// the "passkey wins" bug in the old resolveWallet()) — it must only trust resolveActiveAccount(),
// same resolver as background.js/popup.jsx, and fail closed when it can't produce one unambiguous
// answer. verifyStillValid is the function this task replaced resolveWallet with.
describe('verifyStillValid — pre-sign account re-check (resolveWallet demotion)', () => {
  beforeEach(() => {
    installChromeMock()
  })

  const G1 = 'GAAA1111111111111111111111111111111111111111111111111'
  const C1 = 'CCCC1111111111111111111111111111111111111111111111111'

  function snapshotFor(account) {
    return createRequestSnapshot({
      rid: 'rid-1',
      method: 'signTransaction',
      params: { xdr: 'X' },
      sender: { origin: ORIGIN, tab: { id: 1 } },
      account,
      now: Date.now(),
    })
  }

  it('accepts when the sole wallet on the device matches the snapshot account', async () => {
    await globalThis.chrome.storage.local.set({ vf_wallet_contract: C1 })
    const account = {
      id: `stellar-testnet:${C1}`,
      address: C1,
      kind: 'C',
      signer: 'passkey-secp256r1',
    }
    const check = await verifyStillValid(snapshotFor(account), globalThis.chrome.storage.local)
    expect(check).toEqual({ ok: true })
  })

  it('fails closed (never silently picks the passkey account) when both a classic and a passkey wallet exist and neither is the persisted active selection', async () => {
    await globalThis.chrome.storage.local.set({
      vf_wallet_contract: C1,
      vf_classic_wallets: { [G1]: { publicKey: G1, createdAt: 1 } },
    })
    const passkeyAccount = {
      id: `stellar-testnet:${C1}`,
      address: C1,
      kind: 'C',
      signer: 'passkey-secp256r1',
    }
    const check = await verifyStillValid(
      snapshotFor(passkeyAccount),
      globalThis.chrome.storage.local
    )
    expect(check).toMatchObject({ ok: false, code: -3 })
  })

  it('fails closed when the active account switched away from the snapshot account', async () => {
    await globalThis.chrome.storage.local.set({ vf_wallet_contract: 'COTHER' })
    const staleAccount = {
      id: `stellar-testnet:${C1}`,
      address: C1,
      kind: 'C',
      signer: 'passkey-secp256r1',
    }
    const check = await verifyStillValid(snapshotFor(staleAccount), globalThis.chrome.storage.local)
    expect(check).toMatchObject({
      ok: false,
      code: -3,
      error: expect.stringMatching(/account changed/i),
    })
  })

  it('honors an explicit persisted active-account selection over the other wallet', async () => {
    await globalThis.chrome.storage.local.set({
      vf_wallet_contract: C1,
      vf_classic_wallets: { [G1]: { publicKey: G1, createdAt: 1 } },
      vf_active_account_v1: {
        version: 1,
        id: `stellar-testnet:${G1}`,
        network: 'stellar-testnet',
        address: G1,
        kind: 'G',
        signer: 'classic-ed25519',
        selectedAt: 1,
      },
    })
    const classicAccount = {
      id: `stellar-testnet:${G1}`,
      address: G1,
      kind: 'G',
      signer: 'classic-ed25519',
    }
    const check = await verifyStillValid(
      snapshotFor(classicAccount),
      globalThis.chrome.storage.local
    )
    expect(check).toEqual({ ok: true })
  })
})

// verifyStillValid checks the ACTIVE ACCOUNT, not the classic wallet's unlocked SESSION KEY —
// a device can have multiple vf_classic_wallets entries, so a session left unlocked for a
// different G-address must never be used to sign on behalf of the snapshot's account.
// approveSignClassic pins withSecret's expectedPublicKey to that exact address.
describe('approveSignClassic — session-key pinned to the snapshot address', () => {
  beforeEach(() => {
    installChromeMock()
    // approveSignClassic's setStatus() touches document.getElementById — stub the minimum
    // instead of switching this file to the jsdom environment (jsdom's crypto/Buffer shims break
    // the real @stellar/stellar-sdk keypair generation importFromSecret needs below).
    vi.stubGlobal('document', { getElementById: () => null })
  })

  function unsignedTxXdr(sourcePublicKey) {
    return new TransactionBuilder(new Account(sourcePublicKey, '1'), {
      fee: '100',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .setTimeout(30)
      .build()
      .toXDR()
  }

  it('fails closed when the unlocked session belongs to a different G-address than the snapshot', async () => {
    await importFromSecret({
      secret: 'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN',
      password: 'pw12pw12pw12',
      label: 'unlocked one',
    })
    const req = { method: 'signTransaction', params: { xdr: 'unused — never parsed' } }
    await expect(
      approveSignClassic(req, 'rid-1', 'GSOMEOTHERACCOUNTENTIRELYDIFFERENTFROMUNLOCKED')
    ).rejects.toThrow(/locked/i)
  })

  it('proceeds and signs when the unlocked session matches the snapshot address', async () => {
    const { publicKey } = await importFromSecret({
      secret: 'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN',
      password: 'pw12pw12pw12',
      label: 'unlocked one',
    })
    const req = { method: 'signTransaction', params: { xdr: unsignedTxXdr(publicKey) } }
    const result = await approveSignClassic(req, 'rid-1', publicKey)
    expect(result).toMatchObject({
      type: 'CEREMONY_RESULT',
      rid: 'rid-1',
      ok: true,
      address: publicKey,
    })
    expect(result.signedTxXdr).toBeTruthy()
  })
})

// The approve popup is the ONE place a user reads a grant before signing — Task 3's decoded
// summary must render as a truthful breakdown, never a wall of raw args, and never inflate
// budgets/caps/agent counts beyond what grantDecoder.js actually decoded.
describe('grantRows — truthful funding_router.grant breakdown', () => {
  const singleTokenGrant = {
    kind: 'funding-router-grant',
    schemaVersion: 2,
    owner: 'GOWNER',
    expiryLedger: 1_000_000,
    budgets: [
      {
        token: 'CTOKEN1111111111111111111111111111111111111111111111',
        units: 5_000_000n,
        decimals: 7,
      },
    ],
    agents: [
      {
        index: 0,
        kind: 'deposit',
        capPerPeriod: {
          token: 'CTOKEN1111111111111111111111111111111111111111111111',
          units: 1_000_000n,
          decimals: 7,
        },
        destination: {
          classification: 'known-stellar-vault',
          routeLabel: 'Autofarm Vault → Blend Capital v2',
          targetAddress: SOROBAN_AUTOFARM_VAULT_ADDRESS,
        },
      },
    ],
  }

  it('always leads with the canonical truth copy — grant ≠ completed deposit', () => {
    const rows = grantRows(singleTokenGrant)
    const truthRow = rows.find(([k]) => k === 'What this grant does')
    expect(truthRow[1]).toMatch(/does NOT mean any deposit has completed/)
  })

  it('shows the allowance budget as a ceiling, explicitly not a deposit amount', () => {
    const rows = grantRows(singleTokenGrant)
    const budgetRow = rows.find(([k]) => k === 'Allowance budget (ceiling)')
    expect(budgetRow[1]).toContain('not a deposit amount')
    expect(budgetRow[1]).toContain('0.5') // 5_000_000 base units / 1e7
  })

  it('shows each agent with its own cap ceiling and route label, never a total', () => {
    const rows = grantRows(singleTokenGrant)
    const agentRow = rows.find(([k]) => k === 'Agent #0')
    expect(agentRow[1]).toContain('deposit')
    expect(agentRow[1]).toContain('Autofarm Vault → Blend Capital v2')
    // Never a bare "total"/"amount" row — only per-agent, per-token ceilings.
    expect(rows.some(([k]) => /^total$/i.test(k))).toBe(false)
  })

  it('does not surface the mixed-token or bridge truth bullets for a single-token, deposit-only grant', () => {
    const rows = grantRows(singleTokenGrant)
    expect(rows.some(([, v]) => /more than one token/.test(v))).toBe(false)
    expect(rows.some(([, v]) => /Circle CCTP/.test(v))).toBe(false)
  })

  it('adds the mixed-token truth bullet when budgets cover more than one token, keeping each budget separate', () => {
    const grant = {
      ...singleTokenGrant,
      budgets: [
        {
          token: 'CTOKEN1111111111111111111111111111111111111111111111',
          units: 5_000_000n,
          decimals: 7,
        },
        {
          token: 'CTOKEN2222222222222222222222222222222222222222222222',
          units: 2_000_000n,
          decimals: 7,
        },
      ],
    }
    const rows = grantRows(grant)
    expect(rows.some(([, v]) => /more than one token/.test(v))).toBe(true)
    const budgetRows = rows
      .filter(([k]) => k === 'Allowance budget (ceiling)' || k === '')
      .filter(([, v]) => v.includes('not a deposit amount'))
    expect(budgetRows).toHaveLength(2)
  })

  it('renders raw units (never a /1e7 value) for a budget whose token decimals are unknown (Finding 2)', () => {
    const grant = {
      ...singleTokenGrant,
      budgets: [
        {
          token: 'CTOKEN1111111111111111111111111111111111111111111111',
          units: 5_000_000n,
          decimals: 7,
        },
        {
          token: 'COTHERTOKEN22222222222222222222222222222222222222222',
          units: 123_456n,
          decimals: null, // e.g. a v2 grant's second TokenBudget on a non-pinned token
        },
      ],
    }
    const rows = grantRows(grant)
    const unknownRow = rows.find(([, v]) => v.includes('COTH'))
    expect(unknownRow).toBeTruthy()
    expect(unknownRow[1]).toContain('123456 raw units')
    expect(unknownRow[1]).toContain('token decimals unknown')
    expect(unknownRow[1]).toContain('not a deposit amount')
    // Never the fixed /1e7 display for an unknown-decimals amount.
    expect(unknownRow[1]).not.toMatch(/0\.0123456/)
  })

  it('renders raw units (never a /1e7 value) for an agent cap whose token decimals are unknown (Finding 2)', () => {
    const grant = {
      ...singleTokenGrant,
      agents: [
        {
          index: 0,
          kind: 'deposit',
          capPerPeriod: {
            token: 'COTHERTOKEN22222222222222222222222222222222222222222',
            units: 987_654n,
            decimals: null,
          },
          destination: {
            classification: 'known-stellar-vault',
            routeLabel: 'Autofarm Vault → Blend Capital v2',
            targetAddress: SOROBAN_AUTOFARM_VAULT_ADDRESS,
          },
        },
      ],
    }
    const rows = grantRows(grant)
    const agentRow = rows.find(([k]) => k === 'Agent #0')
    expect(agentRow[1]).toContain('987654 raw units')
    expect(agentRow[1]).toContain('token decimals unknown')
    expect(agentRow[1]).not.toMatch(/0\.0987654/)
  })

  it('appends each agent\'s OWN expiry when present, distinct from the grant-level allowance expiry (Finding 3)', () => {
    const grant = {
      ...singleTokenGrant,
      agents: [{ ...singleTokenGrant.agents[0], expiryTimestamp: 1_800_000_000 }],
    }
    const rows = grantRows(grant)
    const agentRow = rows.find(([k]) => k === 'Agent #0')
    expect(agentRow[1]).toContain('1800000000')
    const grantExpiryRow = rows.find(([k]) => /allowance expires/i.test(k))
    expect(grantExpiryRow).toBeTruthy()
    expect(grantExpiryRow[1]).toContain(String(singleTokenGrant.expiryLedger))
  })

  it('omits per-agent expiry text (never shows zero/unknown as a value) when expiryTimestamp is absent', () => {
    const rows = grantRows(singleTokenGrant) // fixture agents carry no expiryTimestamp field
    const agentRow = rows.find(([k]) => k === 'Agent #0')
    expect(agentRow[1]).not.toMatch(/expires/i)
  })

  it('adds the bridge/CCTP truth bullet only when a bridge-kind agent is present', () => {
    const grant = {
      ...singleTokenGrant,
      agents: [
        ...singleTokenGrant.agents,
        {
          index: 1,
          kind: 'bridge',
          capPerPeriod: {
            token: 'CTOKEN1111111111111111111111111111111111111111111111',
            units: 500_000n,
            decimals: 7,
          },
          destination: {
            classification: 'known-cctp-messenger',
            routeLabel: 'Stellar testnet → Circle CCTP → Base Sepolia',
            targetAddress: 'CMESSENGER11111111111111111111111111111111111111111',
          },
        },
      ],
    }
    const rows = grantRows(grant)
    expect(rows.some(([, v]) => /Circle CCTP/.test(v))).toBe(true)
    const bridgeAgentRow = rows.find(([k]) => k === 'Agent #1')
    expect(bridgeAgentRow[1]).toContain('bridge')
    expect(bridgeAgentRow[1]).toContain('Stellar testnet → Circle CCTP → Base Sepolia')
  })
})

describe('screenModel — funding_router.grant sign screen', () => {
  const grantSummary = {
    network: 'TESTNET',
    contract: 'CROUTER11111111111111111111111111111111111111111111',
    contractLabel: 'funding router',
    fn: 'grant',
    args: ['owner', '5000000 (0.5)', '1000000', '[...]'],
    signer: null,
    grant: {
      kind: 'funding-router-grant',
      schemaVersion: 2,
      owner: 'GOWNER',
      expiryLedger: 1_000_000,
      budgets: [
        {
          token: 'CTOKEN1111111111111111111111111111111111111111111111',
          units: 5_000_000n,
          decimals: 7,
        },
      ],
      agents: [
        {
          index: 0,
          kind: 'deposit',
          capPerPeriod: {
            token: 'CTOKEN1111111111111111111111111111111111111111111111',
            units: 1_000_000n,
            decimals: 7,
          },
          destination: {
            classification: 'known-stellar-vault',
            routeLabel: 'Autofarm Vault → Blend Capital v2',
            targetAddress: SOROBAN_AUTOFARM_VAULT_ADDRESS,
          },
        },
      ],
    },
  }

  it('a decoded grant replaces the raw Args rows with the truthful breakdown', () => {
    const m = screenModel(
      { method: 'signTransaction', params: { xdr: 'RAWXDR' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary }
    )
    expect(m.variant).toBe('sign')
    expect(m.rows.some(([k]) => k === 'What this grant does')).toBe(true)
    expect(m.rows.some(([k]) => k === 'Allowance budget (ceiling)')).toBe(true)
    expect(m.rows.some(([k]) => k === 'Agent #0')).toBe(true)
    expect(m.rows.some(([k]) => k === 'Args')).toBe(false)
    // Raw XDR is still available for a user who wants to verify it themselves.
    expect(m.raw).toBe('RAWXDR')
  })

  it('a known-router schema mismatch surfaces a Warning row AND still shows raw args (fail closed)', () => {
    const mismatchSummary = {
      ...grantSummary,
      grant: {
        kind: 'schema-mismatch',
        schemaVersion: 2,
        warning: 'Args did not match the known funding_router v2 grant schema.',
      },
    }
    const m = screenModel(
      { method: 'signTransaction', params: { xdr: 'RAWXDR' }, origin: ORIGIN },
      { address: 'CACCT', summary: mismatchSummary }
    )
    const warningRow = m.rows.find(([k]) => k === 'Warning')
    expect(warningRow[1]).toMatch(/did not match/)
    expect(m.rows.some(([k]) => k === 'Args')).toBe(true)
  })

  it('a non-grant summary (grant: null) keeps the existing generic Args rows unchanged', () => {
    const m = screenModel(
      { method: 'signTransaction', params: { xdr: 'RAWXDR' }, origin: ORIGIN },
      {
        address: 'CACCT',
        summary: {
          network: 'TESTNET',
          contract: SOROBAN_AUTOFARM_VAULT_ADDRESS,
          contractLabel: 'autofarm vault',
          fn: 'deposit',
          args: ['CDLV…K3QP', '5000000 (0.5)'],
          signer: null,
          grant: null,
        },
      }
    )
    expect(m.rows.some(([k]) => k === 'What this grant does')).toBe(false)
    expect(m.rows.filter(([k]) => k === 'Args' || k === '')).toHaveLength(2)
  })
})
