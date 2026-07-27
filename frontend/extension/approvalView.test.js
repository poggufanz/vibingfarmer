// frontend/extension/approvalView.test.js
// VF Wallet Task 12 -- failing-tests-first coverage for the connect/sign consent view model and
// its DOM rendering. Ordering assertions read `sections.map(s => s.kind)` directly against the
// brief's own numbered lists (Step 1) rather than re-deriving them, so a future reorder shows up
// as an obvious diff against the literal brief order.
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  buildApprovalView,
  renderApprovalView,
  submissionStatusText,
  SUBMISSION_STATE,
  DAPP_REACHABLE_STATES,
  CONNECT_CAPABILITIES,
  STELLAR_TESTNET_LABEL,
  partsToText,
} from './approvalView.js'
import { SOROBAN_AUTOFARM_VAULT_ADDRESS } from '../src/stellar/config.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  launchRealChromium,
  buildHarnessHtml,
  sweep320,
} from '../src/wallet/ui/testSupport/sweep320.js'

const here = path.dirname(fileURLToPath(import.meta.url))

const ORIGIN = 'https://vibing-farmer.pages.dev'
const ADDRESS = 'CDLVXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXK3QP'

describe('buildApprovalView — verified-origin fail-closed gate', () => {
  it('never renders a connect/sign screen when the origin was not Chrome-verified (missing)', () => {
    const v = buildApprovalView(
      { method: 'getAddress', params: {}, origin: null },
      { address: ADDRESS }
    )
    expect(v.variant).toBe('blocked-origin')
    expect(v.approveLabel).toBeNull() // no confirming action at all
    expect(v.sections).toEqual([])
  })

  it('never renders a connect/sign screen when the origin is an empty string', () => {
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: '' },
      { address: ADDRESS }
    )
    expect(v.variant).toBe('blocked-origin')
  })

  it('renders normally once a real, verified origin is present', () => {
    const v = buildApprovalView(
      { method: 'getAddress', params: {}, origin: ORIGIN },
      { address: ADDRESS }
    )
    expect(v.variant).toBe('connect')
  })
})

describe('buildApprovalView — connect ordering (brief Step 1, connection consent order)', () => {
  it('orders sections exactly: origin, requests, account, network', () => {
    const v = buildApprovalView(
      { method: 'getAddress', params: {}, origin: ORIGIN },
      { address: ADDRESS, kind: 'passkey' }
    )
    expect(v.sections.map((s) => s.kind)).toEqual([
      'origin',
      'requests',
      'account',
      'network',
      'state',
    ])
  })

  it('the origin section carries the verified origin verbatim', () => {
    const v = buildApprovalView(
      { method: 'getAddress', params: {}, origin: ORIGIN },
      { address: ADDRESS }
    )
    expect(v.sections[0]).toEqual({ kind: 'origin', origin: ORIGIN, verified: true })
  })

  it('requests exactly the two capabilities, verbatim strings, in a fixed order', () => {
    const v = buildApprovalView(
      { method: 'getAddress', params: {}, origin: ORIGIN },
      { address: ADDRESS }
    )
    const requests = v.sections.find((s) => s.kind === 'requests')
    expect(requests.capabilities.map((c) => c.label)).toEqual([
      'See this address',
      'Ask for signatures',
    ])
    expect(CONNECT_CAPABILITIES.map((c) => c.label)).toEqual([
      'See this address',
      'Ask for signatures',
    ])
  })

  it('shows account type + a SHORTENED address, never the raw 56-char strkey (320px overflow risk)', () => {
    const v = buildApprovalView(
      { method: 'getAddress', params: {}, origin: ORIGIN },
      { address: ADDRESS, kind: 'passkey' }
    )
    const account = v.sections.find((s) => s.kind === 'account')
    expect(account.accountType).toBe('Passkey')
    expect(account.address).not.toBe(ADDRESS)
    expect(account.address).toMatch(/^CDLV…K3QP$/)
  })

  it('classic account renders as "Standard"', () => {
    const v = buildApprovalView(
      { method: 'getAddress', params: {}, origin: ORIGIN },
      { address: 'GCLASSIC', kind: 'classic' }
    )
    expect(v.sections.find((s) => s.kind === 'account').accountType).toBe('Standard')
  })

  it('shows the literal "Stellar testnet" copy, not the SDK TESTNET label', () => {
    const v = buildApprovalView(
      { method: 'getAddress', params: {}, origin: ORIGIN },
      { address: ADDRESS }
    )
    expect(v.sections.find((s) => s.kind === 'network')).toEqual({
      kind: 'network',
      label: 'Stellar testnet',
    })
    expect(STELLAR_TESTNET_LABEL).toBe('Stellar testnet')
  })

  it('action labels are Reject/Connect', () => {
    const v = buildApprovalView(
      { method: 'getAddress', params: {}, origin: ORIGIN },
      { address: ADDRESS }
    )
    expect(v.rejectLabel).toBe('Reject')
    expect(v.approveLabel).toBe('Connect')
  })

  it('no wallet stored → no-wallet variant with an onboarding CTA', () => {
    const v = buildApprovalView(
      { method: 'getAddress', params: {}, origin: ORIGIN },
      { address: null }
    )
    expect(v.variant).toBe('no-wallet')
    expect(v.approveLabel).toBe('Open VF Wallet')
  })
})

