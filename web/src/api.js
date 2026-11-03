const FILE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const MAX_FILE = 50 * 1024 * 1024;

export function safeId(value) {
  if (!UUID.test(value)) throw new Error('서버 식별자가 올바르지 않습니다.');
  return value;
}

export function checkFile(file) {
  if (!file || !FILE_TYPES.has(file.type) || file.size < 1 || file.size > MAX_FILE ||
      file.name.includes('/') || file.name.includes('\\')) {
    throw new Error('JPEG·PNG·WebP·MP4·MOV 형식의 50 MiB 이하 파일을 선택해 주세요.');
  }
  return file;
}

export async function sha256(bytes) {
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), (item) => item.toString(16).padStart(2, '0')).join('');
}

export async function manifestHash(itemId, hash, size) {
  safeId(itemId);
  if (!SHA256.test(hash) || !Number.isSafeInteger(size) || size < 1) throw new Error('파일 확인 정보가 올바르지 않습니다.');
  const manifest = JSON.stringify([{ client_item_id: itemId, sha256: hash, size_bytes: size }]);
  return sha256(new TextEncoder().encode(manifest));
}

export class ApiError extends Error {
  constructor(status, code) {
    super(status === 401 ? '인증에 실패했습니다. 토큰을 다시 확인해 주세요.' :
      status === 409 ? '다른 기기에서 작업이 변경됐을 수 있습니다. 최신 상태를 다시 불러와 주세요.' :
      `서버 요청에 실패했습니다. (HTTP ${status})`);
    this.status = status;
    this.code = code;
  }
}

export class HaejumiApi {
  constructor(token, fetcher = (...args) => globalThis.fetch(...args)) {
    if (!token || /\s/.test(token)) throw new Error('인증 토큰을 입력해 주세요.');
    this.token = token;
    this.fetcher = fetcher;
  }

  async request(path, { method = 'GET', body, key, signal, binary = false } = {}) {
    if (!path.startsWith('/api/v1/') || path.includes('..')) throw new Error('허용되지 않은 API 경로입니다.');
    const headers = { Authorization: `Bearer ${this.token}` };
    if (key) headers['Idempotency-Key'] = key;
    if (body !== undefined) headers['Content-Type'] = body instanceof ArrayBuffer ? 'application/octet-stream' : 'application/json';
    const response = await this.fetcher(path, { method, headers, body: body instanceof ArrayBuffer ? body : body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal });
    if (!response.ok) {
      let code;
      try { code = (await response.json()).error?.code; } catch { /* Do not display server bodies. */ }
      throw new ApiError(response.status, code);
    }
    return binary ? response : response.status === 204 ? {} : response.json();
  }

  capabilities() { return this.request('/api/v1/capabilities'); }
  projects() { return this.request('/api/v1/content/projects'); }
  task(id) { return this.request(`/api/v1/tasks/${safeId(id)}`); }
  project(id) { return this.request(`/api/v1/content/projects/${safeId(id)}`); }
  checkpoints(id) { return this.request(`/api/v1/tasks/${safeId(id)}/checkpoints`); }
  plan(id) { return this.request(`/api/v1/tasks/${safeId(id)}/plan`); }
  draft(id) { return this.request(`/api/v1/tasks/${safeId(id)}/draft`); }
  jobs(id) { return this.request(`/api/v1/tasks/${safeId(id)}/jobs`); }
  tracks() { return this.request('/api/v1/music/tracks'); }
  updateDraft(id, body, key = crypto.randomUUID()) { return this.request(`/api/v1/tasks/${safeId(id)}/draft`, { method: 'PATCH', key, body }); }
  message(text, taskId) { return this.request('/api/v1/assistant/messages', { method: 'POST', key: crypto.randomUUID(),
    body: { text, input_kind: 'typed_text', ...(taskId ? { task_id: safeId(taskId) } : {}) } }); }
  revisePlan(id, version, text, key = crypto.randomUUID()) { return this.request(`/api/v1/tasks/${safeId(id)}/plan`, {
    method: 'POST', key, body: { content_version: version, request_text: text } }); }
  approve(id, checkpoint, key = crypto.randomUUID()) { return this.request(`/api/v1/tasks/${safeId(id)}/approvals`, {
    method: 'POST', key, body: { checkpoint_id: safeId(checkpoint.checkpoint_id), content_version: checkpoint.content_version,
      content_hash: checkpoint.content_hash, approval_scope: 'continue' } }); }
  updateScenes(id, task, scenes, key = crypto.randomUUID()) { return this.request(`/api/v1/tasks/${safeId(id)}/plan`, {
    method: 'PUT', key, body: { content_version: task.current_version, content_hash: task.content_hash, scenes } }); }
  render(id, task, key = crypto.randomUUID()) { return this.request(`/api/v1/tasks/${safeId(id)}/render`, {
    method: 'POST', key, body: { content_version: task.current_version, content_hash: task.content_hash } }); }
  cancel(jobId, key = crypto.randomUUID()) { return this.request(`/api/v1/jobs/${safeId(jobId)}/cancel`, { method: 'POST', key }); }

