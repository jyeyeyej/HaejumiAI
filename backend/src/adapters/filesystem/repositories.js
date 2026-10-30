import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isAllowedMediaType, isSafeDisplayName, sha256, validateMediaBytes } from '../../security/media-validation.js';

export class LocalRepositories {
  constructor({ state, dataDir, maxMediaBytes }) {
    this.state = state;
    this.blobDir = join(dataDir, 'media');
    this.uploadDir = join(dataDir, 'uploads');
    this.maxMediaBytes = maxMediaBytes;
    mkdirSync(this.blobDir, { recursive: true });
    mkdirSync(this.uploadDir, { recursive: true });
  }

  createUpload(ownerId, items, idempotencyKey) {
    if (!Array.isArray(items) || items.length !== 1) {
      throw apiError(422, 'VALIDATION_ERROR', '현재 참조 업로드 어댑터는 세션당 미디어 1개를 처리합니다.');
    }
    const item = items[0];
    if (!item || !isSafeDisplayName(item.file_name) || !isAllowedMediaType(item.declared_media_type) ||
        !Number.isSafeInteger(item.size_bytes) || item.size_bytes < 1 || item.size_bytes > this.maxMediaBytes ||
        !/^[a-f\d]{64}$/i.test(item.sha256 ?? '')) {
      throw apiError(422, 'VALIDATION_ERROR', '선택한 미디어 선언을 확인해 주세요.');
    }
    if (!isValidIdempotencyKey(idempotencyKey)) throw apiError(422, 'VALIDATION_ERROR', 'Idempotency-Key가 필요합니다.');
    const key = `${ownerId}:upload:${idempotencyKey}`;
    const fingerprint = JSON.stringify(item);
    const prior = this.state.data.idempotency[key];
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '멱등 키가 다른 요청에 사용되었습니다.');
      const existing = this.state.data.uploads[prior.uploadId];
      if (existing) return this.uploadResult(existing);
    }
    const uploadId = randomUUID();
    const clientItemId = item.client_item_id;
    this.state.data.uploads[uploadId] = {
      uploadId, ownerId, clientItemId, fileName: item.file_name,
      declaredType: item.declared_media_type, expectedSize: item.size_bytes,
      expectedSha256: item.sha256.toLowerCase(), partPath: join(this.uploadDir, `${uploadId}.part`),
      status: 'created', mediaId: null,
    };
    this.state.data.idempotency[key] = { fingerprint, uploadId };
    this.state.save();
    return this.uploadResult(this.state.data.uploads[uploadId]);
  }

  uploadResult(upload) {
    return { upload_id: upload.uploadId, status: upload.status, expires_at: new Date(Date.now() + 3600_000).toISOString(),
      accepted_items: [{ client_item_id: upload.clientItemId, received_parts: upload.status === 'created' ? [] : [1] }] };
  }

  putUploadPart(ownerId, uploadId, partNumber, bytes) {
    const upload = this.state.data.uploads[uploadId];
    if (!upload || upload.ownerId !== ownerId) throw apiError(404, 'RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.');
    if (partNumber !== 1 || upload.status === 'completed') throw apiError(409, 'INVALID_STATE_TRANSITION', '업로드 상태를 확인해 주세요.');
    if (!Buffer.isBuffer(bytes) || bytes.length > this.maxMediaBytes) throw apiError(413, 'PAYLOAD_TOO_LARGE', '허용 크기를 초과했습니다.');
    if (bytes.length !== upload.expectedSize) throw apiError(409, 'VERSION_CONFLICT', '선언한 파일 크기와 다릅니다.');
    writeFileSync(upload.partPath, bytes, { mode: 0o600 });
    upload.status = 'uploading';
    this.state.save();
  }

  completeUpload(ownerId, uploadId, manifest) {
    const upload = this.state.data.uploads[uploadId];
    if (!upload || upload.ownerId !== ownerId) throw apiError(404, 'RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.');
    if (upload.status === 'completed') return this.importResult(upload);
    if (upload.status !== 'uploading') throw apiError(409, 'INVALID_STATE_TRANSITION', '업로드 조각이 없습니다.');
    const bytes = readFileSync(upload.partPath);
    const validation = validateMediaBytes(bytes, upload.declaredType, upload.expectedSize, upload.expectedSha256, this.maxMediaBytes);
    if (!validation.ok) throw apiError(validation.code === 'VERSION_CONFLICT' ? 409 : validation.code === 'PAYLOAD_TOO_LARGE' ? 413 : 415,
      validation.code, '파일 형식·크기·해시 검증에 실패했습니다.');
    const expectedManifest = sha256(Buffer.from(JSON.stringify([{ client_item_id: upload.clientItemId, sha256: validation.sha256, size_bytes: bytes.length }])));
    if (!manifest || String(manifest.manifest_sha256 ?? '').toLowerCase() !== expectedManifest) {
      throw apiError(409, 'VERSION_CONFLICT', '업로드 manifest 해시가 일치하지 않습니다.');
    }
    const mediaId = randomUUID();
    const blobPath = join(this.blobDir, `${mediaId}.blob`);
    writeFileSync(blobPath, bytes, { flag: 'wx', mode: 0o600 });
    this.state.data.media[mediaId] = { mediaId, ownerId, mediaType: upload.declaredType, sizeBytes: bytes.length,
      sha256: validation.sha256, status: 'available', blobPath };
    upload.status = 'completed';
    upload.mediaId = mediaId;
    this.state.save();
    return this.importResult(upload);
  }

  importResult(upload) {
    const media = this.state.data.media[upload.mediaId];
    return { import_id: upload.uploadId, status: 'completed', manifest_sha256: sha256(Buffer.from(JSON.stringify([
      { client_item_id: upload.clientItemId, sha256: media.sha256, size_bytes: media.sizeBytes },
    ]))), media: [{ media_id: media.mediaId, media_type: media.mediaType, media_type_verified: true,
      size_bytes: media.sizeBytes, sha256: media.sha256, status: media.status }],
      proposal: { status: 'created', proposal_id: upload.uploadId } };
  }

  getOwnedMedia(ownerId, mediaId) {
    const media = this.state.data.media[mediaId];
    return media?.ownerId === ownerId ? media : null;
  }

  createForOwner(ownerId, mediaIds, idempotencyKey) {
    if (!Array.isArray(mediaIds) || mediaIds.length < 1 || new Set(mediaIds).size !== mediaIds.length || mediaIds.some((id) => !this.getOwnedMedia(ownerId, id))) {
      throw apiError(404, 'RESOURCE_NOT_FOUND', '선택한 미디어를 찾을 수 없습니다.');
    }
    if (!isValidIdempotencyKey(idempotencyKey)) throw apiError(422, 'VALIDATION_ERROR', 'Idempotency-Key가 필요합니다.');
    {
      const prior = this.state.data.idempotency[`${ownerId}:project:${idempotencyKey}`];
      if (prior) {
        if (prior.mediaIds.join(',') !== mediaIds.join(',')) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '멱등 키가 다른 요청에 사용되었습니다.');
        const existing = this.state.data.projects[prior.projectId];
        if (!existing) throw apiError(409, 'INVALID_STATE_TRANSITION', '기존 요청 상태를 복구할 수 없습니다.');
        const { ownerId: _ownerId, ...safeProject } = existing;
        return safeProject;
      }
    }
    const projectId = randomUUID();
    const taskId = randomUUID();
    const project = { project_id: projectId, task_id: taskId, status: 'created', current_version: 1, media_ids: mediaIds };
    this.state.data.projects[projectId] = { ...project, ownerId };
    this.state.data.tasks[taskId] = { task_id: taskId, project_id: projectId, ownerId, module_id: 'creator',
      capability_id: 'creator.project', status: 'created', current_version: 1, progress_percent: 0, next_action: 'none', created_at: new Date().toISOString() };
    this.state.data.idempotency[`${ownerId}:project:${idempotencyKey}`] = { projectId, mediaIds };
    this.state.save();
    return project;
  }

  async getOwnedTask(ownerId, taskId) {
    const task = this.state.data.tasks[taskId];
    if (!task || task.ownerId !== ownerId) return null;
    const { ownerId: _ownerId, ...safeTask } = task;
    return safeTask;
  }
}

function isValidIdempotencyKey(value) {
  return typeof value === 'string' && value.length >= 16 && value.length <= 200;
}

function apiError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
