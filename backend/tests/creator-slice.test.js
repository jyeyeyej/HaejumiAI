import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { JsonState } from '../src/adapters/filesystem/json-state.js';
import { LocalRepositories } from '../src/adapters/filesystem/repositories.js';
import { createApiHandler } from '../src/adapters/node-http/transport.js';
import { inspectMedia, sha256 as mediaSha256, validateMediaBytes } from '../src/security/media-validation.js';
import { safeStoragePath } from '../src/security/storage-paths.js';
import { PrivacyGate } from '../src/security/privacy-gate.js';
import { corruptPngCrc, makeJpegStructure, makeMp4Structure, makePng, makeWebpStructure } from './media-fixtures.js';
import { createRenderCoordinator } from '../src/application/render-coordinator.js';
import { createTestRenderer } from '../src/media-engine/test-renderer.js';

const tokenA = 'test-owner-a-token-with-enough-random-looking-bytes';
const tokenB = 'test-owner-b-token-with-enough-random-looking-bytes';
const png = makePng();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, rendererFactory = null) {
  const dataDir = mkdtempSync(join(tmpdir(), 'haejumi-test-'));
  const state = new JsonState(join(dataDir, 'state.json'));
  const repositories = new LocalRepositories({ state, dataDir, maxMediaBytes: 1024 * 1024 });
  const auth = { async authenticate(header) {
    const value = /^Bearer (.+)$/.exec(header || '')?.[1];
    if (value === tokenA) return { ownerId: 'owner-a' };
    if (value === tokenB) return { ownerId: 'owner-b' };
    return null;
  } };
  const renderer = rendererFactory ? rendererFactory(repositories) : createTestRenderer({ outputRoot: repositories.renderDir });
  const renderCoordinator = createRenderCoordinator({ repositories, renderer });
  const server = createServer(createApiHandler({ repositories, auth, maxMediaBytes: 1024 * 1024, renderCoordinator }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { base, repositories, renderCoordinator };
}

function headers(token = tokenA) { return { authorization: `Bearer ${token}` }; }

test('auth is required before private API routes', async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/content/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media_ids: [] }) });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'AUTHENTICATION_REQUIRED');
});