describe('buildApprovalView — sign ordering (brief Step 1, transaction approval order)', () => {
  it('orders sections exactly: consequence, origin, account, network, state, decoded, technical', () => {
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'RAWXDR' }, origin: ORIGIN },
      { address: 'CACCT', summary: null }
    )
    expect(v.sections.map((s) => s.kind)).toEqual([
      'consequence',
      'origin',
      'account',
      'network',
      'state',
      'decoded',
      'technical',
    ])
  })

  it('action labels are Cancel/Confirm, never Reject/Approve', () => {
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'RAWXDR' }, origin: ORIGIN },
      { address: 'CACCT', summary: null }
    )
    expect(v.rejectLabel).toBe('Cancel')
    expect(v.approveLabel).toBe('Confirm')
  })

  it('carries the raw xdr for signTransaction and the raw authEntry for signAuthEntry', () => {
    const vTx = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'RAWXDR' }, origin: ORIGIN },
      { address: 'CACCT' }
    )
    expect(vTx.raw).toBe('RAWXDR')
    const vAuth = buildApprovalView(
      { method: 'signAuthEntry', params: { authEntry: 'RAWENTRY' }, origin: ORIGIN },
      { address: 'CACCT' }
    )
    expect(vAuth.raw).toBe('RAWENTRY')
  })

  it('classic + locked → needsPassword true and the state section carries a password field flag', () => {
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'GCLASSIC', kind: 'classic', unlocked: false }
    )
    expect(v.needsPassword).toBe(true)
    expect(v.sections.find((s) => s.kind === 'state').needsPassword).toBe(true)
  })

  it('classic + unlocked → needsPassword false', () => {
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'GCLASSIC', kind: 'classic', unlocked: true }
    )
    expect(v.needsPassword).toBe(false)
  })

  it('passkey → note asks for Face ID, classic → note asks for wallet password', () => {
    const vPasskey = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', kind: 'passkey' }
    )
    expect(vPasskey.note).toMatch(/passkey/i)
    const vClassic = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'GCLASSIC', kind: 'classic' }
    )
    expect(vClassic.note).toMatch(/wallet password/i)
  })
})

describe('buildApprovalView — consequence never claims an inferred intended movement (item 1)', () => {
  it('an undecoded/generic call states plainly that no ceiling can be guaranteed, never a guessed amount/destination', () => {
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: null }
    )
    const consequence = v.sections.find((s) => s.kind === 'consequence')
    expect(consequence.statements.join(' ')).toMatch(/cannot state a guaranteed spending ceiling/i)
    expect(consequence.ceilingRows).toEqual([])
  })

  it('names the function/contract when decoded, without inventing an amount', () => {
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
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
    const consequence = v.sections.find((s) => s.kind === 'consequence')
    expect(consequence.statements.join(' ')).toContain('deposit')
    expect(consequence.statements.join(' ')).toContain('autofarm vault')
    expect(consequence.ceilingRows).toEqual([])
  })
})

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
      periodDurationSeconds: 86400,
      destination: {
        classification: 'known-stellar-vault',
        routeLabel: 'Autofarm Vault → Blend Capital v2',
        targetAddress: SOROBAN_AUTOFARM_VAULT_ADDRESS,
      },
    },
  ],
}

function grantSummary(grant) {
  return {
    network: 'TESTNET',
    contract: 'CROUTER11111111111111111111111111111111111111111111',
    contractLabel: 'funding router',
    fn: 'grant',
    args: ['owner', '5000000 (0.5)', '1000000', '[...]'],
    signer: null,
    grant,
  }
}

