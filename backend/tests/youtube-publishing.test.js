import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { JsonState } from '../src/adapters/filesystem/json-state.js';
import { LocalRepositories } from '../src/adapters/filesystem/repositories.js';
import { createApiHandler } from '../src/adapters/node-http/transport.js';
import { EncryptedTokenVault } from '../src/security/encrypted-token-vault.js';
import { YouTubeProvider, UPLOAD_SCOPE } from '../src/application/youtube-provider.js';
import { YouTubePublishingService } from '../src/application/youtube-publishing-service.js';

const channelId = 'UC' + 'a'.repeat(22);
const owner = 'owner-a';
const approval = { approval_id: 'approval-a', artifact_sha256: 'a'.repeat(64), content_version: 2 };
const publication = { platform: 'youtube', account_id: channelId, visibility: 'private',
  title: '합성 영상', description: '테스트', hashtags: ['테스트'] };

function fixture(t, { upload = async () => ({ video_id: 'abcdefghijk' }), gate = () => ({ bytes: Buffer.from('synthetic-mp4'), approval, publication }) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'haejumi-youtube-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new JsonState(join(dir, 'state.json'));
  const vaultPath = join(dir, 'vault.json');
  const vaultKey = randomBytes(32);
  const vault = new EncryptedTokenVault(vaultPath, vaultKey);
  const calls = { exchange: 0, channel: 0, upload: 0, revoke: 0, refresh: 0 };
  const provider = {
    authorizationUrl: ({ state, challenge, redirectUri }) =>
      `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&code_challenge=${challenge}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    async exchangeCode({ verifier }) { calls.exchange++; assert.ok(verifier.length >= 43);
      return { access_token: 'mock-access', refresh_token: 'mock-refresh', expires_at: Date.now() + 3600_000, scopes: [UPLOAD_SCOPE] }; },
    async refresh() { calls.refresh++; return { access_token: 'mock-refreshed', expires_at: Date.now() + 3600_000, scopes: [UPLOAD_SCOPE] }; },
    async channel() { calls.channel++; return { channel_id: channelId, channel_title: '테스트 채널' }; },
    async upload(input) { calls.upload++; assert.equal(input.visibility, 'private'); assert.equal(input.madeForKids, false); assert.match(input.description, /#테스트/); return upload(input); },
    async revoke() { calls.revoke++; },
  };
  const repositories = { getPublication: (requestOwner) => requestOwner === owner ? publication : null,
    getApprovedYouTubeUpload: (requestOwner) => {
      if (requestOwner !== owner) throw Object.assign(new Error('missing'), { status: 404, code: 'RESOURCE_NOT_FOUND' });
      return gate();
    } };
  const service = new YouTubePublishingService({ state, repositories, provider, vault });
  return { service, state, vault, vaultPath, vaultKey, calls, provider };
}

async function connect(service) {
  const start = service.begin(owner);
  const state = new URL(start.authorization_url).searchParams.get('state');
  await service.callback(state, 'mock-code');
  return start;
}

test('OAuth state, PKCE, scope and encrypted vault isolate the account', async (t) => {
  const { service, vaultPath, vault, calls, provider } = fixture(t);
  const start = service.begin(owner, 'connect-key-1');
  assert.equal(service.begin(owner, 'connect-key-1').authorization_url, start.authorization_url);
  const url = new URL(start.authorization_url);
  assert.equal(url.hostname, 'accounts.google.com');
  assert.ok(url.searchParams.get('code_challenge'));
  await assert.rejects(service.callback('wrong-state', 'code'), { code: 'OAUTH_STATE_INVALID' });
  await service.callback(url.searchParams.get('state'), 'code');
  assert.equal(service.status(owner).channel_id, channelId);
  assert.equal(service.status('other-owner').connected, false);
  assert.ok(!readFileSync(vaultPath, 'utf8').includes('mock-refresh'));
  await assert.rejects(service.callback(url.searchParams.get('state'), 'code'), { code: 'OAUTH_STATE_INVALID' });
  vault.set(owner, { ...vault.get(owner), expires_at: Date.now() - 1 });
  assert.equal(await service.credential(owner), 'mock-refreshed');
  assert.equal(calls.refresh, 1);
  await service.disconnect(owner);
  assert.equal(service.status(owner).connected, false);
  assert.equal(vault.get(owner), null);
  assert.equal(calls.revoke, 1);
  provider.exchangeCode = async () => ({ access_token: 'mock', refresh_token: 'mock', expires_at: Date.now() + 10000, scopes: [] });
  const missingScope = service.begin(owner);
  await assert.rejects(service.callback(new URL(missingScope.authorization_url).searchParams.get('state'), 'code'), { code: 'OAUTH_SCOPE_MISSING' });
});

test('upload requires approval, matching channel, ownership and idempotency', async (t) => {
  let blocked = true;
  const { service, calls, state } = fixture(t, { gate: () => {
    if (blocked) throw Object.assign(new Error('no approval'), { status: 409, code: 'STALE_APPROVAL' });
    return { bytes: Buffer.from('synthetic-mp4'), approval, publication };
  } });
  await connect(service);
  await assert.rejects(service.upload(owner, 'task-a', 'publication-a', 'upload-key-00000001', { made_for_kids: false }), { code: 'STALE_APPROVAL' });
  assert.equal(calls.upload, 0);
  blocked = false;
  publication.account_id = 'UC' + 'b'.repeat(22);
  await assert.rejects(service.upload(owner, 'task-a', 'publication-a', 'upload-key-00000001', { made_for_kids: false }), { code: 'YOUTUBE_CHANNEL_MISMATCH' });
  publication.account_id = channelId;
  await assert.rejects(service.upload('other-owner', 'task-a', 'publication-a', 'upload-key-00000001', { made_for_kids: false }), { code: 'RESOURCE_NOT_FOUND' });
  const first = await service.upload(owner, 'task-a', 'publication-a', 'upload-key-00000001', { made_for_kids: false });
  assert.equal(first.status, 'succeeded');
  assert.equal(first.video_id, 'abcdefghijk');
  assert.equal(calls.upload, 1);
  assert.equal((await service.upload(owner, 'task-a', 'publication-a', 'upload-key-00000002', { made_for_kids: false })).upload_id, first.upload_id);
  assert.equal(calls.upload, 1);
  assert.equal(service.list(owner, 'task-a', 'publication-a').items.length, 1);
  assert.equal(state.data.youtubePublishing.uploads[first.upload_id].owner_id, owner);
});

test('uncertain provider result is retained and never retried automatically', async (t) => {
  const { service, calls, state, vault, provider } = fixture(t, { upload: async () => { throw new Error('network failed'); } });
  await connect(service);
  await assert.rejects(service.upload(owner, 'task-a', 'publication-a', 'upload-key-00000003', { made_for_kids: false }), { code: 'YOUTUBE_OUTCOME_UNKNOWN' });
  assert.equal(calls.upload, 1);
  const prior = await service.upload(owner, 'task-a', 'publication-a', 'upload-key-00000004', { made_for_kids: false });
  assert.equal(prior.status, 'outcome_unknown');
  assert.equal(calls.upload, 1);
  const restarted = new YouTubePublishingService({ state, repositories: service.repositories, provider, vault });
  assert.equal((await restarted.upload(owner, 'task-a', 'publication-a', 'upload-key-00000005', { made_for_kids: false })).status, 'outcome_unknown');
  assert.equal(calls.upload, 1);
});

test('encrypted credentials and connection metadata survive a server state reload', async (t) => {
  const { service, state, vaultPath, vaultKey, provider } = fixture(t);
  await connect(service);
  const reloaded = new JsonState(state.filePath);
  const restarted = new YouTubePublishingService({ state: reloaded, repositories: service.repositories,
    provider, vault: new EncryptedTokenVault(vaultPath, vaultKey) });
  assert.equal(restarted.status(owner).channel_id, channelId);
  assert.equal(await restarted.credential(owner), 'mock-access');
});

test('parallel clicks cannot start a second upload', async (t) => {
  let finish;
  const { service, calls } = fixture(t, { upload: () => new Promise((resolve) => { finish = () => resolve({ video_id: 'abcdefghijk' }); }) });
  await connect(service);
  const first = service.upload(owner, 'task-a', 'publication-a', 'upload-key-00000006', { made_for_kids: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await service.upload(owner, 'task-a', 'publication-a', 'upload-key-00000007', { made_for_kids: false })).status, 'uploading');
  finish();
  assert.equal((await first).status, 'succeeded');
  assert.equal(calls.upload, 1);
});

test('YouTube metadata limits fail before any provider upload', async (t) => {
  const { service, calls } = fixture(t);
  await connect(service);
  await assert.rejects(service.upload(owner, 'task-a', 'publication-a', 'upload-key-00000008', {}), { code: 'YOUTUBE_AUDIENCE_REQUIRED' });
  publication.title = '긴 제목'.repeat(40);
  try {
    await assert.rejects(service.upload(owner, 'task-a', 'publication-a', 'upload-key-00000008', { made_for_kids: false }), { code: 'YOUTUBE_METADATA_INVALID' });
    assert.equal(calls.upload, 0);
  } finally { publication.title = '합성 영상'; }
});

test('network adapter builds official OAuth and resumable upload requests using mock fetch', async () => {
  const requests = [];
  const provider = new YouTubeProvider({ clientId: 'mock.apps.googleusercontent.com', clientSecret: 'mock-secret',
    fetcher: async (url, options) => {
      requests.push({ url, options });
      if (url.includes('/token')) return { ok: true, json: async () => ({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: UPLOAD_SCOPE }) };
      if (url.includes('/channels?')) return { ok: true, json: async () => ({ items: [{ id: channelId, snippet: { title: '테스트 채널' } }] }) };
      if (options.method === 'POST') return { ok: true, headers: { get: () => 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=mock' } };
      return { ok: true, json: async () => ({ id: 'abcdefghijk' }) };
    } });
  const auth = new URL(provider.authorizationUrl({ state: 'state', challenge: 'challenge', redirectUri: 'http://127.0.0.1:8765/api/v1/publications/youtube/oauth/callback' }));
  assert.equal(auth.searchParams.get('scope'), UPLOAD_SCOPE);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  const token = await provider.exchangeCode({ code: 'mock-code', verifier: 'mock-verifier', redirectUri: auth.searchParams.get('redirect_uri') });
  assert.equal(token.refresh_token, 'refresh');
  assert.equal((await provider.channel({ accessToken: token.access_token })).channel_id, channelId);
  const result = await provider.upload({ accessToken: token.access_token, bytes: Buffer.from('synthetic-mp4'),
    title: '합성 영상', description: '테스트', hashtags: ['테스트'], visibility: 'private', madeForKids: false });
  assert.equal(result.video_id, 'abcdefghijk');
  assert.equal(requests.length, 4);
  assert.equal(JSON.parse(requests[2].options.body).status.privacyStatus, 'private');
  assert.equal(JSON.parse(requests[2].options.body).status.selfDeclaredMadeForKids, false);
  assert.equal(requests[3].options.method, 'PUT');
});

test('repository preflight rechecks current approval, verified MP4, hash and owner', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'haejumi-youtube-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new JsonState(join(dir, 'state.json'));
  const repository = new LocalRepositories({ state, dataDir: dir, maxMediaBytes: 1_000_000 });
  const bytes = Buffer.from('synthetic verified artifact');
  const hash = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(repository.renderDir, 'test.mp4'), bytes);
  state.data.tasks.task = { ownerId: owner, project_id: 'project', current_version: 2, content_hash: 'content-hash', status: 'preview_approved' };
  state.data.projects.project = { ownerId: owner, media_ids: [], composition: { source_volume: 0 } };
  state.data.jobs.job = { task_id: 'task', owner_id: owner, status: 'succeeded', renderer_mode: 'ffmpeg', artifact_verified: true,
    content_version: 2, content_hash: 'content-hash', artifact_sha256: hash, artifact_key: 'test.mp4' };
  state.data.checkpoints.preview = { task_id: 'task', kind: 'preview', status: 'approved', content_version: 2,
    content_hash: 'content-hash', approval_id: 'preview-approval' };
  state.data.approvals['preview-approval'] = { status: 'active', approval_scope: 'continue' };
  state.data.publications.publication = { publication_id: 'publication', task_id: 'task', owner_id: owner,
    ...publication, revision: 1, metadata_hash: 'metadata-hash', status: 'publish_ready', approval_id: 'final-approval' };
  state.data.approvals['final-approval'] = { approval_id: 'final-approval', task_id: 'task', publication_id: 'publication',
    status: 'active', approval_scope: 'final_publish', platform: 'youtube', account_id: channelId,
    visibility: 'private', title: publication.title, description: publication.description, hashtags: publication.hashtags,
    publication_revision: 1, publication_hash: 'metadata-hash', content_version: 2, content_hash: 'content-hash', artifact_sha256: hash };
  assert.deepEqual(repository.getApprovedYouTubeUpload(owner, 'task', 'publication').bytes, bytes);
  assert.throws(() => repository.getApprovedYouTubeUpload('other', 'task', 'publication'), { code: 'RESOURCE_NOT_FOUND' });
  state.data.approvals['final-approval'].status = 'invalidated';
  assert.throws(() => repository.getApprovedYouTubeUpload(owner, 'task', 'publication'), { code: 'STALE_APPROVAL' });
  state.data.approvals['final-approval'].status = 'active';
  writeFileSync(join(repository.renderDir, 'test.mp4'), Buffer.from('changed'));
  assert.throws(() => repository.getApprovedYouTubeUpload(owner, 'task', 'publication'), { code: 'VERSION_CONFLICT' });
});

test('HTTP OAuth callback uses one-time state; status and upload routes require authentication', async (t) => {
  const { service, state, calls } = fixture(t);
  const server = createServer(createApiHandler({ repositories: { state }, auth: {
    async authenticate(value) { return value === 'Bearer mock-bearer' ? { ownerId: owner } : null; },
  }, maxMediaBytes: 1000, youtubePublishing: service }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  service.redirectUri = `${origin}/api/v1/publications/youtube/oauth/callback`;
  const statusUrl = `${origin}/api/v1/publications/youtube/connection`;
  assert.equal((await fetch(statusUrl)).status, 401);
  assert.equal((await fetch(statusUrl, { headers: { Authorization: 'Bearer mock-bearer' } })).status, 200);
  const start = await fetch(`${statusUrl}/start`, { method: 'POST', headers: { Authorization: 'Bearer mock-bearer', 'Idempotency-Key': 'connect-key-0000001' } });
  assert.equal(start.status, 201);
  const stateValue = new URL((await start.json()).authorization_url).searchParams.get('state');
  const callback = await fetch(`${service.redirectUri}?state=${stateValue}&code=mock`, { redirect: 'manual' });
  assert.equal(callback.status, 303);
  assert.equal(calls.exchange, 1);
  assert.equal((await fetch(`${service.redirectUri}?state=${stateValue}&code=mock`, { redirect: 'manual' })).status, 403);
  assert.equal((await fetch(`${origin}/api/v1/tasks/task-a/publications/publication-a/youtube-upload`, {
    method: 'POST', headers: { 'Idempotency-Key': 'upload-key-00000001' }, redirect: 'manual' })).status, 401);
});
