import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HaejumiApi } from '../src/api.js';

test('project delete uses current version, confirmation, and refreshes the list', async () => {
  const calls = [];
  const api = new HaejumiApi('synthetic-token', async (path, options) => {
    calls.push({ path, options });
    return { ok: true, status: 200, json: async () => ({ deleted: true }) };
  });
  const id = '11111111-1111-4111-8111-111111111111';
  await api.deleteProject(id, 3, 'a'.repeat(64), 'synthetic-idempotency-key');
  assert.equal(calls[0].path, `/api/v1/content/projects/${id}`);
  assert.equal(calls[0].options.method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[0].options.body), { content_version: 3, content_hash: 'a'.repeat(64) });
  assert.equal(calls[0].options.headers['Idempotency-Key'], 'synthetic-idempotency-key');
  const jsx = readFileSync(new URL('../src/ui/App.jsx', import.meta.url), 'utf8');
  assert.match(jsx, /window\.confirm\(/);
  assert.match(jsx, /await api\.deleteProject\(/);
  assert.match(jsx, /await reload\(\)/);
  assert.match(jsx, /setSelected\(null\)/);
  assert.match(jsx, /error\.code === 'INVALID_STATE_TRANSITION'/);
  assert.match(jsx, /error\.code === 'VERSION_CONFLICT'/);
});
