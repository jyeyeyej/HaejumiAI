import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

export function makePng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function corruptPngCrc(bytes) {
  const copy = Buffer.from(bytes);
  copy[copy.length - 5] ^= 0x01;
  return copy;
}

export function makeJpegStructure() {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, sos, Buffer.from([0x01, 0xff, 0xd9])]);
}

export function makeWebpStructure() {
  const chunk = Buffer.alloc(14);
  chunk.write('VP8L', 0, 'ascii'); chunk.writeUInt32LE(5, 4);
  chunk[8] = 0x2f;
  const bytes = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), chunk]);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  return bytes;
}

export function makeMp4Structure(brand = 'isom') {
  const ftypPayload = Buffer.alloc(12);
  ftypPayload.write(brand, 0, 'ascii'); ftypPayload.writeUInt32BE(0, 4); ftypPayload.write(brand, 8, 'ascii');
  const hdlrPayload = Buffer.alloc(24);
  hdlrPayload.write('vide', 8, 'ascii');
  const mvhd = box('mvhd', Buffer.alloc(20));
  const hdlr = box('hdlr', hdlrPayload);
  const mdia = box('mdia', hdlr);
  const trak = box('trak', mdia);
  const moov = box('moov', Buffer.concat([mvhd, trak]));
  return Buffer.concat([box('ftyp', ftypPayload), box('mdat', Buffer.from([1, 2, 3, 4])), moov]);
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0); header.write(type, 4, 'ascii');
  return Buffer.concat([header, payload]);
}