describe('buildApprovalView — Step 2: render decoded grant truth', () => {
  it('consequence leads with the canonical truth copy and the allowance ceiling, never a deposit-amount claim', () => {
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(singleTokenGrant) }
    )
    const consequence = v.sections.find((s) => s.kind === 'consequence')
    expect(consequence.statements[0]).toMatch(/does NOT mean any deposit has completed/)
    expect(consequence.ceilingRows).toHaveLength(1)
    expect(partsToText(consequence.ceilingRows[0][1])).toContain('not a deposit amount')
    expect(partsToText(consequence.ceilingRows[0][1])).toContain('0.5')
  })

  it('shows exactly N agent rows matching the actual AgentInit count, never more or fewer', () => {
    const twoAgents = {
      ...singleTokenGrant,
      agents: [
        singleTokenGrant.agents[0],
        { ...singleTokenGrant.agents[0], index: 1, periodDurationSeconds: 3600 },
      ],
    }
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(twoAgents) }
    )
    const decoded = v.sections.find((s) => s.kind === 'decoded')
    const agentRows = decoded.rows.filter(([k]) => /^Agent #/.test(k))
    expect(agentRows).toHaveLength(2)
    expect(agentRows.map(([k]) => k)).toEqual(['Agent #0', 'Agent #1'])
  })

  it('each agent row carries cap, period, and destination; per-agent expiry only when present', () => {
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(singleTokenGrant) }
    )
    const decoded = v.sections.find((s) => s.kind === 'decoded')
    const agentRow = decoded.rows.find(([k]) => k === 'Agent #0')
    expect(partsToText(agentRow[1])).toContain('cap')
    expect(partsToText(agentRow[1])).toContain('every 1d') // periodDurationSeconds: 86400
    expect(partsToText(agentRow[1])).toContain('Autofarm Vault → Blend Capital v2')
    expect(partsToText(agentRow[1])).not.toMatch(/expires/i) // no expiryTimestamp on the fixture
  })

  it('appends the agent-level expiry distinctly from the grant-level allowance expiry', () => {
    const withExpiry = {
      ...singleTokenGrant,
      agents: [{ ...singleTokenGrant.agents[0], expiryTimestamp: 1_800_000_000 }],
    }
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(withExpiry) }
    )
    const decoded = v.sections.find((s) => s.kind === 'decoded')
    expect(partsToText(decoded.rows.find(([k]) => k === 'Agent #0')[1])).toContain('1800000000')
    expect(partsToText(decoded.rows.find(([k]) => /allowance expires/i.test(k))[1])).toContain(
      '1000000'
    )
  })

  it('shows the one Stellar venue truth block', () => {
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(singleTokenGrant) }
    )
    const decoded = v.sections.find((s) => s.kind === 'decoded')
    expect(
      decoded.rows.some(([, v2]) => /Autofarm Vault → Blend Capital v2/.test(partsToText(v2)))
    ).toBe(true)
  })

  it('a bridge agent gets a nested Base-proxy child row directly under it, not a top-of-list bullet', () => {
    const withBridge = {
      ...singleTokenGrant,
      agents: [
        singleTokenGrant.agents[0],
        {
          index: 1,
          kind: 'bridge',
          capPerPeriod: {
            token: 'CTOKEN1111111111111111111111111111111111111111111111',
            units: 500_000n,
            decimals: 7,
          },
          periodDurationSeconds: 3600,
          destination: {
            classification: 'known-cctp-messenger',
            routeLabel: 'Stellar testnet → Circle CCTP → Base Sepolia',
            targetAddress: 'CMESSENGER11111111111111111111111111111111111111111',
          },
        },
      ],
    }
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(withBridge) }
    )
    const decoded = v.sections.find((s) => s.kind === 'decoded')
    const rows = decoded.rows
    const bridgeIdx = rows.findIndex(([k]) => k === 'Agent #1')
    expect(bridgeIdx).toBeGreaterThan(-1)
    expect(partsToText(rows[bridgeIdx][1])).toContain('bridge')
    // The very next row is the nested Base-proxy child, marked nested:true.
    const child = rows[bridgeIdx + 1]
    expect(child[0]).toBe('')
    expect(partsToText(child[1])).toMatch(/Base-side proxy/)
    expect(partsToText(child[1])).toMatch(/no live protocol yield/i)
    expect(child[2]).toEqual({ nested: true })
    // A deposit-only grant (no bridge agent) never carries this bullet at all.
    const decodedNoBridge = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(singleTokenGrant) }
    ).sections.find((s) => s.kind === 'decoded')
    expect(decodedNoBridge.rows.some(([, v2]) => /Base-side proxy/.test(partsToText(v2)))).toBe(
      false
    )
  })

  it('adds the mixed-token truth bullet only when budgets cover more than one token, each kept separate', () => {
    const mixed = {
      ...singleTokenGrant,
      budgets: [
        singleTokenGrant.budgets[0],
        {
          token: 'CTOKEN2222222222222222222222222222222222222222222222',
          units: 2_000_000n,
          decimals: 7,
        },
      ],
    }
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(mixed) }
    )
    const consequence = v.sections.find((s) => s.kind === 'consequence')
    expect(consequence.statements.some((s) => /more than one token/.test(s))).toBe(true)
    expect(consequence.ceilingRows).toHaveLength(2)
  })

  it('renders raw units, never a /1e7 value, when a budget/cap token has unknown decimals', () => {
    const unknownDecimals = {
      ...singleTokenGrant,
      agents: [
        {
          ...singleTokenGrant.agents[0],
          capPerPeriod: {
            token: 'COTHERTOKEN22222222222222222222222222222222222222222',
            units: 987_654n,
            decimals: null,
          },
        },
      ],
    }
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(unknownDecimals) }
    )
    const decoded = v.sections.find((s) => s.kind === 'decoded')
    const agentRow = decoded.rows.find(([k]) => k === 'Agent #0')
    expect(partsToText(agentRow[1])).toContain('987654 raw units')
    expect(partsToText(agentRow[1])).toContain('token decimals unknown')
    expect(partsToText(agentRow[1])).not.toMatch(/0\.0987654/)
  })

  it('a missing/unknown destination address renders as the word "unknown", never a blank/coerced-empty cell', () => {
    const noTarget = {
      ...singleTokenGrant,
      agents: [
        {
          ...singleTokenGrant.agents[0],
          destination: { classification: 'unknown', routeLabel: null, targetAddress: null },
        },
      ],
    }
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(noTarget) }
    )
    const decoded = v.sections.find((s) => s.kind === 'decoded')
    const agentRow = decoded.rows.find(([k]) => k === 'Agent #0')
    expect(partsToText(agentRow[1])).toContain('unlabeled destination unknown')
    expect(partsToText(agentRow[1])).not.toMatch(/unlabeled destination\s*$/) // never a trailing blank
  })
})

