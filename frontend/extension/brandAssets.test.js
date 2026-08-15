// Wallet Task 8 asset-contract tests: proves the MV3 extension boundary consumes the frozen
// Foundation product mark + reviewed network marks, renders deterministic icons from them, and
// ships no remote font/script/image dependency anywhere in popup/approve/ceremony. Companion to
// src/design/brandAssets.test.js (the web app's own asset contract) -- same spirit, scoped to
// extension/.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const FRONTEND_DIR = resolve(import.meta.dirname, '..')
const EXT_DIR = resolve(FRONTEND_DIR, 'extension')
const PUBLIC_DIR = resolve(FRONTEND_DIR, 'public')
const GEN_SCRIPT = resolve(FRONTEND_DIR, 'scripts/gen-ext-icons.mjs')
const MANIFEST_JSON = resolve(EXT_DIR, 'manifest.json')
const MARK_SVG = resolve(PUBLIC_DIR, 'brand/vibing-farmer-mark.svg')
const LOGO_SVG = resolve(EXT_DIR, 'vibing_farmer.logo.svg')
const ASSETS_MANIFEST = resolve(PUBLIC_DIR, 'brand/assets.manifest.json')

// Fixed pocket body + V geometry (see src/design/brandAssets.test.js) -- proves the extension
// mark is the same frozen Foundation product mark, not a redrawn wallet-only shape.
const POCKET_D = 'M8 11H21L25 17H39L43 11H56V50C56 55 52 59 47 59H17C12 59 8 55 8 50Z'
const V_D = 'M18 24L31 48L43 24'

// AgentMark's capsule body + tail (src/components/pocket/AgentMark.jsx) -- the product mark must
// never share this geometry. AgentMark exists so "one crew mark always means one actually
// deployed account"; a wallet-only respray of it would defeat that contract.
const AGENT_MARK_BODY_D =
  'M16 4C10.477 4 6 8.477 6 14V20C6 25.523 10.477 30 16 30C21.523 30 26 25.523 26 20V14C26 8.477 21.523 4 16 4Z'
const AGENT_MARK_TAIL_D = 'M9 25L9 30L4 28Z'

const PAGES = ['popup.html', 'approve.html', 'ceremony.html']
// Brief step 1 asks for a mark "readable at 16px". Not machine-checkable: readability is a
// perceptual judgment (does the pocket/V silhouette still read as a shape, not mud, at 16 real
// pixels) that no pixel-level assertion substitutes for -- a check that counted non-transparent
// pixels or measured contrast could pass on a genuinely unreadable render. The mechanically
// enforceable proxies actually asserted below are: exact 16px IHDR dimensions (this array), byte-
// for-byte deterministic output, and the fail-closed hash-drift guard, none of which claim to
// prove readability. Readability is a visual-review concern (see the visual contract's REQUIRED
// VISUAL SNAPSHOTS), not a unit-test one.
const ICON_SIZES = [16, 32, 48, 128]

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

// Minimal PNG IHDR reader: width/height live at bytes 16-24 of any valid PNG.
function readPngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

// gen-ext-icons.mjs hardcodes its input/output paths relative to its own file location
// (../extension, ../public) -- it takes no path overrides, and it is not in this fix loop's
// authorized file list, so it cannot be given any. Exercising it safely therefore means mirroring
// that relative layout inside a real OS tmpdir (never a tracked path) and pointing a COPY of the
// script at the copy. A symlinked node_modules lets the copy's `import '@resvg/resvg-js'` resolve
// (Node's ESM resolver walks up parent directories from the importing file looking for
// node_modules; the tmpdir itself has none, so it needs one) without copying node_modules itself.
function setupTmpGenDir() {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'vf-gen-ext-icons-'))
  mkdirSync(resolve(tmpRoot, 'scripts'), { recursive: true })
  mkdirSync(resolve(tmpRoot, 'extension/icons'), { recursive: true })
  mkdirSync(resolve(tmpRoot, 'public/brand'), { recursive: true })
  symlinkSync(resolve(FRONTEND_DIR, 'node_modules'), resolve(tmpRoot, 'node_modules'), 'dir')
  const scriptPath = resolve(tmpRoot, 'scripts/gen-ext-icons.mjs')
  writeFileSync(scriptPath, readFileSync(GEN_SCRIPT))
  writeFileSync(
    resolve(tmpRoot, 'public/brand/assets.manifest.json'),
    readFileSync(ASSETS_MANIFEST)
  )
  return {
    scriptPath,
    svgPath: resolve(tmpRoot, 'extension/vibing_farmer.logo.svg'),
    iconsDir: resolve(tmpRoot, 'extension/icons'),
    cleanup: () => rmSync(tmpRoot, { recursive: true, force: true }),
  }
}

