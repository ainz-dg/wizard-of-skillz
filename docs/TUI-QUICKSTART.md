# Wizard of Skillz — TUI quickstart

Run `wizard` inside a **disposable repository** containing at least one Agent Skill. It performs an offline structural scan, then opens the human-controlled review. `wizard scan <repo> --out <fresh-directory>` writes a read-only report outside the inspected repository.

## Navigation
Use **↑/↓** and **Enter** for the guided overview; **Esc** to return. **L** selects the LLM provider, **K** explicitly requests semantic triage, and **J** displays its evidence report. **M** requests a draft for an eligible UPDATE; **E** opens local editing; **P** displays the prepared preview; **R** prepares supported lifecycle operations. **Space** selects a prepared item. The separate **G**, then **Y** confirmation is required before applying a reviewed write.

From the **overview** press **D** for a documented-domain walkthrough. It asks for resources and skills directories, inventories source documents offline, and then lets you press **L** to choose a model. Press **M** to prepare a model request and **Y** to authorize sending the selected source excerpts. Once generated, select a draft with arrows and **Enter** to inspect the SKILL.md; no install or Apply is available in this path.

Not every command is available on every screen: press **?** for contextual help. Navigation and preview fit 60×12 and 80×16 terminals.

## Safety and evidence
Offline findings are bounded structural observations, not semantic proof. Drafts, staged proposals, saved sessions and model outputs cannot authorize Apply. Before confirming, inspect the full diff, source, destination and backups. Paths, symlinks and hashes are rechecked; rollback is best effort, **not an atomic multi-file transaction**. Never use elevated privileges.

Model calls are opt-in and can send selected skill/source excerpts to the chosen service. See [Ollama and provider setup](OLLAMA.md). No organization-specific adapters are shipped.


## Resources-first domain setup (experimental)

Run `node bin/wizard.mjs scan /path/to/disposable-repo`
from your Wizard checkout. A sample folder layout is:


```text
my-domain/
  resources/
    process.md
    glossary.yaml
  skills/         # optional, may be absent
  toolset/        # optional and not inspected by domain pilot
```


1. Press **D** at the main overview. Enter a path to the resources folder (default:
`resources`). Paths can be relative to the inspected repository.
2. Enter a path to existing skills, or accept the default `skills`. No skills required.
3. Examine the **offline** inventory. Press **L** to select the provider.
4. Press **M**, read the disclosure warning, and press **Y** only if sending those
documents to that provider is authorized.
5. Use arrows and Enter to read draft skills. The TUI never installs the drafts.
Their destination directory is shown on the results screen.

Supported source files: MD, TXT, YAML/YML and JSON. PDFs, Word files, external
web content, cloud drives and toolset execution are not currently supported.
A matching source quote is evidence of provenance, not proof of business correctness.
See [Documented Domain](DOCUMENTED-DOMAIN.md) and
[Account-backed providers](ACCOUNT-PROVIDERS.md).