// Rejection-checklist item 5 ("Body or friendly copy uses monospace") has already failed twice
// elsewhere in this leg, and this surface is the densest mix of prose and genuine technical data
// in the whole wallet. jsdom cannot resolve computed font-family reliably (see WalletOnboarding.
// test.jsx's own header for why every mono guard in this wave uses real Chromium instead) -- but
// the SHAPE of each row's value (which segments are marked `addr: true`, i.e. will render inside
// a `.pc-technical` span) is fully computable here, so this asserts the classification itself is
// correct: only genuine addresses/hashes are marked technical, every sentence-shaped explanation
// is plain. The real-Chromium computed-style proof lives in approve.test.js's item-5 guard.
describe('buildApprovalView — item 5: mono is marked ONLY on address/hash segments, never on prose', () => {
  function addrSegments(parts) {
    return parts.filter((p) => p.addr)
  }
  function plainSegments(parts) {
    return parts.filter((p) => !p.addr)
  }

  it('a full-sentence explanation ("What this means", the Stellar venue truth block) carries NO addr segments', () => {
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(singleTokenGrant) }
    )
    const decoded = v.sections.find((s) => s.kind === 'decoded')
    const explanationRow = decoded.rows.find(([k]) => k === 'What this means')
    expect(addrSegments(explanationRow[1])).toEqual([])
    expect(plainSegments(explanationRow[1])[0].text).toBe(explanationRow[1][0].text)
  })

  it("the bridge agent's nested Base-proxy explanation is plain prose, never mono", () => {
    const withBridge = {
      ...singleTokenGrant,
      agents: [
        singleTokenGrant.agents[0],
        {
          index: 1,
          kind: 'bridge',
          capPerPeriod: singleTokenGrant.agents[0].capPerPeriod,
          periodDurationSeconds: 3600,
          destination: {
            classification: 'known-cctp-messenger',
            routeLabel: 'Stellar testnet → Circle CCTP → Base Sepolia',
            targetAddress: 'CMESSENGER11111111111111111111111111111111111111111',
          },
        },
      ],
    }
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(withBridge) }
    )
    const decoded = v.sections.find((s) => s.kind === 'decoded')
    const bridgeIdx = decoded.rows.findIndex(([k]) => k === 'Agent #1')
    const child = decoded.rows[bridgeIdx + 1]
    expect(addrSegments(child[1])).toEqual([])
  })

  it('an agent row keeps the venue label / kind word / period plain, marking ONLY the token address technical', () => {
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(singleTokenGrant) }
    )
    const decoded = v.sections.find((s) => s.kind === 'decoded')
    const agentRow = decoded.rows.find(([k]) => k === 'Agent #0')
    const technical = addrSegments(agentRow[1]).map((p) => p.text)
    expect(technical).toHaveLength(1) // exactly the token address, nothing else
    // The venue label, kind word ("deposit"), and period text are plain, not technical segments.
    const plainText = plainSegments(agentRow[1])
      .map((p) => p.text)
      .join('')
    expect(plainText).toContain('deposit')
    expect(plainText).toContain('Autofarm Vault → Blend Capital v2')
    expect(plainText).toContain('every 1d')
  })

  it('an unlabeled destination marks its fallback address technical, never the "unlabeled destination" wording', () => {
    const noTarget = {
      ...singleTokenGrant,
      agents: [
        {
          ...singleTokenGrant.agents[0],
          destination: { classification: 'unknown', routeLabel: null, targetAddress: null },
        },
      ],
    }
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(noTarget) }
    )
    const decoded = v.sections.find((s) => s.kind === 'decoded')
    const agentRow = decoded.rows.find(([k]) => k === 'Agent #0')
    const technical = addrSegments(agentRow[1]).map((p) => p.text)
    // Two addr segments: the cap's token address, and the destination's fallback address --
    // the LAST one is the destination fallback, and it must be the word "unknown", never blank.
    expect(technical.at(-1)).toBe('unknown')
    const plainText = plainSegments(agentRow[1])
      .map((p) => p.text)
      .join('')
    expect(plainText).toContain('unlabeled destination')
  })

  it('the raw args fallback (undecoded, fail-closed) is marked technical -- it is a raw dump by design, not prose', () => {
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      {
        address: 'CACCT',
        summary: {
          network: 'TESTNET',
          contract: 'CUNKNOWN1111111111111111111111111111111111111111111',
          fn: 'mystery_call',
          args: ['1', '2'],
          signer: null,
          grant: null,
        },
      }
    )
    const decoded = v.sections.find((s) => s.kind === 'decoded')
    const argRow = decoded.rows.find(([k]) => k === 'Args')
    expect(addrSegments(argRow[1])).toHaveLength(1)
  })
})

describe('buildApprovalView — Step 2: schema-mismatch fail-closed degrade (VFW3 preserved)', () => {
  it('a known-router schema mismatch shows the warning AND still surfaces raw args — never a friendly summary', () => {
    const mismatch = {
      kind: 'schema-mismatch',
      schemaVersion: 2,
      warning: 'Args did not match the known funding_router v2 grant schema.',
    }
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(mismatch) }
    )
    const consequence = v.sections.find((s) => s.kind === 'consequence')
    expect(consequence.warning).toBe(true)
    expect(consequence.statements[0]).toMatch(/did not match/)
    expect(consequence.ceilingRows).toEqual([]) // no fabricated ceiling
    const decoded = v.sections.find((s) => s.kind === 'decoded')
    expect(decoded.rows.some(([k]) => k === 'Warning')).toBe(true)
    expect(decoded.rows.some(([k]) => k === 'Args')).toBe(true)
    // I1 fix: the friendly primary Confirm label is never used unqualified on this path, and the
    // view carries an explicit flag approve.js uses to gate Confirm on the raw-details disclosure.
    expect(v.needsAcknowledgment).toBe(true)
    expect(v.approveLabel).toBe('Confirm anyway')
  })

  it('I1 fix: the happy path never needs acknowledgment and keeps the plain "Confirm" label', () => {
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(singleTokenGrant) }
    )
    expect(v.needsAcknowledgment).toBe(false)
    expect(v.approveLabel).toBe('Confirm')
  })

  it('never guesses a friendly label for an unrecognized contract (grant: null) — falls through to plain args', () => {
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      {
        address: 'CACCT',
        summary: {
          network: 'TESTNET',
          contract: 'CUNKNOWN1111111111111111111111111111111111111111111',
          contractLabel: null,
          fn: 'mystery_call',
          args: ['1', '2'],
          signer: null,
          grant: null,
        },
      }
    )
    const consequence = v.sections.find((s) => s.kind === 'consequence')
    expect(consequence.ceilingRows).toEqual([])
    expect(consequence.statements.join(' ')).toContain('mystery_call')
    const decoded = v.sections.find((s) => s.kind === 'decoded')
    expect(decoded.rows.filter(([k]) => k === 'Args' || k === '')).toHaveLength(2)
  })
})

