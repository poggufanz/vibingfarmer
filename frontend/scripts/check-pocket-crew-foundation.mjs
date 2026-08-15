// Primary Pocket Crew Foundation boundary. This scanner deliberately owns only the small,
// shared Foundation surface; route-wide legacy styling remains the Secondary scanner in
// src/design/legacyPocketStyle.test.js.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FOUNDATION_ASSET_PATHS, assertFoundationAssetManifest } from '../src/design/brandAssets.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..')

const FOUNDATION_RELATIVE_FILES = Object.freeze([
  ['pocket-crew.css', 'src/design/pocket-crew.css'],
  ['pocket-crew-contract.js', 'src/design/pocket-crew-contract.js'],
  ['pocket-crew-foundation.js', 'src/design/pocket-crew-foundation.js'],
  ['BrandLockup.jsx', 'src/components/pocket/BrandLockup.jsx'],
  ['NetworkIdentity.jsx', 'src/components/pocket/NetworkIdentity.jsx'],
  ['AgentMark.jsx', 'src/components/pocket/AgentMark.jsx'],
  ['Primitives.jsx', 'src/components/pocket/Primitives.jsx'],
  ['RouteFocus.jsx', 'src/components/pocket/RouteFocus.jsx'],
  ['components.jsx', 'src/components.jsx'],
  ['app.jsx', 'src/app.jsx'],
])

export const FOUNDATION_FILES = Object.freeze(
  FOUNDATION_RELATIVE_FILES.map(([name, file]) =>
    Object.freeze([name, resolve(DEFAULT_ROOT, file)])
  )
)

const CODE_ORDER = Object.freeze([
  'LAYER_LITERAL',
  'MONEY_MONO',
  'RETIRED_EFFECT',
  'RAW_SPACING',
  'UNMANIFESTED_ASSET',
  'LEGACY_SCOPE',
])

const FOUNDATION_ASSET_SET = new Set(FOUNDATION_ASSET_PATHS)

function maskComments(source) {
  const chars = source.split('')
  let quote = null

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    const next = chars[index + 1]

    if (quote) {
      if (char === '\\') {
        index += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }

    if (char === '/' && next === '/') {
      chars[index] = ' '
      index += 1
      while (index < chars.length && chars[index] !== '\n') {
        chars[index] = ' '
        index += 1
      }
      index -= 1
      continue
    }

    if (char === '/' && next === '*') {
      chars[index] = ' '
      chars[index + 1] = ' '
      index += 2
      while (index < chars.length) {
        if (chars[index] === '*' && chars[index + 1] === '/') {
          chars[index] = ' '
          chars[index + 1] = ' '
          index += 1
          break
        }
        if (chars[index] !== '\n') chars[index] = ' '
        index += 1
      }
      continue
    }
  }

  return chars.join('')
}

function maskStrings(source) {
  const chars = source.split('')
  let quote = null

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    if (!quote) {
      if (char === "'" || char === '"' || char === '`') {
        quote = char
        chars[index] = ' '
      }
      continue
    }

    if (char === '\\') {
      chars[index] = ' '
      if (index + 1 < chars.length && chars[index + 1] !== '\n') chars[index + 1] = ' '
      index += 1
      continue
    }

    if (char === quote) {
      chars[index] = ' '
      quote = null
    } else if (char !== '\n') {
      chars[index] = ' '
    }
  }

  return chars.join('')
}

function sourceLocation(source, index) {
  const before = source.slice(0, index)
  const line = before.split('\n').length
  const lastNewline = before.lastIndexOf('\n')
  return { line, column: index - lastNewline }
}

function makeFinding(code, path, source, index, message) {
  const location = sourceLocation(source, Math.max(0, index))
  return Object.freeze({
    code,
    path,
    line: location.line,
    column: location.column,
    message,
  })
}

