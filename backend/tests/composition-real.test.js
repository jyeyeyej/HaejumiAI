import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { buildAss, createFFmpegRenderer } from '../src/media-engine/ffmpeg-renderer.js';

const installed = ['ffmpeg', 'ffprobe'].every((name) => spawnSync(name, ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0);

test('real FFmpeg combines five synthetic photos and two videos into one verified short', { skip: !installed, timeout: 120000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'haejumi-mixed-render-'));
  t.after(() => { const base = resolve(tmpdir()) + sep; assert.ok(resolve(root).startsWith(base)); rmSync(root, { recursive: true, force: true }); });
  const mediaRoot = join(root, 'media'); const outputRoot = join(root, 'renders');
  mkdirSync(mediaRoot); mkdirSync(outputRoot);
  const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
  const mediaItems = [];
  for (let index = 0; index < 5; index++) {
    const fileName = `image-${index}.jpg`;
    ff('-f', 'lavfi', '-i', `color=c=${['red', 'green', 'blue', 'yellow', 'magenta'][index]}:s=320x240:r=30`, '-frames:v', '1', join(mediaRoot, fileName));
    mediaItems.push({ mediaId: randomUUID(), mediaType: 'image/jpeg', fileName, storageKey: fileName });
  }
  for (let index = 0; index < 2; index++) {
    const fileName = `clip-${index}.mp4`;
    ff('-f', 'lavfi', '-i', `testsrc2=s=320x240:r=30`, '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(mediaRoot, fileName));
    mediaItems.push({ mediaId: randomUUID(), mediaType: 'video/mp4', fileName, storageKey: fileName });
  }
  const renderer = createFFmpegRenderer({ mediaRoot, outputRoot });
  const scenes = mediaItems.map((item, index) => ({ order: index + 1, media_id: item.mediaId, start_seconds: index,
    end_seconds: index + 1, ...(item.mediaType.startsWith('video/') ? { trim_start_seconds: 0.25 } : {}) }));
  const result = await renderer.render({ mediaItems, scenes, targetSeconds: 7, framing: 'fit_pad', projectId: randomUUID(), version: 1 });
  assert.equal(result.verified, true);
  assert.equal(result.verification.width, 1080); assert.equal(result.verification.height, 1920);
  assert.equal(result.verification.fps, 30); assert.equal(result.verification.video_codec, 'h264'); assert.equal(result.verification.audio_codec, 'aac');
  assert.ok(result.verification.duration_seconds >= 7 && result.verification.duration_seconds < 60);
});

test('caption input cannot inject ASS overrides or exceed safe layout', () => {
  const ass = buildAss([{ order: 1, start_seconds: 0, end_seconds: 3, text: '안녕 {\\pos(0,0)}' }], 3);
  assert.match(ass, /｛＼pos\(0,0\)｝/);
  assert.throws(() => buildAss([{ order: 1, start_seconds: 0, end_seconds: 3, text: '가'.repeat(81) }], 3), { code: 'VALIDATION_ERROR' });
});

