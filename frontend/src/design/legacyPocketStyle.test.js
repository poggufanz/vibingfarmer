// Foundation Task 8 -- zero-tolerance audit: no shared/disconnected route may keep a hardcoded
// Acid-Yield fallback color once Task 2's Pocket Crew compatibility tokens exist to replace it.
// A fallback hex always wins over an unmapped or renamed CSS variable, so this has to check the
// literal retired values AND every hardcoded inline fallback on a Task 2 compatibility token --
// otherwise Day Field (light) could still render Acid-Yield colors after the five literal
// patterns below all pass green.

import { readdirSync, readFileSync } from 'node:fs'
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
//
// 2026-07-29 (universal adoption): this list used to hold FOUR entries, and that gap is exactly how
// 48 retired hex values survived in ReplayPage.jsx and 32 in EcosystemPage.jsx -- neither file was
// ever audited, so nothing failed while they drifted. Every surface that a production build can
// actually render is now listed. Adding a route without adding it here is the failure mode this
// list exists to prevent.
const ROUTE_FILES = Object.freeze([
  ['HistoryPanel.jsx', resolve(SRC_DIR, 'components/HistoryPanel.jsx')],
  ['SettingsPage.jsx', resolve(SRC_DIR, 'components/SettingsPage.jsx')],
  ['ExplorerPage.jsx', resolve(SRC_DIR, 'components/ExplorerPage.jsx')],
  ['DevelopersLayout.jsx', resolve(SRC_DIR, 'developers/DevelopersLayout.jsx')],
  // Public, wallet-free routes (app.jsx:3332-3368) -- the ones visitors and judges reach first.
  ['EcosystemPage.jsx', resolve(SRC_DIR, 'components/EcosystemPage.jsx')],
  ['ReplayPage.jsx', resolve(SRC_DIR, 'components/ReplayPage.jsx')],
  ['NavBar.jsx', resolve(SRC_DIR, 'components/NavBar.jsx')],
  // Shell chrome and overlays -- rendered on top of EVERY route, so a defect here is universal.
  ['RightRail.jsx', resolve(SRC_DIR, 'components/RightRail.jsx')],
  ['components.jsx', resolve(SRC_DIR, 'components.jsx')],
  ['NotificationCenter.jsx', resolve(SRC_DIR, 'components/NotificationCenter.jsx')],
  ['AlertCard.jsx', resolve(SRC_DIR, 'components/AlertCard.jsx')],
  ['OnboardingFlow.jsx', resolve(SRC_DIR, 'components/OnboardingFlow.jsx')],
  // Detail routes and the remaining developer sections.
  ['VaultDetailPage.jsx', resolve(SRC_DIR, 'components/VaultDetailPage.jsx')],
  ['TxDetailPage.jsx', resolve(SRC_DIR, 'components/TxDetailPage.jsx')],
  ['KeysSection.jsx', resolve(SRC_DIR, 'developers/KeysSection.jsx')],
  ['DocsSection.jsx', resolve(SRC_DIR, 'developers/DocsSection.jsx')],
  ['UsageSection.jsx', resolve(SRC_DIR, 'developers/UsageSection.jsx')],
  ['OverviewSection.jsx', resolve(SRC_DIR, 'developers/OverviewSection.jsx')],
  ['CodeBlock.jsx', resolve(SRC_DIR, 'developers/CodeBlock.jsx')],
  // Skill surfaces, the memory modal's host, and the shared screens helpers.
  ['skills.jsx', resolve(SRC_DIR, 'skills.jsx')],
  ['SkillDrawer.jsx', resolve(SRC_DIR, 'components/SkillDrawer.jsx')],
  ['SkillEditModal.jsx', resolve(SRC_DIR, 'components/SkillEditModal.jsx')],
  ['SkillDetailModal.jsx', resolve(SRC_DIR, 'components/SkillDetailModal.jsx')],
  ['agents.jsx', resolve(SRC_DIR, 'agents.jsx')],
  ['screens.jsx', resolve(SRC_DIR, 'screens.jsx')],
  ['sparkline.js', resolve(SRC_DIR, 'sparkline.js')],
  // The base stylesheet itself, and the Foundation layer that overrides it.
  ['style.css', resolve(SRC_DIR, '../style.css')],
  ['pocket-crew.css', resolve(DESIGN_DIR, 'pocket-crew.css')],
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

// ---------------------------------------------------------------------------------------------
// 2026-07-29, universal adoption. The four checks below are repo-wide rather than per-file: each
// encodes a defect that was found in production, in BOTH themes, by driving the real app in
// Chromium -- not by reading source. Each is at zero right now, so a failure here is a regression,
// never pre-existing debt.
//
// Landing is exempt for the reason the existing block at the bottom of this file documents: its
// narrative/scene styling is deliberately deferred. console.css is exempt because
// components/console/* is retired -- nothing in the production route tree imports it (app.jsx:120).
// ---------------------------------------------------------------------------------------------

const CONTRACT_EXEMPT = Object.freeze([
  'components/LandingHero.css',
  'components/LandingHero.jsx',
  'components/LandingFx.jsx',
  'console.css',
])

function stylingSources() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(css|jsx|js)$/u.test(entry.name) && !/\.test\.[jt]sx?$/u.test(entry.name))
        out.push(full)
    }
  }
  walk(SRC_DIR)
  out.push(resolve(SRC_DIR, '../style.css'))
  return out.filter((f) => !CONTRACT_EXEMPT.some((x) => f.replaceAll('\\', '/').endsWith(x)))
}

