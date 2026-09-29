// frontend/src/components/strategy/StrategyProgress.jsx
// Strategy Task 10 (Pocket Crew redesign, Wave 5). The three-step Plan / Protect / Start stepper
// that sits above every strategy route surface (visual contract's `.pc-strategy-stage-nav`,
// docs/superpowers/specs/2026-07-23-pocket-crew-visual-contract.css:501-521). Steps are always
// visibly labeled text -- dots without labels are an explicit checklist rejection -- and a step
// is only ever a real navigation target when the caller has marked it `reached` (this component
// never invents its own "is it safe to go back" policy; the caller, which knows whether a plan
// has been signed/dispatched, decides what counts as reached).
const STEPS = Object.freeze([
  { id: 'plan', label: 'Plan', caption: 'Amount and comfort' },
  { id: 'protect', label: 'Protect', caption: 'Limits and one signature' },
  { id: 'start', label: 'Start', caption: 'Crew goes to work' },
])

// Station rail (2026-09-28 redesign): each step is a station with a lamp. The accessible name is
// still exactly "N · Label" -- one screen-reader-only text node -- and the visible lamp number,
// label and caption are aria-hidden duplicates of it, so the rail can look like an instrument
// without changing what assistive tech or the tests read.
function stationState(index, currentIndex) {
  if (index < currentIndex) return 'done'
  if (index === currentIndex) return 'current'
  return 'ahead'
}

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
      {STEPS.map((step, index) => {
        const isCurrent = step.id === current
        const canNavigate =
          !isCurrent && reachedSet.has(step.id) && typeof onNavigate === 'function'
        return (
          <button
            key={step.id}
            type="button"
            aria-current={isCurrent ? 'step' : undefined}
            disabled={!canNavigate}
            data-station={stationState(index, currentIndex)}
            onClick={canNavigate ? () => onNavigate(step.id) : undefined}
          >
            <span className="pc-visually-hidden">{`${index + 1} · ${step.label}`}</span>
            <span className="pc-stage-lamp" aria-hidden="true">
              {index + 1}
            </span>
            <span className="pc-stage-text" aria-hidden="true">
              <span className="pc-stage-label">{step.label}</span>
              <span className="pc-stage-caption">{step.caption}</span>
            </span>
          </button>
        )
      })}
      <p className="pc-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </nav>
  )
}
