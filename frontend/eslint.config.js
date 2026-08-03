import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'extension-dist/**',
      'node_modules/**',
      '.vite/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: '18' } },
    rules: {
      // react-hooks@7 ships React-Compiler rules in configs.recommended that
      // would error across existing code; wire only the two canonical rules so
      // this baseline stays non-blocking (0 errors) while still catching the
      // high-value bugs: conditional hooks and stale effect deps.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-console': 'warn',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'react/jsx-uses-react': 'off',
      'react/react-in-jsx-scope': 'off',
    },
  },
  // Node-context server proxies, Pages Functions, root .mjs scripts, and build/config files
  {
    files: [
      'api/**/*.js',
      'functions/**/*.js',
      '**/*.mjs',
      'vite.config.js',
      'eslint.config.js',
      'scripts/**/*.js',
    ],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },
  // Web Worker context
  {
    files: ['**/*.worker.js'],
    languageOptions: { globals: { ...globals.worker } },
  },
  // MV3 entrypoints and wallet persistence modules run with the WebExtension API.
  {
    files: [
      'extension/**/*.{js,jsx}',
      'src/wallet/account.js',
      'src/wallet/session.js',
      'src/wallet/vault.js',
    ],
    languageOptions: { globals: { ...globals.webextensions } },
  },
  // The nested extension Vite config executes in Node, not in the browser bundle.
  {
    files: ['extension/vite.config.extension.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  // These browser modules consume globals installed by src/main.jsx or extension/shims.js.
  {
    files: [
      'src/agents/exitExecutor.js',
      'src/attestation.js',
      'src/base/withdrawBatch.js',
      'src/components/ExplorerPage.jsx',
      'src/stellar/agentDeposit.js',
      'src/stellar/cctpBurn.js',
      'src/stellar/client.js',
      'src/stellar/keeperEvents.js',
      'src/stellar/partialWithdraw.js',
      'src/stellar/scval.js',
      'src/stellar/vaultReads.js',
      'src/wallet/passkey.js',
    ],
    languageOptions: { globals: { Buffer: 'readonly' } },
  },
  {
    files: ['src/stellar/config.js', 'src/wallet/account.js'],
    languageOptions: { globals: { process: 'readonly' } },
  },
  // Playwright evaluate callbacks execute in the browser while the smoke driver runs in Node.
  {
    files: ['scripts/smoke-mandate.mjs'],
    languageOptions: { globals: { ...globals.browser } },
  },
  // Vitest test files import { describe, it, expect, vi } from 'vitest', but run
  // in a Node context — declare node globals for any process/global usage.
  {
    files: ['**/*.test.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  // Intentional empty catch blocks (error swallowing) are allowed project-wide;
  // genuinely empty if/for/while blocks are still flagged.
  {
    rules: { 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
]
