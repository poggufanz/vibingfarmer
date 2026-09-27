// frontend/src/components/money/MyMoneyRoute.jsx
// My Money Task 11 (Pocket Crew redesign, Wave 5). The money-first `/agent` route's composition
// root -- same convention as StrategyRoute.jsx (Strategy Task 10): a pure component tree, no data
// fetching, no wallet/relayer reads. The caller (My Money Task 13 -- NOT this task; nothing here
// is wired into app.jsx yet) owns all real state and passes it in as props.
//
//   1. Your money            -- MoneyHero (the one Rice dominant surface + state-aware action)
//   2. Active grant          -- ActiveGrantCard (P1 G5: persistent router-allowance remainder +
//                                ledger countdown + one-signature Revoke; renders nothing when no
//                                grant is active, so the hierarchy below simply closes ranks)
//   3. Live yield            -- LiveYieldCard (G2 follow-up: P0's live supply-APR + PPS
//                                trailing sparkline, lifted off the retired console; always
//                                rendered, honestly unavailable when reads/history are missing)
//   4. Your position         -- PositionList (rows/dividers, never equal cards)
//   5. Your agent team       -- AgentTeam
//   6. Vault protection      -- VaultProtection
//   7. How your money is working -- HowMoneyWorks
//   8. Technical details     -- TechnicalMoneyDetails (expert capability + the optional,
// This is the ONLY place these sections mount together; each section owns its own literal copy and
// assertions (see each component's own header comment) so this file stays a thin, honest wire-up.
//
// Fix loop 1, I2 (My Money Task 13 review): a 7th, always-rendered "Recover a Base account"
// action is sited LAST (least-prominent, troubleshooting-shaped, like Technical details one
// section up) rather than gated behind RecoveryPanel.jsx. RecoveryPanel can't be the trigger: it
// only opens via app.jsx's openMoneyRecoveryFromOutcomes, i.e. strictly AFTER an owner action has
// already run -- unreachable on a brand-new device with zero local Base state, which is exactly
// the case this action exists to unblock. It never claims custody exists; clicking it only
// triggers a real read (ensureBaseOwner + loadIndexedBasePositions in app.jsx), never a guess.
import { useRef } from 'react'
import './my-money.css'
import { ActiveGrantCard } from './ActiveGrantCard.jsx'
import { LiveYieldCard } from './LiveYieldCard.jsx'
import { usePocketTransition } from '../../design/usePocketTransition.js'
import { MoneyHero, toMoneyFactView } from './MoneyHero.jsx'
import { PositionList } from './PositionList.jsx'
import { AgentTeam } from './AgentTeam.jsx'
import { VaultProtection } from './VaultProtection.jsx'
import { HowMoneyWorks } from './HowMoneyWorks.jsx'
import { TechnicalMoneyDetails } from './TechnicalMoneyDetails.jsx'
import { formatAssetUnits } from '../../money/assetUnits.js'

function basePositionAmount(position) {
  const rawUnits = position?.assets
  const units = typeof rawUnits === 'bigint' ? rawUnits.toString() : rawUnits
  if (typeof units !== 'string' || !/^\d+$/.test(units)) return 'Balance unavailable'
  const decimals =
    Number.isInteger(position?.decimals) && position.decimals >= 0 ? position.decimals : 6
  const token =
    typeof position?.token === 'string' && position.token.trim() ? position.token : 'USDC'
  try {
    return `${formatAssetUnits(units, decimals)} ${token}`
  } catch {
    return 'Balance unavailable'
  }
}