describe('submissionStatusText — Step 4: nine distinct named states', () => {
  it('gives every state its own distinct label', () => {
    const labels = Object.values(SUBMISSION_STATE).map((s) => submissionStatusText(s))
    expect(new Set(labels).size).toBe(labels.length) // all distinct
  })

  it('SIGNED_RETURNED names the origin, never claims a completed deposit/grant', () => {
    const text = submissionStatusText(SUBMISSION_STATE.SIGNED_RETURNED, { origin: ORIGIN })
    expect(text).toBe(`Signed and returned to ${ORIGIN}`)
    expect(text).not.toMatch(/deposit|grant|complete/i)
  })

  it('WAITING_PASSWORD accepts a detail override (e.g. "Wrong password.") without inventing a new state', () => {
    expect(submissionStatusText(SUBMISSION_STATE.WAITING_PASSWORD)).toBe('Waiting for password')
    expect(
      submissionStatusText(SUBMISSION_STATE.WAITING_PASSWORD, { detail: 'Wrong password.' })
    ).toBe('Wrong password.')
  })

  it('FAILED accepts a detail override (the real error message)', () => {
    expect(submissionStatusText(SUBMISSION_STATE.FAILED)).toBe('Failed')
    expect(submissionStatusText(SUBMISSION_STATE.FAILED, { detail: 'network error' })).toBe(
      'Failed: network error'
    )
  })

  it('REJECTED and CONFIRMED read as plain, unambiguous words', () => {
    expect(submissionStatusText(SUBMISSION_STATE.REJECTED)).toBe('Rejected')
    expect(submissionStatusText(SUBMISSION_STATE.CONFIRMED)).toBe('Confirmed')
  })
})

describe('DAPP_REACHABLE_STATES — the generic dapp ceremony never reaches a submission-owning state', () => {
  it('excludes SUBMITTED/CONFIRMED/NOT_SUBMITTED/CHECKING_STATUS — those require an internal flow that owns real submission', () => {
    expect(DAPP_REACHABLE_STATES).not.toContain(SUBMISSION_STATE.SUBMITTED)
    expect(DAPP_REACHABLE_STATES).not.toContain(SUBMISSION_STATE.CONFIRMED)
    expect(DAPP_REACHABLE_STATES).not.toContain(SUBMISSION_STATE.NOT_SUBMITTED)
    expect(DAPP_REACHABLE_STATES).not.toContain(SUBMISSION_STATE.CHECKING_STATUS)
  })

  it('includes exactly the states a sign/reject/fail ceremony can reach', () => {
    expect([...DAPP_REACHABLE_STATES].sort()).toEqual(
      [
        SUBMISSION_STATE.REVIEWING,
        SUBMISSION_STATE.WAITING_PASSWORD,
        SUBMISSION_STATE.WAITING_PASSKEY,
        SUBMISSION_STATE.SIGNED_RETURNED,
        SUBMISSION_STATE.REJECTED,
        SUBMISSION_STATE.FAILED,
      ].sort()
    )
  })
})

