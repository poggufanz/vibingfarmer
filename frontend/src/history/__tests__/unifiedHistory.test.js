// P1 G10: unified feed — merge/sort across sources, null (not []) on failure,
// no explorer link without a source-provided hash.
import { describe, it, expect, vi } from 'vitest'
import {
  stellarTxUrl,
  baseTxUrl,
  normalizeHorizonRows,
  normalizeReceiptRows,
  normalizeLedgerRows,
  normalizeAgentRows,
  normalizeKeeperRows,
  normalizeBaseRows,
  mergeActivityRows,
  fetchUnifiedActivity,
} from '../unifiedHistory.js'

describe('explorer links', () => {
  it('builds a URL only off a real hash, never a guess', () => {
    expect(stellarTxUrl('ABC123')).toBe('https://stellar.expert/explorer/testnet/tx/ABC123')
    expect(stellarTxUrl('')).toBeNull()
    expect(stellarTxUrl(null)).toBeNull()
    expect(stellarTxUrl(undefined)).toBeNull()
    expect(baseTxUrl('0x1')).toBe('https://base-sepolia.blockscout.com/tx/0x1')
    expect(baseTxUrl(null)).toBeNull()
  })
})

describe('mergeActivityRows', () => {
  const row = (over) => ({
    id: 'x',
    time: 1000,
    kind: 'deposit',
    label: 'Deposit',
    detail: 'd',
    hash: null,
    url: null,
    network: 'stellar',
    status: 'confirmed',
    ...over,
  })

  it('sorts newest first and keeps undated rows last without inventing times', () => {
    const rows = mergeActivityRows({
      local: [row({ id: 'old', time: 1000 }), row({ id: 'nodate', time: null })],
      horizon: [row({ id: 'new', time: 3000 })],
    })
    expect(rows.map((r) => r.id)).toEqual(['new', 'old', 'nodate'])
    expect(rows[2].time).toBeNull()
  })

  it('dedupes by hash (case-insensitive): the local receipt beats the ledger hint', () => {
    const rows = mergeActivityRows({
      ledger: [row({ id: 'ledger-hint', hash: 'AbC', detail: 'thin' })],
      local: [row({ id: 'receipt', hash: 'aBc', detail: 'rich' })],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('receipt')
  })

  it('skips unavailable (null) sources instead of rendering them', () => {
    const rows = mergeActivityRows({ horizon: null, local: [row({ id: 'only' })] })
    expect(rows.map((r) => r.id)).toEqual(['only'])
  })

  it('keeps hash-less rows (no link) exactly as they are', () => {
    const rows = mergeActivityRows({
      grant: [row({ id: 'g1' }), row({ id: 'g2' })],
    })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.url === null)).toBe(true)
  })
})

describe('normalizers', () => {
  it('horizon rows keep time/hash/direction and pass null straight through', () => {
    expect(normalizeHorizonRows(null)).toBeNull()
    const [r] = normalizeHorizonRows([
      {
        id: '1',
        type: 'payment',
        amount: '3',
        asset: 'XLM',
        createdAt: '2026-01-01T00:00:00.000Z',
        txHash: 'H1',
        direction: 'out',
      },
    ])
    expect(r).toMatchObject({
      kind: 'payment',
      label: 'Sent',
      hash: 'H1',
      url: 'https://stellar.expert/explorer/testnet/tx/H1',
      status: 'confirmed',
    })
    expect(r.time).toBe(Date.parse('2026-01-01T00:00:00.000Z'))
  })

  it('receipt rows label withdraw vs deposit and link only with a hash', () => {
    const [w, d] = normalizeReceiptRows([
      { type: 'withdraw', txHash: 'HW', vaultName: 'V', amountUsdc: 2, timestamp: 5 },
      { type: 'transaction', vaultName: 'V', amountUsdc: 1, timestamp: 6 },
    ])
    expect(w).toMatchObject({ kind: 'withdraw', label: 'Withdraw', url: expect.stringContaining('HW') })
    expect(d).toMatchObject({ kind: 'deposit', label: 'Deposit', hash: null, url: null })
  })

  it('ledger rows are undated principal evidence with an optional link', () => {
    const [r] = normalizeLedgerRows([{ agent: 'CAGENT1', assetsIn: '20000000', txHash: 'HL' }])
    expect(r).toMatchObject({
      time: null,
      kind: 'deposit',
      hash: 'HL',
      url: 'https://stellar.expert/explorer/testnet/tx/HL',
    })
    expect(r.detail).toMatch(/2\.00 USDC/)
  })

  it('agent rows trust only the address and never fabricate a link', () => {
    const [r] = normalizeAgentRows([{ address: 'CAGENT1', whatever: 'x' }])
    expect(r).toMatchObject({ kind: 'grant', hash: null, url: null })
    expect(normalizeAgentRows([{ address: '' }, null])).toEqual([])
  })

  it('keeper rows use the real close time and link the event hash', () => {
    const [c, u] = normalizeKeeperRows([
      {
        type: 'compound',
        ledger: 10,
        txHash: 'HK',
        closedAt: 1700000000000,
        totalGain: 5000000n,
      },
      { type: 'rebalance', ledger: 11 },
    ])
    expect(c).toMatchObject({
      label: 'Keeper compound',
      time: 1700000000000,
      url: 'https://stellar.expert/explorer/testnet/tx/HK',
    })
    expect(c.detail).toMatch(/ledger 10/)
    expect(u).toMatchObject({ time: null, url: null })
  })

  it('base rows keep direction/time and pass null straight through', () => {
    expect(normalizeBaseRows(null)).toBeNull()
    const [r] = normalizeBaseRows([
      { hash: '0xb', time: 42, symbol: 'USDC', amount: 1.5, direction: 'in' },
    ])
    expect(r).toMatchObject({
      label: 'Received',
      network: 'base',
      url: 'https://base-sepolia.blockscout.com/tx/0xb',
    })
  })
})

