/**
 * Public library entry point.
 *
 * Six operations, each on ordinary in-memory SARIF 2.1.0 values (no files,
 * builders, sessions or private formats); the CLI (src/cli.cts) is a file
 * transport over exactly these functions:
 *
 *   createSarifDocument(options?)          optional authoring: a new document
 *   addSarifComment(sarif, comment)        optional authoring: one finding
 *   removeSarifComment(sarif, selector)    optional authoring: remove one finding
 *   inspectSarif(sarif, options?)          read-only view of any SARIF
 *   addStagedChangesToSarif(input)         staged Git changes as SARIF fixes
 *   publishSarifReview(input, internals?)  one GitHub draft review
 *
 * Authoring is optional and freestanding: SARIF from any producer can be
 * inspected, extended and published without it, and nothing downstream
 * depends on how a document was made. Each operation is implemented in its
 * own module (src/sarif-authoring.cts, src/sarif-inspection.cts,
 * src/staged-changes.cts, src/publish-sarif-review.cts) and re-exported here
 * unchanged; their contracts are in those modules, and the public API as a
 * whole is declared by src/public-api.cts.
 *
 * This module is the runtime shape of the package: `export =` of an object
 * of local bindings compiles to `module.exports = { ... }` with no
 * `__esModule` marker, exactly the CommonJS entry 0.2.0 shipped (so ES module
 * namespace keys and bundler default-import interop are unchanged). The
 * modules are loaded with `import x = require()` for the same reason: an ES
 * import would make the compiler add the marker.
 */

import authoring = require('./sarif-authoring.cjs');
import inspection = require('./sarif-inspection.cjs');
import staged = require('./staged-changes.cjs');
import publication = require('./publish-sarif-review.cjs');
import type * as PublicApi from './public-api.cjs';

const createSarifDocument = authoring.createSarifDocument;
const addSarifComment = authoring.addSarifComment;
const removeSarifComment = authoring.removeSarifComment;
const inspectSarif = inspection.inspectSarif;
const addStagedChangesToSarif = staged.addStagedChangesToSarif;
const publishSarifReview = publication.publishSarifReview;

/** True exactly when X and Y are the same type (the standard exact-equality idiom). */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the exact-type-equality idiom needs each T once per side; that is what makes the comparison exact
type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/** `Declared` when `Runtime` is identical to it, otherwise `never` (so `satisfies` fails). */
type Identical<Runtime, Declared> = Equals<Runtime, Declared> extends true ? Declared : never;

// Compile-time proof that the runtime object has exactly the value exports of
// the declaration entry (no extras, none missing), each with the identical
// type. The key order is the one 0.2.0 shipped, which Object.keys reports,
// with later additions appended so that order is kept.
export = { createSarifDocument, addSarifComment, inspectSarif, addStagedChangesToSarif, publishSarifReview, removeSarifComment } satisfies Identical<
  {
    createSarifDocument: typeof createSarifDocument;
    addSarifComment: typeof addSarifComment;
    inspectSarif: typeof inspectSarif;
    addStagedChangesToSarif: typeof addStagedChangesToSarif;
    publishSarifReview: typeof publishSarifReview;
    removeSarifComment: typeof removeSarifComment;
  },
  typeof PublicApi
>;
