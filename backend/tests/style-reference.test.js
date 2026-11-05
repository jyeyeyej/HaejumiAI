import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonState } from '../src/adapters/filesystem/json-state.js';
import { LocalRepositories } from '../src/adapters/filesystem/repositories.js';
import { createApiHandler } from '../src/adapters/node-http/transport.js';
import { CreatorAgent } from '../src/agents/creator-agent.js';
import { parseStyleReferenceUrl, analyzeLocalStyleVideo } from '../src/media-engine/style-reference.js';
import { createFFmpegRenderer } from '../src/media-engine/ffmpeg-renderer.js';
import { resolveMediaToolPaths } from '../src/media-engine/media-tool-paths.js';
import { sha256 } from '../src/security/media-validation.js';
import { proposeBasicEdit, proposeReferenceEdit } from '../../shared/trend-edit.js';

test('only recognized HTTPS video URLs are accepted without fetching user supplied hosts', () => {
  assert.deepEqual(parseStyleReferenceUrl('https://www.youtube.com/shorts/abcDEF123_-'),
    { platform: 'youtube', video_id: 'abcDEF123_-', url: 'https://www.youtube.com/watch?v=abcDEF123_-' });
  assert.equal(parseStyleReferenceUrl('https://www.instagram.com/reel/ABCD1234/').platform, 'instagram');
  assert.equal(parseStyleReferenceUrl('https://www.tiktok.com/@creator/video/1234567890123456789').platform, 'tiktok');
  for (const value of ['http://youtube.com/shorts/abcDEF123_-', 'https://youtube.com.evil.invalid/shorts/abcDEF123_-',
    'https://127.0.0.1/video', 'https://user:pass@youtube.com/shorts/abcDEF123_-', 'https://youtube.com/redirect?url=evil'])
    assert.equal(parseStyleReferenceUrl(value), null);
});