test('selected upload, completion, project creation and task status form the first Creator slice', async (t) => {
  const { base } = await fixture(t);
  const init = await fetch(`${base}/media/uploads`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'upload-init-key-0001' }, body: JSON.stringify({ items: [{
    client_item_id: '11111111-1111-4111-8111-111111111111', file_name: 'selected.png', declared_media_type: 'image/png', size_bytes: png.length, sha256: digest(png),
  }] }) });
  assert.equal(init.status, 201);
  const upload = await init.json();
  const initReplay = await fetch(`${base}/media/uploads`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'upload-init-key-0001' }, body: JSON.stringify({ items: [{
    client_item_id: '11111111-1111-4111-8111-111111111111', file_name: 'selected.png', declared_media_type: 'image/png', size_bytes: png.length, sha256: digest(png),
  }] }) });
  assert.equal((await initReplay.json()).upload_id, upload.upload_id);
  const part = await fetch(`${base}/media/uploads/${upload.upload_id}/parts/1`, { method: 'PUT', headers: { ...headers(), 'content-type': 'application/octet-stream', 'idempotency-key': 'upload-part-key-0001' }, body: png });
  assert.equal(part.status, 204);

  const manifestHash = digest(Buffer.from(JSON.stringify([{ client_item_id: '11111111-1111-4111-8111-111111111111', sha256: digest(png), size_bytes: png.length }])));
  const complete = await fetch(`${base}/media/uploads/${upload.upload_id}/complete`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'upload-complete-key-001' }, body: JSON.stringify({ manifest_sha256: manifestHash }) });
  assert.equal(complete.status, 200);
  const imported = await complete.json();
  assert.equal(imported.media[0].media_type_verified, true);
  assert.equal(imported.media[0].sha256, digest(png));
  assert.equal(JSON.stringify(imported).includes('blobPath'), false);
  const completeReplay = await fetch(`${base}/media/uploads/${upload.upload_id}/complete`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'upload-complete-key-001' }, body: JSON.stringify({ manifest_sha256: manifestHash }) });
  assert.equal((await completeReplay.json()).import_id, imported.import_id);
  const completeNewKey = await fetch(`${base}/media/uploads/${upload.upload_id}/complete`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'upload-complete-key-002' }, body: JSON.stringify({ manifest_sha256: manifestHash }) });
  assert.equal((await completeNewKey.json()).media[0].media_id, imported.media[0].media_id);

  const projectResponse = await fetch(`${base}/content/projects`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'project-once-key-0001' }, body: JSON.stringify({ media_ids: [imported.media[0].media_id] }) });
  assert.equal(projectResponse.status, 201);
  const project = await projectResponse.json();
  assert.equal(project.status, 'created');
  assert.ok(project.task_id);
  const replay = await fetch(`${base}/content/projects`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'project-once-key-0001' }, body: JSON.stringify({ media_ids: [imported.media[0].media_id] }) });
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).project_id, project.project_id);
  const semanticReplay = await fetch(`${base}/content/projects`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'project-semantic-key-0001' }, body: JSON.stringify({ media_ids: [imported.media[0].media_id] }) });
  assert.equal((await semanticReplay.json()).project_id, project.project_id);
  const conflict = await fetch(`${base}/content/projects`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'project-once-key-0001' }, body: JSON.stringify({ media_ids: [imported.media[0].media_id], target_seconds: 20 }) });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');
  const taskResponse = await fetch(`${base}/tasks/${project.task_id}`, { headers: headers() });
  assert.equal(taskResponse.status, 200);
  const task = await taskResponse.json();
  assert.equal(task.project_id, project.project_id);
  assert.equal(task.status, 'waiting_plan_approval');
  assert.equal(task.next_action, 'review_plan');
  const projectRead = await fetch(`${base}/content/projects/${project.project_id}`, { headers: headers() });
  assert.equal(projectRead.status, 200);

  const renderBody = { content_version: project.current_version, content_hash: project.content_hash };
  const earlyRender = await fetch(`${base}/tasks/${project.task_id}/render`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'render-early-attempt-0001' }, body: JSON.stringify(renderBody) });
  assert.equal(earlyRender.status, 409);
  const planList = await fetch(`${base}/tasks/${project.task_id}/checkpoints`, { headers: headers() });
  const planCheckpoint = (await planList.json()).items.find((item) => item.kind === 'plan');
  const approve = async (checkpoint, key) => fetch(`${base}/tasks/${project.task_id}/approvals`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({
    checkpoint_id: checkpoint.checkpoint_id, content_version: checkpoint.content_version, content_hash: checkpoint.content_hash, approval_scope: 'continue',
  }) });
  assert.equal((await approve(planCheckpoint, 'plan-approval-key-0001')).status, 201);
  const planOnlyRender = await fetch(`${base}/tasks/${project.task_id}/render`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'render-after-plan-only-001' }, body: JSON.stringify(renderBody) });
  assert.equal(planOnlyRender.status, 409);
  const draftList = await fetch(`${base}/tasks/${project.task_id}/checkpoints`, { headers: headers() });
  const draftCheckpoint = (await draftList.json()).items.find((item) => item.kind === 'draft');
  const wrongScope = await fetch(`${base}/tasks/${project.task_id}/approvals`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'draft-wrong-scope-0001' }, body: JSON.stringify({
    checkpoint_id: draftCheckpoint.checkpoint_id, content_version: draftCheckpoint.content_version, content_hash: draftCheckpoint.content_hash, approval_scope: 'final_publish',
  }) });
  assert.equal(wrongScope.status, 409);
  assert.equal((await approve(draftCheckpoint, 'draft-approval-key-0001')).status, 201);
  const ready = await fetch(`${base}/tasks/${project.task_id}`, { headers: headers() });
  assert.equal((await ready.json()).status, 'render_ready');

  const arbitraryPath = await fetch(`${base}/tasks/${project.task_id}/render`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'render-path-injection-001' }, body: JSON.stringify({ ...renderBody, output_path: '..\\private.mp4' }) });
  assert.equal(arbitraryPath.status, 422);

  const render = await fetch(`${base}/tasks/${project.task_id}/render`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'render-request-key-0001' }, body: JSON.stringify(renderBody) });
  assert.equal(render.status, 202);
  const queued = await render.json();
  assert.equal(queued.status, 'queued');
  const renderReplay = await fetch(`${base}/tasks/${project.task_id}/render`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'render-request-key-0001' }, body: JSON.stringify(renderBody) });
  assert.equal((await renderReplay.json()).job_id, queued.job_id);
  const job = await waitForJob(base, queued.job_id);
  assert.equal(job.status, 'simulated');
  assert.equal(job.renderer_mode, 'test');
  assert.equal(job.artifact_verified, false);
  assert.equal(job.safe_error_code, undefined);
  const preview = await fetch(`${base}/tasks/${project.task_id}/preview?content_version=1`, { headers: headers() });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'application/x-haejumi-test-preview');
  assert.equal(preview.headers.get('x-haejumi-render-mode'), 'test');
  assert.match(await preview.text(), /NOT A VIDEO FILE/);
  assert.equal((await fetch(`${base}/jobs/${queued.job_id}`, { headers: headers(tokenB) })).status, 404);
  assert.equal((await fetch(`${base}/tasks/${project.task_id}/preview?content_version=1`, { headers: headers(tokenB) })).status, 404);
  const semanticRenderReplay = await fetch(`${base}/tasks/${project.task_id}/render`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'render-new-key-replay-0001' }, body: JSON.stringify(renderBody) });
  assert.equal((await semanticRenderReplay.json()).job_id, queued.job_id);

  const minimumLength = await fetch(`${base}/content/projects`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'project-min-duration-0001' }, body: JSON.stringify({ media_ids: [imported.media[0].media_id], target_seconds: 3 }) });
  assert.equal(minimumLength.status, 201);
  const maximumLength = await fetch(`${base}/content/projects`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'project-max-duration-0001' }, body: JSON.stringify({ media_ids: [imported.media[0].media_id], target_seconds: 59 }) });
  assert.equal(maximumLength.status, 201);
  const sixtySeconds = await fetch(`${base}/content/projects`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'project-60-duration-0001' }, body: JSON.stringify({ media_ids: [imported.media[0].media_id], target_seconds: 60 }) });
  assert.equal(sixtySeconds.status, 422);
});

