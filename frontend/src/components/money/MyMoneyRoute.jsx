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
        <HowMoneyWorks keeper={keeper} strategyConfig={strategyConfig} riskWatch={riskWatch} yieldInfo={model?.yield} venue={venue} />
        <TechnicalMoneyDetails model={model} agents={agents} />
      </div>
    </div>
  )
}
