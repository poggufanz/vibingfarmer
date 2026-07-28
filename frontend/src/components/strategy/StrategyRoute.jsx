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

// Task 2 (Pocket Crew design alignment): the route owns the single `<h1>` -- each stage's own
// heading is demoted to `<h2>` (see PlanStage/ProtectStage/StartStage) so there is never more than
// one h1 on `/strategy` at a time. STAGE_META supplies the "Step N of 3" counter text; frozen like
// StrategyProgress's own STEPS, for the same reason (it mirrors that fixed 3-stage wizard).
const STAGE_META = {
  plan: { num: 1, name: 'Plan' },
  protect: { num: 2, name: 'Protect' },
  start: { num: 3, name: 'Start' },
}

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
      // Fix (Task 2 review, Minor 3): a bare `querySelector('h2')` was DOM-order-dependent -- it
      // only happened to find the stage TITLE first because that's the first h2 in document order
      // today. PlanStage alone already renders three h2s (the title, plus "Stellar truth"/"Base
      // Sepolia bridge" asides) and StartStage's settled view adds StrategyReceipt's "Your receipt"
      // h2 -- an unrelated reorder (e.g. Task 4's Plan aside edits) could silently steal focus onto
      // the wrong heading with no test failure, since `stackRef.current?.querySelector('h2')` would
      // still find SOME h2. `.pc-strategy-question` is the one class every stage's own title
      // carries (PlanStage/ProtectStage/StartStage, verified), so this selects by intent instead of
      // position.
      const heading = stackRef.current?.querySelector('.pc-strategy-question')
      if (heading) {
        if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
        heading.focus()
      }
    }
    previousStageRef.current = stage
  }, [stage])

  return (
    <div className="pc-route">
      <header className="pc-route-header">
        <div>
          <h1 className="pc-route-title">Hire a crew, once.</h1>
          <p className="pc-route-sub">
            Three short steps. You sign at the very end, one time, and the limits you set are
            enforced by the chain — not by us.
          </p>
        </div>
        <p className="pc-route-step">
          <span className="pc-route-step-label">Step {STAGE_META[stage].num} of 3</span>
          <span className="pc-route-step-name">{STAGE_META[stage].name}</span>
        </p>
      </header>
      <div className="pc-route-stack" ref={stackRef}>
        <StrategyProgress current={stage} reached={reached} onNavigate={onNavigateStage} />
        {stage === 'plan' && <PlanStage {...planStageProps} />}
        {stage === 'protect' && plan && <ProtectStage plan={plan} {...protectProps} />}
        {stage === 'start' && plan && <StartStage plan={plan} {...startProps} />}
      </div>
    </div>
  )
}
