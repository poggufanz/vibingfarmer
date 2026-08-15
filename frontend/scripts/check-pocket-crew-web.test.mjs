import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test as nodeTest } from 'node:test'

import { WEB_PRODUCTION_FILES, runWebCheck, scanWebSource } from './check-pocket-crew-web.mjs'

const test = process.env.VITEST_WORKER_ID ? (await import('vitest')).test : nodeTest

const codes = (source, path = 'src/example.css') =>
  scanWebSource(source, path).map((finding) => finding.code)

test('exports the explicit web inventory without Foundation, Wallet, or extension paths', () => {
  assert.ok(WEB_PRODUCTION_FILES.length > 0)
  assert.ok(WEB_PRODUCTION_FILES.every((path) => !path.includes('wallet')))
  assert.ok(WEB_PRODUCTION_FILES.every((path) => !path.startsWith('extension/')))
  assert.ok(WEB_PRODUCTION_FILES.every((path) => !path.endsWith('.test.js')))
  assert.ok(WEB_PRODUCTION_FILES.every((path) => !path.endsWith('.test.jsx')))
  assert.ok(WEB_PRODUCTION_FILES.every((path) => path !== 'src/design/pocket-crew.css'))
  assert.ok(WEB_PRODUCTION_FILES.every((path) => path !== 'src/app.jsx'))
})

test('reports each retired style declaration after stripping explanatory comments', () => {
  const mutations = [
    ['acid selector', '.acid-yield { color: #fff; }', 'RETIRED_STYLE'],
    ['acid color', '.surface { color: #cfff3d; }', 'RETIRED_STYLE'],
    ['gradient', '.surface { background: linear-gradient(#000, #fff); }', 'UNAPPROVED_EFFECT'],
    ['glow', '.surface { box-shadow: 0 0 20px red; }', 'UNAPPROVED_EFFECT'],
    ['shimmer', '.shimmer { opacity: 1; }', 'UNAPPROVED_EFFECT'],
    ['backdrop filter', '.surface { backdrop-filter: blur(8px); }', 'UNAPPROVED_EFFECT'],
    ['repeat forever', '.surface { repeat: -1; }', 'REPEAT_FOREVER'],
    ['infinite animation', '.surface { animation: pulse 1s infinite; }', 'INFINITE_ANIMATION'],
    ['off lock radius', '.surface { border-radius: 8px; }', 'OFF_LOCK_RADIUS'],
    ['off lock layer', '.surface { z-index: 30; }', 'LAYER_LITERAL'],
    ['compat fallback', '.surface { color: var(--text, #fff); }', 'COMPAT_FALLBACK'],
  ]

  for (const [label, mutation, expectedCode] of mutations) {
    assert.ok(codes(mutation).includes(expectedCode), `${label} mutation must fail`)
  }

  const commented = `/* ${mutations.map(([, mutation]) => mutation).join('\n')} */\n.surface { color: var(--text); }`
  assert.deepEqual(codes(commented), [], 'comments must not masquerade as declarations')
})

test('rejects embedded style tags only in production route sources', () => {
  assert.ok(
    codes('<style>{legacy}</style>', 'src/components/ExplorerPage.jsx').includes('EMBEDDED_STYLE')
  )
  assert.deepEqual(codes('<style>{fixture}</style>', 'src/components/ExplorerPage.test.jsx'), [])
  assert.deepEqual(codes('<style>{wallet}</style>', 'src/wallet/ui/WalletShell.jsx'), [])
  assert.deepEqual(codes('<style>{extension}</style>', 'extension/popup.jsx'), [])
})

test('checks quoted inline layer values while ignoring ordinary strings', () => {
  assert.ok(
    codes('<div style={{ zIndex: "30" }} />', 'src/components/ExplorerPage.jsx').includes(
      'LAYER_LITERAL'
    )
  )
  assert.deepEqual(codes('const copy = "zIndex: 30"', 'src/components/ExplorerPage.jsx'), [])
})

test('allows named state-bearing progress animation but still rejects ambient infinite animation', () => {
  assert.deepEqual(
    codes('.think-spin { animation: think-spin-rot 0.7s linear infinite; }'),
    [],
    'the live progress spinner is semantic state feedback'
  )
  assert.deepEqual(codes('.ambient-sweep { animation: ambient-sweep 1s ease infinite; }'), [
    'INFINITE_ANIMATION',
  ])
  assert.deepEqual(
    codes('.loop-rail.sleeping .loop-stage { animation: breathe 6s ease infinite; }'),
    [],
    'the sleeping rail is semantic pipeline state feedback'
  )
})

test('runWebCheck delegates the ten Foundation files and checks the secondary inventory', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'vf-web-check-'))
  try {
    await mkdir(resolve(root, 'src'), { recursive: true })
    await writeFile(resolve(root, 'style.css'), ':root { color: var(--text); }')
    for (const relativePath of WEB_PRODUCTION_FILES) {
      const path = resolve(root, relativePath)
      await mkdir(resolve(path, '..'), { recursive: true })
      await writeFile(path, '')
    }
    const result = runWebCheck({ root })
    assert.equal(result.ok, true)
    assert.equal(result.filesChecked, WEB_PRODUCTION_FILES.length)
    assert.equal(result.delegatedFoundationFiles.length, 10)
    assert.ok(result.delegatedFoundationFiles.every((path) => path.startsWith('src/')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runWebCheck ignores exact repo-root Wallet and extension trees', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'vf-web-boundary-'))
  try {
    await mkdir(resolve(root, 'frontend/src'), { recursive: true })
    await writeFile(resolve(root, 'frontend/style.css'), ':root { color: var(--text); }')
    for (const relativePath of WEB_PRODUCTION_FILES) {
      const path = resolve(root, 'frontend', relativePath)
      await mkdir(resolve(path, '..'), { recursive: true })
      await writeFile(path, '')
    }
    await mkdir(resolve(root, 'frontend/src/wallet/ui'), { recursive: true })
    await mkdir(resolve(root, 'frontend/extension'), { recursive: true })
    await writeFile(
      resolve(root, 'frontend/src/wallet/ui/WalletShell.jsx'),
      '<style>.wallet { z-index: 999; }</style>'
    )
    await writeFile(
      resolve(root, 'frontend/extension/popup.jsx'),
      '.acid-yield { color: #cfff3d; }'
    )
    const result = runWebCheck({ root })
    assert.equal(result.ok, true)
    assert.equal(
      result.findings.some((finding) => /wallet|extension/iu.test(finding.path)),
      false
    )
    assert.deepEqual(result.excludedPaths, ['frontend/src/wallet/**', 'frontend/extension/**'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
