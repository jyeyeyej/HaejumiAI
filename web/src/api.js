const FILE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const MAX_FILE = 50 * 1024 * 1024;
const PERSONAL_PATHS = new Set(['schedule/events', 'wellness/entries', 'diaries/drafts', 'diaries/entries']);
const personalPath = (kind) => { if (!PERSONAL_PATHS.has(kind)) throw new Error('허용되지 않은 기능입니다.'); return `/api/v1/${kind}`; };

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
  constructor(status, code, itemIndex = null, field = null) {
    super(status === 401 ? '인증에 실패했습니다. 토큰을 다시 확인해 주세요.' :
      code === 'IDEMPOTENCY_CONFLICT' ? '이전 요청과 파일 목록 또는 순서가 다릅니다. 다시 선택해 주세요.' :
      code === 'INVALID_STATE_TRANSITION' ? '업로드 세션이 만료되었거나 아직 전송되지 않은 파일이 있습니다. 다시 시도해 주세요.' :
      code === 'VERSION_CONFLICT' && field?.startsWith('file_') ? '전송된 파일의 크기나 해시가 처음 선택한 파일과 다릅니다. 다시 선택해 주세요.' :
      status === 409 ? '다른 기기에서 작업이 변경됐을 수 있습니다. 최신 상태를 다시 불러와 주세요.' :
      code === 'PAYLOAD_TOO_LARGE' ? '파일이 서버의 허용 크기를 초과했습니다. 파일당 최대 50 MiB인지 확인해 주세요.' :
      code === 'UNSUPPORTED_MEDIA_TYPE' ? '파일 확장자와 실제 형식이 맞는지 확인해 주세요. JPEG·PNG·WebP·MP4·MOV만 지원합니다.' :
      code === 'VALIDATION_ERROR' && field === 'file_structure' ? '사진 또는 영상의 내부 구조를 확인할 수 없습니다. 파일이 손상되지 않았는지 확인해 주세요.' :
      code === 'VALIDATION_ERROR' && field === 'file_name' ? '서버가 이 파일 이름을 안전하게 처리할 수 없습니다. 파일 이름을 변경한 뒤 다시 선택해 주세요.' :
      code === 'VALIDATION_ERROR' && field === 'size_bytes' ? '파일 크기 정보가 올바르지 않습니다. 다시 선택해 주세요.' :
      code === 'VALIDATION_ERROR' && field === 'sha256' ? '파일 해시 정보가 올바르지 않습니다. 다시 선택해 주세요.' :
      code === 'VALIDATION_ERROR' && field === 'client_item_id' ? '파일 식별자가 올바르지 않습니다. 선택을 취소하고 다시 선택해 주세요.' :
      code === 'VALIDATION_ERROR' ? '업로드 요청 형식이 서버 검증을 통과하지 못했습니다. 서버와 웹을 최신 버전으로 다시 실행해 주세요.' :
      `서버 요청에 실패했습니다. (HTTP ${status})`);
    this.status = status;
    this.code = code;
    this.itemIndex = Number.isSafeInteger(itemIndex) && itemIndex > 0 ? itemIndex : null;
    this.field = field;
  }
}

export class HaejumiApi {
  constructor(token, fetcher = (...args) => globalThis.fetch(...args), { session = false } = {}) {
    if (!session && (!token || /\s/.test(token))) throw new Error('인증 토큰을 입력해 주세요.');
    if (session && token) throw new Error('웹 세션에 Bearer 토큰을 보관할 수 없습니다.');
    this.token = token;
    this.fetcher = fetcher;
    this.session = session;
  }

  static webSession(fetcher = (...args) => globalThis.fetch(...args)) { return new HaejumiApi(null, fetcher, { session: true }); }

