The consumer promise is: **“Turn this feedback, and any exact changes I supply, into a review of this revision. Preserve what the feedback says and how the changes must be accepted.”**

That promise includes preparing material and delivering it. It does not include deciding which criticism is correct, selecting among competing fixes, approving feedback, or accepting changes into the author’s branch.

The smallest useful model has five main meanings: a reviewed revision, feedback, proposed changes, a complete review package, and a particular publication. Some of their necessary distinctions can remain values and relationships rather than separate entities.

**1. A reviewed revision identifies the subject of the review**

A review needs an explicit repository and revision, associated with the original PR. A moving branch name or PR number alone is insufficient: the author can push more commits without changing either.

Two facts must remain separate:

- **What content the feedback discusses.** This stays bound to the reviewed revision.
- **Where a proposed change would now be accepted.** An additional PR targets the author’s branch, which may have advanced.

Feedback can remain valid as a statement about an older revision even when its proposed edit can no longer be applied to the current branch.

References also need to identify the content they actually describe. “Line 1” might mean line 1 of an existing file at the reviewed revision, or line 1 of a proposed new file. These are different content sources. A proposed file does not become an existing file merely because its contents have coordinates.

A source reference therefore needs the meaning of **content identity, path, and optional region**. Its serialization may be a SARIF location, URI, or other supported representation. Those encodings are not additional domain concepts.

A reference can be valid without being eligible for inline placement. Conversely, falling back to general review text cannot make an invalid reference valid.

**2. Feedback records an explanation, independently of any edit**

Feedback is the supplied explanatory material: a concern, recommendation, observation, or rationale, together with its attribution and relevant references.

It can have:

- No source reference, such as an architectural observation.
- Several source references, such as a mismatch between an API declaration and its implementation.
- No proposed change.
- Relationships to several changes or alternative proposals.

Attribution belongs to the explanation, not merely to a displayed comment. If an analysis tool and a human explain the same replacement for different reasons, presenting one replacement must not erase either explanation or origin.

“Feedback item” need not become a new public schema competing with SARIF. It names the meaning the tool must preserve while reading and rendering supplied material.

The relationship between feedback and changes is many-to-many. For example, one explanation about a missing authorization boundary could support both a handler change and a regression test. Conversely, two explanations could support the same handler replacement. A displayed GitHub comment is consequently not the identity of a feedback item.

**3. Proposed changes distinguish exact operations from acceptance requirements**

There are two necessary levels.

An **edit** says exactly how content changes. The basic operation distinctions are:

- Replace a specified region of existing content.
- Add a file at an intended path with its complete contents.
- Delete an existing file.

Emptying a file is a replacement that leaves an empty file. It is not deletion. Likewise, adding an empty file is still an addition.

An edit’s meaning includes the content against which it was specified. “Replace lines 20–24” is not a complete identity without the relevant file version and replacement content.

A **proposal** groups the edits offered as one acceptance unit. It can contain one edit or several. An explicitly inseparable code change and regression test belong to one proposal even when they affect different files.

This grouping expresses supplied intent. Sharing a checkout, adjacent lines, or a common producer does not establish it.

Alternative proposals require a separate relationship: **these choices are mutually exclusive**. This need not be a new entity, but it must survive preparation and presentation. Two proposals that modify the same region are not automatically alternatives; their relationship may instead be unknown or invalid. The tool must not supply the missing semantic decision.

These distinctions have several consequences:

- An identical edit can be shown once while preserving several explanations.
- Equality cannot mean “same range.” Different replacement text at the same range is a materially different change.
- Combining identical edits does not authorize combining their containing proposals. An edit might participate in two different alternatives with different associated changes.
- Feedback near a replacement is not part of the replacement unless an explicit relationship says so.
- Several independently acceptable edits do not become one inseparable proposal merely because they can fit in one additional PR.

The staged-content workflow supplies exact content changes, not explanations or semantic grouping. It uses a captured index state relative to the reviewed revision and excludes unstaged working-tree content. If combining staged changes with supplied feedback requires relationships that are absent, proximity cannot fill the gap.

**4. A review package is the complete boundary of validation and sending**

A review package means “all the material supplied for this intended review.” It includes the reviewed revision, feedback, proposals and their relationships, and any explicit sending holds.

This boundary matters because publication is all-or-nothing in **eligibility**, even though remote creation cannot necessarily be atomic. A package containing one invalid reference or one unrepresentable required proposal is not eligible for a smaller “safe” publication.

A sending hold is separate from invalid material:

- Valid material with a hold can be successfully prepared.
- It cannot be sent unless the hold is released upstream or deliberately overridden.
- Overriding a hold does not repair an invalid reference, unsupported content, or unavailable joint-acceptance representation.
- The absence of approval metadata is not a hold.

