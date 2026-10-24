import os from 'node:os';
import path from 'node:path';
import { parseJsonContent } from './llm-client.mjs';

function compactError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim();
}

function withTimeout(promise, timeoutMs, label) {
  const ms = Number(timeoutMs || 0);
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class CopilotCloudClient {
  constructor({
    model = 'auto',
    timeoutMs = 120000,
    reasoningEffort = null,
    sdkLoader = () => import('@github/copilot-sdk'),
    baseDirectory = process.env.WIZARD_COPILOT_HOME || process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'),
    progress = null
  } = {}) {
    this.provider = 'copilot';
    this.auth = 'auto';
    this.model = model || 'auto';
    this.timeoutMs = Number(timeoutMs || 120000);
    this.reasoningEffort = reasoningEffort || null;
    this.sdkLoader = sdkLoader;
    this.baseDirectory = baseDirectory;
    this.progress = typeof progress === 'function' ? progress : () => {};
    this._client = null;
    this._started = false;
  }

  async _ensureClient() {
    if (this._client) return this._client;
    let sdk;
    try {
      sdk = await this.sdkLoader();
    } catch (error) {
      throw new Error(`GitHub Copilot SDK is not installed. Run npm install. (${compactError(error)})`);
    }
    const { CopilotClient } = sdk ?? {};
    if (typeof CopilotClient !== 'function') {
      throw new Error('Invalid @github/copilot-sdk installation: CopilotClient export not found.');
    }

    // Empty mode deliberately disables ambient tools, skills and host context.
    // Wizard supplies every evidence snippet itself and keeps repository access read-only.
    this._client = new CopilotClient({
      // Use normal copilot-cli mode so the runtime may reuse the signed-in user's
      // OAuth/keychain credentials. `mode: 'empty'` intentionally disables keytar
      // and therefore cannot reuse the normal interactive Copilot login.
      mode: 'copilot-cli',
      baseDirectory: this.baseDirectory,
      useLoggedInUser: true,
    });
    return this._client;
  }

  async start() {
    const client = await this._ensureClient();
    if (!this._started) {
      try {
        this.progress('copilot:start', { model: this.model });
        await withTimeout(client.start(), this.timeoutMs, 'Copilot client.start');
        this.progress('copilot:started', { model: this.model });
        this._started = true;
      } catch (error) {
        throw new Error(
          `Copilot authentication/runtime start failed. Sign in with the Copilot CLI and retry. (${compactError(error)})`
        );
      }
    }
    return client;
  }

  async completeText({ system, user }) {
    const client = await this.start();
    let session;
    try {
      this.progress('copilot:create-session', { model: this.model });
      session = await withTimeout(client.createSession({
        model: this.model,
        ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
        // Reproduce the security-relevant empty-mode defaults at session scope
        // while keeping client auth in normal copilot-cli mode.
        availableTools: [],
        includedBuiltinSkills: [],
        enableSkills: false,
        enableConfigDiscovery: false,
        skipCustomInstructions: true,
        enableOnDemandInstructionDiscovery: false,
        enableFileHooks: false,
        enableHostGitOperations: false,
        enableSessionStore: false,
        enableSessionTelemetry: false,
        enableExperimentalMode: false,
        skipEmbeddingRetrieval: true,
        embeddingCacheStorage: 'in-memory',
        memory: { enabled: false },
        customAgentsLocalOnly: true,
        coauthorEnabled: false,
        manageScheduleEnabled: false,
        remoteSession: 'off',
        systemMessage: {
          mode: 'customize',
          content: system,
          sections: {
            environment_context: { action: 'remove' },
          },
        },
      }), this.timeoutMs, 'Copilot createSession');
      this.progress('copilot:session-created', { model: this.model });
      this.progress('copilot:send', { bytes: Buffer.byteLength(user, 'utf8') });
      const response = await withTimeout(
        session.sendAndWait({ prompt: user }, this.timeoutMs),
        this.timeoutMs + 5000,
        'Copilot sendAndWait outer guard'
      );
      this.progress('copilot:response', { model: this.model });
      const content = response?.data?.content;
      if (typeof content !== 'string') {
        throw new Error('Copilot returned no assistant text response.');
      }
      return content;
    } finally {
      if (session?.disconnect) {
        this.progress('copilot:disconnect', {});
        try { await withTimeout(session.disconnect(), 5000, 'Copilot session.disconnect'); } catch {}
      }
    }
  }

  async completeJson({system,user}) {
    const content = await this.completeText({
      system:`${system}\n\nReturn machine-readable JSON only.`, user
    });
    return parseJsonContent(content);
  }

  async doctor() {
    const client = await this.start();

    let authStatus = null;
    try {
      if (typeof client.getAuthStatus === 'function') {
        authStatus = await client.getAuthStatus();
      }
    } catch (error) {
      throw new Error(`Copilot runtime started, but auth status could not be read. (${compactError(error)})`);
    }

    if (authStatus && authStatus.isAuthenticated === false) {
      const detail = authStatus.statusMessage ? ` ${authStatus.statusMessage}` : '';
      throw new Error(`Copilot runtime is not authenticated.${detail} Run the Copilot CLI and sign in, then retry.`);
    }

    let models = [];
    try {
      if (typeof client.listModels === 'function') {
        models = await client.listModels();
      }
    } catch (error) {
      throw new Error(`Copilot model listing failed after auth check. (${compactError(error)})`);
    }
    const normalized = Array.isArray(models) ? models.map(m => ({
      id: m?.id ?? null,
      name: m?.name ?? m?.id ?? null,
      reasoning: Boolean(m?.capabilities?.supports?.reasoningEffort),
      context_window: m?.capabilities?.limits?.max_context_window_tokens ?? null,
    })).filter(m => m.id) : [];

    return {
      ok: true,
      provider: 'copilot',
      auth: 'auto',
      auth_status: authStatus ? {
        authenticated: Boolean(authStatus.isAuthenticated),
        type: authStatus.authType ?? null,
        host: authStatus.host ?? null,
        login: authStatus.login ?? null,
        message: authStatus.statusMessage ?? null,
      } : null,
      requested_model: this.model,
      base_directory: this.baseDirectory,
      models: normalized,
    };
  }

  async close() {
    if (!this._client) return;
    if (this._started && typeof this._client.stop === 'function') {
      try { await withTimeout(this._client.stop(), 5000, 'Copilot client.stop'); } catch {}
    }
    this._client = null;
    this._started = false;
  }
}
