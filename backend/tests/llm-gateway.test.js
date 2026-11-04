import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMGateway } from '../src/application/llm-gateway.js';
import { PrivacyGate } from '../src/security/privacy-gate.js';
import { createMockLLMProvider } from './mock-llm.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonState } from '../src/adapters/filesystem/json-state.js';

test('LLM Gateway is disabled by default and does not call a configured provider', async () => {
  const provider = createMockLLMProvider();
  const gateway = new LLMGateway({ provider, privacyGate: new PrivacyGate() });
  const result = await gateway.generate({ taskId: 'task', prompt: 'test', input: {} });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'llm_disabled');
  assert.equal(provider.calls, 0);
});

test('Mock provider cannot bypass PrivacyGate outside the explicit test harness', async () => {
  const provider = createMockLLMProvider();
  const gateway = new LLMGateway({ enabled: true, provider, privacyGate: new PrivacyGate() });
  const result = await gateway.generate({ taskId: 'task', prompt: 'mock', input: {} });
  assert.equal(result.reason, 'CONSENT_REQUIRED');
  assert.equal(provider.calls, 0);
});

test('external provider is blocked before dispatch without allowlist and verified consent', async () => {
  let outboundCalls = 0;
  const provider = { mode: 'openai', providerId: 'openai', async estimateCostUsd() { return 0.001; }, async generateStructured() { outboundCalls += 1; return {}; } };
  const gateway = new LLMGateway({ enabled: true, provider, privacyGate: new PrivacyGate({ enabled: true, providerAllowlist: ['openai'] }) });
  const result = await gateway.generate({ taskId: 'task', prompt: 'personal', input: {}, dataCategories: ['user_text'] });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'CONSENT_REQUIRED');
  assert.equal(outboundCalls, 0);
  assert.equal(gateway.usage.dailyUsd, 0);
});

test('mock provider uses the Gateway budget and per-task call limit', async () => {
  const provider = createMockLLMProvider();
  const gateway = new LLMGateway({ enabled: true, allowMockProvider: true, provider, privacyGate: new PrivacyGate(),
    limits: { dailyUsd: 1, monthlyUsd: 1, maxCallsPerTask: 1, maxRevisionsPerTask: 1 } });
  const request = { taskId: 'task-1', prompt: 'mock', input: {} };
  assert.equal((await gateway.generate(request)).available, true);
  const blocked = await gateway.generate(request);
  assert.equal(blocked.available, false);
  assert.equal(blocked.reason, 'LLM_BUDGET_EXCEEDED');
  assert.equal(provider.calls, 1);
});

test('mock revisions respect the configured per-task revision cap', async () => {
  const provider = createMockLLMProvider();
  const gateway = new LLMGateway({ enabled: true, allowMockProvider: true, provider, privacyGate: new PrivacyGate(),
    limits: { dailyUsd: 1, monthlyUsd: 1, maxCallsPerTask: 5, maxRevisionsPerTask: 1 } });
  const request = { taskId: 'task-2', revision: true, prompt: 'revise', input: {} };
  assert.equal((await gateway.generate(request)).available, true);
  const blocked = await gateway.generate(request);
  assert.equal(blocked.reason, 'LLM_BUDGET_EXCEEDED');
  assert.equal(provider.calls, 1);
});

test('daily budget reservation survives Gateway recreation and blocks further calls', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'haejumi-llm-budget-'));
  const state = new JsonState(join(dir, 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const firstProvider = createMockLLMProvider();
  const limits = { dailyUsd: 0.001, monthlyUsd: 1, maxCallsPerTask: 5, maxRevisionsPerTask: 3 };
  const first = new LLMGateway({ enabled: true, allowMockProvider: true, provider: firstProvider, privacyGate: new PrivacyGate(), limits, state });
  assert.equal((await first.generate({ taskId: 'task-a', prompt: 'mock', input: {} })).available, true);
  const secondProvider = createMockLLMProvider();
  const second = new LLMGateway({ enabled: true, allowMockProvider: true, provider: secondProvider, privacyGate: new PrivacyGate(), limits, state });
  const blocked = await second.generate({ taskId: 'task-b', prompt: 'mock', input: {} });
  assert.equal(blocked.reason, 'LLM_BUDGET_EXCEEDED');
  assert.equal(secondProvider.calls, 0);
});

test('monthly cost ceiling blocks new tasks after the monthly reservation is exhausted', async () => {
  const provider = createMockLLMProvider();
  const limits = { dailyUsd: 1, monthlyUsd: 0.001, maxCallsPerTask: 5, maxRevisionsPerTask: 3 };
  const gateway = new LLMGateway({ enabled: true, allowMockProvider: true, provider, privacyGate: new PrivacyGate(), limits });
  assert.equal((await gateway.generate({ taskId: 'task-a', prompt: 'mock', input: {} })).available, true);
  assert.equal((await gateway.generate({ taskId: 'task-b', prompt: 'mock', input: {} })).reason, 'LLM_BUDGET_EXCEEDED');
  assert.equal(provider.calls, 1);
});

test('failed provider attempt keeps reserved cost and safe HTTP diagnostics while consent denial reserves nothing', async () => {
  let allowed = false; let calls = 0;
  const provider = { mode: 'external', providerId: 'openai', estimateCostUsd: async () => 0.05,
    generateStructured: async () => { calls += 1; throw Object.assign(new Error('private provider body'),
      { code: 'OPENAI_AUTH_FAILED', httpStatus: 401, providerRequestId: 'req_safe_123' }); } };
  const gateway = new LLMGateway({ enabled: true, provider, privacyGate: new PrivacyGate({ enabled: true,
    providerAllowlist: ['openai'], consentVerifier: async () => allowed }), limits: { dailyUsd: 2, monthlyUsd: 20 } });
  const request = { ownerId: 'owner', taskId: 'task', consentId: 'consent', purpose: 'vision_analysis', dataCategories: ['selected_media'],
    resourceIds: ['selected'], prompt: 'JSON', input: {} };
  const denied = await gateway.generate(request);
  assert.equal(denied.reason, 'CONSENT_REQUIRED'); assert.equal(denied.usage.calls_for_task, 0); assert.equal(calls, 0);
  allowed = true;
  const failed = await gateway.generate(request);
  assert.equal(failed.reason, 'OPENAI_AUTH_FAILED'); assert.equal(failed.usage.calls_for_task, 1);
  assert.equal(failed.usage.estimated_cost_usd, 0.05); assert.equal(gateway.usage.dailyUsd, 0.05);
  assert.deepEqual(failed.diagnostic, { provider_http_status: 401, provider_request_id: 'req_safe_123' });
  assert.equal(calls, 1);
});
