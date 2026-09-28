# sarif-to-comment → strict TypeScript: migration plan

Status: **approved by Astra with corrections (§0); execution in progress.** Baseline `2829530` (npm 0.2.0 = `da3c138`, 1,806 tests / 138 suites, Node 22+24 CI green).

## 0. Approved corrections (binding for execution; they override conflicting text below)

1. **Private injection seams are preserved** as runtime behavior (publishSarifReview's 2nd argument, prepareReview/publication internals, CLI `main(io, internals)` through the shipped executable) and kept out of generated public declarations by a sound overload/entry-boundary design. If that proves impossible without unsound typing or public API divergence, stop and return alternatives to Astra. The seam does not become a supported contract.
2. **No deduplication/refactor cleanup** (draft D7 deferred). Shared *types* and narrowly necessary boundary helpers are allowed; duplicated algorithms (`isPlainObject` variants, `captureJson`, `canonicalJson`, `sarifValidator`) stay separate and behaviorally identical.
3. **Validation is scaled to change**: targeted module tests during conversion; the assembled suite at integration waves and on final source. The frozen baseline oracle, test-conversion parity, negative controls and independent review remain. Declaration layout/formatting differences are not defects per se; every semantic/API difference needs evidence; target zero API drift.
4. **Honest Node contract**: consumer `engines` stays `>=22`; the development-only native-stripping floor is documented and enforced for development tooling only. The stale-output guard compares a content manifest of the full input set (added/removed/changed files), not newest-mtime.
5. **Worktrees** live under the ignored `logs/opus/typescript/wt/`: integration checkout `logs/opus/typescript/wt/integration` on branch `typescript-migration` (from `2829530`); worker worktrees `logs/opus/typescript/wt/<phase>` on `typescript-migration-<phase>` branches, merged only by the lead. `.claude/` and the parent-owned `docs/typescript-migration-work-record.md` in the main checkout are untouched. Evidence: `logs/opus/typescript/evidence/` (main checkout).

6. **Spike-derived engineering decisions** (evidence: `evidence/p0-spike/`), superseding conflicting text below:
   - *Seam typing*: the public `publishSarifReview` has one public overload `(input: IPublishSarifReviewInput)` and an implementation signature `(input: unknown, internals?: …)` that delegates to an internal, fully typed `publishSarifReviewWithInternals(input, internals)`. The runtime still honors a second argument passed to the public function (installed-package test). In-repo TS callers that inject use the internal function. `cli.main(io, internals)` is not public and is typed plainly.
   - *Declaration graph*: modules reachable from `public-api.cts` reference each other with `import type` (API Extractor copies `import x = require('./local.cjs')` into the rollup). The "Node-type-free" check compiles an isolated copy of the rollup with `types: []` (API Extractor never emits `/// <reference types>`, so a grep proves nothing).
   - *Build*: remove `dist/` → `tsc -b src` → API Extractor → write the input manifest last. Neither `tsc -b` nor `--clean` removes output of deleted sources. `check:types` runs no-emit type checks per project (src, test, scripts) because solution-wide `tsc -b` writes build info into test/ and scripts/.
   - *Development Node floor*: `devEngines` requires Node ≥22.18.0 for development (22.18.0 is the first release that runs `.mts` without flags or warnings; 22.17.1 cannot load `.mts`, so a `.mts` guard cannot enforce it). npm 11/pnpm 11 enforce it for developers; installing the packed package on Node 22.17.1 is unaffected. Consumer `engines` stays `>=22`.
   - *Packing*: `files` excludes `dist/.build-inputs.json`, `dist/*.d.cts`, `dist/*.tsbuildinfo` and runtime-empty declaration-only outputs (`dist/public-api.cjs`, type-only modules); the release-guard allowlist names shipped files so an unexpected file fails `verify-pack`.
   - *Interop by Node version*: the ESM namespace key `module.exports` exists on Node 24 but not 22 in 0.2.0 too; compatibility compares against 0.2.0 per Node version (P1a test already written this way).
   - *Lint*: root ESLint config ignores `dist/`; the strict type-aware configuration needs three documented rule settings (recorded in `evidence/p0-spike/files/eslint.config.cjs`). Dev deps: `typescript-eslint@8.70.1`, `@types/node@22.20.4`.
   - *ajv*: ajv, ajv-draft-04, ajv-formats and `@types/node@22` type-check with zero diagnostics under all strict flags without `skipLibCheck`.

7. **Accepted conversion divergences (unreachable or internal only)**: internal (non-entry) module `Object.keys` order and the non-enumerable `__esModule` marker on internal modules (not reachable through `exports`); caught-error message extraction on non-Error thrown values; `packageVersion()` throws rather than returning `undefined` for a package.json without a string version; hostile-Proxy handling in `captureJson`; "Internal error" instead of a TypeError on unreachable index reads. Existing validation looseness (one-element SHA arrays, array-valued state `phase`, unknown tree modes) is preserved deliberately, not tightened.

## Checkpoints

| Checkpoint | State | Evidence |
|---|---|---|
| Integration worktree created from `2829530`; lockfile install | done | this file |
| Baseline `pnpm run check` in integration worktree (Node 24.14.0): 1806 tests / 138 suites pass | done | `logs/opus/typescript/evidence/baseline-check.txt` |
| P0 toolchain spike: commit `63ec325` on `typescript-migration-spike` (`wt/spike`); Node 24.14.0, 22.23.3, 22.18.0 | accepted with caveats (§0.6) | `evidence/p0-spike/worker-handback.md`, `evidence/p0-spike/files/` |
| P1a characterization tests: commit `5086ab2`; 1830 tests / 144 suites pass on unchanged JS; 25 mutation red proofs; runtime identical to `2829530` | accepted | `evidence/p1a/NOTES.md`, `evidence/p1a/red/` |
| P1b red layout tests `8b6a724`; P2 infrastructure `aa605b9`, re-path `83296a1` (specifier-only, script-verified), fixes `db3efe1`, `2af2c03`; lead re-ran gate: 1873/148 pass | accepted | `evidence/p2/INDEX.txt`, `evidence/p2/lead-gate.txt` |
| Wave 1 converted: sarif-common, artifact-files, github, placement, replacements, staged-git, publication (merges `29ba530`..`b761357`); explicit `esModuleInterop:false` + duplicate-module test decoupled `73a314d`; full check 1873 pass, api-report/docs unchanged | accepted | `evidence/p3/w1-*.txt`, `evidence/p3/w1-merge-gate.txt` |
| Wave 2 converted: sarif-authoring, sarif-inspection, staged-changes, prepare-review (merges `91d6ad2`..`daf74cb`); full check 1873 pass; per-module differentials vs original: 0 differences | accepted | `evidence/p3/w2-*.txt`, `evidence/p3/w2-merge-gate.txt` |
| Wave 3: public-types, public-api (declaration entry), publish-sarif-review (overload-hidden seam), index (`export =`, no marker), cli, executable; declarations generated by API Extractor; `types/` deleted (merge `803d880`); full check 1873 pass; all 48 exports mutually assignable and exactly equal to 0.2.0, TSDoc blocks identical (226/226); api-report/docs drift = layout only (tsc prints four inline object literal types multi-line); interop + 15 CLI invocations byte-identical vs 0.2.0 on Node 22.22.1/24.14.0 | accepted | `evidence/p3/w3.txt`, `evidence/p3/w3-declaration-equivalence.txt`, `evidence/p3/w3-merge-gate.txt` |
| **Frozen JavaScript oracle**: test tree at `803d880` (all tests `.cjs`, unchanged in meaning since `2af2c03`; re-path specifier-only) | fixed | used for parity and mutation controls |
| Validation at `f2aa51b`: frozen oracle (803d880 tests) vs final dist — 0 behavioral failures (only pins of deliberately renamed tools/scripts); 7 seeded dist mutants killed by both suites; 1879/149 on Node 24.14.0, 22.18.0, 22.23.3; installed differential vs registry 0.2.0 (hash-verified 246 files) byte-identical over interop, 13 help runs, 76 CLI runs, 60 library calls, 9 seam calls; parent runners `installed-typescript-acceptance` and `installed-insertion-acceptance` pass unmodified (`installed-local-acceptance` hard-codes `bin/` and cannot target the new layout unmodified); 0 `as`/`!`/`any` in owned TS | accepted | `evidence/final/VALIDATION.txt` |
| Durable docs (README, D33), patch Changeset (`7c9c8af`, `6d868ab`, `02df2c8`) | accepted | `evidence/final/docs.txt` |
| Independent review (Fable 5.1): no consumer-observable drift; CONFIRMED risk — build before check made the API report/docs freshness gate vacuous → fixed `a94887e` (red→green), nit comment `845b9df`; re-review CLOSED both and found untracked-page gap → fixed `44af8c5` (red→green, probe) | closed | `evidence/final/fix-api-freshness.txt`, `evidence/final/fix-untracked-*.txt` |
| Clean-state gate at `44af8c5` (fresh checkout, frozen install, build, freshness step, full check, verify-pack): 1881/149 pass on Node 24.14.0 and 22.18.0 | done | `evidence/final/clean-state/` |
| Test/fixture/script conversion to `.mts`: fixture helpers (merge `6329a5c`), test groups (merges `625aea6`..`d45070e`), source comments and test-runner glob (`d6c4a91`, `f2aa51b`); full check 1879 tests / 149 suites pass on Node 24.14.0; test-conversion parity 24/24 identical to the frozen oracle | done | `evidence/p4/`, `evidence/p4/parity/`, `evidence/p4/final-merge-gate.txt` |
| Parsed state-record typing repair: 0.2.0 handling of state files with a non-string phase pinned (`eddeac6`), parsed record typed as validation admits it (`ed34343`), coerced-phase receipt/refusal pinned to exactly `unknown` (`a058c24`, red with those fields typed as the validated shapes, green restored); independent review CLOSED with a 528-case equivalence probe vs 0.2.0; final-bound gate at `a058c24` (fresh checkout, frozen install, build, freshness step, full check): 1917 tests / 150 suites pass, 0 fail/skip on Node 24.14.0 and 22.18.0; rolled-up declaration and every `dist/*.cjs` except `publication.cjs` byte-identical to `44af8c5`; api-report/docs unchanged; verify-pack 247 files | accepted | `evidence/state-type-repair/`, `evidence/final-bound/` |

## 1. Context and outcome

The maintained implementation is ~9.3k lines of CommonJS JavaScript (`src/*.cjs`, `bin/sarif-to-comment.cjs`), ~15k lines of `node:test` tests plus 11 JS fixture helpers, two JS release/docs scripts, and a **hand-written** `types/index.d.ts` (1,023 lines, 5 functions + 43 types, 48 `@public` tags) that nothing ties to the runtime except installed-package drift tests. The user wants the maintained code to be genuinely strict TypeScript, with **declarations generated from the implementation**, while npm consumers of 0.2.0 see no difference.

Success = strict TS source for runtime, CLI, tests/helpers and build/release scripts; generated JS + a generated, API-Extractor-rolled-up public declaration; consumer-observable behavior of 0.2.0 unchanged and proven by oracles that do not depend on the new code; a patch release prepared (Astra executes).

### Facts established by discovery (inspectable)
- **F1 Public runtime surface** is exactly 5 functions on `module.exports = { … }` (`src/index.cjs:532`); `exports` map exposes only `.` and `./package.json`, so internal file paths (`main`, `src/*`, `bin/*`) are not importable through Node/bundler `exports` resolution.
- **F2 ESM interop today**: `import * as ns from` the entry yields keys `[5 names, 'default', 'module.exports']` and **no `__esModule`** (probed on Node 24.14). Standard `tsc` CJS emit adds `Object.defineProperty(exports,"__esModule",…)` to every ES-syntax module, even import-only ones; on Node 24 that surfaces as an `__esModule` namespace key (probed with ajv-formats), and bundler/`esModuleInterop` default-import interop changes when the marker is present. `export =` emits **no** marker (in-memory `ts.transpileModule` probe).
- **F3 Path depth**: `../vendor/sarif-schema-2.1.0.json` (`sarif-common.cjs:26`, `prepare-review.cjs:156`) and `../package.json` (`sarif-common.cjs:230`) require the runtime to sit exactly one directory below the package root.
- **F4 Layout is pinned** (deliberately) in `package.json`, `scripts/release-guard.cjs` (`isDistributable`, `REQUIRED_FILES`), `scripts/api-docs.cjs` (`INPUTS`), `api-extractor.json`, `test/package.test.cjs`, `test/release.test.cjs` (including the `publish.yml` step-order regex), `test/docs.test.cjs`, both workflows, and `README.md:233-237`.
- **F5 Silent-weakening hazards**: three repository checks filter by extension/syntax and would pass vacuously after conversion — `package.test.cjs:71-83` (`require()` regex over `src/*.cjs` to derive runtime deps), `package.test.cjs:172-193` (tarball must contain every `src/*.cjs`), `docs.test.cjs:485-488` (`/\.(c?js|d\.ts)$/` scan).
- **F6 Test harness packs with `ignore_scripts=true`** (`test/fixtures/package/installed-package.cjs:57`); compiled output must exist before `pnpm run check`.
- **F7 Private seams**: `publishSarifReview(input, internals)` (`index.cjs:517`), `prepareReview(…, internals)`, `publication` `internals.fs`, `cli main(io, internals)` via `bin`. Tests import 13 internal modules directly and use these seams; nothing reaches non-exported functions. The seam is exercised **on the installed tarball** (`test/package.test.cjs:241,244`) and through the shipped bin (`test/fixtures/public-api/cli-with-fake-github.cjs:22-25`), so it is observable runtime behavior of 0.2.0 even though undeclared.
- **F12 `tsc` reprints JS**: `allowJs` output of `src/index.cjs` is not byte-identical (533 → 507 lines); JS inputs with `declaration` also emit JSDoc-derived `.d.cts`. It cannot serve as a transitional copier.
- **F13 `tsc` emits double-quoted `require("…")`**; the dependency scan at `package.test.cjs:71-83` matches only single quotes and its assertion (`:150`) is one-directional, so it would pass on zero matches.
- **F8 Behavior a naive conversion changes silently**: ES2022 class fields (`useDefineForClassFields`) create own `undefined` keys on `GitHubError.status` etc. (`github.cjs:270-278`) that the credential-redaction pass enumerates (`index.cjs:58-60,334-349`); `{ k: undefined }` vs omitted keys in JSON output; object-literal key order in CLI JSON/markdown; `Object.freeze` → `as const` loses runtime immutability; ajv `.default || x` interop; lazy `require` of ajv.
- **F9 Duplicates with different meanings**: `isPlainObject` ×6 (two semantics: prototype-checked vs non-null-non-array), `captureJson` ×2, `canonicalJson` ×2 (feeds sha256 fingerprints), `sarifValidator` ×2.
- **F10 No doc/decision constrains language or build** (D1–D32 are product behavior). `second-milestone-goal.md:17,53` makes README, the declarations and getting-started the compatibility boundary.
- **F11 Local toolchain**: Node 24.14.0; CI pins pnpm 11.27.1, Node 22/24 matrix; TypeScript ~5.9.3; ESLint 10 (JS-only config today).

### Assumptions (status after independent review probes; remainder proven in Phase 0)
- **A1** Node native type stripping runs `.mts` tests/scripts on Node 22 (≥22.18) and 24 without stderr warnings. *Partially established*: `--input-type=module-typescript` is warning-free on 22.22.1 and 24.14.0. P0 still runs real `.mts` files under `node --test`, including spawned child wrappers.
- **A2** API Extractor accepts a `.d.cts` entry. *Established*: API Extractor 7.36.2 changelog adds `.d.mts`/`.d.cts` support (7.59.2 installed). P0 verifies only the rollup filename and `import x = require()` handling.
- **A3** Dependencies type-check under our strict flags **without** `skipLibCheck`. *Established for ajv, ajv-draft-04, ajv-formats (0 diagnostics)*; `@types/node@22` remains to be verified in P0. If it fails, stop and ask; never enable `skipLibCheck` silently.
- **A4** cjs-module-lexer detects the entry's exports. *Established*: 0.2.0 already ships `module.exports = { a, b, … }`, and `export = { a, b }` of local bindings emits exactly that. Constraint recorded: shorthand local bindings only (no spread), and `index.cts` uses `import x = require()` so no `__esModule` marker can be emitted.

## 2. Architecture (recommended)

### Source / output
| | Source (TS) | Output (generated, git-ignored) | Shipped |
|---|---|---|---|
| Runtime modules | `src/*.cts` (flat) | `dist/*.cjs` + `dist/*.d.cts` | `dist/*.cjs` only |
| Executable | `src/sarif-to-comment.cts` (shebang) | `dist/sarif-to-comment.cjs` | yes; `bin` → `dist/sarif-to-comment.cjs` |
| Runtime entry | `src/index.cts` (`export =` object of local bindings) | `dist/index.cjs` | yes; `main`/`exports.default` |
| Declaration entry | `src/public-api.cts` (ES named exports: 5 functions + 43 types, TSDoc ported **verbatim** from `types/index.d.ts`) | API Extractor `dtsRollup` → `dist/sarif-to-comment.d.ts` | yes; `types`/`exports.types` |
| Tests, fixture helpers | `test/**/*.mts` | none (run by Node type stripping) | no |
| Release/docs scripts | `scripts/*.mts` | none (type stripping) | no |

Why:
- **`.cts` → `.cjs`, flat `dist/`** keeps module format explicit, keeps every current file name (`x.cjs`), and keeps F3 path depth. During the transition, `build:js` runs `tsc -b` and then byte-copies any not-yet-converted `src/*.cjs` into `dist/`. Because of F12 this is a copy step, not `allowJs`. Converted and unconverted modules therefore coexist under identical names. Conversion is leaf-first, so a `.cts` never imports an unconverted `.cjs`, and unconverted `.cjs` files keep `require('./x.cjs')` working. Every intermediate state runs against the full existing suite, so each module's conversion is validated on its own. The copy step is deleted when `src/` has no `.cjs` left. *(Done in Wave 3; `scripts/build.mts` now refuses any `.cjs` in `src/`.)*
- **Split runtime entry vs declaration entry** (D2) keeps the 0.2.0 interop shape (F2: no `__esModule`, same ESM namespace, same bundler default-import behavior) while declarations are still generated from implementation. A compile-time `satisfies` check in `index.cts` proves the runtime object has exactly the keys and types of `public-api.cts`; existing tests prove it at runtime from the installed tarball.
- **The private seams stay as runtime behavior but are hidden by overloads** (D3). The declaration entry exports `publishSarifReview(input: IPublishSarifReviewInput): Promise<PublishSarifReviewOutcome>` as the public overload. The implementation signature is `(input: unknown, internals: IPublishInternals = {})`. `tsc` emits only the overload, so the declaration is still generated from the implementation and the api-report does not change. The shipped behavior stays identical to 0.2.0. `cli.main(io, internals)` gets the same treatment. *(Superseded in detail by §0.6 seam typing: the public implementation delegates to an internal `publishSarifReviewWithInternals`, and `cli.main` is not public and is typed plainly.)* Each seam carries a durable comment explaining that it is a private test seam.
- **Public declarations are Node-type-free.** The rollup must not gain `/// <reference types="node" />`, because consumer type tests compile with `types: []`. Node types (for example `internals.fs`) stay out of `public-api.cts`. A check greps the rollup and api-report for `reference types`. *(Superseded by §0.6 declaration graph: the check compiles an isolated copy of the rollup with `types: []`.)*
- **Public signatures are explicitly annotated.** The 5 functions have explicit return types. The 43 types keep their interface/alias kinds exactly as in 0.2.0. Inferred types would change the api-report text.
- **Rollup** ships one public declaration file (as today), hides internal types and seams, and is exactly what API Extractor already reports on. `api-report/sarif-to-comment.api.md` and `docs/api/*.md` become the primary declaration-equivalence oracle: they must be byte-unchanged (TSDoc ported verbatim), or any diff is reviewed as intentional. *(Per §0.3, layout-only differences are accepted; the Wave 3 checkpoint records the four multi-line object literal types.)*
- **Tests import `../dist/*.cjs`** (the artifact that ships), not source; Node cannot strip `.cts` files that use `import` syntax, and testing emitted JS is the stronger claim. Test type-checking resolves `dist/*.d.cts` via a project reference.

### Compiler configuration
- `tsconfig.base.json`: `strict` + all flags from the compiler skill (incl. `exactOptionalPropertyTypes`, `noImplicitOverride`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `noUnused*`, `noFallthroughCasesInSwitch`), `module`/`moduleResolution: nodenext`, `target: es2022`, `noEmitOnError`, **no** `esModuleInterop`/`allowSyntheticDefaultImports`/`skipLibCheck`, `types: ["node"]`.
- `src/tsconfig.json`: composite, with `rootDir: src`, `outDir: dist` and `declaration`. It has no `allowJs`, per F12.
- `test/tsconfig.json`, `scripts/tsconfig.json`: `noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly` (guarantees strip-compatibility), reference `src`.
- Root `tsconfig.json` = solution file (references only).

### Type-safety policy (enforced, not aspirational)
- typescript-eslint `strict-type-checked` for `.cts`/`.mts`: `no-explicit-any`, `no-unsafe-*`, `no-non-null-assertion`, `consistent-type-assertions: never` (const assertions allowed), `ban-ts-comment` (description required), `switch-exhaustiveness-check`, `consistent-type-imports`; `linterOptions.reportUnusedDisableDirectives: error`; a repository test fails on any `eslint-disable` lacking a `-- reason`.
- **Every unchecked boundary is named and singular**: e.g. `require()` of the vendored schema assigned to `unknown`; the ajv-schema-to-`ISarifLog` narrowing wrapper; `JSON.parse` results are `unknown` until guarded. An inventory of all remaining assertions/suppressions (with reasons) is a completion artifact.
- **Runtime validation is never removed because the type system "proves" it impossible.** Public implementation signatures take `unknown`, and capture/validation proceeds from there, because JS callers are unconstrained. If `no-unnecessary-condition` flags a boundary guard, the parameter type is wrong, not the guard. Durable defensive guards on already-typed internal values may use a documented, rule-scoped exception instead of being deleted.
- Behavior-preserving idioms (from F8): `declare` or constructor-assigned optional fields on Error subclasses; conditional spreads for omitted keys; keep `Object.freeze` (typed `Readonly`) wherever it exists; preserve object-literal key order; preserve ajv interop semantics and lazy loading where its intent is documented.
- Duplicates (F9) are converted in place, each keeping its own behavior (§0.2).
- Naming follows the established public convention (`I`-prefixed interfaces, PascalCase unions, no `enum`); TSDoc with API-Extractor tags; existing module header blocks become TSDoc `@packageDocumentation`/module comments, keeping decision IDs.

### Build, scripts, CI (names per npm-script skill; release safeguards unchanged in strength)
- `build` = compile (`build:js`, `tsc -b`) then API docs (`build:api-docs`, existing generator retargeted at the emitted `.d.cts`, producing the rollup, report and docs). *(As implemented per §0.6: one `build` script, `scripts/build.mts`, removes `dist/`, runs `tsc -b src`, then `scripts/api-docs.mts build`, and writes the manifest last; there are no `build:*` sub-scripts.)*
- `check` keeps its composition and read-only rule; `check:types` type-checks src/tests/scripts without emitting; `check:api` unchanged in meaning.
- `test` = `node --test "test/**/*.test.mts"` against `dist/`; a harness guard fails fast with "run pnpm run build" if `dist/` is missing or its build manifest (sha256 of every build input: `src/**`, tsconfigs, `package.json`) differs from the current input set, including added or removed files (§0.4). *(As implemented, `scripts/build-manifest.mts` also covers the lockfile, `api-extractor.json` and the build scripts, and records every output file, so orphaned or altered output is refused too; the guard runs as `check:build` before the tests.)*
- Both workflows gain one `pnpm run build` step before `pnpm run check`. The publish order becomes preflight → build → check → pack → verify-pack → publish. The pinned step-order test is updated first. There is no `prepack`, so the tarball is exactly what was checked.
- The manual-publish backstop is kept. `prepublishOnly` (`release-guard check-version`) also refuses a missing or stale `dist/`, using the same freshness rule as the test guard.
- `files`: `["dist/", "!dist/*.d.cts", "!dist/*.tsbuildinfo", "vendor/", …docs as today]`. *(Extended per §0.6 packing: also excludes `dist/.build-inputs.json`, `dist/public-api.cjs` and `dist/public-types.cjs`.)*
- `release-guard`:
  - `isDistributable` → `dist/[^/]+\.cjs` plus `dist/sarif-to-comment.d.ts`. It rejects `*.d.cts`, `*.map`, `*.tsbuildinfo`, nested directories and any `src/`, as the backstop.
  - `REQUIRED_FILES` is updated.
  - Existing negative cases are retained and extended.
  - `MIN_NODE` is raised from 22.14.0 to 22.18.0, because the `.mts` guard needs type stripping to even parse. This is a strengthening, and the reason is documented. A too-old runner then gets the guard's explanation rather than a syntax error. The minimum is still ≥22.14 for trusted publishing.
- New dev deps (only): `typescript-eslint`, `@types/node@^22` (matches consumer `engines`, so no Node-23+ API sneaks in). *(Pinned exactly per §0.6: `typescript-eslint@8.70.1`, `@types/node@22.20.4`.)*

### Deliberately remaining JavaScript
- Generated `dist/*.cjs` is output.
- `eslint.config.cjs` stays JS. It is config glue, and ESLint 10 loads TS config only behind `unstable_native_nodejs_ts_config` or through a `jiti` dependency.
- The vendored schema and the JSON/SARIF fixtures are data.
- Nothing else remains in JavaScript.

## 3. Test-first compatibility strategy

Principle: **never change tests and implementation in the same step.** Oracles must be independent of the new code.

1. **Characterization first (Phase 1, JS, against current `src`, all green on baseline):** audit existing coverage, then add only gaps for F8/F2 risks — own-enumerable key sets and `instanceof`/`name` of each Error class (absent `status` stays absent); exact `Object.keys` order for representative library outcomes and CLI JSON receipts with omitted optional fields; frozen constants/client; installed-tarball interop (`Object.keys(require())`, ESM namespace keys exactly `[5, 'default', 'module.exports']`, `require(pkg).__esModule === undefined`, default import identical to `require` result).
2. **New-layout expectations written red** (Phase 1). These cover:
   - package fields, including `files` negations;
   - `npm pack` of the checkout omitting `*.d.cts` and `*.tsbuildinfo`;
   - tarball allowlist and release-guard positive/negative cases;
   - workflow step order and the stale-`dist` refusal;
   - non-vacuity for every F5 filter (it must find ≥1 file of the new kind);
   - a **bidirectional, quote-agnostic** runtime-dependency scan over `dist/*.cjs` (`deepEqual(found, declared)`), per F13;
   - no `reference types` in the rollup.
3. **Phase 3 runs the existing JS suite with a path-only diff** (`src/` → `dist/`). A script verifies the test diff since Phase 2 contains only require-specifier changes. This suite becomes the **frozen JS oracle**.
4. **Phase 4 converts tests with parity proof**: per-file counts of `test()`/`describe()`/`assert.*` before/after; same pass count; 3–5 seeded mutants in `dist/` (e.g. drop an omitted-key guard, reorder a JSON key, add an own `undefined` error field, flip a rendered byte, mis-order a placement case) must be killed by both the frozen JS suite and the converted TS suite.
5. **Declaration oracle**: `api-report` + `docs/api` byte-unchanged; one-off mutual-assignability check of all 48 exports, 0.2.0 `types/index.d.ts` ⇄ generated rollup; the existing installed consumer type tests (CJS `.cts`, ESM `.mts`, drift, misuse control) continue unchanged in meaning.
6. **Registry differential (one-off evidence, not a permanent test; kept short because the mutants and frozen suite carry most weight).** Install the retained registry 0.2.0 consumer (`logs/opus/typescript/baseline-package.json`) and the new tarball side by side, then compare:
   - interop probes (CJS keys, ESM namespace keys, `__esModule`, default-import identity);
   - `--help` bytes;
   - one run of each CLI command over existing fixtures, comparing stdout/stderr/exit;
   - one fake-HTTP publish flow's library outcome (JSON with key order).

   No live GitHub content is needed. The algorithms are unchanged, and identical outputs keep the 0.2.0 live fidelity evidence valid.

Test framework: keep `node:test` (no Jest/tsd migration). Type-level tests continue as `tsc` compilations of consumer `.cts`/`.mts` files from the installed tarball, which already provide positive, negative (`@ts-expect-error`) and drift coverage; tsd would duplicate them.

## 4. Phases, ownership and dependencies

Work happens in the worktrees named in §0.5. Local commits only (author `Mike North <michael.l.north@gmail.com>`), one or more per phase; Astra owns push/PR/release. Implementation is by Opus 5.5 subagents; the lead assesses each phase against its exit gate and records decisions/evidence in `docs/typescript-migration-plan.md` (checkpoints) and `logs/opus/typescript/` (raw evidence).

| Phase | Owner | Depends on | Exit gate |
|---|---|---|---|
| **P0 Spikes** (throwaway worktree): real `.mts` under `node --test` + child wrappers on Node 22 latest and 24 (A1); rollup filename / `import = require` through API Extractor (A2); `@types/node@22` lib check (A3); `tsc` preserves shebang; overload-hidden seam emits only the public overload | 1 Opus agent | — | Spike report; any failure → fallback (§6) decided by lead, escalated only if it touches D-level choices |
| **P1 Characterization + red layout tests** | 1 Opus agent | P0 | New characterization tests green on baseline; layout tests red for the right reason |
| **P2 Infrastructure**: tsconfigs, typescript-eslint, `@types/node`, scripts, workflows, release-guard, api-docs retarget, transitional byte-copy of `src/*.cjs` → `dist/`, tests re-pathed to `dist/` | 1 Opus agent | P1 | Full suite green with zero TS source; path-only test diff verified; P1 layout tests green except declaration-entry ones |
| **P3 Source conversion** waves, each module converted with **no test edits**, full suite + lint green after each: W1 `sarif-common` (shared SARIF/JSON types, validator boundary) ∥ leaves `staged-git`, `replacements`, `placement`, `artifact-files`, `github`; W2 `sarif-authoring`, `sarif-inspection`, `publication`, `staged-changes`, `prepare-review` *(as executed, `publication` moved into W1; see Checkpoints)*; W3 `publish-sarif-review` (moved from `index`), `public-api`, `index` (`export =`), `cli`, `sarif-to-comment`; delete `types/index.d.ts`; delete the transitional copy step | Opus agents, parallel within a wave in separate worktrees with disjoint file ownership; lead merges and runs the gate | P2 | api-report/docs byte-unchanged (layout-only drift accepted per §0.3); suite green; no `.cjs` in `src/` |
| **P4 Tests, fixtures, scripts → `.mts`** | 2–3 Opus agents by file group | P3 | Parity report + mutants killed by both suites; JS tests deleted only after parity |
| **P5 Durable docs + release prep**: README (declarations now generated; contributor build), `design-decisions.md` D33 (implementation language/distribution rationale), header comments, Changeset (patch) | 1 Opus agent | P4 | `docs.test` green; release plan check green (<1.0) |
| **P6 Independent review**: Fable 5.1 defect review of the full diff (types weakening, behavior drift, validation loss, safeguard weakening); findings fixed by Opus agents | Fable 5.1 reviewer, Opus fixers | P5 | No open confirmed findings |
| **P7 Completion proof** (§7) and handoff to Astra | lead | P6 | Evidence bundle complete |

Parallelism is bounded by shared `dist/` and the type dependency on `sarif-common`; the lead serializes merges and gates.

## 5. Decisions for Astra review (recommendation first)

- **D1 Layout.** `src/*.cts` → flat `dist/*.cjs`; bin file becomes `dist/sarif-to-comment.cjs`; `main`/`types` paths change. Not consumer-visible under `exports` (F1); bin *name* and behavior unchanged. Alternative (keep `src/*.cjs` generated in place beside `.cts`) mixes source and output; rejected.
- **D2 No `__esModule` at the entry** via `export =` runtime entry + separate declaration entry (§2). Cost: ~20 lines of typed glue with a compile-time equivalence check. Alternative: accept tsc's marker — changes ESM namespace keys and bundler/`esModuleInterop` default-import behavior relative to 0.2.0 (F2). Recommend avoiding the change.
- **D3 Keep the private `internals` seams exactly as runtime behavior and hide them with TypeScript overloads.** Only the public overload is emitted, so declarations are still generated from the implementation (§2).
  - This supersedes my first-draft recommendation to remove the seam. The review showed the seam is exercised on the installed tarball and through the shipped bin (F7). Removing it would edit the frozen oracle and make 0.2.1 behave observably differently.
  - Removing or narrowing the seam is a separate, deliberate future decision, not part of a language migration.
- **D4 Tests and scripts are `.mts`, run by Node native type stripping against the built `dist/`.**
  - The development Node floor becomes ≥22.18. CI's `22` resolves to the latest 22.x, and consumer `engines` stays `>=22`.
  - The release guard's `MIN_NODE` rises to 22.18.0 to match.
  - Fallback if A1 fails in P0: compile tests and scripts with `tsc` into a mirror directory, and resolve fixture data from the repository root.
- **D5 Build is an explicit prerequisite.** The workflows add `pnpm run build`. A stale-`dist` guard runs in the test harness and in `prepublishOnly`. There is no `prepack`.
- **D6 Two new dev deps** (`typescript-eslint`, `@types/node@^22`). If A3 fails, the choice is between adjusting flags narrowly and `skipLibCheck` — the latter requires user permission, requested with evidence.
- **D7 (deferred by Astra, §0.2)**: no consolidation of duplicated helpers in this migration.
- **D8 Release as a patch (0.2.1)** if all completion proofs hold. If any consumer-observable difference survives review, re-decide versioning with Astra before the Changeset lands. Expected visible differences are limited to internal tarball paths: `src/*.cjs` → `dist/*.cjs`, the bin file path and the `types` path. None of these is reachable through `exports`.

### Plan review record
Fable 5.1 critiqued the first draft independently (read-only, with probes). Adopted:
- the overload-hidden seam (D3 reversed);
- no `allowJs` (F12);
- quote-agnostic, bidirectional dependency scan (F13);
- `files` negations for `.d.cts` and `.tsbuildinfo`;
- Node-type-free public declarations;
- explicit public annotations;
- stale-`dist` refusal in `prepublishOnly`;
- `MIN_NODE` 22.18;
- A2/A3/A4 largely settled by evidence;
- a shorter registry differential.

Also verified: ESLint 10 loads TS config only behind an unstable flag or via jiti, so `eslint.config.cjs` stays JS.

## 6. Risks and mitigations
- **Silent behavior drift** (F8) → Phase 1 characterization, no test edits during P3, frozen JS oracle, mutants, registry differential.
- **Vacuous checks** (F5) → non-vacuity assertions written red in P1.
- **Assertion/`any` creep to appease `exactOptionalPropertyTypes`** → lint policy + justified-suppression inventory; reviewers treat unexplained assertions as defects.
- **Declaration drift / doc churn** → TSDoc ported verbatim; api-report/docs byte oracle; mutual assignability.
- **Toolchain assumptions A1–A4** → P0 spikes with named fallbacks; `skipLibCheck` never without permission.
- **Release pipeline** → step-order tests updated test-first; verify-pack allowlist tightened not loosened; tarball diff vs 0.2.0 explained file by file.
- **Parallel agents colliding in `dist/`** → separate worktrees per agent, lead-serialized merges.

## 7. Completion proof (what Astra receives)
1. Clean checkout: `pnpm install --frozen-lockfile && pnpm run build && pnpm run check` green on Node 22 (latest) and 24; ≥1,806 tests plus new ones, 0 skipped beyond baseline.
2. Frozen JS oracle (P3 test tree) green against the final `dist/`.
3. Test-conversion parity report and mutant-kill table (both suites).
4. `api-report/` and `docs/api/` unchanged vs `2829530` (or each diff line justified); 48-export mutual-assignability result.
5. Registry differential report vs 0.2.0: interop probes, `--help`, CLI and library outputs over the fixture corpus — byte/deep-equal.
6. Tarball file list vs 0.2.0 with every difference explained; `verify-pack` and `npm publish --dry-run` clean.
7. Inventory of every remaining assertion, `@ts-expect-error`, and `eslint-disable` with its reason; inventory of remaining JavaScript with reasons.
8. Changeset (patch) + passing release-plan check; Fable review findings and dispositions.
All raw evidence under `logs/opus/typescript/`; decisions and checkpoints in `docs/typescript-migration-plan.md`.
