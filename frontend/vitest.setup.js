// jsdom ships no window.matchMedia; GSAP's ScrollTrigger calls it at
// registerPlugin() time (module import), before any per-test beforeEach stub
// can run. Provide a non-matching fallback only when missing — test files that
// stub their own matchMedia (LandingHero.test.jsx) still override this.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })
}
