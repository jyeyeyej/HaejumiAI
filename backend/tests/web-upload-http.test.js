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
import { makeJpegStructure, makeMp4Structure, makePng, makeWebpStructure } from './media-fixtures.js';
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

test('PC web independent sessions keep seven valid uploads after three invalid files and create an ordered project after retry', async (t) => {
  const { api, repositories } = await setup(t);
  const selected = Array.from({ length: 10 }, (_, index) => item([1, 4, 8].includes(index)
    ? Buffer.from([0xff, 0xd8, 1, 2, 3]) : paddedJpeg(4096), index + 1));
  const updates = [];
  const first = await api.uploadEach(selected, { onItem: (index, update) => updates.push({ index, ...update }) });
  assert.equal(first.results.length, 10);
  assert.equal(first.results.filter((result) => result.mediaId).length, 7);
  assert.deepEqual(updates.filter((update) => update.status === '실패').map((update) => update.index), [1, 4, 8]);
  assert.equal(Object.keys(repositories.state.data.media).length, 7);
  const repaired = selected.map((entry, index) => first.results[index].mediaId ? entry : item(paddedJpeg(4096), index + 1));
  const retryIndexes = first.results.map((result, index) => result.mediaId ? null : index).filter((index) => index !== null);
  const retry = await api.uploadEach(retryIndexes.map((index) => repaired[index]));
  assert.equal(retry.results.filter((result) => result.mediaId).length, 3);
  assert.equal(Object.keys(repositories.state.data.media).length, 10);
  const ordered = first.results.map((result, index) => result.mediaId ?? retry.results[retryIndexes.indexOf(index)].mediaId);
  const project = await api.createProject(ordered);
  assert.deepEqual(project.media_ids, ordered);
  assert.deepEqual(repositories.state.data.projects[project.project_id].media_ids, ordered);
});

test('independent upload accepts five JPEG orientations plus PNG, WebP and MP4, and reports a safe JPEG structure field', async (t) => {
  const { api, repositories } = await setup(t);
  const jpeg = (width, height) => {
    const bytes = Buffer.from(makeJpegStructure());
    bytes.writeUInt16BE(height, 7); bytes.writeUInt16BE(width, 9);
    return bytes;
  };
  const selected = [jpeg(1600, 900), jpeg(900, 1600), jpeg(1200, 1200), jpeg(1920, 1080), jpeg(1080, 1920)]
    .map((bytes, index) => item(bytes, index + 1));
  selected.push({ file: new File([makePng()], 'synthetic.png', { type: 'image/png' }), keys: { itemId: randomUUID(), partKey: randomUUID() } });
  selected.push({ file: new File([makeWebpStructure()], 'synthetic.webp', { type: 'image/webp' }), keys: { itemId: randomUUID(), partKey: randomUUID() } });
  selected.push(item(makeMp4Structure(), 7, 'video/mp4'));
  const outcome = await api.uploadEach(selected);
  assert.equal(outcome.results.filter((result) => result.mediaId).length, 8);
  assert.equal((await api.createProject(outcome.results.map((result) => result.mediaId))).media_ids.length, 8);
  assert.equal(Object.keys(repositories.state.data.media).length, 8);
  const damaged = item(Buffer.from([0xff, 0xd8, 1, 2, 3]), 8);
  await assert.rejects(() => api.upload(damaged.file, { keys: damaged.keys }),
    (error) => error.status === 422 && error.code === 'VALIDATION_ERROR' && error.field === 'file_structure' &&
      /내부 구조/.test(error.message));
});
