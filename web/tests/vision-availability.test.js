import test from 'node:test';
import assert from 'node:assert/strict';
import { visionAvailability, visionGenerationMessage } from '../src/vision-availability.js';

test('Vision button readiness distinguishes live switch from configured LLM', () => {
  const off = visionAvailability({ enabled: false, provider_ready: false, availability_reason: 'LIVE_SWITCH_OFF' });
  assert.equal(off.ready, false);
  assert.match(off.message, /HAEJUMI_OPENAI_LIVE_ENABLED/);
  const ready = visionAvailability({ enabled: true, provider_ready: true, availability_reason: 'READY' });
  assert.equal(ready.ready, true);
  assert.match(ready.message, /동의 후 버튼/);
});

test('Vision generation status distinguishes provider output from budget and validation fallbacks', () => {
  assert.match(visionGenerationMessage({ source: 'gateway', fallback_used: false }), /OpenAI Vision 기획안/);
  assert.match(visionGenerationMessage({ source: 'gateway', fallback_used: true }), /부분 반영/);
  assert.match(visionGenerationMessage({ source: 'local_rules', gate_reason: 'LLM_BUDGET_EXCEEDED', llm_calls: 0 }), /전송되지 않았습니다/);
  assert.match(visionGenerationMessage({ source: 'local_rules', gate_reason: 'INVALID_MODEL_OUTPUT' }), /검증을 통과하지 못했습니다/);
  assert.match(visionGenerationMessage({ source: 'local_rules', gate_reason: 'SERVICE_UNAVAILABLE' }), /전송 여부는 확인되지 않습니다/);
  assert.match(visionGenerationMessage({ source: 'local_rules', gate_reason: 'OPENAI_AUTH_FAILED' }), /인증 또는 권한 오류/);
  assert.match(visionGenerationMessage({ source: 'local_rules', gate_reason: 'OPENAI_REQUEST_INVALID' }), /요청 형식/);
  assert.match(visionGenerationMessage({ source: 'local_rules', gate_reason: 'OPENAI_TIMEOUT' }), /자동 재시도하지 않았습니다/);
});
