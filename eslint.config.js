import js from '@eslint/js';

export default [
  { ignores: ['node_modules/', 'runs/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', AbortSignal: 'readonly', URL: 'readonly' },
    },
  },
];