No approval history, inferred staleness, or proofreading lifecycle is needed.

Already complete SARIF can constitute the package directly. Optional preparation is useful when combining producers or deriving staged edits; it is not a compulsory conversion ritual.

**5. A publication identifies this particular attempt to deliver the package**

The same package might intentionally be published twice. That is different from retrying after a lost response.

A publication therefore needs an identity independent of both its contents and the IDs GitHub eventually returns. Its intended material and relevant delivery choices must remain recognizable when it is resumed.

A publication can require:

- One GitHub code review.
- Zero or more additional PRs.
- The configured label and original-PR reference on every additional PR.
- Explicit review submission when requested.

These are distinct remote obligations. Knowing that one PR exists does not establish that another PR or the review exists.

The publication must track both remote progress and uncertainty:

- Work known to be unattempted.
- Work confirmed to exist.
- Work whose creation may have succeeded.
- Work still required to finish the requested result.

“Uncertain” describes the caller’s knowledge, not a new GitHub object state. After a response is lost, an immediate empty search cannot turn uncertainty into confirmed absence. Resumption investigates remote state before creating another object, correlates discoveries to the particular publication and obligation, and stops with an actionable unresolved result when identity cannot be established safely.

The implementation needs durable enough correlation to survive interruption, but that does not imply a continuously running service or reconciliation of every historical review.

Once every required object and property is confirmed, the publication can be reported as complete in the requested state: draft by default, submitted only by explicit choice. Partial remote success must remain visibly partial.

**Presentation is a responsibility, not the domain model**

A GitHub adapter determines how validated meanings can be faithfully represented.

For an eligible small edit, it prefers a native suggestion. For an explicitly inseparable proposal, it uses one additional PR when allowed. File additions and deletions also prefer additional PRs when that setting is enabled.

When additional PRs are disabled:

- An individual addition or deletion can use general feedback if its full meaning and content can be preserved, with verified supported convenience links.
- An inseparable multi-edit proposal cannot be converted into several independently applicable comments. The package must report that the setting is required.
- General text must not claim to provide native click-to-apply behavior.

General review feedback preserves valid explanations that cannot be placed inline. It links to the exact referenced content where that content exists and is linkable. For proposed content that has not been created remotely, it must describe the content honestly rather than fabricate a source permalink.

The adapter may need a delivery plan, placement decisions, rendered bodies, and size checks. Those are useful implementation artifacts. They do not justify turning “comment,” “suggestion block,” “fallback,” and “PR body section” into competing domain identities.

Detailed support bounds remain unverified here. Binary content, special file types, encoding, line-ending preservation, links carrying complete new-file contents, and GitHub size limits need explicit capability verification. Unsupported material produces a diagnostic; it does not authorize truncation or an upload to another service.

**Preparation and publication have different lifecycles**

Preparation can succeed while sending is held. Publication can fail before writes because preparation output is invalid or GitHub cannot faithfully represent it. These facts should not be collapsed into one “ready” flag.

For the optional local preparation step:

- Strict failure produces diagnostics and no current successful result.
- Best effort produces a clearly distinguished error artifact containing the representable flawed material.
- Earlier successful output remains historical, named using its original creation time.
- A failing rerun removes that historical result from the normal success location.
- Diagnostics point to actual inputs and explain what needs repair or proof on rerun.

An error artifact is useful repair material, not a publication bypass. A later publication still validates the complete supplied material.

Literal references remain data. A URI that resembles an executable command is not executed; a remote-looking reference is not fetched simply because it appears in an input.

**Cleanup is a bounded later operation**

An authorized caller can discover open PRs bearing the configured label, resolve their relationship to original PRs, verify that the originals have ended, and close eligible leftovers.

The relationship is an ordinary reference to the original PR; there is no need to edit the original’s description. Publication correlation used for retries can coexist with this reference without turning cleanup into a historical reconciliation service.

A failed or unauthorized lookup leaves the original’s state unknown. Unknown is not ended.

Closing an additional PR and deleting its source branch are separate actions with separate authority and separately reported results. Completing one cannot imply completion of the other.

**Attempts to merge concepts**

Several simplifications work:

- “Human finding,” “AI finding,” and “analyzer finding” can all be feedback with attribution. Their producers do not require different behavior classes.
- Native suggestions and additional PRs can be delivery forms of proposals. They are not different kinds of criticism.
- Existing-file and proposed-file references can share a source-reference concept, provided content identity remains explicit.
- Preparation results can be ordinary files and diagnostics. No managed document-history domain is needed.

Other merges lose necessary meaning:

- **Feedback = edit:** loses valid observations without changes and explanations supporting several changes.
- **Edit = proposal:** loses explicit joint acceptance across several edits.
- **Proposal = displayed comment:** cannot express one explanation appearing with several changes or one change retaining several explanations.
- **Reviewed revision = current PR head:** rewrites the subject of feedback when the branch moves.
- **Valid = inline-placeable:** incorrectly rejects valid old-revision references or incorrectly accepts nonexistent lines through fallback.
- **Approval hold = preparation failure:** prevents useful preparation and risks losing the hold during repair.
- **Publication = content hash:** cannot distinguish an intentional second publication from resumption.
- **Publication complete = first successful create:** misreports partial remote work.
- **PR closed = branch deleted:** exceeds authority and misstates outcomes.

**Minimal interaction surface**

The consumer needs four capabilities, without requiring fixed command syntax:

1. **Prepare, optionally:** combine supplied SARIF and, if requested, a captured staged state relative to an explicit reviewed revision. Return successful material or diagnostics and an explicitly erroneous artifact according to the chosen failure mode.
2. **Publish:** take complete material, identify the original PR and reviewed revision, choose draft or explicit submission, configure additional-PR permission and labeling, and optionally override explicit holds. Validate everything before writes and return the identity and confirmed state of the publication.
3. **Resume or inspect a publication:** investigate uncertainty and finish missing obligations for the same intention. Intentional new publication is an explicit different operation or choice.
4. **Clean up:** discover and assess labeled additional PRs, then perform authorized closure and, separately, authorized branch deletion.

The provisional default permits additional PRs. Draft code review remains the default. Severity never selects an approve or request-changes action.

This surface does not need commands for proofreading, semantic winner selection, inferred dependencies, or hosting an approval service.

**Questions the model lets callers answer**

- Which exact revision does this explanation discuss?
- Does this source reference identify existing or proposed content, and is its region valid?
- Which explanations and producers support this edit?
- Which edits must be accepted together?
- Which proposals are explicitly alternatives?
- Can the entire package be represented under the chosen settings?
- Is sending blocked by a hold, invalid input, unavailable representation, or uncertain remote state?
- Which remote obligations are confirmed, uncertain, or still missing?
- Is this request a new publication or a continuation?
- Which additional PRs are eligible for closure, and was branch deletion separately authorized?

**Additional stress scenarios**

1. **The author changes the same interface during review.** Feedback concerns an argument order at revision H. The author then changes the function signature and migrates callers. The original source reference remains valid, but applying the earlier replacement to the current branch could undo the migration. The model separates historical reference validity from present applicability. It cannot silently retarget the explanation or invent a rebased semantic fix.

2. **Two alternatives share a helper edit.** One proposal changes a parser and adds a helper; another changes a tokenizer and adds the identical helper. Both have different tests. Deduplicating the helper’s presentation must not combine the parser and tokenizer alternatives or detach the helper from either acceptance unit. This tests whether edit identity has incorrectly replaced proposal identity.

3. **A lost response is followed by human activity.** GitHub creates an additional PR, the response is lost, and a maintainer immediately edits its title and adds a commit. A retry based only on the original title or branch-content equality might miss it and create a duplicate. Publication identity must survive presentation changes. What to do with the human-added commit is a separate unresolved policy question; discovery does not authorize overwriting it.

4. **One producer has an explicit hold while another producer supplies a usable fix.** Preparation succeeds and preserves both inputs. Sending the usable fix alone would violate the package boundary. A deliberate hold override permits reconsideration of sending, but an unrelated invalid line in either producer’s material still blocks the complete publication.

5. **A generated resource file exceeds a host’s supported representation.** The file belongs to an inseparable proposal with a small implementation change. The small change fitting a native suggestion does not make the proposal representable. The complete package fails validation unless a supported additional-PR path can preserve the resource and acceptance requirement. A truncated comment or third-party upload is not an equivalent result.

**Unresolved product contracts**

The requirements leave several decisions open:

- What explicitly associates staged edits with supplied explanations, especially when one explanation covers multiple files? What should happen to staged edits with no supplied association?
- Does a particular SARIF structure itself declare joint acceptance or alternatives, or is additional explicit information needed? That mapping must be specified.
- May unselected alternatives all be presented as separate proposals, or must upstream select before publication? The tool cannot silently decide.
- When the author’s branch has advanced, what mechanically verified adaptation is permitted before it becomes a new semantic fix?
- What makes an edit “small” and eligible for native suggestion delivery? Exact bounds require verification.
- What is the supported representation for proposed-only source references when additional PRs are disabled and no remote source exists?
- How are cleanup relationships disambiguated if a PR body names several original PRs, and precisely which original states qualify as ended?
- How should resumption handle a discovered object that a human modified or deleted? Detection is necessary; automatic replacement is not established by the requirements.
- For immediate submission, which review action is explicitly chosen or defaulted? Severity supplies no answer.

These are missing behavior contracts, not reasons to introduce a larger platform. The retained model already provides places to state their answers without changing the consumer promise.
