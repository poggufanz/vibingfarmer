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
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const FRONTEND_DIR = resolve(import.meta.dirname, '..')
const EXT_DIR = resolve(FRONTEND_DIR, 'extension')
const PUBLIC_DIR = resolve(FRONTEND_DIR, 'public')
const DIST_DIR = resolve(FRONTEND_DIR, 'extension-dist')
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

      for (const size of ICON_SIZES) {
        const pngA = readFileSync(resolve(runA.iconsDir, `icon-${size}.png`))
        const pngB = readFileSync(resolve(runB.iconsDir, `icon-${size}.png`))
        expect(readPngSize(pngA), `icon-${size}.png`).toEqual({ width: size, height: size })
        expect(sha256(pngA), `icon-${size}.png byte-stability across independent runs`).toBe(
          sha256(pngB)
        )
      }
    } finally {
      runA.cleanup()
      runB.cleanup()
    }

    expect(sha256(readFileSync(LOGO_SVG)), 'tracked logo must be unchanged').toBe(
      trackedLogoBefore
    )
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
      writeFileSync(dir.svgPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>\n')
      expect(() => execFileSync('node', [dir.scriptPath], { stdio: 'pipe' })).toThrow()
    } finally {
      dir.cleanup()
    }
    expect(sha256(readFileSync(LOGO_SVG)), 'tracked logo must be unchanged').toBe(
      trackedLogoBefore
    )
  })

  it('manifest.json reports the bumped MV3 version and defines no content_security_policy override, so MV3\'s default script-src \'self\' applies', () => {
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
    expect(approval).toMatch(/\.pc-wallet-approval-actions\s*\{[^}]*grid-template-columns:\s*1fr 1\.35fr/)
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

  it('extension-dist ships the reviewed brand mark and network subset with no remote resource in the built HTML', () => {
    execFileSync('npm', ['run', 'build:ext'], { cwd: FRONTEND_DIR, stdio: 'pipe' })

    expect(existsSync(resolve(DIST_DIR, 'brand/vibing-farmer-mark.svg'))).toBe(true)
    expect(existsSync(resolve(DIST_DIR, 'brand/vibing-farmer-mark-forest.svg'))).toBe(true)
    expect(existsSync(resolve(DIST_DIR, 'brand/vibing-farmer-mark-day.svg'))).toBe(true)
    expect(existsSync(resolve(DIST_DIR, 'brand/vibing-farmer-lockup-forest.svg'))).toBe(true)
    expect(existsSync(resolve(DIST_DIR, 'brand/networks/stellar.svg'))).toBe(true)
    expect(existsSync(resolve(DIST_DIR, 'brand/networks/stellar-white.svg'))).toBe(true)
    expect(existsSync(resolve(DIST_DIR, 'brand/networks/base.svg'))).toBe(true)
    expect(existsSync(resolve(DIST_DIR, 'manifest.json'))).toBe(true)
    for (const size of ICON_SIZES) {
      expect(existsSync(resolve(DIST_DIR, `icons/icon-${size}.png`))).toBe(true)
    }

    for (const file of PAGES) {
      const html = readFileSync(resolve(DIST_DIR, file), 'utf8')
      // A built page may legitimately embed a data:image/svg+xml,... URI whose payload contains
      // the SVG namespace string "http://www.w3.org/2000/svg" -- that is a fully-inlined asset,
      // not a fetch. Only a real fetchable attribute/url() pointed at a remote origin counts.
      expect(html, file).not.toMatch(/(?:href|src)\s*=\s*["']https?:\/\//)
      expect(html, file).not.toMatch(/url\(\s*['"]?https?:\/\//)
    }
  }, 30000)
})
