import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultCapabilityRegistry } from '../src/agents/capability-registry.js';
import { SupervisorRouter } from '../src/agents/supervisor-router.js';

test('Capability Registry keeps core modules and disabled extensions independently extensible', () => {
  const registry = createDefaultCapabilityRegistry();
  const creatorBefore = registry.get('creator');
  registry.register({ module_id: 'travel', agent_name: 'Travel Agent', module_version: '1.0.0', status: 'planned',
    implementation_status: 'registered', capability_ids: ['travel.plan'], scopes: [], input_schema_version: '1' });
  assert.deepEqual(registry.get('creator'), creatorBefore);
  assert.equal(registry.resolveCapability('travel.plan').module_id, 'travel');
  assert.equal(registry.get('blog').status, 'disabled');
  assert.equal(registry.get('music').status, 'disabled');
  assert.throws(() => registry.register({ ...creatorBefore }), /already registered/);
});

test('Supervisor routes unique intents and asks for clarification on ambiguity or unknown requests', () => {
  const router = new SupervisorRouter(createDefaultCapabilityRegistry());
  assert.deepEqual(router.route('여행 사진으로 쇼츠 기획해줘').module_id, 'creator');
  assert.equal(router.route('내일 일정 확인해줘').status, 'not_implemented');
  assert.equal(router.route('수면 기록 정리해줘').module_id, 'wellness');
  assert.equal(router.route('오늘 일기 써줘').module_id, 'diary');
  assert.equal(router.route('오늘 일정 정리해서 일기 써줘').status, 'needs_clarification');
  assert.equal(router.route('블로그 포스팅 작성해줘').status, 'disabled');
  assert.equal(router.route('안녕하세요').status, 'needs_clarification');
});
