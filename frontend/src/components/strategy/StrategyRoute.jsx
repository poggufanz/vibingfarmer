// frontend/src/components/strategy/StrategyRoute.jsx
// Strategy Task 10 (Pocket Crew redesign, Wave 5). The `/strategy` route's composition root:
// the three-step progress nav (StrategyProgress) above the current stage's surface.
//
// Fix loop 1 (I1, Strategy Task 13 review): app.jsx used to duplicate this file's wrapper markup
// verbatim in a local `renderStrategyRoute()` because this file only wired the Plan branch at the
// time and was outside Task 13's authorized file list. The owner has since authorized this file
// as a scoped exception -- Protect and Start are wired here now, and app.jsx's copy is gone, so
// there is exactly one `.pc-route`/`.pc-route-stack` + StrategyProgress definition.
//
// A pure component tree: no data fetching, no wallet/relayer reads. The caller (app.jsx) owns all
// real state and passes it in as props. `...planStageProps` keeps its original flat-spread shape
// (PlanStage.test.jsx's G1 layout test renders `<StrategyRoute stage="plan" .../>` with PlanStage
// props at the top level) -- `protectProps`/`startProps` are new, additive prop bags for the two
// stages that did not exist yet when that shape was chosen, so no existing caller's props change
// meaning. `plan` gates Protect/Start exactly as app.jsx's own inline check used to
// (`strategyFlow.moment === 'protect' && strategyFlow.plan`): neither stage renders without one.
import './strategy.css'
import { StrategyProgress } from './StrategyProgress.jsx'
import { PlanStage } from './PlanStage.jsx'
import { ProtectStage } from './ProtectStage.jsx'
import { StartStage } from './StartStage.jsx'

export function StrategyRoute({
  stage = 'plan',
  reached,
  onNavigateStage,
  plan,
  protectProps,
  startProps,
  ...planStageProps
}) {
  return (
    <div className="pc-route">
      <div className="pc-route-stack">
        <StrategyProgress current={stage} reached={reached} onNavigate={onNavigateStage} />
        {stage === 'plan' && <PlanStage {...planStageProps} />}
        {stage === 'protect' && plan && <ProtectStage plan={plan} {...protectProps} />}
        {stage === 'start' && plan && <StartStage plan={plan} {...startProps} />}
      </div>
    </div>
  )
}