describe('renderApprovalView — DOM order matches the view.sections order exactly (no reordering/filtering)', () => {
  it('connect: origin element precedes the requests heading, which precedes the account chip, which precedes the network badge', () => {
    const v = buildApprovalView(
      { method: 'getAddress', params: {}, origin: ORIGIN },
      { address: ADDRESS, kind: 'passkey' }
    )
    const root = document.createElement('main')
    renderApprovalView(root, v)
    const originEl = root.querySelector('#origin')
    const titleEl = root.querySelector('#title')
    const chipEl = root.querySelector('[data-testid="wallet-account-chip"]')
    const networkEl = root.querySelector('.pc-network-badge')
    expect(originEl).toBeTruthy()
    expect(titleEl).toBeTruthy()
    expect(chipEl).toBeTruthy()
    expect(networkEl).toBeTruthy()
    const pos = originEl.compareDocumentPosition(titleEl)
    // DOCUMENT_POSITION_FOLLOWING === 4: titleEl comes after originEl.
    expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(titleEl.compareDocumentPosition(chipEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      chipEl.compareDocumentPosition(networkEl) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(originEl.textContent).toBe(ORIGIN)
  })

  it('sign: the consequence block precedes the origin block, which precedes decoded rows and the technical-details disclosure', () => {
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'RAWXDR' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(singleTokenGrant) }
    )
    const root = document.createElement('main')
    renderApprovalView(root, v)
    const consequenceEl = root.querySelector('.pc-wallet-consequence')
    const originEl = root.querySelector('#origin')
    const rowsEl = root.querySelector('#rows')
    const rawWrapEl = root.querySelector('#raw-wrap')
    expect(consequenceEl && originEl && rowsEl && rawWrapEl).toBeTruthy()
    expect(
      consequenceEl.compareDocumentPosition(originEl) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(originEl.compareDocumentPosition(rowsEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      rowsEl.compareDocumentPosition(rawWrapEl) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it("the small brand lockup/logo is never rendered by this module at all (it lives in approve.html's static header, structurally unable to outrank anything here)", () => {
    const v = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT' }
    )
    const root = document.createElement('main')
    renderApprovalView(root, v)
    expect(root.querySelector('.pc-brand-lockup')).toBeNull()
    expect(root.querySelector('img')).toBeNull()
  })

  it('renders a password field only when needsPassword is true, and never leaves a stale one behind on the other branch', () => {
    const locked = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'GCLASSIC', kind: 'classic', unlocked: false }
    )
    const root = document.createElement('main')
    renderApprovalView(root, locked)
    expect(root.querySelector('#pw')).toBeTruthy()

    const unlocked = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'GCLASSIC', kind: 'classic', unlocked: true }
    )
    renderApprovalView(root, unlocked) // re-render into the SAME root
    expect(root.querySelector('#pw')).toBeNull()
  })

  it('I1 fix: a schema-mismatch consequence box renders visibly distinct from the happy path (warning class + danger-styled lead statement)', () => {
    const mismatch = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      {
        address: 'CACCT',
        summary: grantSummary({
          kind: 'schema-mismatch',
          schemaVersion: 2,
          warning: 'Args did not match the known funding_router v2 grant schema.',
        }),
      }
    )
    const root = document.createElement('main')
    renderApprovalView(root, mismatch)
    const box = root.querySelector('.pc-wallet-consequence')
    expect(box.classList.contains('pc-wallet-consequence--warning')).toBe(true)
    const leadStatement = box.querySelector('p')
    expect(leadStatement.classList.contains('pc-field-error')).toBe(true)

    const happy = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(singleTokenGrant) }
    )
    const happyRoot = document.createElement('main')
    renderApprovalView(happyRoot, happy)
    const happyBox = happyRoot.querySelector('.pc-wallet-consequence')
    expect(happyBox.classList.contains('pc-wallet-consequence--warning')).toBe(false)
    expect(happyBox.querySelector('.pc-field-error')).toBeNull()
  })

  it('blocked-origin renders a title/note and no interactive rows at all', () => {
    const v = buildApprovalView(
      { method: 'getAddress', params: {}, origin: null },
      { address: ADDRESS }
    )
    const root = document.createElement('main')
    renderApprovalView(root, v)
    expect(root.querySelector('#title').textContent).toBe('Request blocked')
    expect(root.querySelector('table')).toBeNull()
    expect(root.querySelector('#origin')).toBeNull() // nothing verified to show
  })
})

// ---------------------------------------------------------------------------------------------
// Real-Chromium guards across every consent/approval state (VF Wallet Task 12's own sweep, built
// on the shared A1 helper -- src/wallet/ui/testSupport/sweep320.js -- exactly as the brief's
// Verification section asks: "Measure 320px for every consent and approval state — use your new
// A1 sweep."). approve.html loads approval.css as a real <link>, not an embedded <style> (unlike
// WalletShell.jsx) -- inlined here via a raw file read so real Chromium computes against the
// actual shipped CSS, not an approximation.
// ---------------------------------------------------------------------------------------------
const approvalCss = readFileSync(path.resolve(here, './approval.css'), 'utf8')

function pageHtml(mainInnerHtml) {
  return `<style>${approvalCss}</style><div class="pc-wallet pc-wallet-shell" data-pocket-critical>
    <header class="pc-wallet-header">
      <div class="pc-brand-lockup pc-brand-lockup--compact">
        <img src="./vibing_farmer.logo.svg" alt="Vibing Farmer" />
        <span>VF Wallet</span>
      </div>
    </header>
    <main class="pc-wallet-main" id="approval-main">${mainInnerHtml}</main>
    <div class="pc-wallet-approval-actions">
      <button class="pc-button pc-button--secondary" id="reject">Reject</button>
      <button class="pc-button pc-button--primary" id="approve">Confirm</button>
    </div>
  </div>`
}

function renderStateHtml(req, ctx) {
  const view = buildApprovalView(req, ctx)
  const main = document.createElement('div')
  renderApprovalView(main, view)
  return pageHtml(main.innerHTML)
}

const bridgeAndMixedGrant = {
  ...singleTokenGrant,
  budgets: [
    singleTokenGrant.budgets[0],
    {
      token: 'CTOKEN2222222222222222222222222222222222222222222222',
      units: 2_000_000n,
      decimals: 7,
    },
  ],
  agents: [
    singleTokenGrant.agents[0],
    {
      index: 1,
      kind: 'bridge',
      capPerPeriod: {
        token: 'CTOKEN1111111111111111111111111111111111111111111111',
        units: 500_000n,
        decimals: 7,
      },
      periodDurationSeconds: 3600,
      destination: {
        classification: 'known-cctp-messenger',
        routeLabel: 'Stellar testnet → Circle CCTP → Base Sepolia',
        targetAddress: 'CMESSENGER11111111111111111111111111111111111111111',
      },
    },
  ],
}

