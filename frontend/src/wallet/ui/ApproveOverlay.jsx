// Verdict-first approve card. Classes resolve from the popup's injected Acid Yield
// stylesheet; data-testid hooks + verdict→amount DOM order are part of the test contract.
export function ApproveOverlay({ verdict, simulate, onApprove, onReject }) {
  const eligible = !!verdict?.allow
  return (
    <div className="approve" role="dialog" aria-label="Approve transaction">
      <div className="eyebrow">
        <span className="dot">·</span>
        <span className="sec">approve</span>
        <span className="rule" />
        <span>f8 gate</span>
      </div>
      <p
        className={'approve-verdict ' + (eligible ? 'ok' : 'bad')}
        data-testid="verdict"
        data-eligible={eligible}
      >
        {eligible ? 'Eligible' : 'Not eligible'}: {(verdict?.reasons ?? []).join('; ')}
      </p>
      <div className="row">
        <span className="row-k">shares out</span>
        <span className="row-v mono tnum" data-testid="amount">
          {simulate?.sharesOut ?? '-'}
        </span>
      </div>
      <div className="btn-row">
        <button className="btn btn-ghost" onClick={onReject}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!eligible} onClick={onApprove}>
          Approve with Face ID
        </button>
      </div>
    </div>
  )
}
