---
name: wizard-of-skillz
description: Audit and improve Agent Skills for one or more related software repositories using code, documentation and existing skills. Use when asked what Agent Skills to create, update, move, merge, split, remove or keep, and to propose reviewable changes without applying them.
---

# Review Agent Skills as a working knowledge system

Take a position on what should change. You are the analyst, not a classifier filling in a claim-by-claim form. Do not wait for deterministic proof before recommending a worthwhile change; distinguish observation, inference and uncertainty.

1. **Map the context.** Identify the repositories, their relationships, existing Agent Skills and project instructions. Locate current code, tests, relevant docs and versioned policies. Confirm branch/commit. Do not treat historical documentation as current implementation. If scope is large, choose representative, risky or repeated workflows first and name the limits.
2. **Investigate actively.** Follow relevant references into source and tests. Compare where a rule is documented with where it actually applies. Detect stale instructions, harmful over-specificity, duplication, missing recurring workflows, weak entry-point descriptions, fragmented or overgrown skills, and knowledge that belongs in code/docs rather than a skill. Existing skills are not ground truth; code is evidence of behavior, not automatically the intended policy.
3. **Recommend decisively.** Prefer a small, prioritized set of actionable interventions over a large list of ambiguous claims. Allowed outcomes: KEEP, UPDATE, CREATE, MOVE, MERGE, SPLIT, DELETE, or NO CHANGE. For each, state *what*, *where*, *why*, impact, evidence, competing explanations and confidence. Avoid creating a skill for ordinary facts, one-off instructions or information cheap for an agent to rediscover.
4. **Design for agents.** Make instructions executable, concise and conditional; prefer clear triggering descriptions, steps with completion criteria, and pointers to deeper references. Remove no-op advice, duplicated knowledge and hard-coded environmental facts. Apply progressive disclosure. Do not impose one repository's conventions on another.
5. **Prepare human review.** Produce a concise editorial summary first, then an ordered action register with file paths and proposed replacement text/diffs when feasible. Mark source citations as `repo@commit:path#Lx-Ly`, or indicate missing line numbers when unavailable. Clearly separate `VERIFIED` evidence from `INFERRED` recommendations and `UNVERIFIED` risks. Explain why some plausible interventions were rejected. Include a way to accept/reject actions individually.
6. **Stop at proposals.** Never modify canonical skill files, open product PRs, execute project code, publish, or delete without explicit approval for that action. Ask before reading private content across trust boundaries or sending excerpts to an external model. Keep private-repo evidence out of public artifacts.

## Response contract

Begin with **Assessment** (a few sentences: biggest issue, expected gain, what is working). Follow with **Proposed actions** prioritized by usefulness, each with: `ID · action · source → destination · rationale · evidence · confidence · proposed change`. End with **Keep / do not change**, **Unknowns & risks**, and **Human review** (which actions can be independently approved). If nothing useful needs changing, say **NO CHANGE** and why.

Be frank: low confidence is not a reason to suppress a proposal; it is a reason to label and justify it. Do not pretend to have read the entire repo if only a subset was inspected.
