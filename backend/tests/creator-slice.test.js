import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { JsonState } from '../src/adapters/filesystem/json-state.js';
import { LocalRepositories } from '../src/adapters/filesystem/repositories.js';
import { createApiHandler } from '../src/adapters/node-http/transport.js';
import { inspectMedia, sha256 as mediaSha256, validateMediaBytes } from '../src/security/media-validation.js';
import { safeStoragePath } from '../src/security/storage-paths.js';
import { PrivacyGate } from '../src/security/privacy-gate.js';
import { corruptPngCrc, makeJpegStructure, makeMp4Structure, makePng, makeWebpStructure } from './media-fixtures.js';
import { createRenderCoordinator } from '../src/application/render-coordinator.js';
import { createTestRenderer } from '../src/media-engine/test-renderer.js';
import { createFFmpegRenderer } from '../src/media-engine/ffmpeg-renderer.js';
import { createDefaultCapabilityRegistry } from '../src/agents/capability-registry.js';
import { SupervisorRouter } from '../src/agents/supervisor-router.js';
import { CreatorAgent } from '../src/agents/creator-agent.js';
import { LLMGateway } from '../src/application/llm-gateway.js';
import { createMockLLMProvider } from './mock-llm.js';

const tokenA = 'test-owner-a-token-with-enough-random-looking-bytes';
const tokenB = 'test-owner-b-token-with-enough-random-looking-bytes';
const png = makePng();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, rendererFactory = null) {
  const dataDir = mkdtempSync(join(tmpdir(), 'haejumi-test-'));
  const state = new JsonState(join(dataDir, 'state.json'));
  const repositories = new LocalRepositories({ state, dataDir, maxMediaBytes: 1024 * 1024,
    imagePreparer: async () => Buffer.from('prepared-test-jpeg'), videoFrameExtractor: async () => Buffer.from('prepared-test-frame') });
  const auth = { async authenticate(header) {
    const value = /^Bearer (.+)$/.exec(header || '')?.[1];
    if (value === tokenA) return { ownerId: 'owner-a' };
    if (value === tokenB) return { ownerId: 'owner-b' };
    return null;
  } };
  const renderer = rendererFactory ? rendererFactory(repositories) : createTestRenderer({ outputRoot: repositories.renderDir });
  const renderCoordinator = createRenderCoordinator({ repositories, renderer });
  const registry = createDefaultCapabilityRegistry();
  const router = new SupervisorRouter(registry);
  const mockLLM = createMockLLMProvider();
  const creatorAgent = new CreatorAgent({ gateway: new LLMGateway({ enabled: true, allowMockProvider: true, provider: mockLLM, privacyGate: new PrivacyGate(), limits: { dailyUsd: 1, monthlyUsd: 5, maxCallsPerTask: 5, maxRevisionsPerTask: 3 } }) });
  const server = createServer(createApiHandler({ repositories, auth, maxMediaBytes: 1024 * 1024, renderCoordinator, capabilityRegistry: registry, supervisorRouter: router, creatorAgent }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { base, repositories, renderCoordinator, registry, router, mockLLM };
}

function headers(token = tokenA) { return { authorization: `Bearer ${token}` }; }

test('mixed multi upload retains staged parts, validates ordered manifest, and creates one owner-scoped project', async (t) => {
  const { base, repositories } = await fixture(t);
  const types = [
    { name: 'one.png', type: 'image/png', bytes: makePng() },
    { name: 'two.mp4', type: 'video/mp4', bytes: makeMp4Structure() },
    { name: 'three.jpg', type: 'image/jpeg', bytes: makeJpegStructure() },
    { name: 'four.png', type: 'image/png', bytes: makePng() },
    { name: 'five.png', type: 'image/png', bytes: makePng() },
    { name: 'six.mp4', type: 'video/mp4', bytes: makeMp4Structure() },
    { name: 'seven.png', type: 'image/png', bytes: makePng() },
  ];
  const manifest = types.map(({ bytes }) => ({ client_item_id: randomUUID(), sha256: digest(bytes), size_bytes: bytes.length }));
  const items = types.map((item, index) => ({ client_item_id: manifest[index].client_item_id, file_name: item.name,
    declared_media_type: item.type, size_bytes: item.bytes.length, sha256: manifest[index].sha256 }));
  const json = { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'multi-init-key-0001' };
  const initiated = await fetch(`${base}/media/uploads`, { method: 'POST', headers: json, body: JSON.stringify({ items }) });
  assert.equal(initiated.status, 201, await initiated.clone().text());
  const upload = await initiated.json();
  assert.equal(upload.accepted_items.length, 7);
  const retry = await fetch(`${base}/media/uploads`, { method: 'POST', headers: json, body: JSON.stringify({ items }) });
  assert.equal((await retry.json()).upload_id, upload.upload_id);
  const put = (index, bytes = types[index - 1].bytes) => fetch(`${base}/media/uploads/${upload.upload_id}/parts/${index}`, {
    method: 'PUT', headers: { ...headers(), 'content-type': 'application/octet-stream', 'idempotency-key': `multi-part-key-000${index}` }, body: bytes });
  assert.equal((await put(1)).status, 204);
  const body = { manifest_sha256: digest(Buffer.from(JSON.stringify(manifest))), items: manifest };
  const complete = () => fetch(`${base}/media/uploads/${upload.upload_id}/complete`, { method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'multi-complete-001' }, body: JSON.stringify(body) });
  assert.equal((await complete()).status, 409);
  assert.equal((await put(1)).status, 204);
  assert.equal((await put(2, Buffer.alloc(types[1].bytes.length))).status, 409);
  for (let index = 2; index <= 7; index++) assert.equal((await put(index)).status, 204);
  const completed = await complete();
  assert.equal(completed.status, 200);
  const result = await completed.json();
  assert.equal(result.media.length, 7);
  assert.equal(result.manifest_sha256, body.manifest_sha256);
  assert.deepEqual((await (await complete()).json()).media.map((entry) => entry.media_id), result.media.map((entry) => entry.media_id));
  const projectResponse = await fetch(`${base}/content/projects`, { method: 'POST', headers: { ...json, 'idempotency-key': 'multi-project-001' },
    body: JSON.stringify({ media_ids: result.media.map((entry) => entry.media_id) }) });
  assert.equal(projectResponse.status, 201);
  const project = await projectResponse.json();
  assert.deepEqual(project.media_manifest.map((entry) => entry.sha256), manifest.map((entry) => entry.sha256));
  const generatedResponse = await fetch(`${base}/tasks/${project.task_id}/plan`, { method: 'POST', headers: { ...json, 'idempotency-key': 'multi-plan-generate-0001' },
    body: JSON.stringify({ content_version: 1, request_text: '선택한 다섯 장면으로 쇼츠를 만듭니다' }) });
  assert.equal(generatedResponse.status, 201);
  const generated = await generatedResponse.json();
  const approve = await fetch(`${base}/tasks/${project.task_id}/approvals`, { method: 'POST', headers: { ...json, 'idempotency-key': 'multi-plan-approve-0001' },
    body: JSON.stringify({ checkpoint_id: generated.checkpoint.checkpoint_id, content_version: generated.content_version,
      content_hash: generated.content_hash, approval_scope: 'continue' }) });
  assert.equal(approve.status, 201);
  const reversed = [...project.media_ids].reverse();
  const sceneEdit = await fetch(`${base}/tasks/${project.task_id}/plan`, { method: 'PUT', headers: { ...json, 'idempotency-key': 'multi-scene-edit-0001' },
    body: JSON.stringify({ content_version: generated.content_version, content_hash: generated.content_hash,
      scenes: reversed.map((media_id, index) => ({ media_id, duration_seconds: index === 0 ? 6 : 4,
        ...(index === 0 ? { framing: 'blur_pad', motion: 'zoom_in', transition: 'fade', subtitle_style: 'emphasis', bgm_mood: '따뜻함', edit_reason: '장면 강조' } : {}),
        ...(media_id === project.media_ids[1] ? { trim_start_seconds: 0.25, trim_end_seconds: (index === 0 ? 6 : 4) + 0.25 } : {}) })) }) });
  assert.equal(sceneEdit.status, 200, await sceneEdit.clone().text());
  const edited = await sceneEdit.json();
  assert.equal(edited.content_version, generated.content_version + 1);
  assert.deepEqual(edited.plan.scenes.map((scene) => scene.media_id), reversed);
  assert.equal(edited.plan.scenes[0].framing, 'blur_pad');
  assert.equal(edited.plan.scenes[0].motion, 'zoom_in');
  assert.deepEqual(repositories.state.data.projects[project.project_id].caption_draft, [], 'scene reorder must not invent subtitles for a local plan');
  assert.equal((await fetch(`${base}/tasks/${project.task_id}/approvals`, { method: 'POST', headers: { ...json, 'idempotency-key': 'multi-stale-approve-0001' },
    body: JSON.stringify({ checkpoint_id: generated.checkpoint.checkpoint_id, content_version: generated.content_version,
      content_hash: generated.content_hash, approval_scope: 'continue' }) })).status, 409);
  assert.equal((await fetch(`${base}/content/projects`, { method: 'POST', headers: { ...json, authorization: `Bearer ${tokenB}`, 'idempotency-key': 'multi-project-other-001' },
    body: JSON.stringify({ media_ids: result.media.map((entry) => entry.media_id) }) })).status, 404);
});

test('auth is required before private API routes', async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/content/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media_ids: [] }) });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'AUTHENTICATION_REQUIRED');
});

