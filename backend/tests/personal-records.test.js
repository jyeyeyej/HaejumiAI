import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { JsonState } from '../src/adapters/filesystem/json-state.js';
import { PersonalRecords } from '../src/adapters/filesystem/personal-records.js';
import { createApiHandler } from '../src/adapters/node-http/transport.js';
import { LocalAssistant } from '../src/agents/local-assistant.js';
import { LocalRepositories, PRIVACY_NOTICE_ID, PRIVACY_NOTICE_VERSION } from '../src/adapters/filesystem/repositories.js';
import { PrivacyGate } from '../src/security/privacy-gate.js';
import { LLMGateway } from '../src/application/llm-gateway.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'haejumi-personal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new PersonalRecords(new JsonState(join(dir, 'state.json')));
}
let serial = 0;
const key = () => `personal-test-key-${++serial}`;

test('schedule and wellness enforce ownership, version and idempotency', (t) => {
  const records = fixture(t);
  const eventInput = { title: '산책', start_at: '2026-11-03T09:00:00+09:00', end_at: '2026-11-03T09:30:00+09:00',
    recurrence: { frequency: 'weekly', interval: 1, until: '2026-12-03' }, reminder_minutes: 10 };
  const requestKey = key();
  const event = records.createSchedule('a', eventInput, requestKey);
  assert.equal(records.createSchedule('a', eventInput, requestKey).event_id, event.event_id);
  assert.throws(() => records.get('scheduleEvents', 'b', event.event_id), { code: 'RESOURCE_NOT_FOUND' });
  assert.throws(() => records.editSchedule('a', event.event_id, { version: 0, title: '변경' }, key()), { code: 'VERSION_CONFLICT' });
  assert.equal(records.editSchedule('a', event.event_id, { version: 1, title: '걷기' }, key()).version, 2);
  assert.deepEqual(records.occurrences('a', '2026-11-03', '2026-11-18').items.map((x) => x.date),
    ['2026-11-03', '2026-11-10', '2026-11-17']);
  assert.equal(records.occurrences('b', '2026-11-03', '2026-11-18').items.length, 0);
  const wellness = records.createWellness('a', { date: '2026-11-03', mood: 'good', sleep_hours: 7.5, activity_minutes: 30 }, key());
  assert.equal(records.summary('a', '2026-11-01', '2026-11-07').average_sleep_hours, 7.5);
  assert.equal(records.list('wellnessEntries', 'b').items.length, 0);
  assert.throws(() => records.editWellness('a', wellness.entry_id, { version: 3, mood: 'low' }, key()), { code: 'VERSION_CONFLICT' });
  assert.equal(records.remove('wellnessEntries', 'a', wellness.entry_id, 1, key()).status, 'deleted');
  assert.equal(records.list('wellnessEntries', 'a').items.length, 0);
});

