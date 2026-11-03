import { lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { canonicalManifestBytes, extensionMatches, isAllowedMediaType, isSafeDisplayName, sha256, validateMediaBytes } from '../../security/media-validation.js';
import { ensureStorageDirectory, safeStoragePath } from '../../security/storage-paths.js';
import { MusicLibrary } from '../../security/music-library.js';
import { CAPTION_FONT_SHA256, CAPTION_TEXT_PATTERN } from '../../media-engine/caption-font.js';

export const PRIVACY_NOTICE_ID = '610ef7d0-c730-4de0-b24c-5b80e9241d11';
export const PRIVACY_NOTICE_VERSION = '1';

export class LocalRepositories {
  constructor({ state, dataDir, maxMediaBytes, maxSelectedMedia = 20, maxVisionImages = 5, videoFrameExtractor = null, imagePreparer = null }) {
    this.state = state;
    this.dataDir = ensureStorageDirectory(dataDir);
    this.blobDir = ensureStorageDirectory(safeStoragePath(this.dataDir, 'media'), this.dataDir);
    this.uploadDir = ensureStorageDirectory(safeStoragePath(this.dataDir, 'uploads'), this.dataDir);
    this.renderDir = ensureStorageDirectory(safeStoragePath(this.dataDir, 'renders'), this.dataDir);
    this.maxMediaBytes = maxMediaBytes;
    this.maxSelectedMedia = maxSelectedMedia;
    this.musicLibrary = new MusicLibrary({ state, dataDir: this.dataDir, maxBytes: maxMediaBytes });
    this.videoFrameExtractor = videoFrameExtractor;
    this.imagePreparer = imagePreparer;
    this.maxVisionImages = Number.isSafeInteger(maxVisionImages) && maxVisionImages > 0 ? maxVisionImages : 5;
  }

  listPrivacyConsents(ownerId) {
    return { items: Object.values(this.state.data.privacyConsents).filter((item) => item.owner_id === ownerId && item.status === 'active' && Date.parse(item.expires_at) > Date.now())
      .map(publicPrivacyConsent) };
  }

  createPrivacyConsent(ownerId, input, idempotencyKey) {
    if (!isValidIdempotencyKey(idempotencyKey)) throw apiError(422, 'VALIDATION_ERROR', 'Idempotency-Key가 필요합니다.');
    const validPurposes = ['llm_text', 'vision_analysis'];
    const categoriesByPurpose = { vision_analysis: ['selected_media', 'user_text'], llm_text: ['user_text'] };
    const expires = Date.parse(input?.expires_at);
    if (!input || Object.keys(input).some((key) => !['provider_id', 'purpose', 'data_categories', 'resource_ids', 'notice_id', 'notice_version', 'explicitly_confirmed', 'expires_at'].includes(key)) ||
        input.provider_id !== 'openai' || !validPurposes.includes(input.purpose) || !Array.isArray(input.data_categories) || !input.data_categories.length ||
        new Set(input.data_categories).size !== input.data_categories.length ||
        JSON.stringify([...input.data_categories].sort()) !== JSON.stringify([...((categoriesByPurpose[input.purpose]) ?? [])].sort()) ||
        (input.purpose === 'vision_analysis' && (!Array.isArray(input.resource_ids) || !input.resource_ids.length || new Set(input.resource_ids).size !== input.resource_ids.length || input.resource_ids.some((id) => !isUuid(id)))) ||
        (input.purpose === 'llm_text' && input.resource_ids != null && (!Array.isArray(input.resource_ids) || input.resource_ids.length !== 0)) ||
        input.notice_id !== PRIVACY_NOTICE_ID || input.notice_version !== PRIVACY_NOTICE_VERSION || input.explicitly_confirmed !== true ||
        !Number.isFinite(expires) || expires <= Date.now()) throw apiError(422, 'VALIDATION_ERROR', '제공자·목적·전송 범위·고지 확인을 검증할 수 없습니다.');
    for (const resourceId of input.resource_ids ?? []) {
      const media = this.state.data.media[resourceId];
      if (!media || media.ownerId !== ownerId || media.status !== 'available') throw apiError(404, 'RESOURCE_NOT_FOUND', '동의 대상 미디어를 찾을 수 없습니다.');
    }
    const key = `${ownerId}:privacy-consent:${idempotencyKey}`;
    const fingerprint = JSON.stringify(input);
    const prior = this.state.data.idempotency[key];
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '멱등 키가 다른 요청에 사용되었습니다.');
      return publicPrivacyConsent(this.state.data.privacyConsents[prior.consent_id]);
    }
    const consent = { consent_id: randomUUID(), owner_id: ownerId, provider_id: input.provider_id, purpose: input.purpose,
      data_categories: [...input.data_categories], resource_ids: [...(input.resource_ids ?? [])], notice_id: input.notice_id, notice_version: input.notice_version,
      explicitly_confirmed: true, expires_at: new Date(expires).toISOString(), status: 'active', created_at: new Date().toISOString() };
    this.state.data.privacyConsents[consent.consent_id] = consent;
    this.state.data.idempotency[key] = { fingerprint, consent_id: consent.consent_id };
    this.state.save();
    return publicPrivacyConsent(consent);
  }

  revokePrivacyConsent(ownerId, consentId) {
    const consent = this.state.data.privacyConsents[consentId];
    if (!consent || consent.owner_id !== ownerId) return false;
    consent.status = 'revoked'; consent.revoked_at = new Date().toISOString(); this.state.save(); return true;
  }

  verifyPrivacyConsent({ ownerId, consentId, providerId, purpose, dataCategories, resourceIds = [] }) {
    const consent = this.state.data.privacyConsents[consentId];
    if (!consent || consent.owner_id !== ownerId || consent.status !== 'active' || Date.parse(consent.expires_at) <= Date.now() ||
        consent.provider_id !== providerId || consent.purpose !== purpose || !consent.explicitly_confirmed ||
        !dataCategories.every((category) => consent.data_categories.includes(category)) ||
        (purpose === 'vision_analysis' && JSON.stringify([...resourceIds].sort()) !== JSON.stringify([...(consent.resource_ids ?? [])].sort())) ||
        (purpose === 'llm_text' && (consent.resource_ids?.length ?? 0) > 0)) return false;
    for (const resourceId of resourceIds) {
      const media = this.state.data.media[resourceId];
      if (!media || media.ownerId !== ownerId || media.status !== 'available') return false;
    }
    return true;
  }

  createUpload(ownerId, items, idempotencyKey) {
    if (!Array.isArray(items) || items.length < 1 || items.length > this.maxSelectedMedia ||
        new Set(items.map((entry) => String(entry?.client_item_id ?? '').toLowerCase())).size !== items.length) throw apiError(422, 'VALIDATION_ERROR', '선택한 미디어 개수를 확인해 주세요.');
    if (items.length > 1) return this.createMultiUpload(ownerId, items, idempotencyKey);
    const item = items[0];
    if (!item || !isSafeDisplayName(item.file_name) || !Number.isSafeInteger(item.size_bytes) || item.size_bytes < 1 ||
        !/^[a-f\d]{64}$/i.test(item.sha256 ?? '') || !isUuid(item.client_item_id)) {
      throw apiError(422, 'VALIDATION_ERROR', '선택한 미디어 선언을 확인해 주세요.');
    }
    if (item.size_bytes > this.maxMediaBytes) throw apiError(413, 'PAYLOAD_TOO_LARGE', '허용 크기를 초과했습니다.');
    if (!isAllowedMediaType(item.declared_media_type) || !extensionMatches(item.file_name, item.declared_media_type)) {
      throw apiError(415, 'UNSUPPORTED_MEDIA_TYPE', '파일 확장자와 선언한 미디어 형식이 일치하지 않습니다.');
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
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    this.state.data.uploads[uploadId] = {
      uploadId, ownerId, clientItemId, fileName: item.file_name,
      declaredType: item.declared_media_type, expectedSize: item.size_bytes,
      expectedSha256: item.sha256.toLowerCase(),
      status: 'created', mediaId: null, expiresAt,
    };
    this.state.data.idempotency[key] = { fingerprint, uploadId };
    this.state.save();
    return this.uploadResult(this.state.data.uploads[uploadId]);
  }

  uploadResult(upload) {
    if (upload.items) return { upload_id: upload.uploadId, status: upload.status, expires_at: upload.expiresAt,
      accepted_items: upload.items.map((item, index) => ({ client_item_id: item.clientItemId, received_parts: item.partHash ? [index + 1] : [] })) };
    return { upload_id: upload.uploadId, status: upload.status, expires_at: upload.expiresAt,
      accepted_items: [{ client_item_id: upload.clientItemId, received_parts: upload.status === 'created' ? [] : [1] }] };
  }

  putUploadPart(ownerId, uploadId, partNumber, bytes, idempotencyKey) {
    const upload = this.state.data.uploads[uploadId];
    if (!upload || upload.ownerId !== ownerId) throw apiError(404, 'RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.');
    if (upload.items) return this.putMultiUploadPart(ownerId, upload, partNumber, bytes, idempotencyKey);
    if (!['created', 'uploading'].includes(upload.status)) throw apiError(409, 'INVALID_STATE_TRANSITION', '업로드 상태를 확인해 주세요.');
    if (Date.parse(upload.expiresAt) <= Date.now()) {
      upload.status = 'expired';
      this.state.save();
      removeRegularFile(safeStoragePath(this.uploadDir, `${uploadId}.part`));
      throw apiError(409, 'INVALID_STATE_TRANSITION', '업로드 세션이 만료되었습니다.');
    }
    if (partNumber !== 1) throw apiError(409, 'INVALID_STATE_TRANSITION', '현재 업로드 계약은 part 1만 지원합니다.');
    if (!Buffer.isBuffer(bytes) || bytes.length > this.maxMediaBytes) throw apiError(413, 'PAYLOAD_TOO_LARGE', '허용 크기를 초과했습니다.');
    if (bytes.length !== upload.expectedSize) throw apiError(409, 'VERSION_CONFLICT', '선언한 파일 크기와 다릅니다.');
    if (!isValidIdempotencyKey(idempotencyKey)) throw apiError(422, 'VALIDATION_ERROR', 'Idempotency-Key가 필요합니다.');
    const partHash = sha256(bytes);
    const requestKey = `${ownerId}:part:${idempotencyKey}`;
    const prior = this.state.data.idempotency[requestKey];
    if (prior && prior.fingerprint !== `${uploadId}:1:${partHash}`) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '멱등 키가 다른 요청에 사용되었습니다.');
    if (upload.partHash && upload.partHash !== partHash) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '이미 저장된 조각과 내용이 다릅니다.');
    if (prior) return;
    const partPath = safeStoragePath(this.uploadDir, `${uploadId}.part`);
    if (upload.partHash === partHash) {
      try {
        if (sha256(readRegularFile(partPath)) === partHash) {
          this.state.data.idempotency[requestKey] = { fingerprint: `${uploadId}:1:${partHash}` };
          this.state.save();
          return;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { writeFileSync(partPath, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code === 'EEXIST') {
        try {
          if (sha256(readRegularFile(partPath)) === partHash) {
            upload.status = 'uploading'; upload.partHash = partHash;
            this.state.data.idempotency[requestKey] = { fingerprint: `${uploadId}:1:${partHash}` };
            this.state.save();
            return;
          }
        } catch { /* A conflicting or unsafe file must not be overwritten. */ }
        throw apiError(409, 'INVALID_STATE_TRANSITION', '업로드 조각이 이미 존재합니다.');
      }
      throw error;
    }
    upload.status = 'uploading';
    upload.partHash = partHash;
    this.state.data.idempotency[requestKey] = { fingerprint: `${uploadId}:1:${partHash}` };
    this.state.save();
  }

  completeUpload(ownerId, uploadId, manifest, idempotencyKey) {
    const upload = this.state.data.uploads[uploadId];
    if (!upload || upload.ownerId !== ownerId) throw apiError(404, 'RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.');
    if (upload.items) return this.completeMultiUpload(ownerId, upload, manifest, idempotencyKey);
    if (!isValidIdempotencyKey(idempotencyKey)) throw apiError(422, 'VALIDATION_ERROR', 'Idempotency-Key가 필요합니다.');
    if (upload.status !== 'completed' && Date.parse(upload.expiresAt) <= Date.now()) {
      upload.status = 'expired';
      this.state.save();
      removeRegularFile(safeStoragePath(this.uploadDir, `${uploadId}.part`));
      throw apiError(409, 'INVALID_STATE_TRANSITION', '업로드 세션이 만료되었습니다.');
    }
    const requestKey = `${ownerId}:complete:${idempotencyKey}`;
    const fingerprint = `${uploadId}:${String(manifest?.manifest_sha256 ?? '').toLowerCase()}`;
    const prior = this.state.data.idempotency[requestKey];
    if (prior && prior.fingerprint !== fingerprint) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '멱등 키가 다른 요청에 사용되었습니다.');
    if (upload.status === 'completed') {
      if (upload.manifestSha256 !== String(manifest?.manifest_sha256 ?? '').toLowerCase()) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '완료된 업로드 manifest가 다릅니다.');
      const media = this.state.data.media[upload.mediaId];
      if (manifest.items !== undefined && !mediaItemsMatch(manifest.items, upload, media.sha256, media.sizeBytes)) {
        throw apiError(409, 'VERSION_CONFLICT', 'manifest 항목이 완료된 미디어와 일치하지 않습니다.');
      }
      if (!prior) this.state.data.idempotency[requestKey] = { fingerprint };
      this.state.save();
      return this.importResult(upload);
    }
    if (upload.status !== 'uploading') throw apiError(409, 'INVALID_STATE_TRANSITION', '업로드 조각이 없습니다.');
    const partPath = safeStoragePath(this.uploadDir, `${uploadId}.part`);
    const bytes = readRegularFile(partPath);
    const validation = validateMediaBytes(bytes, upload.declaredType, upload.expectedSize, upload.expectedSha256, this.maxMediaBytes, upload.fileName);
    if (!validation.ok) {
      upload.status = 'rejected';
      this.state.save();
      removeRegularFile(partPath);
      const status = validation.code === 'VERSION_CONFLICT' ? 409 : validation.code === 'PAYLOAD_TOO_LARGE' ? 413
        : validation.code === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : 422;
      throw apiError(status, validation.code, '파일 형식·내용·크기·해시 검증에 실패했습니다.');
    }
    const expectedManifest = sha256(canonicalManifestBytes([{ client_item_id: upload.clientItemId, sha256: validation.sha256, size_bytes: bytes.length }]));
    if (!manifest || String(manifest.manifest_sha256 ?? '').toLowerCase() !== expectedManifest) {
      throw apiError(409, 'VERSION_CONFLICT', '업로드 manifest 해시가 일치하지 않습니다.');
    }
    if (manifest.items !== undefined && !mediaItemsMatch(manifest.items, upload, validation.sha256, bytes.length)) {
      throw apiError(409, 'VERSION_CONFLICT', 'manifest 항목이 업로드 선언과 일치하지 않습니다.');
    }
    const manifestKey = `${ownerId}:manifest:${expectedManifest}`;
    const existingImport = this.state.data.idempotency[manifestKey];
    if (existingImport) {
      upload.status = 'completed';
      upload.mediaId = existingImport.mediaId;
      upload.importId = existingImport.importId;
      upload.proposalId = existingImport.proposalId;
      upload.proposalStatus = 'already_created';
      upload.manifestSha256 = expectedManifest;
      this.state.data.idempotency[requestKey] = { fingerprint };
      this.state.save();
      removeRegularFile(partPath);
      return this.importResult(upload);
    }
    const mediaId = randomUUID();
    const importId = randomUUID();
    const proposalId = randomUUID();
    const blobPath = safeStoragePath(this.blobDir, `${mediaId}.blob`);
    writeFileSync(blobPath, bytes, { flag: 'wx', mode: 0o600 });
    this.state.data.media[mediaId] = { mediaId, ownerId, mediaType: upload.declaredType, fileName: upload.fileName, sizeBytes: bytes.length,
      sha256: validation.sha256, status: 'available', storageKey: `${mediaId}.blob` };
    upload.status = 'completed';
    upload.mediaId = mediaId;
    upload.importId = importId;
    upload.proposalId = proposalId;
    upload.proposalStatus = 'created';
    upload.manifestSha256 = expectedManifest;
    this.state.data.idempotency[requestKey] = { fingerprint };
    this.state.data.idempotency[manifestKey] = { mediaId, importId, proposalId };
    this.state.save();
    removeRegularFile(partPath);
    return this.importResult(upload);
  }

  importResult(upload) {
    const media = this.state.data.media[upload.mediaId];
    return { import_id: upload.importId ?? upload.uploadId, status: 'completed', manifest_sha256: sha256(canonicalManifestBytes([
      { client_item_id: upload.clientItemId, sha256: media.sha256, size_bytes: media.sizeBytes },
    ])), media: [{ media_id: media.mediaId, media_type: media.mediaType, media_type_verified: true,
      size_bytes: media.sizeBytes, sha256: media.sha256, status: media.status }],
      proposal: { status: upload.proposalStatus ?? 'created', proposal_id: upload.proposalId ?? upload.uploadId } };
  }

  createMultiUpload(ownerId, items, idempotencyKey) {
    if (!isValidIdempotencyKey(idempotencyKey)) throw apiError(422, 'VALIDATION_ERROR', 'Idempotency-Key가 필요합니다.');
    for (const item of items) {
      if (!item || !isSafeDisplayName(item.file_name) || !Number.isSafeInteger(item.size_bytes) || item.size_bytes < 1 ||
          !/^[a-f\d]{64}$/i.test(item.sha256 ?? '') || !isUuid(item.client_item_id)) throw apiError(422, 'VALIDATION_ERROR', '선택한 미디어 선언을 확인해 주세요.');
      if (item.size_bytes > this.maxMediaBytes) throw apiError(413, 'PAYLOAD_TOO_LARGE', '허용 크기를 초과했습니다.');
      if (!isAllowedMediaType(item.declared_media_type) || !extensionMatches(item.file_name, item.declared_media_type)) throw apiError(415, 'UNSUPPORTED_MEDIA_TYPE', '파일 형식을 확인해 주세요.');
    }
    const key = `${ownerId}:upload:${idempotencyKey}`;
    const fingerprint = JSON.stringify(items);
    const prior = this.state.data.idempotency[key];
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '멱등 키가 다른 요청에 사용되었습니다.');
      const existing = this.state.data.uploads[prior.uploadId];
      if (existing) return this.uploadResult(existing);
    }
    const uploadId = randomUUID();
    this.state.data.uploads[uploadId] = { uploadId, ownerId, status: 'created', expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      items: items.map((item) => ({ clientItemId: item.client_item_id, fileName: item.file_name, declaredType: item.declared_media_type,
        expectedSize: item.size_bytes, expectedSha256: item.sha256.toLowerCase(), partHash: null })) };
    this.state.data.idempotency[key] = { fingerprint, uploadId };
    this.state.save();
    return this.uploadResult(this.state.data.uploads[uploadId]);
  }

  putMultiUploadPart(ownerId, upload, partNumber, bytes, idempotencyKey) {
    if (upload.status === 'completed' || Date.parse(upload.expiresAt) <= Date.now()) throw apiError(409, 'INVALID_STATE_TRANSITION', '업로드 세션 상태를 확인해 주세요.');
    const item = upload.items[partNumber - 1];
    if (!item || !Number.isInteger(partNumber)) throw apiError(422, 'VALIDATION_ERROR', '업로드 항목 번호를 확인해 주세요.');
    if (!Buffer.isBuffer(bytes) || bytes.length > this.maxMediaBytes) throw apiError(413, 'PAYLOAD_TOO_LARGE', '허용 크기를 초과했습니다.');
    if (bytes.length !== item.expectedSize) throw apiError(409, 'VERSION_CONFLICT', '선언한 파일 크기와 다릅니다.');
    if (!isValidIdempotencyKey(idempotencyKey)) throw apiError(422, 'VALIDATION_ERROR', 'Idempotency-Key가 필요합니다.');
    const digest = sha256(bytes);
    if (digest !== item.expectedSha256) throw apiError(409, 'VERSION_CONFLICT', '선언한 파일 해시와 다릅니다.');
    const key = `${ownerId}:part:${idempotencyKey}`;
    const fingerprint = `${upload.uploadId}:${partNumber}:${digest}`;
    const prior = this.state.data.idempotency[key];
    if (prior && prior.fingerprint !== fingerprint) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '멱등 키가 다른 요청에 사용되었습니다.');
    if (item.partHash && item.partHash !== digest) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '이미 저장된 파일의 내용이 다릅니다.');
    const path = safeStoragePath(this.uploadDir, `${upload.uploadId}-${partNumber}.part`);
    if (item.partHash) {
      if (sha256(readRegularFile(path)) !== digest) throw apiError(409, 'VERSION_CONFLICT', '저장된 업로드 조각이 변경되었습니다.');
    } else {
      try { writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST' || sha256(readRegularFile(path)) !== digest) throw error;
      }
      item.partHash = digest; upload.status = 'uploading';
    }
    this.state.data.idempotency[key] = { fingerprint };
    this.state.save();
  }

  completeMultiUpload(ownerId, upload, manifest, idempotencyKey) {
    if (!isValidIdempotencyKey(idempotencyKey)) throw apiError(422, 'VALIDATION_ERROR', 'Idempotency-Key가 필요합니다.');
    const key = `${ownerId}:complete:${idempotencyKey}`;
    const declared = upload.items.map((item) => ({ client_item_id: item.clientItemId, sha256: item.expectedSha256, size_bytes: item.expectedSize }));
    const expectedHash = sha256(canonicalManifestBytes(declared));
    if (String(manifest?.manifest_sha256 ?? '').toLowerCase() !== expectedHash ||
        !Array.isArray(manifest?.items) || sha256(canonicalManifestBytes(manifest.items)) !== expectedHash) {
      throw apiError(409, 'VERSION_CONFLICT', '업로드 manifest 목록·순서·해시가 일치하지 않습니다.');
    }
    const prior = this.state.data.idempotency[key];
    const fingerprint = `${upload.uploadId}:${expectedHash}`;
    if (prior && prior.fingerprint !== fingerprint) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '멱등 키가 다른 요청에 사용되었습니다.');
    if (upload.status === 'completed') return this.multiImportResult(upload);
    if (Date.parse(upload.expiresAt) <= Date.now() || upload.items.some((item) => !item.partHash)) throw apiError(409, 'INVALID_STATE_TRANSITION', '업로드되지 않은 파일이 있습니다.');
    const validated = upload.items.map((item, index) => {
      const bytes = readRegularFile(safeStoragePath(this.uploadDir, `${upload.uploadId}-${index + 1}.part`));
      const result = validateMediaBytes(bytes, item.declaredType, item.expectedSize, item.expectedSha256, this.maxMediaBytes, item.fileName);
      if (!result.ok) throw apiError(result.code === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : 422, result.code, '파일 검증에 실패했습니다.');
      return { item, bytes, result };
    });
    const mediaIds = validated.map(() => randomUUID());
    validated.forEach(({ bytes }, index) => writeFileSync(safeStoragePath(this.blobDir, `${mediaIds[index]}.blob`), bytes, { flag: 'wx', mode: 0o600 }));
    validated.forEach(({ item, bytes, result }, index) => {
      const mediaId = mediaIds[index];
      this.state.data.media[mediaId] = { mediaId, ownerId, mediaType: item.declaredType, fileName: item.fileName,
        sizeBytes: bytes.length, sha256: result.sha256, status: 'available', storageKey: `${mediaId}.blob` };
    });
    upload.mediaIds = mediaIds; upload.manifestSha256 = expectedHash; upload.status = 'completed'; upload.importId = randomUUID();
    this.state.data.idempotency[key] = { fingerprint };
    this.state.save();
    return this.multiImportResult(upload);
  }

  multiImportResult(upload) {
    return { import_id: upload.importId, status: 'completed', manifest_sha256: upload.manifestSha256,
      media: upload.mediaIds.map((id) => { const media = this.state.data.media[id]; return { media_id: id, media_type: media.mediaType,
        media_type_verified: true, size_bytes: media.sizeBytes, sha256: media.sha256, status: media.status }; }),
      proposal: { status: 'suppressed' } };
  }

  getOwnedMedia(ownerId, mediaId) {
    const media = this.state.data.media[mediaId];
    return media?.ownerId === ownerId ? media : null;
  }

  createForOwner(ownerId, input, idempotencyKey) {
    const { media_ids: mediaIds, style, target_seconds: targetSeconds = 30, aspect_ratio: aspectRatio = '9:16' } = input ?? {};
    if (!Array.isArray(mediaIds) || mediaIds.length < 1 || mediaIds.length > this.maxSelectedMedia || new Set(mediaIds).size !== mediaIds.length || mediaIds.some((id) => !this.getOwnedMedia(ownerId, id))) {
      throw apiError(404, 'RESOURCE_NOT_FOUND', '선택한 미디어를 찾을 수 없습니다.');
    }
    const framing = input?.framing ?? 'fit_pad';
    const focalX = input?.focal_x ?? 0.5;
    const focalY = input?.focal_y ?? 0.5;
    if (!Number.isInteger(targetSeconds) || targetSeconds < 3 || targetSeconds >= 60 || aspectRatio !== '9:16' || !['fit_pad', 'fill_crop'].includes(framing) ||
        !Number.isFinite(focalX) || focalX < 0 || focalX > 1 || !Number.isFinite(focalY) || focalY < 0 || focalY > 1 ||
        (style !== undefined && (typeof style !== 'string' || style.length > 80))) {
      throw apiError(422, 'VALIDATION_ERROR', '프로젝트 설정을 확인해 주세요.');
    }
    if (!isValidIdempotencyKey(idempotencyKey)) throw apiError(422, 'VALIDATION_ERROR', 'Idempotency-Key가 필요합니다.');
    const requestFingerprint = JSON.stringify({ media_ids: mediaIds, style: style ?? null, target_seconds: targetSeconds, aspect_ratio: aspectRatio, framing, focal_x: focalX, focal_y: focalY });
    const requestKey = `${ownerId}:project:${idempotencyKey}`;
    const prior = this.state.data.idempotency[requestKey];
    if (prior) {
      if (prior.fingerprint !== requestFingerprint) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '멱등 키가 다른 요청에 사용되었습니다.');
      const existing = this.state.data.projects[prior.projectId];
      if (!existing) throw apiError(409, 'INVALID_STATE_TRANSITION', '기존 요청 상태를 복구할 수 없습니다.');
      return publicProject(existing);
    }
    const semanticKey = `${ownerId}:project-semantic:${sha256(Buffer.from(requestFingerprint))}`;
    const semanticPrior = this.state.data.idempotency[semanticKey];
    if (semanticPrior) {
      const existing = this.state.data.projects[semanticPrior.projectId];
      if (!existing) throw apiError(409, 'INVALID_STATE_TRANSITION', '기존 프로젝트 상태를 복구할 수 없습니다.');
      this.state.data.idempotency[requestKey] = { projectId: semanticPrior.projectId, fingerprint: requestFingerprint };
      this.state.save();
      return publicProject(existing);
    }
    const projectId = randomUUID();
    const taskId = randomUUID();
    const project = { project_id: projectId, task_id: taskId, ownerId, status: 'created', current_version: 1, media_ids: mediaIds,
      media_manifest: mediaIds.map((mediaId, index) => { const item = this.getOwnedMedia(ownerId, mediaId); return { order: index + 1, media_id: mediaId, sha256: item.sha256 }; }),
      target_seconds: targetSeconds, aspect_ratio: aspectRatio, framing, focal_x: focalX, focal_y: focalY };
    if (style !== undefined) project.style = style;
    const contentHash = this.contentHash(project);
    project.content_hash = contentHash;
    this.state.data.projects[projectId] = { ...project, ownerId };
    this.state.data.tasks[taskId] = { task_id: taskId, project_id: projectId, ownerId, module_id: 'creator',
      capability_id: 'creator.project', status: 'waiting_plan_approval', current_version: 1, content_hash: contentHash,
      progress_percent: 0, next_action: 'review_plan', created_at: new Date().toISOString() };
    const planCheckpointId = randomUUID();
    this.state.data.checkpoints[planCheckpointId] = { checkpoint_id: planCheckpointId, task_id: taskId, owner_id: ownerId, kind: 'plan', status: 'pending',
      content_version: 1, content_hash: contentHash, approval_scope: 'continue', summary: `선택 미디어 ${mediaIds.length}개, ${targetSeconds}초, ${framing} 프레이밍 계획을 확인해 주세요.` };
    this.state.data.idempotency[requestKey] = { projectId, fingerprint: requestFingerprint };
    this.state.data.idempotency[semanticKey] = { projectId, fingerprint: requestFingerprint };
    this.state.save();
    return publicProject(project);
  }

  async createCreatorPlan(ownerId, taskId, input, idempotencyKey, creatorAgent) {
    const task = this.state.data.tasks[taskId];
    if (!task || task.ownerId !== ownerId) throw apiError(404, 'RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.');
    const project = this.state.data.projects[task.project_id];
    if (!project || project.ownerId !== ownerId) throw apiError(404, 'RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.');
    if (!input || Object.keys(input).some((key) => !['content_version', 'request_text', 'privacy_consent_id'].includes(key)) ||
        (input.privacy_consent_id !== undefined && !isUuid(input.privacy_consent_id)) ||
        !Number.isSafeInteger(input.content_version) || typeof input.request_text !== 'string' || !input.request_text.trim() || input.request_text.length > 4000) {
      throw apiError(422, 'VALIDATION_ERROR', '현재 콘텐츠 버전과 기획 요청을 확인해 주세요.');
    }
    if (!isValidIdempotencyKey(idempotencyKey)) throw apiError(422, 'VALIDATION_ERROR', 'Idempotency-Key가 필요합니다.');
    const fingerprint = JSON.stringify({ task_id: taskId, content_version: input.content_version, request_text: input.request_text.trim(), privacy_consent_id: input.privacy_consent_id ?? null });
    const key = `${ownerId}:creator-plan:${idempotencyKey}`;
    const prior = this.state.data.idempotency[key];
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '멱등 키가 다른 요청에 사용되었습니다.');
      if (prior.result) return structuredClone(prior.result);
      throw apiError(409, 'INVALID_STATE_TRANSITION', '같은 기획 요청을 처리 중입니다.');
    }
    if (input.content_version !== task.current_version) throw apiError(409, 'VERSION_CONFLICT', '요청한 콘텐츠 버전이 최신 버전과 다릅니다.');
    if (!['waiting_plan_approval', 'waiting_draft_approval', 'render_ready', 'render_simulated', 'waiting_preview_approval', 'preview_approved'].includes(task.status) || task.active_job_id) {
      throw apiError(409, 'INVALID_STATE_TRANSITION', '현재 작업 상태에서는 기획을 생성하거나 수정할 수 없습니다.');
    }
    const expectedVersion = task.current_version;
    const media = project.media_ids.map((mediaId) => this.state.data.media[mediaId]);
    if (!media.length || media.some((item) => !item || item.ownerId !== ownerId || item.status !== 'available')) throw apiError(404, 'RESOURCE_NOT_FOUND', '선택한 프로젝트 미디어를 찾을 수 없습니다.');
    this.state.data.idempotency[key] = { fingerprint, status: 'generating' };
    this.state.save();
    try {
      const selectedMedia = [];
      let preparedImageCount = 0;
      for (const item of media) {
        const selected = { mediaId: item.mediaId, mediaType: item.mediaType };
        if (input.privacy_consent_id && preparedImageCount < this.maxVisionImages) {
          try {
            const bytes = readRegularFile(safeStoragePath(this.blobDir, item.storageKey));
            if (sha256(bytes) !== item.sha256) throw apiError(409, 'VERSION_CONFLICT', '선택 미디어 무결성 검증에 실패했습니다.');
            if (item.mediaType.startsWith('image/') && this.imagePreparer) {
              const prepared = await this.imagePreparer(safeStoragePath(this.blobDir, item.storageKey));
              if (Buffer.isBuffer(prepared) && prepared.length > 0 && prepared.length <= 2 * 1024 * 1024) {
                selected.imageDataUrl = `data:image/jpeg;base64,${prepared.toString('base64')}`; preparedImageCount += 1;
              }
            }
            else if (item.mediaType.startsWith('video/') && this.videoFrameExtractor) {
              const frame = await this.videoFrameExtractor(safeStoragePath(this.blobDir, item.storageKey));
              if (Buffer.isBuffer(frame) && frame.length > 0 && frame.length <= 2 * 1024 * 1024) {
                selected.imageDataUrl = `data:image/jpeg;base64,${frame.toString('base64')}`; preparedImageCount += 1;
              }
            }
          } catch (error) {
            if (error?.code === 'VERSION_CONFLICT') throw error;
            // Missing local FFmpeg or an unsupported video is a safe local fallback.
          }
        }
        selectedMedia.push(selected);
      }
      const generated = await creatorAgent.createPlan({ ownerId, taskId, project: structuredClone(project), requestText: input.request_text.trim(),
        media: selectedMedia, revision: Boolean(project.creator_plan), privacyConsentId: input.privacy_consent_id ?? null });
      if (task.current_version !== expectedVersion || task.active_job_id) throw apiError(409, 'VERSION_CONFLICT', '기획 생성 중 콘텐츠 버전이 변경되었습니다.');
      for (const approval of Object.values(this.state.data.approvals)) if (approval.task_id === taskId && approval.status === 'active') approval.status = 'invalidated';
      for (const checkpoint of Object.values(this.state.data.checkpoints)) if (checkpoint.task_id === taskId && ['pending', 'approved'].includes(checkpoint.status)) checkpoint.status = 'invalidated';
      project.plan_request = input.request_text.trim();
      project.creator_plan = generated.plan;
      project.caption_draft = generated.captions;
      delete project.video_reuse;
      project.composition ??= { captions_enabled: true, music_track_id: null, source_volume: 1, music_volume: 0.25, fade_in_seconds: 1, fade_out_seconds: 1, source_audio_rights: [] };
      project.creator_generation = generated.generation;
      project.current_version = expectedVersion + 1;
      project.content_hash = this.contentHash(project);
      project.status = 'review_required';
      task.current_version = project.current_version;
      task.content_hash = project.content_hash;
      task.status = 'waiting_plan_approval';
      task.progress_percent = 0; task.next_action = 'review_plan'; delete task.artifact_sha256; delete task.active_job_id;
      task.updated_at = new Date().toISOString();
      const checkpointId = randomUUID();
      const checkpoint = { checkpoint_id: checkpointId, task_id: taskId, owner_id: ownerId, kind: 'plan', status: 'pending',
        content_version: task.current_version, content_hash: task.content_hash, approval_scope: 'continue',
        summary: `${project.target_seconds}초 쇼츠 기획을 검토해 주세요. 승인 후 자막 초안 확인 단계로 이동합니다.` };
      this.state.data.checkpoints[checkpointId] = checkpoint;
      const result = { task_id: taskId, content_version: task.current_version, content_hash: task.content_hash,
        plan: structuredClone(project.creator_plan), checkpoint: publicCheckpoint(checkpoint), generation: generated.generation };
      this.state.data.idempotency[key] = { fingerprint, result };
      this.state.save();
      return structuredClone(result);
    } catch (error) {
      delete this.state.data.idempotency[key];
      this.state.save();
      throw error;
    }
  }

  getOwnedCaptionDraft(ownerId, taskId) {
    const task = this.state.data.tasks[taskId];
    const project = task && this.state.data.projects[task.project_id];
    if (!task || task.ownerId !== ownerId || !project || project.ownerId !== ownerId) return null;
    const checkpoint = Object.values(this.state.data.checkpoints).find((item) => item.task_id === taskId && item.kind === 'draft' && ['pending', 'approved'].includes(item.status) && item.content_version === task.current_version && item.content_hash === task.content_hash);
    const planCheckpoint = Object.values(this.state.data.checkpoints).find((item) => item.task_id === taskId && item.kind === 'plan' && item.status === 'approved' && item.content_version === task.current_version && item.content_hash === task.content_hash);
    const planApproval = planCheckpoint && this.state.data.approvals[planCheckpoint.approval_id];
    if (!checkpoint || !['waiting_draft_approval', 'render_ready', 'rendering', 'render_simulated', 'waiting_preview_approval', 'preview_approved'].includes(task.status) ||
        !planApproval || planApproval.status !== 'active' || planApproval.approval_scope !== 'continue') {
      throw apiError(409, 'INVALID_STATE_TRANSITION', '기획 승인 후에만 현재 자막 초안을 열 수 있습니다.');
    }
    return { task_id: taskId, content_version: task.current_version, content_hash: task.content_hash,
      captions: structuredClone(project.caption_draft ?? []), composition: structuredClone(project.composition ?? null), checkpoint: publicCheckpoint(checkpoint) };
  }

  updateCaptionDraft(ownerId, taskId, input, idempotencyKey) {
    const task = this.state.data.tasks[taskId];
    const project = task && this.state.data.projects[task.project_id];
    if (!task || task.ownerId !== ownerId || !project || project.ownerId !== ownerId) throw apiError(404, 'RESOURCE_NOT_FOUND', '작업을 찾을 수 없습니다.');
    const keys = ['content_version', 'content_hash', 'captions', 'captions_enabled', 'music_track_id', 'source_volume', 'music_volume', 'fade_in_seconds', 'fade_out_seconds', 'source_audio_rights'];
    const sourceRights = input?.source_audio_rights ?? project.composition?.source_audio_rights ?? [];
    if (!isValidIdempotencyKey(idempotencyKey) || !input || Object.keys(input).some((key) => !keys.includes(key)) ||
        !Number.isSafeInteger(input.content_version) || typeof input.content_hash !== 'string' || !Array.isArray(input.captions) || input.captions.length > 30 ||
        typeof input.captions_enabled !== 'boolean' || !(input.music_track_id === null || isUuid(input.music_track_id)) ||
        [input.source_volume, input.music_volume].some((v) => !Number.isFinite(v) || v < 0 || v > 2) ||
        [input.fade_in_seconds, input.fade_out_seconds].some((v) => !Number.isFinite(v) || v < 0 || v > 10 || v > project.target_seconds / 2) ||
        (input.source_audio_rights !== undefined && !Array.isArray(input.source_audio_rights)) || !Array.isArray(sourceRights) || sourceRights.length > 30 || new Set(sourceRights.map((item) => item?.media_id)).size !== sourceRights.length ||
        sourceRights.some((r) => !r || Object.keys(r).some((key) => !['media_id', 'explicitly_verified', 'commercial_allowed', 'platforms', 'evidence', 'attribution_required', 'required_attribution'].includes(key)) ||
          !project.media_ids.includes(r.media_id) || !['video/mp4', 'video/quicktime'].includes(this.state.data.media[r.media_id]?.mediaType) ||
          typeof r.explicitly_verified !== 'boolean' || typeof r.commercial_allowed !== 'boolean' || !Array.isArray(r.platforms) || new Set(r.platforms).size !== r.platforms.length ||
          r.platforms.some((p) => !['youtube', 'instagram', 'tiktok'].includes(p)) || typeof r.evidence !== 'string' || r.evidence.length > 4000 ||
          typeof r.attribution_required !== 'boolean' || typeof r.required_attribution !== 'string' || r.required_attribution.length > 2000 ||
          (r.explicitly_verified && (!r.commercial_allowed || !r.platforms.length || !r.evidence.trim() || (r.attribution_required && !r.required_attribution.trim())))) ||
        input.captions.some((c, i) => !c || Object.keys(c).some((k) => !['order', 'start_seconds', 'end_seconds', 'text'].includes(k)) || c.order !== i + 1 ||
          !Number.isFinite(c.start_seconds) || !Number.isFinite(c.end_seconds) || c.start_seconds < 0 || c.start_seconds >= c.end_seconds || c.end_seconds > project.target_seconds ||
          typeof c.text !== 'string' || [...c.text].length > 80 || !CAPTION_TEXT_PATTERN.test(c.text))) {
      throw apiError(422, 'VALIDATION_ERROR', '자막 또는 오디오 설정을 확인해 주세요.');
    }
    const key = `${ownerId}:draft-edit:${taskId}:${idempotencyKey}`;
    const fingerprint = JSON.stringify(input); const prior = this.state.data.idempotency[key];
    if (prior) { if (prior.fingerprint !== fingerprint) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '이미 사용한 요청 키입니다.'); return structuredClone(prior.result); }
    if (task.current_version !== input.content_version || task.content_hash !== input.content_hash) throw apiError(409, 'VERSION_CONFLICT', '현재 콘텐츠 버전과 일치하지 않습니다.');
    if (!['waiting_draft_approval', 'render_ready', 'render_simulated', 'waiting_preview_approval', 'preview_approved'].includes(task.status) || task.active_job_id) throw apiError(409, 'INVALID_STATE_TRANSITION', '기획 승인 후 자막과 음악을 수정해 주세요.');
    const planApproval = Object.values(this.state.data.checkpoints).find((c) => c.task_id === taskId && c.kind === 'plan' && c.content_version === task.current_version && c.status === 'approved');
    if (!planApproval || this.state.data.approvals[planApproval.approval_id]?.status !== 'active') throw apiError(409, 'INVALID_STATE_TRANSITION', '현재 기획을 먼저 승인해 주세요.');
    if (input.music_track_id) this.musicLibrary.path(ownerId, input.music_track_id);
    let reuse = null;
    const sameVideo = project.composition && project.composition.captions_enabled === input.captions_enabled &&
      JSON.stringify(project.caption_draft ?? []) === JSON.stringify(input.captions);
    if (sameVideo) {
      const previous = Object.values(this.state.data.jobs).filter((job) => job.task_id === taskId && job.content_version === task.current_version && job.content_hash === task.content_hash &&
        job.status === 'succeeded' && job.renderer_mode === 'ffmpeg' && job.artifact_verified === true && typeof job.artifact_key === 'string' && /^[a-f\d]{64}$/.test(job.artifact_sha256 ?? '')).at(-1);
      if (previous) {
        try { if (sha256(readRegularFile(safeStoragePath(this.renderDir, previous.artifact_key))) === previous.artifact_sha256) reuse = { artifact_key: previous.artifact_key, sha256: previous.artifact_sha256 }; } catch { /* Re-render instead of trusting a missing or changed cache. */ }
      }
    }
    const updatedProject = { ...project, caption_draft: structuredClone(input.captions),
      composition: { ...Object.fromEntries(keys.slice(3, 9).map((keyName) => [keyName, input[keyName]])), source_audio_rights: structuredClone(sourceRights) }, current_version: task.current_version + 1 };
    if (reuse) updatedProject.video_reuse = reuse; else delete updatedProject.video_reuse;
    updatedProject.content_hash = this.contentHash(updatedProject);
    if (!reuse) delete project.video_reuse;
    Object.assign(project, updatedProject);
    for (const approval of Object.values(this.state.data.approvals)) if (approval.task_id === taskId && approval.status === 'active') approval.status = 'invalidated';
    for (const checkpoint of Object.values(this.state.data.checkpoints)) if (checkpoint.task_id === taskId && ['pending', 'approved'].includes(checkpoint.status)) checkpoint.status = 'invalidated';
    for (const publication of Object.values(this.state.data.publications)) if (publication.task_id === taskId && publication.owner_id === ownerId) { publication.status = 'draft'; publication.approval_id = null; }
    Object.assign(task, { current_version: project.current_version, content_hash: project.content_hash, status: 'waiting_plan_approval', next_action: 'review_plan', progress_percent: 0, updated_at: new Date().toISOString() });
    delete task.artifact_sha256; project.status = 'review_required';
    const checkpointId = randomUUID();
    const checkpoint = { checkpoint_id: checkpointId, task_id: taskId, owner_id: ownerId, kind: 'plan', status: 'pending', content_version: task.current_version,
      content_hash: task.content_hash, approval_scope: 'continue', summary: '수정된 자막과 음악이 포함된 새 버전의 기획을 다시 확인해 주세요.' };
    this.state.data.checkpoints[checkpointId] = checkpoint;
    const result = { task_id: taskId, content_version: task.current_version, content_hash: task.content_hash, checkpoint: publicCheckpoint(checkpoint) };
    this.state.data.idempotency[key] = { fingerprint, result }; this.state.save(); return structuredClone(result);
  }

  getOwnedCreatorPlan(ownerId, taskId) {
    const task = this.state.data.tasks[taskId];
    const project = task && this.state.data.projects[task.project_id];
    if (!task || task.ownerId !== ownerId || !project || project.ownerId !== ownerId) return null;
    if (!project.creator_plan) throw apiError(409, 'INVALID_STATE_TRANSITION', '아직 생성된 쇼츠 기획안이 없습니다.');
    const checkpoint = Object.values(this.state.data.checkpoints).filter((item) => item.task_id === taskId && item.kind === 'plan' &&
      item.content_version === task.current_version && item.content_hash === task.content_hash).at(-1);
    if (!checkpoint) throw apiError(409, 'INVALID_STATE_TRANSITION', '현재 버전의 기획 확인 단계를 찾을 수 없습니다.');
    return { task_id: taskId, content_version: task.current_version, content_hash: task.content_hash, plan: structuredClone(project.creator_plan),
      checkpoint: publicCheckpoint(checkpoint), generation: structuredClone(project.creator_generation ?? { source: 'local_rules', fallback_used: true, llm_calls: 0, estimated_cost_usd: 0 }) };
  }

  updateCreatorScenes(ownerId, taskId, input, idempotencyKey) {
    const task = this.state.data.tasks[taskId];
    const project = task && this.state.data.projects[task.project_id];
    if (!task || task.ownerId !== ownerId || !project || project.ownerId !== ownerId) throw apiError(404, 'RESOURCE_NOT_FOUND', '작업을 찾을 수 없습니다.');
    if (!project.creator_plan || task.active_job_id) throw apiError(409, 'INVALID_STATE_TRANSITION', '현재 기획을 수정할 수 없습니다.');
    if (!isValidIdempotencyKey(idempotencyKey) || !input || Object.keys(input).some((key) => !['content_version', 'content_hash', 'scenes'].includes(key)) ||
        !Number.isSafeInteger(input.content_version) || typeof input.content_hash !== 'string' || !Array.isArray(input.scenes) ||
        input.scenes.length !== project.media_ids.length || new Set(input.scenes.map((scene) => scene?.media_id)).size !== project.media_ids.length ||
        input.scenes.some((scene) => !scene || Object.keys(scene).some((key) => !['media_id', 'duration_seconds', 'trim_start_seconds'].includes(key)) ||
          !project.media_ids.includes(scene.media_id) || !Number.isFinite(scene.duration_seconds) || scene.duration_seconds < 0.1 ||
          (scene.trim_start_seconds !== undefined && (!['video/mp4', 'video/quicktime'].includes(this.state.data.media[scene.media_id]?.mediaType) ||
            !Number.isFinite(scene.trim_start_seconds) || scene.trim_start_seconds < 0 || scene.trim_start_seconds > 3600))) ||
        Math.abs(input.scenes.reduce((sum, scene) => sum + scene.duration_seconds, 0) - project.target_seconds) > 0.01) {
      throw apiError(422, 'VALIDATION_ERROR', '장면 순서와 길이를 확인해 주세요.');
    }
    const key = `${ownerId}:scene-edit:${taskId}:${idempotencyKey}`;
    const fingerprint = JSON.stringify(input); const prior = this.state.data.idempotency[key];
    if (prior) { if (prior.fingerprint !== fingerprint) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '이미 사용한 요청 키입니다.'); return structuredClone(prior.result); }
    if (input.content_version !== task.current_version || input.content_hash !== task.content_hash) throw apiError(409, 'VERSION_CONFLICT', '현재 버전을 다시 확인해 주세요.');
    const previous = new Map(project.creator_plan.scenes.map((scene) => [scene.media_id, scene]));
    const captions = new Map((project.caption_draft ?? []).map((caption, index) => [project.creator_plan.scenes[index]?.media_id, caption]));
    let start = 0;
    const scenes = input.scenes.map((item, index) => {
      const end = index === input.scenes.length - 1 ? project.target_seconds : Math.round((start + item.duration_seconds) * 100) / 100;
      const scene = { ...previous.get(item.media_id), order: index + 1, start_seconds: start, end_seconds: end };
      if (item.trim_start_seconds !== undefined) scene.trim_start_seconds = item.trim_start_seconds; else delete scene.trim_start_seconds;
      start = end; return scene;
    });
    project.media_ids = input.scenes.map((scene) => scene.media_id);
    project.media_manifest = project.media_ids.map((mediaId, index) => ({ order: index + 1, media_id: mediaId, sha256: this.state.data.media[mediaId].sha256 }));
    project.creator_plan.scenes = scenes;
    project.caption_draft = scenes.map((scene, index) => ({ order: index + 1, start_seconds: scene.start_seconds, end_seconds: scene.end_seconds,
      text: captions.get(scene.media_id)?.text ?? scene.caption_text }));
    project.current_version += 1; project.content_hash = this.contentHash(project); project.status = 'review_required'; delete project.video_reuse;
    for (const approval of Object.values(this.state.data.approvals)) if (approval.task_id === taskId && approval.status === 'active') approval.status = 'invalidated';
    for (const checkpoint of Object.values(this.state.data.checkpoints)) if (checkpoint.task_id === taskId && ['pending', 'approved'].includes(checkpoint.status)) checkpoint.status = 'invalidated';
    for (const publication of Object.values(this.state.data.publications)) if (publication.task_id === taskId && publication.owner_id === ownerId) { publication.status = 'draft'; publication.approval_id = null; }
    Object.assign(task, { current_version: project.current_version, content_hash: project.content_hash, status: 'waiting_plan_approval', next_action: 'review_plan', progress_percent: 0, updated_at: new Date().toISOString() });
    delete task.artifact_sha256;
    const checkpoint = { checkpoint_id: randomUUID(), task_id: taskId, owner_id: ownerId, kind: 'plan', status: 'pending',
      content_version: task.current_version, content_hash: task.content_hash, approval_scope: 'continue', summary: '수정된 장면 순서와 길이를 확인해 주세요.' };
    this.state.data.checkpoints[checkpoint.checkpoint_id] = checkpoint;
    const result = { task_id: taskId, content_version: task.current_version, content_hash: task.content_hash,
      plan: structuredClone(project.creator_plan), checkpoint: publicCheckpoint(checkpoint), generation: structuredClone(project.creator_generation ?? { source: 'local_rules', fallback_used: true, llm_calls: 0, estimated_cost_usd: 0 }) };
    this.state.data.idempotency[key] = { fingerprint, result }; this.state.save(); return structuredClone(result);
  }

  getOwnedProject(ownerId, projectId) {
    const project = this.state.data.projects[projectId];
    return project?.ownerId === ownerId ? publicProject(project) : null;
  }

  listOwnedProjects(ownerId) {
    return Object.values(this.state.data.projects)
      .filter((project) => project.ownerId === ownerId)
      .map((project) => publicProject(project))
      .reverse();
  }

  async getOwnedTask(ownerId, taskId) {
    const task = this.state.data.tasks[taskId];
    if (!task || task.ownerId !== ownerId) return null;
    const { ownerId: _ownerId, ...safeTask } = task;
    return safeTask;
  }

  listOwnedTaskJobs(ownerId, taskId) {
    const task = this.state.data.tasks[taskId];
    if (!task || task.ownerId !== ownerId) return null;
    return Object.values(this.state.data.jobs)
      .filter((job) => job.owner_id === ownerId && job.task_id === taskId)
      .map((job) => this.getPublicJob(job))
      .reverse();
  }

  getOwnedCreatorContext(ownerId, taskId, attachmentIds = []) {
    const task = this.state.data.tasks[taskId];
    const project = task && this.state.data.projects[task.project_id];
    if (!task || task.ownerId !== ownerId || !project || project.ownerId !== ownerId) return null;
    if (!Array.isArray(attachmentIds) || attachmentIds.some((id) => !project.media_ids.includes(id)) ||
        (attachmentIds.length > 0 && (attachmentIds.length !== project.media_ids.length || attachmentIds.some((id) => !project.media_ids.includes(id))))) {
      throw apiError(404, 'RESOURCE_NOT_FOUND', '작업에 연결되지 않은 선택 미디어입니다.');
    }
    const media = project.media_ids.map((id) => this.state.data.media[id]);
    if (media.some((item) => !item || item.ownerId !== ownerId || item.status !== 'available')) throw apiError(404, 'RESOURCE_NOT_FOUND', '선택한 미디어를 찾을 수 없습니다.');
    return { task: { task_id: taskId, current_version: task.current_version, content_hash: task.content_hash, status: task.status },
      project: structuredClone(project), media: media.map((item) => ({ mediaId: item.mediaId, mediaType: item.mediaType })) };
  }

  async withIdempotentResponse(ownerId, operation, key, fingerprint, action) {
    if (!isValidIdempotencyKey(key)) throw apiError(422, 'VALIDATION_ERROR', 'Idempotency-Key가 필요합니다.');
    const requestKey = `${ownerId}:${operation}:${key}`;
    const prior = this.state.data.idempotency[requestKey];
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '멱등 키가 다른 요청에 사용되었습니다.');
      if (prior.result) return structuredClone(prior.result);
      throw apiError(409, 'INVALID_STATE_TRANSITION', '같은 요청을 처리 중입니다.');
    }
    this.state.data.idempotency[requestKey] = { fingerprint, status: 'processing' };
    this.state.save();
    try {
      const result = await action();
      this.state.data.idempotency[requestKey] = { fingerprint, result: structuredClone(result) };
      this.state.save();
      return result;
    } catch (error) {
      delete this.state.data.idempotency[requestKey];
      this.state.save();
      throw error;
    }
  }

  contentHash(project) {
    const media = project.media_ids.map((id) => {
      const item = this.state.data.media[id];
      if (!item || item.ownerId !== project.ownerId || item.status !== 'available') throw apiError(404, 'RESOURCE_NOT_FOUND', '선택한 미디어를 찾을 수 없습니다.');
      return { media_id: id, sha256: item.sha256 };
    });
    return sha256(Buffer.from(JSON.stringify({ media, target_seconds: project.target_seconds, aspect_ratio: project.aspect_ratio,
      style: project.style ?? null, framing: project.framing, focal_x: project.focal_x, focal_y: project.focal_y,
      plan_request: project.plan_request ?? null, creator_plan: project.creator_plan ?? null, caption_draft: project.caption_draft ?? null,
      caption_mode: project.composition ? 'burn_in' : 'draft_only', audio_mode: project.composition ? 'mixed' : 'silent', profile: 'vertical_9_16_h264_aac',
      ...(project.composition ? { composition: project.composition, caption_font_sha256: project.composition.captions_enabled ? CAPTION_FONT_SHA256 : null,
        music_sha256: project.composition.music_track_id ? this.musicLibrary.owned(project.ownerId, project.composition.music_track_id).sha256 : null } : {}) })));
  }

  getOwnedCheckpoints(ownerId, taskId) {
    const task = this.state.data.tasks[taskId];
    if (!task || task.ownerId !== ownerId) return null;
    return Object.values(this.state.data.checkpoints).filter((item) => item.task_id === taskId && item.owner_id === ownerId)
      .map(({ owner_id: _owner, ...checkpoint }) => checkpoint);
  }

  approveCheckpoint(ownerId, taskId, input, idempotencyKey) {
    const task = this.state.data.tasks[taskId];
    if (!task || task.ownerId !== ownerId) throw apiError(404, 'RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.');
    if (!isValidIdempotencyKey(idempotencyKey)) throw apiError(422, 'VALIDATION_ERROR', 'Idempotency-Key가 필요합니다.');
    if (!input || input.approval_scope !== 'continue') throw apiError(409, 'APPROVAL_SCOPE_MISMATCH', '이 체크포인트에는 continue 중간 승인만 허용됩니다.');
    const checkpoint = this.state.data.checkpoints[input.checkpoint_id];
    if (!checkpoint || checkpoint.task_id !== taskId || checkpoint.owner_id !== ownerId) throw apiError(404, 'RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.');
    if (checkpoint.status === 'approved') return structuredClone(this.state.data.approvals[checkpoint.approval_id]);
    if (checkpoint.status !== 'pending' || task.current_version !== input.content_version || task.content_hash !== input.content_hash ||
        checkpoint.content_version !== input.content_version || checkpoint.content_hash !== input.content_hash) {
      throw apiError(409, 'VERSION_CONFLICT', '체크포인트가 현재 콘텐츠 버전과 일치하지 않습니다.');
    }
    const priorPlan = Object.values(this.state.data.checkpoints).find((item) => item.task_id === taskId && item.kind === 'plan' &&
      item.content_version === task.current_version && item.content_hash === task.content_hash);
    if (checkpoint.kind === 'draft' && (priorPlan?.status !== 'approved' || task.status !== 'waiting_draft_approval')) {
      throw apiError(409, 'INVALID_STATE_TRANSITION', '기획 체크포인트 승인 후에만 초안 체크포인트를 승인할 수 있습니다.');
    }
    if (checkpoint.kind === 'plan' && task.status !== 'waiting_plan_approval') throw apiError(409, 'INVALID_STATE_TRANSITION', '현재 상태에서 기획을 승인할 수 없습니다.');
    if (checkpoint.kind === 'preview' && task.status !== 'waiting_preview_approval') throw apiError(409, 'INVALID_STATE_TRANSITION', '현재 상태에서 미리보기를 승인할 수 없습니다.');
    if (!['plan', 'draft', 'preview'].includes(checkpoint.kind)) throw apiError(409, 'APPROVAL_SCOPE_MISMATCH', '이 체크포인트 종류는 현재 참조 API에서 승인할 수 없습니다.');
    const fingerprint = JSON.stringify({ task_id: taskId, checkpoint_id: checkpoint.checkpoint_id, content_version: input.content_version,
      content_hash: input.content_hash, approval_scope: input.approval_scope });
    const key = `${ownerId}:approval:${idempotencyKey}`;
    const prior = this.state.data.idempotency[key];
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '멱등 키가 다른 요청에 사용되었습니다.');
      return structuredClone(this.state.data.approvals[prior.approvalId]);
    }
    const approval = { approval_id: randomUUID(), task_id: taskId, checkpoint_id: checkpoint.checkpoint_id,
      content_version: task.current_version, content_hash: task.content_hash, approval_scope: 'continue', status: 'active',
      approval_hash: sha256(Buffer.from(JSON.stringify({ task_id: taskId, checkpoint_id: checkpoint.checkpoint_id, content_version: task.current_version,
        content_hash: task.content_hash, approval_scope: 'continue' }))), approved_at: new Date().toISOString() };
    this.state.data.approvals[approval.approval_id] = approval;
    checkpoint.status = 'approved'; checkpoint.approval_id = approval.approval_id;
    if (checkpoint.kind === 'plan') {
      task.status = 'waiting_draft_approval'; task.next_action = 'review_draft';
      const draftCheckpointId = randomUUID();
      this.state.data.checkpoints[draftCheckpointId] = { checkpoint_id: draftCheckpointId, task_id: taskId, owner_id: ownerId, kind: 'draft', status: 'pending',
        content_version: task.current_version, content_hash: task.content_hash, approval_scope: 'continue',
        summary: '생성된 자막 초안을 확인하고 수정하거나 다음 렌더 단계 진행을 승인해 주세요. 오디오 구성은 무음입니다.' };
    } else if (checkpoint.kind === 'draft') {
      task.status = 'render_ready'; task.next_action = 'none';
    } else {
      task.status = 'preview_approved'; task.next_action = 'none';
    }
    task.updated_at = new Date().toISOString();
    this.state.data.idempotency[key] = { fingerprint, approvalId: approval.approval_id };
    this.state.save();
    return structuredClone(approval);
  }

  createPublication(ownerId, taskId, input, idempotencyKey) {
    const task = this.state.data.tasks[taskId];
    if (!task || task.ownerId !== ownerId) throw apiError(404, 'RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.');
    const value = publicationInput(input);
    if (!isValidIdempotencyKey(idempotencyKey)) throw apiError(422, 'VALIDATION_ERROR', 'Idempotency-Key가 필요합니다.');
    const fingerprint = JSON.stringify({ task_id: taskId, ...value });
    const key = `${ownerId}:publication-create:${idempotencyKey}`;
    const prior = this.state.data.idempotency[key];
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '멱등 키가 다른 요청에 사용되었습니다.');
      return structuredClone(this.state.data.publications[prior.publicationId]);
    }
    if (Object.values(this.state.data.publications).some((item) => item.task_id === taskId && item.platform === value.platform)) {
      throw apiError(409, 'PUBLICATION_ALREADY_EXISTS', '해당 플랫폼 게시 정보가 이미 있습니다. 기존 정보를 수정해 주세요.');
    }
    const publication = { publication_id: randomUUID(), task_id: taskId, owner_id: ownerId, ...value,
      revision: 1, metadata_hash: publicationHash(value), status: 'draft', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    this.state.data.publications[publication.publication_id] = publication;
    this.state.data.idempotency[key] = { fingerprint, publicationId: publication.publication_id };
    this.state.save();
    return publicPublication(publication);
  }

  listPublications(ownerId, taskId) {
    const task = this.state.data.tasks[taskId];
    if (!task || task.ownerId !== ownerId) return null;
    this.invalidateStalePublicationApprovals(task);
    return Object.values(this.state.data.publications).filter((item) => item.task_id === taskId && item.owner_id === ownerId).map(publicPublication);
  }

  getPublication(ownerId, taskId, publicationId) {
    const item = this.state.data.publications[publicationId];
    const task = this.state.data.tasks[taskId];
    if (task?.ownerId === ownerId) this.invalidateStalePublicationApprovals(task);
    return item?.task_id === taskId && item.owner_id === ownerId ? publicPublication(item) : null;
  }

  invalidateStalePublicationApprovals(task) {
    let changed = false;
    for (const approval of Object.values(this.state.data.approvals)) {
      if (approval.task_id === task.task_id && approval.approval_scope === 'final_publish' && approval.status === 'active' &&
          (approval.content_version !== task.current_version || approval.content_hash !== task.content_hash)) {
        approval.status = 'invalidated';
        const publication = this.state.data.publications[approval.publication_id];
        if (publication?.approval_id === approval.approval_id) {
          publication.status = 'draft'; publication.approval_id = null; publication.updated_at = new Date().toISOString();
        }
        changed = true;
      }
    }
    if (changed) this.state.save();
  }

  updatePublication(ownerId, taskId, publicationId, input, idempotencyKey) {
    const item = this.state.data.publications[publicationId];
    if (!item || item.task_id !== taskId || item.owner_id !== ownerId) throw apiError(404, 'RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.');
    const value = publicationInput(input);
    if (value.platform !== item.platform) throw apiError(422, 'VALIDATION_ERROR', '게시 플랫폼은 생성 후 변경할 수 없습니다.');
    if (!isValidIdempotencyKey(idempotencyKey)) throw apiError(422, 'VALIDATION_ERROR', 'Idempotency-Key가 필요합니다.');
    const fingerprint = JSON.stringify({ publication_id: publicationId, revision: input.revision, ...value });
    const key = `${ownerId}:publication-update:${idempotencyKey}`;
    const prior = this.state.data.idempotency[key];
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '멱등 키가 다른 요청에 사용되었습니다.');
      return publicPublication(this.state.data.publications[publicationId]);
    }
    if (input.revision !== item.revision) throw apiError(409, 'VERSION_CONFLICT', '게시 정보가 다른 요청에서 수정되었습니다. 최신 정보를 다시 읽어 주세요.');
    const changed = publicationHash(value) !== item.metadata_hash;
    if (changed) {
      for (const approval of Object.values(this.state.data.approvals)) {
        if (approval.publication_id === publicationId && approval.status === 'active') approval.status = 'invalidated';
      }
      Object.assign(item, value, { revision: item.revision + 1, metadata_hash: publicationHash(value), status: 'draft', approval_id: null, updated_at: new Date().toISOString() });
    }
    this.state.data.idempotency[key] = { fingerprint, publicationId };
    this.state.save();
    return publicPublication(item);
  }

  approvePublication(ownerId, taskId, publicationId, input, idempotencyKey) {
    const task = this.state.data.tasks[taskId];
    const publication = this.state.data.publications[publicationId];
    if (!task || task.ownerId !== ownerId || !publication || publication.owner_id !== ownerId || publication.task_id !== taskId) throw apiError(404, 'RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.');
    if (!isValidIdempotencyKey(idempotencyKey)) throw apiError(422, 'VALIDATION_ERROR', 'Idempotency-Key가 필요합니다.');
    const job = Object.values(this.state.data.jobs).filter((item) => item.task_id === taskId && item.status === 'succeeded' && item.renderer_mode === 'ffmpeg' && item.artifact_verified === true && item.content_version === task.current_version && item.content_hash === task.content_hash && /^[a-f\d]{64}$/i.test(item.artifact_sha256 ?? '')).sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))[0];
    const preview = Object.values(this.state.data.checkpoints).find((item) => item.task_id === taskId && item.kind === 'preview' && item.status === 'approved' && item.content_version === task.current_version && item.content_hash === task.content_hash);
    const previewApproval = preview && this.state.data.approvals[preview.approval_id];
    if (!job || !previewApproval || previewApproval.status !== 'active' || previewApproval.approval_scope !== 'continue' || task.status !== 'preview_approved') throw apiError(409, 'RENDER_REQUIRED', '실제 FFmpeg·ffprobe 검증 및 현재 버전 미리보기 승인이 필요합니다.');
    const expected = { content_version: task.current_version, content_hash: task.content_hash, artifact_sha256: job.artifact_sha256,
      publication_revision: publication.revision, publication_hash: publication.metadata_hash };
    if (!input || Object.keys(input).some((key) => !['content_version', 'content_hash', 'artifact_sha256', 'publication_revision', 'publication_hash'].includes(key)) ||
        Object.entries(expected).some(([key, value]) => input[key] !== value)) throw apiError(409, 'VERSION_CONFLICT', '승인 대상 영상 또는 게시 정보가 현재 버전과 일치하지 않습니다.');
    const project = this.state.data.projects[task.project_id];
    if (!project || project.ownerId !== ownerId) throw apiError(404, 'RESOURCE_NOT_FOUND', '프로젝트를 찾을 수 없습니다.');
    if (project.composition?.music_track_id) this.musicLibrary.assertPublishable(ownerId, project.composition.music_track_id, publication.platform, publication);
    if (project.composition && project.composition.source_volume > 0) {
      if (!Array.isArray(job.source_audio_media_ids)) throw apiError(403, 'RIGHTS_REVIEW_REQUIRED', '원본 오디오의 권리를 확인해 주세요.');
      for (const mediaId of job.source_audio_media_ids) {
        const rights = project.composition.source_audio_rights?.find((r) => r.media_id === mediaId);
        if (!project.media_ids.includes(mediaId) || this.state.data.media[mediaId]?.ownerId !== ownerId || !rights?.explicitly_verified || !rights.commercial_allowed || !rights.evidence?.trim() || !rights.platforms?.includes(publication.platform) ||
            (rights.attribution_required && (!rights.required_attribution?.trim() || !publication.description.includes(rights.required_attribution)))) {
          throw apiError(403, 'RIGHTS_REVIEW_REQUIRED', '원본 오디오의 상업 이용 및 대상 플랫폼 권리를 확인해 주세요.');
        }
      }
    }
    const fingerprint = JSON.stringify({ task_id: taskId, publication_id: publicationId, platform: publication.platform, account_id: publication.account_id,
      visibility: publication.visibility, title: publication.title, description: publication.description, hashtags: publication.hashtags, ...expected });
    const key = `${ownerId}:publication-approval:${idempotencyKey}`;
    const prior = this.state.data.idempotency[key];
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '멱등 키가 다른 요청에 사용되었습니다.');
      return structuredClone(this.state.data.approvals[prior.approvalId]);
    }
    const approvalHash = sha256(Buffer.from(fingerprint));
    const semanticKey = `${ownerId}:publication-approval-semantic:${taskId}:${publicationId}:${approvalHash}`;
    const semanticPrior = this.state.data.idempotency[semanticKey];
    if (semanticPrior && this.state.data.approvals[semanticPrior.approvalId]?.status === 'active') {
      this.state.data.idempotency[key] = { fingerprint, approvalId: semanticPrior.approvalId };
      this.state.save();
      return structuredClone(this.state.data.approvals[semanticPrior.approvalId]);
    }
    const approval = { approval_id: randomUUID(), task_id: taskId, publication_id: publicationId, platform: publication.platform,
      account_id: publication.account_id, visibility: publication.visibility, title: publication.title, description: publication.description,
      hashtags: [...publication.hashtags], ...expected, approval_scope: 'final_publish', status: 'active', approved_at: new Date().toISOString() };
    approval.approval_hash = approvalHash;
    this.state.data.approvals[approval.approval_id] = approval;
    publication.status = 'publish_ready'; publication.approval_id = approval.approval_id; publication.updated_at = new Date().toISOString();
    this.state.data.idempotency[key] = { fingerprint, approvalId: approval.approval_id };
    this.state.data.idempotency[semanticKey] = { fingerprint, approvalId: approval.approval_id };
    this.state.save();
    return structuredClone(approval);
  }

  createRenderJob(ownerId, taskId, input, idempotencyKey) {
    const task = this.state.data.tasks[taskId];
    if (!task || task.ownerId !== ownerId) throw apiError(404, 'RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.');
    const allowedFields = new Set(['content_version', 'content_hash', 'render_profile', 'target_seconds', 'framing', 'focal_x', 'focal_y']);
    if (!input || Object.keys(input).some((key) => !allowedFields.has(key)) || !Number.isSafeInteger(input.content_version) ||
        typeof input.content_hash !== 'string' || (input.target_seconds !== undefined && (!Number.isInteger(input.target_seconds) || input.target_seconds < 3 || input.target_seconds >= 60)) ||
        (input.framing !== undefined && !['fit_pad', 'fill_crop'].includes(input.framing)) ||
        (input.focal_x !== undefined && (!Number.isFinite(input.focal_x) || input.focal_x < 0 || input.focal_x > 1)) ||
        (input.focal_y !== undefined && (!Number.isFinite(input.focal_y) || input.focal_y < 0 || input.focal_y > 1))) {
      throw apiError(422, 'VALIDATION_ERROR', '렌더 요청 형식을 확인해 주세요.');
    }
    const checkpoints = Object.values(this.state.data.checkpoints).filter((item) => item.task_id === taskId);
    const project = this.state.data.projects[task.project_id];
    if (!project || project.ownerId !== ownerId) throw apiError(404, 'RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.');
    if (!input || input.content_version !== task.current_version || input.content_hash !== task.content_hash) throw apiError(409, 'VERSION_CONFLICT', '현재 승인된 콘텐츠 버전과 일치하지 않습니다.');
    const settings = { render_profile: input.render_profile ?? 'vertical_9_16_h264_aac', target_seconds: input.target_seconds ?? project.target_seconds,
      framing: input.framing ?? project.framing, focal_x: input.focal_x ?? project.focal_x, focal_y: input.focal_y ?? project.focal_y };
    if (settings.render_profile !== 'vertical_9_16_h264_aac' || settings.target_seconds !== project.target_seconds || settings.framing !== project.framing ||
        settings.focal_x !== project.focal_x || settings.focal_y !== project.focal_y) throw apiError(409, 'VERSION_CONFLICT', '렌더 설정이 승인된 기획과 다릅니다. 프로젝트를 수정하고 다시 승인해 주세요.');
    if (!isValidIdempotencyKey(idempotencyKey)) throw apiError(422, 'VALIDATION_ERROR', 'Idempotency-Key가 필요합니다.');
    const fingerprint = JSON.stringify({ task_id: taskId, content_version: task.current_version, content_hash: task.content_hash, settings });
    const key = `${ownerId}:render:${idempotencyKey}`;
    const prior = this.state.data.idempotency[key];
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '멱등 키가 다른 요청에 사용되었습니다.');
      return { job: this.getPublicJob(this.state.data.jobs[prior.jobId]), created: false };
    }
    const semanticKey = `${ownerId}:render-semantic:${taskId}:${task.current_version}:${task.content_hash}`;
    const semantic = this.state.data.idempotency[semanticKey];
    const existing = semantic && this.state.data.jobs[semantic.jobId];
    if (existing && ['queued', 'running', 'succeeded', 'simulated'].includes(existing.status)) {
      this.state.data.idempotency[key] = { fingerprint, jobId: existing.job_id };
      this.state.save();
      return { job: this.getPublicJob(existing), created: false };
    }
    if (task.status !== 'render_ready') throw apiError(409, 'INVALID_STATE_TRANSITION', '기획과 초안의 중간 승인이 완료되어야 렌더할 수 있습니다.');
    for (const kind of ['plan', 'draft']) {
      const checkpoint = checkpoints.find((item) => item.kind === kind && item.status === 'approved');
      const approval = checkpoint && this.state.data.approvals[checkpoint.approval_id];
      if (!checkpoint || !approval || approval.status !== 'active' || approval.approval_scope !== 'continue' ||
          checkpoint.content_version !== task.current_version || checkpoint.content_hash !== task.content_hash) {
        throw apiError(409, 'INVALID_STATE_TRANSITION', '현재 버전에 연결된 기획·초안 중간 승인이 모두 필요합니다.');
      }
    }
    const mediaItems = project.media_ids.map((id) => this.state.data.media[id]);
    if (mediaItems.some((item) => !item || item.ownerId !== ownerId || item.status !== 'available' || !item.storageKey)) throw apiError(404, 'RESOURCE_NOT_FOUND', '승인된 프로젝트 미디어를 찾을 수 없습니다.');
    const job = { job_id: randomUUID(), task_id: taskId, owner_id: ownerId, kind: 'render', status: 'queued', progress_percent: 0,
      content_version: task.current_version, content_hash: task.content_hash, created_at: new Date().toISOString(), ...settings };
    this.state.data.jobs[job.job_id] = job;
    this.state.data.idempotency[key] = { fingerprint, jobId: job.job_id };
    this.state.data.idempotency[semanticKey] = { fingerprint, jobId: job.job_id };
    task.status = 'rendering'; task.progress_percent = 0; task.next_action = 'none'; task.active_job_id = job.job_id;
    project.status = 'rendering';
    this.state.save();
    return { job: this.getPublicJob(job), created: true };
  }

  claimRenderJob(jobId) {
    const job = this.state.data.jobs[jobId];
    if (!job || job.status !== 'queued') return null;
    const task = this.state.data.tasks[job.task_id];
    const project = task && this.state.data.projects[task.project_id];
    if (!task || !project || task.ownerId !== job.owner_id || task.active_job_id !== jobId || task.current_version !== job.content_version || task.content_hash !== job.content_hash) {
      this.failRenderJob(jobId, 'VERSION_CONFLICT'); return null;
    }
    const mediaItems = project.media_ids.map((id) => this.state.data.media[id]);
    const invalidMedia = mediaItems.some((item) => {
      if (!item || item.ownerId !== job.owner_id || item.status !== 'available' || !item.storageKey) return true;
      try { return sha256(readRegularFile(safeStoragePath(this.blobDir, item.storageKey))) !== item.sha256; }
      catch { return true; }
    });
    if (invalidMedia) {
      job.status = 'failed'; job.safe_error_code = 'VERSION_CONFLICT'; task.status = 'failed'; delete task.active_job_id; project.status = 'failed'; this.state.save(); return null;
    }
    job.status = 'running'; job.progress_percent = 5; job.started_at = new Date().toISOString(); task.progress_percent = 5; this.state.save();
    const musicPath = project.composition?.music_track_id ? this.musicLibrary.path(job.owner_id, project.composition.music_track_id) : null;
    let reuseVideo = null;
    if (project.video_reuse) {
      const path = safeStoragePath(this.renderDir, project.video_reuse.artifact_key);
      if (sha256(readRegularFile(path)) !== project.video_reuse.sha256) throw apiError(409, 'VERSION_CONFLICT', '이전 렌더 파일이 변경되었습니다.');
      reuseVideo = { path, sha256: project.video_reuse.sha256 };
    }
    return { task: { ...task }, project: structuredClone(project), musicPath, reuseVideo, mediaItems: mediaItems.map((item) => ({ mediaId: item.mediaId, mediaType: item.mediaType, fileName: item.fileName, storageKey: item.storageKey })) };
  }

  finishRenderJob(jobId, result) {
    const job = this.state.data.jobs[jobId];
    if (!job || job.status !== 'running') return this.getPublicJob(job);
    const task = this.state.data.tasks[job.task_id];
    if (!task || task.current_version !== job.content_version || task.content_hash !== job.content_hash || task.active_job_id !== jobId) {
      throw apiError(409, 'VERSION_CONFLICT', '렌더 중 콘텐츠 버전이 변경되었습니다.');
    }
    const fileName = typeof result?.file_name === 'string' ? result.file_name : '';
    if (!fileName || fileName !== fileName.split(/[\\/]/).at(-1)) throw apiError(422, 'RENDER_FAILED', '렌더 결과 경로가 안전하지 않습니다.');
    const artifactPath = safeStoragePath(this.renderDir, fileName);
    if (resolve(artifactPath) !== resolve(result.output_path)) throw apiError(422, 'RENDER_FAILED', '렌더 결과 경로가 저장 영역을 벗어났습니다.');
    const bytes = readRegularFile(artifactPath);
    if (result?.mode === 'ffmpeg' && (result.verified !== true || result.verification?.valid !== true)) throw apiError(422, 'RENDER_VALIDATION_FAILED', 'ffprobe 검증을 통과하지 않은 영상입니다.');
    if (!['ffmpeg', 'test'].includes(result?.mode)) throw apiError(422, 'RENDER_FAILED', '등록되지 않은 렌더러입니다.');
    job.status = result.mode === 'test' ? 'simulated' : 'succeeded';
    job.renderer_mode = result.mode;
    job.video_reused = result.mode === 'ffmpeg' && result.video_reused === true;
    if (result.mode === 'ffmpeg') job.source_audio_media_ids = result.source_audio_media_ids;
    job.artifact_verified = result.mode === 'ffmpeg' && result.verified === true;
    job.artifact_sha256 = sha256(bytes);
    job.artifact_key = fileName;
    job.preview_ready = true;
    job.progress_percent = 100; job.completed_at = new Date().toISOString();
    const project = task && this.state.data.projects[task.project_id];
    if (task?.active_job_id === jobId) {
      task.status = result.mode === 'test' ? 'render_simulated' : 'waiting_preview_approval';
      task.progress_percent = 100; task.next_action = result.mode === 'test' ? 'none' : 'review_preview';
      delete task.active_job_id; task.artifact_sha256 = job.artifact_sha256;
    }
    if (project) project.status = 'review_required';
    if (result.mode === 'ffmpeg' && task?.status === 'waiting_preview_approval') {
      const previewCheckpointId = randomUUID();
      this.state.data.checkpoints[previewCheckpointId] = { checkpoint_id: previewCheckpointId, task_id: task.task_id, owner_id: task.ownerId,
        kind: 'preview', status: 'pending', content_version: task.current_version, content_hash: task.content_hash, approval_scope: 'continue',
        summary: 'ffprobe 검증을 통과한 비공개 미리보기를 확인해 주세요.' };
    }
    this.state.save(); return this.getPublicJob(job);
  }

  failRenderJob(jobId, errorCode) {
    const job = this.state.data.jobs[jobId];
    if (!job || !['queued', 'running'].includes(job.status)) return this.getPublicJob(job);
    const safeCodes = new Set(['RENDER_FAILED', 'RENDER_VALIDATION_FAILED', 'FFPROBE_UNAVAILABLE', 'UNSUPPORTED_MEDIA_TYPE', 'VALIDATION_ERROR', 'RESOURCE_NOT_FOUND', 'WORKER_INTERRUPTED', 'VERSION_CONFLICT']);
    job.status = 'failed'; job.safe_error_code = safeCodes.has(errorCode) ? errorCode : 'RENDER_FAILED'; job.completed_at = new Date().toISOString();
    const task = this.state.data.tasks[job.task_id]; const project = task && this.state.data.projects[task.project_id];
    if (task?.active_job_id === jobId) { task.status = 'failed'; delete task.active_job_id; task.progress_percent = Math.min(task.progress_percent ?? 0, 99); }
    if (project) project.status = 'failed';
    this.state.save(); return this.getPublicJob(job);
  }

  cancelRenderJob(ownerId, jobId) {
    const job = this.state.data.jobs[jobId];
    if (!job || job.owner_id !== ownerId) throw apiError(404, 'RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.');
    if (job.status === 'cancelled') return this.getPublicJob(job);
    if (!['queued', 'running'].includes(job.status)) throw apiError(409, 'INVALID_STATE_TRANSITION', '현재 작업을 취소할 수 없습니다.');
    job.status = 'cancelled'; job.completed_at = new Date().toISOString(); delete job.safe_error_code;
    const task = this.state.data.tasks[job.task_id]; const project = task && this.state.data.projects[task.project_id];
    if (task?.active_job_id === jobId) { task.status = 'render_ready'; delete task.active_job_id; task.next_action = 'none'; task.progress_percent = 0; }
    if (project) project.status = 'created';
    this.state.save(); return this.getPublicJob(job);
  }

  getOwnedJob(ownerId, jobId) {
    const job = this.state.data.jobs[jobId];
    return job?.owner_id === ownerId ? this.getPublicJob(job) : null;
  }

  recoverInterruptedRenders() {
    for (const job of Object.values(this.state.data.jobs)) {
      if (job.status !== 'running') continue;
      job.status = 'failed'; job.safe_error_code = 'WORKER_INTERRUPTED'; job.completed_at = new Date().toISOString();
      const task = this.state.data.tasks[job.task_id]; const project = task && this.state.data.projects[task.project_id];
      if (task?.active_job_id === job.job_id) { task.status = 'failed'; delete task.active_job_id; }
      if (project) project.status = 'failed';
    }
    this.state.save();
    return Object.values(this.state.data.jobs).filter((job) => job.kind === 'render' && job.status === 'queued').map((job) => job.job_id);
  }

  getOwnedPreview(ownerId, taskId, contentVersion) {
    const task = this.state.data.tasks[taskId];
    if (!task || task.ownerId !== ownerId) return null;
    if (contentVersion !== task.current_version) throw apiError(409, 'VERSION_CONFLICT', '현재 미리보기 버전과 일치하지 않습니다.');
    const job = Object.values(this.state.data.jobs).filter((item) => item.task_id === taskId && item.content_version === contentVersion &&
      item.content_hash === task.content_hash && ['succeeded', 'simulated'].includes(item.status)).sort((left, right) => right.completed_at.localeCompare(left.completed_at))[0];
    if (!job || !job.preview_ready || !job.artifact_key) return null;
    const path = safeStoragePath(this.renderDir, job.artifact_key);
    return { bytes: readRegularFile(path), mode: job.renderer_mode, artifact_verified: job.artifact_verified === true };
  }

  getPublicJob(job) {
    if (!job) return null;
    const { owner_id: _owner, artifact_key: _artifactKey, ...safeJob } = job;
    return { ...safeJob, artifact_verified: job.artifact_verified ?? false, preview_ready: job.preview_ready ?? false };
  }
}

