// frontend/src/components/money/MyMoneyRoute.jsx
// My Money Task 11 (Pocket Crew redesign, Wave 5). The money-first `/agent` route's composition
// root -- same convention as StrategyRoute.jsx (Strategy Task 10): a pure component tree, no data
// fetching, no wallet/relayer reads. The caller (My Money Task 13 -- NOT this task; nothing here
// is wired into app.jsx yet) owns all real state and passes it in as props.
//
// Renders EXACTLY the approved hierarchy (brief Step 2), in this order:
//   1. Your money            -- MoneyHero (the one Rice dominant surface + state-aware action)
//   2. Your position         -- PositionList (rows/dividers, never equal cards)
//   3. Your agent team       -- AgentTeam
//   4. Vault protection      -- VaultProtection
//   5. How your money is working -- HowMoneyWorks
//   6. Technical details     -- TechnicalMoneyDetails (expert capability + the optional,
//                                DOM-list-last graph disclosure)
// This is the ONLY place these six mount together; each section owns its own literal copy and
// assertions (see each component's own header comment) so this file stays a thin, honest wire-up.
//
// Fix loop 1, I2 (My Money Task 13 review): a 7th, always-rendered "Recover a Base account"
// action is sited LAST (least-prominent, troubleshooting-shaped, like Technical details one
// section up) rather than gated behind RecoveryPanel.jsx. RecoveryPanel can't be the trigger: it
// only opens via app.jsx's openMoneyRecoveryFromOutcomes, i.e. strictly AFTER an owner action has
// already run -- unreachable on a brand-new device with zero local Base state, which is exactly
// the case this action exists to unblock. It never claims custody exists; clicking it only
// triggers a real read (ensureBaseOwner + loadIndexedBasePositions in app.jsx), never a guess.
import './my-money.css'
import { MoneyHero } from './MoneyHero.jsx'
import { PositionList } from './PositionList.jsx'
import { AgentTeam } from './AgentTeam.jsx'
import { VaultProtection } from './VaultProtection.jsx'
import { HowMoneyWorks } from './HowMoneyWorks.jsx'
import { TechnicalMoneyDetails } from './TechnicalMoneyDetails.jsx'

export function MyMoneyRoute({
  model,
  agents = [],
  discovery = null,
  account = null,
  keeper,
  strategyConfig,
  riskWatch,
  venue,
  onAction,
  onRecoverAgent,
  onRecoverBase,
  actionPending = false,
}) {
  return (
    <div className="pc-route pc-my-money-route">
      <div className="pc-route-stack">
        <h1>My money</h1>

        <MoneyHero model={model} onAction={onAction} actionPending={actionPending} />
        <PositionList agents={agents} unattributed={model?.unattributed} />
        <AgentTeam
          agents={agents}
          problemAgents={model?.problemAgents ?? []}
          discovery={discovery}
          account={account}
          onRecoverAgent={onRecoverAgent}
        />
        <VaultProtection protection={model?.protection} />
        <HowMoneyWorks
          keeper={keeper}
          strategyConfig={strategyConfig}
          riskWatch={riskWatch}
          yieldInfo={model?.yield}
          venue={venue}
        />
        <TechnicalMoneyDetails model={model} agents={agents} />

        <section className="pc-money-section" aria-labelledby="recover-base-heading">
          <header>
            <h2 id="recover-base-heading">Recover a Base account</h2>
          </header>
          <p>
            Settled USDC on Base from a previous device or browser? Check for it here -- this device
            has no local Base record yet.
          </p>
          <button
            type="button"
            className="pc-button pc-button--secondary"
            disabled={actionPending}
            onClick={onRecoverBase}
          >
            Recover Base account
          </button>
        </section>
      </div>
    </div>
  )
}