test('real FFmpeg burns Korean captions and mixes original and music with fades', { skip: !installed, timeout: 120000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'haejumi-composition-test-'));
  if (process.env.HAEJUMI_KEEP_SYNTHETIC_TEST_OUTPUT !== '1') t.after(() => {
    const base = resolve(tmpdir()) + sep;
    assert.ok(resolve(root).startsWith(base));
    rmSync(root, { recursive: true, force: true });
  });
  const mediaRoot = join(root, 'media'); const outputRoot = join(root, 'renders'); const musicRoot = join(root, 'music');
  for (const dir of [mediaRoot, outputRoot, musicRoot]) mkdirSync(dir);
  const clip = join(mediaRoot, 'source.mp4'); const music = join(musicRoot, 'tone.wav');
  const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', clip);
  ff('-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '3', '-c:a', 'pcm_s16le', music);
  const renderer = createFFmpegRenderer({ mediaRoot, outputRoot });
  const mediaId = randomUUID();
  const result = await renderer.render({ mediaItems: [{ mediaId, mediaType: 'video/mp4', fileName: 'source.mp4', storageKey: 'source.mp4' }], targetSeconds: 3, framing: 'fit_pad', projectId: randomUUID(), version: 1,
    captions: [{ order: 1, start_seconds: 0, end_seconds: 3, text: '안녕하세요 테스트 자막입니다' }], musicPath: music,
    composition: { captions_enabled: true, source_volume: 0.8, music_volume: 0.6, fade_in_seconds: 0.5, fade_out_seconds: 0.5 } });
  assert.equal(result.mode, 'ffmpeg'); assert.equal(result.verified, true);
  assert.deepEqual(result.source_audio_media_ids, [mediaId]);
  assert.equal(result.verification.width, 1080); assert.equal(result.verification.height, 1920); assert.equal(result.verification.fps, 30);
  assert.equal(result.verification.video_codec, 'h264'); assert.equal(result.verification.audio_codec, 'aac');
  assert.ok(result.verification.duration_seconds >= 3 && result.verification.duration_seconds < 60);
  const frame = ff('-ss', '1', '-i', result.output_path, '-vf', 'crop=864:200:108:1336,format=gray', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1');
  assert.ok(frame.filter((v) => v > 200).length > 40, 'caption pixels should appear in the reserved safe area');
  const pcm = ff('-i', result.output_path, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1');
  const sample = (i) => pcm.readFloatLE(i * 4);
  const magnitude = (hz) => { let re = 0; let im = 0; const start = 8000; const n = 4000; for (let i = 0; i < n; i++) { const v = sample(start + i); re += v * Math.cos(2 * Math.PI * hz * i / 8000); im += v * Math.sin(2 * Math.PI * hz * i / 8000); } return 2 * Math.hypot(re, im) / n; };
  assert.ok(magnitude(440) > 0.01, 'original audio must be present');
  assert.ok(magnitude(880) > 0.01, 'music audio must be present');
  const rms = (start, count) => { let sum = 0; for (let i = 0; i < count; i++) sum += sample(start + i) ** 2; return Math.sqrt(sum / count); };
  assert.ok(rms(0, 800) < rms(8000, 800) * 0.7, 'fade-in must lower initial volume');
  assert.ok(rms(23200, 800) < rms(8000, 800) * 0.7, 'fade-out must lower ending volume');
  const mutedOriginal = await renderer.render({ mediaItems: [{ mediaId, mediaType: 'video/mp4', fileName: 'source.mp4', storageKey: 'source.mp4' }], targetSeconds: 3, framing: 'fit_pad', projectId: randomUUID(), version: 1,
    captions: [{ order: 1, start_seconds: 0, end_seconds: 3, text: '안녕하세요 테스트 자막입니다' }], musicPath: music, composition: { captions_enabled: true, source_volume: 0, music_volume: 0.6, fade_in_seconds: 0, fade_out_seconds: 0 },
    reuseVideo: { path: result.output_path, sha256: createHash('sha256').update(readFileSync(result.output_path)).digest('hex') } });
  assert.equal(mutedOriginal.video_reused, true);
  const videoHash = (path) => createHash('sha256').update(ff('-i', path, '-map', '0:v:0', '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', 'pipe:1')).digest('hex');
  assert.equal(videoHash(result.output_path), videoHash(mutedOriginal.output_path), 'audio-only changes must reuse the exact video bitstream');
  const mutedPcm = ff('-i', mutedOriginal.output_path, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1');
  const frequency = (hz) => { let re = 0; let im = 0; for (let i = 0; i < 4000; i++) { const v = mutedPcm.readFloatLE((8000 + i) * 4); re += v * Math.cos(2 * Math.PI * hz * i / 8000); im += v * Math.sin(2 * Math.PI * hz * i / 8000); } return 2 * Math.hypot(re, im) / 4000; };
  assert.ok(frequency(440) < 0.002, 'original mute must remove the original tone');
  assert.ok(frequency(880) > 0.01, 'music must remain audible when the original is muted');
  const mutedMusic = await renderer.render({ mediaItems: [{ mediaId, mediaType: 'video/mp4', fileName: 'source.mp4', storageKey: 'source.mp4' }], targetSeconds: 3, framing: 'fit_pad', projectId: randomUUID(), version: 1,
    captions: [{ order: 1, start_seconds: 0, end_seconds: 3, text: '안녕하세요 테스트 자막입니다' }], musicPath: music, composition: { captions_enabled: true, source_volume: 0.8, music_volume: 0, fade_in_seconds: 0, fade_out_seconds: 0 },
    reuseVideo: { path: result.output_path, sha256: createHash('sha256').update(readFileSync(result.output_path)).digest('hex') } });
  const sourceOnlyPcm = ff('-i', mutedMusic.output_path, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1');
  const sourceOnlyFrequency = (hz) => { let re = 0; let im = 0; for (let i = 0; i < 4000; i++) { const v = sourceOnlyPcm.readFloatLE((8000 + i) * 4); re += v * Math.cos(2 * Math.PI * hz * i / 8000); im += v * Math.sin(2 * Math.PI * hz * i / 8000); } return 2 * Math.hypot(re, im) / 4000; };
  assert.ok(sourceOnlyFrequency(440) > 0.01, 'original audio must remain audible when music is muted');
  assert.ok(sourceOnlyFrequency(880) < 0.002, 'music mute must remove the music tone');
  const mp3 = join(musicRoot, 'tone.mp3');
  ff('-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '3', '-c:a', 'libmp3lame', mp3);
  const mp3Result = await renderer.render({ mediaItems: [{ mediaId, mediaType: 'video/mp4', fileName: 'source.mp4', storageKey: 'source.mp4' }], targetSeconds: 3, framing: 'fit_pad', projectId: randomUUID(), version: 1,
    captions: [{ order: 1, start_seconds: 0, end_seconds: 3, text: '안녕하세요 테스트 자막입니다' }], musicPath: mp3, composition: { captions_enabled: true, source_volume: 0, music_volume: 0.6, fade_in_seconds: 0, fade_out_seconds: 0 },
    reuseVideo: { path: result.output_path, sha256: createHash('sha256').update(readFileSync(result.output_path)).digest('hex') } });
  assert.equal(mp3Result.verified, true, 'MP3 music must render to a verified MP4');
  assert.equal(mp3Result.video_reused, true);
  const plain = await renderer.render({ mediaItems: [{ mediaType: 'video/mp4', fileName: 'source.mp4', storageKey: 'source.mp4' }], targetSeconds: 3, framing: 'fit_pad', projectId: randomUUID(), version: 1 });
  assert.equal(plain.verified, true, 'legacy render without captions or music must remain available');
  t.diagnostic(`Synthetic rendered MP4: ${result.output_path}`);
});