function publicProject(project) {
  const result = { project_id: project.project_id, task_id: project.task_id, status: project.status,
    current_version: project.current_version, content_hash: project.content_hash, media_ids: project.media_ids,
    target_seconds: project.target_seconds, aspect_ratio: project.aspect_ratio, framing: project.framing, focal_x: project.focal_x, focal_y: project.focal_y };
  if (project.style !== undefined) result.style = project.style;
  if (project.media_manifest) result.media_manifest = structuredClone(project.media_manifest);
  return result;
}

function publicationInput(input) {
  const fields = ['platform', 'account_id', 'visibility', 'title', 'description', 'hashtags'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => ![...fields, 'revision'].includes(key)) ||
      fields.some((key) => input[key] === undefined) || !['youtube', 'tiktok', 'instagram'].includes(input.platform) ||
      typeof input.account_id !== 'string' || input.account_id.trim().length < 1 || input.account_id.length > 128 ||
      !['private', 'unlisted', 'public', 'followers'].includes(input.visibility) || typeof input.title !== 'string' || input.title.length > 200 ||
      typeof input.description !== 'string' || input.description.length > 5000 || !Array.isArray(input.hashtags) || input.hashtags.length > 30 ||
      input.hashtags.some((tag) => typeof tag !== 'string' || tag.trim().length < 1 || tag.length > 100)) {
    throw apiError(422, 'VALIDATION_ERROR', '플랫폼 게시 정보를 확인해 주세요.');
  }
  return Object.fromEntries(fields.map((key) => [key, key === 'hashtags' ? [...input[key]] : input[key]]));
}

