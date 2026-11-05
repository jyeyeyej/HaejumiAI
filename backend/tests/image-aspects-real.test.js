import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonState } from '../src/adapters/filesystem/json-state.js';
import { LocalRepositories } from '../src/adapters/filesystem/repositories.js';
import { createApiHandler } from '../src/adapters/node-http/transport.js';
import { resolveMediaToolPaths } from '../src/media-engine/media-tool-paths.js';
import { createFFmpegRenderer } from '../src/media-engine/ffmpeg-renderer.js';
import { HaejumiApi } from '../../web/src/api.js';

const toolPaths = resolveMediaToolPaths();
const available = [toolPaths.ffmpegPath, toolPaths.ffprobePath].every((path) => spawnSync(path, ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0);

test('landscape, portrait and square JPEG/PNG upload and attach to one owned project', { skip: !available }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'haejumi-image-aspects-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = new JsonState(join(root, 'state.json'));
  const repositories = new LocalRepositories({ state, dataDir: root, maxMediaBytes: 50 * 1024 * 1024 });
  const auth = { authenticate: async (header) => header === 'Bearer synthetic-token' ? { ownerId: 'synthetic-owner' } : null };
  const server = createServer(createApiHandler({ repositories, auth, maxMediaBytes: 50 * 1024 * 1024 }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = new HaejumiApi('synthetic-token', (path, options) => fetch(base + path, options));
  const sizes = [[640, 360], [360, 640], [480, 480]];
  const cases = ['jpg', 'png'].flatMap((extension) => sizes.map(([width, height]) => ({ extension, width, height })));
  const selected = cases.map(({ extension, width, height }, index) => {
    const filePath = join(root, `synthetic-${index}.${extension}`);
    execFileSync(toolPaths.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=${width}x${height}`,
      ...(index === 0 ? ['-vf', 'drawbox=x=0:y=0:w=160:h=360:color=yellow:t=fill'] : []),
      '-frames:v', '1', '-q:v', '4', '-update', '1', filePath], { windowsHide: true });
    return { file: new File([readFileSync(filePath)], `합성-${index}.${extension}`, { type: extension === 'jpg' ? 'image/jpeg' : 'image/png' }),
      keys: { itemId: randomUUID(), partKey: randomUUID() } };
  });
  const ids = await api.uploadMany(selected, { keys: { initKey: randomUUID(), completeKey: randomUUID() } });
  assert.equal(ids.length, 6);
  const project = await api.createProject(ids, randomUUID());
  assert.deepEqual(project.media_ids, ids);
  for (const [index, id] of ids.entries()) {
    const media = state.data.media[id];
    assert.equal(media.ownerId, 'synthetic-owner');
    const probe = JSON.parse(execFileSync(toolPaths.ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=width,height', '-of', 'json', join(repositories.blobDir, media.storageKey)], { encoding: 'utf8', windowsHide: true }));
    assert.deepEqual([probe.streams[0].width, probe.streams[0].height], [cases[index].width, cases[index].height]);
  }
  const scenes = ids.map((id, index) => ({ order: index + 1, media_id: id, start_seconds: index, end_seconds: index + 1,
    framing: index % 3 === 0 ? 'blur_pad' : index % 3 === 1 ? 'fit_pad' : 'fill_crop',
    motion: index === 0 ? 'zoom_in' : 'static', transition: 'cut', subtitle_style: 'default' }));
  const captions = [{ order: 1, start_seconds: 0.1, end_seconds: 0.9, text: '가로 사진' },
    { order: 2, start_seconds: 5.1, end_seconds: 5.9, text: '정사각 사진' }];
  const output = await createFFmpegRenderer({ mediaRoot: repositories.blobDir, outputRoot: repositories.renderDir, ...toolPaths }).render({
    mediaItems: ids.map((id) => ({ mediaId: id, mediaType: state.data.media[id].mediaType,
      fileName: state.data.media[id].fileName, storageKey: state.data.media[id].storageKey })),
    scenes, captions, targetSeconds: 6, framing: 'fit_pad', projectId: project.project_id, version: 1 });
  assert.equal(output.verified, true);
  assert.deepEqual([output.verification.width, output.verification.height, output.verification.fps], [1080, 1920, 30]);
  assert.deepEqual([output.verification.video_codec, output.verification.audio_codec], ['h264', 'aac']);
  assert.ok(output.verification.duration_seconds >= 6 && output.verification.duration_seconds < 60);
  const frame = (seconds) => execFileSync(toolPaths.ffmpegPath, ['-v', 'error', '-ss', String(seconds), '-i', output.output_path,
    '-frames:v', '1', '-vf', 'scale=90:160', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true });
  const first = frame(0.2); const later = frame(0.8);
  const topPixel = first.subarray((2 * 90 + 2) * 3, (2 * 90 + 2) * 3 + 3);
  assert.ok([...topPixel].some((value) => value > 15), 'landscape blur background should not be black');
  assert.notDeepEqual(first, later, 'landscape photo motion should change output frames');
});