const APPROVAL_STATES = [
  [
    'connect-passkey',
    [
      { method: 'getAddress', params: {}, origin: ORIGIN },
      { address: ADDRESS, kind: 'passkey' },
    ],
  ],
  [
    'connect-classic',
    [
      { method: 'getAddress', params: {}, origin: ORIGIN },
      { address: 'GCLASSIC', kind: 'classic' },
    ],
  ],
  [
    'sign-generic-undecoded',
    [
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: null },
    ],
  ],
  [
    'sign-grant-single-token',
    [
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(singleTokenGrant) },
    ],
  ],
  [
    'sign-grant-mixed-token-with-bridge',
    [
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(bridgeAndMixedGrant) },
    ],
  ],
  [
    'sign-schema-mismatch',
    [
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      {
        address: 'CACCT',
        summary: grantSummary({
          kind: 'schema-mismatch',
          schemaVersion: 2,
          warning: 'Args did not match the known funding_router v2 grant schema.',
        }),
      },
    ],
  ],
  [
    'sign-classic-locked-needs-password',
    [
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'GCLASSIC', kind: 'classic', unlocked: false },
    ],
  ],
  // C2 fix: a DNS label may be 63 unbroken [a-z0-9-] characters -- the reviewer measured this
  // pushing the 320px popup to 494.4px with no scrollbar (overflow-x: clip silently swallowed it),
  // letting an attacker choose which part of the origin the user reads. Reachable from any dapp.
  [
    'sign-long-origin',
    [
      {
        method: 'signTransaction',
        params: { xdr: 'X' },
        origin: `https://${'a'.repeat(63)}.com`,
      },
      { address: 'CACCT', summary: null },
    ],
  ],
  // I4 fix: 32 characters is the Soroban Symbol maximum, so a max-length function name is
  // reachable from any dapp, not a synthetic case -- the reviewer measured this pushing the
  // consequence <p> to 353.7px.
  [
    'sign-long-fn',
    [
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      {
        address: 'CACCT',
        summary: {
          network: 'TESTNET',
          contract: 'CUNKNOWN1111111111111111111111111111111111111111111',
          contractLabel: null,
          fn: 'abcdefghij_klmnopqrs_tuvwxyz_012',
          args: ['1'],
          signer: null,
          grant: null,
        },
      },
    ],
  ],
  ['no-wallet', [{ method: 'getAddress', params: {}, origin: ORIGIN }, { address: null }]],
  ['blocked-origin', [{ method: 'getAddress', params: {}, origin: null }, { address: ADDRESS }]],
]

function buildStatesHtml() {
  return APPROVAL_STATES.map(([label, [req, ctx]]) => [label, renderStateHtml(req, ctx)])
}

describe('renderApprovalView — real-browser 320px layout guard, every consent/approval state', () => {
  it('creates no horizontal overflow at 320px for every state (Part A1 sweep)', async () => {
    await sweep320(buildStatesHtml(), { logPrefix: 'approve' })
  }, 60000)
})

describe('renderApprovalView — real-Chromium proof of rejection-checklist item 5, every state', () => {
  it('no friendly copy outside .pc-technical/code/pre computes a JetBrains Mono font-family', async () => {
    const results = buildStatesHtml()
    const browser = await launchRealChromium()
    try {
      for (const [label, html] of results) {
        const page = await browser.newPage()
        await page.setContent(buildHarnessHtml(html))
        const monoOffenders = await page.evaluate(() =>
          Array.from(document.querySelectorAll('*'))
            .filter((el) => el.children.length === 0 && el.textContent.trim())
            .filter((el) => !el.closest('.pc-technical, code, pre'))
            .map((el) => ({
              text: el.textContent.trim().slice(0, 60),
              fontFamily: getComputedStyle(el).fontFamily,
            }))
            .filter((entry) => /jetbrains mono/i.test(entry.fontFamily))
        )
        expect(monoOffenders, `${label}: friendly copy rendered in JetBrains Mono`).toEqual([])
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }, 60000)

  // Positive control: prove the check isn't vacuously green because nothing on the page is ever
  // mono -- the densest state (mixed-token + bridge grant) DOES carry real .pc-technical address
  // segments, and they DO compute JetBrains Mono.
  it("positive control: the densest state's address segments DO compute JetBrains Mono (the filter excludes them correctly, not vacuously)", async () => {
    const html = renderStateHtml(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(bridgeAndMixedGrant) }
    )
    const browser = await launchRealChromium()
    try {
      const page = await browser.newPage()
      await page.setContent(buildHarnessHtml(html))
      const technicalFonts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.pc-technical')).map(
          (el) => getComputedStyle(el).fontFamily
        )
      )
      expect(technicalFonts.length).toBeGreaterThan(0)
      expect(technicalFonts.every((f) => /jetbrains mono/i.test(f))).toBe(true)
      await page.close()
    } finally {
      await browser.close()
    }
  }, 60000)

  // RED-then-GREEN mutation proof against the OLD (pre-fix) behavior: forcing every table cell
  // into mono (the exact regression this task fixed -- see approval.css's own comment on
  // `.pc-approval-table td`) makes a plain-prose row fail the check above.
  it('mutation-proof: forcing every .pc-approval-table td into mono (the pre-fix behavior) fails the check', async () => {
    const html = renderStateHtml(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(singleTokenGrant) }
    )
    const mutated = html.replace(
      '.pc-approval-table td {',
      '.pc-approval-table td { font-family: var(--pc-font-mono) !important;'
    )
    const browser = await launchRealChromium()
    try {
      const page = await browser.newPage()
      await page.setContent(buildHarnessHtml(mutated))
      const monoOffenders = await page.evaluate(() =>
        Array.from(document.querySelectorAll('*'))
          .filter((el) => el.children.length === 0 && el.textContent.trim())
          .filter((el) => !el.closest('.pc-technical, code, pre'))
          .filter((entry) => /jetbrains mono/i.test(getComputedStyle(entry).fontFamily))
      )
      expect(monoOffenders.length).toBeGreaterThan(0) // RED on the mutated (pre-fix) CSS
      await page.close()
    } finally {
      await browser.close()
    }
  }, 60000)
})