test('monthly recurrence clips short months and deleted events disappear', (t) => {
  const records = fixture(t);
  const event = records.createSchedule('a', { title: '월말 정리', start_at: '2026-01-31T09:00:00+09:00',
    end_at: '2026-01-31T10:00:00+09:00', recurrence: { frequency: 'monthly', interval: 1, until: '2026-04-30' } }, key());
  assert.deepEqual(records.occurrences('a', '2026-01-01', '2026-04-30').items.map((x) => x.date),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  records.remove('scheduleEvents', 'a', event.event_id, 1, key());
  assert.equal(records.occurrences('a', '2026-01-01', '2026-04-30').items.length, 0);
});

test('local Supervisor splits multiple requests and waits for individual confirmation', (t) => {
  const records = fixture(t);
  const assistant = new LocalAssistant(records.state, records);
  const result = assistant.prepare('a', '일정 등록 2026-11-03 09:00 10:00 산책; 기분 기록 2026-11-03 좋음');
  assert.equal(result.status, 'needs_confirmation');
  assert.equal(result.actions.length, 2);
  assert.equal(records.list('scheduleEvents', 'a').items.length, 0);
  assert.equal(records.list('wellnessEntries', 'a').items.length, 0);
  assert.throws(() => assistant.confirm('b', result.actions[0].proposal_id, key()), { code: 'RESOURCE_NOT_FOUND' });
  assistant.confirm('a', result.actions[0].proposal_id, key());
  assert.equal(records.list('scheduleEvents', 'a').items.length, 1);
  assert.equal(records.list('wellnessEntries', 'a').items.length, 0);
  assistant.confirm('a', result.actions[1].proposal_id, key());
  assert.equal(records.list('wellnessEntries', 'a').items.length, 1);
  assert.equal(assistant.prepare('a', '일정 조회 2026-11-03').actions[0].result.items.length, 1);
  assert.equal(assistant.prepare('a', '일정 등록 내일 산책').status, 'needs_clarification');
});

test('diary requires scoped source, intermediate and current final approval', (t) => {
  const records = fixture(t);
  const source = records.createWellness('a', { date: '2026-11-03', mood: 'neutral' }, key());
  assert.throws(() => records.createDraft('b', { date: '2026-11-03', allowed_source_ids: [source.entry_id] }, key()), { code: 'RESOURCE_NOT_FOUND' });
  const draft = records.createDraft('a', { date: '2026-11-03', allowed_source_ids: [source.entry_id] }, key());
  assert.match(draft.body, /neutral/);
  assert.throws(() => records.approveDraft('a', draft.draft_id, { content_version: 1, content_hash: draft.content_hash, approval_scope: 'final_diary' }, key()), { code: 'INVALID_STATE_TRANSITION' });
  records.approveDraft('a', draft.draft_id, { content_version: 1, content_hash: draft.content_hash, approval_scope: 'continue' }, key());
  const oldFinal = records.approveDraft('a', draft.draft_id, { content_version: 1, content_hash: draft.content_hash, approval_scope: 'final_diary' }, key());
  const updated = records.reviseDraft('a', draft.draft_id, { base_content_version: 1, feedback: '직접 수정한 오늘의 기록' }, key());
  assert.throws(() => records.finalizeDraft('a', draft.draft_id, { content_version: 1, content_hash: draft.content_hash, approval_id: oldFinal.approval_id }, key()), { code: 'VERSION_CONFLICT' });
  records.approveDraft('a', draft.draft_id, { content_version: 2, content_hash: updated.content_hash, approval_scope: 'continue' }, key());
  const currentFinal = records.approveDraft('a', draft.draft_id, { content_version: 2, content_hash: updated.content_hash, approval_scope: 'final_diary' }, key());
  const saved = records.finalizeDraft('a', draft.draft_id, { content_version: 2, content_hash: updated.content_hash, approval_id: currentFinal.approval_id }, key());
  assert.equal(saved.body, '직접 수정한 오늘의 기록');
  assert.equal(records.list('diaryEntries', 'a').items.length, 1);
  assert.equal(records.list('diaryEntries', 'b').items.length, 0);
  const revision = records.beginEntryRevision('a', saved.entry_id, { version: 1 }, key());
  const edited = records.reviseDraft('a', revision.draft_id,
    { base_content_version: revision.content_version, feedback: '승인 전 수정 내용' }, key());
  assert.equal(records.get('diaryEntries', 'a', saved.entry_id).body, saved.body);
  records.approveDraft('a', revision.draft_id, { content_version: edited.content_version,
    content_hash: edited.content_hash, approval_scope: 'continue' }, key());
  const finalRevision = records.approveDraft('a', revision.draft_id, { content_version: edited.content_version,
    content_hash: edited.content_hash, approval_scope: 'final_diary' }, key());
  const updatedEntry = records.finalizeDraft('a', revision.draft_id, { content_version: edited.content_version,
    content_hash: edited.content_hash, approval_id: finalRevision.approval_id }, key());
  assert.equal(updatedEntry.body, '승인 전 수정 내용');
  assert.equal(updatedEntry.version, 2);
  assert.equal(updatedEntry.history.length, 2);
  assert.throws(() => records.beginEntryRevision('a', saved.entry_id, { version: 1 }, key()), { code: 'VERSION_CONFLICT' });
});

test('personal HTTP API requires Bearer auth and isolates owners', async (t) => {
  const records = fixture(t);
  const server = createServer(createApiHandler({ repositories: { state: records.state,
    async withIdempotentResponse(_owner, _scope, _key, _fingerprint, action) { return action(); } }, maxMediaBytes: 1024,
    supervisorRouter: {}, creatorAgent: {},
    auth: { async authenticate(header) { return header === 'Bearer owner-a' ? { ownerId: 'a' } :
      header === 'Bearer owner-b' ? { ownerId: 'b' } : null; } } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const schedule = `${base}/schedule/events`;
  assert.equal((await fetch(schedule)).status, 401);
  assert.equal((await fetch(`${base}/llm/usage`)).status, 401);
  const usage = await fetch(`${base}/llm/usage`, { headers: { authorization: 'Bearer owner-a' } });
  assert.equal(usage.status, 200);
  assert.equal((await usage.json()).enabled, false);
  const created = await fetch(schedule, { method: 'POST', headers: { authorization: 'Bearer owner-a',
    'content-type': 'application/json', 'idempotency-key': key() }, body: JSON.stringify({ title: '회의',
    start_at: '2026-11-03T10:00:00+09:00', end_at: '2026-11-03T11:00:00+09:00' }) });
  assert.equal(created.status, 201);
  const event = await created.json();
  assert.equal((await fetch(`${schedule}/${event.event_id}`, { headers: { authorization: 'Bearer owner-b' } })).status, 404);
  assert.equal((await fetch(schedule, { headers: { authorization: 'Bearer owner-a' } })).status, 200);
  const clientA = await (await fetch(`${schedule}/${event.event_id}`, { headers: { authorization: 'Bearer owner-a' } })).json();
  const clientB = await (await fetch(`${schedule}/${event.event_id}`, { headers: { authorization: 'Bearer owner-a' } })).json();
  const edit = (version, title) => fetch(`${schedule}/${event.event_id}`, { method: 'PATCH', headers: {
    authorization: 'Bearer owner-a', 'content-type': 'application/json', 'idempotency-key': key() },
    body: JSON.stringify({ version, title }) });
  assert.equal((await edit(clientA.version, '변경된 회의')).status, 200);
  const stale = await edit(clientB.version, '이전 화면에서 변경');
  assert.equal(stale.status, 409);
  assert.equal((await (await fetch(`${schedule}/${event.event_id}`, { headers: { authorization: 'Bearer owner-a' } })).json()).title, '변경된 회의');
  const proposed = await fetch(`${base}/assistant/messages`, { method: 'POST', headers: { authorization: 'Bearer owner-a',
    'content-type': 'application/json', 'idempotency-key': key() }, body: JSON.stringify({ text: '기분 기록 2026-11-03 좋음' }) });
  assert.equal(proposed.status, 202);
  const action = (await proposed.json()).actions[0];
  assert.equal(action.kind, 'wellness_create');
  assert.equal((await fetch(`${base}/wellness/entries`, { headers: { authorization: 'Bearer owner-a' } }).then((r) => r.json())).items.length, 0);
  const confirmed = await fetch(`${base}/assistant/proposals/${action.proposal_id}/confirm`, { method: 'POST',
    headers: { authorization: 'Bearer owner-a', 'idempotency-key': key() } });
  assert.equal(confirmed.status, 200);
  assert.equal((await fetch(`${base}/wellness/entries`, { headers: { authorization: 'Bearer owner-a' } }).then((r) => r.json())).items.length, 1);
});

test('consented mock interpretation proposes an allowlisted action without executing it', async (t) => {
  const records = fixture(t);
  let calls = 0;
  const server = createServer(createApiHandler({ repositories: { state: records.state,
    async withIdempotentResponse(_owner, _scope, _key, _fingerprint, action) { return action(); } },
    maxMediaBytes: 1024, creatorAgent: {}, supervisorRouter: { route: () => ({ status: 'needs_clarification' }) },
    capabilityRegistry: { get: () => ({ status: 'planned', capability_ids: ['schedule.manage'] }) },
    llmGateway: { enabled: true, provider: { mode: 'mock' }, async generate() { calls++;
      return { available: true, output: { module_id: 'schedule', normalized_command: '일정 등록 2026-11-03 09:00 10:00 산책' } }; } },
    auth: { async authenticate(header) { return header === 'Bearer owner-a' ? { ownerId: 'a' } : null; } } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/assistant/messages`;
  const post = (body) => fetch(url, { method: 'POST', headers: { authorization: 'Bearer owner-a',
    'content-type': 'application/json', 'idempotency-key': key() }, body: JSON.stringify(body) });
  const withoutConsent = await post({ text: '내일 아침 산책을 일정에 넣어줘' });
  assert.equal(withoutConsent.status, 202);
  assert.equal(calls, 0);
  const response = await post({ text: '내일 아침 산책을 일정에 넣어줘', privacy_consent_id: '00000000-0000-4000-8000-000000000001' });
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(result.interpretation.source, 'mock');
  assert.equal(result.status, 'needs_confirmation');
  assert.equal(calls, 1);
  assert.equal(records.list('scheduleEvents', 'a').items.length, 0);
});

test('missing schedule end time is clarified without a database write', async (t) => {
  const records = fixture(t);
  const assistant = new LocalAssistant(records.state, records);
  const partial = assistant.previewIncompleteSchedule('일정 등록 2026-11-04 15:00 종료시간미정 독서 모임');
  assert.equal(partial.status, 'needs_clarification');
  assert.equal(partial.agent_id, 'schedule');
  assert.deepEqual(partial.actions[0].planned_action.missing_fields, ['end_time']);
  assert.equal(records.list('scheduleEvents', 'a').items.length, 0);
  assert.equal(assistant.previewIncompleteSchedule('일정 등록 2026-02-30 15:00 종료시간미정 독서 모임'), null);
});

test('Diary mock AI receives only consented facts and never finalizes a draft', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'haejumi-diary-ai-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new JsonState(join(dir, 'state.json'));
  const records = new PersonalRecords(state);
  const repositories = new LocalRepositories({ state, dataDir: dir, maxMediaBytes: 1024 });
  const chosen = records.createWellness('a', { date: '2026-11-03', mood: 'good', sleep_hours: 7, note: '전송하면 안 되는 개인 메모' }, key());
  const other = records.createWellness('a', { date: '2026-11-03', mood: 'low', note: '선택하지 않은 기록' }, key());
  const consent = repositories.createPrivacyConsent('a', { provider_id: 'openai', purpose: 'diary_draft',
    data_categories: ['user_text', 'schedule', 'wellness'], resource_ids: [chosen.entry_id],
    notice_id: PRIVACY_NOTICE_ID, notice_version: PRIVACY_NOTICE_VERSION, explicitly_confirmed: true,
    expires_at: new Date(Date.now() + 60_000).toISOString() }, key());
  let calls = 0;
  const provider = { mode: 'mock', providerId: 'openai', estimateCostUsd: () => 0.01,
    async generateStructured({ input }) { calls++; assert.deepEqual(input.selected_facts,
      [{ kind: 'wellness', mood: 'good', sleep_hours: 7, activity_minutes: null }]);
      assert.equal(JSON.stringify(input).includes('개인 메모'), false);
      assert.equal(JSON.stringify(input).includes('선택하지 않은'), false);
      return { body: '승인 대기 중인 AI 일기 초안' }; } };
  const gateway = new LLMGateway({ enabled: true, provider, state, privacyGate: new PrivacyGate({ enabled: true,
    providerAllowlist: ['openai'], consentVerifier: (context) => repositories.verifyPrivacyConsent(context) }) });
  const server = createServer(createApiHandler({ repositories, llmGateway: gateway, maxMediaBytes: 1024,
    auth: { async authenticate(header) { return header === 'Bearer owner-a' ? { ownerId: 'a' } : null; } } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/diaries/drafts`;
  const post = (body, idempotencyKey = key()) => fetch(url, { method: 'POST', headers: {
    authorization: 'Bearer owner-a', 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body: JSON.stringify(body) });
  const noConsent = await post({ date: '2026-11-03', allowed_source_ids: [other.entry_id], user_notes: '로컬' });
  assert.equal(noConsent.status, 202); assert.equal(calls, 0);
  const request = { date: '2026-11-03', allowed_source_ids: [chosen.entry_id], user_notes: '오늘은 좋았다', privacy_consent_id: consent.consent_id };
  const requestKey = key();
  const created = await post(request, requestKey);
  assert.equal(created.status, 202);
  const draft = await created.json();
  assert.equal(draft.generation.source, 'mock'); assert.equal(draft.content_version, 2);
  assert.equal(draft.status, 'draft'); assert.equal(calls, 1);
  assert.equal(records.list('diaryEntries', 'a').items.length, 0);
  await post(request, requestKey);
  assert.equal(calls, 1);
  repositories.revokePrivacyConsent('a', consent.consent_id);
  const blocked = await (await post({ ...request, user_notes: '다시 작성' })).json();
  assert.equal(blocked.generation.source, 'local_rules'); assert.equal(blocked.generation.gate_reason, 'CONSENT_REQUIRED');
  assert.equal(calls, 1);
  assert.equal(records.list('diaryEntries', 'a').items.length, 0);
});

test('mock AI splits a multi-agent request into separate confirmed proposals', async (t) => {
  const records = fixture(t);
  const server = createServer(createApiHandler({ repositories: { state: records.state,
    async withIdempotentResponse(_owner, _scope, _key, _fingerprint, action) { return action(); } }, maxMediaBytes: 1024,
    creatorAgent: {}, supervisorRouter: { route: () => ({ status: 'needs_clarification' }) },
    llmGateway: { enabled: true, provider: { mode: 'mock' }, async generate() { return { available: true, output: {
      module_id: 'multi', normalized_commands: ['일정 등록 2026-11-03 09:00 10:00 산책', '기분 기록 2026-11-03 좋음'] } }; } },
    auth: { async authenticate(header) { return header === 'Bearer owner-a' ? { ownerId: 'a' } : null; } } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/assistant/messages`;
  const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer owner-a',
    'content-type': 'application/json', 'idempotency-key': key() }, body: JSON.stringify({ text: '내일 일정과 기분을 기록해 줘',
    privacy_consent_id: '00000000-0000-4000-8000-000000000001' }) });
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(result.status, 'needs_confirmation'); assert.equal(result.actions.length, 2);
  assert.equal(records.list('scheduleEvents', 'a').items.length, 0);
  assert.equal(records.list('wellnessEntries', 'a').items.length, 0);
});
