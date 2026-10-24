# Wizard of Skillz — TUI quickstart

Run `wizard` inside a **disposable repository** containing at least one Agent Skill. It performs an offline structural scan, then opens the human-controlled review. `wizard scan <repo> --out <fresh-directory>` writes a read-only report outside the inspected repository.

## Navigation
Use **↑/↓** and **Enter** for the guided overview; **Esc** to return. **L** selects the LLM provider, **K** explicitly requests semantic triage, and **J** displays its evidence report. **M** requests a draft for an eligible UPDATE; **E** opens local editing; **P** displays the prepared preview; **R** prepares supported lifecycle operations. **Space** selects a prepared item. The separate **G**, then **Y** confirmation is required before applying a reviewed write.

Not every command is available on every screen: press **?** for contextual help. Navigation and preview fit 60×12 and 80×16 terminals.

## Safety and evidence
Offline findings are bounded structural observations, not semantic proof. Drafts, staged proposals, saved sessions and model outputs cannot authorize Apply. Before confirming, inspect the full diff, source, destination and backups. Paths, symlinks and hashes are rechecked; rollback is best effort, **not an atomic multi-file transaction**. Never use elevated privileges.

Model calls are opt-in and can send selected skill/source excerpts to the chosen service. See [Ollama and provider setup](OLLAMA.md). No organization-specific adapters are shipped.