export function MyMoneyRoute({
  model,
  agents = [],
  personaByAddress = null,
  discovery = null,
  account = null,
  keeper,
  strategyConfig,
  riskWatch,
  venue,
  onAction,
  onRecoverAgent,
  onRecoverBase,
  // P1 G5: the persistent grant widget's view-model (money/activeGrant.js) + its one-signature
  // revoke wiring. `grant` defaults to null = no active grant = the card renders nothing.
  grant = null,
  onRevokeGrant,
  revokePending = false,
  revokeError = null,
  // G2 follow-up: P0's live supply-APR + PPS series (money/liveYield.js), loaded by the app
  // controller. Null-safe: the card renders honest unavailable states on its own.
  liveYield = null,
  actionPending = false,
  baseActionsAvailable = true,
  baseUnavailableReason = null,
  baseActionError = null,
  basePlan = null,
  nowMs,
}) {
  // 2026-08-02 polish (motion pass): one restrained section entrance (the shared
  // usePocketTransition treatment StartStage already uses -- 0.32s power3.out, y:8, stagger
  // 0.04, reduced-motion = instant), keyed on the money MODEL STATE so it only replays when the
  // underlying state genuinely changes (loading -> current -> stale...), never on an interval or
  // a re-render. Sections opt in via their own root `data-pocket-enter` attributes.
  const stackRef = useRef(null)
  usePocketTransition(stackRef, model?.state ?? 'unknown')
  const factView = toMoneyFactView(model)

  return (
    <div className="pc-route pc-my-money-route">
      <div className="pc-route-stack" ref={stackRef}>
        <h1>My money</h1>

        <MoneyHero
          model={model}
          factView={factView}
          onAction={onAction}
          actionPending={actionPending}
        />
        <ActiveGrantCard
          grant={grant}
          onRevoke={onRevokeGrant}
          revokePending={revokePending}
          revokeError={revokeError}
        />
        <LiveYieldCard
          liveApr={liveYield?.liveApr ?? null}
          series={liveYield?.series ?? []}
          nowMs={nowMs}
          collectionState={model?.state}
        />
        <PositionList
          agents={agents}
          unattributed={model?.unattributed}
          collectionState={model?.state}
          factView={factView}
          personaByAddress={personaByAddress}
        />
        <AgentTeam
          agents={agents}
          problemAgents={model?.problemAgents ?? []}
          discovery={discovery}
          account={account}
          onRecoverAgent={onRecoverAgent}
          collectionState={model?.state}
          presentationNow={nowMs}
          personaByAddress={personaByAddress}
        />
        <VaultProtection protection={model?.protection} />
        <HowMoneyWorks
          keeper={keeper}
          strategyConfig={strategyConfig}
          riskWatch={riskWatch}
          yieldInfo={model?.yield}
          venue={venue}
        />
        <TechnicalMoneyDetails model={model} factView={factView} agents={agents} />

        {(basePlan?.positions?.length ?? 0) > 0 && (
          <section
            className="pc-money-section"
            aria-labelledby="base-history-heading"
            data-pocket-enter
          >
            <header>
              <h2 id="base-history-heading">Historical Base positions</h2>
            </header>
            <div className="pc-money-panel">
              {!basePlan.available && basePlan.unavailableReason && (
                <p id="base-history-unavailable" role="status">
                  {basePlan.unavailableReason}
                </p>
              )}
              <ul className="pc-position-list">
                {basePlan.positions.map((position) => (
                  <li className="pc-position-row" key={position.pool}>
                    <strong>Base</strong>
                    <span>{position.poolName || position.pool}</span>
                    <span className="pc-money">{basePositionAmount(position)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}

        <section
          className="pc-money-section"
          aria-labelledby="recover-base-heading"
          data-pocket-enter
        >
          <header>
            <h2 id="recover-base-heading">Recover a Base account</h2>
          </header>
          <div className="pc-money-panel">
            <p>
              {(basePlan?.positions?.length ?? 0) > 0
                ? 'Historical Base balances stay visible here. Recovery remains a separate owner action.'
                : 'Settled USDC on Base from a previous device or browser? Check for it here. This device has no local Base record yet.'}
            </p>
            {!baseActionsAvailable && baseUnavailableReason && (
              <p id="recover-base-unavailable" role="status">
                {baseUnavailableReason}
              </p>
            )}
            {baseActionError && baseActionError !== baseUnavailableReason && (
              <p role="alert">{baseActionError}</p>
            )}
            <button
              type="button"
              className="pc-button pc-button--secondary"
              disabled={actionPending || !baseActionsAvailable}
              aria-describedby={
                !baseActionsAvailable && baseUnavailableReason
                  ? 'recover-base-unavailable'
                  : undefined
              }
              onClick={() => {
                if (baseActionsAvailable) onRecoverBase?.()
              }}
            >
              Recover Base account
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
