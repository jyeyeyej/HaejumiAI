import { createHash } from 'node:crypto';

export function createCreatorFingerprint(input) {
  const {
    media_ids: mediaIds,
    style,
    target_seconds: targetSeconds = 30,
    aspect_ratio: aspectRatio = '9:16'
  } = input ?? {};

  const framing = input?.framing ?? 'fit_pad';
  const focalX = input?.focal_x ?? 0.5;
  const focalY = input?.focal_y ?? 0.5;

  return JSON.stringify({
    media_ids: mediaIds,
    style: style ?? null,
    target_seconds: targetSeconds,
    aspect_ratio: aspectRatio,
    framing,
    focal_x: focalX,
    focal_y: focalY
  });
}

export function createCreatorIdempotencyKeys(ownerId, idempotencyKey, fingerprint) {
  const semanticHash = createHash('sha256')
    .update(Buffer.from(fingerprint))
    .digest('hex');

  return {
    requestKey: `${ownerId}:project:${idempotencyKey}`,
    semanticKey: `${ownerId}:project-semantic:${semanticHash}`
  };
}
