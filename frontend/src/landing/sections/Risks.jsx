// Trust content stays calm on purpose: no decorative motion in this section.
import './risks.css'

const SECURITY_URL = 'https://github.com/poggufanz/vibingfarmer/blob/main/SECURITY.md'
const DOCS_URL = 'https://vibingfarmer.gitbook.io/vibingfarmer/'
const WHITEPAPER_URL = '/vibing-farmer-whitepaper.pdf'

const LIVE = [
  'One-signature grant through the funding router',
  'Blend lending position held by the vault',
  'Fee-bump relay sponsoring worker transactions',
  'Lifeboat de-risk drill',
  'CCTP corridor to Base Sepolia',
]

const RISKS = [
  'Testnet only. No real funds are at stake.',
  'Lending markets can reach high utilisation, which can delay withdrawals.',
  'AI can be wrong, so deterministic gates and your review sit before execution.',
  'If the relay is down, the grant falls back to a user-paid submission.',
  'The Base leg is a stand-in: its pools hold bridged USDC one-to-one and pay no yield.',
]

export default function Risks() {
  return (
    <section
      className="vf-section vf-risks"
      data-landing-section="Risks"
      aria-labelledby="risks-title"
    >
      <div className="vf-section-head">
        <p className="vf-kicker">05 · Risks &amp; status</p>
        <h2 id="risks-title">What is live, and what can go wrong.</h2>
        <p>Vibing Farmer is testnet software. Read this before you farm.</p>
      </div>

      <div className="vf-risks__grid">
        <div className="vf-risks__col">
          <h3>Live-proven on testnet</h3>
          <ul className="vf-risks__list vf-risks__list--live">
            {LIVE.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="vf-risks__col">
          <h3>Know before you farm</h3>
          <ul className="vf-risks__list vf-risks__list--risk">
            <li>
              Not independently audited. The threat model and residual risks are in{' '}
              <a href={SECURITY_URL} target="_blank" rel="noreferrer">
                SECURITY.md
              </a>
              .
            </li>
            {RISKS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>

      <p className="vf-risks__links">
        <a className="vf-text-link" href={DOCS_URL} target="_blank" rel="noreferrer">
          Read the docs
        </a>
        <a className="vf-text-link" href={WHITEPAPER_URL} target="_blank" rel="noreferrer">
          Whitepaper (PDF)
        </a>
      </p>
    </section>
  )
}
