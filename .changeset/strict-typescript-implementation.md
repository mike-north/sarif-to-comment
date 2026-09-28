---
"sarif-to-comment": patch
---

The implementation is now strict TypeScript, and the shipped TypeScript declarations are generated from it rather than written by hand.

- No change to the public API, the CLI or behavior. The declarations describe the same functions and types as before.
- The packaged runtime files moved from `src/` and `bin/` to `dist/`. The package entry points are unchanged: `require('sarif-to-comment')`, `import … from 'sarif-to-comment'`, its TypeScript types and the `sarif-to-comment` command resolve through `package.json` as before. Only code that reached into the package's internal file paths is affected.