test('owned search, URL and local video references attach to the plan and preserve approval invalidation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'haejumi-style-reference-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new JsonState(join(dir, 'state.json'));
  const repo = new LocalRepositories({ state, dataDir: dir, maxMediaBytes: 50 * 1024 * 1024 });
  const owner = 'synthetic-owner'; const other = 'other-owner';
  const imageId = randomUUID(); const videoId = randomUUID();
  state.data.media[imageId] = { mediaId: imageId, ownerId: owner, mediaType: 'image/jpeg', status: 'available', sha256: 'a'.repeat(64) };
  const bytes = Buffer.from('synthetic video test fixture');
  writeFileSync(join(repo.blobDir, `${videoId}.blob`), bytes);
  state.data.media[videoId] = { mediaId: videoId, ownerId: owner, mediaType: 'video/mp4', status: 'available',
    storageKey: `${videoId}.blob`, sha256: sha256(bytes) };
  const project = repo.createForOwner(owner, { media_ids: [imageId], target_seconds: 6 }, randomUUID());
  const item = { video_id: 'abcDEF123_-', url: 'https://www.youtube.com/watch?v=abcDEF123_-', title: '합성 여행 쇼츠',
    description: '합성 여행 설명', published_at: new Date().toISOString(), view_count: 100, duration_seconds: 25 };
  let externalCalls = 0;
  const trends = { getCached: () => ({ items: [item] }), getCachedVideo: () => item,
    lookup: async () => { externalCalls++; throw new Error('unexpected external call'); } };
  const searched = await repo.addStyleReference(owner, project.task_id,
    { kind: 'search', topic: 'travel', days: 30, video_id: item.video_id, note: '부드러운 분위기' }, randomUUID(), trends);
  const linked = await repo.addStyleReference(owner, project.task_id,
    { kind: 'url', url: 'https://www.youtube.com/shorts/abcDEF123_-', note: '' }, randomUUID(), trends);
  const local = await repo.addStyleReference(owner, project.task_id,
    { kind: 'upload', media_id: videoId, note: '빠른 전개' }, randomUUID(), trends,
    async () => ({ duration_seconds: 6, width: 1080, height: 1920, pace: 'fast', cut_detection: 'sampled_scene_threshold' }));
  assert.equal(externalCalls, 0);
  assert.equal(searched.analysis_scope, 'metadata_only');
  assert.equal(linked.analysis_scope, 'metadata_only');
  assert.equal(local.analysis_scope, 'local_video_sample');
  assert.equal(repo.listStyleReferences(other, project.task_id), null);
  await assert.rejects(repo.addStyleReference(other, project.task_id, { kind: 'url', url: item.url }, randomUUID(), trends), { code: 'RESOURCE_NOT_FOUND' });
  assert.throws(() => repo.deleteStyleReference(other, project.task_id, searched.reference_id), { code: 'RESOURCE_NOT_FOUND' });
  const plan = await repo.createCreatorPlan(owner, project.task_id,
    { content_version: project.current_version, request_text: '합성 여행 쇼츠', reference_ids: [searched.reference_id, local.reference_id] },
    randomUUID(), new CreatorAgent({ gateway: null }));
  assert.deepEqual(plan.plan.style_reference_ids, [searched.reference_id, local.reference_id]);
  assert.equal(plan.plan.style_references[1].analysis.pace, 'fast');
  assert.throws(() => repo.deleteStyleReference(owner, project.task_id, searched.reference_id), { code: 'INVALID_STATE_TRANSITION' });
  const rows = proposeReferenceEdit(plan.plan, plan.generation, null, [local]);
  assert.equal(rows[0].motion, 'zoom_in');
  assert.equal(rows[0].edit_style, 'food_pop');
  const current = state.data.tasks[project.task_id];
  const edited = repo.updateCreatorScenes(owner, project.task_id, { content_version: current.current_version,
    content_hash: current.content_hash, reference_ids: [], scenes: plan.plan.scenes.map((scene) => ({
      media_id: scene.media_id, duration_seconds: scene.end_seconds - scene.start_seconds,
      framing: rows[0].framing, motion: rows[0].motion, transition: rows[0].transition,
      subtitle_style: rows[0].subtitle_style, edit_style: rows[0].edit_style })) }, randomUUID());
  assert.ok(edited.content_version > plan.content_version);
  assert.equal(edited.plan.scenes[0].motion, 'zoom_in');
  assert.deepEqual(edited.plan.style_reference_ids, []);
  assert.ok(repo.getOwnedCheckpoints(owner, project.task_id).some((checkpoint) => checkpoint.status === 'invalidated'));
  assert.deepEqual(repo.deleteStyleReference(owner, project.task_id, searched.reference_id), { deleted: true });
});

