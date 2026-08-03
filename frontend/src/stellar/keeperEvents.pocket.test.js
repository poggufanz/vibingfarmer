// frontend/src/stellar/keeperEvents.pocket.test.js
// Pocket Crew "My money" Task 8 regression coverage for keeperEvents.js. keeperEvents.test.js
// already carries owner changes at plan time (see the Task 8 brief's worktree warning) — this
// file is the Task 8-owned sibling, covering ONLY the new real-ledger-close-time behavior added
// here. It does not re-test anything keeperEvents.test.js already covers, and every existing
// keeperEvents.test.js assertion (exact-shape `toEqual`s with no `ledgerClosedAt` on the fixture)
// must keep passing unmodified — see the full-suite run in the Task 8 report.
import { describe, it, expect } from 'vitest'
import { nativeToScVal } from '@stellar/stellar-sdk'
import { decodeKeeperEvent } from './keeperEvents.js'

function fakeRecord({ type, fields, ledger, pagingToken, ledgerClosedAt }) {
  return {
    ledger,
    pagingToken,
    topic: [nativeToScVal(type, { type: 'symbol' })],
    value: nativeToScVal(fields),
    txHash: 'TX' + pagingToken,
    ...(ledgerClosedAt !== undefined ? { ledgerClosedAt } : {}),
  }
}

describe('decodeKeeperEvent - real ledger close time (Pocket Crew Task 8)', () => {
  it("surfaces closedAt from the record's real ledgerClosedAt, not Date.now()", () => {
    const rec = fakeRecord({
      type: 'vault_compound',
      fields: { total_gain: 1_0000000n, price_per_share: 10_0000000n },
      ledger: 500,
      pagingToken: '9001',
      ledgerClosedAt: '2026-01-01T00:00:00Z',
    })
    const e = decodeKeeperEvent(rec)
    expect(e.closedAt).toBe(Date.parse('2026-01-01T00:00:00Z'))
  })

  it('never manufactures closedAt from Date.now() when ledgerClosedAt is absent', () => {
    const rec = fakeRecord({
      type: 'vault_resume',
      fields: { idle: 1n },
      ledger: 501,
      pagingToken: '9002',
      // no ledgerClosedAt — mirrors every existing keeperEvents.test.js fixture
    })
    const e = decodeKeeperEvent(rec)
    expect('closedAt' in e).toBe(false)
  })

  it('ignores an unparseable ledgerClosedAt rather than falling back to Date.now()', () => {
    const rec = fakeRecord({
      type: 'vault_derisk',
      fields: { reason_code: 1, drained_total: 1n },
      ledger: 502,
      pagingToken: '9003',
      ledgerClosedAt: 'not-a-date',
    })
    const e = decodeKeeperEvent(rec)
    expect('closedAt' in e).toBe(false)
  })

  it('surfaces closedAt on every decoded event type, not just compound', () => {
    const rec = fakeRecord({
      type: 'vault_rebalance',
      fields: { from: 'GA', to: 'GB', amount: 1n },
      ledger: 503,
      pagingToken: '9004',
      ledgerClosedAt: '2026-02-02T00:00:00Z',
    })
    const e = decodeKeeperEvent(rec)
    expect(e.closedAt).toBe(Date.parse('2026-02-02T00:00:00Z'))
  })
})
