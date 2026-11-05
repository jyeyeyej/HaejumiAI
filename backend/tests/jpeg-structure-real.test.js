import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectMedia, sha256, validateMediaBytes } from '../src/security/media-validation.js';
import { resolveMediaToolPaths } from '../src/media-engine/media-tool-paths.js';
import { JsonState } from '../src/adapters/filesystem/json-state.js';
import { LocalRepositories } from '../src/adapters/filesystem/repositories.js';
import { createApiHandler } from '../src/adapters/node-http/transport.js';
import { HaejumiApi } from '../../web/src/api.js';
import { createFFmpegRenderer } from '../src/media-engine/ffmpeg-renderer.js';

const mediaTools = resolveMediaToolPaths();
const available = [mediaTools.ffmpegPath, mediaTools.ffprobePath].every((path) =>
  spawnSync(path, ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0);

function segment(marker, payload) {
  const header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

test('decodable landscape and portrait JPEGs with EXIF, ICC and APP segments pass; truncation fails',
  { skip: !available }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'haejumi-jpeg-structure-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const state = new JsonState(join(dir, 'state.json'));
    const repositories = new LocalRepositories({ state, dataDir: dir, maxMediaBytes: 50 * 1024 * 1024 });
    const server = createServer(createApiHandler({ repositories, maxMediaBytes: 50 * 1024 * 1024,
      auth: { authenticate: async (header) => header === 'Bearer synthetic-token' ? { ownerId: 'synthetic-owner' } : null } }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const api = new HaejumiApi('synthetic-token', (path, options) =>
      fetch(`http://127.0.0.1:${server.address().port}${path}`, options));
    for (const [index, size] of [[1600, 900], [900, 1600]].entries()) {
      const path = join(dir, `synthetic-${index}.jpg`);
      execFileSync(mediaTools.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        `testsrc2=size=${size[0]}x${size[1]}:rate=1`, '-frames:v', '1', '-q:v', '3', '-update', '1', path], { windowsHide: true });
      const base = readFileSync(path);
      const exif = segment(0xe1, Buffer.from('45786966000049492a00080000000000000000000000', 'hex'));
      const icc = segment(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0', 'ascii'), Buffer.from([1, 1, 0, 0, 0, 0])]));
      const app = segment(0xed, Buffer.from('synthetic metadata', 'ascii'));
      const decorated = Buffer.concat([base.subarray(0, 2), exif, icc, app, base.subarray(2)]);
      const withTrailer = Buffer.concat([decorated, Buffer.alloc(229, 0x42)]);
      const mpf = segment(0xe2, Buffer.concat([Buffer.from('MPF\0', 'ascii'), Buffer.alloc(12)]));
      const primaryMpf = Buffer.concat([base.subarray(0, 2), mpf, base.subarray(2)]);
      const companion = Buffer.concat([primaryMpf, decorated, Buffer.alloc(340, 0x42)]);
      const probe = spawnSync(mediaTools.ffprobePath, ['-v', 'error', '-f', 'mjpeg', '-i', 'pipe:0', '-show_entries', 'stream=width,height',
        '-of', 'json'], { input: decorated, encoding: 'utf8', windowsHide: true });
      assert.equal(probe.status, 0);
      assert.deepEqual([JSON.parse(probe.stdout).streams[0].width, JSON.parse(probe.stdout).streams[0].height], size);
      assert.deepEqual(inspectMedia(decorated, 'image/jpeg'), { ok: true });
      assert.deepEqual(inspectMedia(withTrailer, 'image/jpeg'), { ok: true });
      assert.deepEqual(inspectMedia(companion, 'image/jpeg'), { ok: true });
      assert.equal(inspectMedia(Buffer.concat([base, decorated]), 'image/jpeg').ok, false,
        'a second JPEG without a primary MPF marker must be rejected');
      assert.equal(inspectMedia(Buffer.concat([primaryMpf, decorated.subarray(0, -2)]), 'image/jpeg').ok, false,
        'a truncated MPF companion must be rejected');
      const trailerProbe = spawnSync(mediaTools.ffprobePath, ['-v', 'error', '-f', 'mjpeg', '-i', 'pipe:0',
        '-show_entries', 'stream=width,height', '-of', 'json'], { input: withTrailer, encoding: 'utf8', windowsHide: true });
      assert.equal(trailerProbe.status, 0, 'JPEG with a short trailer must remain decodable');
      assert.equal(inspectMedia(Buffer.concat([decorated, Buffer.alloc(1025, 0x42)]), 'image/jpeg').ok, false,
        'oversized appended data must remain blocked');
      assert.equal(validateMediaBytes(decorated, 'image/jpeg', decorated.length, sha256(decorated), 50 * 1024 * 1024, 'synthetic.jpg').ok, true);
      const id = await api.upload(new File([decorated], `synthetic-${index}.jpg`, { type: 'image/jpeg' }),
        { keys: { itemId: randomUUID(), initKey: randomUUID(), partKey: randomUUID(), completeKey: randomUUID() } });
      assert.equal(state.data.media[id].sha256, sha256(decorated));
      assert.equal(state.data.media[id].sizeBytes, decorated.length);
      const trailerId = await api.upload(new File([withTrailer], `synthetic-trailer-${index}.jpg`, { type: 'image/jpeg' }),
        { keys: { itemId: randomUUID(), initKey: randomUUID(), partKey: randomUUID(), completeKey: randomUUID() } });
      assert.equal(state.data.media[trailerId].sha256, sha256(withTrailer));
      assert.equal(state.data.media[trailerId].sizeBytes, withTrailer.length);
      const mpfId = await api.upload(new File([companion], `synthetic-mpf-${index}.jpg`, { type: 'image/jpeg' }),
        { keys: { itemId: randomUUID(), initKey: randomUUID(), partKey: randomUUID(), completeKey: randomUUID() } });
      assert.equal(state.data.media[mpfId].sha256, sha256(companion));
      assert.equal(inspectMedia(decorated.subarray(0, -2), 'image/jpeg').ok, false, 'missing EOI must be rejected');
      assert.equal(inspectMedia(decorated.subarray(0, 12), 'image/jpeg').ok, false, 'truncated APP segment must be rejected');
      const withTem = Buffer.concat([base.subarray(0, 2), Buffer.from([0xff, 0x01]), base.subarray(2)]);
      const temProbe = spawnSync(mediaTools.ffprobePath, ['-v', 'error', '-f', 'mjpeg', '-i', 'pipe:0', '-show_entries',
        'stream=width,height', '-of', 'json'], { input: withTem, encoding: 'utf8', windowsHide: true });
      assert.equal(temProbe.status, 0, 'JPEG decoder should accept the standalone TEM marker');
      assert.deepEqual(inspectMedia(withTem, 'image/jpeg'), { ok: true });
      const temId = await api.upload(new File([withTem], `synthetic-tem-${index}.jpg`, { type: 'image/jpeg' }),
        { keys: { itemId: randomUUID(), initKey: randomUUID(), partKey: randomUUID(), completeKey: randomUUID() } });
      assert.equal(state.data.media[temId].sha256, sha256(withTem));
    }
  });

test('an MPF JPEG is normalized only for rendering and produces a verified MP4',
  { skip: !available }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'haejumi-mpf-render-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const mediaDir = join(dir, 'media'); const renderDir = join(dir, 'renders');
    mkdirSync(mediaDir); mkdirSync(renderDir);
    const basePath = join(dir, 'base.jpg');
    execFileSync(mediaTools.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'testsrc2=size=4000x3000:rate=1', '-frames:v', '1', '-q:v', '3', '-update', '1', basePath], { windowsHide: true });
    const base = readFileSync(basePath);
    const mpf = segment(0xe2, Buffer.concat([Buffer.from('MPF\0', 'ascii'), Buffer.alloc(12)]));
    const source = Buffer.concat([base.subarray(0, 2), mpf, base.subarray(2), base]);
    assert.deepEqual(inspectMedia(source, 'image/jpeg'), { ok: true });
    const originalHash = sha256(source);
    writeFileSync(join(mediaDir, 'synthetic.jpg'), source);
    const calls = []; const errors = [];
    const renderer = createFFmpegRenderer({ mediaRoot: mediaDir, outputRoot: renderDir,
      ffmpegPath: mediaTools.ffmpegPath, ffprobePath: mediaTools.ffprobePath,
      spawn: (executable, args, options) => {
        calls.push(args); const child = spawn(executable, args, options);
        child.stderr?.on('data', (chunk) => errors.push(chunk.toString().slice(0, 500)));
        return child;
      } });
    let result;
    try {
      result = await renderer.render({ mediaItems: [{ mediaType: 'image/jpeg', storageKey: 'synthetic.jpg', fileName: 'synthetic.jpg' }],
        targetSeconds: 3, projectId: randomUUID() });
    } catch (error) { assert.fail(`${error.code}: ${errors.join('').slice(0, 1000)}`); }
    assert.equal(result.verified, true);
    assert.equal(calls.length, 3, 'normalize, render, then verify with ffprobe');
    assert.ok(calls[1].some((arg) => String(arg).endsWith('media-0.png')));
    const captioned = await renderer.render({ mediaItems: [{ mediaType: 'image/jpeg', storageKey: 'synthetic.jpg', fileName: 'synthetic.jpg' }],
      targetSeconds: 3, projectId: randomUUID(), captions: [{ order: 1, start_seconds: 0, end_seconds: 2.5, text: '테스트 자막' }] });
    assert.equal(captioned.verified, true);
    assert.equal(sha256(readFileSync(join(mediaDir, 'synthetic.jpg'))), originalHash);
    const probe = JSON.parse(execFileSync(mediaTools.ffprobePath, ['-v', 'error', '-show_entries',
      'stream=codec_name,width,height,r_frame_rate', '-of', 'json', result.output_path], { encoding: 'utf8', windowsHide: true }));
    assert.ok(probe.streams.some((stream) => stream.codec_name === 'h264' && stream.width === 1080 && stream.height === 1920 && stream.r_frame_rate === '30/1'));
    assert.ok(probe.streams.some((stream) => stream.codec_name === 'aac'));
  });
