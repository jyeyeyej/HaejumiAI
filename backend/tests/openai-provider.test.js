import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider } from '../src/application/openai-provider.js';
import { LLMGateway } from '../src/application/llm-gateway.js';
import { PrivacyGate } from '../src/security/privacy-gate.js';
import { CreatorAgent } from '../src/agents/creator-agent.js';

const planResult = { plan: { title_idea: '카페', format: 'vertical_short', aspect_ratio: '9:16', target_seconds: 30, scenes: [] }, captions: [] };

test('OpenAI adapter uses Responses JSON output, selected image data, no storage, and a bounded timeout', async () => {
  let seen = null;
  const provider = new OpenAIProvider({ apiKey: 'synthetic-only-test-key', model: 'test-model', timeoutMs: 2500, estimatedCostUsd: 0.02,
    fetchImpl: async (url, init) => {
      seen = { url, init, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(planResult) }] }] }) };
    } });
  const result = await provider.generateStructured({ prompt: 'Return structured scene data', input: { request: '귀여운 카페 쇼츠', target_seconds: 30,
    media: [{ media_id: 'selected-media-1', media_type: 'image/png', image_data_url: 'data:image/png;base64,c3ludGhldGlj' }] } });
  assert.deepEqual(result, planResult);
  assert.equal(seen.url, 'https://api.openai.com/v1/responses');
  assert.equal(seen.init.headers.Authorization, 'Bearer synthetic-only-test-key');
  assert.equal(seen.body.store, false);
  assert.equal(seen.body.max_output_tokens, 2500);
  assert.equal(seen.body.input[0].content.some((item) => item.type === 'input_image' && item.image_url.includes('c3ludGhldGlj')), true);
  assert.match(seen.body.input[0].content[0].text, /selected-media-1/);
  assert.match(seen.body.input[0].content[0].text, /visual_input_available/);
  assert.equal(seen.init.signal instanceof AbortSignal, true);
});

test('OpenAI network dispatch stays at zero when consent is absent or revoked', async () => {
  let dispatches = 0; let consentActive = false;
  const provider = { providerId: 'openai', mode: 'external', estimateCostUsd: async () => 0.001,
    generateStructured: async () => { dispatches += 1; return planResult; } };
  const gate = new PrivacyGate({ enabled: true, providerAllowlist: ['openai'], consentVerifier: async () => consentActive });
  const gateway = new LLMGateway({ enabled: true, provider, privacyGate: gate, limits: { dailyUsd: 1, monthlyUsd: 1, maxCallsPerTask: 2, maxRevisionsPerTask: 1 } });
  const request = { ownerId: 'owner-a', taskId: 'task-a', consentId: 'consent-a', purpose: 'vision_analysis', dataCategories: ['selected_media', 'user_text'],
    resourceIds: ['selected-media-a'], prompt: 'analyze selected image', input: { media: [{ image_data_url: 'data:image/png;base64,bW9jaw==' }] } };
  assert.equal((await gateway.generate(request)).reason, 'CONSENT_REQUIRED');
  assert.equal(dispatches, 0);
  consentActive = true;
  assert.equal((await gateway.generate(request)).available, true);
  consentActive = false;
  assert.equal((await gateway.generate({ ...request, taskId: 'task-b' })).reason, 'CONSENT_REQUIRED');
  assert.equal(dispatches, 1);
});

test('provider failures are reduced to safe errors and timeout does not retry', async () => {
  let calls = 0;
  const provider = new OpenAIProvider({ apiKey: 'synthetic-only-test-key', model: 'test-model', timeoutMs: 1000,
    fetchImpl: async () => { calls += 1; return { ok: false, status: 500, json: async () => ({ error: { message: 'secret detail' } }) }; } });
  await assert.rejects(provider.generateStructured({ prompt: 'test', input: { request: 'test', target_seconds: 30, media: [] } }), (error) => {
    assert.equal(error.code, 'SERVICE_UNAVAILABLE'); assert.equal(error.message, 'OpenAI request failed'); return true;
  });
  assert.equal(calls, 1);
});

test('OpenAI adapter caps visual attachments and times out without retry', async () => {
  let calls = 0; let captured = null;
  const provider = new OpenAIProvider({ apiKey: 'synthetic-only-test-key', model: 'test-model', timeoutMs: 1000, maxImages: 1,
    fetchImpl: async (_url, init) => { calls += 1; captured = JSON.parse(init.body); return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(planResult) }] }] }) }; } });
  await provider.generateStructured({ prompt: 'plan', input: { request: 'test', target_seconds: 30, media: [
    { media_id: 'one', media_type: 'image/jpeg', image_data_url: 'data:image/jpeg;base64,YQ==' },
    { media_id: 'two', media_type: 'image/jpeg', image_data_url: 'data:image/jpeg;base64,Yg==' },
  ] } });
  assert.equal(captured.input[0].content.filter((item) => item.type === 'input_image').length, 1);
  assert.equal(await provider.estimateCostUsd({ input: { media: [{ image_data_url: 'x' }, { image_data_url: 'y' }] } }), 0.01);

  let timeoutCalls = 0;
  const timeoutProvider = new OpenAIProvider({ apiKey: 'synthetic-only-test-key', model: 'test-model', timeoutMs: 1000,
    fetchImpl: async (_url, init) => { timeoutCalls += 1; return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })); } });
  await assert.rejects(timeoutProvider.generateStructured({ prompt: 'x', input: { request: 'x', target_seconds: 30, media: [] } }), (error) => error.code === 'SERVICE_UNAVAILABLE');
  assert.equal(timeoutCalls, 1);
});

test('Creator scene result is built from only selected, locally prepared media and requires scoped consent for external vision', async () => {
  let captured = null;
  const provider = { providerId: 'openai', mode: 'external', estimateCostUsd: async () => 0.001,
    generateStructured: async ({ input }) => { captured = input; return { plan: { title_idea: '카페 쇼츠', format: 'vertical_short', aspect_ratio: '9:16', target_seconds: 30,
      scenes: [{ order: 1, media_id: 'selected-image-id', media_type: 'image/jpeg', start_seconds: 0, end_seconds: 30, visual_direction: '커피와 디저트 장면', caption_text: '달콤한 카페 시간' }] },
      captions: [{ order: 1, start_seconds: 0, end_seconds: 30, text: '달콤한 카페 시간' }] }; } };
  const gateway = new LLMGateway({ enabled: true, provider, privacyGate: new PrivacyGate({ enabled: true, providerAllowlist: ['openai'], consentVerifier: async (context) =>
    context.ownerId === 'owner-a' && context.consentId === 'consent-a' && context.resourceIds.length === 1 && context.purpose === 'vision_analysis' }) });
  const agent = new CreatorAgent({ gateway });
  const result = await agent.createPlan({ ownerId: 'owner-a', taskId: 'task-a', requestText: '귀여운 카페 쇼츠', privacyConsentId: 'consent-a',
    project: { target_seconds: 30 }, media: [{ mediaId: 'selected-image-id', mediaType: 'image/jpeg', imageDataUrl: 'data:image/jpeg;base64,cHJlcGFyZWQ=' }] });
  assert.equal(captured.media.length, 1);
  assert.equal(captured.media[0].media_id, 'selected-image-id');
  assert.equal(captured.media[0].image_data_url, 'data:image/jpeg;base64,cHJlcGFyZWQ=');
  assert.equal(result.plan.scenes[0].visual_direction, '커피와 디저트 장면');
  assert.equal(result.generation.source, 'gateway');
});
