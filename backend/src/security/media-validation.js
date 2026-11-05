import { createHash } from 'node:crypto';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_JPEG_TRAILER_BYTES = 1024;
const CRC_TABLE = createCrcTable();
const EXTENSIONS = new Map([
  ['image/jpeg', new Set(['.jpg', '.jpeg'])],
  ['image/png', new Set(['.png'])],
  ['image/webp', new Set(['.webp'])],
  ['video/mp4', new Set(['.mp4', '.m4v'])],
  ['video/quicktime', new Set(['.mov', '.qt'])],
]);

export function isAllowedMediaType(value) {
  return EXTENSIONS.has(value);
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isSafeDisplayName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255 || name !== name.trim()) return false;
  if (/[\\/\0-\x1f<>:"|?*]/.test(name) || name === '.' || name === '..') return false;
  const deviceName = name.split('.')[0].replace(/[. ]+$/g, '').toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(deviceName)) return false;
  return true;
}

export function extensionMatches(name, declaredType) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return true; // Extensionless display names are permitted.
  const extension = name.slice(dot).toLowerCase();
  return EXTENSIONS.get(declaredType)?.has(extension) === true;
}

export function canonicalManifestBytes(items) {
  const normalized = items.map((item) => ({
    client_item_id: String(item.client_item_id).toLowerCase(),
    sha256: String(item.sha256).toLowerCase(),
    size_bytes: Number(item.size_bytes),
  }));
  return Buffer.from(JSON.stringify(normalized), 'utf8');
}

export function validateMediaBytes(bytes, declaredType, expectedSize, expectedSha256, maxBytes, fileName) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { ok: false, code: 'VALIDATION_ERROR' };
  if (bytes.length > maxBytes) return { ok: false, code: 'PAYLOAD_TOO_LARGE' };
  if (bytes.length !== expectedSize) return { ok: false, code: 'VERSION_CONFLICT' };
  if (!EXTENSIONS.has(declaredType) || (fileName && !extensionMatches(fileName, declaredType))) {
    return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE' };
  }

  const inspected = inspectMedia(bytes, declaredType);
  if (!inspected.ok) return inspected;
  const digest = sha256(bytes);
  if (digest.toLowerCase() !== String(expectedSha256).toLowerCase()) return { ok: false, code: 'VERSION_CONFLICT' };
  return { ok: true, sha256: digest, sizeBytes: bytes.length, mediaType: declaredType, verification: 'container-structure' };
}

export function inspectMedia(bytes, declaredType) {
  try {
    const sniffedType = sniffMediaType(bytes);
    if (!sniffedType || sniffedType !== declaredType) return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE' };
    const valid = declaredType === 'image/png' ? inspectPng(bytes)
      : declaredType === 'image/jpeg' ? inspectJpeg(bytes)
      : declaredType === 'image/webp' ? inspectWebp(bytes)
      : declaredType === 'video/mp4' || declaredType === 'video/quicktime' ? inspectIsoBmff(bytes, declaredType)
      : false;
    return valid ? { ok: true } : { ok: false, code: 'VALIDATION_ERROR' };
  } catch {
    return { ok: false, code: 'VALIDATION_ERROR' };
  }
}

function sniffMediaType(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    return bytes.toString('ascii', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  return null;
}

function inspectPng(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let offset = 8;
  let header = null;
  let sawData = false;
  let ended = false;
  const idatChunks = [];
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) return false;
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const crcStart = dataStart + length;
    const end = crcStart + 4;
    if (end > bytes.length) return false;
    const type = bytes.toString('ascii', typeStart, dataStart);
    const data = bytes.subarray(dataStart, crcStart);
    if (readCrc32(bytes.subarray(typeStart, crcStart)) !== bytes.readUInt32BE(crcStart)) return false;
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (offset === 8 && type !== 'IHDR') return false;
    if (type === 'IHDR') {
      if (header || length !== 13) return false;
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const depth = data[8];
      const color = data[9];
      if (!width || !height || !validPngDepth(depth, color) || data[10] !== 0 || data[11] !== 0 || data[12] > 1) return false;
      header = { width, height, interlace: data[12] };
    } else if (type === 'IDAT') {
      if (!header || ended) return false;
      sawData = true;
      idatChunks.push(data);
    } else if (type === 'IEND') {
      if (length !== 0 || !sawData || end !== bytes.length) return false;
      ended = true;
      offset = end;
      break;
    } else if (type[0] === type[0].toUpperCase() && !['PLTE', 'tRNS'].includes(type)) {
      return false; // Unknown critical chunk.
    } else if (sawData && type !== 'IEND') {
      // PNG requires IDAT chunks to be consecutive.
      if (type !== 'IDAT') return false;
    }
    offset = end;
  }
  if (!ended || !header || !sawData || !idatChunks.length) return false;
  const compressed = Buffer.concat(idatChunks);
  if (compressed.length < 6) return false;
  const cmf = compressed[0];
  const flg = compressed[1];
  return (cmf & 0x0f) === 8 && (cmf >>> 4) <= 7 && (flg & 0x20) === 0 && ((cmf << 8) + flg) % 31 === 0 &&
    header.width > 0 && header.height > 0;
}

