// ESLint flat config for UI Auditor.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'web/dist/**',
      'reports/**',
      'test-results/**',
      'playwright-report/**',
      'tests/generated/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Browser code: the React frontend, fixture site scripts, and functions evaluated in the page by Playwright.
    files: ['web/**/*.{ts,tsx,js,jsx}', 'fixtures/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // Crawler code passes functions to page.evaluate(), which run in the browser.
    files: ['src/crawler/**/*.ts', 'src/design/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
);
