# Wizard of Skillz

**Keep your skills where they belong.**

A generic, terminal-first, human-controlled assistant for reviewing and maintaining [Agent Skills](https://agentskills.io/).

**Status:** `0.5.0-rc.4` is the currently published experimental prerelease. `0.5.0-rc.5` is being prepared for review and is **not published**; `npm`'s `next` dist-tag remains on the published version until the owner approves and publishes a GitHub prerelease.

## Use Wizard: TUI first

The interactive terminal interface is the recommended way to use Wizard.
The CLI remains for automation, scripting and advanced repeatable operations.
When started in an interactive terminal without arguments, Wizard opens its TUI
and offers guided paths to choose another repository, analyze existing skills,
review documented-domain sources, examine proposals and select an AI provider.
Choosing resources never requires a separate CLI command.

## Try Wizard

Requires Node.js 22.12 or later. In a clean checkout:

```sh
npm ci
npm test
npm run pack:check
node bin/wizard.mjs --version
node bin/wizard.mjs --help
node bin/wizard.mjs scan /path/to/disposable-project
```

With no arguments, `wizard` scans the current directory locally and starts the TUI on an interactive terminal. For first runs use a **disposable project**, not sensitive or production source.

## Resources-first documented domains (EXPERIMENTAL)

You can create review-only candidate Agent Skills from an explicitly selected documentation
folder, even when no skills exist yet. For an interactive setup:


```sh
node bin/wizard.mjs scan /path/to/disposable-domain-repo
```

Choose **Crea e verifica skill dalle risorse documentali** on the TUI overview
(or use the D shortcut), choose the resource and existing-skill folders
(defaults are `resources` and `skills`), inspect the offline source
inventory, select the LLM with **L**, then press **M** to request a draft and **Y**
to authorize sending excerpts to that model. Enter opens the generated
`SKILL.md` drafts for inspection. Drafts remain outside the inspected repo.

Alternatively, from the command line:


```sh
node bin/wizard.mjs domain /path/to/disposable-domain-repo \
  --resources resources --skills skills --llm --llm-provider codex-account
```

Domain resources currently support MD, TXT, YAML and JSON only — not PDF or DOCX.
`--llm` is explicit and may disclose selected local documents to the
configured provider. No generated skill is automatically installed or approved.
See [domain guide](docs/DOCUMENTED-DOMAIN.md) and
[EXPERIMENTAL account-backed providers](docs/ACCOUNT-PROVIDERS.md).
Account-backed Codex and Claude Code adapters have simulated CI tests but still
require real-account smoke tests and compliance with each provider's terms.

After the owner publishes `0.5.0-rc.5`, install that exact version or use the `next` dist-tag:

```sh
npx wizard-of-skillz@0.5.0-rc.5
# or, after the same publication updates the dist-tag:
npx wizard-of-skillz@next
```

Until that publication, `npx wizard-of-skillz@next` still installs the already published `0.5.0-rc.4`, which does not include the changes prepared for rc.5. Pin a specific version for repeatable installations.

## How it works

Wizard scans local repositories for Agent Skills, gathers bounded evidence, suggests changes, and provides a human review workflow. The default scan is offline, read-only and does not contact an LLM. AI-powered analysis is optional and **may send skill content and selected source excerpts to the configured model provider**, including a remote server or a cloud-backed Ollama model.

Diffs, generated drafts and staged candidates **do not** authorize changes. Apply requires a separate human confirmation and rechecks selected targets, hashes and paths before writing. Backups are retained; rollback is best-effort rather than a globally atomic multi-file operation. Structural findings and LLM judgments are not semantic proof.

See [TUI quickstart](docs/TUI-QUICKSTART.md), [LLM provider and Ollama setup](docs/OLLAMA.md), [Security](SECURITY.md), and [Acknowledgements](docs/ACKNOWLEDGEMENTS.md).

## Open source readiness

**License:** [Apache License 2.0](LICENSE). The experimental releases `0.5.0-rc.3` and `0.5.0-rc.4` are published and verified. Candidate `0.5.0-rc.5` includes the reviewed same-repository audit and bounded evidence-selection fixes. Merges never publish: the owner must explicitly publish a GitHub prerelease. See the [release guide](docs/RELEASING.md) and [rc.5 notes](https://github.com/ainz-dg/wizard-of-skillz/blob/main/docs/releases/0.5.0-rc.5.md).
