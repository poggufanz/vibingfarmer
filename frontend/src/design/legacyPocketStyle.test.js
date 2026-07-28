// Foundation Task 8 -- zero-tolerance audit: no shared/disconnected route may keep a hardcoded
// Acid-Yield fallback color once Task 2's Pocket Crew compatibility tokens exist to replace it.
// A fallback hex always wins over an unmapped or renamed CSS variable, so this has to check the
// literal retired values AND every hardcoded inline fallback on a Task 2 compatibility token --
// otherwise Day Field (light) could still render Acid-Yield colors after the five literal
// patterns below all pass green.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const DESIGN_DIR = import.meta.dirname
const SRC_DIR = resolve(DESIGN_DIR, '..')

export const RETIRED_ROUTE_STYLE_PATTERNS = Object.freeze([
  ['acid language', /\bacid(?:-yield)?\b/iu],
  ['acid accent', /#cfff3d/iu],
  ['legacy canvas', /#0e0f0c/iu],
  ['legacy card', /#1a1b16/iu],
  ['lava animation', /\bbtn-lava\b/iu],
])

// Every Task 2 compatibility token a shared route is allowed to reference. A literal retired
// hex (#cfff3d, #0e0f0c, #1a1b16) hiding behind one of these as a fallback is already caught by
// RETIRED_ROUTE_STYLE_PATTERNS above; this catches the OTHER hardcoded fallbacks (e.g. #ecebe1,
// #e8e8e8) that mask theme-awareness without literally being a retired Acid-Yield value.
const COMPAT_TOKENS = Object.freeze([
  '--text',
  '--bg-canvas',
  '--bg-input',
  '--accent-fg',
  '--accent-soft',
  '--border-accent',
  '--text-faint',
  '--info',
  '--warn',
  '--ok',
])

// `--text-primary` never existed in style.css -- pocket-crew.css only carries it as a legacy
// compatibility alias for `--text` (see theme.test.js's compatibilityValues) because the ONLY
// prior reference to it was HomePage.jsx's hardcoded `var(--text-primary, #e8e8e8)`, which always
// resolved to its hex regardless of theme. The `--text` check has to catch that alias too.
const TOKEN_ALIASES = Object.freeze({ '--text': ['--text-primary'] })

const escapeRe = (s) => s.replace(/[/\\^$*+?.()|[\]{}]/gu, '\\$&')

function fallbackPatternFor(token) {
  const names = [token, ...(TOKEN_ALIASES[token] || [])]
  const alt = names.map(escapeRe).join('|')
  // A hardcoded inline fallback is a `var(--token, ...)` reference -- the comma is what makes it
  // a fallback rather than a plain `var(--token)` read.
  return new RegExp(`var\\(\\s*(?:${alt})\\s*,`, 'iu')
}

export const COMPAT_TOKEN_FALLBACK_PATTERNS = Object.freeze(
  COMPAT_TOKENS.map((token) => [`${token} hardcoded fallback`, fallbackPatternFor(token)])
)

// Task 10 (IA remap): HomePage.jsx is retired (/home now mounts MyMoneyRoute, already covered by
// its own Pocket Crew token audits -- contractTokens.test.js et al.), so its entry is dropped, not
// replaced -- this list is specifically the shared/disconnected routes outside that port.
const ROUTE_FILES = Object.freeze([
  ['HistoryPanel.jsx', resolve(SRC_DIR, 'components/HistoryPanel.jsx')],
  ['SettingsPage.jsx', resolve(SRC_DIR, 'components/SettingsPage.jsx')],
  ['ExplorerPage.jsx', resolve(SRC_DIR, 'components/ExplorerPage.jsx')],
  ['DevelopersLayout.jsx', resolve(SRC_DIR, 'developers/DevelopersLayout.jsx')],
])

const ALL_ROUTE_PATTERNS = Object.freeze([
  ...RETIRED_ROUTE_STYLE_PATTERNS,
  ...COMPAT_TOKEN_FALLBACK_PATTERNS,
])

describe('shared/disconnected route sources carry no legacy Acid styling', () => {
  it.each(ROUTE_FILES)(
    '%s has no retired pattern or hardcoded compat-token fallback',
    (name, path) => {
      const content = readFileSync(path, 'utf8')
      const hits = ALL_ROUTE_PATTERNS.filter(([, pattern]) => pattern.test(content)).map(
        ([label]) => label
      )
      expect(hits, `${name} matched: ${hits.join(', ')}`).toEqual([])
    }
  )
})

describe('pocket-crew.css final lava-animation compatibility override', () => {
  it('resets .btn-primary, .btn-ghost, .btn-chip, .mandate-revoke to no animation/gradient', () => {
    const css = readFileSync(resolve(DESIGN_DIR, 'pocket-crew.css'), 'utf8')
    const tail = css.trimEnd().slice(-600)

    expect(tail, 'final override must be scoped under [data-theme]').toMatch(/\[data-theme\]/u)
    for (const selector of ['.btn-primary', '.btn-ghost', '.btn-chip', '.mandate-revoke']) {
      expect(tail, `final override must reset ${selector}`).toContain(selector)
    }
    expect(tail).toMatch(/animation:\s*none/u)
    expect(tail).toMatch(/background-image:\s*none/u)
  })
})

// Landing is explicitly deferred (narrative/scene redesign is out of scope for Foundation) -- the
// five retired-pattern regexes still run against it so the debt is visible in test output, but a
// match there does not fail the suite. The one thing that DOES fail: hardcoding the retired
// pre-Task-3 logo path, or a fake/placeholder network mark, since LandingHero.jsx already carries
// the real approved marks (/brand/networks/stellar.svg, stellar-white.svg).
const RETIRED_LOGO_PATH_PATTERN = /vibing_farmer\.logo\.(?:svg|png)/iu
const FAKE_NETWORK_MARK_PATTERN =
  /\/(?:brand\/networks|logos)\/(?:ethereum|eth-mark|fake-network|placeholder-network)[\w.-]*\.(?:svg|png)/iu

const LANDING_FILES = Object.freeze([
  ['LandingHero.css', resolve(SRC_DIR, 'components/LandingHero.css')],
  ['LandingFx.jsx', resolve(SRC_DIR, 'components/LandingFx.jsx')],
])

describe('landing narrative/scene styling (deferred debt, printed not failed)', () => {
  it.each(LANDING_FILES)('%s prints retired-pattern matches without failing', (name, path) => {
    const content = readFileSync(path, 'utf8')
    const lines = content.split('\n')
    RETIRED_ROUTE_STYLE_PATTERNS.forEach(([label, pattern]) => {
      lines.forEach((line, i) => {
        if (pattern.test(line)) {
          // eslint-disable-next-line no-console -- intentional deferred-debt printout, see above
          console.log(`[deferred landing debt] ${name}:${i + 1} (${label}): ${line.trim()}`)
        }
      })
    })

    expect(content, `${name} must not hardcode the retired product logo path`).not.toMatch(
      RETIRED_LOGO_PATH_PATTERN
    )
    expect(content, `${name} must not hardcode a fake/placeholder network mark`).not.toMatch(
      FAKE_NETWORK_MARK_PATTERN
    )
  })
})