function collectMatches(findings, source, path, code, pattern, message) {
  pattern.lastIndex = 0
  let match
  while ((match = pattern.exec(source)) !== null) {
    findings.push(makeFinding(code, path, source, match.index, message))
    if (match[0].length === 0) pattern.lastIndex += 1
  }
}

function collectJsxInlineViolations(findings, activeSource, sourceWithStrings, path) {
  const mono = /(?:--(?:pc-)?font-mono|--mono|JetBrains\s+Mono|ui-monospace|monospace)/iu
  const tagPattern = /<[A-Za-z][^>\n]*>/gu
  const fontPattern = /(?:\bfontFamily\b|['"]font-family['"])\s*:\s*(?:(['"])(.*?)\1|([^,}\n]+))/giu
  const layerPattern =
    /(?:\bz[\s_-]*index\b|['"]z-index['"])\s*:\s*(?:(['"])([-+]?\d+(?:\.\d+)?)\1)/giu

  let tagMatch
  while ((tagMatch = tagPattern.exec(activeSource)) !== null) {
    const originalTag = sourceWithStrings.slice(tagMatch.index, tagMatch.index + tagMatch[0].length)
    if (originalTag.length !== tagMatch[0].length) continue

    const tagName = originalTag.match(/^<([A-Za-z][\w.]*)/u)?.[1] ?? ''
    const className = originalTag.match(/\bclassName\s*=\s*(['"])(.*?)\1/iu)?.[2] ?? ''
    const isMoney =
      tagName === 'MoneyFigure' || /(?:^|\s)pc-money(?:--[\w-]+)?(?=\s|$)/u.test(className)
    const styleMatch = originalTag.match(/\bstyle\s*=\s*\{\{([\s\S]*?)\}\}/u)
    if (!styleMatch) continue

    const style = styleMatch[1]
    const styleOffset = originalTag.indexOf(style)
    if (isMoney) {
      fontPattern.lastIndex = 0
      let fontMatch
      while ((fontMatch = fontPattern.exec(style)) !== null) {
        const value = fontMatch[2] ?? fontMatch[3] ?? ''
        if (!mono.test(value)) continue
        findings.push(
          makeFinding(
            'MONEY_MONO',
            path,
            activeSource,
            tagMatch.index + styleOffset + fontMatch.index,
            'money surfaces must use the Foundation body face, not monospace'
          )
        )
      }
    }

    layerPattern.lastIndex = 0
    let layerMatch
    while ((layerMatch = layerPattern.exec(style)) !== null) {
      findings.push(
        makeFinding(
          'LAYER_LITERAL',
          path,
          activeSource,
          tagMatch.index + styleOffset + layerMatch.index,
          'Foundation layers must use a --pc-z-* token'
        )
      )
    }
  }
}

function collectMoneyMono(findings, activeSource, sourceWithStrings, path) {
  const mono = /(?:--(?:pc-)?font-mono|--mono|JetBrains\s+Mono|ui-monospace|monospace)/iu
  const cssSelector = /(?:\.pc-money\b|\[data-pc-money\])[^{]*\{[^}]*\}/giu
  let match
  const cssSource = /\.css$/iu.test(path) ? sourceWithStrings : activeSource
  cssSelector.lastIndex = 0
  while ((match = cssSelector.exec(cssSource)) !== null) {
    const block = match[0]
    if (/font-family\s*:\s*[^;}]+/iu.test(block) && mono.test(block)) {
      const offset = match.index + block.search(/font-family\s*:/iu)
      findings.push(
        makeFinding(
          'MONEY_MONO',
          path,
          cssSource,
          offset,
          'money surfaces must use the Foundation body face, not monospace'
        )
      )
    }
  }

  const jsxMoney =
    /(?:MoneyFigure\b|pc-money\b)[\s\S]{0,240}?(?:fontFamily|font-family)\s*[:=]\s*[^,;}\n]+/giu
  jsxMoney.lastIndex = 0
  while ((match = jsxMoney.exec(activeSource)) !== null) {
    if (mono.test(match[0])) {
      findings.push(
        makeFinding(
          'MONEY_MONO',
          path,
          activeSource,
          match.index,
          'money surfaces must use the Foundation body face, not monospace'
        )
      )
    }
  }
}

