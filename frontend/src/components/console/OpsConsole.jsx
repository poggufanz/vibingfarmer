// frontend/src/components/console/OpsConsole.jsx
// Operations Console — Tier D. Grid shell + zone composition. All data via props;
// app.jsx state machine untouched. One shared 1s clock feeds every countdown.
import { useEffect, useMemo, useState } from 'react'
import './../../console.css'
import CommandStrip from './CommandStrip.jsx'
import SwarmZone from './SwarmZone.jsx'
import CouncilZone from './CouncilZone.jsx'
import PositionsZone from './PositionsZone.jsx'
import KeeperZone from './KeeperZone.jsx'
import MonitorZone from './MonitorZone.jsx'
import LifeboatZone from './LifeboatZone.jsx'
import MandateZone from './MandateZone.jsx'
import { toDisplay } from '../../stellar/format.js'
import { panelState } from '../../stellar/lifeboat.js'

const keeperTrace = (e) => ({
  label: e.kind === 'compound_executed' ? `compounded · +${e.totalGainUsdc} USDC` : `rebalanced · ${e.amountUsdc} USDC`,
  tone: e.kind === 'compound_executed' ? 'ok' : 'info',
  timestamp: e.timestamp || 0,
})
const lifeboatTrace = (e) => ({
  label: e.type === 'derisk' ? 'lifeboat engaged' : e.type === 'resume' ? 'lifeboat resumed' : 'mandate updated',
  tone: e.type === 'derisk' ? 'warn' : e.type === 'resume' ? 'ok' : 'info',
  timestamp: e.timestamp || 0,
})

export default function OpsConsole({
  positions = {},
  vaultMeta = {},
  lastUpdated = null,
  userAddress = null,
  withdrawEnabled = true,
  onWithdrawSuccess,
  onNewStrategy,
  monitorStatus = null,
  loop = null,
  keeper = { events: [], pricePerShare: null, strategies: [] },
  lifeboat = { state: null, events: [], busy: false, onGrant: () => {} },
  scopes = [],
  onRevoke,
  graph = { data: { nodes: [], links: [] }, paletteIsLight: false, pulseEdge: null },
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const nowS = Math.floor(now / 1000)

  const posList = Object.entries(positions)
  const apyOf = (addr) => vaultMeta[addr.toLowerCase()]?.apy || 0
  const totalUnits = posList.reduce((s, [, p]) => s + Number(p.balance || 0), 0)
  const earnedUnits = posList.reduce((s, [, p]) => s + Number(p.unclaimedRewards || 0), 0)
  const blendedApy =
    totalUnits > 0
      ? posList.reduce((s, [a, p]) => s + Number(p.balance || 0) * apyOf(a), 0) / totalUnits
      : 0

  const traceEvents = useMemo(
    () =>
      [...(keeper.events || []).map(keeperTrace), ...(lifeboat.events || []).map(lifeboatTrace)].sort(
        (a, b) => b.timestamp - a.timestamp,
      ),
    [keeper.events, lifeboat.events],
  )
  const lifeboatMode = lifeboat.state ? panelState({ ...lifeboat.state, nowS }) : null
  const running = Boolean(loop?.running)
  const cycling = Boolean(running && loop.phase && loop.phase !== 'sleep')

  return (
    <div className="console enter">
      <CommandStrip
        running={running}
        cycling={cycling}
        phase={loop?.phase}
        cycle={loop?.cycle || 0}
        totalDisplay={toDisplay(totalUnits).toFixed(2)}
        earnedDisplay={toDisplay(earnedUnits).toFixed(4)}
        blendedApy={blendedApy}
        lifeboatMode={lifeboatMode}
        mandateState={lifeboat.state}
        scopesCount={scopes.filter((s) => !s.revoked).length}
        nowS={nowS}
      />
      <SwarmZone
        graphData={graph.data}
        paletteIsLight={graph.paletteIsLight}
        pulseEdge={graph.pulseEdge}
        traceEvents={traceEvents}
        nowMs={now}
      />
      <CouncilZone
        monitorStatus={monitorStatus}
        decisionsRows={loop?.decisionsRows || []}
        decisionsSummary={loop?.decisionsSummary || null}
        nowMs={now}
      />
      <PositionsZone
        positions={positions}
        vaultMeta={vaultMeta}
        lastUpdated={lastUpdated}
        nowMs={now}
        userAddress={userAddress}
        withdrawEnabled={withdrawEnabled}
        onWithdrawSuccess={onWithdrawSuccess}
        onNewStrategy={onNewStrategy}
      />
      <KeeperZone
        events={keeper.events || []}
        pricePerShare={keeper.pricePerShare}
        strategies={keeper.strategies || []}
        nowMs={now}
      />
      <MonitorZone
        running={running}
        rows={loop?.rows || []}
        summary={loop?.summary || null}
        phase={loop?.phase}
        nextTickAt={loop?.nextTickAt || null}
        heartbeatMs={loop?.heartbeatMs || null}
      />
      <LifeboatZone
        state={lifeboat.state}
        events={lifeboat.events || []}
        owner={userAddress}
        onGrant={lifeboat.onGrant}
        busy={lifeboat.busy}
        nowMs={now}
      />
      <MandateZone scopes={scopes} onRevoke={onRevoke} />
    </div>
  )
}
