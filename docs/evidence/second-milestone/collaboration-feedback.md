# Collaboration feedback: second milestone

This is a proposal-only retrospective by the extraction author, written after acceptance. It records observations and recommendations; none of them were adopted automatically as project or global instructions. On September 28, 2026 it was condensed to its project-relevant content. Process-tooling proposals and internal session details were removed, and the original text is in Git history. Labels: [F] fact, [A] assumption, [P] proposal.

**Were purpose and requirements clear?** Yes.

- [F] Every assignment stated:
  - the outcome;
  - the files owned and what was off-limits;
  - tests first, with real failing evidence;
  - what to hand back.
- [F] When the contract was accepted it was named as binding, and its revisions were labeled as engineering choices rather than user policy.
- [F] Specification facts arrived with their sources (the SARIF sections, the GitHub Contents behavior).
- [F] One gap: the contract gave message templates for changed lines, creation and deletion, but none for a pure insertion's message, location or receipt range. The author filled the gap, and review 01 found two defects there: C1 (unpublishable) and C5 (untruthful receipt). An insertion row in the contract would likely have prevented both.

**Did recommendations stay open to challenge?** Yes.

- [F] One challenge was needed. The grouped-fix assignment called its probe a confirmed violation with independently authored effects.
  - The probe's replacement (`{startLine: 1}` → `"ONE\n"`) produces `ONE\n\ntwo…`, which is not the staged bytes, so failing on that exact input was correct.
  - The underlying gap was real: grouped replacements were never compared.
  - The author repaired the gap, kept the probe input as a test that must fail for a genuine difference, and reported the mismatch.
- [F] Every other supplied probe and oracle was correct and reproduced exactly, including the replace-ref probe, the review 01 probes, and the independent source oracle and upstream fixture.

**What caused rework, and what helped.**

- [F] Most of the C1 rework traced to one gap. The only publisher-composition test covered line edits; insertion outputs were never run through the publisher.
- [F] Some environment friction cost time but never produced a wrong result. One example is an invalid `GITHUB_TOKEN` in the environment overriding the keyring login.
- [F] Some assignments were long single paragraphs with ambiguous phrases. "Unchanged input bytes" in C3 could mean the caller's SARIF or an unchanged BOM-only file, so both were covered.
- [F] What helped most:
  - verified specification facts, each of which became a test target;
  - proportionate budgets;
  - naming a sibling module's exports in advance, so failing tests could be written before that module existed.

**Interventions and handoffs.**

- [F] Independent review 01 found a real high-severity defect (C1) that the author's tests missed.
- [F] The receipt-shape handshake with the public-surface owner converged on a single module hash that both surfaces tested against.
- [F] The installed-package runs and real GitHub application covered what local tests could not.
- [P] Before calling a probe a confirmed violation, check its expected bytes with an independent applier, and label each expectation as "asserted" or "verified".

**Project-specific proposals**

1. [P] Add an insertion row to the contract. More broadly, add a table of every extraction output shape against the publisher.
2. [P] Make it a standing rule that every new extraction output shape gets one composition test against the unchanged publisher.
3. [P] Mention the `GITHUB_TOKEN` override in live-evidence briefs, or unset it in the launcher.
4. [P] Defect reports should say whether the expected bytes were verified (and how) or only asserted.
5. [P] Structure assignments as requirements with their basis, recommendations, open questions and acceptance checks. This would have avoided the C3-style ambiguity.

No other material lessons were recorded. Mutation isolation, hash reporting, failing-before-passing evidence and scope limits all worked as intended.
