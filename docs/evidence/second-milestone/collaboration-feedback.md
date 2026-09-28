# Collaboration feedback: second milestone

Proposal-only feedback from the existing extraction conversation after acceptance. These are worker observations and recommendations, not automatically adopted project or global instructions. No persistent guidance was edited.

The feedback is drafted below. Plan mode blocks writing it to `logs/opus/m2/collaboration-feedback.md`, and the tool to leave plan mode isn't available in this session, so I'm returning it here. The full text is also in the plan file (`~/.claude/plans/shared-vocabulary-a-requirement-purring-wozniak.md`) and can be copied to the log unchanged. Labels: [F] fact from this session, [A] assumption, [P] proposal.

**Were purpose and requirements clear?** Yes.
- [F] Every ticket stated the outcome, the files I owned, what was off-limits, tests-first with real failing evidence, and what to hand back. I never had to guess where my boundaries were.
- [F] The contract, when accepted, was named as binding, and its revisions were labeled as engineering choices rather than user policy.
- [F] Specification facts arrived with sources (the SARIF sections, the GitHub Contents behavior).
- [F] One gap: the contract gave message templates for changed lines, creation and deletion, but none for a pure insertion's message, location or receipt range. I filled that gap myself, and review-01 found two defects there (C1 unpublishable, C5 untruthful receipt). An insertion row in the contract would likely have prevented both.

**Did recommendations stay open to challenge?** Yes.
- [F] Tickets explicitly invited it ("choose implementation, not a new user policy"; "rather than changing the contract to match current behavior"). The contract review also visibly corrected several of my own defaults, with reasons.
- [F] The one place a challenge was needed: the grouped-fix ticket called its probe a confirmed violation with independently authored effects.
  - The probe's replacements (`{startLine: 1}` → `"ONE\n"`) produce `ONE\n\ntwo…`, which isn't the staged bytes. So failing on that exact input was correct.
  - The underlying gap was real: grouped replacements were never compared, which I had already listed as a limit.
  - I repaired the gap, kept the probe input as a test that must fail for a genuine difference, and reported the mismatch. The ticket's wording allowed this, but its confidence pushed toward fitting the code to the probe.
- [F] Everything else you supplied was correct and reproduced exactly:
  - the replace-ref probe;
  - the review-01 probes p1 and p2;
  - the parent's source oracle and upstream fixture, which passed on the first implementation run.

**What caused rework, and what helped.**
- [F] Most of the C1 rework was mine. My only publisher-composition test covered line edits; I never ran insertion outputs through the publisher.
- [F] There was no direct channel to you. To get the shared URI resolver, I messaged peer sessions. The authoring owner delivered it within the hour, but that relied on goodwill and on guessing session names.
- [F] Environment friction cost a turn or two each but never produced a wrong result:
  - an invalid `GITHUB_TOKEN` in the environment overriding the keyring login;
  - a hook matching "find" inside a grep pattern;
  - an SSH clone hanging;
  - `cd` followed by git needing approval.
- [F] Some tickets were long single paragraphs with ambiguous phrases. "Unchanged input bytes" in C3 could mean the caller's SARIF or an unchanged BOM-only file, so I covered both.
- [F] What helped most:
  - verified specification facts, each of which became a test target;
  - proportionate budgets ("no full mutation campaign");
  - allowlisting the exact hash and mutation commands mid-stream, after I'd twice had to report them as not run;
  - naming the sibling module's exports in advance, so I could write failing tests before that module existed.

**Interventions and handoffs.**
- [F] The independent review-01 found a real high-severity defect (C1) that my tests missed.
- [F] The receipt-shape handshake with the public-surface owner converged on a single module hash that both surfaces tested against.
- [F] Your installed-package, real-GitHub application runs covered what my local tests could not.

**Feedback on Astra.** Strong evidence discipline, explicit ownership, honest labeling of requirements versus choices, fast reproducible probes, proportionate scope, and pushback was accepted without friction. One improvement: before calling a probe a confirmed violation, check its expected bytes with an independent applier, and label expectations as "asserted" or "verified".

**Project-specific proposals**
1. [P] Add an insertion row to the contract, and more broadly a table of every extraction output shape against the publisher.
2. [P] Make it a standing rule that every new extraction output shape gets one composition test against the unchanged publisher.
3. [P] Mention the `GITHUB_TOKEN` override in live-evidence briefs, or unset it in the launcher.

**Proposals for the shared orchestration skill or CLI**
1. [P] Defect tickets should say whether the expected bytes were verified (and how) or only asserted.
2. [P] Use a structured ticket layout: Requirements with their basis, Recommendations, Open questions, Acceptance checks. This would have avoided the C3-style ambiguity.
3. [P] Include a coordination roster in each brief: sibling owners' session names and how to reach Astra.
4. [P] List the exact verification commands the worker will need (hash, harness, suite) in the brief, so they're allowlisted before evidence is due.
5. [P, low priority] Suppress "changed on disk" notices when a file's content hash hasn't changed. [A] They appear to come from other workers touching modification times; they led me to re-hash files defensively at the start of several tickets.

No other material lessons: mutation isolation, hash reporting, failing-before-passing evidence and scope limits all worked as intended. Nothing was changed.
