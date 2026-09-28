# Independent re-review: V1–V3 repairs (turn 06)

Read-only review against `logs/opus/trusted-publish-review-05-result.md` and `logs/opus/release-acceptance.md`. Probes ran only in scratch directories under `/tmp`. I made no product edits, no Git changes, no external writes and no publish, and I did not wait on the author's mutation run.

## Coverage

- `shasum -a 256 -c logs/opus/trusted-publish-review-06-manifest.txt`: all 49 entries are OK.
- Files changed since turn 05, with their manifest hashes:

  | File | SHA-256 |
  | --- | --- |
  | `scripts/release-guard.cjs` | `4839feed8ecbfd2710d07d5a5176461157f0ca4838a0f246c25c560b5ec9afc7` |
  | `test/release.test.cjs` | `138f5e3753149106cde3a8417058b9199c2f2d2f7b39f3021248822794aa9c54` |
  | `test/docs.test.cjs` | `e149e88f4ec8f62e5cc35bcc753c3f0c983e479da5f1d53cce62ab13c681843d` |
  | `types/index.d.ts` | `6a5d6c84634f44e18993ab1d9274fb5319dbc356c51a64136407783adf36c5b7` |
  | `README.md` | `f036dee5d2fc7fa41b33da1669a1cfe824c5f9307ed3ed3253ca44bcfd267d08` |
  | `docs/getting-started.md` | `1917e1dbccb9a2a0cef9c4845a3287cedea66492f4b59dcdb93e42d8d7d1981a` |
  | `docs/api/sarif-to-comment.md` | `367524613d00cce0b4b38d7aae4a9262aaf9be43488eabaf1e8bd494a8aba8e4` |
  | `docs/api/sarif-to-comment.ipublishedoutcome.md` | `218bc12038beb6f09be60d9fe70ce15e419a771da46f7611c43e53ed460e1bd1` |
  | `docs/api/sarif-to-comment.ipublishedoutcome.review.md` | `a24594f531ba4620fcaceac3a25764d481db93af5223d197740e8682478f5b2f` |
  | `docs/api/sarif-to-comment.ipublishedoutcome.status.md` | `7f4075a46edef648d2af3cc98a0b96cdf53ec67c3fd54db36a95ba37a683e694` |

- **Coverage gap:** `.changeset/README.md` also changed since turn 05 but is **not** in the turn-06 manifest. I reviewed it at `f3f4bffd063d22e5a43a0532bda99c3d45720f6b7836d48510597078758c95e6`; add it to the manifest. Every other turn-05 manifest entry that the new manifest omits still matches its turn-05 hash.
- `git diff --quiet HEAD -- src bin vendor` passes: runtime behavior is unchanged. `git status --porcelain` was the same before and after.

## Checks run

| Command | Result |
| --- | --- |
| `npm run -s check:types` | exit 0 |
| `npm run -s check:api` | exit 0, "API report and 38 reference pages are up to date." (so the pages were regenerated from the corrected declaration) |
| `npm run -s check:release` | exit 0, "sarif-to-comment 0.0.0 -> 0.1.0 (minor)" |
| `npm run -s check:lint` | exit 0 |
| `node --test test/release.test.cjs test/docs.test.cjs test/package.test.cjs` | 123 tests, 123 pass, 0 fail, 0 skipped |
| `/tmp/str-repro/release-probe-06.cjs` (throwaway copies, real Changesets 3.0.3 CLI) | Results under V1 and V2 below |

I did not rerun the full suite. The author reports 1389/1389.

## Reconciliation of turn-05 findings

**V1 (quoted YAML bump values): fixed.** `computeReleasePlan` now always rehearses the real `changeset version` in a sandbox whenever any changeset file exists. It judges the version and changelog section Changesets actually writes, and refuses changesets Changesets rejects or leaves unconsumed.

| Pending changeset(s) | `plan` | `version` | Resulting state |
| --- | --- | --- | --- |
| `"sarif-to-comment": "major"` | exit 1 | exit 1 | unchanged (0.0.0, changeset kept) |
| `'sarif-to-comment': 'major'` | exit 1 | exit 1 | unchanged (0.0.0, changeset kept) |
| `sarif-to-comment: "major"` | exit 1 | exit 1 | unchanged (0.0.0, changeset kept) |
| quoted `"major"` plus plain `minor` | exit 1 | exit 1 | unchanged (0.0.0, changeset kept) |
| quoted `"minor"` | 0.0.0 -> 0.1.0 | versions | `## 0.1.0` |
| quoted `"patch"` | 0.0.0 -> 0.0.1 | versions | `## 0.0.1` |
| a changeset for an unknown package | exit 1, surfacing Changesets' own refusal | — | — |

