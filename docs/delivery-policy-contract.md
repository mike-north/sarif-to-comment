# Delivery policy: contract

Draft contract · September 30, 2026. It turns the owner's delivery decisions of September 30, 2026 into a normative policy: [D48](design-decisions.md#d48-make-publication-policy-caller-controlled--accepted-product-direction-implementation-design-open) (caller control and precedence), [D49](design-decisions.md#d49-keep-each-supplied-group-available-for-collective-application-in-one-pr--owner-selected-direction-host-verification-open) (a group stays whole), [D50](design-decisions.md#d50-use-one-delivery-setting-for-whole-file-additions-and-deletions--owner-selected-direction) (one setting for whole-file additions and deletions), [D51](design-decisions.md#d51-propagate-whole-file-delivery-over-its-explicit-group--owner-selected-precedence) (a group follows its whole-file operation), [D52](design-decisions.md#d52-organize-companion-prs-around-caller-selected-acceptance-choices--owner-scenarios-representation-design-open) (companion bundles), [D53](design-decisions.md#d53-offer-alternative-remedies-as-a-related-family-of-companion-prs--owner-scenario-cleanup-mechanism-unverified) (alternatives stay separate), [D55](design-decisions.md#d55-report-unavailable-explicit-delivery-requests-without-silently-substituting--owner-selected-direction) (no silent substitution) and [D56](design-decisions.md#d56-make-each-review-an-explicit-index-of-its-companion-proposals--owner-selected-scope-extension) (the review indexes its companions). Values marked **owner confirmation** are engineering choices that the owner confirms or replaces at release review (§15).

**Status.** The resolution and planning rules of §3–§10 and the configuration validation of §11 are implemented as an internal module, `src/delivery-policy.cts`. Publication, readiness assessment and the command line do not use it yet: until they do, the [companion contract](companion-suggestion-pr-contract.md) (its single `allowSuggestionPullRequests` setting, §2.1–§2.5) describes what the tool does. Where the two differ, this contract is the target.

**Sources.** [Decisions](design-decisions.md) D22, D43, D44, D46 and D48–D56; [specification](specification.md) R8, R9, R12 and R16; the [companion contract](companion-suggestion-pr-contract.md) §2.2–§2.5 and §2.7; the [file-operation publication contract](file-operation-publication-contract.md); the [suggestion pull request convention](suggestion-pr-convention.md) §4; [Diagnostics](diagnostics.md).

The key words MUST, MUST NOT, SHOULD and MAY are used as in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## Contents

