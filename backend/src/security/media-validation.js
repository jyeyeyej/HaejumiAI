import { createHash } from 'node:crypto';

const SIGNATURES = new Map([
  ['image/jpeg', (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))],
  ['image/webp', (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'],
  ['video/mp4', (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' && !b.toString('ascii', 8, 12).startsWith('qt')],
  ['video/quicktime', (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' && b.toString('ascii', 8, 12).startsWith('qt')],
]);

export function isAllowedMediaType(value) {
  return SIGNATURES.has(value);
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function validateMediaBytes(bytes, declaredType, expectedSize, expectedSha256, maxBytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maxBytes) {
    return { ok: false, code: 'PAYLOAD_TOO_LARGE' };
  }
  if (!SIGNATURES.has(declaredType) || !SIGNATURES.get(declaredType)(bytes)) {
    return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE' };
  }
  if (bytes.length !== expectedSize || sha256(bytes).toLowerCase() !== String(expectedSha256).toLowerCase()) {
    return { ok: false, code: 'VERSION_CONFLICT' };
  }
  return { ok: true, sha256: sha256(bytes), sizeBytes: bytes.length };
}

export function isSafeDisplayName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 &&
    !/[\\/\0]/.test(name) && name !== '.' && name !== '..';
}