function normalizedAssetPaths(paths) {
  if (paths instanceof Set) return paths
  if (Array.isArray(paths)) return new Set(paths.filter((path) => typeof path === 'string'))
  return FOUNDATION_ASSET_SET
}

/**
 * Scan one source string against the Primary Foundation boundary.
 *
 * Comments and string contents are masked for style rules so historical explanations and fixture
 * prose cannot become violations. Asset paths are read from the comment-masked source because an
 * actual path is necessarily a string literal in JSX/JavaScript.
 *
 * @param {string} text
 * @param {string} path
 * @returns {Array<{code:string,path:string,line:number,column:number,message:string}>}
 */
export function scanFoundationSource(text, path, allowedAssetPaths = FOUNDATION_ASSET_PATHS) {
  if (typeof text !== 'string' || typeof path !== 'string' || path.length === 0) {
    return [
      makeFinding(
        'LEGACY_SCOPE',
        typeof path === 'string' && path.length > 0 ? path : '(unknown)',
        '',
        0,
        'Foundation source must be a readable string with a named path'
      ),
    ]
  }

  const commentMasked = maskComments(text)
  const active = maskStrings(commentMasked)
  const findings = []

  collectMatches(
    findings,
    active,
    path,
    'LAYER_LITERAL',
    /\bz[\s_-]*index\s*:\s*[-+]?\d+(?:\.\d+)?\b/giu,
    'Foundation layers must use a --pc-z-* token'
  )

  collectJsxInlineViolations(findings, active, commentMasked, path)
  collectMoneyMono(findings, active, commentMasked, path)

  collectMatches(
    findings,
    active,
    path,
    'RETIRED_EFFECT',
    /(?:\b(?:linear|radial|conic)-gradient\s*\(|@keyframes\b)/giu,
    'gradients and keyframe effects are retired from Foundation'
  )
  const animationPattern = /\banimation(?:-name)?\s*:\s*([^;{}\n]+)/giu
  animationPattern.lastIndex = 0
  let animationMatch
  while ((animationMatch = animationPattern.exec(active)) !== null) {
    if (/^none(?:\s|!|$)/iu.test(animationMatch[1])) continue
    findings.push(
      makeFinding(
        'RETIRED_EFFECT',
        path,
        active,
        animationMatch.index,
        'Foundation animation must be absent or explicitly reset to none'
      )
    )
  }

  collectMatches(
    findings,
    active,
    path,
    'RAW_SPACING',
    /var\(\s*--pc-space-[a-z0-9-]+\s*,/giu,
    'Foundation spacing tokens must not carry raw fallbacks'
  )

  collectMatches(
    findings,
    active,
    path,
    'LAYER_LITERAL',
    /\bz[\s_-]*index\s*:\s*var\(\s*--pc-z-[a-z0-9-]+\s*,\s*[-+]?\d+(?:\.\d+)?\s*\)/giu,
    'Foundation layers must use a --pc-z-* token without a raw fallback'
  )

  collectMatches(
    findings,
    active,
    path,
    'LEGACY_SCOPE',
    /\bdata-palette\b/giu,
    'data-palette is a retired theme scope'
  )

  const assetPaths = normalizedAssetPaths(allowedAssetPaths)
  const assetPattern = /\/brand\/[A-Za-z0-9._~!$&+;=@%\-/]+/gu
  assetPattern.lastIndex = 0
  let assetMatch
  while ((assetMatch = assetPattern.exec(commentMasked)) !== null) {
    const assetPath = assetMatch[0]
    if (!assetPaths.has(assetPath)) {
      findings.push(
        makeFinding(
          'UNMANIFESTED_ASSET',
          path,
          commentMasked,
          assetMatch.index,
          `Foundation asset path is not present in the checked manifest: ${assetPath}`
        )
      )
    }
  }

  const ruleOrder = new Map(CODE_ORDER.map((code, index) => [code, index]))
  findings.sort(
    (left, right) =>
      left.line - right.line ||
      left.column - right.column ||
      (ruleOrder.get(left.code) ?? Number.MAX_SAFE_INTEGER) -
        (ruleOrder.get(right.code) ?? Number.MAX_SAFE_INTEGER) ||
      left.message.localeCompare(right.message)
  )
  const seen = new Set()
  return findings.filter((finding) => {
    const key = `${finding.code}\u0000${finding.path}\u0000${finding.line}\u0000${finding.column}\u0000${finding.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function resolveFrontendRoot(root) {
  const candidate = resolve(root)
  if (existsSync(resolve(candidate, 'src'))) return candidate
  const nested = resolve(candidate, 'frontend')
  if (existsSync(resolve(nested, 'src'))) return nested
  return candidate
}

function fileEntriesForRoot(frontendRoot) {
  return FOUNDATION_FILES.map(([name, defaultPath]) => [
    name,
    resolve(frontendRoot, relative(DEFAULT_ROOT, defaultPath)),
  ])
}

function closureFinding(path, error) {
  const reason = error instanceof Error ? error.message : String(error)
  return makeFinding(
    'UNMANIFESTED_ASSET',
    path,
    '',
    0,
    `Foundation asset manifest closure failed: ${reason}`
  )
}

/**
 * Run the Primary Foundation check against exactly FOUNDATION_FILES and the shared asset closure.
 *
 * @param {{root:string}} input
 * @returns {{ok:boolean,findings:Array,filesChecked:number,report:string}}
 */
export function runFoundationCheck(input) {
  const { root = DEFAULT_ROOT } = input ?? {}
  const filesChecked = FOUNDATION_FILES.length
  if (typeof root !== 'string' || root.trim().length === 0) {
    const finding = makeFinding(
      'LEGACY_SCOPE',
      '(root)',
      '',
      0,
      'Foundation check requires a non-empty frontend root'
    )
    return {
      ok: false,
      findings: [finding],
      filesChecked,
      report: `foundation files checked: ${filesChecked}`,
    }
  }

  const frontendRoot = resolveFrontendRoot(root)
  const findings = []
  const manifestPath = resolve(frontendRoot, 'public/brand/assets.manifest.json')
  let manifestPaths = new Set(FOUNDATION_ASSET_PATHS)

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assertFoundationAssetManifest(manifest, FOUNDATION_ASSET_PATHS)
    manifestPaths = new Set(
      manifest
        .filter((entry) => entry && typeof entry === 'object' && typeof entry.path === 'string')
        .map((entry) => entry.path)
    )
  } catch (error) {
    findings.push(closureFinding('public/brand/assets.manifest.json', error))
  }

  for (const [name, filePath] of fileEntriesForRoot(frontendRoot)) {
    let source
    try {
      source = readFileSync(filePath, 'utf8')
    } catch (error) {
      findings.push(
        makeFinding(
          'LEGACY_SCOPE',
          name,
          '',
          0,
          `Foundation source is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`
        )
      )
      continue
    }
    findings.push(...scanFoundationSource(source, name, manifestPaths))
  }

  const report = `foundation files checked: ${filesChecked}`
  return { ok: findings.length === 0, findings, filesChecked, report }
}

const THIS_FILE = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === THIS_FILE) {
  const result = runFoundationCheck({ root: DEFAULT_ROOT })
  if (!result.ok) {
    console.error(`foundation:check FAILED — ${result.report}`)
    for (const finding of result.findings) {
      console.error(
        `  - ${finding.code} ${finding.path}:${finding.line}:${finding.column} — ${finding.message}`
      )
    }
    process.exitCode = 1
  } else {
    console.log(`foundation:check OK — ${result.report}`)
  }
}