const CONTRACT_RULES = Object.freeze([
  [
    // Harvest is the decision SURFACE, never text. On Field the two coincide, so this was invisible
    // for a long time; on Day Field lime-on-light measured 1.03:1 -- effectively unreadable -- and
    // it appeared on every route via RightRail's "Customize" link. Use --accent-text.
    'harvest used as a text colour',
    /(?<![-\w])color:\s*'?var\(--accent\)/u,
  ],
  [
    // `var(--token, #hex)` / `var(--token, rgba(...))`. Every one of these carried a retired
    // Acid-Yield value, and a fallback always wins the moment a token is renamed or unmapped --
    // silently reinstating a one-theme colour. Every token referenced this way is declared for both
    // themes in pocket-crew.css, so the fallback can only ever mask a bug.
    'hardcoded colour fallback on a token',
    /var\(\s*--[a-z0-9-]+\s*,\s*(?:#[0-9a-fA-F]{3,8}|rgba?\()/u,
  ],
  [
    // Same masking pattern on the shape lock: `var(--radius-md, 8px)` reinstates a pre-contract
    // radius if the token ever moves.
    'hardcoded px fallback on a radius token',
    /var\(\s*--[a-z0-9-]*radius[a-z0-9-]*\s*,\s*[0-9.]+(?:px|rem|%)\s*\)/u,
  ],
  [
    // Contract rule 7: no glass blur. This was the last glassmorphism in the product, on the fixed
    // nav bar of the three wallet-free public pages.
    'glass blur (backdrop-filter)',
    /backdrop-filter\s*:(?!\s*none)/u,
  ],
])

describe('Pocket Crew contract holds across every non-exempt styling source', () => {
  it.each(CONTRACT_RULES)('no %s', (label, pattern) => {
    const offenders = stylingSources()
      .filter((f) => pattern.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(f.indexOf('/frontend/') + 10))
    expect(offenders, `${label} found in: ${offenders.join(', ')}`).toEqual([])
  })

  // Contract rule 7 bans gradients outright. Checked on rendered CSS declarations only -- the three
  // public pages carry the word "gradient" in comments explaining what was removed, and a
  // `mask-image` gradient is a mask, not a painted gradient.
  it('paints no gradients', () => {
    const decl =
      /(?:background|background-image|background-color)\s*:[^;{}]*\b(?:linear|radial|conic)-gradient/u
    const offenders = stylingSources()
      .filter((f) => decl.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(f.indexOf('/frontend/') + 10))
    expect(offenders, `gradient fills found in: ${offenders.join(', ')}`).toEqual([])
  })

  // The shape lock: controls 12px, supporting surfaces 16px, dominant surfaces 24px, pills 999px.
  // style.css is the base stylesheet every route inherits, so an off-lock literal there is the one
  // that spreads furthest.
  it('keeps style.css border radii on the shape lock', () => {
    const css = readFileSync(resolve(SRC_DIR, '../style.css'), 'utf8')
    const offLock = [...css.matchAll(/border-radius:\s*(\d+)px/gu)]
      .map((m) => Number(m[1]))
      .filter((n) => ![12, 16, 24, 999].includes(n))
    expect(offLock, `off-lock px radii in style.css: ${offLock.join(', ')}`).toEqual([])
  })

  // The elevation tokens must resolve to the supporting surface, not back to the canvas. They were
  // flattened onto the canvas hex during the first port ("until they adopt an explicit surface
  // pair"), which left 111 declarations across the app asking for a surface and getting none -- the
  // sidebar's active nav item painted #17251f on a #17251f rail and could not be seen at all.
  it('gives --bg-card/--bg-elev a real surface, distinct from the canvas, in both themes', () => {
    const css = readFileSync(resolve(DESIGN_DIR, 'pocket-crew.css'), 'utf8')
    for (const [theme, marker] of [
      ['forest', ":root,\n:root[data-theme='forest']"],
      ['day-field', ":root[data-theme='day-field']"],
    ]) {
      const start = css.indexOf(marker)
      expect(start, `${theme} token block not found`).toBeGreaterThan(-1)
      const block = css.slice(start, css.indexOf('\n}', start))
      const read = (name) => block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`, 'u'))?.[1]
      const canvas = read('--bg-canvas')
      for (const token of ['--bg-card', '--bg-elev', '--bg-elev-2']) {
        expect(read(token), `${theme} ${token} must not equal --bg-canvas (${canvas})`).not.toBe(
          canvas
        )
      }
    }
  })
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
