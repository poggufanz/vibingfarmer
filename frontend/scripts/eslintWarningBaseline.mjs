// Core logic behind `npm run lint:ci` / `npm run lint:warnings:update`. Kept separate from the
// CLI (check-eslint-warning-baseline.mjs) so the comparison/fingerprinting logic is unit-testable
// without invoking ESLint itself.
//
// A "fingerprint" is {relativePath, ruleId, messageId, message} — deliberately no line/column,
// so moving code around doesn't count as a new warning. The baseline stores a count per
// fingerprint (multiplicity), because the same fingerprint can legitimately occur more than once
// (e.g. the same rule/message repeated at several call sites in one file). `npm run lint:ci`
// fails on any ESLint error, or on any fingerprint whose current count exceeds its baseline
// count (including a fingerprint that didn't exist in the baseline at all, i.e. baseline count
// 0). A fingerprint's count going down, or disappearing entirely, always passes — the baseline
// is a ceiling, not a target to match exactly.
import path from 'node:path'

export function computeRelativePath(absPath, root) {
  return path.relative(root, absPath).split(path.sep).join('/')
}

export function fingerprintKey({ relativePath, ruleId, messageId, message }) {
  return JSON.stringify([relativePath, ruleId ?? null, messageId ?? null, message])
}

export function parseFingerprintKey(key) {
  const [relativePath, ruleId, messageId, message] = JSON.parse(key)
  return { relativePath, ruleId, messageId, message }
}

// results: ESLint's LintResult[] (only .filePath and .messages[].{severity,ruleId,messageId,message} read).
export function buildFingerprints(results, root) {
  const counts = new Map()
  let errorCount = 0
  let totalWarnings = 0
  for (const result of results) {
    const relativePath = computeRelativePath(result.filePath, root)
    for (const msg of result.messages) {
      if (msg.severity === 2) {
        errorCount++
        continue
      }
      if (msg.severity !== 1) continue
      totalWarnings++
      const key = fingerprintKey({
        relativePath,
        ruleId: msg.ruleId,
        messageId: msg.messageId,
        message: msg.message,
      })
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return { counts, errorCount, totalWarnings }
}

export function loadBaseline(json) {
  const entries = JSON.parse(json)
  const map = new Map()
  for (const entry of entries) {
    const { count, ...fp } = entry
    map.set(fingerprintKey(fp), count)
  }
  return map
}

// Sorted output so re-running the update script twice on an unchanged tree produces a byte-identical
// file (no diff noise from Map iteration order).
export function serializeBaseline(counts) {
  const entries = [...counts.entries()]
    .map(([key, count]) => ({ ...parseFingerprintKey(key), count }))
    .sort((a, b) => {
      if (a.relativePath !== b.relativePath) return a.relativePath < b.relativePath ? -1 : 1
      const aRule = a.ruleId ?? ''
      const bRule = b.ruleId ?? ''
      if (aRule !== bRule) return aRule < bRule ? -1 : 1
      return a.message < b.message ? -1 : a.message > b.message ? 1 : 0
    })
  return JSON.stringify(entries, null, 2) + '\n'
}

export function compareToBaseline(currentCounts, baselineCounts) {
  const additions = []
  let totalCurrentWarnings = 0
  for (const [key, currentCount] of currentCounts) {
    totalCurrentWarnings += currentCount
    const baselineCount = baselineCounts.get(key) ?? 0
    if (currentCount > baselineCount) {
      additions.push({
        ...parseFingerprintKey(key),
        baselineCount,
        currentCount,
        delta: currentCount - baselineCount,
      })
    }
  }
  return { additions, totalCurrentWarnings }
}

// Baseline updates are a reviewed, human decision — never something CI silently regenerates
// and re-commits. Refusing under CI=true is what makes `lint:ci` a real gate instead of a
// checker that can quietly launder its own baseline forward on every run.
export function assertUpdateAllowed(env = process.env) {
  if (env.CI === 'true') {
    throw new Error(
      'lint:warnings:update refuses to run when CI=true — baseline updates must be reviewed and committed locally.'
    )
  }
}
