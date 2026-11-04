import test from 'node:test';
import assert from 'node:assert/strict';
import { visionAvailability } from '../src/vision-availability.js';

test('Vision button readiness distinguishes live switch from configured LLM', () => {
  const off = visionAvailability({ enabled: false, provider_ready: false, availability_reason: 'LIVE_SWITCH_OFF' });
  assert.equal(off.ready, false);
  assert.match(off.message, /HAEJUMI_OPENAI_LIVE_ENABLED/);
  const ready = visionAvailability({ enabled: true, provider_ready: true, availability_reason: 'READY' });
  assert.equal(ready.ready, true);
  assert.match(ready.message, /동의 후 버튼/);
});