describe('renderApprovalView — real-Chromium proof of rejection-checklist items 6/7, every state', () => {
  it('no element in any consent/approval state has a running (non-"none") animation', async () => {
    const results = buildStatesHtml()
    const browser = await launchRealChromium()
    try {
      for (const [label, html] of results) {
        const page = await browser.newPage()
        await page.setContent(buildHarnessHtml(html))
        const animating = await page.evaluate(() =>
          Array.from(document.querySelectorAll('*'))
            .map((el) => getComputedStyle(el).animationName)
            .filter((name) => name && name !== 'none')
        )
        expect(animating, `${label}: entry/infinite animation found in real Chromium`).toEqual([])
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }, 60000)
})

// ---------------------------------------------------------------------------------------------
// Review fix round 1 -- C1. The allowance ceiling ("0.5 CTOK…1111 (not a deposit amount)") used to
// render `color: var(--pc-ink)` (which resolves to --pc-rice in the forest theme) directly on the
// --pc-owned (rice) background `.pc-wallet-consequence` sits on -- literally the same color,
// measured contrast 1.00. WCAG AA for normal text requires >= 4.5:1; jsdom cannot compute this
// (it doesn't resolve CSS custom properties or paint), so this is real-Chromium only, per the task
// brief's own instruction to measure C1 in a real browser.
// ---------------------------------------------------------------------------------------------
function parseRgb(str) {
  const m = str && str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function relativeLuminance([r, g, b]) {
  const [R, G, B] = [r, g, b].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * R + 0.7152 * G + 0.0722 * B
}

function contrastRatio(rgbA, rgbB) {
  const lA = relativeLuminance(rgbA)
  const lB = relativeLuminance(rgbB)
  const lighter = Math.max(lA, lB)
  const darker = Math.min(lA, lB)
  return (lighter + 0.05) / (darker + 0.05)
}

async function measureConsequenceColors(html) {
  const browser = await launchRealChromium()
  try {
    const page = await browser.newPage()
    await page.setContent(buildHarnessHtml(html))
    const raw = await page.evaluate(() => {
      const box = document.querySelector('.pc-wallet-consequence')
      const td = box.querySelector('.pc-approval-table td')
      const th = box.querySelector('.pc-approval-table th')
      const technical = box.querySelector('.pc-approval-table td .pc-technical')
      const styleOf = (el) => (el ? getComputedStyle(el).color : null)
      return {
        bg: getComputedStyle(box).backgroundColor,
        tdColor: styleOf(td),
        thColor: styleOf(th),
        technicalColor: styleOf(technical),
      }
    })
    await page.close()
    return raw
  } finally {
    await browser.close()
  }
}

describe('renderConsequence — real-Chromium WCAG AA contrast on the allowance ceiling (C1)', () => {
  const AA_NORMAL_TEXT = 4.5

  it('the ceiling amount, its token, and the table header meet AA contrast against the rice background', async () => {
    const html = renderStateHtml(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(singleTokenGrant) }
    )
    const { bg, tdColor, thColor, technicalColor } = await measureConsequenceColors(html)
    const bgRgb = parseRgb(bg)
    expect(bgRgb, `could not parse background color: ${bg}`).not.toBeNull()
    const tdRatio = contrastRatio(parseRgb(tdColor), bgRgb)
    const thRatio = contrastRatio(parseRgb(thColor), bgRgb)
    const technicalRatio = contrastRatio(parseRgb(technicalColor), bgRgb)
    expect(
      tdRatio,
      `td contrast ${tdRatio.toFixed(2)}:1 (color ${tdColor} on ${bg})`
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
    expect(thRatio, `th contrast ${thRatio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
    expect(
      technicalRatio,
      `.pc-technical contrast ${technicalRatio.toFixed(2)}:1`
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
  }, 60000)

  it('mutation-proof: removing the .pc-wallet-consequence-scoped color override reproduces the white-on-white regression', async () => {
    const html = renderStateHtml(
      { method: 'signTransaction', params: { xdr: 'X' }, origin: ORIGIN },
      { address: 'CACCT', summary: grantSummary(singleTokenGrant) }
    )
    // Strip exactly the two rules this fix added, reproducing the pre-fix CSS (td inherits the
    // generic `.pc-approval-table td { color: var(--pc-ink) }`, which is --pc-rice in this theme --
    // identical to the --pc-owned background it sits on).
    const mutated = html
      .replace(/\.pc-wallet-consequence \.pc-approval-table th\s*\{[^}]*\}/, '')
      .replace(
        /\.pc-wallet-consequence \.pc-approval-table td,\s*\.pc-wallet-consequence \.pc-approval-table td \.pc-technical\s*\{[^}]*\}/,
        ''
      )
    const { bg, tdColor } = await measureConsequenceColors(mutated)
    const ratio = contrastRatio(parseRgb(tdColor), parseRgb(bg))
    expect(
      ratio,
      `expected the pre-fix regression to reproduce low contrast, got ${ratio.toFixed(2)}:1`
    ).toBeLessThan(AA_NORMAL_TEXT)
  }, 60000)
})