async function waitForJob(base, jobId, token = tokenA) {
  for (let count = 0; count < 100; count += 1) {
    const response = await fetch(`${base}/jobs/${jobId}`, { headers: headers(token) });
    const job = await response.json();
    if (['succeeded', 'simulated', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Render job did not reach a terminal state.');
}

async function prepareApprovedProject(base, suffix) {
  const clientItemId = `33333333-3333-4333-8333-${String(suffix).padStart(12, '0')}`;
  const request = async (path, options = {}) => fetch(`${base}${path}`, options);
  const init = await request('/media/uploads', { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': `upload-init-render-${suffix}` }, body: JSON.stringify({ items: [{
    client_item_id: clientItemId, file_name: `selected-${suffix}.png`, declared_media_type: 'image/png', size_bytes: png.length, sha256: digest(png),
  }] }) });
  const upload = await init.json();
  await request(`/media/uploads/${upload.upload_id}/parts/1`, { method: 'PUT', headers: { ...headers(), 'content-type': 'application/octet-stream', 'idempotency-key': `upload-part-render-${suffix}` }, body: png });
  const manifest = digest(Buffer.from(JSON.stringify([{ client_item_id: clientItemId, sha256: digest(png), size_bytes: png.length }])));
  const complete = await request(`/media/uploads/${upload.upload_id}/complete`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': `upload-done-render-${suffix}` }, body: JSON.stringify({ manifest_sha256: manifest }) });
  const mediaId = (await complete.json()).media[0].media_id;
  const projectResponse = await request('/content/projects', { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': `project-render-${suffix}` }, body: JSON.stringify({ media_ids: [mediaId] }) });
  const project = await projectResponse.json();
  for (const [kind, key] of [['plan', `approve-plan-render-${suffix}`], ['draft', `approve-draft-render-${suffix}`]]) {
    const list = await request(`/tasks/${project.task_id}/checkpoints`, { headers: headers() });
    const checkpoint = (await list.json()).items.find((item) => item.kind === kind);
    const response = await request(`/tasks/${project.task_id}/approvals`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({
      checkpoint_id: checkpoint.checkpoint_id, content_version: checkpoint.content_version, content_hash: checkpoint.content_hash, approval_scope: 'continue',
    }) });
    assert.equal(response.status, 201);
  }
  return project;
}

test('platform publication metadata is owner-scoped, independent, idempotent and edits invalidate only its approval', async (t) => {
  const { base, repositories } = await fixture(t);
  const project = await prepareApprovedProject(base, 1234);
  const body = (platform) => ({ platform, account_id: `account-${platform}`, visibility: 'private', title: `${platform} title`, description: 'description', hashtags: ['해주미', 'video'] });
  const create = (platform, key) => fetch(`${base}/tasks/${project.task_id}/publications`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body(platform)) });
  const ytResponse = await create('youtube', 'publication-youtube-key-01');
  assert.equal(ytResponse.status, 201);
  const yt = await ytResponse.json();
  const ttResponse = await create('tiktok', 'publication-tiktok-key-01');
  assert.equal(ttResponse.status, 201);
  const tt = await ttResponse.json();
  assert.notEqual(yt.publication_id, tt.publication_id);
  const list = await fetch(`${base}/tasks/${project.task_id}/publications`, { headers: headers() });
  assert.deepEqual((await list.json()).items.map((item) => item.platform).sort(), ['tiktok', 'youtube']);
  assert.equal((await fetch(`${base}/tasks/${project.task_id}/publications/${yt.publication_id}`, { headers: headers(tokenB) })).status, 404);
  const foreignUpdate = await fetch(`${base}/tasks/${project.task_id}/publications/${yt.publication_id}`, { method: 'PATCH', headers: { ...headers(tokenB), 'content-type': 'application/json', 'idempotency-key': 'foreign-publication-update-01' }, body: JSON.stringify({ ...body('youtube'), revision: yt.revision }) });
  assert.equal(foreignUpdate.status, 404);

  // A test renderer's artifact is deliberately insufficient for final approval.
  const blockedApproval = await fetch(`${base}/tasks/${project.task_id}/publications/${yt.publication_id}/approvals`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'publication-approval-key-01' }, body: JSON.stringify({
    content_version: project.current_version, content_hash: project.content_hash, artifact_sha256: 'a'.repeat(64), publication_revision: yt.revision, publication_hash: yt.metadata_hash,
  }) });
  assert.equal(blockedApproval.status, 409);
  assert.equal((await blockedApproval.json()).error.code, 'RENDER_REQUIRED');
  assert.equal((await fetch(`${base}/tasks/${project.task_id}/publications/${yt.publication_id}`, { headers: headers() }).then((r) => r.json())).status, 'draft');

  const seededYt = { approval_id: 'seeded-yt-approval', task_id: project.task_id, publication_id: yt.publication_id, platform: 'youtube', approval_scope: 'final_publish', status: 'active' };
  const seededTt = { approval_id: 'seeded-tt-approval', task_id: project.task_id, publication_id: tt.publication_id, platform: 'tiktok', approval_scope: 'final_publish', status: 'active' };
  repositories.state.data.approvals[seededYt.approval_id] = seededYt;
  repositories.state.data.approvals[seededTt.approval_id] = seededTt;
  repositories.state.data.publications[yt.publication_id].approval_id = seededYt.approval_id;
  repositories.state.data.publications[yt.publication_id].status = 'publish_ready';
  repositories.state.save();
  const updatedResponse = await fetch(`${base}/tasks/${project.task_id}/publications/${yt.publication_id}`, { method: 'PATCH', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'publication-update-key-0001' }, body: JSON.stringify({ ...body('youtube'), title: 'Edited title', revision: yt.revision }) });
  assert.equal(updatedResponse.status, 200);
  const updated = await updatedResponse.json();
  assert.equal(updated.revision, yt.revision + 1);
  assert.equal(updated.status, 'draft');
  assert.equal(repositories.state.data.approvals[seededYt.approval_id].status, 'invalidated');
  assert.equal(repositories.state.data.approvals[seededTt.approval_id].status, 'active');
  const duplicate = await create('youtube', 'publication-youtube-key-02');
  assert.equal(duplicate.status, 409);
});

