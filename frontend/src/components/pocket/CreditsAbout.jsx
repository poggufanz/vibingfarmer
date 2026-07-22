// frontend/src/components/pocket/CreditsAbout.jsx
// Settings -> About's network credits block (Foundation Task 6). Every trademark line is read
// straight from the canonical NETWORK_CREDITS manifest (src/design/networks.js) -- never
// hand-copied here or in SettingsPage.jsx -- so a brand-policy edit only ever needs to happen in
// one place. NetworkBadge already renders each mark as decorative (alt="") and the name as
// visible text, so this component adds only the trademark/source-link/independence copy on top.
import { useId } from 'react'
import { NETWORK_CREDITS } from '../../design/networks.js'
import { NetworkBadge } from './NetworkIdentity.jsx'

export function CreditsAbout({ className = '' }) {
  const headingId = useId()

  return (
    <section
      className={`pc-credits-about${className ? ` ${className}` : ''}`}
      aria-labelledby={headingId}
    >
      <h4 id={headingId} className="pc-credits-about-title">
        Network credits
      </h4>
      <p className="pc-credits-independence">
        Vibing Farmer is not sponsored by or affiliated with Stellar Development Foundation or Base.
      </p>
      <ul className="pc-credits-list">
        {NETWORK_CREDITS.map((net) => (
          <li key={net.id} className="pc-credits-item">
            <NetworkBadge networkId={net.id} />
            <p className="pc-credits-trademark">{net.trademarkNotice}</p>
            <a href={net.sourceUrl} target="_blank" rel="noopener noreferrer">
              {net.label} brand resources (opens in a new tab)
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}
