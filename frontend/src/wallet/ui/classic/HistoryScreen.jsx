export default function HistoryScreen({ items }) {
  if (!items?.length)
    return (
      <div className="vf-screen">
        <p>No activity yet.</p>
      </div>
    )
  return (
    <ul className="vf-screen vf-history">
      {items.map((x) => (
        <li key={x.id} className={x.direction}>
          <span>
            {x.direction === 'in' ? '↓' : '↑'} {x.amount}{' '}
            {x.asset === 'XLM' ? 'XLM' : x.asset.split(':')[0]}
          </span>
          <span className="vf-muted">{x.direction === 'in' ? x.from : x.to}</span>
          <time>{x.createdAt}</time>
        </li>
      ))}
    </ul>
  )
}