test('render failures become safe failed jobs and do not expose previews', async (t) => {
  const { base } = await fixture(t, () => ({ async render() { const error = new Error('private tool details'); error.code = 'FFPROBE_UNAVAILABLE'; throw error; } }));
  const project = await prepareApprovedProject(base, 41);
  const response = await fetch(`${base}/tasks/${project.task_id}/render`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'render-failure-request-0001' }, body: JSON.stringify({ content_version: 1, content_hash: project.content_hash }) });
  const queued = await response.json();
  const failed = await waitForJob(base, queued.job_id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.safe_error_code, 'FFPROBE_UNAVAILABLE');
  assert.equal(failed.preview_ready, false);
  assert.equal((await fetch(`${base}/tasks/${project.task_id}/preview?content_version=1`, { headers: headers() })).status, 404);
});

test('render refuses project media changed after upload verification', async (t) => {
  let calls = 0;
  const { base, repositories } = await fixture(t, (repo) => {
    const renderer = createTestRenderer({ outputRoot: repo.renderDir });
    return { async render(args) { calls += 1; return renderer.render(args); } };
  });
  const project = await prepareApprovedProject(base, 43);
  const media = repositories.getOwnedMedia('owner-a', project.media_ids[0]);
  writeFileSync(join(repositories.blobDir, media.storageKey), Buffer.from('changed after upload'));
  const response = await fetch(`${base}/tasks/${project.task_id}/render`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'render-tampered-media-001' }, body: JSON.stringify({ content_version: 1, content_hash: project.content_hash }) });
  const queued = await response.json();
  const failed = await waitForJob(base, queued.job_id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.safe_error_code, 'VERSION_CONFLICT');
  assert.equal(calls, 0);
});

