import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { JsonState } from '../src/adapters/filesystem/json-state.js';
import { LocalRepositories } from '../src/adapters/filesystem/repositories.js';
import { createApiHandler } from '../src/adapters/node-http/transport.js';
import { CreatorAgent } from '../src/agents/creator-agent.js';
import { proposeMixedEdit, summarizeTrend } from '../../shared/trend-edit.js';

const NOW = new Date('2026-11-04T12:00:00.000Z');
function result(topic, title) {
  return { status: 'ok', source: 'youtube_data_api', analysis_scope: 'metadata_only', topic,
    period: { from: '2026-10-05T12:00:00.000Z', to: '2026-11-04T12:00:00.000Z' },
    items: [{ title, description: '합성 검색 설명', published_at: '2026-11-02T12:00:00.000Z',
      url: 'https://www.youtube.com/watch?v=abcDEF123_-', view_count: 1200 }] };
}

test('restaurant, cafe and travel metadata yield only topic evidence, not claimed editing techniques', () => {
  for (const [topic, title, word] of [['restaurant', '맛집 음식 쇼츠', '맛집'], ['cafe', '카페 커피 릴스', '카페'], ['travel', '여행 풍경 브이로그', '여행']]) {
    const summary = summarizeTrend(result(topic, title), NOW);
    assert.equal(summary.topic, topic);
    assert.ok(summary.keywords.includes(word));
    if (title.includes('브이로그')) assert.ok(summary.title_patterns.includes('브이로그'));
    assert.equal(summary.analysis_scope, 'metadata_only');
    assert.equal(summary.references.length, 1);
    assert.equal(JSON.stringify(summary).includes('transition'), false);
  }
  assert.equal(summarizeTrend(result('travel', '무관한 게임 영상'), NOW), null);
  assert.equal(summarizeTrend(result('travel', '여행 영상'), new Date('2026-11-05T12:00:00Z')), null);
  assert.equal(summarizeTrend({ status: 'unavailable', reason: 'API_LIMITED' }, NOW), null);
});

test('Vision categories mix supported scene effects; absent Vision keeps every scene basic', () => {
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const plan = { target_seconds: 12, scenes: ids.map((id, index) => ({ media_id: id, media_type: 'image/jpeg',
    start_seconds: index * 3, end_seconds: index * 3 + 3 })),
  media_insights: ids.map((id, index) => ({ media_id: id, category: ['travel', 'food', 'cafe', 'unknown'][index],
    subjects: index === 3 ? [] : ['합성 피사체'] })) };
  const trend = summarizeTrend(result('restaurant', '맛집 음식 쇼츠'), NOW);
  const rows = proposeMixedEdit(plan, { source: 'mock' }, trend);
  assert.equal(rows[0].media_id, ids[1]);
  assert.deepEqual(rows.map((row) => row.suggested_style), ['highlight', 'emotional', 'emotional', 'basic']);
  assert.deepEqual(rows.map((row) => row.motion), ['zoom_in', 'zoom_in', 'pan_right', 'static']);
  assert.ok(Math.abs(rows.reduce((sum, row) => sum + row.duration_seconds, 0) - 12) < 0.01);
  assert.ok(rows.every((row) => !row.edit_reason.includes('YouTube 영상 효과')));
  const local = proposeMixedEdit(plan, { source: 'local_rules' }, trend);
  assert.ok(local.every((row) => row.motion === 'static' && row.suggested_style === 'basic'));
  assert.deepEqual(proposeMixedEdit(plan, { source: 'mock' }, null).map((row) => row.media_id), ids);
});

test('cached trend provenance is stored with scene edit and version invalidation; missing cache is rejected', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'haejumi-trend-edit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new JsonState(join(dir, 'state.json'));
  const repo = new LocalRepositories({ state, dataDir: dir, maxMediaBytes: 1024 * 1024 });
  const owner = 'synthetic-owner';
  const ids = [randomUUID(), randomUUID()];
  ids.forEach((mediaId) => { state.data.media[mediaId] = { mediaId, mediaType: 'image/jpeg', ownerId: owner,
    status: 'available', sha256: 'a'.repeat(64) }; });
  const project = repo.createForOwner(owner, { media_ids: ids, target_seconds: 6 }, randomUUID());
  const plan = await repo.createCreatorPlan(owner, project.task_id, { content_version: 1, request_text: '합성 여행 쇼츠' },
    randomUUID(), new CreatorAgent({ gateway: null }));
  const task = state.data.tasks[project.task_id];
  const scenes = [...plan.plan.scenes].reverse().map((scene) => ({ media_id: scene.media_id, duration_seconds: 3,
    framing: 'blur_pad', motion: 'zoom_in', transition: 'fade', subtitle_style: 'default' }));
  const input = { content_version: task.current_version, content_hash: task.content_hash, scenes,
    trend_query: { topic: 'travel', days: 30 } };
  assert.throws(() => repo.updateCreatorScenes(owner, project.task_id, input, randomUUID()), { code: 'TREND_CACHE_MISSING' });
  const fixture = result('travel', '여행 풍경 브이로그');
  fixture.period.to = new Date().toISOString();
  fixture.period.from = new Date(Date.now() - 30 * 86400000).toISOString();
  fixture.items[0].published_at = new Date(Date.now() - 2 * 86400000).toISOString();
  let searches = 0;
  const trends = { getCached: ({ topic, days }) => topic === 'travel' && days === 30 ? fixture : null,
    async search() { searches += 1; throw new Error('unexpected live search'); } };
  const auth = { authenticate: async (header) => header === 'Bearer synthetic-test-token' ? { ownerId: owner } : null };
  const server = createServer(createApiHandler({ repositories: repo, auth, trends }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/tasks/${project.task_id}/plan`;
  const unauthenticated = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(input) });
  assert.equal(unauthenticated.status, 401);
  const response = await fetch(url, { method: 'PUT', headers: { authorization: 'Bearer synthetic-test-token',
    'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(input) });
  assert.equal(response.status, 200, await response.clone().text());
  const edited = await response.json();
  assert.equal(searches, 0);
  assert.equal(edited.content_version, plan.content_version + 1);
  assert.equal(edited.plan.trend_reference.analysis_scope, 'metadata_only');
  assert.equal(edited.plan.trend_reference.references.length, 1);
  assert.deepEqual(edited.plan.scenes.map((scene) => scene.media_id), [...ids].reverse());
  assert.deepEqual(edited.plan.media_insights.map((insight) => insight.media_id), [...ids].reverse());
  assert.ok(repo.getOwnedCheckpoints(owner, project.task_id).some((item) => item.status === 'invalidated'));
  assert.equal(repo.getOwnedCreatorPlan(owner, project.task_id).plan.trend_reference.topic, 'travel');
});
