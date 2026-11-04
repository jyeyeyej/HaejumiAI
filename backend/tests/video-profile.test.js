import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRenderArgs } from '../src/media-engine/ffmpeg-renderer.js';
import { inspectRenderedVideo } from '../src/media-engine/ffprobe-validator.js';
import { captionSafeArea, CREATOR_VIDEO_PROFILE, validateRenderOptions, videoFilter } from '../src/media-engine/video-profile.js';

test('Creator video profile and duration bounds match the confirmed specification', () => {
  assert.deepEqual(CREATOR_VIDEO_PROFILE, { aspectRatio: '9:16', width: 1080, height: 1920, minimumSeconds: 3,
    maximumSecondsExclusive: 60, defaultSeconds: 30, videoFormat: 'mp4', videoCodec: 'h264', audioCodec: 'aac', framesPerSecond: 30 });
  assert.equal(validateRenderOptions({}).targetSeconds, 30);
  for (const seconds of [3, 30, 59]) assert.equal(validateRenderOptions({ targetSeconds: seconds }).targetSeconds, seconds);
  for (const seconds of [2, 60, 90, 3.5]) assert.throws(() => validateRenderOptions({ targetSeconds: seconds }), { code: 'VALIDATION_ERROR' });
});

test('fit_pad preserves the full frame and fill_crop accepts a user focal point', () => {
  assert.match(videoFilter({ framing: 'fit_pad' }), /force_original_aspect_ratio=decrease,pad=1080:1920/);
  assert.match(videoFilter({ framing: 'fill_crop', focalX: 0.25, focalY: 0.7 }), /crop=1080:1920:x=\(iw-ow\)\*0\.25:y=\(ih-oh\)\*0\.7/);
  assert.deepEqual(captionSafeArea(), { left: 108, right: 972, top: 288, bottom: 1536 });
  assert.throws(() => validateRenderOptions({ framing: 'fill_crop', focalX: 2 }), { code: 'VALIDATION_ERROR' });
});

test('render command emits vertical 1080p 30fps H.264 MP4 with AAC audio', () => {
  const args = buildRenderArgs([{ kind: 'image', path: 'photo.jpg' }, { kind: 'video', path: 'clip.mp4' }], 'result.mp4', { targetSeconds: 30 });
  assert.ok(args.includes('libx264'));
  assert.ok(args.includes('aac'));
  assert.ok(args.includes('30'));
  assert.ok(args.join(' ').includes('1080:1920:force_original_aspect_ratio=decrease'));
  assert.ok(args.includes('mp4'));
  assert.equal(args.at(-1), 'result.mp4');
});

test('video source end position bounds the selected input interval', () => {
  const args = buildRenderArgs([{ kind: 'video', path: 'clip.mp4' }], 'result.mp4', {
    targetSeconds: 3, timeline: [{ duration: 3, trimStart: 2, trimEnd: 5 }] });
  assert.deepEqual(args.slice(args.indexOf('-ss'), args.indexOf('-i') + 2), ['-ss', '2', '-t', '3', '-i', 'clip.mp4']);
});

test('ffprobe accepts only a file that meets every required render invariant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'haejumi-render-test-'));
  const filePath = join(dir, 'result.mp4');
  writeFileSync(filePath, Buffer.from('synthetic output marker'));
  const spawn = (_command, _args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.end(JSON.stringify({
        streams: [
          { codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, r_frame_rate: '30/1', avg_frame_rate: '30/1' },
          { codec_type: 'audio', codec_name: 'aac' },
        ], format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '30.000000' },
      }));
      child.emit('close', 0);
    });
    return child;
  };
  try {
    const result = await inspectRenderedVideo({ spawn, filePath });
    assert.equal(result.valid, true);
    assert.equal(result.duration_seconds, 30);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