  async upload(file, { signal, onStep = () => {}, keys = {} } = {}) {
    checkFile(file);
    const bytes = await file.arrayBuffer();
    if (signal?.aborted) throw new DOMException('취소했습니다.', 'AbortError');
    const hash = await sha256(bytes);
    const itemId = keys.itemId ?? crypto.randomUUID();
    const init = await this.request('/api/v1/media/uploads', { method: 'POST', key: keys.initKey ?? crypto.randomUUID(), signal,
      body: { items: [{ client_item_id: itemId, file_name: file.name, declared_media_type: file.type, size_bytes: file.size, sha256: hash }] } });
    onStep('파일을 전송하고 있습니다.');
    await this.request(`/api/v1/media/uploads/${safeId(init.upload_id)}/parts/1`, { method: 'PUT', key: keys.partKey ?? crypto.randomUUID(), body: bytes, signal });
    onStep('서버에서 파일을 검사하고 있습니다.');
    const completed = await this.request(`/api/v1/media/uploads/${safeId(init.upload_id)}/complete`, { method: 'POST', key: keys.completeKey ?? crypto.randomUUID(), signal,
      body: { manifest_sha256: await manifestHash(itemId, hash, file.size) } });
    return completed.media[0].media_id;
  }

  async uploadMany(items, { signal, onStep = () => {}, keys = {} } = {}) {
    if (!Array.isArray(items) || items.length < 1 || items.length > 30) throw new Error('선택한 파일 수를 확인해 주세요.');
    if (items.length === 1) return [await this.upload(items[0].file, { signal, onStep, keys: items[0].keys })];
    const prepared = [];
    for (const item of items) {
      checkFile(item.file); safeId(item.keys.itemId);
      const bytes = await item.file.arrayBuffer();
      if (signal?.aborted) throw new DOMException('취소했습니다.', 'AbortError');
      prepared.push({ item, bytes, hash: await sha256(bytes) });
    }
    const manifest = prepared.map(({ item, hash }) => ({ client_item_id: item.keys.itemId, sha256: hash, size_bytes: item.file.size }));
    const init = await this.request('/api/v1/media/uploads', { method: 'POST', key: keys.initKey ?? crypto.randomUUID(), signal,
      body: { items: prepared.map(({ item, hash }) => ({ client_item_id: item.keys.itemId, file_name: item.file.name,
        declared_media_type: item.file.type, size_bytes: item.file.size, sha256: hash })) } });
    for (let index = 0; index < prepared.length; index++) {
      onStep(`${index + 1}/${prepared.length} 파일을 전송하고 있습니다.`);
      await this.request(`/api/v1/media/uploads/${safeId(init.upload_id)}/parts/${index + 1}`, { method: 'PUT', key: prepared[index].item.keys.partKey ?? crypto.randomUUID(), body: prepared[index].bytes, signal });
    }
    onStep('서버에서 선택한 모든 파일을 검사하고 있습니다.');
    const completed = await this.request(`/api/v1/media/uploads/${safeId(init.upload_id)}/complete`, { method: 'POST', key: keys.completeKey ?? crypto.randomUUID(), signal,
      body: { manifest_sha256: await sha256(new TextEncoder().encode(JSON.stringify(manifest))), items: manifest } });
    if (completed.media?.length !== items.length) throw new Error('서버의 미디어 결과 개수가 일치하지 않습니다.');
    return completed.media.map((entry) => safeId(entry.media_id));
  }

  createProject(mediaIds, key = crypto.randomUUID()) { return this.request('/api/v1/content/projects', {
    method: 'POST', key, body: { media_ids: (Array.isArray(mediaIds) ? mediaIds : [mediaIds]).map(safeId) } }); }

  async preview(taskId, version, expectedHash, signal) {
    if (!SHA256.test(expectedHash)) throw new Error('검증된 영상 해시가 없습니다.');
    const response = await this.request(`/api/v1/tasks/${safeId(taskId)}/preview?content_version=${version}`, { binary: true, signal });
    if (response.headers.get('content-type')?.split(';')[0] !== 'video/mp4' || response.headers.get('x-haejumi-render-mode') !== 'ffmpeg') {
      throw new Error('실제 MP4 렌더 결과가 아닙니다.');
    }
    const length = Number(response.headers.get('content-length'));
    if (!Number.isSafeInteger(length) || length < 1 || length > 512 * 1024 * 1024) throw new Error('미리보기 크기를 확인할 수 없습니다.');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== length || await sha256(bytes) !== expectedHash.toLowerCase()) throw new Error('영상 해시 검증에 실패했습니다.');
    return URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
  }
}
