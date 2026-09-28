'use strict';

/**
 * ESLint flat configuration: correctness rules only, no stylistic rules.
 *
 * The rules catch defects (undefined or unused bindings, unreachable code,
 * unsafe comparisons, duplicate keys, accidental fallthrough) rather than
 * enforce formatting, so linting never causes churn in files owned by other
 * authors. The rule set and Node globals are listed explicitly because the
 * project adds no lint plugins or shared-config dependencies.
 *
 * @see https://eslint.org/docs/latest/use/configure/configuration-files
 * @see https://eslint.org/docs/latest/rules/
 */

/** Globals of the supported Node runtime (engines: node >= 22) used by this code. */
const NODE_GLOBALS = Object.fromEntries(
  [
    'require',
    'module',
    'exports',
    '__dirname',
    '__filename',
    'process',
    'Buffer',
    'console',
    'URL',
    'URLSearchParams',
    'TextEncoder',
    'TextDecoder',
    'AbortController',
    'fetch',
    'Headers',
    'Request',
    'Response',
    'structuredClone',
    'queueMicrotask',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'setImmediate',
    'clearImmediate',
    'SharedArrayBuffer',
    'Atomics',
    'globalThis',
  ].map((name) => [name, 'readonly']),
);

module.exports = [
  {
    ignores: ['node_modules/', 'logs/', 'docs/', 'vendor/', '.claude/', 'scratch/', 'scratch*', 'temp/'],
  },
  {
    files: ['**/*.cjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      'no-undef': 'error',
      // ignoreRestSiblings: `({ omitted, ...rest }) => rest` is the idiomatic way to
      // drop a field from a copy; the omitted binding is intentionally unused.
      'no-unused-vars': [
        'error',
        { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',
      'no-fallthrough': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-redeclare': 'error',
      'no-const-assign': 'error',
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-cond-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-sparse-arrays': 'error',
      'no-shadow-restricted-names': 'error',
      'no-loss-of-precision': 'error',
      'no-dupe-class-members': 'error',
      'no-this-before-super': 'error',
      'constructor-super': 'error',
      'getter-return': 'error',
      'no-setter-return': 'error',
      'no-async-promise-executor': 'error',
      'no-promise-executor-return': 'error',
      'no-unmodified-loop-condition': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'eqeqeq': ['error', 'always'],
      'no-var': 'error',
    },
  },
];