test('project list is authenticated, owner-scoped, and uses the shared server state', async (t) => {
  const { base, repositories } = await fixture(t);
  const first = await prepareUnapprovedProject(base, 9111);
  const second = await prepareUnapprovedProject(base, 9112);
  assert.equal((await fetch(`${base}/content/projects`)).status, 401);
  const own = await fetch(`${base}/content/projects`, { headers: headers() });
  assert.equal(own.status, 200);
  const { items } = await own.json();
  assert.deepEqual(items.map((item) => item.project_id), [second.project.project_id, first.project.project_id]);
  assert.equal(items[0].ownerId, undefined);
  const other = await fetch(`${base}/content/projects`, { headers: headers(tokenB) });
  assert.deepEqual((await other.json()).items, []);
  const jobId = randomUUID();
  repositories.state.data.jobs[jobId] = { job_id: jobId, task_id: first.project.task_id, owner_id: 'owner-a', status: 'succeeded', artifact_key: 'private-file.mp4' };
  repositories.state.save();
  const ownJobs = await fetch(`${base}/tasks/${first.project.task_id}/jobs`, { headers: headers() });
  const ownItems = (await ownJobs.json()).items;
  assert.equal(ownItems[0].job_id, jobId);
  assert.equal(ownItems[0].artifact_key, undefined);
  assert.equal(ownItems[0].owner_id, undefined);
  assert.equal((await fetch(`${base}/tasks/${first.project.task_id}/jobs`, { headers: headers(tokenB) })).status, 404);
});

