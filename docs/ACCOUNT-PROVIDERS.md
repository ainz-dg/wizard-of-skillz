# Account-backed local CLI providers (experimental)

Wizard can reuse an **already installed and authenticated** local CLI. Wizard
never accepts account passwords, exports tokens, or implements an OAuth flow.

These are independent of Wizard's OpenAI-compatible API-key provider:
- codex-account uses the unmodified OpenAI Codex CLI, signed in with a supported ChatGPT account.
- claude-code-account calls the unmodified Claude Code CLI only after end-user authentication.

## Check your own local installation

The examples below invoke the published npm release with `npx`. Run them on a trusted machine where the official provider CLI is already installed and signed in.

    codex login
    npx --yes wizard-of-skillz@next doctor --llm-provider codex-account
    npx --yes wizard-of-skillz@next probe --llm-provider codex-account

For Claude Code:

    claude auth login
    npx --yes wizard-of-skillz@next doctor --llm-provider claude-code-account
    npx --yes wizard-of-skillz@next probe --llm-provider claude-code-account

Wizard passes Codex's global approval flag before `exec` and uses a read-only
sandbox, without granting extra permissions. In the TUI, choose an optional
Codex model ID or leave it empty to use the installed CLI's default. Wizard
does not offer Codex model discovery; use the official CLI to identify IDs.

Codex runs exec in an isolated temporary working directory with a read-only
sandbox and no repository checkout. Codex retains its built-in read-only tools;
the wrapper does not grant writes but cannot promise filesystem read isolation
outside that sandbox. Claude Code runs with built-in and MCP tools disabled,
no session persistence and no custom skills. Both receive only the explicit
Wizard prompt, not the full repository by default.

**Provider policy:** an authenticated session is not a guarantee of entitlement
or free usage. Anthropic restricts third-party apps from collecting or
intermediating consumer subscription credentials. Wizard neither offers
Claude.ai login nor operates a credential relay; users must run the official,
unmodified binary directly under their own account and applicable terms.
Do not deploy an intermediary that runs other users' subscription credentials.

This integration does not embed Sign in with ChatGPT (SIWC); instead it uses
the documented local Codex CLI authenticated via the user account. A native
SIWC integration can follow when its SDK deployment is verified.

The transport does not grant filesystem write permissions. Claude tools are
disabled; Codex remains limited to its read-only sandbox. It does NOT imply that model output or any requested
change is automatically authorized.

Provider login/probe against real accounts are not exercised in public CI
because CI has no user account. Validate manually on a machine with the
official CLI installed before describing either as fully supported.
