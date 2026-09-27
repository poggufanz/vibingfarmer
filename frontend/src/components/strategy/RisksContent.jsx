// frontend/src/components/strategy/RisksContent.jsx
// P1 G7: the six risks, rendered identically on the /risks page and inside the first-grant
// gate modal — one content definition (strategy/risks.js), never two copies that can drift.
// Pure presentational list; the caller owns the surrounding page/dialog chrome.
import { RISKS } from '../../strategy/risks.js'

export function RisksContent() {
  return (
    <ul className="pc-risks-list">
      {RISKS.map((risk) => (
        <li key={risk.id} className="pc-risks-row">
          <h3>{risk.title}</h3>
          <p>{risk.body}</p>
          <p>Mitigation: {risk.mitigation}</p>
        </li>
      ))}
    </ul>
  )
}
