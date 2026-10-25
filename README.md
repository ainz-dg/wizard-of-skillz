# Wizard of Skillz

**Keep your skills where they belong.**

A generic, terminal-first, human-controlled assistant for reviewing and maintaining [Agent Skills](https://agentskills.io/).

**Status: pre-release source candidate 0.5.0-rc.2.** This repository contains a clean-history snapshot; validation and publication review are in progress. No official GitHub Release or npm package has been published.

## Try locally (before release)

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

## Resources-first documented domains (experimental)

You can create review-only candidate Agent Skills from an explicitly selected documentation
folder, even when no skills exist yet. For an interactive setup:


```sh
node bin/wizard.mjs scan /path/to/disposable-domain-repo
```

Press **D** on the TUI overview, choose the resource and existing-skill folders
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
[account-backed providers](docs/ACCOUNT-PROVIDERS.md).

After an approved npm prerelease is published with the `next` dist-tag, users will be able to run:

```sh
npx wizard-of-skillz@next
```

This command is not available until npm publication is actually completed.

## How it works

Wizard scans local repositories for Agent Skills, gathers bounded evidence, suggests changes, and provides a human review workflow. The default scan is offline, read-only and does not contact an LLM. AI-powered analysis is optional and **may send skill content and selected source excerpts to the configured model provider**, including a remote server or a cloud-backed Ollama model.

Diffs, generated drafts and staged candidates **do not** authorize changes. Apply requires a separate human confirmation and rechecks selected targets, hashes and paths before writing. Backups are retained; rollback is best-effort rather than a globally atomic multi-file operation. Structural findings and LLM judgments are not semantic proof.

See [TUI quickstart](docs/TUI-QUICKSTART.md), [LLM provider and Ollama setup](docs/OLLAMA.md), [Security](SECURITY.md), and [Acknowledgements](docs/ACKNOWLEDGEMENTS.md).

## Open source readiness

**License:** [Apache License 2.0](LICENSE). The candidate remains `private: true` in `package.json` to prevent accidental npm publication during review. The proposed release process is documented in [docs/RELEASING.md](docs/RELEASING.md). No merge, repository visibility change, GitHub Release, or npm publication is authorized by the presence of these files.
