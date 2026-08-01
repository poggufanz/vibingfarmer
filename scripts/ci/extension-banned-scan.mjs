import {
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BANNED_EXTENSION_STRINGS = Object.freeze([
  'executeAgentDeposit',
  'executeAgentApprove',
  'runAutonomousExit',
  'https://fonts',
  'vf_base_owner_address',
])

export function scanExtensionDirectory(target) {
  const root = path.resolve(target)
  if (!statSync(root).isDirectory()) {
    throw new Error(`scan target is not a directory: ${root}`)
  }

  const findings = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(absolutePath)
        continue
      }
      if (!entry.isFile()) {
        throw new Error(`unsupported entry in scan target: ${absolutePath}`)
      }

      const contents = readFileSync(absolutePath, 'utf8')
      for (const banned of BANNED_EXTENSION_STRINGS) {
        if (contents.includes(banned)) {
          findings.push({
            banned,
            file: path.relative(root, absolutePath),
          })
        }
      }
    }
  }
  return findings
}

export function main(args = process.argv.slice(2)) {
  if (args.length !== 1) {
    console.error('extension scan ERROR: expected exactly one directory argument')
    return 2
  }

  try {
    const findings = scanExtensionDirectory(args[0])
    if (findings.length > 0) {
      for (const finding of findings) {
        console.error(`extension scan BANNED: ${finding.file}: ${finding.banned}`)
      }
      return 1
    }
    console.log(`extension scan OK: ${path.resolve(args[0])}`)
    return 0
  } catch (error) {
    console.error(`extension scan ERROR: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

const isEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isEntrypoint) {
  process.exitCode = main()
}
