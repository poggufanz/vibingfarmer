// frontend/src/components/crew/CrewLanes.jsx
// Task 9 (Pocket Crew design alignment). One lane per deployed agent, keyed by its own stable
// address -- same identity rule AgentMark.jsx/AgentTeam.jsx already enforce (never a list index).
//
// Consumes the SAME raw `moneyRead.agents` rows AgentTeam.jsx/PositionList.jsx do
// (readOwnerMoney.js:317-327 -- {address, scope, amount, executionStatus, custody, problems, ...}).
// `unitsToDisplay` below is that same one-liner boundary math MoneyHero.jsx/PositionList.jsx
// already declare locally for a canonical {token,units,decimals} amount (division only, never a
// `BigInt(Math.round(x*N))` multiply -- this plan has white-screened three times on exactly that
// pattern; there is no multiply anywhere in this file).
import { AgentMark } from '../pocket/AgentMark.jsx'
import { MoneyFigure } from '../pocket/Primitives.jsx'

function unitsToDisplay(units, decimals) {
  return Number(BigInt(units)) / 10 ** decimals
}

function shortAddress(address) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`
}

// Revoked -> AgentMark's own 'idle' (not yet live); a confirmed problem -> 'failed'; mid-flight ->
// 'active'; otherwise this lane is doing its job -> 'confirmed'. Mirrors AgentTeam.jsx's own
// markStateFor precedence.
function markStateFor(agent) {
  if (agent?.scope?.value?.revoked) return 'idle'
  if (agent?.problems?.length) return 'failed'
  if (agent?.executionStatus === 'executing') return 'active'
  return 'confirmed'
}

// Calm plain English (brief: "Nothing moves." / "You can take it out any time") -- never the raw
// enum value.
function laneNote(agent) {
  if (agent?.scope?.value?.revoked) return 'Cancelled — cannot spend anything'
  if (agent?.problems?.length) return 'Needs recovery'
  if (agent?.executionStatus === 'executing') return 'Working right now'
  if (agent?.custody?.location === 'stellar-vault') return 'Deposited · in the vault'
  return 'Active'
}

export function CrewLanes({ agents = [], onCancelAgent, actionPending = false }) {
  return (
    <section className="pc-crew-lanes-section" aria-labelledby="crew-lanes-heading">
      <h2 id="crew-lanes-heading" className="pc-crew-stat-label">
        Your crew
      </h2>
      <ul className="pc-crew-lanes">
        {agents.map((agent, index) => {
          const revoked = Boolean(agent?.scope?.value?.revoked)
          return (
            <li key={agent.address} className="pc-crew-lane" data-revoked={revoked}>
              {/* Fix round 2, F6: `label` renders as a real visible <text> glyph inside the mark
                  body (AgentMark.jsx:143-147), not merely an aria-label -- every other call site
                  (PlanStage.jsx/StartStage.jsx/ProtectStage.jsx) passes a 1-2 char label for
                  exactly that reason. The 9-char short address round 1 passed here overflowed the
                  36px mark. The 1-based lane number matches that same established convention
                  (`String(index + 1)`) and still gives each lane a distinct accessible name, which
                  is all M11 asked for -- `identity` (never `index`) remains the real per-agent
                  color seed, so reordering the array still never reassigns any agent's color. */}
              <AgentMark
                identity={agent.address}
                size={36}
                state={markStateFor(agent)}
                label={String(index + 1)}
              />
              <div>
                <p className="pc-crew-lane-address">{shortAddress(agent.address)}</p>
                <p className="pc-crew-lane-note">{laneNote(agent)}</p>
              </div>
              <div className="pc-crew-lane-right">
                {agent.amount ? (
                  <MoneyFigure
                    state="current"
                    value={unitsToDisplay(agent.amount.units, agent.amount.decimals)}
                    currency={agent.amount.token}
                  />
                ) : (
                  <span className="pc-money pc-money--unknown">Unavailable</span>
                )}
                {!revoked && (
                  <button
                    type="button"
                    className="pc-button pc-button--secondary"
                    disabled={actionPending}
                    onClick={() => onCancelAgent?.(agent.address)}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
