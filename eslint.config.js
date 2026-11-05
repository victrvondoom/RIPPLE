import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
}, {
  // Plain-JS e2e scripts run in Node and drive a real browser (page.evaluate callbacks reference DOM globals).
  files: ['scripts/**/*.mjs'],
  languageOptions: {
    globals: {
      console: 'readonly', process: 'readonly', fetch: 'readonly',
      document: 'readonly', window: 'readonly',
      setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
      URL: 'readonly', URLSearchParams: 'readonly', FormData: 'readonly',
    },
  },
});
