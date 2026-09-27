// frontend/src/components/strategy/RisksGateModal.jsx
// P1 G7: the once-per-wallet gate in front of the FIRST grant. app.jsx opens this instead of
// dispatching GRANT_REQUESTED when risksAck.js says the wallet still owes its acknowledgement;
// confirming (checkbox first, then the button) persists the ack and hands the run back to the
// normal grant flow, while closing/dismissing rejects so ProtectStage shows its usual
// wallet-class "Nothing moved" failure with a safe retry (which reopens this gate).
// Pure component tree like StopAccessDialog: no storage reads here — open/onConfirm/onClose
// are all owned by the app controller.
import { useEffect, useState } from 'react'
import { Dialog } from '../pocket/Primitives.jsx'
import { RisksContent } from './RisksContent.jsx'

export function RisksGateModal({ open, onConfirm, onClose }) {
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    if (open) setChecked(false)
  }, [open ])

  return (
    <Dialog
      open={open}
      title="Understand the risks"
      description="Your first grant needs one acknowledgement, stored on this device only."
      onClose={onClose}
      actions={
        <>
          <button type="button" className="pc-button pc-button--secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="pc-button pc-button--primary"
            disabled={!checked}
            aria-disabled={!checked}
            onClick={() => {
              if (checked) onConfirm?.()
            }}
          >
            Acknowledge and continue
          </button>
        </>
      }
    >
      <RisksContent />
      <label className="pc-risks-ack">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
        />
        Saya paham risiko di atas dan ingin melanjutkan.
      </label>
    </Dialog>
  )
}