test('style reference HTTP route enforces auth, rejects unsupported URLs, and never fetches provider media', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'haejumi-reference-http-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new JsonState(join(dir, 'state.json'));
  const repo = new LocalRepositories({ state, dataDir: dir, maxMediaBytes: 1024 * 1024 });
  const owner = 'synthetic-owner'; const mediaId = randomUUID();
  state.data.media[mediaId] = { mediaId, ownerId: owner, mediaType: 'image/jpeg', status: 'available', sha256: 'b'.repeat(64) };
  const project = repo.createForOwner(owner, { media_ids: [mediaId], target_seconds: 6 }, randomUUID());
  let providerCalls = 0;
  const trends = { enabled: false, getCachedVideo: () => null, lookup: async () => { providerCalls++; return null; } };
  const auth = { authenticate: async (header) => header === 'Bearer synthetic-token' ? { ownerId: owner } : null };
  const server = createServer(createApiHandler({ repositories: repo, auth, trends }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/v1/tasks/${project.task_id}/style-references`;
  const headers = { authorization: 'Bearer synthetic-token', 'content-type': 'application/json', 'idempotency-key': randomUUID() };
  assert.equal((await fetch(endpoint)).status, 401);
  const bad = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ kind: 'url', url: 'https://127.0.0.1/private' }) });
  assert.equal(bad.status, 422);
  const good = await fetch(endpoint, { method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ kind: 'url', url: 'https://www.instagram.com/reel/ABCD1234/', note: '차분하게' }) });
  assert.equal(good.status, 201, await good.clone().text());
  const item = await good.json();
  assert.equal(item.analysis_scope, 'none');
  assert.equal(providerCalls, 0);
  const listed = await fetch(endpoint, { headers: { authorization: 'Bearer synthetic-token' } }).then((response) => response.json());
  assert.equal(listed.items.length, 1);
  const removed = await fetch(`${endpoint}/${item.reference_id}`, { method: 'DELETE', headers: { ...headers, 'idempotency-key': randomUUID() } });
  assert.equal(removed.status, 200);
  assert.equal(repo.listStyleReferences(owner, project.task_id).items.length, 0);
});

const mediaTools = resolveMediaToolPaths();
const available = [mediaTools.ffmpegPath, mediaTools.ffprobePath].every((path) =>
  spawnSync(path, ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0);

test('local style probe reports only measurable properties of a synthetic video', { skip: !available }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'haejumi-style-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'synthetic.mp4');
  execFileSync(mediaTools.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=320x180:rate=10:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path], { windowsHide: true });
  const result = await analyzeLocalStyleVideo(path, mediaTools);
  assert.ok(result.duration_seconds >= 3.9 && result.duration_seconds <= 4.1);
  assert.deepEqual([result.width, result.height], [320, 180]);
  assert.ok(['sampled_scene_threshold', 'unavailable'].includes(result.cut_detection));
  assert.equal(Object.hasOwn(result, 'subtitle_font'), false);
  assert.equal(Object.hasOwn(result, 'music'), false);
});

test('a locally sampled fast reference changes the actual approved render settings and MP4 frames',
  { skip: !available, timeout: 120000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'haejumi-reference-render-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const mediaRoot = join(dir, 'media'); const outputRoot = join(dir, 'out');
    mkdirSync(mediaRoot); mkdirSync(outputRoot);
    execFileSync(mediaTools.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'testsrc2=size=640x360:rate=1', '-frames:v', '1', '-q:v', '3', '-update', '1', join(mediaRoot, 'synthetic.jpg')], { windowsHide: true });
    const id = randomUUID();
    const plan = { target_seconds: 3, scenes: [{ media_id: id, media_type: 'image/jpeg', start_seconds: 0, end_seconds: 3 }] };
    const basic = proposeBasicEdit(plan)[0];
    const styled = proposeReferenceEdit(plan, { source: 'local_rules' }, null,
      [{ analysis_scope: 'local_video_sample', analysis: { pace: 'fast' }, note: '' }])[0];
    assert.equal(styled.motion, 'zoom_in');
    const scene = (row) => ({ ...row, order: 1, start_seconds: 0, end_seconds: 3 });
    const renderer = createFFmpegRenderer({ mediaRoot, outputRoot, ...mediaTools });
    const mediaItems = [{ mediaId: id, mediaType: 'image/jpeg', fileName: 'synthetic.jpg', storageKey: 'synthetic.jpg' }];
    const baseOutput = await renderer.render({ mediaItems, scenes: [scene(basic)], targetSeconds: 3, projectId: randomUUID() });
    const styledOutput = await renderer.render({ mediaItems, scenes: [scene(styled)], targetSeconds: 3, projectId: randomUUID() });
    assert.equal(baseOutput.verified, true); assert.equal(styledOutput.verified, true);
    const frame = (path) => execFileSync(mediaTools.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', '1.5', '-i', path,
      '-frames:v', '1', '-vf', 'scale=90:160', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true });
    assert.notDeepEqual(frame(baseOutput.output_path), frame(styledOutput.output_path));
    assert.equal(styledOutput.verification.width, 1080); assert.equal(styledOutput.verification.height, 1920);
    assert.equal(styledOutput.verification.fps, 30);
  });
