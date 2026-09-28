# Comparison criteria, recorded before receiving the result

The existing model is identified by the checksum in [method.json](method.json). Do not alter it while comparing. Keep the independent answer separate from the comparison, so subsequent interpretation cannot silently rewrite what the agent independently produced.

Compare:

1. **Behavioral coverage:** Can each account explain the required outcomes, including incomplete and ambiguous outcomes, without introducing silent policy choices?
2. **Necessary distinctions:** What breaks if each proposed distinction is removed? Shared terminology is not evidence of shared reasoning; different terminology is not evidence of disagreement.
3. **Ownership and independent variation:** Does information move to the right scope when the producer, reviewed content, intended changes, destination, current branch, or request outcome varies?
4. **Relationship complexity:** Does the model need extra registries, global identities, generic graphs, mandatory intermediate formats, or user-managed lifecycle states? Are those costs justified by a concrete requirement?
5. **New counterexamples:** Do independently proposed scenarios reveal a failure or an unstated assumption in the existing model? Can one model handle it with fewer exceptions or less caller reconstruction?
6. **Interaction burden:** What information and choices must the caller supply, and what can safely remain internal or derived? Do superficially simple interfaces merely conceal obligations?

Classify findings as independent convergence, useful refinement, substantive divergence, unsupported addition, or shared unresolved gap. Preserve disagreements instead of counting similar nouns as a score. A claim of improvement needs a concrete behavior or cost difference.

## Limits

The brief was extracted by the existing designer, so framing and selection bias remain possible. It deliberately includes settled host-specific product choices while omitting the existing conceptual inventory, named abstractions, hidden-marker solution, and preferred operation surface. Agreement is corroboration under that brief, not independent empirical proof that the requirements are complete, the model is minimal, or a future implementation is correct.
