// frontend/src/components/money/LiveYieldCard.jsx
// G2 follow-up: the production home of P0's live supply-APR + PPS trailing sparkline — the
// same facts KeeperZone renders for the retired console, now on the /home My Money route
// (third section, under Your money and Active grant). Reuses Sparkline
// (console/instruments, pure over display numbers), agoText (consoleUtils), and ppsHistory's
// pure derivations; reads nothing itself — `liveApr`/`series` come from money/liveYield.js
// via the app controller, `nowMs` is the route's explicit presentation clock.
// - APR read failed → "Live APY unavailable" (KeeperZone's own vocabulary), never a number.
// - Fewer than 2 displayable samples → "Price history unavailable", no SVG — an empty chart
//   is not a flat one, and trailingApyPct already refuses to annualize such windows.
// Copy carries no em/en dashes (route-wide a11y ban).
import Sparkline from '../console/instruments/Sparkline.jsx'
import { agoText } from '../console/consoleUtils.js'
import { ppsDisplayValues, selectPpsWindow, trailingApyPct } from '../../history/ppsHistory.js'

const fmtPct = (v) => (v == null ? 'Unavailable' : `${v.toFixed(2)}%`)

export function LiveYieldCard({ liveApr = null, series = [], nowMs, collectionState = null }) {
  // Display age only — chain facts (allowance, PPS) never touch the wall clock; without an
  // explicit route clock this falls back to now so "updated …" can never print NaN.
  const at = Number.isFinite(nowMs) ? nowMs : Date.now()
  // Pre-read states say so (AgentTeam/PositionList precedent): loading must never show even
  // an honest "unavailable" APY line — MyMoneyRoute.test.jsx pins that loading shows Loading
  // and no APY copy at all.
  const preRead =
    collectionState === 'loading'
      ? 'Checking live yield…'
      : collectionState === 'disconnected'
        ? 'Connect a wallet to see live yield.'
        : null
  const aprLive = preRead == null && liveApr?.state === 'live' && Number.isFinite(liveApr?.aprPct)
  const windowed = selectPpsWindow(series, { days: 30, now: at })
  const sparkValues = ppsDisplayValues(windowed)
  const hasHistory = preRead == null && sparkValues.length >= 2
  const apy7 = hasHistory ? trailingApyPct(series, { days: 7, now: at }) : null
  const apy30 = hasHistory ? trailingApyPct(series, { days: 30, now: at }) : null

  return (
    <section className="pc-money-section" aria-labelledby="live-yield-heading" data-pocket-enter>
      <header>
        <h2 id="live-yield-heading">Live yield</h2>
        <p className="pc-money-section-lede">Blend supply rate and your vault's share price.</p>
      </header>
      <div className="pc-money-panel">
        {preRead != null ? (
          <p className="pc-money-empty pc-money-empty--chart">
            <span className="pc-lamp" aria-hidden="true" />
            {preRead}
          </p>
        ) : (
          <>
            {/* Readout strip: the one live number leads; trailing figures only exist once the
                history can back them (trailingApyPct refuses thinner windows). */}
            <dl className="pc-readouts">
              <div className="pc-readout pc-readout--lead" data-tone={aprLive ? 'live' : 'idle'}>
                <dt>Live supply APY</dt>
                <dd className="pc-readout-value">
                  {aprLive ? fmtPct(liveApr.aprPct) : 'Unavailable'}
                </dd>
                {aprLive && (
                  <dd className="pc-readout-note">
                    <span className="pc-lamp" aria-hidden="true" />
                    Updated {agoText(liveApr.asOf, at)}
                  </dd>
                )}
              </div>
              {hasHistory && (
                <>
                  <div className="pc-readout">
                    <dt>7 day trailing APY</dt>
                    <dd className="pc-readout-value">{fmtPct(apy7)}</dd>
                  </div>
                  <div className="pc-readout">
                    <dt>30 day trailing APY</dt>
                    <dd className="pc-readout-value">{fmtPct(apy30)}</dd>
                  </div>
                </>
              )}
            </dl>
            {hasHistory ? (
              <figure className="pc-yield-chart">
                <Sparkline values={sparkValues} label="Price per share" height={96} />
                <figcaption>Price per share, last 30 days</figcaption>
              </figure>
            ) : (
              <p className="pc-money-empty pc-money-empty--chart" role="status">
                <span className="pc-lamp" aria-hidden="true" />
                Price history unavailable
              </p>
            )}
          </>
        )}
      </div>
    </section>
  )
}
