import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { JsonState } from '../src/adapters/filesystem/json-state.js';
import { LocalRepositories } from '../src/adapters/filesystem/repositories.js';
import { createApiHandler } from '../src/adapters/node-http/transport.js';
import { PrivacyGate } from '../src/security/privacy-gate.js';

const tokenA = 'test-owner-a-token-with-enough-random-looking-bytes';
const tokenB = 'test-owner-b-token-with-enough-random-looking-bytes';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'haejumi-test-'));
  const state = new JsonState(join(dataDir, 'state.json'));
  const repositories = new LocalRepositories({ state, dataDir, maxMediaBytes: 1024 * 1024 });
  const auth = { async authenticate(header) {
    const value = /^Bearer (.+)$/.exec(header || '')?.[1];
    if (value === tokenA) return { ownerId: 'owner-a' };
    if (value === tokenB) return { ownerId: 'owner-b' };
    return null;
  } };
  const server = createServer(createApiHandler({ repositories, auth, maxMediaBytes: 1024 * 1024 }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { base, repositories };
}

function headers(token = tokenA) { return { authorization: `Bearer ${token}` }; }

test('auth is required before private API routes', async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/content/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media_ids: [] }) });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'AUTHENTICATION_REQUIRED');
});

test('selected upload, completion, project creation and task status form the first Creator slice', async (t) => {
  const { base } = await fixture(t);
  const init = await fetch(`${base}/media/uploads`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'upload-init-key-0001' }, body: JSON.stringify({ items: [{
    client_item_id: '11111111-1111-4111-8111-111111111111', file_name: 'selected.png', declared_media_type: 'image/png', size_bytes: png.length, sha256: digest(png),
  }] }) });
  assert.equal(init.status, 201);
  const upload = await init.json();
  const part = await fetch(`${base}/media/uploads/${upload.upload_id}/parts/1`, { method: 'PUT', headers: { ...headers(), 'content-type': 'application/octet-stream' }, body: png });
  assert.equal(part.status, 204);

  const manifestHash = digest(Buffer.from(JSON.stringify([{ client_item_id: '11111111-1111-4111-8111-111111111111', sha256: digest(png), size_bytes: png.length }])));
  const complete = await fetch(`${base}/media/uploads/${upload.upload_id}/complete`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ manifest_sha256: manifestHash }) });
  assert.equal(complete.status, 200);
  const imported = await complete.json();
  assert.equal(imported.media[0].media_type_verified, true);
  assert.equal(imported.media[0].sha256, digest(png));
  assert.equal(JSON.stringify(imported).includes('blobPath'), false);

  const projectResponse = await fetch(`${base}/content/projects`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'project-once' }, body: JSON.stringify({ media_ids: [imported.media[0].media_id] }) });
  assert.equal(projectResponse.status, 201);
  const project = await projectResponse.json();
  assert.equal(project.status, 'created');
  assert.ok(project.task_id);
  const taskResponse = await fetch(`${base}/tasks/${project.task_id}`, { headers: headers() });
  assert.equal(taskResponse.status, 200);
  assert.equal((await taskResponse.json()).project_id, project.project_id);
});

test('a different owner cannot read or attach another owner’s media/task', async (t) => {
  const { base } = await fixture(t);
  const init = await fetch(`${base}/media/uploads`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'upload-init-key-0002' }, body: JSON.stringify({ items: [{
    client_item_id: '11111111-1111-4111-8111-111111111111', file_name: 'selected.png', declared_media_type: 'image/png', size_bytes: png.length, sha256: digest(png),
  }] }) });
  const upload = await init.json();
  await fetch(`${base}/media/uploads/${upload.upload_id}/parts/1`, { method: 'PUT', headers: { ...headers(), 'content-type': 'application/octet-stream' }, body: png });
  const manifestHash = digest(Buffer.from(JSON.stringify([{ client_item_id: '11111111-1111-4111-8111-111111111111', sha256: digest(png), size_bytes: png.length }])));
  const complete = await fetch(`${base}/media/uploads/${upload.upload_id}/complete`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ manifest_sha256: manifestHash }) });
  const mediaId = (await complete.json()).media[0].media_id;
  const foreignProject = await fetch(`${base}/content/projects`, { method: 'POST', headers: { ...headers(tokenB), 'content-type': 'application/json' }, body: JSON.stringify({ media_ids: [mediaId] }) });
  assert.equal(foreignProject.status, 404);
});

test('declared MIME, bytes, size and digest are checked before import', async (t) => {
  const { base } = await fixture(t);
  const init = await fetch(`${base}/media/uploads`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'upload-init-key-0003' }, body: JSON.stringify({ items: [{
    client_item_id: '11111111-1111-4111-8111-111111111111', file_name: '..\\private.png', declared_media_type: 'image/png', size_bytes: png.length, sha256: digest(png),
  }] }) });
  assert.equal(init.status, 422);

  const validInit = await fetch(`${base}/media/uploads`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'upload-init-key-0004' }, body: JSON.stringify({ items: [{
    client_item_id: '11111111-1111-4111-8111-111111111111', file_name: 'selected.png', declared_media_type: 'image/jpeg', size_bytes: png.length, sha256: digest(png),
  }] }) });
  const upload = await validInit.json();
  await fetch(`${base}/media/uploads/${upload.upload_id}/parts/1`, { method: 'PUT', headers: { ...headers(), 'content-type': 'application/octet-stream' }, body: png });
  const completion = await fetch(`${base}/media/uploads/${upload.upload_id}/complete`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ manifest_sha256: '0'.repeat(64) }) });
  assert.equal(completion.status, 415);
  assert.equal((await completion.json()).error.code, 'UNSUPPORTED_MEDIA_TYPE');
});

test('PrivacyGate denies external processing before dispatch (zero calls)', async () => {
  const gate = new PrivacyGate();
  let calls = 0;
  await assert.rejects(() => gate.dispatchExternal({ ownerId: 'owner-a' }, async () => { calls += 1; }), { code: 'CONSENT_REQUIRED' });
  assert.equal(calls, 0);
});