test('running render cancellation is owner-scoped and remains cancelled', async (t) => {
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const { base } = await fixture(t, () => ({ render({ signal }) {
    started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { const error = new Error('cancelled'); error.code = 'JOB_CANCELLED'; reject(error); }, { once: true }));
  } }));
  const project = await prepareApprovedProject(base, 42);
  const response = await fetch(`${base}/tasks/${project.task_id}/render`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'render-cancel-request-0001' }, body: JSON.stringify({ content_version: 1, content_hash: project.content_hash }) });
  const queued = await response.json();
  await startedPromise;
  const running = await waitForJobStatus(base, queued.job_id, 'running');
  assert.equal(running.status, 'running');
  const foreignCancel = await fetch(`${base}/jobs/${queued.job_id}/cancel`, { method: 'POST', headers: headers(tokenB) });
  assert.equal(foreignCancel.status, 422); // Idempotency-Key is required before resource resolution.
  const cancel = await fetch(`${base}/jobs/${queued.job_id}/cancel`, { method: 'POST', headers: { ...headers(), 'idempotency-key': 'cancel-render-request-0001' } });
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json()).status, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal((await (await fetch(`${base}/jobs/${queued.job_id}`, { headers: headers() })).json()).status, 'cancelled');
  assert.equal((await fetch(`${base}/jobs/${queued.job_id}/cancel`, { method: 'POST', headers: { ...headers(tokenB), 'idempotency-key': 'foreign-cancel-render-0001' } })).status, 404);
});

