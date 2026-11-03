import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, HaejumiApi, checkFile, manifestHash, sha256 } from '../src/api.js';

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
