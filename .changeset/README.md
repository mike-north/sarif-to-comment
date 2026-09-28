# Changesets

Each Markdown file in this folder describes one pending change to
`sarif-to-comment` and the version bump it needs (`patch` or `minor`). Create
one with `pnpm changeset` in the same pull request as the change.

Releases are versioned with `pnpm run release:version`, which runs
`changeset version` only after the release guard confirms that the pending
changesets would not take the package to 1.0.0 or higher. The guard judges
the version Changesets itself would produce (it rehearses `changeset version`
in a throwaway copy), so every front-matter form Changesets accepts, quoted
or not, is covered. A `major` changeset that would reach 1.0.0 is refused
and left as written, never converted. Releasing 1.0 is a deliberate change:
raise `MAXIMUM_RELEASE_MAJOR` in `scripts/release-guard.mts` to 1 and update
the test in `test/release.test.mts` that pins it; a major changeset then
releases 1.0.0 normally. See the "Releasing" section of the README.