function publicationHash(value) {
  return sha256(Buffer.from(JSON.stringify({ platform: value.platform, account_id: value.account_id, visibility: value.visibility,
    title: value.title, description: value.description, hashtags: value.hashtags })));
}

function publicPublication(item) {
  const { owner_id: _owner, ...safe } = item;
  return structuredClone(safe);
}

function publicCheckpoint(checkpoint) {
  const { owner_id: _owner, ...safe } = checkpoint;
  return structuredClone(safe);
}

function isValidIdempotencyKey(value) {
  return typeof value === 'string' && value.length >= 16 && value.length <= 200;
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function mediaItemsMatch(items, upload, digest, sizeBytes) {
  if (!Array.isArray(items) || items.length !== 1) return false;
  const item = items[0];
  return item?.client_item_id?.toLowerCase() === upload.clientItemId.toLowerCase() &&
    item?.sha256?.toLowerCase() === digest.toLowerCase() && item?.size_bytes === sizeBytes;
}

function publicPrivacyConsent(consent) {
  const { owner_id: _ownerId, ...publicConsent } = consent;
  return structuredClone(publicConsent);
}

function readRegularFile(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw apiError(409, 'INVALID_STATE_TRANSITION', '업로드 임시 파일을 확인할 수 없습니다.');
  return readFileSync(path);
}

function removeRegularFile(path) {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe temporary upload path.');
    unlinkSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function apiError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
