import js from '@eslint/js';

export default [
  { ignores: ['node_modules/', 'runs/', 'worktrees/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', AbortSignal: 'readonly', URL: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', AbortController: 'readonly', structuredClone: 'readonly' },
    },
  },
];
