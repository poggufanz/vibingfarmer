// frontend/src/components/settings/LegacyAutoExitCleanup.jsx
// Pocket Crew "My money" Task 10: replaces the old "Auto-Exit" settings tab (deleted along with
// its live enable/edit controls and the production execution loop it drove). This surface only
// INSPECTS the four legacy localStorage families that loop used to write and lets the owner
// delete them explicitly — it never executes, schedules, or authorizes a fund movement, never
// deletes anything on load, and never calls a local delete "revocation" (deleting a browser
// record does not change an on-chain registered signer; only an owner-signed on-chain transaction
// does that).
//
// Visual contract (docs/superpowers/specs/2026-07-23-pocket-crew-visual-contract.css, local-only):
// this is a destructive-cleanup / consent-adjacent control, so it deliberately carries NO entrance
// animation (MOTION_INTENSITY 1-2 for consent/revoke/withdraw surfaces) and its confirmation uses
// the shared Dialog primitive rather than a bespoke modal.
import { useMemo, useState } from 'react'
import { scanLegacyAutoExit, deleteLegacyAutoExitKeys } from '../../money/legacyAutoExit.js'
import { Dialog } from '../pocket/Primitives.jsx'

const KIND_LABEL = {
  exitRules: 'Auto-exit rules',
  lastExitTrip: 'Last auto-exit trigger',
  exitKey: 'Exit-signer key cache',
  exitInflight: 'In-progress exit lock',
}

function short(address) {
  if (!address || typeof address !== 'string') return 'unknown address'
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`
}

function rowSubject(row) {
  return row.owner ? { role: 'Owner', address: row.owner } : { role: 'Agent', address: row.agent }
}

// Presentation only — every fact here comes straight from the row money/legacyAutoExit.js already
// computed; this function never re-derives or guesses at on-chain state.
function rowDetail(row) {
  if (!row.readable) {
    return 'Could not be read. The stored value is missing or corrupted.'
  }
  switch (row.kind) {
    case 'exitRules': {
      const bits = [row.authorized ? 'was authorized' : 'was never authorized']
      if (row.enabledTriggers.length) bits.push(`triggers: ${row.enabledTriggers.join(', ')}`)
      if (row.expiryAt != null) bits.push(row.expired ? 'expired' : 'not yet expired')
      return bits.join(', ')
    }
    case 'lastExitTrip':
      return `Last tripped ${new Date(row.lastTrippedAt).toLocaleString()}`
    case 'exitKey':
      return row.supersededByManualKey
        ? 'A newer manual withdraw key exists for this agent. This legacy key likely no longer matches the on-chain signer.'
        : 'No newer manual withdraw key was found for this agent on this device. Whether this legacy key still matches the on-chain signer cannot be confirmed here.'
    case 'exitInflight':
      return row.expired ? 'Lock expired. Safe to clear.' : 'Lock still within its expiry window.'
    default:
      return ''
  }
}

export default function LegacyAutoExitCleanup({ addLog } = {}) {
  const [scan, setScan] = useState(() => scanLegacyAutoExit())
  const [selected, setSelected] = useState(() => new Set())
  const [confirming, setConfirming] = useState(false)

  const rows = scan.rows

  const toggleRow = (key) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectedKeys = useMemo(
    () => rows.map((r) => r.key).filter((k) => selected.has(k)),
    [rows, selected]
  )

  const handleConfirmDelete = () => {
    const { deleted } = deleteLegacyAutoExitKeys(selectedKeys)
    if (addLog && deleted.length) {
      addLog({
        event: 'OrchestratorPlanned',
        meta: `Cleared ${deleted.length} legacy auto-exit local record${deleted.length === 1 ? '' : 's'} from this browser.`,
      })
    }
    setScan(scanLegacyAutoExit())
    setSelected(new Set())
    setConfirming(false)
  }

  if (scan.failed) {
    return (
      <div>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--danger)', lineHeight: 1.55 }}>
          This browser's storage could not be scanned right now, so it is unknown whether any
          legacy auto-exit data remains. Nothing has been deleted.
        </p>
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55 }}>
          No legacy auto-exit data found on this device. The autonomous auto-exit feature has
          been removed from the app. This app no longer moves money on its own.
        </p>
      </div>
    )
  }

  return (
    <div>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55 }}>
        The autonomous auto-exit feature has been removed. This app no longer moves money on its
        own. Below are leftover browser records from that older feature. Deleting them only clears
        this browser; it does not change any on-chain signer registration.
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows.map((row) => {
          const subject = rowSubject(row)
          const label = `${KIND_LABEL[row.kind] || row.kind} for ${subject.role.toLowerCase()} ${short(subject.address)}`
          return (
            <li
              key={row.key}
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'flex-start',
                padding: '12px 0',
                borderBottom: '1px solid var(--border)',
                minWidth: 0,
              }}
            >
              <input
                type="checkbox"
                aria-label={label}
                checked={selected.has(row.key)}
                onChange={() => toggleRow(row.key)}
                style={{ marginTop: 4, flex: 'none' }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{KIND_LABEL[row.kind] || row.kind}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', wordBreak: 'break-word' }}>
                  {subject.role}: <span className="pc-technical">{short(subject.address)}</span>
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: row.readable ? 'var(--text-muted)' : 'var(--danger)',
                    marginTop: 4,
                  }}
                >
                  {rowDetail(row)}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
      <div style={{ marginTop: 16 }}>
        <button
          type="button"
          disabled={selectedKeys.length === 0}
          onClick={() => setConfirming(true)}
          style={{
            appearance: 'none',
            border: '1px solid var(--danger)',
            borderRadius: 'var(--radius-sm)',
            background: 'transparent',
            color: 'var(--danger)',
            font: 'inherit',
            fontSize: 12,
            fontWeight: 600,
            padding: '8px 16px',
            cursor: selectedKeys.length === 0 ? 'not-allowed' : 'pointer',
            opacity: selectedKeys.length === 0 ? 0.5 : 1,
          }}
        >
          Delete selected ({selectedKeys.length})
        </button>
      </div>

      <Dialog
        open={confirming}
        title="Delete this browser's legacy auto-exit data?"
        description="This removes the records below from this browser only. It cannot start a withdrawal, and it does not change any on-chain signer registration."
        onClose={() => setConfirming(false)}
        actions={
          <>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              style={{
                appearance: 'none',
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--radius-sm)',
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
                fontSize: 12,
                fontWeight: 600,
                padding: '8px 16px',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmDelete}
              style={{
                appearance: 'none',
                border: '1px solid var(--danger)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--danger)',
                color: 'var(--pc-owned-ink)',
                font: 'inherit',
                fontSize: 12,
                fontWeight: 700,
                padding: '8px 16px',
                cursor: 'pointer',
              }}
            >
              Delete {selectedKeys.length} record{selectedKeys.length === 1 ? '' : 's'}
            </button>
          </>
        }
      >
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
          {selectedKeys.map((k) => (
            <li key={k} className="pc-technical" style={{ wordBreak: 'break-all' }}>
              {k}
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  )
}
