import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLlmAvailability } from '../src/config/llm-availability.js';

test('Vision readiness requires both switches and provider configuration', () => {
  assert.deepEqual(resolveLlmAvailability({ llmRequested: true, liveEnabled: false, keyConfigured: true, modelConfigured: true }),
    { enabled: false, reason: 'LIVE_SWITCH_OFF' });
  assert.deepEqual(resolveLlmAvailability({ llmRequested: false, liveEnabled: true, keyConfigured: true, modelConfigured: true }),
    { enabled: false, reason: 'LLM_SWITCH_OFF' });
  assert.deepEqual(resolveLlmAvailability({ llmRequested: true, liveEnabled: true, keyConfigured: false, modelConfigured: true }),
    { enabled: false, reason: 'PROVIDER_CONFIG_MISSING' });
  assert.deepEqual(resolveLlmAvailability({ llmRequested: true, liveEnabled: true, keyConfigured: true, modelConfigured: true }),
    { enabled: true, reason: 'READY' });
});
