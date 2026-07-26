// frontend/src/components/money/TechnicalMoneyDetails.jsx
// My Money Task 11 (Pocket Crew redesign, Wave 5). "Technical details": the expert-capability
// disclosure sink for this route -- raw scope fields, the freshness triple (checkedAt/
// confirmedLedger/confirmedBlock/source), custody/execution breakdowns, and (last, per Step 4 +
// the brief's own DOM-list-before-graph rule) the optional agent-graph disclosure. Exercised via
// MyMoneyRoute.test.jsx (no dedicated test per the brief's Files list).
//
// The graph placeholder below is intentionally NOT a real Pixi/force-graph render. Wiring
// src/graph/PixiSwarmGraph.jsx would mean adapting its `strategy`/`execMap` prop contract (built
// for the legacy console) to MyMoneyModelV1 -- a real integration task of its own, and outside
// this task's twelve-file scope (no graph-adapter file appears in the brief's Files list). What
// Step 1 actually requires is structural: every position/agent DOM list renders BEFORE this
// disclosure, and the disclosure never replaces those lists. A labeled, honest placeholder proves
// that ordering without pretending to be a finished graph.
import { TechnicalDetails } from '../pocket/Primitives.jsx'

function rawOrUnavailable(value) {
  return value === null || value === undefined ? 'Unavailable' : String(value)
}

export function TechnicalMoneyDetails({ model, agents = [] }) {
  return (
    <section className="pc-money-section" aria-labelledby="technical-details-heading">
      <header>
        <h2 id="technical-details-heading">Technical details</h2>
      </header>
      <div>
        <TechnicalDetails summary="Freshness and provenance">
          <p>State: {model?.state ?? 'unavailable'}</p>
          <p>Checked at: {rawOrUnavailable(model?.checkedAt)}</p>
          <p>Confirmed ledger (Stellar): {rawOrUnavailable(model?.confirmedLedger)}</p>
          <p>Confirmed block (Base): {rawOrUnavailable(model?.confirmedBlock)}</p>
          <p>Source: {rawOrUnavailable(model?.source)}</p>
          <p>Freshness: {rawOrUnavailable(model?.freshness)}</p>
        </TechnicalDetails>

        <TechnicalDetails summary="Custody and execution breakdown">
          <p>Agent count: {rawOrUnavailable(model?.agentCount)}</p>
          <p>Problem agent count: {rawOrUnavailable(model?.problemAgentCount)}</p>
          <pre>{JSON.stringify(model?.custodyBreakdown ?? {}, null, 2)}</pre>
          <pre>{JSON.stringify(model?.unattributed ?? {}, null, 2)}</pre>
        </TechnicalDetails>

        <TechnicalDetails summary="Raw agent scope fields">
          {agents.length === 0 && <p>No agents to show.</p>}
          {agents.map((agent) => (
            <p key={agent.address}>
              {agent.address}: scope={agent.scope?.state ?? 'unavailable'}, revoked=
              {rawOrUnavailable(agent.scope?.value?.revoked)}, expiry=
              {rawOrUnavailable(agent.scope?.value?.expiry)}, executionStatus=
              {rawOrUnavailable(agent.executionStatus)}, problems=
              {(agent.problems ?? []).join(', ') || 'none'}
            </p>
          ))}
        </TechnicalDetails>

        {/* Optional graph disclosure -- deliberately LAST, after every real DOM list this route
            renders (PositionList/AgentTeam, both mounted ahead of this section in MyMoneyRoute).
            See this file's header for why no real graph library is wired here yet. */}
        <TechnicalDetails summary="Agent network graph (advanced)">
          <p>
            A visual agent network graph is planned for this space. It will only ever supplement the
            lists above, never replace them.
          </p>
        </TechnicalDetails>
      </div>
    </section>
  )
}
