# Independent derivation: comparison and lessons

September 27, 2026. The fresh agent substantially converged on the existing model. The useful difference is a sharper recovery case: identifying a remotely created object does not establish that its current contents still match what the publisher intended, especially after human edits. This is a missing continuation contract, not evidence that the entire model needs replacing.

**Subsequent scope correction — D29:** The user explicitly constrained the product to one-way initial publication. Human-change reconciliation, review maintenance, and importing GitHub state into SARIF are out of scope. The analysis below records the independent exercise, but its proposed continuation work must not expand into those features. Recovery only verifies/completes initial delivery without duplicates or overwriting human work; unresolved delivery can remain a reported outcome. New SARIF can create a separate new review.

## What was independent

The agent was started without conversation history and received only the [problem and behavioral requirements](brief.md). It was not given the existing concept inventory, preferred surface, decision log, domain-modeling report, or hidden-marker recovery design. It was instructed not to inspect files, memories, other agents or outside material. After returning its answer, it reported that it made no tool calls and used only the supplied brief, its visible general instructions and general knowledge. That provenance statement is the agent's report, not an independently instrumented access audit.

The [original response](independent-result.md) is preserved separately from this interpretation. The [comparison criteria](comparison-criteria.md) and [baseline checksum](method.json) were recorded before its answer arrived. The existing [domain-model scrutiny](../domain-model-scrutiny.md) was not revised during this comparison.

The brief necessarily supplies established requirements, so convergence on their explicit consequences is weaker evidence than an independently chosen decomposition. Its preparation by the existing designer also leaves framing bias. This exercise supplies independent corroboration of a plausible model, not proof that the model is uniquely minimal or empirically correct.

## Where the accounts converge

| Existing account | Independently derived account | Interpretation |
|---|---|---|
| Feedback retains explanation, attribution and source association independently of proposed changes. | Feedback is independent of edits and displayed comments, with several-to-several relationships where necessary. | Convergence. Much is directly constrained by the brief's feedback-only and shared-replacement cases; it should not be presented as a surprising discovery. Neither account requires a generic graph API. |
| A proposed change preserves the supplied acceptance boundary and contains operations. | A proposal is one acceptance unit containing one or more edits. | Same two levels of meaning under different names. No additional Group service or entity is required by either. |
| Reviewed/proposed content provenance differs from host placement; operation targets can differ from feedback locations. | Content identity stays explicit; historical reference validity differs from current applicability and inline placement. | Strong agreement on boundaries. The existing account makes the three roles more explicit; the fresh account emphasizes applicability to the current branch. |
| A complete review contribution is the whole-publication validation boundary but needs no second public format or pre-publication persistent identity. | A review package is the complete boundary of validation and sending and can be supplied directly as SARIF. | Naming/prominence difference, not a demonstrated architectural conflict. The independent account does not require a managed package resource. |
| A logical publication and each intended remote object retain stable identities across request attempts. | A publication differs from content identity and eventual GitHub IDs and tracks distinct remote obligations. | Independent convergence on durable intent and per-object progress without being told the marker solution. These are also consequences of the required ambiguous-create behavior. |
| Preparation, rendering and assessment do not require separate user-managed lifecycle entities. | Preparation results, presentation plans and placement decisions can remain files, results and adapter responsibilities. | Convergence on avoiding a larger platform or second review schema. No measurable implementation reduction has yet been demonstrated. |
| Optional prepare; publish with resume; cleanup. | Optional prepare; publish; resume/inspect; cleanup. | Same capabilities, different proposed interface grouping. Neither dictates final command syntax. It is not evidence that one domain model is smaller. |

## Useful new or stronger challenges

### 1. A recovered object may have changed since creation

**Fresh scenario:** GitHub creates the suggestion PR, its response is lost, and a maintainer changes the title and adds a commit before retry.

The existing model's stable per-object marker should identify the same PR despite a title change. But identity recovery alone does not answer whether the publisher may update its body, label, branch or contents, or what should be reported if the PR has been deleted. Earlier requirements say to verify a recovered candidate; they do not define these continuation conditions precisely.