test('privacy notice is disclosed, scoped consent is owner-bound, and revocation blocks verification', async (t) => {
  const { base, repositories } = await fixture(t);
  const { mediaId } = await prepareUnapprovedProject(base, 6111);
  const noticeResponse = await fetch(`${base}/privacy/processing-notice?provider_id=openai&purpose=vision_analysis`, { headers: headers() });
  assert.equal(noticeResponse.status, 200);
  const notice = await noticeResponse.json();
  assert.match(notice.disclosure, /OpenAI API로 전송/);
  assert.deepEqual(notice.data_categories, ['selected_media', 'user_text']);
  const consentInput = { provider_id: 'openai', purpose: 'vision_analysis', data_categories: notice.data_categories, resource_ids: [mediaId],
    notice_id: notice.notice_id, notice_version: notice.notice_version, explicitly_confirmed: true,
    expires_at: new Date(Date.now() + 60_000).toISOString() };
  const created = await fetch(`${base}/privacy/consents`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'privacy-consent-confirm-001' }, body: JSON.stringify(consentInput) });
  assert.equal(created.status, 201);
  const consent = await created.json();
  const context = { ownerId: 'owner-a', consentId: consent.consent_id, providerId: 'openai', purpose: 'vision_analysis', dataCategories: ['selected_media', 'user_text'], resourceIds: [mediaId] };
  assert.equal(repositories.verifyPrivacyConsent(context), true);
  const overbroad = await fetch(`${base}/privacy/consents`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'privacy-consent-overbroad-001' }, body: JSON.stringify({
    ...consentInput, data_categories: [...notice.data_categories, 'diary'],
  }) });
  assert.equal(overbroad.status, 422);
  const unsupportedPurpose = await fetch(`${base}/privacy/consents`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'privacy-consent-stt-001' }, body: JSON.stringify({
    ...consentInput, purpose: 'stt', data_categories: ['transcript'],
  }) });
  assert.equal(unsupportedPurpose.status, 422);
  assert.equal(repositories.verifyPrivacyConsent({ ...context, ownerId: 'owner-b' }), false);
  assert.equal(repositories.verifyPrivacyConsent({ ...context, resourceIds: ['99999999-9999-4999-8999-999999999999'] }), false);
  const revoke = await fetch(`${base}/privacy/consents/${consent.consent_id}`, { method: 'DELETE', headers: { ...headers(), 'idempotency-key': 'privacy-consent-revoke-001' } });
  assert.equal(revoke.status, 204);
  assert.equal(repositories.verifyPrivacyConsent(context), false);
  assert.equal((await fetch(`${base}/privacy/consents/${consent.consent_id}`, { method: 'DELETE', headers: { ...headers(tokenB), 'idempotency-key': 'privacy-consent-revoke-b-001' } })).status, 404);
});

test('Supervisor routes registered Agents and Creator plan/draft approvals advance with version invalidation', async (t) => {
  const { base, repositories, mockLLM } = await fixture(t);
  const capabilities = await fetch(`${base}/capabilities`, { headers: headers() }).then((r) => r.json());
  assert.deepEqual(capabilities.items.map((item) => item.module_id), ['creator', 'schedule', 'wellness', 'diary', 'blog', 'music']);
  assert.equal(capabilities.items.find((item) => item.module_id === 'creator').status, 'enabled');
  assert.equal(capabilities.items.find((item) => item.module_id === 'schedule').status, 'planned');
  assert.equal(capabilities.items.find((item) => item.module_id === 'blog').status, 'disabled');

  const { project, mediaId } = await prepareUnapprovedProject(base, 2121);
  const unselected = await fetch(`${base}/assistant/messages`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'assistant-unselected-media-key' }, body: JSON.stringify({
    text: '선택한 사진으로 쇼츠 기획', task_id: project.task_id, attachment_ids: ['99999999-9999-4999-8999-999999999999'],
  }) });
  assert.equal(unselected.status, 404);
  assert.equal(mockLLM.calls, 0);
  const unconfirmedTranscript = await fetch(`${base}/assistant/messages`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'assistant-transcript-check-01' }, body: JSON.stringify({
    text: '영상 쇼츠 기획', input_kind: 'confirmed_transcript', confirmed_transcript: false,
  }) });
  assert.equal(unconfirmedTranscript.status, 409);
  const notice = await fetch(`${base}/privacy/processing-notice?provider_id=openai&purpose=vision_analysis`, { headers: headers() }).then((r) => r.json());
  const consent = await fetch(`${base}/privacy/consents`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'creator-vision-consent-0001' }, body: JSON.stringify({
    provider_id: 'openai', purpose: 'vision_analysis', data_categories: notice.data_categories, resource_ids: [mediaId], notice_id: notice.notice_id,
    notice_version: notice.notice_version, explicitly_confirmed: true, expires_at: new Date(Date.now() + 60_000).toISOString(),
  }) }).then((r) => r.json());
  const planResponse = await fetch(`${base}/assistant/messages`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'assistant-creator-plan-key-1' }, body: JSON.stringify({
    text: '선택한 사진으로 여행 쇼츠 기획과 자막을 만들어줘', task_id: project.task_id, attachment_ids: [mediaId], privacy_consent_id: consent.consent_id,
  }) });
  assert.equal(planResponse.status, 202);
  const routed = await planResponse.json();
  assert.equal(routed.route, 'creator');
  assert.equal(routed.capability_id, 'creator.shorts_plan');
  assert.equal(routed.status, 'routed');
  assert.equal(routed.plan.scenes[0].caption_text, 'Mock 자막 1');
  assert.equal(routed.checkpoint.kind, 'plan');
  assert.equal(routed.content_version, 2);
  assert.equal(routed.generation.source, 'mock');
  assert.equal(routed.generation.fallback_used, false);
  const planRead = await fetch(`${base}/tasks/${project.task_id}/plan`, { headers: headers() });
  assert.equal(planRead.status, 200);
  assert.equal((await planRead.json()).content_hash, routed.content_hash);
  const idempotentReplay = await fetch(`${base}/assistant/messages`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'assistant-creator-plan-key-1' }, body: JSON.stringify({
    text: '선택한 사진으로 여행 쇼츠 기획과 자막을 만들어줘', task_id: project.task_id, attachment_ids: [mediaId], privacy_consent_id: consent.consent_id,
  }) });
  assert.equal((await idempotentReplay.json()).checkpoint.checkpoint_id, routed.checkpoint.checkpoint_id);
  assert.equal(mockLLM.calls, 1);
  assert.equal((await fetch(`${base}/tasks/${project.task_id}/draft`, { headers: headers() })).status, 409);

  const approve = async (checkpoint, key) => fetch(`${base}/tasks/${project.task_id}/approvals`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({
    checkpoint_id: checkpoint.checkpoint_id, content_version: checkpoint.content_version, content_hash: checkpoint.content_hash, approval_scope: 'continue',
  }) });
  const planApproval = await approve(routed.checkpoint, 'supervisor-plan-approval-01');
  assert.equal(planApproval.status, 201);
  const draft = await fetch(`${base}/tasks/${project.task_id}/draft`, { headers: headers() });
  assert.equal(draft.status, 200);
  const draftValue = await draft.json();
  assert.equal(draftValue.captions[0].text, 'Mock 자막 1');
  const draftApproval = await approve(draftValue.checkpoint, 'supervisor-draft-approval-01');
  assert.equal(draftApproval.status, 201, JSON.stringify(await draftApproval.json()));
  assert.equal((await fetch(`${base}/tasks/${project.task_id}`, { headers: headers() }).then((r) => r.json())).status, 'render_ready');
  assert.equal((await fetch(`${base}/tasks/${project.task_id}/draft`, { headers: headers() })).status, 200);

  const revision = await fetch(`${base}/tasks/${project.task_id}/plan`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'creator-plan-revision-key-1' }, body: JSON.stringify({
    content_version: 2, request_text: '장면 전개를 더 차분하게 수정해 주세요', privacy_consent_id: consent.consent_id,
  }) });
  assert.equal(revision.status, 201);
  const revised = await revision.json();
  assert.equal(revised.content_version, 3);
  assert.equal(revised.checkpoint.status, 'pending');
  assert.deepEqual(repositories.state.data.projects[project.project_id].media_ids, [mediaId], 'existing project media must be reused without upload');
  assert.equal(repositories.state.data.projects[project.project_id].caption_draft.some((caption) => /장면\s*\d+을 소개합니다|차분하게 수정/u.test(caption.text)), false);
  assert.ok(Object.values(repositories.state.data.approvals).filter((item) => item.task_id === project.task_id).every((item) => item.status === 'invalidated'));
  assert.equal(mockLLM.calls, 2);
  const revisionReplay = await fetch(`${base}/tasks/${project.task_id}/plan`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'creator-plan-revision-key-1' }, body: JSON.stringify({
    content_version: 2, request_text: '장면 전개를 더 차분하게 수정해 주세요', privacy_consent_id: consent.consent_id,
  }) });
  assert.equal((await revisionReplay.json()).content_hash, revised.content_hash);
  assert.equal(mockLLM.calls, 2);

  const foreignPlan = await fetch(`${base}/tasks/${project.task_id}/plan`, { method: 'POST', headers: { ...headers(tokenB), 'content-type': 'application/json', 'idempotency-key': 'foreign-creator-plan-key' }, body: JSON.stringify({ content_version: 3, request_text: '내 쇼츠' }) });
  assert.equal(foreignPlan.status, 404);
  const foreignRoute = await fetch(`${base}/assistant/messages`, { method: 'POST', headers: { ...headers(tokenB), 'content-type': 'application/json', 'idempotency-key': 'foreign-assistant-route-key' }, body: JSON.stringify({ text: '쇼츠 기획', task_id: project.task_id }) });
  assert.equal(foreignRoute.status, 404);
  const nonCreator = await fetch(`${base}/assistant/messages`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'assistant-schedule-route-key' }, body: JSON.stringify({ text: '다음 주 일정 알려줘' }) });
  assert.equal((await nonCreator.json()).agent_id, 'schedule');
  const ambiguous = await fetch(`${base}/assistant/messages`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'assistant-ambiguous-route-key' }, body: JSON.stringify({ text: '오늘 일정 정리해서 일기 써줘' }) });
  assert.equal((await ambiguous.json()).status, 'needs_clarification');
});

