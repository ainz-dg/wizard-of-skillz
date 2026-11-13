# Experimental: Wizard agent-first pilot

**Status:** exploratory; not the current `wizard` CLI/TUI behavior, not a release candidate.

The first version of Wizard tried to produce good advice by splitting a repository
into extracted claims and asking a language model to classify the fragments.
For knowledge maintenance this can overconstrain the investigation: the tool
can hide relationships that a normal coding agent would explore directly.

This experiment uses **one ordinary Agent Skill** to instruct an existing
coding agent with repository-reading tools to investigate **one or more related
projects** and recommend changes. No bespoke agent runtime, provider-specific
SDK integration, claim quota, external database, new evaluator or TUI.

## Try it

Check out this **experimental branch** with a coding agent that can read the
repositories you want to review. Give that agent the file
`skills/wizard-of-skillz/SKILL.md` as the review instructions, and ask:

> Review the Agent Skills knowledge across these repositories and their relevant
> source and documentation: [paths]. Recommend the most valuable CREATE, UPDATE,
> MOVE, MERGE, SPLIT, DELETE or KEEP decisions. Rank them, show real evidence,
> and prepare suggested edits. This is read-only: do not change files or open PRs.

The skill has Agent Skills frontmatter so a compatible host can discover it.
Directly pointing an agent at the file also works before installation. The
pilot requires an agent that can actually inspect the requested repositories;
reading the file alone **does not run an audit**.

When the experimental branch has been merged and the user chooses to install
it, the conventional Agent Skills CLI can install from the repository:

```sh
npx skills add https://github.com/ainz-dg/wizard-of-skillz --skill wizard-of-skillz
```

Do **not** treat this command as applicable to the current published npm
package. The `wizard-of-skillz@next` CLI remains the legacy prototype.

## What to review with a human

Compare this report with what a strong coding agent produces **without** the
skill on the same scope. Judge whether the recommended actions are concrete,
useful, supported by inspected material and easy to approve or reject.
Consider time spent reading/reviewing and dangerous or irrelevant suggestions;
do not turn the trial into a benchmark infrastructure project.

Only after this simple comparison proves useful should Wizard build an
interface for report presentation, diff previews and *individually approved*
application. Preserve source ownership: private repository findings must never
be committed to this public project.

**No knowledge changes or publications happen automatically.**