async function waitForJobStatus(base, jobId, expected) {
  for (let count = 0; count < 100; count += 1) {
    const response = await fetch(`${base}/jobs/${jobId}`, { headers: headers() });
    const job = await response.json();
    if (job.status === expected) return job;
    if (['failed', 'cancelled', 'succeeded', 'simulated'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Render job did not reach ${expected}.`);
}

test('a different owner cannot read or attach another owner’s media/task', async (t) => {
  const { base } = await fixture(t);
  const init = await fetch(`${base}/media/uploads`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'upload-init-key-0002' }, body: JSON.stringify({ items: [{
    client_item_id: '11111111-1111-4111-8111-111111111111', file_name: 'selected.png', declared_media_type: 'image/png', size_bytes: png.length, sha256: digest(png),
  }] }) });
  const upload = await init.json();
  await fetch(`${base}/media/uploads/${upload.upload_id}/parts/1`, { method: 'PUT', headers: { ...headers(), 'content-type': 'application/octet-stream', 'idempotency-key': 'upload-part-key-0002' }, body: png });
  const manifestHash = digest(Buffer.from(JSON.stringify([{ client_item_id: '11111111-1111-4111-8111-111111111111', sha256: digest(png), size_bytes: png.length }])));
  const complete = await fetch(`${base}/media/uploads/${upload.upload_id}/complete`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'upload-complete-key-002' }, body: JSON.stringify({ manifest_sha256: manifestHash }) });
  const mediaId = (await complete.json()).media[0].media_id;
  const foreignProject = await fetch(`${base}/content/projects`, { method: 'POST', headers: { ...headers(tokenB), 'content-type': 'application/json', 'idempotency-key': 'foreign-project-key-001' }, body: JSON.stringify({ media_ids: [mediaId] }) });
  assert.equal(foreignProject.status, 404);
  const ownProjectResponse = await fetch(`${base}/content/projects`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'own-project-key-0001' }, body: JSON.stringify({ media_ids: [mediaId] }) });
  const ownProject = await ownProjectResponse.json();
  const foreignTask = await fetch(`${base}/tasks/${ownProject.task_id}`, { headers: headers(tokenB) });
  assert.equal(foreignTask.status, 404);
  const foreignProjectRead = await fetch(`${base}/content/projects/${ownProject.project_id}`, { headers: headers(tokenB) });
  assert.equal(foreignProjectRead.status, 404);
});

test('declared MIME, bytes, size and digest are checked before import', async (t) => {
  const { base } = await fixture(t);
  const init = await fetch(`${base}/media/uploads`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'upload-init-key-0003' }, body: JSON.stringify({ items: [{
    client_item_id: '11111111-1111-4111-8111-111111111111', file_name: '..\\private.png', declared_media_type: 'image/png', size_bytes: png.length, sha256: digest(png),
  }] }) });
  assert.equal(init.status, 422);

  const extensionMismatch = await fetch(`${base}/media/uploads`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'upload-ext-init-0001' }, body: JSON.stringify({ items: [{
    client_item_id: '22222222-2222-4222-8222-222222222222', file_name: 'selected.jpg', declared_media_type: 'image/png', size_bytes: png.length, sha256: digest(png),
  }] }) });
  assert.equal(extensionMismatch.status, 415);

  const tooLarge = await fetch(`${base}/media/uploads`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'upload-size-init-0001' }, body: JSON.stringify({ items: [{
    client_item_id: '22222222-2222-4222-8222-222222222223', file_name: 'large.png', declared_media_type: 'image/png', size_bytes: 1024 * 1024 + 1, sha256: '0'.repeat(64),
  }] }) });
  assert.equal(tooLarge.status, 413);

  const validInit = await fetch(`${base}/media/uploads`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'upload-init-key-0004' }, body: JSON.stringify({ items: [{
    client_item_id: '11111111-1111-4111-8111-111111111111', file_name: 'selected.jpg', declared_media_type: 'image/jpeg', size_bytes: png.length, sha256: digest(png),
  }] }) });
  const upload = await validInit.json();
  await fetch(`${base}/media/uploads/${upload.upload_id}/parts/1`, { method: 'PUT', headers: { ...headers(), 'content-type': 'application/octet-stream', 'idempotency-key': 'upload-part-key-0003' }, body: png });
  const completion = await fetch(`${base}/media/uploads/${upload.upload_id}/complete`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'upload-complete-key-003' }, body: JSON.stringify({ manifest_sha256: '0'.repeat(64) }) });
  assert.equal(completion.status, 415);
  assert.equal((await completion.json()).error.code, 'UNSUPPORTED_MEDIA_TYPE');

  const hashInit = await fetch(`${base}/media/uploads`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'upload-hash-init-0001' }, body: JSON.stringify({ items: [{
    client_item_id: '22222222-2222-4222-8222-222222222222', file_name: 'other.png', declared_media_type: 'image/png', size_bytes: png.length, sha256: '0'.repeat(64),
  }] }) });
  const hashUpload = await hashInit.json();
  await fetch(`${base}/media/uploads/${hashUpload.upload_id}/parts/1`, { method: 'PUT', headers: { ...headers(), 'content-type': 'application/octet-stream', 'idempotency-key': 'upload-hash-part-0001' }, body: png });
  const hashCompletion = await fetch(`${base}/media/uploads/${hashUpload.upload_id}/complete`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'upload-hash-done-0001' }, body: JSON.stringify({ manifest_sha256: '0'.repeat(64) }) });
  assert.equal(hashCompletion.status, 409);
  assert.equal((await hashCompletion.json()).error.code, 'VERSION_CONFLICT');
});

test('write endpoints require idempotency keys', async (t) => {
  const { base } = await fixture(t);
  const missing = await fetch(`${base}/content/projects`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ media_ids: ['00000000-0000-4000-8000-000000000001'] }) });
  assert.equal(missing.status, 422);
  assert.equal((await missing.json()).error.code, 'VALIDATION_ERROR');
});

test('current upload contract rejects multi-item sessions, wrong part content type and part 2', async (t) => {
  const { base } = await fixture(t);
  const item = { client_item_id: '33333333-3333-4333-8333-333333333333', file_name: 'selected.png', declared_media_type: 'image/png', size_bytes: png.length, sha256: digest(png) };
  const multi = await fetch(`${base}/media/uploads`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'multi-upload-init-0001' }, body: JSON.stringify({ items: [item, { ...item, client_item_id: '44444444-4444-4444-8444-444444444444' }] }) });
  assert.equal(multi.status, 422);

  const init = await fetch(`${base}/media/uploads`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'single-upload-init-0001' }, body: JSON.stringify({ items: [item] }) });
  const upload = await init.json();
  const wrongContentType = await fetch(`${base}/media/uploads/${upload.upload_id}/parts/1`, { method: 'PUT', headers: { ...headers(), 'content-type': 'image/png', 'idempotency-key': 'single-upload-part-0001' }, body: png });
  assert.equal(wrongContentType.status, 415);
  const secondPart = await fetch(`${base}/media/uploads/${upload.upload_id}/parts/2`, { method: 'PUT', headers: { ...headers(), 'content-type': 'application/octet-stream', 'idempotency-key': 'single-upload-part-0002' }, body: png });
  assert.equal(secondPart.status, 409);
});

test('same owner and manifest reuse the completed media import and proposal', async (t) => {
  const { base } = await fixture(t);
  const clientItemId = '11111111-1111-4111-8111-111111111111';
  const createSession = async (suffix) => {
    const init = await fetch(`${base}/media/uploads`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': `manifest-init-key-${suffix}` }, body: JSON.stringify({ items: [{
      client_item_id: clientItemId, file_name: 'selected.png', declared_media_type: 'image/png', size_bytes: png.length, sha256: digest(png),
    }] }) });
    const upload = await init.json();
    await fetch(`${base}/media/uploads/${upload.upload_id}/parts/1`, { method: 'PUT', headers: { ...headers(), 'content-type': 'application/octet-stream', 'idempotency-key': `manifest-part-key-${suffix}` }, body: png });
    const manifestHash = digest(Buffer.from(JSON.stringify([{ client_item_id: clientItemId, sha256: digest(png), size_bytes: png.length }])));
    const complete = await fetch(`${base}/media/uploads/${upload.upload_id}/complete`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': `manifest-done-key-${suffix}` }, body: JSON.stringify({ manifest_sha256: manifestHash }) });
    assert.equal(complete.status, 200);
    return complete.json();
  };
  const first = await createSession('0001');
  const second = await createSession('0002');
  assert.equal(second.media[0].media_id, first.media[0].media_id);
  assert.equal(second.proposal.proposal_id, first.proposal.proposal_id);
  assert.equal(second.proposal.status, 'already_created');
});

test('container structure, corruption and extension checks cover supported media types', async () => {
  const fixtures = [
    [makePng(), 'image/png', 'photo.png'],
    [makeJpegStructure(), 'image/jpeg', 'photo.jpg'],
    [makeWebpStructure(), 'image/webp', 'photo.webp'],
    [makeMp4Structure(), 'video/mp4', 'clip.mp4'],
    [makeMp4Structure('qt  '), 'video/quicktime', 'clip.mov'],
  ];
  for (const [bytes, mime, filename] of fixtures) {
    const result = validateMediaBytes(bytes, mime, bytes.length, mediaSha256(bytes), 1024 * 1024, filename);
    assert.equal(result.ok, true, `${mime} structural fixture should validate`);
  }
  assert.equal(inspectMedia(corruptPngCrc(makePng()), 'image/png').code, 'VALIDATION_ERROR');
  assert.equal(inspectMedia(makeJpegStructure().subarray(0, -2), 'image/jpeg').code, 'VALIDATION_ERROR');
  const malformedMp4 = makeMp4Structure(); malformedMp4.writeUInt32BE(0xffffffff, 0);
  assert.equal(inspectMedia(malformedMp4, 'video/mp4').code, 'VALIDATION_ERROR');
  assert.equal(validateMediaBytes(makePng(), 'image/jpeg', makePng().length, mediaSha256(makePng()), 1024, 'photo.jpg').code, 'UNSUPPORTED_MEDIA_TYPE');
});

test('storage path resolver blocks path traversal', () => {
  const root = 'C:/private/haejumi-data';
  assert.throws(() => safeStoragePath(root, '..', 'outside.bin'));
});

test('PrivacyGate denies external processing before dispatch (zero calls)', async () => {
  const gate = new PrivacyGate();
  let calls = 0;
  await assert.rejects(() => gate.dispatchExternal({ ownerId: 'owner-a' }, async () => { calls += 1; }), { code: 'CONSENT_REQUIRED' });
  assert.equal(calls, 0);
});
