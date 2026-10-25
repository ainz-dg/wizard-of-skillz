import { clientFromEnv as openAICompatibleFromEnv } from './llm-client.mjs';
import { CopilotCloudClient } from './copilot-client.mjs';
import { OllamaClient } from './ollama-client.mjs';
import { AccountCliClient } from './account-cli-client.mjs';

function boolEnv(value) {
  return /^(1|true|yes)$/i.test(String(value ?? ''));
}

export function createLlmClient(overrides = {}) {
  const provider = overrides.provider ?? process.env.WIZARD_LLM_PROVIDER ?? 'copilot';
  const model = overrides.model ?? process.env.WIZARD_LLM_MODEL ?? (provider === 'copilot' ? 'auto' : undefined);
  const timeoutMs = Number(overrides.timeoutMs ?? process.env.WIZARD_LLM_TIMEOUT_MS ?? 120000);

  if (provider === 'codex-account' || provider === 'claude-code-account') {
    return new AccountCliClient({
      provider,model,timeoutMs,run:overrides.cliRun
    });
  }

  if (provider === 'copilot') {
    return new CopilotCloudClient({
      model,
      timeoutMs,
      reasoningEffort: overrides.reasoningEffort ?? process.env.WIZARD_LLM_REASONING_EFFORT ?? null,
      sdkLoader: overrides.sdkLoader,
      progress: overrides.progress,
    });
  }

  if (provider === 'ollama') {
    return new OllamaClient({
      baseUrl: overrides.baseUrl ?? process.env.WIZARD_LLM_BASE_URL ?? 'http://127.0.0.1:11434/v1',
      model,
      timeoutMs,
      temperature: overrides.temperature ?? Number(process.env.WIZARD_LLM_TEMPERATURE ?? 0),
      jsonMode: overrides.jsonMode ??
        (process.env.WIZARD_LLM_JSON_MODE===undefined?true:
          boolEnv(process.env.WIZARD_LLM_JSON_MODE)),
      apiKey: overrides.apiKey ?? process.env.WIZARD_OLLAMA_API_KEY ?? null,
      fetchImpl: overrides.fetchImpl
    });
  }

  if (provider === 'openai-compatible') {
    return openAICompatibleFromEnv({
      baseUrl: overrides.baseUrl,
      apiKey: overrides.apiKey,
      model,
      timeoutMs,
      temperature: overrides.temperature,
      jsonMode: overrides.jsonMode ?? boolEnv(process.env.WIZARD_LLM_JSON_MODE),
    });
  }

  throw new Error(`unsupported LLM provider: ${provider}`);
}

export async function closeLlmClient(client) {
  if (client && typeof client.close === 'function') await client.close();
}