The regression tests in `test/release.test.cjs` from about line 360 cover double-quoted, single-quoted, spaced and mixed forms, plus quoted minor and patch.

**V2 (ceiling raise): fixed.** With `MAXIMUM_RELEASE_MAJOR = 1` in a scratch copy:

| Starting version and changeset | Result |
| --- | --- |
| 0.3.0, `major` | `plan` exit 0; `version` gives 1.0.0 with a `## 1.0.0` entry; `check-version` exit 0 |
| 1.2.0, `major` | refused before mutation: "(1.2.0 -> 2.0.0) … Releases at 2.0.0 or above are blocked"; the message is now coherent |
| 1.2.0, `minor` | 1.3.0 |

The shipped ceiling of 0 still versions the first release to 0.1.0. Tests at `test/release.test.cjs:162` and `:228` check the raised ceiling by injecting it as a parameter. My probe additionally confirms the end-to-end constant edit, as the documentation now describes.

**V3 (completed-receipt wording): fixed.**
- `types/index.d.ts` now reads "The publication is complete …", with a `@remarks` section. It says the completed record is returned without contacting GitHub, and that the review may since have been submitted, edited or deleted without the tool checking.
- The regenerated `docs/api` pages match; `check:api` is fresh.
- The Outcomes row at `docs/getting-started.md:159` is corrected.
- No "exists on GitHub" claim remains in `types/`, `docs/`, or `README.md`.
- A docs test at `test/docs.test.cjs:230` pins the wording.

## New findings (parent observations assessed)

### F1 — Low-medium, documentation: the publish-recovery instructions don't work as written

`README.md:236` says: "If a run fails before publishing, fix the cause on `main`, then re-run the workflow or push the fix."

- **Re-running doesn't pick up a fix.** A GitHub Actions re-run executes the original run's commit (`GITHUB_SHA`) with the workflow file from that commit, so a fix merged to `main` afterwards is not included.
- **Pushing the fix may not trigger anything.** `.github/workflows/publish.yml` triggers only on `push` to `main` with `paths: [package.json]` and has no `workflow_dispatch`. A fix limited to `scripts/`, the workflow, tests or docs never starts a publish run.

A re-run is correct only for external or transient causes: a registry outage, npm-side trusted-publisher settings, or a runner problem. For a repository fix, the unpublished version becomes publishable again only through a later `main` commit that changes `package.json`. Preflight would then find the version unpublished with its CHANGELOG entry and publish it. The next Changesets release would also move past that version.

**Repair:** tests-first, update the docs test or the release-workflow test to pin the intended recovery path. Then state that distinction truthfully. Adding a dispatch trigger is a design choice for the author and parent; the finding requires only accurate instructions.

### F2 — Low, durable-comment accuracy: two stale `changeset status --output` references

- `scripts/release-guard.cjs:181` (the `checkReleasePlan` JSDoc) says the plan "is the JSON written by `changeset status --output`".
- `test/release.test.cjs:85` says the same in a test helper comment.

The actual source is `computeReleasePlan`'s sandboxed `changeset version` result. The comment at `scripts/release-guard.cjs:334` explicitly says `changeset status` is not used. Update both comments. This is comment-only, with no behavior impact.

## Nonblocking observations

- **Empty changeset (`---\n---`).** An empty changeset gives "no pending releases" from `plan` and "nothing to version" from `version`, and stays pending until a real release consumes it. That is harmless and consistent with Changesets.
- **`IPublishedReview` summary.** It still reads "The draft review on GitHub." That is acceptable alongside the corrected `review` member ("The review as it was when the publication completed").

## Verdict

V1–V3 are fixed and regression-tested. The runtime is unchanged, and the private-repository no-provenance statement is unchanged. The remaining actionable items are F1, a documentation correction, and F2, comment accuracy. Neither lets a disallowed version publish, and neither changes product behavior. They should go to the same author before the release commit.