1. [Purpose and boundary](#1-purpose-and-boundary)
2. [Delivery units](#2-delivery-units)
3. [Dimensions and mechanisms](#3-dimensions-and-mechanisms)
4. [Ordered lists](#4-ordered-lists)
5. [Defaults](#5-defaults)
6. [Presets](#6-presets)
7. [Layers and precedence](#7-layers-and-precedence)
8. [Routing each unit](#8-routing-each-unit)
9. [Companion bundles](#9-companion-bundles)
10. [Blocking and announced fallback](#10-blocking-and-announced-fallback)
11. [The configuration file](#11-the-configuration-file)
12. [Caller settings](#12-caller-settings)
13. [Recording the resolved policy](#13-recording-the-resolved-policy)
14. [Acceptance examples](#14-acceptance-examples)
15. [Owner confirmation and open questions](#15-owner-confirmation-and-open-questions)

## 1. Purpose and boundary

A review proposes changes. This contract decides, for each proposed change or group of changes, **which mechanism delivers it**: a native suggestion, a section of the review body, or a companion pull request. It decides nothing else.

- **Caller control (D48).** Defaults are replaceable. For each dimension, the caller's explicit setting wins over the repository's configuration, which wins over the default. A caller can keep everything on the original pull request, or send every group and every whole-file operation to companion pull requests (§6).
- **No silent substitution (D55).** Only a mechanism the policy lists is ever used. When no listed mechanism can deliver a unit, the whole publication is blocked before any write.
- **Groups stay whole (D49, D51).** A group has exactly one destination for all of its members.
- **Delivery only.** Whether a mechanism *can* deliver a unit (native eligibility, companion obstacles such as a fork or a size limit, body limits) is decided by preparation and is an input here (§8.7). How each mechanism is presented is the business of the presentation contracts. This contract does not invent edits for findings without fixes (D48).

## 2. Delivery units

A **delivery unit** is what receives one destination. Every proposed change belongs to exactly one unit; a change belongs to one group or none ([companion contract §2.3](companion-suggestion-pr-contract.md#23-groups-a-fix-with-several-changes-and-explicit-groups)). Findings that carry the identical change share its unit (R8).

| Unit | What it is | Governed by |
| --- | --- | --- |
| **Edit** | One change to an existing file that belongs to no group. | `edits` |
| **Edit group** | An explicit group (`suggestionGroup`) or a single SARIF fix with several changes, every member of which is an edit. | `groupedEdits` |
| **File operation** | One whole-file creation or deletion that belongs to no group. Creations and deletions are one category (D50). | `fileOperations` |
| **File-operation group** | A group (explicit, or a fix with several changes) with at least one whole-file creation or deletion among its members. | `fileOperations` (D51) |

**Alternatives are not delivery units** (D44, D53). A result's further fixes are listed with their finding ("Alternatives to consider:"). They are never members of a group, never in a companion pull request or bundle, and never committed (§8.6).

## 3. Dimensions and mechanisms

Each dimension has a fixed vocabulary. No other value is valid.

| Dimension | Mechanism | Meaning |
| --- | --- | --- |
| `edits` | `native` | A native suggestion on the original pull request, in an inline review comment. |
| | `review-body` | The exact replacement shown on the original pull request in the review body, for the author to apply by hand. It is not an applicable suggestion. |
| `groupedEdits` | `native-batch` | Every member as a native suggestion on the original pull request, in the same review, with guidance that lists the members by path and line so the author can add all of them to one GitHub suggestion batch (D49). |
| | `companion` | The whole group in one companion pull request. |
| | `manual-group` | One review-body section on the original pull request holding every member's replacement, to be applied together by hand in one commit (D49's manual route). |
| `fileOperations` | `manual` | On the original pull request, by hand. A file operation is its review-body section ([file-operation contract](file-operation-publication-contract.md)). A file-operation group is the **mixed manual group**: one review-body section holding every member, edits as replacements and file operations as their proposals, to be assembled into one commit (D49, D51). |
| | `companion` | One companion pull request holding the operation, or the whole group. |

One more setting is not a delivery dimension but packages what companions deliver:

| Setting | Value | Meaning |
| --- | --- | --- |
| `companionBundle` | `per-unit` | One companion pull request per unit delivered by `companion`. |
| | `single` | One companion pull request holding every unit delivered by `companion`, each in its own section (§9). |

## 4. Ordered lists

`edits`, `groupedEdits` and `fileOperations` each take an **ordered list** of their mechanisms.

1. A list names at least one mechanism, and no mechanism twice. An empty list or a repeated mechanism is invalid (§11.4, §12).
2. The list is the caller authorizing fallback **in that order** (D55). For each unit, the first listed mechanism that is available delivers it.
3. A mechanism the list does not name is never used for that dimension. A list with one entry is therefore **strict**: when that mechanism is unavailable, nothing is substituted and the publication is blocked (§10.1).
4. Using any mechanism other than the first is a **fallback** and is always announced by a warning (§10.2).
5. These rules are the same for every layer (§7), including the defaults (§5).

`companionBundle` is a single value, not a list. It chooses how companion-delivered units are packaged, never whether a unit is delivered, so it has no fallback.

## 5. Defaults

Every dimension has an explicit default. The defaults never create a companion pull request, as before (D22, [companion contract §2.1](companion-suggestion-pr-contract.md#21-the-setting-and-why-it-is-off-by-default)).

| Dimension | Default |
| --- | --- |
| `edits` | `[native, review-body]` |
| `groupedEdits` | `[native-batch]` (**owner confirmation**: §15, item 1) |
| `fileOperations` | `[manual]` |
| `companionBundle` | `per-unit` |

- `edits`: a native suggestion where the edit is eligible, otherwise the review body, with a fallback warning.
- `groupedEdits`: a group whose members are all eligible for native suggestions is offered as one native batch. Any other edit group is blocked. The manual group is never a default (§8.4).
- `fileOperations`: the review-body section, as the file-operation contract has always published it.

## 6. Presets

A preset is a named set of lists. It sets only the dimensions it names; the others come from lower layers (§7).

| Preset | `edits` | `groupedEdits` | `fileOperations` | `companionBundle` |
| --- | --- | --- | --- | --- |
| `original-pr` | `[native, review-body]` | `[native-batch, manual-group]` | `[manual]` | not set |
| `companion` | not set | `[companion]` | `[companion]` | not set |

- **`original-pr`** keeps every proposal on the original pull request and never creates a companion pull request (D48's all-native mode; D51's no-companion workflow). It lists both original-pull-request forms of a group, so choosing the preset authorizes the manual group as an announced fallback (§8.4).
- **`companion`** sends every group and every whole-file operation to companion pull requests, strictly (D48's all-companion mode, D55). It does not set `edits`: the `edits` vocabulary has no companion mechanism, so an ungrouped edit keeps its own setting (§15, item 3).
- Both expansions are **owner confirmation** (§15, item 2).

## 7. Layers and precedence

Each dimension, and `companionBundle`, is resolved **separately**, from the first of these layers that sets it:

| Rank | Layer | Source recorded | Where it comes from |
| --- | --- | --- | --- |
| 1 | Caller, specific | `caller` | A list or value the caller gave for that dimension: `--edits`, `--grouped-edits`, `--file-operations`, `--companion-bundle`, or the library's `delivery.edits` and so on (§12). |
| 2 | Caller, preset | `caller-preset` | The caller's preset (`--delivery`, `delivery.preset`), if it sets the dimension (§6). |
| 3 | Configuration, specific | `configuration` | `delivery.edits` and so on in `.github/sarif-to-comment.json` (§11). |
| 4 | Configuration, preset | `configuration-preset` | `delivery.preset` in that file, if it sets the dimension. |
| 5 | Default | `default` | §5. |

- **Configuration is caller input** (D48). Its lists are as binding as the caller's: a one-entry list in the configuration is strict, and a configured list is never silently replaced by a later one.
- **A list is taken whole.** The winning layer's list replaces every lower layer's list for that dimension; lists of different layers are never merged.
- **Specific over preset, within a layer.** A layer that gives both a preset and a specific list for one dimension resolves to the specific list. A preset that does not set a dimension does not stop the search: the next layer decides.
- The library and the command line are one layer: the command line builds the library's `delivery` option from its flags (§12).

## 8. Routing each unit

### 8.1 One destination per unit

Each unit is routed by the list of the dimension that governs it (§2), to the **first available mechanism** of that list. A unit is atomic: it is delivered whole by one mechanism, or the publication is blocked. In particular, a group is never split between mechanisms, between pull requests, or between companion pull requests, and two members of a three-member group are never delivered without the third (D49).

### 8.2 Edits

An edit follows `edits`.

### 8.3 Edit groups and native batches

An edit group follows `groupedEdits`.

- **`native-batch` requires every member to be eligible for a native suggestion** (D49). If any member is not, `native-batch` is unavailable for the whole group, and its obstacles name each ineligible member with that member's own obstacles. The eligible members are never delivered natively on their own.
- `companion` delivers the whole group in one companion pull request.
- `manual-group` delivers the whole group in one review-body section.

### 8.4 The manual group only when listed

`manual-group` delivers an edit group **only when the governing list names it**. No default names it (§5). A caller or configuration names it explicitly or through the `original-pr` preset (§6).

### 8.5 Groups containing a whole-file operation

A file-operation group follows **`fileOperations`, as a whole** (D51), whatever `groupedEdits` says and whether or not its edits are eligible for native suggestions:

- `companion`: one companion pull request holding every member;
- `manual`: the mixed manual group on the original pull request.

`fileOperations` never pulls anything else along: an unrelated ungrouped edit keeps its own `edits` setting (D51's example). A `fileOperations` list without `companion` therefore never creates a companion pull request for a whole-file operation or its group (D51's no-companion workflow).

### 8.6 Alternatives

Alternatives (§2) are presented with their finding (D44). They are never placed in a companion pull request, never in a bundle, never in a group and never committed, whatever the policy says, including the `companion` preset and the `single` bundle (D53).

### 8.7 Availability is an input

Whether each mechanism is available for each unit is decided by preparation and validation: the native-suggestion eligibility rules (R8, [companion contract §2.4](companion-suggestion-pr-contract.md#24-presentation-form-selection)), what prevents a companion pull request ([companion contract §2.5](companion-suggestion-pr-contract.md#25-repository-target-branch-and-revision): a fork, another base, a size limit, a description limit, …), and the limits of the review-body forms. An unavailable mechanism always carries at least one **obstacle**: a concrete Markdown sentence saying what prevents it. A mechanism is never reported unavailable without one.

## 9. Companion bundles

The units delivered by `companion` are packaged by `companionBundle` (D52):

- **`per-unit`**: one companion pull request per unit, in the order the units are found.
- **`single`**: one companion pull request holding every companion-delivered unit, in the order they are found. Each unit is its own **section**, keeping its identity (the group's name, or the change). A group is one section and is never split across sections or companion pull requests. When no unit is delivered by `companion`, no companion pull request is created.

Bundling packages proposals for one convenient merge. It does not claim that the bundled groups depend on one another, and keeping them separate does not claim that they are independent (D52). Alternatives are never bundled (§8.6). The companion contract's limit on the number of companion pull requests one review creates (`too-many-suggestion-prs`) counts the pull requests the bundling produces.

## 10. Blocking and announced fallback

### 10.1 Blocked: no listed mechanism is available (D55)

When, for a unit, **no mechanism its list names is available**, the publication is **blocked** before any write: no review, branch, pull request or label is created. Every such unit is reported, each with one `delivery-unavailable` error diagnostic. `validate` reports the same outcome as `blocked`. The command line exits **2**; the library returns its `blocked` outcome carrying the diagnostics.

The message names the unit, the list, its source layer and each listed mechanism's obstacles, exactly as follows:

```text
UNIT cannot be delivered. `DIMENSION` is LIST, SOURCE, and no mechanism it lists is available:

- `MECHANISM`: OBSTACLES
```

with one bullet per listed mechanism, in list order, where:

- `UNIT` is the unit's description (for example ``The creation of `docs/guide.md` ``, ``The group `retry-with-test` ``);
- `DIMENSION` is `edits`, `groupedEdits` or `fileOperations`;
- `LIST` is the list in one code span, its mechanisms joined by `, ` within brackets: `` `[companion, manual]` ``;
- `SOURCE` names the layer (§7):

  | Source | `SOURCE` |
  | --- | --- |
  | `caller` | ``set by the caller (`FLAG`, `delivery.DIMENSION`)`` |
  | `caller-preset` | ``set by the caller's preset `PRESET` (`--delivery`, `delivery.preset`)`` |
  | `configuration` | ``set by `.github/sarif-to-comment.json` on the default branch (`delivery.DIMENSION`)`` |
  | `configuration-preset` | ``set by the preset `PRESET` in `.github/sarif-to-comment.json` on the default branch`` |
  | `default` | `the default` |

  where `FLAG` is `--edits`, `--grouped-edits` or `--file-operations`;
- `OBSTACLES` is the mechanism's obstacles, each a sentence, joined by single spaces. For `native-batch`, any obstacle of the group as a whole comes first, then, for each ineligible member in order, ``MEMBER: OBSTACLES`` with that member's description and its own obstacles.

The diagnostic's location is the unit's location (its SARIF pointer) when it has one.

### 10.2 Announced fallback

When a unit is delivered by a mechanism that is **not the first** of its list, the publication proceeds and reports one `delivery-fallback` warning for that unit. As for every warning, it is stated in the outcome's headline, in `diagnostics`, and on stderr in human output ([Diagnostics](diagnostics.md#--format-human)); the exit status stays 0. The message is exactly:

```text
UNIT is delivered as `MECHANISM`. `DIMENSION` is LIST, SOURCE, and the mechanisms listed before it are unavailable:

- `EARLIER`: OBSTACLES
```

with one bullet per earlier mechanism, in list order, and the other parts as in §10.1. Delivering an edit as a native suggestion, or a group as a native batch, when it is first in its list is the requested delivery, not a fallback.

### 10.3 Diagnostic codes

| Code | Severity | Title | Typical remedies |
| --- | --- | --- | --- |
| `delivery-unavailable` | error | No delivery mechanism the policy lists is available for a proposal | Remove the obstacle the message names, then publish again.<br>Or list a mechanism that is available for this kind of proposal (`--edits`, `--grouped-edits`, `--file-operations`, the `delivery` option, or `.github/sarif-to-comment.json`). |
| `delivery-fallback` | warning | A proposal is delivered by a later mechanism of its delivery list | To use an earlier mechanism, remove the obstacle the message names, then publish again.<br>To refuse rather than fall back, list only the mechanism you require. |
| `delivery-configuration-invalid` | error | The delivery configuration is not valid | Fix `.github/sarif-to-comment.json` on the default branch. |

**Reconciliation with the companion contract's codes.** These codes replace, rather than sit beside, the codes of the single allow/disallow setting, none of which was released:

- **`suggestion-pr-fallback` is retired in favour of `delivery-fallback`.** Its case (a whole-file operation whose companion pull request cannot be made, published in the review body) is, under this contract, `fileOperations: [companion, manual]` falling back to `manual`. Every list-driven fallback has one code, whatever the mechanisms; a separate code for one pair would describe the mechanism instead of the condition.
- **`suggestion-group-pr-unavailable`**, **`suggestion-group-requires-suggestion-prs`** and **`fix-changes-require-suggestion-prs`** are retired in favour of `delivery-unavailable`: a group, or a fix with several changes, that no listed mechanism can deliver is one case of §10.1.

Until publication adopts this contract, the implemented behavior keeps reporting the retired codes, as [Diagnostics](diagnostics.md) catalogues them.

## 11. The configuration file

### 11.1 Location and trust

A repository MAY set its delivery policy in **`.github/sarif-to-comment.json`**.

- It is read from the **current commit of the repository's default branch**, never from the pull request's branch, so a pull request cannot change its own delivery policy.
- It is read through Git objects (the default branch's reference, its commit, the trees on the path and the blob), never the Contents API, which would follow a symbolic link to another path's text. This is the same read, with the same trust rules, as `.github/suggestion-prs.json` ([companion contract §2.7](companion-suggestion-pr-contract.md#27-relationship-reference-marker-and-labels)).
- It is optional, read-only and maintained by hand. The tool never writes it.
- It is read once when a publication is planned, by `publish` and `validate` alike, because any dimension may come from it.

### 11.2 Distinct from the convention file

`.github/sarif-to-comment.json` is this tool's own configuration. `.github/suggestion-prs.json` is the tool-neutral convention's ([convention §4](suggestion-pr-convention.md#4-repository-configuration)): it names the canonical label for every tool, and ignores members it does not know so the convention can grow. Neither file is read for the other's purpose. The canonical label is never set in `.github/sarif-to-comment.json` (a `label` member there is an unknown key, §11.4), and delivery policy is never read from `.github/suggestion-prs.json`.

### 11.3 Shape

```json
{
  "delivery": {
    "preset": "original-pr",
    "edits": ["native", "review-body"],
    "groupedEdits": ["native-batch", "companion"],
    "fileOperations": ["companion", "manual"],
    "companionBundle": "single"
  }
}
```

Every member is optional. Its JSON Schema:

<!-- delivery-configuration-schema -->
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "sarif-to-comment repository configuration",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "$schema": { "type": "string" },
    "delivery": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "preset": { "enum": ["original-pr", "companion"] },
        "edits": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": { "enum": ["native", "review-body"] }
        },
        "groupedEdits": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": { "enum": ["native-batch", "companion", "manual-group"] }
        },
        "fileOperations": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": { "enum": ["manual", "companion"] }
        },
        "companionBundle": { "enum": ["per-unit", "single"] }
      }
    }
  }
}
```

The top-level `$schema` member, if present, is a string the tool ignores, so that editors can validate the file.

### 11.4 States and validation

| File on the default branch | Outcome |
| --- | --- |
| Absent | No configuration layer: every dimension comes from the caller or the defaults. |
| An object without `delivery`, or whose `delivery` is `{}` | The same: the configuration sets nothing. |
| A valid object | Its values form the configuration layer (§7). |
| Invalid UTF-8 or JSON; not an object; any unknown member, at the top level or in `delivery`; `delivery` not an object; a list that is not an array, is empty, holds a value outside its vocabulary or repeats a mechanism; a `preset` or `companionBundle` outside its vocabulary; `$schema` not a string; a directory, symbolic link or submodule at the path, or a symbolic link or submodule on the way to it (never followed); a file over 1,000,000 bytes | **Blocked** before any write (`delivery-configuration-invalid`); `validate` reports the same. Every problem found is reported, one diagnostic each. |
| The read failed (network, HTTP 403, 5xx, a malformed answer) | Operational: `publish` rejects and `validate` answers `incomplete`. Never a silent default. |

A leading byte-order mark is allowed and is not part of the JSON. A blocked configuration is never partly used: no dimension is resolved from a file with any problem.

Each `delivery-configuration-invalid` message is exactly:

```text
`.github/sarif-to-comment.json` on the default branch `BRANCH` cannot be used: CLAUSE.
```

where `CLAUSE` is the problem. A problem with the file as a whole is one of: `it is not UTF-8 text`, `it is not valid JSON`, `it is not a JSON object`, `it is a directory` (or `a symbolic link`, `a submodule`) `, not a file`, `` `PATH` is a symbolic link, which is never followed `` (or a submodule, for a path on the way to the file), `it is larger than 1000000 bytes`. A problem with a member is the member's JSON Pointer in a code span, then:

| Problem | Clause after the pointer |
| --- | --- |
| Unknown member | `is not a known setting` |
| `delivery` not an object | `must be an object` |
| A list that is not an array | `must be a list of mechanisms` |
| An empty list | `must list at least one mechanism` |
| A list entry outside the vocabulary (pointer to the entry) | ``is not one of `A`, `B` `` (the dimension's mechanisms, in §3's order) |
| A repeated mechanism (pointer to the later entry) | ``repeats `M` `` |
| `preset` outside its vocabulary | ``is not one of `original-pr`, `companion` `` |
| `companionBundle` outside its vocabulary | ``is not one of `per-unit`, `single` `` |
| `$schema` not a string | `must be a string` |

For example: ``.github/sarif-to-comment.json` on the default branch `main` cannot be used: `/delivery/edits/1` repeats `native`.`` Members are checked in the file's order, and a list's entries in order. Invalid values are named by their pointer and never echoed. A pointer escapes `~` and `/` in member names as `~0` and `~1` ([RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)), and shows each control or invisible formatting character of a member name (those a label name may not hold, [convention §3](suggestion-pr-convention.md#3-the-canonical-label)) as `\uXXXX`, four uppercase hexadecimal digits.

## 12. Caller settings

The caller layer has the same members as the configuration's `delivery` object.

| Library (`options.delivery`) | CLI | Value |
| --- | --- | --- |
| `preset?: 'original-pr' \| 'companion'` | `--delivery <preset>` | A preset (§6). |
| `edits?: ('native' \| 'review-body')[]` | `--edits <list>` | An ordered list. |
| `groupedEdits?: ('native-batch' \| 'companion' \| 'manual-group')[]` | `--grouped-edits <list>` | An ordered list. |
| `fileOperations?: ('manual' \| 'companion')[]` | `--file-operations <list>` | An ordered list. |
| `companionBundle?: 'per-unit' \| 'single'` | `--companion-bundle <bundle>` | A single value. |

- The command line takes a list as comma-separated mechanisms and trims the spaces around each: `--file-operations "companion, manual"` is `["companion", "manual"]`. An empty entry (`a,,b`, a trailing comma, an empty value) is a usage error.
- An invalid caller setting is refused before anything is read, by the rules of §11.4 (an unknown member, an empty list, a value outside the vocabulary, a repeated mechanism): the library throws a `TypeError` naming the member and the problem, and the command line reports a usage error and exits **1**. A caller's mistake is a usage error; a repository's is a blocked publication.
- `validateSarifReview` and `validate` take the same settings, because they take publication's options.
- `allowSuggestionPullRequests` and `--allow-suggestion-prs` are replaced by these settings: a companion pull request is requested by listing `companion`.

## 13. Recording the resolved policy

The resolved policy is part of the publication's identity, in two places:

- **The caller's settings are in the input fingerprint.** When the caller gives any delivery setting, the input fingerprint's identity document gains `delivery`: the caller layer exactly as validated (`preset` and each list or value given, lists in the given order). When the caller gives none, the identity document has no `delivery` member. Retrying a state path with different delivery settings is refused as a `state-mismatch` before any request, as for every other setting ([companion contract §2.2](companion-suggestion-pr-contract.md#22-options)).
- **The resolution is recorded when the publication is planned.** The resolved value of every dimension and of `companionBundle`, each with its source layer (§7, and for a preset layer the preset's name), is persisted with the publication's state before its first write. The configuration is read once, when planning; a retry continues with the recorded resolution and never reads the configuration again, so a later change to the file never changes a publication already planned. This is how the canonical label is already treated ([companion contract §2.2](companion-suggestion-pr-contract.md#22-options)).

The recorded form of each dimension is `{ "value": <list or value>, "source": "<layer>" }`, plus `"preset": "<name>"` when the source is a preset layer. Members appear in the order `edits`, `groupedEdits`, `fileOperations`, `companionBundle`.

## 14. Acceptance examples

Each example gives its inputs and the hand-derived expectation. "Eligible" means available for that mechanism; "C" is the caller layer and "F" the configuration file.

**D-A1 (D48: an explicit choice over configuration).** F: `{"delivery":{"groupedEdits":["native-batch"]}}`. C: `--grouped-edits companion`. `groupedEdits` resolves to `[companion]`, source `caller`. A group of two eligible edits whose companion pull request can be made is delivered by `companion`; no warning.

**D-A2 (D48: presets, the same precedence).** F: `{"delivery":{"preset":"original-pr"}}`. C: `--delivery companion`. `groupedEdits` is `[companion]` and `fileOperations` is `[companion]`, both source `caller-preset` `companion`; `edits` is `[native, review-body]`, source `configuration-preset` `original-pr` (the `companion` preset does not set `edits`); `companionBundle` is `per-unit`, source `default`.

**D-A3 (D48: no configuration, an explicit native choice).** No file. C: `--edits native`. `edits` resolves to `[native]`, source `caller`. An eligible edit is delivered as `native`. An edit that is not eligible is blocked with `delivery-unavailable`, naming `` `[native]` `` and ``set by the caller (`--edits`, `delivery.edits`)``; it is not moved to the review body.

**D-A4 (D48: nothing set).** No file, no caller setting. `edits` `[native, review-body]`, `groupedEdits` `[native-batch]`, `fileOperations` `[manual]`, `companionBundle` `per-unit`, every source `default`. No companion pull request is created for any document.

**D-A5 (D49: two edits delivered natively).** Defaults. An edit group of two members, both eligible. The group is delivered as `native-batch`: both members stay on the original pull request, in one plan entry for the group; no warning.

**D-A6 (D49: never one native and one companion).** An edit group of two members; the first is eligible, the second is not (its lines are outside the diff).
- With the default `groupedEdits` `[native-batch]`: blocked, `delivery-unavailable`, naming the second member and its obstacle under `native-batch`. The first member is not delivered on its own.
- With `groupedEdits` `[native-batch, companion]` and a companion possible: the whole group goes to one companion pull request, with a `delivery-fallback` warning naming the second member's obstacle. Neither member is a native suggestion.

**D-A7 (D51: a helper file and two edits).** An explicit group of a new helper file and two eligible edits that call it; `fileOperations` `[companion]` (for example from `--file-operations companion`). The group is one unit delivered by `companion`: one companion pull request holds all three changes. An unrelated ungrouped eligible edit in the same review is still delivered as `native`.

**D-A8 (D51: the no-companion workflow).** The same group with the default `fileOperations` `[manual]`: delivered as the mixed manual group on the original pull request. No companion pull request is created.

**D-A9 (D55: strict, unavailable).** C: `--file-operations companion`. A standalone deletion on a pull request from a fork, whose companion obstacle is "The pull request's head branch is in a fork." Blocked: one `delivery-unavailable` naming the deletion, `` `[companion]` ``, ``set by the caller (`--file-operations`, `delivery.fileOperations`)``, and that obstacle. Nothing is written; the command line exits 2.

**D-A10 (announced fallback).** F: `{"delivery":{"fileOperations":["companion","manual"]}}`. A standalone creation whose companion pull request cannot be made. Delivered as `manual`, with one `delivery-fallback` warning naming the creation, `` `[companion, manual]` ``, ``set by `.github/sarif-to-comment.json` on the default branch (`delivery.fileOperations`)`` and the companion obstacle.

**D-A11 (D49: the manual group only when listed).** Defaults; an edit group with one ineligible member. Blocked: `manual-group` is not used, because no layer listed it. With `--delivery original-pr`: delivered as `manual-group`, with a `delivery-fallback` warning whose source is ``set by the caller's preset `original-pr` (`--delivery`, `delivery.preset`)``.

**D-A12 (D52: bundling).** `--delivery companion --companion-bundle single`; two edit groups and one standalone creation, all with companions possible. One companion pull request with three sections, in document order. With `per-unit`: three companion pull requests.

**D-A13 (D53: alternatives).** `--delivery companion --companion-bundle single`; a finding whose primary fix is in a delivered group and which has two alternatives. The alternatives are in no companion pull request and no section; they are listed with their finding.

**D-A14 (specific over preset, within a layer).** C: `--delivery companion --file-operations companion,manual`. `fileOperations` `[companion, manual]` source `caller`; `groupedEdits` `[companion]` source `caller-preset`.

**D-A15 (configuration specific over configuration preset).** F: `{"delivery":{"preset":"companion","groupedEdits":["native-batch","companion"]}}`. `groupedEdits` `[native-batch, companion]` source `configuration`; `fileOperations` `[companion]` source `configuration-preset`.

**D-A16 (invalid configuration).** F: `{"delivery":{"edits":["native","native"],"bundle":"single"}}` on `main`. Blocked with two `delivery-configuration-invalid` diagnostics, in file order: `` `/delivery/edits/1` repeats `native` `` and `` `/delivery/bundle` is not a known setting ``. Nothing is resolved from the file.

**D-A17 (invalid caller setting).** `--file-operations ""` or `delivery: { fileOperations: [] }`: a usage error (exit 1) or `TypeError`, before anything is read.

## 15. Owner confirmation and open questions

1. **`groupedEdits` default `[native-batch]`** (owner confirmation). Today an edit group without suggestion pull requests is refused; under this default it is delivered as a native batch when every member is eligible. The alternative is a default that blocks every edit group unless the caller chooses.
2. **The presets' expansions** (owner confirmation, §6). In particular, whether `original-pr` should list `manual-group` after `native-batch`, or be strict (`[native-batch]`), and whether `companion` should set `companionBundle`.
3. **All-companion delivery of ungrouped edits.** D48 asks that a caller can request companion pull requests for all proposed changes. The `edits` vocabulary (`native`, `review-body`) has no companion mechanism, so an ungrouped edit can never be delivered by a companion pull request, even under the `companion` preset. Whether `edits` gains `companion` is open.
4. **`review-body` for an ungrouped edit.** Today an edit that cannot be a native suggestion blocks the review (for example `suggestion-not-inline`). The default `edits` list names `review-body`, so once that form exists such an edit is delivered in the review body with a fallback warning instead. Until the form exists, preparation reports it unavailable, and the behavior is unchanged.
5. **Companion-only caller settings.** `pullRequestLabels` / `--pr-labels` and `markSuggestionPullRequestsReady` / `--mark-suggestion-prs-ready` only affect companions. Whether they are refused when the resolved policy can create none, and how (a usage error cannot see the configuration), is open.
6. **The cost of reading the configuration.** Every publication now reads `.github/sarif-to-comment.json`, so a failed read becomes an operational failure even for a caller who configured nothing and set every dimension. Whether the read is skipped when the caller layer sets every dimension is open.
