import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, HaejumiApi, checkFile, manifestHash, sha256 } from '../src/api.js';

test('PC web exchanges Bearer once for a persistent HttpOnly session and sends CSRF header on writes', async () => {
  const calls = [];
  const fetcher = async (path, options) => {
    calls.push({ path, options });
    return path === '/api/v1/auth/web-session' && options.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ authenticated: true, items: [] });
  };
  const api = await HaejumiApi.signIn('synthetic-token', fetcher);
  await api.status(); await api.projects();
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await api.approve(id, { checkpoint_id: id, content_version: 1, content_hash: 'a'.repeat(64) }, 'session-test-key-0001');
  await api.logout();
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-token');
  assert.equal(calls[0].options.headers['X-Haejumi-Web'], '1');
  assert.equal(calls.slice(1).every(({ options }) => !options.headers.Authorization && options.credentials === 'same-origin'), true);
  assert.equal(calls[3].options.headers['X-Haejumi-Web'], '1');
  assert.equal(calls[4].options.method, 'DELETE');
});

test('web API sends bearer only to relative /api/v1 paths and binds writes to version/hash', async () => {
  const calls = [];
  const api = new HaejumiApi('test-token', async (path, options) => {
    calls.push({ path, options });
    return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  await api.projects();
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await api.approve(id, { checkpoint_id: id, content_version: 3, content_hash: 'a'.repeat(64) }, 'key-for-approval-0001');
  assert.equal(calls[0].path, '/api/v1/content/projects');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[1].options.headers['Idempotency-Key'], 'key-for-approval-0001');
  assert.deepEqual(JSON.parse(calls[1].options.body), { checkpoint_id: id, content_version: 3, content_hash: 'a'.repeat(64), approval_scope: 'continue' });
  await assert.rejects(() => api.request('https://other.example/api/v1/tasks'), /허용되지 않은/);
});

test('publication metadata and final approval use owner-authenticated API without SNS calls', async () => {
  const calls = [];
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const api = new HaejumiApi('synthetic-token', async (path, options) => {
    calls.push({ path, options }); return Response.json({ items: [] });
  });
  await api.publications(id);
  await api.createPublication(id, { platform: 'youtube', account_id: 'my-account', visibility: 'private', title: '제목', description: '', hashtags: [] }, 'publication-create-key-001');
  await api.approvePublication(id, id, { content_version: 2, content_hash: 'a'.repeat(64), artifact_sha256: 'b'.repeat(64),
    publication_revision: 1, publication_hash: 'c'.repeat(64) }, 'publication-approve-key-001');
  assert.equal(calls.length, 3);
  assert.equal(calls.every(({ path, options }) => path.startsWith('/api/v1/') && options.headers.Authorization === 'Bearer synthetic-token'), true);
  assert.equal(calls[2].path, `/api/v1/tasks/${id}/publications/${id}/approvals`);
  assert.equal(JSON.parse(calls[2].options.body).artifact_sha256, 'b'.repeat(64));
});

test('YouTube connection and upload use local authenticated endpoints and explicit write keys', async () => {
  const calls = [];
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const api = HaejumiApi.webSession(async (path, options) => {
    calls.push({ path, options }); return Response.json({ items: [] });
  });
  await api.youtubeConnection();
  await api.youtubeConnect('youtube-connect-key-001');
  await api.youtubeUploads(id, id);
  await api.youtubeUpload(id, id, false, 'youtube-upload-key-001');
  await api.youtubeDisconnect('youtube-disconnect-key-001');
  assert.deepEqual(calls.map((call) => [call.options.method, call.path]), [
    ['GET', '/api/v1/publications/youtube/connection'],
    ['POST', '/api/v1/publications/youtube/connection/start'],
    ['GET', `/api/v1/tasks/${id}/publications/${id}/youtube-upload`],
    ['POST', `/api/v1/tasks/${id}/publications/${id}/youtube-upload`],
    ['DELETE', '/api/v1/publications/youtube/connection'],
  ]);
  assert.equal(calls.filter((call) => call.options.method !== 'GET').every((call) =>
    call.options.headers['X-Haejumi-Web'] === '1' && call.options.headers['Idempotency-Key'] &&
    call.options.credentials === 'same-origin'), true);
  assert.equal(calls.every((call) => !call.options.headers.Authorization), true);
  assert.deepEqual(JSON.parse(calls[3].options.body), { made_for_kids: false });
});

test('privacy notice, consent and usage requests stay on the authenticated local API', async () => {
  const calls = [];
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const api = new HaejumiApi('synthetic-token', async (path, options) => {
    calls.push({ path, options }); return Response.json({ items: [] });
  });
  await api.llmUsage(); await api.privacyNotice(); await api.consents();
  await api.grantTextConsent({ notice_id: id, notice_version: '1' }, 'consent-create-key-001');
  await api.revokeConsent(id, 'consent-revoke-key-001');
  assert.equal(calls.every(({ path, options }) => path.startsWith('/api/v1/') && options.headers.Authorization === 'Bearer synthetic-token'), true);
  assert.equal(JSON.parse(calls[3].options.body).resource_ids.length, 0);
  assert.equal(calls[4].options.method, 'DELETE');
});

test('Vision consent names only selected media and plan request passes its scoped consent', async () => {
  const calls = [];
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const mediaId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const api = new HaejumiApi('synthetic-token', async (path, options) => {
    calls.push({ path, options }); return Response.json({ consent_id: id });
  });
  await api.grantVisionConsent({ notice_id: id, notice_version: '1' }, [mediaId], 'vision-consent-key-0001');
  await api.revisePlan(id, 2, '밝고 귀엽게', 'vision-plan-key-0001', id);
  const consent = JSON.parse(calls[0].options.body);
  assert.deepEqual(consent.resource_ids, [mediaId]);
  assert.equal(consent.purpose, 'vision_analysis');
  assert.deepEqual(consent.data_categories, ['selected_media', 'user_text']);
  assert.equal(JSON.parse(calls[1].options.body).privacy_consent_id, id);
});

test('trend metadata request remains on authenticated local API with a bounded period', async () => {
  const calls = [];
  const api = new HaejumiApi('synthetic-token', async (path, options) => { calls.push({ path, options }); return Response.json({ status: 'unavailable', items: [] }); });
  await api.trends('cafe', 30);
  assert.equal(calls[0].path, '/api/v1/trends/search?topic=cafe&days=30');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-token');
  assert.throws(() => api.trends('other', 30), /검색 조건/);
  assert.equal(calls.length, 1);
});

test('mixed edit saves only a cached trend selector and current version, without another search', async () => {
  const calls = [];
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const api = new HaejumiApi('synthetic-token', async (path, options) => { calls.push({ path, options }); return Response.json({ plan: {} }); });
  await api.updateScenes(id, { current_version: 4, content_hash: 'a'.repeat(64) },
    [{ media_id: id, duration_seconds: 6, motion: 'zoom_in' }], 'mixed-edit-key-0001', { topic: 'travel', days: 30 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, `/api/v1/tasks/${id}/plan`);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-token');
  assert.equal(calls[0].options.headers['Idempotency-Key'], 'mixed-edit-key-0001');
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.trend_query, { topic: 'travel', days: 30 });
  assert.equal(body.content_version, 4); assert.equal(body.content_hash, 'a'.repeat(64));
});

test('style references stay on authenticated local API and bind selected IDs to plan versions', async () => {
  const calls = []; const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const referenceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const api = new HaejumiApi('synthetic-token', async (path, options) => { calls.push({ path, options }); return Response.json({ items: [] }); });
  await api.styleReferences(id);
  await api.addStyleReference(id, { kind: 'url', url: 'https://www.youtube.com/shorts/abcDEF123_-', note: '빠르게' }, 'reference-add-key');
  await api.revisePlan(id, 2, '합성 여행 쇼츠', 'reference-plan-key', null, [referenceId]);
  await api.updateScenes(id, { current_version: 3, content_hash: 'a'.repeat(64) },
    [{ media_id: id, duration_seconds: 6 }], 'reference-scene-key', null, [referenceId]);
  assert.ok(calls.every((call) => call.path.startsWith('/api/v1/tasks/') && call.options.headers.Authorization === 'Bearer synthetic-token'));
  assert.deepEqual(JSON.parse(calls[2].options.body).reference_ids, [referenceId]);
  assert.deepEqual(JSON.parse(calls[3].options.body).reference_ids, [referenceId]);
  assert.equal(JSON.parse(calls[3].options.body).content_version, 3);
});

test('web request cancellation stops the local wait without automatic retry', async () => {
  let calls = 0;
  const controller = new AbortController();
  const api = new HaejumiApi('synthetic-token', async (_path, options) => {
    calls += 1;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
  });
  const pending = api.request('/api/v1/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/plan', {
    method: 'POST', key: 'synthetic-cancel-key', signal: controller.signal,
    body: { content_version: 1, request_text: '합성 문장' } });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('selected upload uses one file, SHA-256 manifest, and per-step idempotency keys', async () => {
  const calls = [];
  const file = new File([new Uint8Array([1, 2, 3])], 'selected.png', { type: 'image/png' });
  const itemId = '11111111-1111-4111-8111-111111111111';
  const uploadId = '22222222-2222-4222-8222-222222222222';
  const mediaId = '33333333-3333-4333-8333-333333333333';
  const api = new HaejumiApi('test-token', async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/media/uploads')) return Response.json({ upload_id: uploadId });
    if (path.endsWith('/parts/1')) return new Response(null, { status: 204 });
    return Response.json({ media: [{ media_id: mediaId }] });
  });
  assert.equal(await api.upload(file, { keys: { itemId, initKey: 'init-000000000001', partKey: 'part-000000000001', completeKey: 'complete-00000001' } }), mediaId);
  const hash = await sha256(new Uint8Array([1, 2, 3]));
  assert.equal(JSON.parse(calls[0].options.body).items[0].sha256, hash);
  assert.equal(calls[1].options.headers['Content-Type'], 'application/octet-stream');
  assert.equal(JSON.parse(calls[2].options.body).manifest_sha256, await manifestHash(itemId, hash, 3));
  assert.equal(calls[2].options.headers['Idempotency-Key'], 'complete-00000001');
  assert.throws(() => checkFile(new File(['x'], 'bad.txt', { type: 'text/plain' })), /파일을 선택/);
});

test('mixed files use one ordered upload session and verified manifest', async () => {
  const calls = [];
  const uploadId = '22222222-2222-4222-8222-222222222222';
  const mediaIds = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
  const api = new HaejumiApi('test-token', async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/media/uploads')) return Response.json({ upload_id: uploadId });
    if (path.includes('/parts/')) return new Response(null, { status: 204 });
    return Response.json({ media: mediaIds.map((media_id) => ({ media_id })) });
  });
  const items = [
    { file: new File([new Uint8Array([1, 2, 3])], 'first.png', { type: 'image/png' }), keys: { itemId: '11111111-1111-4111-8111-111111111111', partKey: 'part-key-00000001' } },
    { file: new File([new Uint8Array([4, 5, 6])], 'second.mp4', { type: 'video/mp4' }), keys: { itemId: '55555555-5555-4555-8555-555555555555', partKey: 'part-key-00000002' } },
  ];
  assert.deepEqual(await api.uploadMany(items, { keys: { initKey: 'init-key-00000001', completeKey: 'complete-key-00000001' } }), mediaIds);
  assert.equal(calls[1].path, `/api/v1/media/uploads/${uploadId}/parts/1`);
  assert.equal(calls[2].path, `/api/v1/media/uploads/${uploadId}/parts/2`);
  const body = JSON.parse(calls[3].options.body);
  assert.deepEqual(body.items.map((item) => item.client_item_id), items.map((item) => item.keys.itemId));
  assert.equal(body.manifest_sha256, await sha256(new TextEncoder().encode(JSON.stringify(body.items))));
});

test('authentication and concurrent revision errors have safe messages', async () => {
  for (const status of [401, 409]) {
    const api = new HaejumiApi('test-token', async () => Response.json({ error: { code: 'VERSION_CONFLICT', secret: 'must not display' } }, { status }));
    await assert.rejects(() => api.projects(), (error) => error instanceof ApiError && error.status === status && !error.message.includes('must not display'));
  }
});

test('upload errors disclose a safe file number and enforce 50 MiB per file', async () => {
  assert.throws(() => checkFile({ name: 'large.jpg', type: 'image/jpeg', size: 50 * 1024 * 1024 + 1 }), /50 MiB/);
  const api = new HaejumiApi('test-token', async () => Response.json({ error: {
    code: 'VALIDATION_ERROR', item_index: 16, field: 'file_structure', secret: 'private path' } }, { status: 422 }));
  await assert.rejects(() => api.projects(), (error) => error instanceof ApiError && error.itemIndex === 16 &&
    error.field === 'file_structure' && /내부 구조/.test(error.message) && !error.message.includes('private path'));
});

test('preview accepts only authenticated FFmpeg MP4 with matching artifact hash', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const hash = await sha256(bytes);
  const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const makeResponse = (mode = 'ffmpeg') => new Response(bytes, { status: 200, headers: {
    'content-type': 'video/mp4', 'content-length': String(bytes.length), 'x-haejumi-render-mode': mode,
  } });
  const api = new HaejumiApi('test-token', async () => makeResponse());
  const url = await api.preview(taskId, 2, hash);
  assert.match(url, /^blob:/);
  URL.revokeObjectURL(url);
  await assert.rejects(() => api.preview(taskId, 2, '0'.repeat(64)), /해시 검증/);
  const mock = new HaejumiApi('test-token', async () => makeResponse('test'));
  await assert.rejects(() => mock.preview(taskId, 2, hash), /실제 MP4/);
});