test('existing synthetic travel project recovers scene-only Vision captions after plan approval', async (t) => {
  const { base, mockLLM } = await fixture(t);
  const { project, mediaId } = await prepareUnapprovedProject(base, 5112);
  const originalGenerate = mockLLM.generateStructured.bind(mockLLM);
  mockLLM.generateStructured = async (context) => {
    const output = await originalGenerate(context);
    if (Array.isArray(context.input?.media)) {
      output.captions = [];
      output.plan.scenes[0].caption_text = '길 위의 조용한 순간';
      delete output.plan.media_insights;
    }
    return output;
  };
  const jsonHeaders = { ...headers(), 'content-type': 'application/json' };
  const local = await fetch(`${base}/tasks/${project.task_id}/plan`, { method: 'POST', headers: { ...jsonHeaders, 'idempotency-key': 'travel-local-plan-0001' },
    body: JSON.stringify({ content_version: 1, request_text: '여행 쇼츠를 만들어줘' }) });
  assert.equal(local.status, 201);
  assert.equal((await local.json()).generation.source, 'local_rules');
  assert.equal(mockLLM.calls, 0);
  const notice = await fetch(`${base}/privacy/processing-notice?provider_id=openai&purpose=vision_analysis`, { headers: headers() }).then((r) => r.json());
  const consentResponse = await fetch(`${base}/privacy/consents`, { method: 'POST', headers: { ...jsonHeaders, 'idempotency-key': 'travel-vision-consent-0001' },
    body: JSON.stringify({ provider_id: 'openai', purpose: 'vision_analysis', data_categories: notice.data_categories, resource_ids: [mediaId],
      notice_id: notice.notice_id, notice_version: notice.notice_version, explicitly_confirmed: true, expires_at: new Date(Date.now() + 60_000).toISOString() }) });
  assert.equal(consentResponse.status, 201);
  const consent = await consentResponse.json();
  const vision = await fetch(`${base}/tasks/${project.task_id}/plan`, { method: 'POST', headers: { ...jsonHeaders, 'idempotency-key': 'travel-vision-plan-0001' },
    body: JSON.stringify({ content_version: 2, request_text: '차분한 여행 영상으로 구성해 줘', privacy_consent_id: consent.consent_id }) });
  assert.equal(vision.status, 201);
  const planned = await vision.json();
  assert.equal(planned.generation.source, 'mock');
  assert.equal(planned.generation.fallback_used, true);
  assert.equal(mockLLM.calls, 1);
  assert.equal((await fetch(`${base}/tasks/${project.task_id}/draft`, { headers: headers() })).status, 409);
  const approve = async (checkpoint, key) => fetch(`${base}/tasks/${project.task_id}/approvals`, { method: 'POST', headers: { ...jsonHeaders, 'idempotency-key': key },
    body: JSON.stringify({ checkpoint_id: checkpoint.checkpoint_id, content_version: checkpoint.content_version,
      content_hash: checkpoint.content_hash, approval_scope: 'continue' }) });
  assert.equal((await approve(planned.checkpoint, 'travel-plan-approve-0001')).status, 201);
  const draft = await fetch(`${base}/tasks/${project.task_id}/draft`, { headers: headers() }).then((r) => r.json());
  assert.deepEqual(draft.captions.map((caption) => caption.text), ['길 위의 조용한 순간']);
  assert.equal(draft.captions[0].start_seconds, 0);
  assert.equal(draft.captions[0].end_seconds, 3.5);
  assert.equal((await approve(draft.checkpoint, 'travel-draft-approve-0001')).status, 201);
  const edited = await fetch(`${base}/tasks/${project.task_id}/draft`, { method: 'PATCH', headers: { ...jsonHeaders, 'idempotency-key': 'travel-caption-edit-0001' },
    body: JSON.stringify({ content_version: planned.content_version, content_hash: planned.content_hash,
      captions: [{ order: 1, start_seconds: 0.4, end_seconds: 2.8, text: '길 위의 새로운 순간' }], captions_enabled: true,
      music_track_id: null, source_volume: 1, music_volume: 0.25, fade_in_seconds: 1, fade_out_seconds: 1 }) });
  assert.equal(edited.status, 200);
  const revised = await edited.json();
  assert.equal(revised.content_version, planned.content_version + 1);
  assert.equal((await fetch(`${base}/tasks/${project.task_id}/render`, { method: 'POST', headers: { ...jsonHeaders, 'idempotency-key': 'travel-stale-render-0001' },
    body: JSON.stringify({ content_version: planned.content_version, content_hash: planned.content_hash }) })).status, 409);
  assert.equal((await approve(revised.checkpoint, 'travel-replan-approve-0001')).status, 201);
  const revisedDraft = await fetch(`${base}/tasks/${project.task_id}/draft`, { headers: headers() }).then((r) => r.json());
  assert.deepEqual(revisedDraft.captions.map((caption) => [caption.start_seconds, caption.end_seconds, caption.text]),
    [[0.4, 2.8, '길 위의 새로운 순간']]);
  assert.equal((await approve(revisedDraft.checkpoint, 'travel-redraft-approve-0001')).status, 201);
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

async function prepareUnapprovedProject(base, suffix) {
  const clientItemId = `44444444-4444-4444-8444-${String(suffix).padStart(12, '0')}`;
  const init = await fetch(`${base}/media/uploads`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': `upload-init-plan-${suffix}` }, body: JSON.stringify({ items: [{
    client_item_id: clientItemId, file_name: `selected-plan-${suffix}.png`, declared_media_type: 'image/png', size_bytes: png.length, sha256: digest(png),
  }] }) });
  const upload = await init.json();
  await fetch(`${base}/media/uploads/${upload.upload_id}/parts/1`, { method: 'PUT', headers: { ...headers(), 'content-type': 'application/octet-stream', 'idempotency-key': `upload-part-plan-${suffix}` }, body: png });
  const manifest = digest(Buffer.from(JSON.stringify([{ client_item_id: clientItemId, sha256: digest(png), size_bytes: png.length }])));
  const completed = await fetch(`${base}/media/uploads/${upload.upload_id}/complete`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': `upload-done-plan-${suffix}` }, body: JSON.stringify({ manifest_sha256: manifest }) });
  const mediaId = (await completed.json()).media[0].media_id;
  const created = await fetch(`${base}/content/projects`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': `project-plan-${suffix}` }, body: JSON.stringify({ media_ids: [mediaId] }) });
  return { project: await created.json(), mediaId };
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

test('multi-item sessions work while single upload still rejects wrong part content type and part 2', async (t) => {
  const { base } = await fixture(t);
  const item = { client_item_id: '33333333-3333-4333-8333-333333333333', file_name: 'selected.png', declared_media_type: 'image/png', size_bytes: png.length, sha256: digest(png) };
  const multi = await fetch(`${base}/media/uploads`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'multi-upload-init-0001' }, body: JSON.stringify({ items: [item, { ...item, client_item_id: '44444444-4444-4444-8444-444444444444' }] }) });
  assert.equal(multi.status, 201);

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

test('caption and music edits version the task and unverified platform rights block final approval', async (t) => {
  const { base, repositories } = await fixture(t);
  const project = await prepareApprovedProject(base, 7788);
  const wav = Buffer.alloc(44); wav.write('RIFF', 0); wav.write('WAVE', 8);
  const rights = { source_url: '', license_name: '', license_version: '', license_url: '', evidence: '', downloaded_at: '', attribution_required: false, required_attribution: '', commercial_allowed: false, platforms: [], explicitly_verified: false };
  const create = await fetch(`${base}/music/tracks`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'music-register-test-0001' }, body: JSON.stringify({ title: 'Synthetic test tone', artist: 'Test', format: 'wav', size_bytes: wav.length, sha256: digest(wav), rights }) });
  assert.equal(create.status, 201);
  const track = await create.json();
  const foreign = await fetch(`${base}/music/tracks/${track.track_id}/content`, { method: 'PUT', headers: { ...headers(tokenB), 'content-type': 'application/octet-stream', 'idempotency-key': 'foreign-music-upload-0001' }, body: wav });
  assert.equal(foreign.status, 404);
  const wrongBytes = Buffer.from(wav); wrongBytes[20] = 1;
  const tamperedUpload = await fetch(`${base}/music/tracks/${track.track_id}/content`, { method: 'PUT', headers: { ...headers(), 'content-type': 'application/octet-stream', 'idempotency-key': 'tampered-music-upload-001' }, body: wrongBytes });
  assert.equal(tamperedUpload.status, 409);
  const uploaded = await fetch(`${base}/music/tracks/${track.track_id}/content`, { method: 'PUT', headers: { ...headers(), 'content-type': 'application/octet-stream', 'idempotency-key': 'music-upload-test-0001' }, body: wav });
  assert.equal(uploaded.status, 200);
  assert.equal((await uploaded.json()).status, 'available');
  assert.equal((await fetch(`${base}/music/tracks`, { headers: headers(tokenB) }).then((r) => r.json())).items.length, 0);

  const edit = { content_version: project.current_version, content_hash: project.content_hash, captions: [{ order: 1, start_seconds: 0.3, end_seconds: 2.5, text: '안녕하세요' }], captions_enabled: true,
    music_track_id: track.track_id, source_volume: 0.5, music_volume: 0.3, fade_in_seconds: 1, fade_out_seconds: 1 };
  const editHeaders = { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'draft-edit-test-0001' };
  const response = await fetch(`${base}/tasks/${project.task_id}/draft`, { method: 'PATCH', headers: editHeaders, body: JSON.stringify(edit) });
  assert.equal(response.status, 200);
  const revised = await response.json();
  assert.equal(revised.content_version, 2);
  assert.notEqual(revised.content_hash, project.content_hash);
  assert.ok(Object.values(repositories.state.data.approvals).filter((item) => item.task_id === project.task_id).every((item) => item.status === 'invalidated'));
  const replay = await fetch(`${base}/tasks/${project.task_id}/draft`, { method: 'PATCH', headers: editHeaders, body: JSON.stringify(edit) });
  assert.equal((await replay.json()).content_hash, revised.content_hash);
  const stale = await fetch(`${base}/tasks/${project.task_id}/render`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'old-version-render-0001' }, body: JSON.stringify({ content_version: 1, content_hash: project.content_hash }) });
  assert.equal(stale.status, 409);

  const approve = async (checkpoint, key) => fetch(`${base}/tasks/${project.task_id}/approvals`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ checkpoint_id: checkpoint.checkpoint_id, content_version: checkpoint.content_version, content_hash: checkpoint.content_hash, approval_scope: 'continue' }) });
  assert.equal((await approve(revised.checkpoint, 'edit-plan-approval-0001')).status, 201);
  const draft = await fetch(`${base}/tasks/${project.task_id}/draft`, { headers: headers() }).then((r) => r.json());
  assert.equal(draft.captions[0].text, '안녕하세요');
  assert.equal(draft.captions[0].start_seconds, 0.3);
  assert.equal(draft.captions[0].end_seconds, 2.5);
  assert.equal((await approve(draft.checkpoint, 'edit-draft-approval-0001')).status, 201);
  const rendered = await fetch(`${base}/tasks/${project.task_id}/render`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'edited-draft-render-0001' }, body: JSON.stringify({ content_version: 2, content_hash: revised.content_hash }) });
  assert.equal(rendered.status, 202);
  assert.equal((await waitForJob(base, (await rendered.json()).job_id)).status, 'simulated');
  const publication = await fetch(`${base}/tasks/${project.task_id}/publications`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'music-publication-test-01' }, body: JSON.stringify({ platform: 'youtube', account_id: 'test-account', visibility: 'private', title: 'test', description: '', hashtags: [] }) }).then((r) => r.json());

  // Seed a verified artifact and preview approval to isolate the rights gate; no real SNS call is made.
  const task = repositories.state.data.tasks[project.task_id];
  repositories.state.data.jobs['test-real-job'] = { task_id: project.task_id, status: 'succeeded', renderer_mode: 'ffmpeg', artifact_verified: true, artifact_sha256: 'a'.repeat(64), content_version: 2, content_hash: revised.content_hash, source_audio_media_ids: [] };
  repositories.state.data.checkpoints['test-preview'] = { task_id: project.task_id, kind: 'preview', status: 'approved', content_version: 2, content_hash: revised.content_hash, approval_id: 'test-preview-approval' };
  repositories.state.data.approvals['test-preview-approval'] = { task_id: project.task_id, status: 'active', approval_scope: 'continue' };
  task.status = 'preview_approved'; repositories.state.save();
  const approvalBody = { content_version: 2, content_hash: revised.content_hash, artifact_sha256: 'a'.repeat(64), publication_revision: publication.revision, publication_hash: publication.metadata_hash };
  const finalApproval = (key) => fetch(`${base}/tasks/${project.task_id}/publications/${publication.publication_id}/approvals`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(approvalBody) });
  const blocked = await finalApproval('unverified-rights-test-001');
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error.code, 'RIGHTS_REVIEW_REQUIRED');
  const verified = { source_url: 'https://example.invalid/source', license_name: 'Test license', license_version: 'test-v1', license_url: 'https://example.invalid/license', evidence: 'Synthetic test evidence', downloaded_at: '2026-01-01', attribution_required: false, required_attribution: '', commercial_allowed: true, platforms: ['youtube'], explicitly_verified: true };
  const updateRights = (revision, value, key) => fetch(`${base}/music/tracks/${track.track_id}/rights`, { method: 'PATCH', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ rights_revision: revision, rights: value }) });
  const attributed = { ...verified, attribution_required: true, required_attribution: 'Test Artist' };
  assert.equal((await updateRights(1, attributed, 'music-rights-verify-0001')).status, 200);
  assert.throws(() => repositories.musicLibrary.assertPublishable('owner-a', track.track_id, 'instagram'), { code: 'RIGHTS_REVIEW_REQUIRED' });
  assert.equal((await finalApproval('missing-attribution-test-01')).status, 403);
  assert.equal((await updateRights(2, verified, 'music-rights-update-0001')).status, 200);
  const storedAudio = join(repositories.musicLibrary.directory, `${track.track_id}.wav`);
  writeFileSync(storedAudio, wrongBytes);
  assert.equal((await finalApproval('changed-audio-rights-test-01')).status, 409);
  writeFileSync(storedAudio, wav);
  const syntheticSourceId = project.media_ids[0];
  repositories.state.data.jobs['test-real-job'].source_audio_media_ids = [syntheticSourceId];
  assert.equal((await finalApproval('unverified-original-test-01')).status, 403);
  repositories.state.data.projects[project.project_id].composition.source_audio_rights = [{ media_id: syntheticSourceId, explicitly_verified: true, commercial_allowed: true, platforms: ['youtube'], evidence: 'Synthetic source proof', attribution_required: false, required_attribution: '' }];
  const allowed = await finalApproval('verified-rights-test-0001');
  assert.equal(allowed.status, 201);
  const approval = await allowed.json();
  assert.equal((await updateRights(3, rights, 'music-rights-revoke-0001')).status, 200);
  assert.equal(repositories.state.data.approvals[approval.approval_id].status, 'invalidated');
  assert.equal(repositories.state.data.publications[publication.publication_id].status, 'draft');
  assert.equal((await finalApproval('verified-rights-test-0001')).status, 403);
  repositories.state.data.projects[project.project_id].composition.source_audio_rights = [];
  repositories.state.data.jobs['test-real-job'].source_audio_media_ids = [];
  const cachedBytes = Buffer.from('synthetic cached video, used only by this mocked repository test');
  const cachedName = 'cached-test.mp4';
  writeFileSync(join(repositories.renderDir, cachedName), cachedBytes);
  Object.assign(repositories.state.data.jobs['test-real-job'], { artifact_key: cachedName, artifact_sha256: digest(cachedBytes) });
  const musicOnlyEdit = { ...edit, content_version: 2, content_hash: revised.content_hash, music_volume: 0.8 };
  const musicOnly = await fetch(`${base}/tasks/${project.task_id}/draft`, { method: 'PATCH', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'music-only-edit-test-001' }, body: JSON.stringify(musicOnlyEdit) });
  assert.equal(musicOnly.status, 200);
  assert.equal((await musicOnly.json()).content_version, 3);
  assert.equal(repositories.state.data.projects[project.project_id].video_reuse?.sha256, digest(cachedBytes));
});

