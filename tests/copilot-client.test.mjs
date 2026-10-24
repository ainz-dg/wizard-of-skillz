import test from 'node:test';
import assert from 'node:assert/strict';
import { CopilotCloudClient } from '../src/copilot-client.mjs';
import { createLlmClient, closeLlmClient } from '../src/llm-provider.mjs';

function fakeSdk(state) {
  return {
    CopilotClient: class {
      constructor(options) { state.clientOptions = options; }
      async start() { state.started = (state.started ?? 0) + 1; }
      async stop() { state.stopped = (state.stopped ?? 0) + 1; return []; }
      async getAuthStatus() {
        return { isAuthenticated: true, authType: 'user', host: 'https://github.com', login: 'tester' };
      }
      async listModels() {
        return [{
          id: 'gpt-test',
          name: 'GPT Test',
          capabilities: { supports: { reasoningEffort: true }, limits: { max_context_window_tokens: 123456 } }
        }];
      }
      async createSession(config) {
        state.sessionConfig = config;
        return {
          async sendAndWait(options, timeout) {
            state.message = options;
            state.timeout = timeout;
            return { data: { content: '```json\n{"ok":true,"source":"copilot"}\n```' } };
          },
          async disconnect() { state.disconnected = (state.disconnected ?? 0) + 1; }
        };
      }
    }
  };
}

test('CopilotCloudClient uses federated auth defaults and exposes no tools', async () => {
  const state = {};
  const client = new CopilotCloudClient({
    model: 'auto',
    timeoutMs: 4321,
    sdkLoader: async () => fakeSdk(state),
  });

  const result = await client.completeJson({ system: 'SYSTEM RULES', user: '{"task":"audit"}' });
  assert.deepEqual(result, { ok: true, source: 'copilot' });
  assert.equal(client.provider, 'copilot');
  assert.equal(client.auth, 'auto');
  assert.equal(state.clientOptions.mode, 'copilot-cli');
  assert.equal(state.clientOptions.useLoggedInUser, true);
  assert.match(state.clientOptions.baseDirectory, /\.copilot$/);
  assert.equal(state.sessionConfig.model, 'auto');
  assert.deepEqual(state.sessionConfig.availableTools, []);
  assert.equal(state.sessionConfig.enableSkills, false);
  assert.equal(state.sessionConfig.skipCustomInstructions, true);
  assert.equal(state.sessionConfig.enableHostGitOperations, false);
  assert.equal(state.sessionConfig.memory.enabled, false);
  assert.equal(state.sessionConfig.systemMessage.mode, 'customize');
  assert.equal(state.sessionConfig.systemMessage.sections.environment_context.action, 'remove');
  assert.match(state.sessionConfig.systemMessage.content, /SYSTEM RULES/);
  assert.equal(state.message.prompt, '{"task":"audit"}');
  assert.equal(state.timeout, 4321);
  assert.equal(state.disconnected, 1);

  await client.close();
  assert.equal(state.stopped, 1);
});

test('Copilot doctor verifies runtime/auth and lists available models', async () => {
  const state = {};
  const client = new CopilotCloudClient({ sdkLoader: async () => fakeSdk(state) });
  const doctor = await client.doctor();
  assert.equal(doctor.ok, true);
  assert.equal(doctor.provider, 'copilot');
  assert.equal(doctor.auth, 'auto');
  assert.equal(doctor.auth_status.authenticated, true);
  assert.equal(doctor.auth_status.type, 'user');
  assert.equal(doctor.auth_status.login, 'tester');
  assert.equal(doctor.models[0].id, 'gpt-test');
  assert.equal(doctor.models[0].reasoning, true);
  assert.equal(doctor.models[0].context_window, 123456);
  assert.match(doctor.base_directory, /\.copilot$/);
  await client.close();
});


test('Copilot doctor reports unauthenticated runtime before listing models', async () => {
  const state = {};
  const sdk = fakeSdk(state);
  sdk.CopilotClient.prototype.getAuthStatus = async () => ({
    isAuthenticated: false,
    statusMessage: 'No signed-in user',
  });
  sdk.CopilotClient.prototype.listModels = async () => {
    throw new Error('listModels should not be called');
  };

  const client = new CopilotCloudClient({ sdkLoader: async () => sdk });
  await assert.rejects(() => client.doctor(), /not authenticated.*No signed-in user/i);
  await client.close();
});

test('LLM provider defaults to Copilot and can be closed uniformly', async () => {
  const state = {};
  const client = createLlmClient({ sdkLoader: async () => fakeSdk(state) });
  assert.equal(client.provider, 'copilot');
  await client.start();
  await closeLlmClient(client);
  assert.equal(state.stopped, 1);
});

test('CopilotCloudClient times out a stuck createSession', async () => {
  const sdk = {
    CopilotClient: class {
      async start() {}
      async stop() {}
      async createSession() { return await new Promise(() => {}); }
    }
  };
  const client = new CopilotCloudClient({ timeoutMs: 20, sdkLoader: async () => sdk });
  await assert.rejects(
    () => client.completeJson({ system: 's', user: 'u' }),
    /createSession timed out/i
  );
  await client.close();
});

test('CopilotCloudClient does not hang forever on disconnect cleanup', async () => {
  const sdk = {
    CopilotClient: class {
      async start() {}
      async stop() {}
      async createSession() {
        return {
          async sendAndWait() { return { data: { content: '{"ok":true}' } }; },
          async disconnect() { return await new Promise(() => {}); }
        };
      }
    }
  };
  const client = new CopilotCloudClient({ timeoutMs: 50, sdkLoader: async () => sdk });
  const started = Date.now();
  const result = await client.completeJson({ system: 's', user: 'u' });
  assert.deepEqual(result, {ok:true});
  assert.ok(Date.now() - started < 6000);
  await client.close();
});
