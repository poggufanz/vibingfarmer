// frontend/src/components/money/TechnicalMoneyDetails.jsx
// My Money Task 11 (Pocket Crew redesign, Wave 5). "Technical details": the expert-capability
// disclosure sink for this route -- raw scope fields, the freshness triple (checkedAt/
// confirmedLedger/confirmedBlock/source), custody/execution breakdowns, and (last, per Step 4 +
// the brief's own DOM-list-before-graph rule) the optional agent-graph disclosure. Exercised via
// MyMoneyRoute.test.jsx (no dedicated test per the brief's Files list) AND its own
// TechnicalMoneyDetails.test.jsx (My Money Task 13 Part B item 8, added once this component could
// mount PixiSwarmGraph directly).
//
// My Money Task 13 Part B item 8: the placeholder text below is retired for a REAL graph, built
// from `agents` -- the exact same real per-agent rows AgentTeam/PositionList (both mounted ahead of
// this section in MyMoneyRoute) already render as DOM list rows. MyMoneyRoute is a pure
// composition root (outside this task's authorized file list) that only ever forwards `model` and
// `agents` into this component -- so the adapter below deliberately stays a pure reshape of props
// already in hand, no new chain read, no new prop threaded through an unauthorized file.
//
// This is NOT the per-run orchestrator/worker/step graph `src/graph/topology.js`'s buildGraphData
// draws from a live `strategy` object (swap/approve/deposit steps) -- MyMoneyRoute reflects
// DURABLE chain state via discovery, not an in-memory execution run, so there is no `strategy`
// shape to adapt to here. Instead this builds the simpler, equally real topology this route DOES
// have proof of: one node per known agent address, one vault node, and a link for each -- using
// PixiSwarmGraph's own `graphData` escape hatch (bypasses buildGraphData(strategy) entirely, see
// PixiSwarmGraph.jsx:42-45), so no `strategy`/`execMap` adaptation is needed at all.
// What remains out of scope: click-through from a graph node back to its AgentTeam row (no
// `onAgentClick` wired), and this component has no theme/palette signal to pass as
// `paletteIsLight` (falls back to PixiSwarmGraph's own default) -- neither affects correctness of
// what the graph shows, only its polish.
//
// PixiSwarmGraph is `lazy()`-loaded here, not a top-level static import: this file is itself a
// plain (non-lazy) import reached from MyMoneyRoute.jsx -> app.jsx, so a static import of
// PixiSwarmGraph would pull pixi.js's own weight into the SAME eager chunk every `/agent` visit
// downloads, even for an owner who never opens this disclosure -- verified via a clean
// `rm -rf dist && npm run build` A/B (pixi's CanvasContextSystem code present in the eager main
// chunk with a static import here, absent with lazy()).
import { lazy, Suspense } from 'react'
import { TechnicalDetails } from '../pocket/Primitives.jsx'
import { SOROBAN_ACTIVE_VAULT_ADDRESS } from '../../stellar/config.js'

const PixiSwarmGraph = lazy(() =>
  import('../../graph/PixiSwarmGraph.jsx').then((m) => ({ default: m.PixiSwarmGraph }))
)

function rawOrUnavailable(value) {
  return value === null || value === undefined ? 'Unavailable' : String(value)
}

// Pure reshape of `agents` into PixiSwarmGraph's {nodes, links} contract -- every node id is a
// REAL address already rendered above (AgentTeam's own <li> rows), never a fabricated one. Agents
// with no address are skipped (mirrors positionsStore.js's own "zero/blank addresses dropped"
// convention) rather than rendered as an anonymous node.
function buildAgentNetworkGraphData(agents) {
  const nodes = [{ id: SOROBAN_ACTIVE_VAULT_ADDRESS, name: 'Your vault', kind: 'vault' }]
  const links = []
  for (const agent of agents) {
    if (!agent?.address) continue
    nodes.push({ id: agent.address, name: agent.address, kind: 'worker', agentId: agent.address })
    links.push({ source: agent.address, target: SOROBAN_ACTIVE_VAULT_ADDRESS })
  }
  return { nodes, links }
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
            See this file's header for the adapter this graph is built from -- it supplements the
            lists above, it never replaces them (those lists mount unconditionally, above). */}
        <TechnicalDetails summary="Agent network graph (advanced)">
          <p>
            Your agents and the vault they deposit into, drawn from the same real data as the list
            above. This never replaces that list -- it only visualizes it.
          </p>
          {agents.length === 0 ? (
            <p>No agents yet to graph.</p>
          ) : (
            <Suspense fallback={<p>Loading graph…</p>}>
              <PixiSwarmGraph graphData={buildAgentNetworkGraphData(agents)} />
            </Suspense>
          )}
        </TechnicalDetails>
      </div>
    </section>
  )
}