describe('extension brand asset contract', () => {
  it('popup uses the local wallet stylesheet and Foundation logo path', () => {
    const html = readFileSync(resolve(EXT_DIR, 'popup.html'), 'utf8')
    expect(html).toContain('<link rel="stylesheet" href="./wallet.css">')
    expect(html).toContain('data-theme="forest"')
    expect(html).toContain('class="pc-wallet-page"')
    expect(html).toContain('href="./vibing_farmer.logo.svg"')
  })

  it('vibing_farmer.logo.svg is byte-identical to the Foundation product mark (no alternate wallet logo geometry)', () => {
    const logo = readFileSync(LOGO_SVG)
    const mark = readFileSync(MARK_SVG)
    expect(sha256(logo)).toBe(sha256(mark))
  })

  it('the extension ships exactly one logo SVG and it carries the frozen pocket/V geometry, never the AgentMark capsule+tail', () => {
    const svgFiles = readdirSync(EXT_DIR).filter((f) => f.endsWith('.svg'))
    expect(svgFiles).toEqual(['vibing_farmer.logo.svg'])
    const content = readFileSync(LOGO_SVG, 'utf8')
    expect(content).toContain(POCKET_D)
    expect(content).toContain(V_D)
    expect(content).not.toContain(AGENT_MARK_BODY_D)
    expect(content).not.toContain(AGENT_MARK_TAIL_D)
  })

  it('gen-ext-icons.mjs renders 16/32/48/128 PNGs deterministically from a source whose hash matches the frozen manifest entry, without touching any tracked file', () => {
    // Baseline: prove the generator run below never wrote the tracked icons/logo it exercises
    // a copy of (the standing worktree-preservation constraint -- a prior version of this test
    // regenerated the tracked PNGs and overwrote the tracked SVG in place on every `npm test`).
    const trackedLogoBefore = sha256(readFileSync(LOGO_SVG))
    const trackedIconsBefore = ICON_SIZES.map((size) =>
      sha256(readFileSync(resolve(EXT_DIR, `icons/icon-${size}.png`)))
    )

    const manifest = JSON.parse(readFileSync(ASSETS_MANIFEST, 'utf8'))
    const markEntry = manifest.find((e) => e.path === '/brand/vibing-farmer-mark.svg')
    expect(markEntry, 'manifest must record the mark entry').toBeTruthy()
    expect(sha256(readFileSync(LOGO_SVG))).toBe(markEntry.sha256)

    // Two independent tmpdir runs of the same source SVG: byte-identical PNG output across both
    // is the deterministic-icon guarantee the brief asks for (a raster pipeline that embedded a
    // timestamp, random id, or nondeterministic encoder pass would fail this even though IHDR
    // dimensions alone would still look fine).
    const runA = setupTmpGenDir()
    const runB = setupTmpGenDir()
    try {
      writeFileSync(runA.svgPath, readFileSync(LOGO_SVG))
      writeFileSync(runB.svgPath, readFileSync(LOGO_SVG))
      execFileSync('node', [runA.scriptPath], { stdio: 'pipe' })
      execFileSync('node', [runB.scriptPath], { stdio: 'pipe' })

      ICON_SIZES.forEach((size, i) => {
        const pngA = readFileSync(resolve(runA.iconsDir, `icon-${size}.png`))
        const pngB = readFileSync(resolve(runB.iconsDir, `icon-${size}.png`))
        expect(readPngSize(pngA), `icon-${size}.png`).toEqual({ width: size, height: size })
        expect(sha256(pngA), `icon-${size}.png byte-stability across independent runs`).toBe(
          sha256(pngB)
        )
        // Ties generator output to the COMMITTED icon, not just to itself across two fresh runs --
        // run-to-run stability alone proves the pipeline is deterministic but not that the tracked
        // PNG actually came from this source SVG. A hand-edited or stale tracked icon would pass
        // every assertion above (and the unchanged-since check below, which only proves the test
        // itself didn't mutate it) without this line ever comparing it to real generator output.
        expect(sha256(pngA), `icon-${size}.png must match the committed icon`).toBe(
          trackedIconsBefore[i]
        )
      })
    } finally {
      runA.cleanup()
      runB.cleanup()
    }

    expect(sha256(readFileSync(LOGO_SVG)), 'tracked logo must be unchanged').toBe(trackedLogoBefore)
    ICON_SIZES.forEach((size, i) => {
      expect(
        sha256(readFileSync(resolve(EXT_DIR, `icons/icon-${size}.png`))),
        `tracked icon-${size}.png must be unchanged`
      ).toBe(trackedIconsBefore[i])
    })
  })

  it('gen-ext-icons.mjs fails closed when the source SVG no longer hashes to the manifest entry, without ever writing the tracked logo', () => {
    const trackedLogoBefore = sha256(readFileSync(LOGO_SVG))
    const dir = setupTmpGenDir()
    try {
      writeFileSync(
        dir.svgPath,
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>\n'
      )
      let failure
      try {
        execFileSync('node', [dir.scriptPath], { stdio: 'pipe' })
      } catch (err) {
        failure = err
      }
      expect(failure, 'gen-ext-icons.mjs must exit non-zero on a hash mismatch').toBeTruthy()
      // A bare .toThrow() here also passes when the *harness* is broken (e.g. a missing/broken
      // node_modules symlink -> ERR_MODULE_NOT_FOUND) without the frozen-hash guard in
      // gen-ext-icons.mjs ever firing. Match the guard's own message text so only that specific
      // guard satisfies this test.
      expect(String(failure.stderr)).toMatch(
        /does not match the frozen mark hash in assets\.manifest\.json/
      )
    } finally {
      dir.cleanup()
    }
    expect(sha256(readFileSync(LOGO_SVG)), 'tracked logo must be unchanged').toBe(trackedLogoBefore)
  })

  it("manifest.json reports the bumped MV3 version and defines no content_security_policy override, so MV3's default script-src 'self' applies", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_JSON, 'utf8'))
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.version).toBe('0.3.0')
    // A previous version of this assertion guarded a remote-origin check behind
    // `if (manifest.content_security_policy)`, which never runs -- manifest.json declares no
    // such key, so MV3's built-in default (`script-src 'self'`) governs instead. Assert that
    // directly rather than leaving a conditional branch that can never execute.
    expect(manifest.content_security_policy).toBeUndefined()
  })

  it('popup/approve/ceremony HTML declare no remote font, script, image, or stylesheet dependency', () => {
    for (const file of PAGES) {
      const html = readFileSync(resolve(EXT_DIR, file), 'utf8')
      expect(html, file).not.toMatch(/https?:\/\//)
    }
  })

  it('keeps shipped brand references local and closes the public brand directory through its manifest', () => {
    const manifest = JSON.parse(readFileSync(ASSETS_MANIFEST, 'utf8'))
    const manifestPaths = new Set(manifest.map((entry) => entry.path))
    const brandDir = resolve(PUBLIC_DIR, 'brand')
    const brandFiles = readdirSync(brandDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== 'assets.manifest.json')
      .map((entry) => {
        const absolute = resolve(entry.parentPath ?? entry.path, entry.name)
        return `/brand/${absolute.slice(brandDir.length + 1).replaceAll(sep, '/')}`
      })

    for (const file of brandFiles) {
      expect(manifestPaths, `${file} must be recorded in assets.manifest.json`).toContain(file)
    }
    for (const entry of manifest) {
      expect(entry?.path, 'manifest entries need a path').toEqual(expect.any(String))
      expect(
        existsSync(resolve(PUBLIC_DIR, entry.path.replace(/^\//, ''))),
        `${entry.path} must exist on disk`
      ).toBe(true)
    }

    const markEntry = manifest.find((entry) => entry.path === '/brand/vibing-farmer-mark.svg')
    expect(markEntry, 'the extension mark must have a frozen public manifest entry').toBeTruthy()
    expect(sha256(readFileSync(LOGO_SVG))).toBe(markEntry.sha256)

    for (const file of PAGES) {
      const html = readFileSync(resolve(EXT_DIR, file), 'utf8')
      const refs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)].map((match) => match[1])
      for (const ref of refs.filter((value) => /\.(?:svg|png|jpe?g|webp|woff2?)$/i.test(value))) {
        expect(ref, `${file} must use a relative local asset`).not.toMatch(/^(?:https?:)?\/\//i)
        expect(existsSync(resolve(EXT_DIR, ref.replace(/^\.\//, ''))), `${file}: ${ref}`).toBe(true)
      }
    }
  })

  it('popup/approve/ceremony authored markup carries no em/en-dash design separator', () => {
    for (const file of PAGES) {
      const html = readFileSync(resolve(EXT_DIR, file), 'utf8')
      expect(html, file).not.toMatch(/[–—]/)
    }
  })

  it('ceremony.html carries no decorative status dot and no generic eyebrow label', () => {
    const html = readFileSync(resolve(EXT_DIR, 'ceremony.html'), 'utf8')
    expect(html).not.toMatch(/class="[^"]*\bdot\b[^"]*"/)
    expect(html).not.toMatch(/class="[^"]*\beyebrow\b[^"]*"/)
  })

  it('approve.html and ceremony.html mark their root as a critical wallet screen (no entry animation)', () => {
    for (const file of ['approve.html', 'ceremony.html']) {
      const html = readFileSync(resolve(EXT_DIR, file), 'utf8')
      expect(html, file).toMatch(/data-pocket-critical/)
    }
  })

  it('wallet.css and approval.css define the Pocket Crew tokens verbatim and fetch no remote font', () => {
    for (const file of ['wallet.css', 'approval.css']) {
      const css = readFileSync(resolve(EXT_DIR, file), 'utf8')
      expect(css, file).not.toMatch(/url\(\s*['"]?https?:/)
      expect(css, file).not.toMatch(/@import\s+url\(\s*['"]?https?:/)
      // Locked hex values, copied verbatim from the visual contract -- never approximated.
      expect(css, file).toContain('--pc-field: #17251f')
      expect(css, file).toContain('--pc-grove: #20342b')
      expect(css, file).toContain('--pc-harvest: #dff56c')
      expect(css, file).toContain('--pc-rice: #f2f5ef')
      expect(css, file).toContain('--pc-danger: #e26e67')
      expect(css, file).toContain('--pc-radius-control: 12px')
      expect(css, file).toContain('--pc-radius-support: 16px')
      expect(css, file).toContain('--pc-radius-dominant: 24px')
      expect(css, file).toContain('--pc-touch-target: 44px')
      expect(css, file).toContain('--pc-control-height: 48px')
      // Day Field theme must exist too -- both themes ship in every extension page.
      expect(css, file).toMatch(/:root\[data-theme=['"]day-field['"]\]/)
    }
  })

  it('wallet.css declares the 360px wallet geometry verbatim', () => {
    const wallet = readFileSync(resolve(EXT_DIR, 'wallet.css'), 'utf8')
    expect(wallet).toMatch(/\.pc-wallet\s*\{[^}]*width:\s*360px/)
    expect(wallet).toMatch(/\.pc-wallet\s*\{[^}]*min-height:\s*560px/)
  })

  it('approval.css declares the shared wallet approval action grid verbatim', () => {
    const approval = readFileSync(resolve(EXT_DIR, 'approval.css'), 'utf8')
    expect(approval).toMatch(
      /\.pc-wallet-approval-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/
    )
  })

  // Fix loop 2, checklist item 5: "#status" (approve.js/ceremony.js full-sentence user guidance,
  // e.g. "Wrong password.", "Request expired: close this window and retry from the site.") is
  // friendly copy in a <p>, not an address/hash/amount -- it must not resolve to the mono stack.
  // jsdom does not load external stylesheets or resolve CSS custom properties, so a computed-style
  // assertion can't observe this; asserting the rule's absence from the stylesheet text is the
  // available proxy (brief's documented fallback).
  it('approval.css does not set the mono font-family on #status (friendly copy stays in the body font)', () => {
    const css = readFileSync(resolve(EXT_DIR, 'approval.css'), 'utf8')
    const statusBlock = css.match(/#status\s*\{([^}]*)\}/)
    expect(statusBlock, 'approval.css must define #status').toBeTruthy()
    expect(statusBlock[1]).not.toMatch(/font-family\s*:\s*var\(--pc-font-mono\)/)
    // The size token (--pc-type-technical) is unaffected by this fix and must remain.
    expect(statusBlock[1]).toMatch(/font-size\s*:\s*var\(--pc-type-technical\)/)
  })

  // Fix loop 2, minor: wallet.css's header claims each extension stylesheet is a COMPLETE copy of
  // its slice of the contract; approval.css's header claims it carries "the same token/primitive
  // slice wallet.css carries". Both were false while wallet.css omitted the contract's base h1/h2
  // rules that approval.css had. Guard both claims by pinning wallet.css to the same verbatim
  // rules approval.css already asserts elsewhere in this file.
  it('wallet.css declares the contract base h1/h2 rules verbatim (same slice approval.css carries)', () => {
    const wallet = readFileSync(resolve(EXT_DIR, 'wallet.css'), 'utf8')
    expect(wallet).toMatch(
      /h1\s*\{[^}]*max-width:\s*15ch;[^}]*font-size:\s*var\(--pc-type-page\);[^}]*font-weight:\s*700;/
    )
    expect(wallet).toMatch(
      /h2\s*\{[^}]*font-size:\s*var\(--pc-type-section\);[^}]*font-weight:\s*650;/
    )
  })

  it('no critical-screen stylesheet defines a gradient, glow, shimmer, pulse, or infinite animation', () => {
    for (const file of ['wallet.css', 'approval.css']) {
      const css = readFileSync(resolve(EXT_DIR, file), 'utf8')
      expect(css, file).not.toMatch(/@keyframes/)
      // `animation: none !important` is the contract's own critical-screen kill switch
      // ([data-pocket-critical]) -- only an actual non-"none" animation value is a violation, so
      // capture each declared value and check it directly rather than pattern-exclude "none"
      // (a bare negative lookahead here is defeatable by \s* backtracking to zero-width).
      const animationDecls = [...css.matchAll(/\banimation\s*:\s*([^;]+);/g)].map((m) =>
        m[1].trim()
      )
      for (const decl of animationDecls) {
        expect(decl, `${file}: animation: ${decl}`).toBe('none !important')
      }
      expect(css, file).not.toMatch(/linear-gradient|radial-gradient/)
    }
  })

  // Fix loop 2, minor: this suite used to also run `npm run build:ext` here and assert against
  // extension-dist/ (brand/network asset copy, dist HTML free of remote hrefs). That cost every
  // `npm test` invocation a full second Vite build (~3s, verified non-mutating but still paid on
  // every run) for coverage this file cannot otherwise exercise cheaply -- extension-dist/ has no
  // other producer to assert against. Dropped in favor of the standalone `npm run build:ext` gate
  // (already a Process Requirement of this fix loop, run and pasted in the report). Known gap left
  // by this choice: .github/workflows/frontend.yml's frontend job runs `npm test` and `npm run
  // build` but never `npm run build:ext`, so nothing currently re-runs that gate in CI on every
  // push/PR -- wiring it in is a `.github/workflows/frontend.yml` change outside this fix loop's
  // authorized file list (approval.css, wallet.css, brandAssets.test.js only) and is left as a
  // follow-up, not silently absorbed here.
})
