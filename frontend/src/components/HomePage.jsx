// frontend/src/components/HomePage.jsx
// My Money Task 13 (Pocket Crew redesign, Wave 5), Step 4. `/home` is reduced to a compact
// launcher: ONE freshness-labeled summary/connection entry, plus the `New deposit` (-> /strategy)
// and `My money` (-> /agent) links. Home is no longer a second portfolio surface -- it consumes
// only the small `{state, total, lastConfirmed}` projection the app's My Money controller derives
// from `buildMyMoneyModel`'s own output (see app.jsx's `projectMoneyForHome`), and renders it
// as-is. It has NO independent APY math, market pulse, withdraw, Base recovery, agent controls, or
// protection controls -- all of that now lives on `/agent` (MyMoneyRoute), the one portfolio
// authority. The old command-center version of this file (market pulse table, yield estimator,
// active-positions withdraw list, Base panel/recovery) is retired outright, not hidden behind a
// flag -- a second place that could show a different number than My Money is exactly the bug this
// task exists to close.
//
// Deliberately NOT ported onto the Pocket Crew `.pc-route`/`.pc-dominant`/`.pc-button` contract:
// `/home` is outside that contract's own required-snapshot list (Foundation shell, Strategy, My
// Money, VF Wallet only -- see the visual contract's DESIGN READ/REQUIRED VISUAL SNAPSHOTS), and
// `.pc-route`/`.pc-route-stack` are intentionally NOT defined in the shared `pocket-crew.css` --
// each route ports the contract into its OWN scoped stylesheet (strategy.css, my-money.css).
// Reaching into either of those (or fabricating a new HomePage.css) would either violate the
// established per-route CSS ownership convention or require a file outside this task's authorized
// list. Home keeps its pre-existing legacy layout (`enter`, `btn`, `link-btn`, inline styles) --
// unchanged look for the parts that survive, just far less of them.
import { t, loadSettings } from '../settingsStore.js'

// Same boundary math every My Money component uses for a canonical {token,units,decimals} amount
// (MoneyHero.jsx's own unitsToDisplay) -- display-only, never touches the underlying bigint.
function unitsToDisplay(units, decimals) {
  return Number(BigInt(units)) / 10 ** decimals
}

// myMoneyModel.js's own documented state list, in plain English -- never re-derived here (Step 4:
// Home "cannot fetch or calculate a second portfolio model"), only relabeled for a one-line
// summary. 'problem' reads as "Needs review", matching MoneyHero's own primary-action copy for the
// same state, so the two surfaces never describe the same fact differently.
const HOME_MONEY_LABEL = Object.freeze({
  disconnected: 'Not connected',
  loading: 'Checking your money…',
  empty: 'No deposits yet',
  current: 'Current',
  stale: 'Stale',
  'partial-discovery': 'Partial',
  problem: 'Needs review',
  unavailable: 'Unavailable',
})

function formatLastConfirmed(lastConfirmed) {
  return Number.isFinite(lastConfirmed) ? new Date(lastConfirmed).toISOString() : null
}

// The ONE freshness-labeled summary/connection entry the brief names -- a single status line,
// never a second figure or a second freshness word competing with it. The freshness word and the
// total are always in the SAME sentence, never a bare number on its own with staleness disclosed
// somewhere else.
function moneySummaryText(projection) {
  const { state, total, lastConfirmed } = projection || {}
  const label = HOME_MONEY_LABEL[state] ?? HOME_MONEY_LABEL.unavailable
  const confirmedIso = formatLastConfirmed(lastConfirmed)
  const value =
    total != null ? `${unitsToDisplay(total.units, total.decimals)} ${total.token}` : null
  return (
    [label, value].filter(Boolean).join(': ') + (confirmedIso ? ` — confirmed ${confirmedIso}` : '')
  )
}

const card = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
}
const cardPad = { ...card, padding: '20px 22px' }
const eyebrow = {
  fontSize: 11,
  letterSpacing: '0.01em',
  color: 'var(--text-muted)',
  textTransform: 'capitalize',
  fontWeight: 500,
}

export default function HomePage({
  userAddress,
  moneyProjection,
  sessionResumed = false,
  onDismissResumed,
  onConnect,
  onStartStrategy,
  onOpenAgent,
}) {
  const settings = loadSettings()
  const lang = settings.language

  return (
    <div className="enter" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 28 }}>
      <div className="home-shell" style={{ maxWidth: 820, margin: '0 auto', width: '100%' }}>
        {sessionResumed && (
          <div
            role="status"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              marginBottom: 20,
              padding: '10px 14px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-strong)',
              background: 'var(--bg-card)',
            }}
          >
            <span style={{ flex: 1, fontSize: 12.5 }}>
              Session resumed — reconnected your wallet.
            </span>
            <button className="link-btn" onClick={onDismissResumed}>
              Dismiss
            </button>
          </div>
        )}

        <div style={{ ...cardPad, marginBottom: 20 }}>
          <div style={{ ...eyebrow, marginBottom: 10 }}>Your money</div>
          {userAddress ? (
            <p role="status" style={{ fontSize: 15, margin: 0 }}>
              {moneySummaryText(moneyProjection)}
            </p>
          ) : (
            <>
              <p role="status" style={{ fontSize: 15, margin: '0 0 14px' }}>
                Not connected
              </p>
              <button className="btn btn-primary" onClick={onConnect}>
                {t(lang, 'connectWallet')}
              </button>
            </>
          )}
        </div>

        <nav aria-label="Quick links" style={{ display: 'flex', gap: 12 }}>
          <button className="btn btn-primary" onClick={() => onStartStrategy?.()}>
            New deposit
          </button>
          <button className="btn btn-ghost" onClick={onOpenAgent}>
            My money
          </button>
        </nav>
      </div>
    </div>
  )
}
