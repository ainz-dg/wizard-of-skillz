# Wizard of Skillz

<p align="center">
  <img src="https://raw.githubusercontent.com/ainz-dg/wizard-of-skillz/main/docs/assets/wizard-pixel.svg" alt="Wizard of Skillz pixel-art wizard mascot" width="240" />
</p>

**Keep your skills where they belong.**

A generic, terminal-first, human-controlled assistant for reviewing and maintaining [Agent Skills](https://agentskills.io/).

**Status:** [`0.5.0-rc.5`](https://github.com/ainz-dg/wizard-of-skillz/releases/tag/v0.5.0-rc.5) is published as an experimental prerelease on npm (`next`).

## Install and launch

Requires Node.js **22.12 or later**. Open a terminal and run:

```sh
npx --yes wizard-of-skillz@next
```

Or pin the tested prerelease: `npx --yes wizard-of-skillz@0.5.0-rc.5`.
The TUI starts in the current directory; choose **Scegli il progetto da analizzare** to select another local repository. Initial scans are offline; using an AI provider and applying edits require explicit actions. For your first run, choose a disposable, non-sensitive project. See the [TUI quickstart](docs/TUI-QUICKSTART.md).

## Use Wizard: TUI first

The interactive terminal interface is the recommended way to use Wizard.
The CLI remains for automation, scripting and advanced repeatable operations.
When started in an interactive terminal without arguments, Wizard opens its TUI
and offers guided paths to choose another repository, analyze existing skills,
review documented-domain sources, examine proposals and select an AI provider.
Choosing resources never requires a separate CLI command.

## Try from a source checkout (contributors)

For developers working on Wizard itself:

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

Pin a specific npm version for repeatable installs; `@next` tracks the currently published experimental prerelease.

## How it works

Wizard scans local repositories for Agent Skills, gathers bounded evidence, suggests changes, and provides a human review workflow. The default scan is offline, read-only and does not contact an LLM. AI-powered analysis is optional and **may send skill content and selected source excerpts to the configured model provider**, including a remote server or a cloud-backed Ollama model.

Diffs, generated drafts and staged candidates **do not** authorize changes. Apply requires a separate human confirmation and rechecks selected targets, hashes and paths before writing. Backups are retained; rollback is best-effort rather than a globally atomic multi-file operation. Structural findings and LLM judgments are not semantic proof.

See [TUI quickstart](docs/TUI-QUICKSTART.md), [LLM provider and Ollama setup](docs/OLLAMA.md), [Security](SECURITY.md), and [Acknowledgements](docs/ACKNOWLEDGEMENTS.md).

## Open source readiness

**License:** [Apache License 2.0](LICENSE). The published `0.5.0-rc.5` prerelease includes the reviewed same-repository audit and bounded evidence-selection fixes. Merges never publish: the owner must explicitly publish a GitHub prerelease. See the [release guide](docs/RELEASING.md) and [rc.5 notes](docs/releases/0.5.0-rc.5.md).
