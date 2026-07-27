// frontend/src/components/strategy/StrategyProgress.jsx
// Strategy Task 10 (Pocket Crew redesign, Wave 5). The three-step Plan / Protect / Start stepper
// that sits above every strategy route surface (visual contract's `.pc-strategy-stage-nav`,
// docs/superpowers/specs/2026-07-23-pocket-crew-visual-contract.css:501-521). Steps are always
// visibly labeled text -- dots without labels are an explicit checklist rejection -- and a step
// is only ever a real navigation target when the caller has marked it `reached` (this component
// never invents its own "is it safe to go back" policy; the caller, which knows whether a plan
// has been signed/dispatched, decides what counts as reached).
const STEPS = Object.freeze([
  { id: 'plan', label: 'Plan' },
  { id: 'protect', label: 'Protect' },
  { id: 'start', label: 'Start' },
])

/**
 * @param {object} props
 * @param {'plan'|'protect'|'start'} props.current
 * @param {Array<'plan'|'protect'|'start'>} [props.reached] steps safe to navigate back/forward to.
 *   Defaults to just `current` (nothing else reached yet).
 * @param {(stepId: string) => void} [props.onNavigate]
 */
export function StrategyProgress({ current, reached, onNavigate }) {
  const reachedSet = new Set(reached || [current])
  const currentIndex = STEPS.findIndex((step) => step.id === current)
  const announcement =
    currentIndex >= 0
      ? `Step ${currentIndex + 1} of ${STEPS.length}: ${STEPS[currentIndex].label}`
      : ''

  return (
    <nav className="pc-strategy-stage-nav" aria-label="Strategy progress">
      {STEPS.map((step) => {
        const isCurrent = step.id === current
        const canNavigate =
          !isCurrent && reachedSet.has(step.id) && typeof onNavigate === 'function'
        return (
          <button
            key={step.id}
            type="button"
            aria-current={isCurrent ? 'step' : undefined}
            disabled={!canNavigate}
            onClick={canNavigate ? () => onNavigate(step.id) : undefined}
          >
            {step.label}
          </button>
        )
      })}
      <p className="pc-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </nav>
  )
}
