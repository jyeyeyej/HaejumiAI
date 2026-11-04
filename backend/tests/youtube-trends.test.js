import test from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeTrends } from '../src/application/youtube-trends.js';
import { createServer } from 'node:http';
import { createApiHandler } from '../src/adapters/node-http/transport.js';

test('trend search is off by default and sends zero requests without explicit live configuration', async () => {
  let calls = 0;
  const trends = new YouTubeTrends({ apiKey: 'synthetic-key', fetchImpl: async () => { calls += 1; throw new Error('unexpected'); } });
  const result = await trends.search({ topic: 'cafe' });
  assert.equal(result.status, 'unavailable'); assert.equal(result.analysis_scope, 'none'); assert.equal(calls, 0);
});

test('official YouTube adapter uses two metadata requests, recent dates and public metrics only', async () => {
  const calls = [];
  const videoId = 'abcDEF123_-';
  const trends = new YouTubeTrends({ apiKey: 'synthetic-key', enabled: true, now: () => new Date('2026-11-04T00:00:00.000Z'),
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.pathname.endsWith('/search')) return { ok: true, json: async () => ({ items: [{ id: { videoId } }] }) };
      return { ok: true, json: async () => ({ items: [{ id: videoId, snippet: { title: '합성 카페 영상', publishedAt: '2026-11-01T00:00:00Z' },
        statistics: { viewCount: '1200', likeCount: '23', commentCount: '4' }, contentDetails: { duration: 'PT45S' } },
      { id: 'longVID1234', snippet: { title: '긴 영상' }, statistics: { viewCount: '9999' }, contentDetails: { duration: 'PT4M' } }] }) };
    } });
  const result = await trends.search({ topic: 'cafe', days: 30 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].hostname, 'www.googleapis.com');
  assert.equal(calls[0].searchParams.get('publishedAfter'), '2026-10-05T00:00:00.000Z');
  assert.equal(calls[0].searchParams.get('order'), 'viewCount');
  assert.equal(calls[1].searchParams.get('part'), 'snippet,statistics,contentDetails');
  assert.equal(result.items.length, 1); assert.equal(result.items[0].view_count, 1200);
  assert.equal(result.items[0].analysis_scope, 'metadata_only');
  assert.equal(result.items[0].url, `https://www.youtube.com/watch?v=${videoId}`);
});

test('YouTube quota and provider errors fall back without retry or effect-analysis claims', async () => {
  let calls = 0;
  const trends = new YouTubeTrends({ apiKey: 'synthetic-key', enabled: true,
    fetchImpl: async () => { calls += 1; return { ok: false, status: 429 }; } });
  const result = await trends.search({ topic: 'travel', days: 7 });
  assert.equal(calls, 1); assert.equal(result.reason, 'API_LIMITED'); assert.equal(result.analysis_scope, 'none');
  assert.deepEqual(result.items, []);
});

test('trend HTTP route requires authentication and never exposes the provider key', async (t) => {
  const repositories = { state: { data: {}, save() {} } };
  const trends = new YouTubeTrends({ apiKey: 'synthetic-key', enabled: false });
  const auth = { authenticate: async (header) => header === 'Bearer synthetic-owner-token' ? { ownerId: 'owner' } : null };
  const server = createServer(createApiHandler({ repositories, auth, trends }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/trends/search?topic=cafe&days=30`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { Authorization: 'Bearer synthetic-owner-token' } });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(JSON.parse(body).analysis_scope, 'none');
  assert.equal(body.includes('synthetic-key'), false);
});