describe('fetchUnifiedActivity', () => {
  it('merges every source newest-first and reports per-source status', async () => {
    const out = await fetchUnifiedActivity({
      owner: 'GOWNER',
      baseAccount: '0xbase',
      deps: {
        fetchHistory: async () => [
          {
            id: 'h1',
            type: 'payment',
            amount: '1',
            asset: 'XLM',
            createdAt: '2026-01-02T00:00:00.000Z',
            txHash: 'HH',
            direction: 'in',
          },
        ],
        getTransactions: () => [
          { type: 'transaction', txHash: 'HR', vaultName: 'V', amountUsdc: 5, timestamp: 1700000000000 },
        ],
        loadDepositLedger: () => [{ agent: 'CA', assetsIn: '10000000', txHash: 'HR' }],
        fetchAgents: async () => ({ status: 'complete', agents: [{ address: 'CAGENT9' }] }),
        fetchKeeper: async () => [],
        fetchBase: async () => [
          { hash: '0xb1', time: 1800000000000, symbol: 'USDC', amount: 2, direction: 'out' },
        ],
      },
    })
    // Dedup: receipt HR wins over the ledger hint with the same hash.
    expect(out.rows.some((r) => r.id.startsWith('ledger:'))).toBe(false)
    expect(out.rows[0].network).toBe('base')
    expect(out.rows.map((r) => r.id)).toContain('grant:CAGENT9')
    expect(out.sources).toMatchObject({
      local: 'ok',
      horizon: 'ok',
      ledger: 'ok',
      keeper: 'empty',
      grant: 'ok',
      base: 'ok',
    })
    expect(out.partial).toBe(false)
  })

  it('a throwing source marks its leg unavailable without failing the feed', async () => {
    const out = await fetchUnifiedActivity({
      owner: 'GOWNER',
      deps: {
        fetchHistory: async () => {
          throw new Error('net down')
        },
        getTransactions: () => [],
        loadDepositLedger: () => [],
        fetchAgents: async () => ({ status: 'unavailable', agents: [] }),
        fetchKeeper: async () => [],
      },
    })
    expect(out.rows).toEqual([])
    expect(out.sources).toMatchObject({ horizon: 'unavailable', grant: 'unavailable', local: 'empty' })
    expect(out.partial).toBe(true)
  })

  it('never throws: every default-shaped failure collapses to empty rows + flags', async () => {
    const fail = async () => {
      throw new Error('down')
    }
    const out = await fetchUnifiedActivity({
      owner: 'GOWNER',
      baseAccount: '0xbase',
      deps: {
        fetchHistory: fail,
        getTransactions: () => {
          throw new Error('no storage')
        },
        loadDepositLedger: () => {
          throw new Error('no storage')
        },
        fetchAgents: fail,
        fetchKeeper: fail,
        fetchBase: fail,
      },
    })
    expect(out.rows).toEqual([])
    expect(out.partial).toBe(true)
    expect(Object.values(out.sources)).toContain('unavailable')
  })

  it('passes the owner through to the fetchers that need it', async () => {
    const seen = {}
    await fetchUnifiedActivity({
      owner: 'GOWNER',
      deps: {
        fetchHistory: async (owner, opts) => ((seen.history = [owner, opts]), []),
        getTransactions: () => [],
        loadDepositLedger: (owner) => ((seen.ledger = owner), []),
        fetchAgents: async (owner) => ((seen.agents = owner), { status: 'complete', agents: [] }),
        fetchKeeper: async () => [],
      },
    })
    expect(seen.history[0]).toBe('GOWNER')
    expect(seen.ledger).toBe('GOWNER')
    expect(seen.agents).toBe('GOWNER')
  })
})
