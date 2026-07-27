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
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
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

// My Money Task 14 scoped exception (owner-authorized precedent: Strategy Task 14's
// aria-describedby/focus wiring), surfaced while writing the a11y/motion suite: the brief's Step 3
// requires the graph to go still once its disclosure closes, but nothing before this task ever
// stopped PixiSwarmGraph's Pixi ticker on close -- the graph mounts once (TechnicalMoneyDetails.
// test.jsx's own "renders a real node... " test proves it mounts immediately, NOT gated on the
// <details> being open) and, absent this wiring, keeps redrawing every frame forever underneath a
// visually closed disclosure. Fixed via the native `toggle` event (no new prop threaded through
// the shared Primitives.jsx <details> wrapper -- every other TechnicalDetails caller across
// Foundation/Strategy/this route is unaffected) driving PixiSwarmGraph's own new `paused` prop
// (stops/starts the SAME ticker, never destroys the scene -- see PixiSwarmGraph.jsx's own note).
// MM14 fix round 1 (M-1, reviewer finding): `paused` actually starts `true` -- `open` initializes
// `false` (matching `TechnicalDetails`' own closed-by-default state) and `!open` is what this hook
// returns, so the graph is paused from first paint. The mount effect also does NOT wait for a user
// toggle: it runs immediately and calls `setOpen(details.open)` on mount, reconfirming the same
// `true` value the initial state already had. The prior wording here claimed the opposite of both.
// ponytail: this reads the closed-source's own DOM state via a plain `toggle` listener rather than
// widening the shared <details> primitive's prop surface for one caller.
function useGraphDisclosurePaused() {
  const wrapRef = useRef(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const details = wrapRef.current?.querySelector('details')
    if (!details) return undefined
    setOpen(details.open)
    const onToggle = () => setOpen(details.open)
    details.addEventListener('toggle', onToggle)
    return () => details.removeEventListener('toggle', onToggle)
  }, [])
  return [wrapRef, !open]
}

export function TechnicalMoneyDetails({ model, agents = [] }) {
  const [graphWrapRef, graphPaused] = useGraphDisclosurePaused()
  // My Money Task 14: memoized on `agents` itself, not recomputed on every render. Toggling the
  // disclosure re-renders this component (useGraphDisclosurePaused's own `open` state) -- an
  // unmemoized call here would hand PixiSwarmGraph a new `graphData` OBJECT on every toggle, and
  // its own `data = useMemo(..., [strategy, graphData])` would then see a changed reference and
  // tear down + recreate the WHOLE Pixi Application on every open/close (found empirically: with
  // this unmemoized, the pause wiring below appeared to work only because each toggle already
  // rebuilt a fresh, correctly-initialized app from scratch -- reverting the actual stop()/start()
  // effect entirely still passed the graph-pause e2e test, which is what exposed this). Real
  // pause-in-place (positions/particles surviving a close/reopen) requires the app to survive the
  // toggle, which requires this reference to stay stable across it.
  const graphData = useMemo(() => buildAgentNetworkGraphData(agents), [agents])
  return (
    <section className="pc-money-section" aria-labelledby="technical-details-heading">
      <header>
        <h2 id="technical-details-heading">Technical details</h2>
      </header>
      <div>
        {/* Owner decision #19: the container no longer defaults to mono -- these six raw values
            are marked .pc-technical individually so they keep rendering in the mono face. */}
        <TechnicalDetails summary="Freshness and provenance">
          <p>
            State: <span className="pc-technical">{model?.state ?? 'unavailable'}</span>
          </p>
          <p>
            Checked at: <span className="pc-technical">{rawOrUnavailable(model?.checkedAt)}</span>
          </p>
          <p>
            Confirmed ledger (Stellar):{' '}
            <span className="pc-technical">{rawOrUnavailable(model?.confirmedLedger)}</span>
          </p>
          <p>
            Confirmed block (Base):{' '}
            <span className="pc-technical">{rawOrUnavailable(model?.confirmedBlock)}</span>
          </p>
          <p>
            Source: <span className="pc-technical">{rawOrUnavailable(model?.source)}</span>
          </p>
          <p>
            Freshness: <span className="pc-technical">{rawOrUnavailable(model?.freshness)}</span>
          </p>
        </TechnicalDetails>

        {/* Owner decision #19: two raw counts marked .pc-technical individually; the two <pre>
            blocks already stay mono via pocket-crew.css's Foundation-wide `code, pre, .pc-technical`
            rule with no change needed here. */}
        <TechnicalDetails summary="Custody and execution breakdown">
          <p>
            Agent count: <span className="pc-technical">{rawOrUnavailable(model?.agentCount)}</span>
          </p>
          <p>
            Problem agent count:{' '}
            <span className="pc-technical">{rawOrUnavailable(model?.problemAgentCount)}</span>
          </p>
          <pre>{JSON.stringify(model?.custodyBreakdown ?? {}, null, 2)}</pre>
          <pre>{JSON.stringify(model?.unattributed ?? {}, null, 2)}</pre>
        </TechnicalDetails>

        {/* Owner decision #19: the whole raw-fields line is marked .pc-technical (it is entirely
            addresses/state/booleans/numbers, no friendly label prefix worth splitting out). */}
        <TechnicalDetails summary="Raw agent scope fields">
          {agents.length === 0 && <p>No agents to show.</p>}
          {agents.map((agent) => (
            <p key={agent.address} className="pc-technical">
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
        <div ref={graphWrapRef}>
          <TechnicalDetails summary="Agent network graph (advanced)">
            <p>
              Your agents and the vault they deposit into, drawn from the same real data as the list
              above. This never replaces that list -- it only visualizes it.
            </p>
            {agents.length === 0 ? (
              <p>No agents yet to graph.</p>
            ) : (
              <Suspense fallback={<p>Loading graph…</p>}>
                <PixiSwarmGraph graphData={graphData} paused={graphPaused} />
              </Suspense>
            )}
          </TechnicalDetails>
        </div>
      </div>
    </section>
  )
}
