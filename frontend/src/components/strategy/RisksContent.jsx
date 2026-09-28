// frontend/src/components/strategy/RisksContent.jsx
// P1 G7: the six risks, rendered identically on the /risks page and inside the first-grant
// gate modal — one content definition (strategy/risks.js), never two copies that can drift.
// Pure presentational register; the caller owns the surrounding page/dialog chrome.
// Each row reads left to right: what can go wrong, then the guard that already ships.
import { RISKS } from '../../strategy/risks.js'
import './risks.css'

export function RisksContent() {
  return (
    <ol className="pc-risks-list">
      {RISKS.map((risk, index) => (
        <li key={risk.id} className="pc-risks-row">
          <div className="pc-risks-exposure">
            <p className="pc-risks-tag">
              <span className="pc-risks-index" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              {risk.area}
            </p>
            <h3 className="pc-risks-name">{risk.title}</h3>
            <p className="pc-risks-body">{risk.body}</p>
          </div>
          <div className="pc-risks-guard" data-tone="live">
            <p className="pc-risks-guard-label">
              <span className="pc-risks-lamp" aria-hidden="true" />
              Mitigation shipped
            </p>
            <p className="pc-risks-mitigation">{risk.mitigation}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}
