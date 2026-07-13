import { useState } from 'react'

export default function OnboardingScreen({ onGetStarted }) {
  const [slide, setSlide] = useState(1)
  const [direction, setDirection] = useState('forward')

  const slides = [
    {
      id: 1,
      title: 'Coordination Swarm',
      desc: 'Venice AI coordinator maps strategy, while parallel worker agents execute swap and deposit actions autonomously.',
      icon: (
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4"></circle>
          <path d="M12 2v6M12 16v6M4.93 4.93l4.24 4.24M14.83 14.83l4.24 4.24M2 12h6M16 12h6M4.93 19.07l4.24-4.24M14.83 9.17l4.24-4.24"></path>
        </svg>
      )
    },
    {
      id: 2,
      title: 'Secure Boundaries',
      desc: 'Enforce ed25519 session-key limits on-chain. Smart contracts prevent agents from exceeding approved amount limits.',
      icon: (
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          <path d="M12 15v3"></path>
        </svg>
      )
    },
    {
      id: 3,
      title: 'Gasless Relaying',
      desc: 'Pay zero transaction fees. Every agent operation is fee-bump relayer sponsored on Stellar testnet.',
      icon: (
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="1" x2="12" y2="23"></line>
          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
        </svg>
      )
    }
  ]

  const current = slides[slide - 1]

  const handleNext = () => {
    if (slide < 3) {
      setDirection('forward')
      setSlide(slide + 1)
    }
    else onGetStarted()
  }

  const handleBack = () => {
    if (slide > 1) {
      setDirection('back')
      setSlide(slide - 1)
    }
  }

  const goToSlide = (id) => {
    if (id === slide) return
    setDirection(id > slide ? 'forward' : 'back')
    setSlide(id)
  }

  return (
    <div className="vf-screen vf-onboarding">
      <OnboardingStyle />

      {/* ── Skip button at top right ── */}
      {slide < 3 && (
        <button className="ob-skip-btn" onClick={onGetStarted}>
          Skip
        </button>
      )}

      {/* ── Slide Content Card ── */}
      <div className="ob-content" data-direction={direction} key={slide}>
        <div className="ob-icon-wrapper">
          {current.icon}
        </div>
        <h2 className="ob-title">{current.title}</h2>
        <p className="ob-desc">{current.desc}</p>
      </div>

      {/* ── Indicator Dots ── */}
      <div className="ob-dots">
        {slides.map((s) => (
          <button
            type="button"
            key={s.id}
            className={'ob-dot' + (s.id === slide ? ' active' : '')}
            aria-label={`Go to onboarding step ${s.id}`}
            aria-current={s.id === slide ? 'step' : undefined}
            onClick={() => goToSlide(s.id)}
          />
        ))}
      </div>

      {/* ── Navigation Actions ── */}
      <div className="ob-actions">
        {slide > 1 && (
          <button className="vf-btn ghost" onClick={handleBack} style={{ flex: 1 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginRight: 6 }}>
              <path d="M19 12H5M12 19l-7-7 7-7"></path>
            </svg>
            Back
          </button>
        )}

        <button className="vf-btn primary" onClick={handleNext} style={{ flex: slide > 1 ? 2 : 1 }}>
          {slide === 3 ? (
            <>
              Get Started
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginLeft: 6 }}>
                <path d="M5 12h14M12 5l7 7-7 7"></path>
              </svg>
            </>
          ) : (
            <>
              Next
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginLeft: 6 }}>
                <path d="M5 12h14M12 5l7 7-7 7"></path>
              </svg>
            </>
          )}
        </button>
      </div>

      {/* ── Brand footer tag ── */}
      <div className="ob-foot">
        <span className="ob-foot-mark">vibing / farmer</span>
        <span className="ob-foot-tag">Set once. Vibe forever.</span>
      </div>
    </div>
  )
}

/* ─────────── scoped styles ─────────── */
function OnboardingStyle() {
  return (
    <style>{`
.vf-onboarding {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: space-between;
  flex: 1;
  min-height: 480px;
  position: relative;
}

.ob-skip-btn {
  position: absolute;
  top: -8px; right: -4px;
  background: transparent;
  border: none;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-faint);
  cursor: pointer;
  padding: 8px 12px;
  transition: color 200ms ease;
  z-index: 10;
}
.ob-skip-btn:hover {
  color: var(--text);
}

.ob-content {
  --ob-enter-x: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 32px 12px 16px;
  flex: 1;
  justify-content: center;
  animation: ob-fade-in 220ms cubic-bezier(.23,1,.32,1) both;
}
.ob-content[data-direction="back"] { --ob-enter-x: -12px; }
@keyframes ob-fade-in {
  from { opacity: 0; transform: translateX(var(--ob-enter-x)); }
  to   { opacity: 1; transform: translateX(0); }
}

.ob-icon-wrapper {
  width: 96px; height: 96px;
  border-radius: 24px;
  background: var(--bg-elev);
  border: 1px solid var(--border-strong);
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 24px;
}

.ob-title {
  font-family: var(--font-display, "Geist", sans-serif);
  font-size: 20px; font-weight: 700;
  color: var(--text);
  margin: 0 0 12px;
  letter-spacing: -.02em;
}

.ob-desc {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-muted);
  max-width: 28ch;
  margin: 0;
}

.ob-dots {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-bottom: 24px;
}
.ob-dot {
  appearance: none;
  width: 32px; height: 32px;
  padding: 0;
  border: 0;
  display: grid;
  place-items: center;
  background: transparent;
  cursor: pointer;
}
.ob-dot::before {
  content: "";
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--border-strong);
  transition: background-color 160ms ease, transform 160ms cubic-bezier(.23,1,.32,1);
}
.ob-dot.active::before {
  background: var(--accent, #cfff3d);
  transform: scale(1.25);
}

.ob-actions {
  display: flex;
  gap: 12px;
  align-items: center;
}

.ob-foot {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-top: 24px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.ob-foot-mark {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-faint);
}
.ob-foot-tag {
  font-family: var(--font-script, "Newsreader", serif);
  font-style: italic;
  font-size: 11px;
  color: var(--text-faint);
}

@media (prefers-reduced-motion: reduce) {
  .ob-content { animation: none; }
  .ob-dot::before { transition: background-color 160ms ease; }
}
`}</style>
  )
}
