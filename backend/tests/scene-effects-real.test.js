import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFFmpegRenderer, buildAss } from '../src/media-engine/ffmpeg-renderer.js';

const available = ['ffmpeg', 'ffprobe'].every((tool) => spawnSync(tool, ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0);

test('real FFmpeg applies landscape blur padding, image zoom/pan, fade and Korean subtitle styles', { skip: !available, timeout: 120000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'haejumi-effects-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  const mediaRoot = join(root, 'media'); const outputRoot = join(root, 'out'); mkdirSync(mediaRoot); mkdirSync(outputRoot);
  const picture = join(mediaRoot, 'landscape.jpg');
  const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  ff('-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30', '-vf', 'drawbox=x=0:y=0:w=160:h=360:color=blue:t=fill', '-frames:v', '1', picture);
  const ids = [randomUUID(), randomUUID()];
  const mediaItems = ids.map((mediaId) => ({ mediaId, mediaType: 'image/jpeg', fileName: 'landscape.jpg', storageKey: 'landscape.jpg' }));
  const scenes = [
    { order: 1, media_id: ids[0], start_seconds: 0, end_seconds: 2, framing: 'blur_pad', motion: 'zoom_in', transition: 'cut', subtitle_style: 'emphasis' },
    { order: 2, media_id: ids[1], start_seconds: 2, end_seconds: 4, framing: 'fill_crop', motion: 'pan_left', transition: 'fade', subtitle_style: 'information' },
  ];
  const captions = [
    { order: 1, start_seconds: 0, end_seconds: 2, text: '오늘의 풍경' },
    { order: 2, start_seconds: 2, end_seconds: 4, text: '천천히 살펴보세요' },
  ];
  const ass = buildAss(captions, 4, scenes);
  assert.match(ass, /Emphasis/); assert.match(ass, /Information/);
  const result = await createFFmpegRenderer({ mediaRoot, outputRoot }).render({ mediaItems, scenes, captions,
    targetSeconds: 4, framing: 'fit_pad', projectId: randomUUID(), version: 1 });
  assert.equal(result.verified, true);
  assert.equal(result.verification.width, 1080); assert.equal(result.verification.height, 1920);
  assert.equal(result.verification.video_codec, 'h264'); assert.equal(result.verification.audio_codec, 'aac');
  assert.equal(result.verification.fps, 30);
  const frame = (time) => ff('-ss', String(time), '-i', result.output_path, '-frames:v', '1', '-vf', 'scale=90:160', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1');
  const first = frame(0.5); const later = frame(1.5); const fadeStart = frame(2.03); const fadeMiddle = frame(2.5);
  const pixel = (bytes, x, y) => [...bytes.subarray((y * 90 + x) * 3, (y * 90 + x) * 3 + 3)];
  assert.ok(pixel(first, 2, 70).some((channel) => channel > 15), 'blurred landscape padding should not be black');
  assert.notDeepEqual(first, later, 'zoom should change frames of a still photo');
  const brightness = (bytes) => bytes.reduce((sum, value) => sum + value, 0) / bytes.length;
  assert.ok(brightness(fadeStart) < brightness(fadeMiddle), 'fade should brighten after the scene begins');
});
