# Claim-analysis contract

The effective runtime prompt and validation remain in `src/semantic.mjs`. This document describes the generic design constraints, not additional language-specific checks.

The model receives repository identities, extracted skill assertions, and bounded source excerpts.

For each candidate claim the model may suggest:
- `claim_id`
- `verification`: `SUPPORTED | CONTRADICTED | DEPRECATED | NOT_FOUND | NOT_CHECKED | NEEDS_REVIEW`
- `knowledge_class`: `repo-domain | sdk-contract | shared-domain | agent-policy`
- `applicability`: `repo-local | sdk-consumer | shared | unknown`
- `owner`, `confidence`, `evidence[]`, `reason`

A file path, quoted line or symbol match establishes a candidate reference — **not semantic entailment**. Claims must be downgraded when their implications cannot be verified against exact source material; an LLM judgment is not a deterministic proof. Unsupported or composite assertions remain unresolved. The generic product ships no language- or company-specific contract checker.

`LOCAL_ONLY` may be recognized for backwards compatibility with old analysis documents and reinterpreted as `NEEDS_REVIEW` with repository-local applicability where appropriate. This is compatibility with an analysis vocabulary, not a dependency on historical pilots.

Users can explicitly run `wizard review` on existing results or `wizard audit --analysis` with local repositories to avoid unnecessary repeated model calls. The user alone approves edits to Agent Skills.
