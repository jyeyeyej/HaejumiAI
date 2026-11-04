import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonState } from '../src/adapters/filesystem/json-state.js';
import { LocalRepositories } from '../src/adapters/filesystem/repositories.js';
import { createApiHandler } from '../src/adapters/node-http/transport.js';
import { makeJpegStructure, makeMp4Structure } from './media-fixtures.js';
import { HaejumiApi } from '../../web/src/api.js';

function paddedJpeg(size) {
  const base = makeJpegStructure();
  const chunks = [base.subarray(0, 2)];
  let remaining = size - base.length;
  while (remaining > 0) {
    const payload = Math.min(65533, remaining - 4);
    if (payload < 0) throw new Error('Invalid synthetic JPEG size');
    const segment = Buffer.alloc(payload + 4);
    segment[0] = 0xff; segment[1] = 0xe2; segment.writeUInt16BE(payload + 2, 2);
    chunks.push(segment); remaining -= segment.length;
  }
  chunks.push(base.subarray(2));
  return Buffer.concat(chunks);
}

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'haejumi-web-upload-'));
  const state = new JsonState(join(dir, 'state.json'));
  const repositories = new LocalRepositories({ state, dataDir: dir, maxMediaBytes: 50 * 1024 * 1024, maxSelectedMedia: 20 });
  const server = createServer(createApiHandler({ repositories, maxMediaBytes: 50 * 1024 * 1024,
    auth: { async authenticate(header) { return header === 'Bearer synthetic-token' ? { ownerId: 'synthetic-owner' } : null; } } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = new HaejumiApi('synthetic-token', (path, options) => fetch(base + path, options));
  return { api, repositories };
}

const item = (bytes, index, type = 'image/jpeg') => ({ file: new File([bytes], `synthetic-${index}.${type === 'video/mp4' ? 'mp4' : 'jpg'}`, { type }),
  keys: { itemId: randomUUID(), partKey: randomUUID() } });

test('PC web API uploads 1, 5, 16 four-MiB JPEGs, 20 JPEGs and a mixed batch then creates projects', async (t) => {
  const { api, repositories } = await setup(t);
  for (const count of [1, 5, 16, 20]) {
    const bytes = paddedJpeg(count === 16 ? 4 * 1024 * 1024 : 4096);
    const selected = Array.from({ length: count }, (_, index) => item(bytes, index + 1));
    const ids = await api.uploadMany(selected, { keys: { initKey: randomUUID(), completeKey: randomUUID() } });
    assert.equal(ids.length, count);
    const project = await api.createProject(ids);
    assert.equal(project.media_ids?.length ?? repositories.state.data.projects[project.project_id].media_ids.length, count);
  }
  const mixed = [item(paddedJpeg(4096), 1), item(makeMp4Structure(), 2, 'video/mp4')];
  const ids = await api.uploadMany(mixed, { keys: { initKey: randomUUID(), completeKey: randomUUID() } });
  assert.equal(ids.length, 2);
  assert.equal((await api.createProject(ids)).media_ids.length, 2);
});

test('PC web retry reuses accepted parts and reports a numbered bad JPEG without duplicating media', async (t) => {
  const { api, repositories } = await setup(t);
  const selected = [item(paddedJpeg(4096), 1), item(paddedJpeg(4096), 2), item(paddedJpeg(4096), 3)];
  const keys = { initKey: randomUUID(), completeKey: randomUUID() };
  let failOnce = true;
  const fetcher = api.fetcher;
  api.fetcher = (path, options) => {
    if (failOnce && path.endsWith('/parts/2')) { failOnce = false; return Promise.reject(new Error('synthetic disconnect')); }
    return fetcher(path, options);
  };
  await assert.rejects(() => api.uploadMany(selected, { keys }), /synthetic disconnect/);
  const uploaded = await api.uploadMany(selected, { keys });
  assert.equal(uploaded.length, 3);
  assert.equal(Object.keys(repositories.state.data.media).length, 3);
  await assert.rejects(() => api.request('/api/v1/media/uploads', { method: 'POST', key: randomUUID(), body: { items: [
    { client_item_id: randomUUID(), file_name: 'valid.jpg', declared_media_type: 'image/jpeg', size_bytes: 100, sha256: 'a'.repeat(64) },
    { client_item_id: randomUUID(), file_name: 'bad:name.jpg', declared_media_type: 'image/jpeg', size_bytes: 100, sha256: 'b'.repeat(64) },
  ] } }), (error) => error.status === 422 && error.itemIndex === 2 && error.field === 'file_name');
  await assert.rejects(() => api.request('/api/v1/media/uploads', { method: 'POST', key: randomUUID(), body: { items: [
    { client_item_id: randomUUID(), file_name: 'large.jpg', declared_media_type: 'image/jpeg', size_bytes: 50 * 1024 * 1024 + 1,
      sha256: 'a'.repeat(64) },
    { client_item_id: randomUUID(), file_name: 'small.jpg', declared_media_type: 'image/jpeg', size_bytes: 100,
      sha256: 'b'.repeat(64) },
  ] } }), (error) => error.status === 413 && error.itemIndex === 1 && error.field === 'size_bytes');
  assert.deepEqual(await api.uploadMany(selected, { keys }), uploaded);
  assert.equal(Object.keys(repositories.state.data.media).length, 3);
  const bad = [item(paddedJpeg(4096), 4), item(Buffer.from([0xff, 0xd8, 1, 2, 3]), 5)];
  await assert.rejects(() => api.uploadMany(bad, { keys: { initKey: randomUUID(), completeKey: randomUUID() } }),
    (error) => error.status === 422 && error.itemIndex === 2 && error.field === 'file_structure');
  assert.equal(Object.keys(repositories.state.data.media).length, 3);
});
