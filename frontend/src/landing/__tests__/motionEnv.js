import { afterAll, vi } from 'vitest'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

// ScrollTrigger keeps a 250 ms sync interval alive for the page's lifetime. jsdom is torn down
// after each file, so stop it here or it calls a requestAnimationFrame that no longer exists.
afterAll(() => ScrollTrigger.disable(false, true))

// jsdom has no matchMedia. Match whole media features, never substrings: the motion query
// "(prefers-reduced-motion: no-preference)" contains the word "reduced" and a substring check
// once disabled every motion branch while the tests stayed green.
export function setMotion({ reduce = false, desktop = true } = {}) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    get matches() {
      if (query.includes('prefers-reduced-motion: reduce')) return reduce
      if (query.includes('prefers-reduced-motion: no-preference')) return !reduce
      if (query.includes('min-width')) return desktop
      return false
    },
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}
