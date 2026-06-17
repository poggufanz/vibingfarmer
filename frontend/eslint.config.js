import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  { ignores: ['dist/**', 'node_modules/**', '.vite/**'] },
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
