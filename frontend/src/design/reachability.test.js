import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const DESIGN_DIR = import.meta.dirname
const FRONTEND_ROOT = resolve(DESIGN_DIR, '../..')
const SRC_DIR = resolve(FRONTEND_ROOT, 'src')

function stripComments(source) {
  const chars = source.split('')
  let quote = null
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    const next = chars[index + 1]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
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
    } else if (char === '/' && next === '*') {
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
    }
  }
  return chars.join('')
}

function productionSources() {
  const files = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name.startsWith('.') ||
        ['node_modules', 'dist', 'extension-dist', 'coverage', 'test-results', 'build'].includes(
          entry.name
        )
      )
        continue
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (
        /\.(?:css|jsx?|mjs)$/iu.test(entry.name) &&
        !/(?:\.test|\.spec)\.[cm]?[jt]sx?$/iu.test(entry.name)
      )
        files.push(path)
    }
  }
  walk(SRC_DIR)
  files.push(resolve(FRONTEND_ROOT, 'style.css'))
  return files
}

function productionText({ excludeDormantConsole = false } = {}) {
  const files = productionSources().filter(
    (path) =>
      !excludeDormantConsole || !path.replaceAll('\\', '/').includes('/src/components/console/')
  )
  return files.map((path) => stripComments(readFileSync(path, 'utf8'))).join('\n')
}

describe('retired operations console reachability', () => {
  it('removes the retired console stylesheet', () => {
    expect(existsSync(resolve(SRC_DIR, 'console.css'))).toBe(false)
  })

  it('has no production import or route reference to console.css', () => {
    const source = productionText()
    expect(source).not.toMatch(/(?:from|import\s*\(|require\s*\()[^\n]*console\.css/iu)
    expect(source).not.toMatch(/['"`]\/console(?:[/?'"`]|$)/iu)
  })

  it('does not mount an OpsConsole or ZoneFrame and keeps TweaksPanel as the only App dev panel', () => {
    const source = productionText({ excludeDormantConsole: true })
    expect(source).not.toMatch(/<\s*OpsConsole\b/iu)
    expect(source).not.toMatch(/<\s*ZoneFrame\b/iu)

    const appSource = stripComments(readFileSync(resolve(SRC_DIR, 'app.jsx'), 'utf8'))
    expect(appSource.match(/<\s*TweaksPanel\b/giu) || []).toHaveLength(1)
    expect(appSource).not.toMatch(/<\s*(?:OpsConsole|ConsolePanel)\b/iu)
  })

  it('keeps MemoryModal overlay and callback behavior intact', () => {
    const source = readFileSync(resolve(SRC_DIR, 'agents.jsx'), 'utf8')
    expect(source).toMatch(/const\s+MemoryModal\s*=\s*\(/u)
    expect(source).toMatch(/className="modal-backdrop"\s+onClick=\{onClose\}/u)
    expect(source).toMatch(/onClick=\{\(e\)\s*=>\s*e\.stopPropagation\(\)\}/u)
    expect(source).toMatch(/aria-label="Close"\s+onClick=\{onClose\}/u)
  })
})
