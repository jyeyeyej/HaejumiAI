import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ensureStorageDirectory, safeStoragePath } from './storage-paths.js';
import { sha256 } from './media-validation.js';

const PLATFORMS = ['youtube', 'instagram', 'tiktok'];
const FORMATS = { wav: '.wav', mp3: '.mp3' };
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const hasKeys = (object, allowed) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every((key) => allowed.includes(key));

function checkRights(input) {
  const fields = ['source_url', 'license_name', 'license_version', 'license_url', 'evidence', 'downloaded_at', 'attribution_required', 'required_attribution', 'commercial_allowed', 'platforms', 'explicitly_verified'];
  if (!hasKeys(input, fields) || typeof input.source_url !== 'string' || input.source_url.length > 2000 ||
      typeof input.license_name !== 'string' || input.license_name.length > 300 ||
      typeof input.license_version !== 'string' || input.license_version.length > 200 ||
      typeof input.license_url !== 'string' || input.license_url.length > 2000 ||
      typeof input.evidence !== 'string' || input.evidence.length > 4000 ||
      typeof input.downloaded_at !== 'string' || (input.downloaded_at !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(input.downloaded_at) || !Number.isFinite(Date.parse(input.downloaded_at)) || new Date(input.downloaded_at).toISOString().slice(0, 10) !== input.downloaded_at)) ||
      typeof input.attribution_required !== 'boolean' || typeof input.required_attribution !== 'string' || input.required_attribution.length > 2000 ||
      typeof input.commercial_allowed !== 'boolean' || typeof input.explicitly_verified !== 'boolean' ||
      !Array.isArray(input.platforms) || new Set(input.platforms).size !== input.platforms.length ||
      input.platforms.some((item) => !PLATFORMS.includes(item))) throw fail(422, 'VALIDATION_ERROR', '음원 권리 정보를 확인해 주세요.');
  for (const value of [input.source_url, input.license_url]) {
    if (value) { try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); } catch { throw fail(422, 'VALIDATION_ERROR', '권리 출처 주소를 확인해 주세요.'); } }
  }
  if (input.explicitly_verified && (!input.source_url.trim() || !input.license_name.trim() || !input.license_version.trim() || !input.license_url.trim() || !input.evidence.trim() || !input.downloaded_at ||
      (input.attribution_required && !input.required_attribution.trim()) || !input.commercial_allowed || !input.platforms.length)) {
    throw fail(422, 'VALIDATION_ERROR', '권리 확인에는 출처, 라이선스, 증빙, 상업 이용 및 허용 플랫폼이 필요합니다.');
  }
  return structuredClone(input);
}

