# Independent review: trusted npm release and API documentation (turn 05)

Read-only review against `logs/opus/trusted-publish-review-brief.md` and `logs/opus/release-acceptance.md`. Probes ran only in scratch directories under `/tmp`. I made no product edits, no Git changes, and no publish or other external write. My only network use was a read-only `npm view` of the public registry.

## Snapshot coverage

- `shasum -a 256 -c logs/opus/trusted-publish-review-manifest.txt`: every one of the 62 entries is OK.
- `git diff --quiet HEAD -- src bin vendor` passes. The runtime is byte-identical to commit `dfaebb0`, so there is no product runtime change to justify.
- `git status --porcelain` was the same before and after every probe.

## Checks run

| Command | Result |
| --- | --- |
| `npm run check` (lint, `tsc`, `check:api`, `check:release`, tests) | 1371 tests, 1371 pass, 0 fail, 0 skipped; lint, types, API freshness and release plan all pass |
| `npm pack --dry-run --json` then `node scripts/release-guard.cjs verify-pack` | 52 files, exit 0: runtime, CLI, `types/index.d.ts`, vendored schema, README, CHANGELOG, `docs/getting-started.md`, 38 `docs/api` pages; no fixtures, logs, scripts or credentials |
| Scratch consumer (`/tmp/str-repro/consumer-probe.cjs`): repository's isolated offline pack+install, then `tsc` (nodenext, strict, `exactOptionalPropertyTypes`) on a `.mts` and a `.cts` consumer | exit 0 (details below) |
| Same consumer at runtime | ESM `import { publishSarifReview }` resolves; CJS exports exactly `publishSarifReview`; invalid input rejects with `TypeError`; installed `sarif-to-comment --help` exits 0 |
| `/tmp/str-repro/docs-drift-probe.cjs` (throwaway copies) | Control exit 0; each stale case below exits 1 and names the stale file |
| `/tmp/str-repro/release-probe.cjs` (throwaway copies, real Changesets 3.0.3 CLI) | Results below |
| `npm view sarif-to-comment versions dist-tags maintainers repository --json` | versions `["0.0.0"]`, latest `0.0.0`, maintainer `northm`, no repository field |

The `tsc` consumer checks covered:
- a producer's own SARIF interfaces with no index signature, passed as `sarif`;
- an exhaustive `switch` on `status` that ends in `never`;
- `sourceRootUri: undefined`;
- three `@ts-expect-error` negative controls: an unknown input field, the private second `internals` argument, and a text `sarif`.

The stale cases the drift check caught:
- a declaration doc comment changed without rebuilding;
- a declaration signature changed without rebuilding;
- a generated page edited by hand;
- a leftover page no longer generated;
- the API report edited by hand.

## Verified defects

### V1 — Medium: a quoted `"major"` changeset gets past the plan and version guards

`pendingChangesets` (`scripts/release-guard.cjs:290-307`) reads bump types with the regex `^\s*["']?([^"':]+)["']?\s*:\s*(patch|minor|major)\s*$`. That regex does not accept a quoted YAML value, but Changesets' front-matter parser does. When no pending changeset parses, `computeReleasePlan` returns `releases: []` without running the sandboxed `changeset version` (line 328).

Reproduction, in a scratch copy with only `.changeset/bump-major-quoted.md` containing the front matter `"sarif-to-comment": "major"`:

| Command | Result |
| --- | --- |
| `node scripts/release-guard.cjs plan` (the CI check) | exit 0, "Release plan allowed: no pending releases." |
| `node scripts/release-guard.cjs version` (`pnpm run release:version`) | exit 0, "No pending changesets; nothing to version." The changeset is left pending. |
| real `changeset version` on the same tree | exit 0, `package.json` becomes **1.0.0** |

- **What still holds:** `publish-preflight` and `check-version` refuse 1.0.0, so publication stays blocked.
- **What breaks:** the documented promises that `pnpm run check` "fails if a pending changeset would reach 1.0.0" and that `release:version` "refuses the same plans before `changeset version` changes any file" (`README.md:204-209`, `.changeset/README.md`) do not hold for this valid input.
- **Second effect:** a quoted `"minor"` or `"patch"` changeset is likewise ignored by `release:version`, which reports "nothing to version" for a real pending release.
- **Repair (tests first):** add quoted-value major, minor and patch changesets to `test/release.test.cjs`, alone and mixed with a normal one. Then derive the plan from the real sandboxed `changeset version` whenever any changeset file exists, rather than from the regex. Or refuse any changeset front matter the guard cannot parse.

### V2 — Low-medium: raising the ceiling constant does not allow 1.0

`checkReleasePlan` refuses any `release.type === 'major'` unconditionally (`scripts/release-guard.cjs:194-201`), whatever `MAXIMUM_RELEASE_MAJOR` is.

