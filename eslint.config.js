// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    // The backend and the offline test suites are Node ESM, so they need Node
    // globals (Buffer, process, …) rather than the React Native set. Without
    // this they are not linted meaningfully at all.
    files: ['server/**/*.js', 'test/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
]);
