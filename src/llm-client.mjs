function trimSlash(s) { return String(s ?? '').replace(/\/+$/, ''); }

export function parseJsonContent(text) {
  if (typeof text !== 'string') throw new Error('LLM returned non-text content');
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch {}
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1));
  }
  throw new Error('LLM response does not contain valid JSON');
}

export class OpenAICompatibleClient {
  constructor({
    baseUrl,
    apiKey = null,
    model,
    timeoutMs = 120000,
    temperature = 0,
    jsonMode = false,
    fetchImpl = globalThis.fetch
  }) {
    if (!baseUrl) throw new Error('missing LLM baseUrl');
    if (!model) throw new Error('missing LLM model');
    if (!fetchImpl) throw new Error('fetch is not available');
    this.provider = 'openai-compatible';
    this.auth = apiKey ? 'api-key' : 'none';
    this.baseUrl = trimSlash(baseUrl);
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.temperature = temperature;
    this.jsonMode = jsonMode;
    this.fetchImpl = fetchImpl;
  }

  endpoint() {
    if (/\/chat\/completions$/i.test(this.baseUrl)) return this.baseUrl;
    return `${this.baseUrl}/chat/completions`;
  }

  async completeJson({ system, user }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const body = {
      model: this.model,
      temperature: this.temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    };
    if (this.jsonMode) body.response_format = { type: 'json_object' };

    try {
      const res = await this.fetchImpl(this.endpoint(), {
        method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${raw.slice(0, 800)}`);
      let payload;
      try { payload = JSON.parse(raw); }
      catch { throw new Error(`LLM endpoint returned invalid JSON envelope: ${raw.slice(0, 500)}`); }
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('LLM envelope missing choices[0].message.content');
      return parseJsonContent(content);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function clientFromEnv(overrides = {}) {
  return new OpenAICompatibleClient({
    baseUrl: overrides.baseUrl ?? process.env.WIZARD_LLM_BASE_URL ?? 'http://127.0.0.1:11434/v1',
    apiKey: overrides.apiKey ?? process.env.WIZARD_LLM_API_KEY ?? null,
    model: overrides.model ?? process.env.WIZARD_LLM_MODEL,
    timeoutMs: Number(overrides.timeoutMs ?? process.env.WIZARD_LLM_TIMEOUT_MS ?? 120000),
    temperature: Number(overrides.temperature ?? process.env.WIZARD_LLM_TEMPERATURE ?? 0),
    jsonMode: overrides.jsonMode ?? /^(1|true|yes)$/i.test(process.env.WIZARD_LLM_JSON_MODE ?? '')
  });
}
