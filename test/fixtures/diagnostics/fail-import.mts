/**
 * Preload (`node --import`) that makes one package fail to load, as a broken
 * installation would: resolving the package named by FAIL_IMPORT_PACKAGE,
 * from `require()` or `import()`, throws. Everything else resolves normally.
 * Used to check how the CLI behaves when an optional runtime dependency
 * cannot be loaded.
 *
 * @see https://nodejs.org/api/module.html#moduleregisterhooksoptions
 */

import { registerHooks } from 'node:module';

const failing = process.env['FAIL_IMPORT_PACKAGE'];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (failing !== undefined && (specifier === failing || specifier.startsWith(`${failing}/`))) {
      throw new Error(`Cannot load ${specifier}: simulated broken installation`);
    }
    return nextResolve(specifier, context);
  },
});