**Concrete learning:** Preserve three separate answers: which object this is, what it currently contains, and which remaining actions are still valid. These are observations and operation conditions within the existing publication model; no new managed entity is justified.

**Recommendation, not an adopted blanket policy:** Preserve human changes. Define narrow conditions for completing missing properties and report a diagnostic when continuing would overwrite or invalidate intervening work. A test must show that a recovered identity neither causes duplicate creation nor licenses restoring the original content over a human edit. The policy for deletion/replacement remains explicit work.

This is the strongest addition from the independent pass. It sharpens a previously implicit obligation rather than disproving the original core model.

### 2. Shared bytes do not make two alternatives one proposal

**Fresh scenario:** A parser-based alternative and a tokenizer-based alternative both add an identical helper, but contain different changes and tests.

The existing account already says physical edit equality must not replace acceptance identity. The independent scenario gives that rule a more concrete test: presentation may avoid repeated text where faithful, but each separately offered alternative must retain the helper it needs. A global deduplication that removes the helper from one suggestion PR would be wrong.

**Classification:** Independent corroboration plus a stronger fixture, not a newly discovered domain distinction. A shared edit does not justify a global edit registry or merging the alternatives.

### 3. Historical truth and present applicability are different

**Fresh scenario:** The author changes a function signature and migrates callers after the reviewed revision. The old feedback still accurately names its reviewed source; applying its proposed edit to the new branch may undo subsequent work.

The existing model preserves the reviewed revision and already leaves historical host eligibility unverified. The fresh account makes an additional check more explicit: displaying an accurate historical reference is not proof that an action can safely apply its change to the current branch. General presentation need not retarget the feedback, and mechanical rebasing must not silently become semantic rewriting.

**Classification:** Useful sharpening of an existing boundary. Concrete branch-advance and same-file-change fixtures are needed before promising actionable historical edits.

## Differences that should not become new requirements automatically

- **Review package as a named concept:** Both accounts already need the whole-input boundary. Promoting it to another stored or public resource would require demonstrated benefit; the fresh answer did not establish that need.
- **Separate resume/inspect capability:** This can be part of the publish interaction. No evidence requires a separate public command, endpoint or state-management interface.
- **Branch deletion within cleanup:** The fresh answer mentions separately authorized deletion. The requirements distinguish its authority and outcome from PR closure; they do not by themselves settle initial branch-deletion support. Preserve that separation without adding automatic deletion to scope.
- **Several referenced original PRs:** Exact relationship conventions remain to implement, but this does not overturn the settled use of labels and original references or require a new relationship database. The intended original must be unambiguous under the supported convention.

## Open contracts: new versus already known

The fresh answer independently surfaced several known gaps: association of staged changes, explicit grouping/alternative encoding, supported source/content cases, current-head adaptation, and the review action used for immediate submission. These were already recorded engineering or product contracts. They are not new discoveries merely because another agent listed them.

It also asked whether unselected alternatives can all be offered or must be selected upstream. The existing design prohibits silently choosing or unioning them, but the concrete supported presentation is not yet specified. This reinforces the earlier R4 clarification: an intentional alternative is not automatically a conflicting edit that must be reconciled with every other alternative. Exact support must be settled through worked input/output examples; no alternative may be silently lost.

The genuinely stronger follow-up is behavior after human modification or deletion of a recovered object. That needs an explicit continuation contract before recovery can be called safe beyond the synthetic response-discard test.

## What this changes

Keep the existing core model provisionally. There is no substantive competing decomposition in the independent answer that currently earns a replacement. Do not claim that matching five-item inventories or similar vocabulary proves optimality.

Before implementation, add concrete acceptance fixtures for:

1. Recovery after a human changes the body, branch contents, or lifecycle state of the created object.
2. Two offered alternatives sharing an identical edit while retaining different jointly accepted members.
3. A reviewed revision whose changed lines remain valid historical references but whose suggested edit conflicts with newer author work.

The exercise therefore did more than repeat the existing document: it independently reconstructed much of the same structure and supplied sharper counterexamples. Its evidence supports retaining the core while tightening recovery and applicability contracts. It does not settle all open policies or justify beginning implementation without the agreed scope and contracts.
