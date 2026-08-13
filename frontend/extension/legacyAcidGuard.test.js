import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')
const files = [
  'extension/popup.jsx',
  'extension/popup.html',
  'extension/wallet.css',
  'extension/approve.html',
  'extension/ceremony.html',
  'extension/approval.css',
  'src/wallet/ui/WalletShell.jsx',
  'src/wallet/ui/HonestyLabels.jsx',
  'src/wallet/ui/WalletSettings.jsx',
  'src/wallet/ui/classic/AddAssetScreen.jsx',
  'src/wallet/ui/classic/BackupScreen.jsx',
]

describe('retired Acid surface is absent from shipped wallet code', () => {
  it('contains no old shell, prepaint, lava, gradient, or inline page-style authority', () => {
    for (const file of files) {
      const source = fs.readFileSync(path.join(root, file), 'utf8')
      expect(source, file).not.toMatch(
        /Acid|acid-yield|btn-lava|vf-head|vf-history|#0e0f0c|--accent\s*:\s*#cfff3d/i
      )
    }
    expect(fs.readFileSync(path.join(root, 'extension/popup.html'), 'utf8')).not.toMatch(
      /<style[ >]/i
    )
    expect(fs.readFileSync(path.join(root, 'extension/ceremony.html'), 'utf8')).not.toMatch(
      /<style[ >]/i
    )
  })
})
