'use strict';

/**
 * ESLint flat configuration: correctness rules only, no stylistic rules.
 *
 * JavaScript (.cjs/.js): the rules catch defects (undefined or unused
 * bindings, unreachable code, unsafe comparisons, duplicate keys, accidental
 * fallthrough) rather than enforce formatting, so linting never causes churn
 * in files owned by other authors. The rule set and Node globals are listed
 * explicitly because JavaScript linting uses no plugin or shared config.
 *
 * TypeScript (.cts/.mts): typescript-eslint's strict, type-aware rule set
 * enforces the type-safety policy the compiler cannot: no `any`, no non-null
 * or type assertions (const assertions excepted), no unsafe use of untyped
 * values, and a written reason on every `@ts-expect-error`. Every
 * `eslint-disable` directive must also carry a `-- reason` (checked by
 * test/source-policy.test.mts) and must still be needed
 * (reportUnusedDisableDirectives).
 *
 * dist/ is build output and is not linted.
 *
 * @see https://eslint.org/docs/latest/use/configure/configuration-files
 * @see https://eslint.org/docs/latest/rules/
 * @see https://typescript-eslint.io/users/configs#strict-type-checked
 */

const { defineConfig } = require('eslint/config');
const tseslint = require('typescript-eslint');

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

module.exports = defineConfig([
  {
    ignores: ['node_modules/', 'logs/', 'docs/', 'vendor/', '.claude/', 'scratch/', 'scratch*', 'temp/', 'dist/'],
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
  {
    files: ['**/*.cts', '**/*.mts'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      // Type assertions are unchecked claims; narrow with a guard instead.
      // `as const` stays allowed: it only narrows literal types.
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
          minimumDescriptionLength: 10,
        },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // `import x = require()` is the CommonJS import form a .cts module needs
      // (an ES import would make tsc mark the module with __esModule, which
      // changes how consumers see the package entry). A bare require() stays
      // forbidden except the documented lazy loads of the ajv plugins, which
      // defer their cost until a SARIF document is first validated.
      '@typescript-eslint/no-require-imports': ['error', { allowAsImport: true, allow: ['^ajv-draft-04$', '^ajv-formats$'] }],
      // node:test's test()/describe()/it() return promises the runner tracks itself.
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] }] },
      ],
    },
  },
]);
