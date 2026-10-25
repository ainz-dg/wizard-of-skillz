# Documented-domain pilot

A resource-first workflow for Agent Skills. The software workflow remains unchanged.

## Prepare a disposable project

A domain repository may contain:
- resources/: authoritative **candidate** documentation (Markdown, text, YAML, JSON)
- skills/: optional existing Agent Skills
- toolset/: optional; **not** automatically inferred or executed by this pilot

Wizard has no special meaning for any organization's folder conventions. Select a
resource directory explicitly.

## Read-only inventory

    node bin/wizard.mjs domain ./example --resources resources --out /tmp/wizard-domain-audit

This lists a bounded snapshot of resource documents and existing skills. It does
not contact a model or suggest skills without model evidence.

## Propose reviewable skills

    node bin/wizard.mjs domain ./example --resources resources --skills skills --llm \
      --llm-provider copilot --out /tmp/wizard-domain-review

This **explicitly** calls the selected model, sending bounded local resource
excerpts and existing skill excerpts. Choose the provider under your own data
policies. Do not point it at confidential documentation without authorization.

Output is written **outside** the inspected project:
- domain-audit.json: source identities, hashes, findings, review status
- candidate-details.json: proposed steps with exact source quotes and review flags
- skill-candidates/<name>/SKILL.md: human-review drafts, NEVER installed automatically

The model may return zero candidates when documentation contains no useful
procedures. No skill is created for every source document.

## Interpretation limits

The system checks that cited text really occurs in the identified source, and
retains the source hash. **A quote match does not prove that the claim or
proposed procedure is true.** In particular, an old or conflicting manual can
contain a false instruction. Owners must review scope, applicability, audience,
terminology, risks, and proposed steps before installing any candidate.

Communication guidance is part of the proposed draft: report facts relevant to
the recipient's role and domain, and never claim that work or an approval was
completed without evidence. This is not a substitute for live execution testing.

No automatic Apply, no publication, no external connector, no PDF extraction,
no toolset discovery, and no claims of semantic proof are included in this pilot.
