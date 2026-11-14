import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    files: ['src/core/constants.js', 'src/core/dates.js', 'src/core/markdown.js', 'src/core/domain.js', 'src/data/seed.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: {} },
  },
  {
    files: ['vite.config.js', 'eslint.config.js', 'server/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
];