export class MusicLibrary {
  constructor({ state, dataDir, maxBytes }) {
    this.state = state;
    this.state.data.musicTracks ??= {};
    this.directory = ensureStorageDirectory(safeStoragePath(dataDir, 'music'), dataDir);
    this.maxBytes = maxBytes;
  }
  list(ownerId) { return { items: Object.values(this.state.data.musicTracks).filter((item) => item.owner_id === ownerId).map(publicTrack) }; }
  create(ownerId, input, key) {
    if (!validKey(key) || !hasKeys(input, ['title', 'artist', 'format', 'size_bytes', 'sha256', 'rights']) ||
        typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 ||
        typeof input.artist !== 'string' || !input.artist.trim() || input.artist.length > 200 || !Object.hasOwn(FORMATS, input.format) ||
        !Number.isSafeInteger(input.size_bytes) || input.size_bytes < 1 || input.size_bytes > this.maxBytes || !/^[a-f\d]{64}$/.test(input.sha256 ?? '')) {
      throw fail(422, 'VALIDATION_ERROR', '음원 파일 정보를 확인해 주세요.');
    }
    const rights = checkRights(input.rights);
    const fingerprint = JSON.stringify(input);
    const idempotency = `${ownerId}:music-create:${key}`;
    const prior = this.state.data.idempotency[idempotency];
    if (prior) { if (prior.fingerprint !== fingerprint) throw fail(409, 'IDEMPOTENCY_CONFLICT', '이미 사용한 요청 키입니다.'); return publicTrack(this.state.data.musicTracks[prior.trackId]); }
    const item = { track_id: randomUUID(), owner_id: ownerId, title: input.title.trim(), artist: input.artist.trim(), format: input.format,
      size_bytes: input.size_bytes, sha256: input.sha256, rights, rights_revision: 1, status: 'awaiting_upload' };
    this.state.data.musicTracks[item.track_id] = item;
    this.state.data.idempotency[idempotency] = { fingerprint, trackId: item.track_id };
    this.state.save();
    return publicTrack(item);
  }
  upload(ownerId, trackId, bytes, key) {
    const item = this.owned(ownerId, trackId);
    if (!validKey(key)) throw fail(422, 'VALIDATION_ERROR', '요청 키가 필요합니다.');
    if (!Buffer.isBuffer(bytes) || bytes.length !== item.size_bytes || sha256(bytes) !== item.sha256) throw fail(409, 'VERSION_CONFLICT', '음원 크기 또는 해시가 일치하지 않습니다.');
    const signature = item.format === 'wav' ? bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE' :
      bytes.length >= 3 && (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
    if (!signature) throw fail(415, 'UNSUPPORTED_MEDIA_TYPE', '지원하는 음원 형식을 확인해 주세요.');
    if (item.status === 'available') { this.path(ownerId, trackId); return publicTrack(item); }
    if (item.status !== 'awaiting_upload') throw fail(409, 'INVALID_STATE_TRANSITION', '음원을 등록할 수 없는 상태입니다.');
    const fileName = item.track_id + FORMATS[item.format];
    writeFileSync(safeStoragePath(this.directory, fileName), bytes, { flag: 'wx', mode: 0o600 });
    item.storage_key = fileName; item.status = 'available'; this.state.save();
    return publicTrack(item);
  }
  updateRights(ownerId, trackId, input, key) {
    const item = this.owned(ownerId, trackId);
    if (!validKey(key) || !hasKeys(input, ['rights_revision', 'rights']) || !Number.isSafeInteger(input.rights_revision)) throw fail(422, 'VALIDATION_ERROR', '음원 권리 수정 요청을 확인해 주세요.');
    const rights = checkRights(input.rights);
    const fingerprint = JSON.stringify(input);
    const idempotency = `${ownerId}:music-rights:${trackId}:${key}`;
    const prior = this.state.data.idempotency[idempotency];
    if (prior) { if (prior.fingerprint !== fingerprint) throw fail(409, 'IDEMPOTENCY_CONFLICT', '이미 사용한 요청 키입니다.'); return structuredClone(prior.result); }
    if (item.rights_revision !== input.rights_revision) throw fail(409, 'VERSION_CONFLICT', '음원 권리 정보가 변경되었습니다.');
    item.rights = rights; item.rights_revision += 1;
    const taskIds = new Set(Object.values(this.state.data.projects).filter((p) => p.ownerId === ownerId && p.composition?.music_track_id === trackId).map((p) => p.task_id));
    for (const approval of Object.values(this.state.data.approvals)) if (taskIds.has(approval.task_id) && approval.approval_scope === 'final_publish' && approval.status === 'active') approval.status = 'invalidated';
    for (const publication of Object.values(this.state.data.publications)) if (taskIds.has(publication.task_id) && publication.owner_id === ownerId) { publication.status = 'draft'; publication.approval_id = null; }
    const result = publicTrack(item); this.state.data.idempotency[idempotency] = { fingerprint, result }; this.state.save(); return result;
  }
  owned(ownerId, trackId) {
    const item = this.state.data.musicTracks[trackId];
    if (!item || item.owner_id !== ownerId) throw fail(404, 'RESOURCE_NOT_FOUND', '음원을 찾을 수 없습니다.');
    return item;
  }
  path(ownerId, trackId) {
    const item = this.owned(ownerId, trackId);
    if (item.status !== 'available' || item.storage_key !== item.track_id + FORMATS[item.format]) throw fail(409, 'INVALID_STATE_TRANSITION', '등록된 음원 파일이 필요합니다.');
    const path = safeStoragePath(this.directory, item.storage_key);
    let stat; try { stat = lstatSync(path); } catch { throw fail(409, 'VERSION_CONFLICT', '음원 파일을 확인할 수 없습니다.'); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.size_bytes || sha256(readFileSync(path)) !== item.sha256) throw fail(409, 'VERSION_CONFLICT', '음원 파일이 변경되었습니다.');
    return path;
  }
  assertPublishable(ownerId, trackId, platform, publication = null) {
    const item = this.owned(ownerId, trackId); this.path(ownerId, trackId);
    const rights = item.rights;
    if (!rights?.explicitly_verified || !rights.commercial_allowed || !rights.source_url?.trim() || !rights.license_name?.trim() || !rights.license_version?.trim() || !rights.license_url?.trim() || !rights.evidence?.trim() || !rights.downloaded_at ||
        (rights.attribution_required && (!rights.required_attribution?.trim() || typeof publication?.description !== 'string' || !publication.description.includes(rights.required_attribution))) || !rights.platforms?.includes(platform)) {
      throw fail(403, 'RIGHTS_REVIEW_REQUIRED', '대상 플랫폼의 상업 이용 권리와 증빙을 확인해 주세요.');
    }
    return item;
  }
}
function validKey(key) { return typeof key === 'string' && key.length >= 16 && key.length <= 200; }
function publicTrack(item) { const { owner_id: _owner, storage_key: _storage, ...result } = item; return structuredClone({ ...result, rights_status: item.rights?.explicitly_verified ? 'user_verified' : 'unverified' }); }