  static async signIn(token, fetcher = (...args) => globalThis.fetch(...args)) {
    const bearer = new HaejumiApi(token, fetcher);
    const response = await fetcher('/api/v1/auth/web-session', { method: 'POST',
      headers: { Authorization: `Bearer ${bearer.token}`, 'X-Haejumi-Web': '1' }, credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw new ApiError(response.status, 'AUTHENTICATION_REQUIRED');
    return HaejumiApi.webSession(fetcher);
  }

  status() { return this.request('/api/v1/auth/web-session'); }
  logout() { return this.request('/api/v1/auth/web-session', { method: 'DELETE' }); }

  async request(path, { method = 'GET', body, key, signal, binary = false } = {}) {
    if (!path.startsWith('/api/v1/') || path.includes('..')) throw new Error('허용되지 않은 API 경로입니다.');
    const headers = this.session ? {} : { Authorization: `Bearer ${this.token}` };
    if (this.session && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-Haejumi-Web'] = '1';
    if (key) headers['Idempotency-Key'] = key;
    if (body !== undefined) headers['Content-Type'] = body instanceof ArrayBuffer ? 'application/octet-stream' : 'application/json';
    const response = await this.fetcher(path, { method, headers, body: body instanceof ArrayBuffer ? body : body === undefined ? undefined : JSON.stringify(body),
      credentials: this.session ? 'same-origin' : 'omit', redirect: 'error', cache: 'no-store', signal });
    if (!response.ok) {
      let error = {};
      try { error = (await response.json()).error ?? {}; } catch { /* Do not display server bodies. */ }
      throw new ApiError(response.status, error.code, error.item_index, error.field);
    }
    return binary ? response : response.status === 204 ? {} : response.json();
  }

  capabilities() { return this.request('/api/v1/capabilities'); }
  history() { return this.request('/api/v1/assistant/history'); }
  clearHistory(key = crypto.randomUUID()) { return this.request('/api/v1/assistant/history', { method: 'DELETE', key }); }
  projects() { return this.request('/api/v1/content/projects'); }
  task(id) { return this.request(`/api/v1/tasks/${safeId(id)}`); }
  project(id) { return this.request(`/api/v1/content/projects/${safeId(id)}`); }
  trends(topic, days = 30) { if (!['restaurant', 'cafe', 'travel'].includes(topic) || !Number.isInteger(days) || days < 1 || days > 90) throw new Error('트렌드 검색 조건을 확인해 주세요.');
    return this.request(`/api/v1/trends/search?topic=${topic}&days=${days}`); }
  checkpoints(id) { return this.request(`/api/v1/tasks/${safeId(id)}/checkpoints`); }
  plan(id) { return this.request(`/api/v1/tasks/${safeId(id)}/plan`); }
  draft(id) { return this.request(`/api/v1/tasks/${safeId(id)}/draft`); }
  jobs(id) { return this.request(`/api/v1/tasks/${safeId(id)}/jobs`); }
  tracks() { return this.request('/api/v1/music/tracks'); }
  personalList(kind, date) { return this.request(`${personalPath(kind)}${date ? `?date=${encodeURIComponent(date)}` : ''}`); }
  personalCreate(kind, body, key = crypto.randomUUID()) { return this.request(personalPath(kind), { method: 'POST', body, key }); }
  personalEdit(kind, id, body, key = crypto.randomUUID()) { return this.request(`${personalPath(kind)}/${safeId(id)}`, { method: 'PATCH', body, key }); }
  personalDelete(kind, id, version, key = crypto.randomUUID()) { return this.request(`${personalPath(kind)}/${safeId(id)}`, { method: 'DELETE', body: { version }, key }); }
  wellnessSummary(from, to) { return this.request(`/api/v1/wellness/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`); }
  scheduleOccurrences(from, to) { return this.request(`/api/v1/schedule/occurrences?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`); }
  beginDiaryRevision(id, version, key = crypto.randomUUID()) { return this.request(`/api/v1/diaries/entries/${safeId(id)}/revisions`, { method: 'POST', body: { version }, key }); }
  diaryApproval(id, body, key = crypto.randomUUID()) { return this.request(`/api/v1/diaries/drafts/${safeId(id)}/approvals`, { method: 'POST', body, key }); }
  diaryFinalize(id, body, key = crypto.randomUUID()) { return this.request(`/api/v1/diaries/drafts/${safeId(id)}/finalize`, { method: 'POST', body, key }); }
  updateDraft(id, body, key = crypto.randomUUID()) { return this.request(`/api/v1/tasks/${safeId(id)}/draft`, { method: 'PATCH', key, body }); }
  message(text, taskId, consentId = null) { return this.request('/api/v1/assistant/messages', { method: 'POST', key: crypto.randomUUID(),
    body: { text, input_kind: 'typed_text', ...(taskId ? { task_id: safeId(taskId) } : {}),
      ...(consentId ? { privacy_consent_id: safeId(consentId) } : {}) } }); }
  confirmProposal(id, key = crypto.randomUUID()) { return this.request(`/api/v1/assistant/proposals/${safeId(id)}/confirm`, { method: 'POST', key }); }
  revisePlan(id, version, text, key = crypto.randomUUID(), consentId = null) { return this.request(`/api/v1/tasks/${safeId(id)}/plan`, {
    method: 'POST', key, body: { content_version: version, request_text: text, ...(consentId ? { privacy_consent_id: safeId(consentId) } : {}) } }); }
  approve(id, checkpoint, key = crypto.randomUUID()) { return this.request(`/api/v1/tasks/${safeId(id)}/approvals`, {
    method: 'POST', key, body: { checkpoint_id: safeId(checkpoint.checkpoint_id), content_version: checkpoint.content_version,
      content_hash: checkpoint.content_hash, approval_scope: 'continue' } }); }
  updateScenes(id, task, scenes, key = crypto.randomUUID()) { return this.request(`/api/v1/tasks/${safeId(id)}/plan`, {
    method: 'PUT', key, body: { content_version: task.current_version, content_hash: task.content_hash, scenes } }); }
  render(id, task, key = crypto.randomUUID()) { return this.request(`/api/v1/tasks/${safeId(id)}/render`, {
    method: 'POST', key, body: { content_version: task.current_version, content_hash: task.content_hash } }); }
  cancel(jobId, key = crypto.randomUUID()) { return this.request(`/api/v1/jobs/${safeId(jobId)}/cancel`, { method: 'POST', key }); }
  publications(taskId) { return this.request(`/api/v1/tasks/${safeId(taskId)}/publications`); }
  llmUsage() { return this.request('/api/v1/llm/usage'); }
  privacyNotice(purpose = 'llm_text') { return this.request(`/api/v1/privacy/processing-notice?provider_id=openai&purpose=${encodeURIComponent(purpose)}`); }
  consents() { return this.request('/api/v1/privacy/consents'); }
  grantTextConsent(notice, key = crypto.randomUUID()) { return this.request('/api/v1/privacy/consents', { method: 'POST', key,
    body: { provider_id: 'openai', purpose: 'llm_text', data_categories: ['user_text'], resource_ids: [],
      notice_id: notice.notice_id, notice_version: notice.notice_version, explicitly_confirmed: true,
      expires_at: new Date(Date.now() + 24 * 3600_000).toISOString() } }); }
  grantDiaryConsent(notice, sourceIds, key = crypto.randomUUID()) { return this.request('/api/v1/privacy/consents', { method: 'POST', key,
    body: { provider_id: 'openai', purpose: 'diary_draft', data_categories: ['user_text', 'schedule', 'wellness'],
      resource_ids: sourceIds.map(safeId), notice_id: notice.notice_id, notice_version: notice.notice_version,
      explicitly_confirmed: true, expires_at: new Date(Date.now() + 3600_000).toISOString() } }); }
  grantVisionConsent(notice, mediaIds, key = crypto.randomUUID()) { return this.request('/api/v1/privacy/consents', { method: 'POST', key,
    body: { provider_id: 'openai', purpose: 'vision_analysis', data_categories: ['selected_media', 'user_text'],
      resource_ids: mediaIds.map(safeId), notice_id: notice.notice_id, notice_version: notice.notice_version,
      explicitly_confirmed: true, expires_at: new Date(Date.now() + 3600_000).toISOString() } }); }
  revokeConsent(consentId, key = crypto.randomUUID()) { return this.request(`/api/v1/privacy/consents/${safeId(consentId)}`, { method: 'DELETE', key }); }
  createPublication(taskId, body, key = crypto.randomUUID()) { return this.request(`/api/v1/tasks/${safeId(taskId)}/publications`, { method: 'POST', key, body }); }
  updatePublication(taskId, publicationId, body, key = crypto.randomUUID()) { return this.request(`/api/v1/tasks/${safeId(taskId)}/publications/${safeId(publicationId)}`, { method: 'PATCH', key, body }); }
  approvePublication(taskId, publicationId, body, key = crypto.randomUUID()) { return this.request(`/api/v1/tasks/${safeId(taskId)}/publications/${safeId(publicationId)}/approvals`, { method: 'POST', key, body }); }

  async upload(file, { signal, onStep = () => {}, keys = {} } = {}) {
    checkFile(file);
    const bytes = await file.arrayBuffer();
    if (signal?.aborted) throw new DOMException('취소했습니다.', 'AbortError');
    const hash = await sha256(bytes);
    const itemId = keys.itemId ?? crypto.randomUUID();
    const init = await this.request('/api/v1/media/uploads', { method: 'POST', key: keys.initKey ?? crypto.randomUUID(), signal,
      body: { items: [{ client_item_id: itemId, file_name: file.name, declared_media_type: file.type, size_bytes: file.size, sha256: hash }] } });
    if (init.status !== 'completed' && !init.accepted_items?.[0]?.received_parts?.includes(1)) {
      onStep('파일을 전송하고 있습니다.');
      await this.request(`/api/v1/media/uploads/${safeId(init.upload_id)}/parts/1`, { method: 'PUT', key: keys.partKey ?? crypto.randomUUID(), body: bytes, signal });
    }
    onStep('서버에서 파일을 검사하고 있습니다.');
    const completed = await this.request(`/api/v1/media/uploads/${safeId(init.upload_id)}/complete`, { method: 'POST', key: keys.completeKey ?? crypto.randomUUID(), signal,
      body: { manifest_sha256: await manifestHash(itemId, hash, file.size) } });
    return completed.media[0].media_id;
  }

  async uploadMany(items, { signal, onStep = () => {}, onItem = () => {}, keys = {} } = {}) {
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
    onStep('서버에 업로드 세션을 만들고 있습니다.');
    const init = await this.request('/api/v1/media/uploads', { method: 'POST', key: keys.initKey ?? crypto.randomUUID(), signal,
      body: { items: prepared.map(({ item, hash }) => ({ client_item_id: item.keys.itemId, file_name: item.file.name,
        declared_media_type: item.file.type, size_bytes: item.file.size, sha256: hash })) } });
    if (init.status !== 'completed') for (let index = 0; index < prepared.length; index++) {
      if (init.accepted_items?.[index]?.received_parts?.includes(index + 1)) {
        onItem(index, '전송됨');
        continue;
      }
      onStep(`${index + 1}/${prepared.length} 파일을 전송하고 있습니다.`);
      onItem(index, '전송 중');
      try {
        await this.request(`/api/v1/media/uploads/${safeId(init.upload_id)}/parts/${index + 1}`, { method: 'PUT', key: prepared[index].item.keys.partKey ?? crypto.randomUUID(), body: prepared[index].bytes, signal });
        onItem(index, '전송됨');
      } catch (error) {
        onItem(index, '재시도 필요');
        if (error instanceof ApiError && !error.itemIndex) error.itemIndex = index + 1;
        throw error;
      }
    }
    onStep('서버에서 선택한 모든 파일을 검사하고 있습니다.');
    const completed = await this.request(`/api/v1/media/uploads/${safeId(init.upload_id)}/complete`, { method: 'POST', key: keys.completeKey ?? crypto.randomUUID(), signal,
      body: { manifest_sha256: await sha256(new TextEncoder().encode(JSON.stringify(manifest))), items: manifest } });
    if (completed.media?.length !== items.length) throw new Error('서버의 미디어 결과 개수가 일치하지 않습니다.');
    completed.media.forEach((_entry, index) => onItem(index, '완료'));
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