function validPngDepth(depth, color) {
  const allowed = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  return allowed[color]?.includes(depth) === true;
}

function inspectJpeg(bytes, allowMpfCompanion = false, depth = 0) {
  if (bytes.length < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  let ended = false;
  let hasMpf = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset++];
    // Some decodable JPEG exports append a small metadata trailer after EOI.
    // Keep the trailer bounded; the full original bytes remain size/hash verified.
    if (marker === 0xd9) {
      const trailing = bytes.subarray(offset);
      const companionStarts = trailing.length >= 2 && trailing[0] === 0xff && trailing[1] === 0xd8;
      ended = companionStarts ? depth < 8 && (hasMpf || allowMpfCompanion) && inspectJpeg(trailing, true, depth + 1)
        : trailing.length <= MAX_JPEG_TRAILER_BYTES;
      break;
    }
    if (marker === 0x01) continue; // TEM is a standalone JPEG marker without a length field.
    if (marker === 0x00 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7) return false;
    if (offset + 2 > bytes.length) return false;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return false;
    const segmentStart = offset + 2;
    const segmentEnd = offset + segmentLength;
    if (marker === 0xe2 && bytes.toString('ascii', segmentStart, segmentStart + 4) === 'MPF\0') hasMpf = true;
    if (isJpegFrameMarker(marker)) {
      if (segmentLength < 8) return false;
      const height = bytes.readUInt16BE(segmentStart + 1);
      const width = bytes.readUInt16BE(segmentStart + 3);
      const components = bytes[segmentStart + 5];
      if (!width || !height || !components || segmentLength !== 8 + 3 * components) return false;
      sawFrame = true;
    }
    offset = segmentEnd;
    if (marker === 0xda) {
      if (!sawFrame) return false;
      sawScan = true;
      let hasEntropy = false;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { hasEntropy = true; offset++; continue; }
        let markerOffset = offset + 1;
        while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) markerOffset++;
        if (markerOffset >= bytes.length) return false;
        const next = bytes[markerOffset];
        if (next === 0x00 || next >= 0xd0 && next <= 0xd7) { hasEntropy = true; offset = markerOffset + 1; continue; }
        if (!hasEntropy) return false;
        offset = offset;
        break;
      }
      if (!hasEntropy || offset >= bytes.length) return false;
    }
  }
  return ended && sawFrame && sawScan;
}

function isJpegFrameMarker(marker) {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function inspectWebp(bytes) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return false;
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  let offset = 12;
  let sawImage = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) return false;
    const fourcc = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    const paddedEnd = dataEnd + (size & 1);
    if (paddedEnd > bytes.length) return false;
    if (fourcc === 'VP8 ' && size >= 10) {
      sawImage = bytes[dataStart + 3] === 0x9d && bytes[dataStart + 4] === 0x01 && bytes[dataStart + 5] === 0x2a;
    } else if (fourcc === 'VP8L' && size >= 5) {
      sawImage = bytes[dataStart] === 0x2f;
    } else if (fourcc === 'VP8X' && size === 10) {
      // VP8X only describes an extended container; it does not itself contain pixels.
    }
    offset = paddedEnd;
  }
  return offset === bytes.length && sawImage;
}

function inspectIsoBmff(bytes, declaredType) {
  const top = readBoxes(bytes, 0, bytes.length);
  if (!top || top.length < 3 || top[0].type !== 'ftyp') return false;
  const ftyp = top[0];
  if (ftyp.end - ftyp.dataStart < 8) return false;
  const major = bytes.toString('ascii', ftyp.dataStart, ftyp.dataStart + 4);
  const isQuickTime = major === 'qt  ';
  if ((declaredType === 'video/quicktime') !== isQuickTime) return false;
  const moov = top.find((box) => box.type === 'moov');
  const mdat = top.find((box) => box.type === 'mdat' && box.end > box.dataStart);
  if (!moov || !mdat) return false;
  const moovChildren = readBoxes(bytes, moov.dataStart, moov.end);
  if (!moovChildren?.some((box) => box.type === 'mvhd')) return false;
  const tracks = moovChildren.filter((box) => box.type === 'trak');
  return tracks.some((track) => {
    const children = readBoxes(bytes, track.dataStart, track.end);
    const mdia = children?.find((box) => box.type === 'mdia');
    if (!mdia) return false;
    return readBoxes(bytes, mdia.dataStart, mdia.end)?.some((box) => {
      if (box.type !== 'hdlr') return false;
      const dataLength = box.end - box.dataStart;
      return dataLength >= 12 && bytes.toString('ascii', box.dataStart + 8, box.dataStart + 12) === 'vide';
    }) === true;
  });
}

function readBoxes(bytes, start, end) {
  const boxes = [];
  let offset = start;
  while (offset < end) {
    if (end - offset < 8) return null;
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (end - offset < 16) return null;
      const wide = bytes.readBigUInt64BE(offset + 8);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(wide);
      header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) return null;
    boxes.push({ type, start: offset, dataStart: offset + header, end: offset + size });
    offset += size;
  }
  return offset === end ? boxes : null;
}

function readCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createCrcTable() {
  return Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    return crc >>> 0;
  });
}
