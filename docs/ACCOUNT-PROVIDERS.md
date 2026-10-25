# Account-backed local CLI providers (experimental)

Wizard can reuse an **already installed and authenticated** local CLI. Wizard
never accepts account passwords, exports tokens, or implements an OAuth flow.

These are independent of Wizard's OpenAI-compatible API-key provider:
- codex-account uses the unmodified OpenAI Codex CLI, signed in with a supported ChatGPT account.
- claude-code-account calls the unmodified Claude Code CLI only after end-user authentication.

## Check your own local installation

    codex login
    node bin/wizard.mjs doctor --llm-provider codex-account
    node bin/wizard.mjs probe --llm-provider codex-account

For Claude Code:

    claude auth login
    node bin/wizard.mjs doctor --llm-provider claude-code-account
    node bin/wizard.mjs probe --llm-provider claude-code-account

Codex runs exec in an isolated temporary working directory with a read-only
sandbox and no repository checkout. Claude Code runs with builtin tools and MCP
tools disabled, no session persistence and no custom skills. Both get only the
explicit Wizard prompt, not the full repository by default.

**Provider policy:** an authenticated session is not a guarantee of entitlement
or free usage. Anthropic restricts third-party apps from collecting or
intermediating consumer subscription credentials. Wizard neither offers
Claude.ai login nor operates a credential relay; users must run the official,
unmodified binary directly under their own account and applicable terms.
Do not deploy an intermediary that runs other users' subscription credentials.

This integration does not embed Sign in with ChatGPT (SIWC); instead it uses
the documented local Codex CLI authenticated via the user account. A native
SIWC integration can follow when its SDK deployment is verified.

The transport deliberately does not grant filesystem write permissions or
tools during inference. It does NOT imply that model output or any requested
change is automatically authorized.

Provider login/probe against real accounts are not exercised in public CI
because CI has no user account. Validate manually on a machine with the
official CLI installed before describing either as fully supported.
