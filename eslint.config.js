import js from '@eslint/js';
import globals from 'globals';

const SHARED_CORE = ['src/core/constants.js', 'src/core/dates.js', 'src/core/markdown.js', 'src/core/domain.js', 'src/data/seed.js'];

export default [
  { ignores: ['dist/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    ignores: SHARED_CORE,
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    files: SHARED_CORE,
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals['shared-node-browser'] } },
  },
  {
    files: ['vite.config.js', 'eslint.config.js', 'server/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
];
