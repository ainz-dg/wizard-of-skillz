# Using Ollama with Wizard of Skillz

Wizard supports `copilot` (default), `ollama` (optional), and
`openai-compatible` (custom endpoint). Ollama is **not a dependency**:
the provider reuses Wizard's existing JSON-only OpenAI-compatible transport.
No Ollama SDK, automatic model download, daemon startup, cloud account, or
Copilot authentication is required.

## Local Ollama

Start your normal Ollama service and install a model using Ollama itself.
See `ollama list` for model names. Then:

```sh
wizard doctor --llm-provider ollama
wizard probe --llm-provider ollama --llm-model <installed-model-name>
```

The default endpoint is `http://127.0.0.1:11434/v1`. `doctor`
queries `GET /api/tags` and lists the names the server reports; it works
**without** a selected model. `probe` sends one actual JSON completion
request. The selected model name is required for inference. Wizard will
not guess a model, silently pull one, or claim that `doctor` proves
the model's output quality. `model_available` from `doctor` is an
informational match against listed models, not an inference test.

Copilot works the same way: press L → 1, accept `auto`,
enter a specific model ID, or press TAB to ask Copilot for the models
available to your signed-in account. Provider/model discovery is not a
generation request.

## Selecting Ollama inside Wizard

Start `wizard` or `wizard scan .`, press **L** and select **2**
for local Ollama or **3** for a remote server. For remote, enter
`http(s)://host:port/v1`; then choose a model by typing its name
or pressing **TAB** to list models from that server. The active
provider/model appears in the status line. Only **M** on an UPDATE
sends a generation request; **G → Y** is still separate approval
for applying any source change.

No provider call occurs on startup or merely choosing the provider.
TAB deliberately contacts `/api/tags` for model discovery.
Provider selection is session-only and never written to repository
or review-session artifacts. CLI flags still work.

## Drafting in the TUI

```sh
wizard scan . --llm --llm-provider ollama --llm-model <installed-model-name>
# Navigate to an UPDATE proposal and press M to request a draft.
# Review the resulting diff. G then Y are still required before Apply.
```

Or use an existing audit with:

```sh
wizard tui /path/to/audit --consumer-root /path/to/project \
  --llm --llm-provider ollama --llm-model <installed-model-name>
```

Or generate a candidate without opening the TUI:

```sh
wizard prepare-update /path/to/audit --consumer-root /path/to/project \
  --proposal <proposal-id> --llm --llm-provider ollama \
  --llm-model <installed-model-name>
```

The same provider choice works for Wizard's other `--llm` workflows.
Calling `scan` alone is offline and never starts the LLM.
Pressing **L** selects a provider, and **M** is the explicit generation request.
Generated content is untrusted and **never authorizes Apply**.

## Ollama on another machine

Supply the *explicit* server URL:

```sh
wizard doctor --llm-provider ollama \
  --llm-url http://your-ollama-host:11434/v1

wizard probe --llm-provider ollama \
  --llm-url http://your-ollama-host:11434/v1 \
  --llm-model <available-model-name>
```

The server root `http://your-ollama-host:11434` is also accepted.
Only use a remote endpoint you trust: the selected repository evidence
and skill content **leave the local computer** when M is invoked.
A model routed to a cloud backend by Ollama may likewise not be local.
For gateways requiring a token, set `WIZARD_OLLAMA_API_KEY` explicitly.
Ordinary local Ollama does not need it. The generic
`WIZARD_LLM_API_KEY` is **not automatically forwarded** to Ollama.

Environment equivalents:

```sh
export WIZARD_LLM_PROVIDER=ollama
export WIZARD_LLM_MODEL=<installed-model-name>
# optional:
export WIZARD_LLM_BASE_URL=http://127.0.0.1:11434/v1
export WIZARD_LLM_TIMEOUT_MS=120000
export WIZARD_LLM_JSON_MODE=true
```

Ollama JSON mode is enabled by default for this provider; opt out by
setting `WIZARD_LLM_JSON_MODE=false` if a particular model/server
does not support it. Model competence and latency remain model-dependent.

## Compatibility and limits

- Existing Copilot federated authentication and its `auto` model remain
  unchanged.
- `openai-compatible` remains a separate generic provider; you can
  continue using it directly.
- `doctor` checks Ollama server connectivity and enumerates models;
  `probe` exercises inference. Neither modifies repository source.
- Wizard does not promise that any LLM draft is semantically correct:
  review the preview, resolve unsupported source facts, and explicitly
  confirm before applying changes.
