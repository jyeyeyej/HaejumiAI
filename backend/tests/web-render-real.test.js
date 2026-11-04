import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonState } from '../src/adapters/filesystem/json-state.js';
import { LocalRepositories } from '../src/adapters/filesystem/repositories.js';
import { createApiHandler } from '../src/adapters/node-http/transport.js';
import { createRenderCoordinator } from '../src/application/render-coordinator.js';
import { createFFmpegRenderer } from '../src/media-engine/ffmpeg-renderer.js';
import { resolveMediaToolPaths } from '../src/media-engine/media-tool-paths.js';
import { CreatorAgent } from '../src/agents/creator-agent.js';
import { LLMGateway } from '../src/application/llm-gateway.js';
import { HaejumiApi } from '../../web/src/api.js';

const toolsReady = (() => { try { const paths = resolveMediaToolPaths();
  return [paths.ffmpegPath, paths.ffprobePath].every((path) => spawnSync(path, ['-version'], { stdio: 'ignore' }).status === 0);
} catch { return false; } })();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('16 synthetic JPEGs with EXIF orientation and Korean names render after a safe retry and yield an authenticated MP4',
  { skip: !toolsReady, timeout: 120000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'haejumi-web-render-'));
    const state = new JsonState(join(dir, 'state.json'));
    const repositories = new LocalRepositories({ state, dataDir: dir, maxMediaBytes: 50 * 1024 * 1024, maxSelectedMedia: 20 });
    const paths = resolveMediaToolPaths();
    const realRenderer = createFFmpegRenderer({ mediaRoot: repositories.blobDir, outputRoot: repositories.renderDir, ...paths });
    let attempts = 0;
    const renderer = { async render(input) { if (++attempts === 1) {
      const error = new Error('synthetic missing executable'); error.code = 'FFMPEG_UNAVAILABLE'; error.failureStage = 'ffmpeg_start'; throw error;
    } return realRenderer.render(input); } };
    const coordinator = createRenderCoordinator({ repositories, renderer });
    const auth = { async authenticate(header) { return header === 'Bearer synthetic-token' ? { ownerId: 'synthetic-owner' } : null; } };
    const server = createServer(createApiHandler({ repositories, auth, maxMediaBytes: 50 * 1024 * 1024,
      renderCoordinator: coordinator, creatorAgent: new CreatorAgent({ gateway: new LLMGateway() }) }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = new HaejumiApi('synthetic-token', (path, options) => fetch(base + path, options));
    const jpgPath = join(dir, 'synthetic.jpg');
    execFileSync(paths.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240',
      '-frames:v', '1', '-q:v', '4', '-update', '1', jpgPath], { windowsHide: true });
    const baseJpg = readFileSync(jpgPath);
    const grayPath = join(dir, 'synthetic-gray.jpg');
    execFileSync(paths.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x240',
      '-vf', 'format=gray', '-frames:v', '1', '-q:v', '4', '-update', '1', grayPath], { windowsHide: true });
    const color444Path = join(dir, 'synthetic-444.jpg');
    execFileSync(paths.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240',
      '-pix_fmt', 'yuvj444p', '-frames:v', '1', '-q:v', '4', '-update', '1', color444Path], { windowsHide: true });
    const variants = [baseJpg, readFileSync(grayPath), readFileSync(color444Path)];
    const exif = Buffer.from('45786966000049492a0008000000010012010300010000000600000000000000', 'hex');
    const app1 = Buffer.alloc(4); app1[0] = 0xff; app1[1] = 0xe1; app1.writeUInt16BE(exif.length + 2, 2);
    const rotated = Buffer.concat([baseJpg.subarray(0, 2), app1, exif, baseJpg.subarray(2)]);
    const selected = Array.from({ length: 16 }, (_, index) => ({ file: new File([index === 1 ? rotated : variants[index % variants.length]], `합성 사진 ${index + 1}.jpg`, { type: 'image/jpeg' }),
      keys: { itemId: randomUUID(), partKey: randomUUID() } }));
    const mediaIds = await api.uploadMany(selected, { keys: { initKey: randomUUID(), completeKey: randomUUID() } });
    assert.equal(mediaIds.length, 16);
    const project = await api.request('/api/v1/content/projects', { method: 'POST', key: randomUUID(), body: { media_ids: mediaIds, target_seconds: 3 } });
    const plan = await api.revisePlan(project.task_id, 1, '합성 사진 쇼츠', randomUUID());
    await api.approve(project.task_id, plan.checkpoint, randomUUID());
    const afterPlan = await api.task(project.task_id);
    const edited = await api.updateScenes(project.task_id, afterPlan, plan.plan.scenes.map((scene, index) => ({ media_id: scene.media_id,
      duration_seconds: Number((scene.end_seconds - scene.start_seconds).toFixed(2)),
      ...(index === 0 ? { framing: 'blur_pad', motion: 'zoom_in', transition: 'fade', subtitle_style: 'emphasis' } : {}) })), randomUUID());
    assert.equal(edited.content_version, plan.content_version + 1);
    assert.equal(edited.plan.scenes[0].framing, 'blur_pad');
    await api.approve(project.task_id, edited.checkpoint, randomUUID());
    const draft = await api.draft(project.task_id);
    await api.approve(project.task_id, draft.checkpoint, randomUUID());
    const current = await api.task(project.task_id);
    const first = await api.render(project.task_id, current, randomUUID());
    const waitJob = async (id) => { for (let i = 0; i < 400; i++) { const job = await api.request(`/api/v1/jobs/${id}`);
      if (['failed', 'succeeded'].includes(job.status)) return job; await pause(50); } throw new Error('Render timeout'); };
    const failed = await waitJob(first.job_id);
    assert.equal(failed.safe_error_code, 'FFMPEG_UNAVAILABLE'); assert.equal(failed.failure_stage, 'ffmpeg_start');
    const draftAfterFailure = await api.draft(project.task_id);
    assert.equal(draftAfterFailure.checkpoint.checkpoint_id, draft.checkpoint.checkpoint_id);
    assert.equal(draftAfterFailure.checkpoint.status, 'approved');
    const second = await api.render(project.task_id, await api.task(project.task_id), randomUUID());
    assert.notEqual(second.job_id, first.job_id);
    assert.equal((await api.request(`/api/v1/jobs/${first.job_id}`)).status, 'failed');
    const job = await waitJob(second.job_id);
    assert.equal(job.status, 'succeeded', job.safe_error_code);
    assert.equal(job.artifact_verified, true);
    const previewPath = `/api/v1/tasks/${project.task_id}/preview?content_version=${job.content_version}`;
    assert.equal((await fetch(base + previewPath)).status, 401);
    const preview = await api.request(previewPath, { binary: true });
    assert.equal(preview.status, 200); assert.equal(preview.headers.get('content-type'), 'video/mp4');
    const bytes = Buffer.from(await preview.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), job.artifact_sha256);
    const artifact = join(repositories.renderDir, state.data.jobs[job.job_id].artifact_key);
    const probe = JSON.parse(execFileSync(paths.ffprobePath, ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,r_frame_rate',
      '-show_entries', 'format=duration', '-of', 'json', artifact], { encoding: 'utf8', windowsHide: true }));
    assert.ok(probe.streams.some((stream) => stream.codec_name === 'h264' && stream.width === 1080 && stream.height === 1920 && stream.r_frame_rate === '30/1'));
    assert.ok(probe.streams.some((stream) => stream.codec_name === 'aac'));
    assert.ok(Number(probe.format.duration) >= 3 && Number(probe.format.duration) <= 59);
  });
