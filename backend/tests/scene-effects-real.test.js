import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFFmpegRenderer, buildAss } from '../src/media-engine/ffmpeg-renderer.js';
import { proposeBasicEdit, proposeMixedEdit, hasVisibleEditDifference, summarizeTrend } from '../../shared/trend-edit.js';
import { sceneVideoFilters } from '../src/media-engine/scene-effects.js';

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

test('scene-bound Korean captions appear only within their approved scene intervals in a real MP4', { skip: !available, timeout: 120000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'haejumi-scene-caption-real-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  const mediaRoot = join(root, 'media'); const outputRoot = join(root, 'out'); mkdirSync(mediaRoot); mkdirSync(outputRoot);
  const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  for (const [name, color] of [['game.jpg', 'red'], ['food.jpg', 'blue']]) {
    ff('-f', 'lavfi', '-i', `color=c=${color}:s=360x640`, '-frames:v', '1', join(mediaRoot, name));
  }
  const ids = [randomUUID(), randomUUID()]; const sceneIds = [randomUUID(), randomUUID()];
  const mediaItems = ids.map((mediaId, index) => ({ mediaId, mediaType: 'image/jpeg', fileName: index ? 'food.jpg' : 'game.jpg', storageKey: index ? 'food.jpg' : 'game.jpg' }));
  const scenes = ids.map((mediaId, index) => ({ scene_id: sceneIds[index], media_id: mediaId, order: index + 1,
    start_seconds: index * 2, end_seconds: index * 2 + 2, framing: 'fit_pad', motion: 'static', transition: 'cut', subtitle_style: 'default' }));
  const captions = [
    { order: 1, scene_id: sceneIds[0], media_id: ids[0], start_seconds: 0.3, end_seconds: 1.4, text: '친구들과 게임 한 판' },
    { order: 2, scene_id: sceneIds[1], media_id: ids[1], start_seconds: 2.3, end_seconds: 3.4, text: '함께 준비한 음식' },
  ];
  const renderer = createFFmpegRenderer({ mediaRoot, outputRoot });
  const withCaptions = await renderer.render({ mediaItems, scenes, captions, targetSeconds: 4, projectId: randomUUID(), version: 1 });
  const baseline = await renderer.render({ mediaItems, scenes, captions: [], targetSeconds: 4, projectId: randomUUID(), version: 1 });
  assert.equal(withCaptions.verified, true);
  assert.equal(withCaptions.verification.video_codec, 'h264');
  assert.equal(withCaptions.verification.audio_codec, 'aac');
  const frame = (file, time) => ff('-ss', String(time), '-i', file, '-frames:v', '1', '-vf', 'scale=90:160', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1');
  const meanDifference = (a, b) => a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / a.length;
  for (const time of [0.8, 2.8]) {
    const difference = meanDifference(frame(withCaptions.output_path, time), frame(baseline.output_path, time));
    assert.ok(difference > 0.1, `caption must be visible at ${time}s: mean difference ${difference}`);
  }
  for (const time of [1.8, 2.1, 3.8]) {
    const difference = meanDifference(frame(withCaptions.output_path, time), frame(baseline.output_path, time));
    assert.ok(difference < 0.3, `caption must not leak at ${time}s: mean difference ${difference}`);
  }
  const beforeCut = frame(withCaptions.output_path, 1.8); const afterCut = frame(withCaptions.output_path, 2.1);
  assert.notDeepEqual(beforeCut, afterCut, 'the scene source changes at the cut');
});

test('mock trend plus Vision mixed edit renders synthetic photos and video with verified FFmpeg effects', { skip: !available, timeout: 120000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'haejumi-trend-render-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  const mediaRoot = join(root, 'media'); const outputRoot = join(root, 'out'); mkdirSync(mediaRoot); mkdirSync(outputRoot);
  const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  ff('-f', 'lavfi', '-i', 'color=c=0x9b5540:s=640x360', '-frames:v', '1', join(mediaRoot, 'food.jpg'));
  ff('-f', 'lavfi', '-i', 'color=c=blue:s=640x360', '-vf', 'drawbox=x=20:y=20:w=150:h=150:color=yellow:t=fill', '-frames:v', '1', join(mediaRoot, 'travel.jpg'));
  ff('-f', 'lavfi', '-i', 'color=c=green:s=640x360:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(mediaRoot, 'cafe.mp4'));
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const types = ['image/jpeg', 'video/mp4', 'image/jpeg'];
  const names = ['food.jpg', 'cafe.mp4', 'travel.jpg'];
  const plan = { target_seconds: 6, scenes: ids.map((mediaId, index) => ({ order: index + 1, media_id: mediaId,
    media_type: types[index], start_seconds: index * 2, end_seconds: index * 2 + 2 })),
  media_insights: ids.map((mediaId, index) => ({ media_id: mediaId, category: ['food', 'cafe', 'travel'][index], subjects: ['합성 장면'] })) };
  const now = new Date();
  const metadata = { status: 'ok', source: 'youtube_data_api', analysis_scope: 'metadata_only', topic: 'travel',
    period: { from: new Date(now.getTime() - 30 * 86400000).toISOString(), to: now.toISOString() },
    items: [{ title: '합성 여행 브이로그', description: '', url: 'https://www.youtube.com/watch?v=abcDEF123_-',
      published_at: new Date(now.getTime() - 86400000).toISOString(), view_count: 500 }] };
  const proposal = proposeMixedEdit(plan, { source: 'mock' }, summarizeTrend(metadata, now));
  const baseline = proposeBasicEdit(plan);
  assert.equal(proposal[0].media_id, ids[2]);
  assert.equal(hasVisibleEditDifference(baseline, proposal), true);
  const asScenes = (rows) => { let start = 0; return rows.map((row, index) => { const scene = { ...row,
    order: index + 1, start_seconds: start, end_seconds: Number((start + row.duration_seconds).toFixed(2)) };
    start = scene.end_seconds; return scene; }); };
  const scenes = asScenes(proposal);
  const basicScenes = asScenes(baseline);
  const mediaFor = (rows) => rows.map((row) => { const index = ids.indexOf(row.media_id); return { mediaId: row.media_id,
    mediaType: types[index], fileName: names[index], storageKey: names[index] }; });
  const captionsFor = (sceneRows) => sceneRows.map((scene, index) => ({ order: index + 1,
    start_seconds: Number((scene.start_seconds + 0.15).toFixed(2)),
    end_seconds: Number(Math.min(scene.end_seconds - 0.15, scene.start_seconds + 0.9).toFixed(2)),
    text: `${{ [ids[0]]: '음식 장면', [ids[1]]: '카페 장면', [ids[2]]: '여행 장면' }[scene.media_id]}` }));
  const baseFilters = sceneVideoFilters(0, { framing: 'fit_pad', focalX: 0.5, focalY: 0.5 }, basicScenes[0], basicScenes[0].end_seconds, 'image').join(';');
  const trendFilters = sceneVideoFilters(0, { framing: 'fit_pad', focalX: 0.5, focalY: 0.5 }, scenes[0], scenes[0].end_seconds, 'image').join(';');
  assert.doesNotMatch(baseFilters, /colorbalance|eq=|zoompan/);
  assert.match(trendFilters, /colorbalance/);
  assert.match(trendFilters, /zoompan/);
  assert.match(buildAss(captionsFor(scenes), 6, scenes), /,Emphasis,/);
  const renderer = createFFmpegRenderer({ mediaRoot, outputRoot });
  const basicOutput = await renderer.render({ mediaItems: mediaFor(baseline), scenes: basicScenes, captions: captionsFor(basicScenes),
    targetSeconds: 6, framing: 'fit_pad', projectId: randomUUID(), version: 1 });
  const output = await renderer.render({ mediaItems: mediaFor(proposal), scenes, captions: captionsFor(scenes),
    targetSeconds: 6, framing: 'fit_pad', projectId: randomUUID(), version: 1 });
  assert.equal(basicOutput.verified, true);
  assert.equal(output.verified, true);
  assert.equal(basicOutput.verification.duration_seconds > 5.8, true);
  assert.equal(output.verification.width, 1080); assert.equal(output.verification.height, 1920);
  assert.equal(output.verification.fps, 30); assert.equal(output.verification.video_codec, 'h264');
  assert.equal(output.verification.audio_codec, 'aac');
  const frame = (file, time) => ff('-ss', String(time), '-i', file, '-frames:v', '1', '-vf', 'scale=90:160',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1');
  const basicFirst = frame(basicOutput.output_path, 0.5);
  const first = frame(output.output_path, 0.5); const later = frame(output.output_path, 1.5);
  const second = frame(output.output_path, scenes[1].start_seconds + 0.5);
  assert.notDeepEqual(first, later, 'first travel photo zoom should change frames');
  const meanDifference = (a, b) => a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / a.length;
  const openingDifference = meanDifference(basicFirst, first);
  assert.ok(openingDifference > 20, `basic and mixed opening frames must visibly differ: ${openingDifference}`);
  const basicFood = frame(basicOutput.output_path, 0.5);
  assert.ok(meanDifference(basicFood, second) > 5, 'the matching food media must show a distinct crop/color grade');
  const center = (bytes) => [...bytes.subarray((80 * 90 + 45) * 3, (80 * 90 + 45) * 3 + 3)];
  assert.ok(center(basicFirst)[0] > center(basicFirst)[2], 'baseline food photo must appear first');
  assert.ok(center(first)[2] > center(first)[0], 'travel blue scene should appear first');
  assert.ok(center(second)[0] > center(second)[2], 'food red scene should follow the trend-selected opening');
  assert.notDeepEqual(basicScenes.map((scene) => scene.media_id), scenes.map((scene) => scene.media_id));
  assert.notDeepEqual(basicScenes.map((scene) => scene.end_seconds - scene.start_seconds),
    scenes.map((scene) => scene.end_seconds - scene.start_seconds));
  const cafe = scenes.find((scene) => scene.media_id === ids[1]);
  const fadeStart = frame(output.output_path, cafe.start_seconds + 0.03);
  const fadeMiddle = frame(output.output_path, cafe.start_seconds + 0.5);
  const brightness = (bytes) => bytes.reduce((sum, value) => sum + value, 0) / bytes.length;
  assert.ok(brightness(fadeStart) < brightness(fadeMiddle), 'cafe scene must brighten after the fade begins');
  t.diagnostic(`synthetic basic/mixed MP4: opening mean RGB difference ${openingDifference.toFixed(1)}/255; order, duration, grade, fade and caption styles differ`);
  assert.ok(scenes.some((scene) => scene.transition === 'fade'));
});
