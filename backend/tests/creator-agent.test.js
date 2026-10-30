import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorAgent } from '../src/agents/creator-agent.js';

test('Creator local fallback fits every selected media item into short target durations', async () => {
  let gatewayCalls = 0;
  const agent = new CreatorAgent({ gateway: { async generate() { gatewayCalls += 1; return { available: false, reason: 'llm_disabled', usage: { calls_for_task: 0, estimated_cost_usd: 0 } }; } } });
  const media = Array.from({ length: 8 }, (_, index) => ({ mediaId: `media-${index}`, mediaType: 'image/png' }));
  const result = await agent.createPlan({ taskId: 'task', project: { target_seconds: 3 }, media, requestText: '짧은 쇼츠를 만들어줘' });
  assert.equal(result.plan.scenes.length, 8);
  assert.equal(result.captions.length, 8);
  assert.equal(result.plan.scenes.every((scene) => scene.end_seconds > scene.start_seconds), true);
  assert.equal(result.plan.scenes[0].start_seconds, 0);
  assert.equal(result.plan.scenes.at(-1).end_seconds, 3);
  assert.equal(result.generation.source, 'local_rules');
  assert.equal(result.generation.fallback_used, true);
  assert.equal(gatewayCalls, 1);
});
