/**
 * Replaceable persistence contracts. Implementations must scope every lookup by
 * ownerId and must never expose a filesystem path to API callers.
 */
export class MediaRepository {
  async createUpload(_ownerId, _items) { throw new Error('Not implemented'); }
  async putUploadPart(_ownerId, _uploadId, _partNumber, _bytes) { throw new Error('Not implemented'); }
  async completeUpload(_ownerId, _uploadId, _manifest) { throw new Error('Not implemented'); }
  async getOwnedMedia(_ownerId, _mediaId) { throw new Error('Not implemented'); }
}

export class ProjectRepository {
  async createForOwner(_ownerId, _mediaIds, _idempotencyKey) { throw new Error('Not implemented'); }
}

export class TaskRepository {
  async getOwnedTask(_ownerId, _taskId) { throw new Error('Not implemented'); }
}

export class Authenticator {
  async authenticate(_authorizationHeader) { throw new Error('Not implemented'); }
}