Reproduction: a scratch copy with `MAXIMUM_RELEASE_MAJOR = 1` and a single `"sarif-to-comment": major` changeset on 0.0.0. `release-guard.cjs version` exits 1: "requests a major release … (0.0.0 -> 1.0.0). Releases at 2.0.0 or above are blocked until MAXIMUM_RELEASE_MAJOR … is deliberately raised."

- The refusal message contradicts itself: it refuses 1.0.0 while saying only 2.0.0 or above is blocked.
- Minor bumps can never reach 1.0.0, so the documented route cannot release 1.0.

These instructions say that raising the constant is the deliberate step, and are therefore inaccurate:
- `scripts/release-guard.cjs:13-15` and lines 56-58;
- `README.md:204`;
- `.changeset/README.md`;
- `test/release.test.cjs:13` and line 122.

Repair (tests first): add a test that a raised ceiling permits the major reaching exactly `MAXIMUM_RELEASE_MAJOR`.0.0 and still refuses the next one. Then compare the planned major against the ceiling instead of refusing the `major` type outright, or document every step truthfully. This is not a request for protection against administrators.

### V3 — Low-medium (documentation): `published` promises current remote existence

These say "The draft review exists on GitHub", or "The review exists on GitHub" for the discriminant:
- `types/index.d.ts:106` and `:112`;
- the generated `docs/api/sarif-to-comment.md:70`, `docs/api/sarif-to-comment.ipublishedoutcome.md:7` and `:118`, and `docs/api/sarif-to-comment.ipublishedoutcome.status.md:7`;
- the Outcomes table in `docs/getting-started.md:159`.

The same row's advice, "Nothing; a person submits the draft", also assumes it is still a draft.

A repeat call on a completed receipt returns `published` with no GitHub request at all. That no-network behavior is an existing, tested contract (`test/publication.test.cjs` "a completed receipt is final"; README "Completed and rejected records return without authentication or network calls"). By then a person may have submitted or deleted the review.

- **Fix:** describe `published` as a completed publication: created and confirmed now, confirmed after an uncertain attempt, or recorded as complete in the state file. The review may since have been submitted, edited or deleted, and the tool does not check.
- **Steps:** fix the declaration first, then run `pnpm run build` so the generated pages follow. A docs test asserting the receipt-path wording would stop it regressing.
- **Scope:** no product behavior change and no review maintenance.

## Missing live evidence (parent-owned; not defects)

- **OIDC trusted publishing** has not run for real. The workflow's identity matches the documented npm trusted-publisher row, and there is no npm token in `publish.yml` or `ci.yml`:
  - owner `mike-north`, repository `sarif-to-comment`, workflow `publish.yml`, no environment;
  - `id-token: write` and `contents: read`;
  - `repository.url` is `git+https://github.com/mike-north/sarif-to-comment.git`.

  Still unproven: npm's trusted-publisher record being saved, and the OIDC exchange working with `setup-node` given no `registry-url`. The pinned action SHAs (checkout v7.0.1, setup-node v7.0.0, pnpm/action-setup v6.1.0) could not be verified offline.
- **Registry state.** npm currently holds only 0.0.0, with no repository field, so the README's unpkg "latest" documentation links resolve to 0.0.0 content until 0.1.0 is published. Once 0.1.0 is out, a clean consumer install from the registry, and whether the links resolve, still need checking. Locally, the first-release flow works: the pending `minor` changeset turns 0.0.0 into 0.1.0 with a `## 0.1.0` changelog entry, and later patch and minor releases give 0.1.1 and 0.2.0.
- **Required status checks.** CI's plan check only protects `main` if it is a required status check. Branch protection was not inspected. The publish preflight remains the hard stop.

## Nonblocking limitations

- **`undefined` values in SARIF.** Runtime capture refuses `undefined`-valued properties inside `sarif`. The types (`sarif: object`) cannot express this, and producers building objects with optional TypeScript fields may hit it. It is documented and was already the behavior; nothing changed here.
- **No LICENSE file.** `license: "ISC"` is declared but the tarball has no LICENSE file.
- **`prepublishOnly` backstop.** It does not run for `npm publish <tarball>`. That is documented, and the workflow's preflight covers that path.

## Confirmed as meeting the brief

- **Release guard.** Unquoted major changesets and pre mode are refused before any file changes. Prereleases and ≥1.0.0 versions are refused at publish preflight and at `check-version`.
- **Workflow ordering.** Preflight runs first, then `check`, then pack, then `verify-pack`, then the exact tarball is published. There is no `--provenance`, and the private-repository no-provenance limitation is stated accurately.
- **Drift guard** has the discrimination listed under "Checks run".
- **Declarations** match the runtime's input fields, the outcome union and the stated rejection semantics. The private `internals` seam is not declared.
- **Docs.** The getting-started examples execute in the suite against the installed package. The README states that the review token and npm release authentication are unrelated. The cited evidence documents exist.

**Verdict:** V1–V3 should be fixed tests-first before the first release is merged to `main`. Nothing I found would publish a version at 1.0.0 or above, and the runtime is unchanged.
