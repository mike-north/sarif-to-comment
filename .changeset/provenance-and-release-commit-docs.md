---
"sarif-to-comment": patch
---

Correct the release documentation shipped in the README.

- Provenance is described conditionally. Trusted publishing authenticates with OIDC from a private or public repository, but npm attaches a provenance attestation only when the source repository is public at publish time. Version 0.1.0 carries a verified attestation; a release from a private repository has none.
- Release commits are no longer said to be recorded as `gitHead`, which is absent from the registry metadata for 0.1.0. The commit is identified by the `publish.yml` run and, when present, the provenance attestation; tags remain optional.
