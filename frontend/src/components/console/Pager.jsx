// frontend/src/components/console/Pager.jsx
// Tier-D mono pager. Hidden when everything fits on one page.
export default function Pager({ page, pages, onPage }) {
  if (pages <= 1) return null
  return (
    <div className="con-pager">
      <button
        className="btn btn-ghost pos-cta"
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
        aria-label="previous page"
      >
        ‹ prev
      </button>
      <span className="con-pager-info mono tnum">
        {page + 1} / {pages}
      </span>
      <button
        className="btn btn-ghost pos-cta"
        disabled={page >= pages - 1}
        onClick={() => onPage(page + 1)}
        aria-label="next page"
      >
        next ›
      </button>
    </div>
  )
}