test('real Creator API renders an approved Korean caption and selected local music and enforces rights', {
  skip: !['ffmpeg', 'ffprobe'].every((command) => spawnSync(command, ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0), timeout: 120000,
}, async (t) => {
  const { base, repositories, mockLLM } = await fixture(t, (repo) => createFFmpegRenderer({ mediaRoot: repo.blobDir, outputRoot: repo.renderDir }));
  const sourcePath = join(repositories.dataDir, 'synthetic-source.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-movflags', '+faststart', sourcePath], { windowsHide: true });
  const sourceBytes = readFileSync(sourcePath); const sourceId = randomUUID(); const sourceHash = digest(sourceBytes);
  const sourceInit = await fetch(`${base}/media/uploads`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'real-source-upload-init-001' }, body: JSON.stringify({ items: [{ client_item_id: sourceId, file_name: 'synthetic-source.mp4', declared_media_type: 'video/mp4', size_bytes: sourceBytes.length, sha256: sourceHash }] }) });
  assert.equal(sourceInit.status, 201); const sourceUpload = await sourceInit.json();
  assert.equal((await fetch(`${base}/media/uploads/${sourceUpload.upload_id}/parts/1`, { method: 'PUT', headers: { ...headers(), 'content-type': 'application/octet-stream', 'idempotency-key': 'real-source-upload-part-001' }, body: sourceBytes })).status, 204);
  const sourceManifest = digest(Buffer.from(JSON.stringify([{ client_item_id: sourceId, sha256: sourceHash, size_bytes: sourceBytes.length }])));
  const sourceComplete = await fetch(`${base}/media/uploads/${sourceUpload.upload_id}/complete`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'real-source-complete-key-01' }, body: JSON.stringify({ manifest_sha256: sourceManifest }) });
  assert.equal(sourceComplete.status, 200); const mediaId = (await sourceComplete.json()).media[0].media_id;
  const project = await fetch(`${base}/content/projects`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'real-composition-project-001' }, body: JSON.stringify({ media_ids: [mediaId], target_seconds: 3 }) }).then((r) => r.json());
  const plan = await fetch(`${base}/tasks/${project.task_id}/plan`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'real-composition-plan-0001' }, body: JSON.stringify({ content_version: 1, request_text: '합성 영상을 소개합니다' }) }).then((r) => r.json());
  assert.equal(plan.generation.llm_calls, 0); assert.equal(mockLLM.calls, 0);
  const approve = async (checkpoint, key) => fetch(`${base}/tasks/${project.task_id}/approvals`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ checkpoint_id: checkpoint.checkpoint_id, content_version: checkpoint.content_version, content_hash: checkpoint.content_hash, approval_scope: 'continue' }) });
  assert.equal((await approve(plan.checkpoint, 'real-initial-plan-approval-001')).status, 201);
  const initialDraft = await fetch(`${base}/tasks/${project.task_id}/draft`, { headers: headers() }).then((r) => r.json());
  assert.deepEqual(initialDraft.captions, [], 'local fallback must leave visual captions for the user to write');
  const audioPath = join(repositories.dataDir, 'synthetic-test-tone.wav');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '3', '-c:a', 'pcm_s16le', audioPath], { windowsHide: true });
  const audio = readFileSync(audioPath);
  const rights = { source_url: '', license_name: '', license_version: '', license_url: '', evidence: '', downloaded_at: '', attribution_required: false, required_attribution: '', commercial_allowed: false, platforms: [], explicitly_verified: false };
  const trackResponse = await fetch(`${base}/music/tracks`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'real-track-registration-001' }, body: JSON.stringify({ title: '합성 시험 음원', artist: 'test', format: 'wav', size_bytes: audio.length, sha256: digest(audio), rights }) });
  assert.equal(trackResponse.status, 201); const track = await trackResponse.json();
  assert.equal((await fetch(`${base}/music/tracks/${track.track_id}/content`, { method: 'PUT', headers: { ...headers(), 'content-type': 'application/octet-stream', 'idempotency-key': 'real-track-upload-key-0001' }, body: audio })).status, 200);
  const edit = await fetch(`${base}/tasks/${project.task_id}/draft`, { method: 'PATCH', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'real-draft-edit-key-0001' }, body: JSON.stringify({ content_version: plan.content_version, content_hash: plan.content_hash, captions: [{ order: 1, start_seconds: 0, end_seconds: 3, text: '안녕하세요 합성 테스트입니다' }], captions_enabled: true, music_track_id: track.track_id, source_volume: 0.7, music_volume: 0.4, fade_in_seconds: 0.5, fade_out_seconds: 0.5 }) });
  assert.equal(edit.status, 200); const revised = await edit.json();
  assert.equal((await approve(revised.checkpoint, 'real-revised-plan-approval-01')).status, 201);
  const draft = await fetch(`${base}/tasks/${project.task_id}/draft`, { headers: headers() }).then((r) => r.json());
  assert.equal((await approve(draft.checkpoint, 'real-revised-draft-approval-01')).status, 201);
  const render = await fetch(`${base}/tasks/${project.task_id}/render`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'real-composition-render-0001' }, body: JSON.stringify({ content_version: revised.content_version, content_hash: revised.content_hash }) });
  assert.equal(render.status, 202); const queued = await render.json();
  let job;
  for (let i = 0; i < 300; i++) { job = await fetch(`${base}/jobs/${queued.job_id}`, { headers: headers() }).then((r) => r.json()); if (['succeeded', 'failed', 'cancelled'].includes(job.status)) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.equal(job.status, 'succeeded', job.safe_error_code); assert.equal(job.renderer_mode, 'ffmpeg'); assert.equal(job.artifact_verified, true);
  assert.deepEqual(job.source_audio_media_ids, [mediaId]);
  const noAuth = await fetch(`${base}/tasks/${project.task_id}/preview?content_version=${revised.content_version}`); assert.equal(noAuth.status, 401);
  const preview = await fetch(`${base}/tasks/${project.task_id}/preview?content_version=${revised.content_version}`, { headers: headers() });
  assert.equal(preview.status, 200); assert.equal(preview.headers.get('content-type'), 'video/mp4'); assert.equal(preview.headers.get('x-haejumi-render-mode'), 'ffmpeg');
  const checkpoints = await fetch(`${base}/tasks/${project.task_id}/checkpoints`, { headers: headers() }).then((r) => r.json());
  assert.equal((await approve(checkpoints.items.find((item) => item.kind === 'preview' && item.status === 'pending'), 'real-preview-approval-0001')).status, 201);
  const publication = await fetch(`${base}/tasks/${project.task_id}/publications`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'real-publication-create-001' }, body: JSON.stringify({ platform: 'youtube', account_id: 'test-account', visibility: 'private', title: 'test', description: '', hashtags: [] }) }).then((r) => r.json());
  const final = await fetch(`${base}/tasks/${project.task_id}/publications/${publication.publication_id}/approvals`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'real-unverified-approval-01' }, body: JSON.stringify({ content_version: revised.content_version, content_hash: revised.content_hash, artifact_sha256: job.artifact_sha256, publication_revision: publication.revision, publication_hash: publication.metadata_hash }) });
  assert.equal(final.status, 403); assert.equal((await final.json()).error.code, 'RIGHTS_REVIEW_REQUIRED');
  const verified = { source_url: 'https://example.invalid/source', license_name: 'Test license', license_version: 'v1', license_url: 'https://example.invalid/license', evidence: 'Synthetic test evidence', downloaded_at: '2026-01-01', attribution_required: false, required_attribution: '', commercial_allowed: true, platforms: ['youtube'], explicitly_verified: true };
  assert.equal((await fetch(`${base}/music/tracks/${track.track_id}/rights`, { method: 'PATCH', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'real-track-rights-confirm-01' }, body: JSON.stringify({ rights_revision: 1, rights: verified }) })).status, 200);
  const approvalInput = { content_version: revised.content_version, content_hash: revised.content_hash, artifact_sha256: job.artifact_sha256, publication_revision: publication.revision, publication_hash: publication.metadata_hash };
  const missingOriginal = await fetch(`${base}/tasks/${project.task_id}/publications/${publication.publication_id}/approvals`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'real-original-rights-block-01' }, body: JSON.stringify(approvalInput) });
  assert.equal(missingOriginal.status, 403); assert.equal((await missingOriginal.json()).error.code, 'RIGHTS_REVIEW_REQUIRED');
  const sourceRights = [{ media_id: mediaId, explicitly_verified: true, commercial_allowed: true, platforms: ['youtube'], evidence: 'Synthetic original audio', attribution_required: false, required_attribution: '' }];
  const editRights = await fetch(`${base}/tasks/${project.task_id}/draft`, { method: 'PATCH', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'real-source-rights-edit-001' }, body: JSON.stringify({ content_version: revised.content_version, content_hash: revised.content_hash, captions: draft.captions, captions_enabled: true, music_track_id: track.track_id, source_volume: 0.7, music_volume: 0.4, fade_in_seconds: 0.5, fade_out_seconds: 0.5, source_audio_rights: sourceRights }) });
  assert.equal(editRights.status, 200); const rightsVersion = await editRights.json();
  assert.equal((await approve(rightsVersion.checkpoint, 'real-rights-plan-approval-001')).status, 201);
  const rightsDraft = await fetch(`${base}/tasks/${project.task_id}/draft`, { headers: headers() }).then((r) => r.json());
  assert.equal((await approve(rightsDraft.checkpoint, 'real-rights-draft-approval-01')).status, 201);
  const secondRender = await fetch(`${base}/tasks/${project.task_id}/render`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'real-rights-render-key-0001' }, body: JSON.stringify({ content_version: rightsVersion.content_version, content_hash: rightsVersion.content_hash }) });
  assert.equal(secondRender.status, 202); const secondJobId = (await secondRender.json()).job_id;
  let secondJob; for (let i = 0; i < 300; i++) { secondJob = await fetch(`${base}/jobs/${secondJobId}`, { headers: headers() }).then((r) => r.json()); if (['succeeded', 'failed', 'cancelled'].includes(secondJob.status)) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.equal(secondJob.status, 'succeeded', secondJob.safe_error_code); assert.equal(secondJob.video_reused, true); assert.deepEqual(secondJob.source_audio_media_ids, [mediaId]);
  const secondCheckpoints = await fetch(`${base}/tasks/${project.task_id}/checkpoints`, { headers: headers() }).then((r) => r.json());
  assert.equal((await approve(secondCheckpoints.items.find((item) => item.kind === 'preview' && item.status === 'pending'), 'real-rights-preview-approve-01')).status, 201);
  const accepted = await fetch(`${base}/tasks/${project.task_id}/publications/${publication.publication_id}/approvals`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', 'idempotency-key': 'real-confirmed-rights-final-01' }, body: JSON.stringify({ content_version: rightsVersion.content_version, content_hash: rightsVersion.content_hash, artifact_sha256: secondJob.artifact_sha256, publication_revision: publication.revision, publication_hash: publication.metadata_hash }) });
  assert.equal(accepted.status, 201); assert.equal(mockLLM.calls, 0);
});
