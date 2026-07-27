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
//
// Wave 6 Task 14 (scoped exception, owner-authorized): a stage change (Plan -> Protect -> Start)
// is NOT a route change, so Foundation Task 6's RouteFocus (route-pathname-keyed) never fires for
// it -- a keyboard user advancing stages had focus dropped onto the unmounted previous stage's
// element, falling back to document.body, so the next Tab restarted from the top of the page.
// Reuses RouteFocus.jsx's own technique (tabindex-on-demand + .focus() on the new heading) rather
// than inventing a second one, but keyed on `stage` (a per-instance ref), not RouteFocus's
// module-scoped `hasFocusedRoute` flag: that flag exists because App remounts a fresh RouteFocus
// per branch (public/onboarding/authenticated), so a ref would reset every branch swap. This
// component is mounted exactly once per `/strategy` visit and only re-renders with new `stage`
// props (app.jsx's strategyFlow state machine), so a plain per-instance ref already tells "first
// render of this instance" (ref seeded with the initial stage, so the mount-time effect run sees
// no change) apart from "stage actually changed" -- no module-scope flag needed here. The effect
// depends ONLY on `stage`, never on `events`/`receipt`/internal phase, so a background update
// inside the CURRENT stage (e.g. StartStage's live events arriving) can never steal focus -- the
// brief's "no focus theft from background events" item and this one pull in opposite directions,
// and the dependency array is what keeps them both true at once.
import { useEffect, useRef } from 'react'
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
  const stackRef = useRef(null)
  const previousStageRef = useRef(stage)

  useEffect(() => {
    if (previousStageRef.current !== stage) {
      const heading = stackRef.current?.querySelector('h1')
      if (heading) {
        if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
        heading.focus()
      }
    }
    previousStageRef.current = stage
  }, [stage])

  return (
    <div className="pc-route">
      <div className="pc-route-stack" ref={stackRef}>
        <StrategyProgress current={stage} reached={reached} onNavigate={onNavigateStage} />
        {stage === 'plan' && <PlanStage {...planStageProps} />}
        {stage === 'protect' && plan && <ProtectStage plan={plan} {...protectProps} />}
        {stage === 'start' && plan && <StartStage plan={plan} {...startProps} />}
      </div>
    </div>
  )
}
