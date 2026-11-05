import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, HaejumiApi } from '../src/api.js';

function items(count) {
  return Array.from({ length: count }, (_, index) => ({ file: { name: `synthetic-${index + 1}.jpg` }, keys: { itemId: `item-${index + 1}` } }));
}

for (const [name, failedIndexes, status] of [
  ['10장 모두 성공', [], 422],
  ['10장 중 3장 실패', [0, 4, 9], 422],
  ['첫 파일 실패', [0], 422],
  ['중간 파일 실패', [4], 422],
  ['마지막 파일 실패', [9], 422],
  ['422 이후 계속', [2], 422],
  ['409 이후 계속', [2], 409],
]) {
  test(`파일별 업로드: ${name}`, async () => {
    const api = new HaejumiApi('synthetic-token');
    const selected = items(10);
    const calls = [];
    const updates = [];
    api.upload = async (file, { keys }) => {
      const index = Number(file.name.match(/\d+/)[0]) - 1;
      calls.push({ index, itemId: keys.itemId });
      if (failedIndexes.includes(index)) throw new ApiError(status, status === 422 ? 'VALIDATION_ERROR' : 'INVALID_STATE_TRANSITION', null, 'file_structure');
      return `media-${index + 1}`;
    };
    const outcome = await api.uploadEach(selected, { onItem: (index, update) => updates.push({ index, ...update }) });
    assert.deepEqual(calls.map((entry) => entry.index), Array.from({ length: 10 }, (_, index) => index));
    assert.deepEqual(calls.map((entry) => entry.itemId), selected.map((entry) => entry.keys.itemId));
    assert.equal(outcome.results.filter((result) => result.mediaId).length, 10 - failedIndexes.length);
    assert.equal(outcome.results.filter((result) => result.error).length, failedIndexes.length);
    assert.deepEqual(updates.filter((entry) => entry.status === '실패').map((entry) => entry.index), failedIndexes);
    assert.equal(updates.filter((entry) => entry.status === '완료').length, 10 - failedIndexes.length);
  });
}

test('실패 파일만 다시 시도하며 성공 파일은 중복 전송하지 않음', async () => {
  const api = new HaejumiApi('synthetic-token');
  const selected = items(10);
  const calls = [];
  let firstPass = true;
  api.upload = async (file) => {
    const index = Number(file.name.match(/\d+/)[0]) - 1;
    calls.push(index);
    if (firstPass && [1, 4, 7].includes(index)) throw new ApiError(422, 'VALIDATION_ERROR');
    return `media-${index + 1}`;
  };
  const first = await api.uploadEach(selected);
  assert.equal(first.results.filter((result) => result.mediaId).length, 7);
  firstPass = false;
  const pending = selected.filter((_item, index) => !first.results[index].mediaId);
  const retry = await api.uploadEach(pending);
  assert.deepEqual(calls.slice(10), [1, 4, 7]);
  assert.equal(retry.results.filter((result) => result.mediaId).length, 3);
});

test('검증되지 않은 파일도 개별 실패 처리하고 다음 파일을 업로드함', async () => {
  const api = new HaejumiApi('synthetic-token');
  const selected = items(3);
  const calls = [];
  api.upload = async (file) => {
    calls.push(file.name);
    if (file.name.includes('2')) throw new Error('JPEG·PNG·WebP·MP4·MOV 형식의 50 MiB 이하 파일을 선택해 주세요.');
    return `media-${calls.length}`;
  };
  const outcome = await api.uploadEach(selected);
  assert.equal(calls.length, 3);
  assert.match(outcome.results[1].error, /50 MiB/);
  assert.equal(outcome.results[2].mediaId, 'media-3');
});

test('실제 단일 파일 HTTP 흐름은 파일별 세션으로 분리되어 422 뒤에도 완료됨', async () => {
  const sessions = [];
  const completed = [];
  const api = new HaejumiApi('synthetic-token', async (path, options) => {
    if (path === '/api/v1/media/uploads') {
      const index = sessions.push(JSON.parse(options.body).items[0]);
      return Response.json({ upload_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` });
    }
    if (path.endsWith('/parts/1')) return new Response(null, { status: 204 });
    if (path.endsWith('/complete')) {
      const index = Number(path.match(/(\d{12})\/complete$/)[1]);
      completed.push(index);
      if (index === 2) return Response.json({ error: { code: 'VALIDATION_ERROR', field: 'file_structure' } }, { status: 422 });
      return Response.json({ media: [{ media_id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}` }] });
    }
    throw new Error('예상하지 못한 경로');
  });
  const selected = Array.from({ length: 3 }, (_, index) => ({
    file: new File([new Uint8Array([index + 1, 2, 3])], `synthetic-${index + 1}.jpg`, { type: 'image/jpeg' }),
    keys: { itemId: crypto.randomUUID(), initKey: crypto.randomUUID(), partKey: crypto.randomUUID(), completeKey: crypto.randomUUID() },
  }));
  const outcome = await api.uploadEach(selected);
  assert.equal(sessions.length, 3);
  assert.deepEqual(completed, [1, 2, 3]);
  assert.equal(outcome.results.filter((result) => result.mediaId).length, 2);
  assert.match(outcome.results[1].error, /내부 구조/);
});

test('거부된 세션은 complete로 진행하지 않고 실패 파일의 다음 수동 재시도 키만 교체함', async () => {
  const calls = [];
  const api = new HaejumiApi('synthetic-token', async (path) => {
    calls.push(path);
    return Response.json({ upload_id: '11111111-1111-4111-8111-111111111111', status: 'rejected',
      accepted_items: [{ received_parts: [1] }] });
  });
  const entry = { file: new File([new Uint8Array([1, 2, 3])], 'synthetic.jpg', { type: 'image/jpeg' }),
    keys: { itemId: crypto.randomUUID(), initKey: crypto.randomUUID(), partKey: crypto.randomUUID(), completeKey: crypto.randomUUID() } };
  let finalUpdate;
  const outcome = await api.uploadEach([entry], { onItem: (_index, update) => { finalUpdate = update; } });
  assert.deepEqual(calls, ['/api/v1/media/uploads']);
  assert.equal(outcome.results[0].mediaId, null);
  assert.equal(finalUpdate.status, '실패');
  assert.notEqual(finalUpdate.keys.initKey, entry.keys.initKey);
  assert.equal(finalUpdate.keys.itemId, entry.keys.itemId);
});

test('구조 검증 422는 다음 수동 재시도에 새 세션 키를 주고 성공 파일 키는 유지함', async () => {
  const api = new HaejumiApi('synthetic-token');
  const selected = items(2);
  selected.forEach((entry) => { entry.keys.initKey = crypto.randomUUID(); });
  api.upload = async (file) => {
    if (file.name.includes('1')) throw new ApiError(422, 'VALIDATION_ERROR', 1, 'file_structure');
    return 'media-success';
  };
  const updates = [];
  const result = await api.uploadEach(selected, { onItem: (index, update) => updates.push({ index, ...update }) });
  assert.equal(result.results[1].mediaId, 'media-success');
  assert.notEqual(updates.find((update) => update.index === 0 && update.status === '실패').keys.initKey, selected[0].keys.initKey);
  assert.equal(updates.find((update) => update.index === 1 && update.status === '완료').keys, undefined);
});
