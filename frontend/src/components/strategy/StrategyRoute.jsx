// frontend/src/components/strategy/StrategyRoute.jsx
// Strategy Task 10 (Pocket Crew redesign, Wave 5). The `/strategy` route's composition root:
// the three-step progress nav (StrategyProgress) above the current stage's surface. Only the
// Plan stage exists yet (Protect/Start are later Wave 5 tasks) -- this file adds their branches
// when those surfaces exist rather than guessing their shape now.
//
// A pure component tree: no data fetching, no wallet/relayer reads, no app.jsx wiring. Task 13
// mounts this inside the real app shell (`.pc-app-shell`/`.pc-app-main`) and supplies every prop
// from real state; until then this file is not imported anywhere.
import './strategy.css'
import { StrategyProgress } from './StrategyProgress.jsx'
import { PlanStage } from './PlanStage.jsx'

export function StrategyRoute({ stage = 'plan', reached, onNavigateStage, ...planStageProps }) {
  return (
    <div className="pc-route">
      <div className="pc-route-stack">
        <StrategyProgress current={stage} reached={reached} onNavigate={onNavigateStage} />
        {stage === 'plan' && <PlanStage {...planStageProps} />}
      </div>
    </div>
  )
}
