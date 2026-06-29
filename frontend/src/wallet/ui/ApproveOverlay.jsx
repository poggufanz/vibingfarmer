export function ApproveOverlay({ verdict, simulate, onApprove, onReject }) {
  const eligible = !!verdict?.allow
  return (
    <div role="dialog" aria-label="Approve transaction">
      <p data-testid="verdict" data-eligible={eligible}>
        {eligible ? 'Eligible' : 'Not eligible'} — {(verdict?.reasons ?? []).join('; ')}
      </p>
      <p data-testid="amount">Shares out: {simulate?.sharesOut ?? '—'}</p>
      <button onClick={onReject}>Cancel</button>
      <button disabled={!eligible} onClick={onApprove}>Approve with Face ID</button>
    </div>
  )
}
