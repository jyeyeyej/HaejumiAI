import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonState } from '../src/adapters/filesystem/json-state.js';
import { PersonalRecords } from '../src/adapters/filesystem/personal-records.js';
import { createApiHandler } from '../src/adapters/node-http/transport.js';
import { createDefaultCapabilityRegistry } from '../src/agents/capability-registry.js';
import { SupervisorRouter } from '../src/agents/supervisor-router.js';

test('free talk, feelings, Creator and three record Agents stay separate with local history and Mock AI', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'haejumi-talk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new JsonState(join(dir, 'state.json'));
  const personal = new PersonalRecords(state);
  const taskId = randomUUID(); let aiCalls = 0; let plans = 0;
  const registry = createDefaultCapabilityRegistry();
  const repositories = { state, async withIdempotentResponse(_owner, _scope, _key, _fingerprint, action) { return action(); },
    getOwnedTask(owner, id) { return owner === 'owner' && id === taskId ? { task_id: id } : null; },
    getOwnedCreatorContext(owner, id) { return owner === 'owner' && id === taskId ? { task: { current_version: 1 } } : null; },
    async createCreatorPlan(_owner, id) { plans++; return { task_id: id, content_version: 2, content_hash: 'a'.repeat(64), plan: { title_idea: '합성 쇼츠' },
      checkpoint: { checkpoint_id: randomUUID() }, generation: { fallback_used: true } }; } };
  const server = createServer(createApiHandler({ repositories, auth: { async authenticate(value) { return value === 'Bearer synthetic' ? { ownerId: 'owner' } :
    value === 'Bearer synthetic-other' ? { ownerId: 'other' } : null; } },
    creatorAgent: {}, supervisorRouter: new SupervisorRouter(registry), capabilityRegistry: registry,
    llmGateway: { enabled: true, provider: { mode: 'mock' }, async generate() { aiCalls++; return { available: true,
      output: { module_id: 'conversation', reply: '그 이야기를 조금 더 들려주시겠어요?' } }; } } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const post = async (text, extra = {}) => {
    const response = await fetch(`${base}/assistant/messages`, { method: 'POST', headers: { authorization: 'Bearer synthetic',
      'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ text, ...extra }) });
    assert.equal(response.status, 202); return response.json();
  };
  const talk = await post('안녕하세요, 오늘은 그냥 이야기하고 싶어요');
  assert.equal(talk.status, 'conversation'); assert.equal(talk.route, 'conversation'); assert.equal(aiCalls, 0);
  const feelings = await post('오늘 기분이 안 좋아요');
  assert.equal(feelings.status, 'conversation'); assert.equal(personal.list('wellnessEntries', 'owner').items.length, 0);
  assert.equal(personal.list('diaryEntries', 'owner').items.length, 0);
  const aiTalk = await post('오늘 무슨 이야기를 나누면 좋을까요?', { privacy_consent_id: randomUUID() });
  assert.equal(aiTalk.interpretation.source, 'mock'); assert.equal(aiCalls, 1);
  const creatorNoProject = await post('사진으로 쇼츠를 만들어 주세요');
  assert.equal(creatorNoProject.status, 'needs_project');
  const creator = await post('사진으로 쇼츠를 만들어 주세요', { task_id: taskId });
  assert.equal(creator.route, 'creator'); assert.equal(plans, 1);
  const schedule = await post('일정 등록 2026-11-06 15:00 16:00 독서 모임');
  const wellness = await post('기분 기록 2026-11-06 보통');
  const diary = await post('일기 초안 2026-11-06 오늘은 독서 모임을 준비했다');
  assert.deepEqual([schedule.actions[0].kind, wellness.actions[0].kind, diary.actions[0].kind],
    ['schedule_create', 'wellness_create', 'diary_create']);
  const multi = await post('일정 등록 2026-11-06 15:00 16:00 독서 모임; 기분 기록 2026-11-06 좋음');
  assert.equal(multi.actions.length, 2);
  assert.equal(personal.list('scheduleEvents', 'owner').items.length, 0);
  assert.equal(personal.list('wellnessEntries', 'owner').items.length, 0);
  assert.equal(personal.list('diaryEntries', 'owner').items.length, 0);
  const history = await (await fetch(`${base}/assistant/history`, { headers: { authorization: 'Bearer synthetic' } })).json();
  assert.equal(history.items.length, 9);
  const otherHistory = await (await fetch(`${base}/assistant/history`, { headers: { authorization: 'Bearer synthetic-other' } })).json();
  assert.equal(otherHistory.items.length, 0);
  assert.equal((await fetch(`${base}/assistant/history`, { method: 'DELETE', headers: {
    authorization: 'Bearer synthetic', 'idempotency-key': randomUUID() } })).status, 204);
  assert.equal((await (await fetch(`${base}/assistant/history`, { headers: { authorization: 'Bearer synthetic' } })).json()).items.length, 0);
});
