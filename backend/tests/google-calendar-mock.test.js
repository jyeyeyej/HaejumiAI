import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { JsonState } from '../src/adapters/filesystem/json-state.js';
import { PersonalRecords } from '../src/adapters/filesystem/personal-records.js';
import { EncryptedTokenVault } from '../src/security/encrypted-token-vault.js';
import { GoogleCalendarService } from '../src/application/google-calendar-service.js';
import { MockGoogleCalendar } from '../src/application/mock-google-calendar.js';
import { createApiHandler } from '../src/adapters/node-http/transport.js';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'haejumi-google-mock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new JsonState(join(dir, 'state.json'));
  const vault = new EncryptedTokenVault(join(dir, 'google-tokens.json'), randomBytes(32));
  const provider = new MockGoogleCalendar();
  const google = new GoogleCalendarService({ state, vault, provider });
  return { dir, state, vault, provider, google };
}
const event = { title: '독서 모임', all_day: false, time_zone: 'Asia/Seoul',
  start_at: '2026-11-10T15:00:00+09:00', end_at: '2026-11-10T16:00:00+09:00', location: '성수동' };
function connect(google, owner) {
  const start = google.beginConnect(owner);
  const url = new URL(start.authorization_url);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar.events.owned');
  return google.completeConnect(url.searchParams.get('state'), 'mock:' + owner);
}

test('OAuth mock checks state and scope; token bytes remain encrypted outside JSON state', async (t) => {
  const { dir, state, vault, provider, google } = setup(t);
  assert.equal(google.status('a').connected, false);
  await assert.rejects(() => google.completeConnect('wrong', 'mock:a'), { code: 'OAUTH_STATE_INVALID' });
  const started = google.beginConnect('a');
  const url = new URL(started.authorization_url);
  provider.failNext = new Error('cancelled');
  await assert.rejects(() => google.completeConnect(url.searchParams.get('state'), 'mock:a'), { code: 'OAUTH_EXCHANGE_FAILED' });
  await connect(google, 'a');
  assert.equal(google.status('a').connected, true);
  assert.equal(google.status('b').connected, false);
  assert.equal(JSON.stringify(state.data).includes('mock-refresh-'), false);
  assert.equal(readFileSync(join(dir, 'google-tokens.json'), 'utf8').includes('mock-refresh-'), false);
  assert.equal(vault.get('a').refresh_token, 'mock-refresh-a');
  vault.set('a', { ...vault.get('a'), expires_at: Date.now() - 1 });
  assert.equal((await google.list('a', '2026-11-10', '2026-11-10')).items.length, 0);
  assert.equal(provider.calls.includes('refresh'), true);
  await assert.rejects(() => google.completeConnect(url.searchParams.get('state'), 'mock:a'), { code: 'OAUTH_STATE_INVALID' });
  await google.disconnect('a');
  assert.equal(vault.get('a'), null);
  assert.equal(google.status('a').connected, false);
});

test('Google mock CRUD stays separate from local events and needs a fresh confirmation', async (t) => {
  const { state, google, provider } = setup(t);
  const local = new PersonalRecords(state);
  const localEvent = local.createSchedule('a', { title: '로컬 일정', start_at: event.start_at, end_at: event.end_at }, 'local-event-key-123456');
  await connect(google, 'a'); await connect(google, 'b');
  const proposal = await google.propose('a', { kind: 'create', event }, 'create-proposal-key-123456');
  assert.equal((await google.propose('a', { kind: 'create', event }, 'create-proposal-key-123456')).proposal_id, proposal.proposal_id);
  assert.equal(provider.calls.includes('insert'), false);
  assert.equal((await google.list('a', '2026-11-10', '2026-11-10')).items.length, 0);
  await assert.rejects(() => google.confirm('b', proposal.proposal_id, 'google-confirm-key-123456'), { code: 'RESOURCE_NOT_FOUND' });
  const created = await google.confirm('a', proposal.proposal_id, 'google-confirm-key-123456');
  assert.equal(created.result.title, '독서 모임');
  await assert.rejects(() => google.propose('a', { kind: 'create', event }, 'duplicate-proposal-key-123456'), { code: 'DUPLICATE_EVENT' });
  assert.equal((await google.confirm('a', proposal.proposal_id, 'google-confirm-key-123456')).result.google_event_id,
    created.result.google_event_id);
  assert.equal(provider.calls.filter((item) => item === 'insert').length, 1);
  await assert.rejects(() => google.confirm('a', proposal.proposal_id, 'new-confirm-key-123456'), { code: 'INVALID_STATE_TRANSITION' });
  assert.equal((await google.list('a', '2026-11-10', '2026-11-10', '독서')).items.length, 1);
  provider.failNext = new Error('mock offline');
  await assert.rejects(() => google.list('a', '2026-11-10', '2026-11-10'), { code: 'GOOGLE_CALENDAR_UNAVAILABLE' });
  assert.equal(google.status('a').sync_status, 'failed');
  assert.equal((await google.list('a', '2026-11-10', '2026-11-10')).sync_status, 'current');
  assert.equal((await google.list('b', '2026-11-10', '2026-11-10')).items.length, 0);
  assert.equal(local.get('scheduleEvents', 'a', localEvent.event_id).title, '로컬 일정');
  assert.equal(state.data.scheduleEvents[localEvent.event_id].google_event_id, undefined);
  const updatedProposal = await google.propose('a', { kind: 'update', google_event_id: created.result.google_event_id,
    etag: created.result.etag, event: { ...event, title: '새 독서 모임' } }, 'update-proposal-key-123456');
  assert.equal((await google.get('a', created.result.google_event_id)).title, '독서 모임');
  assert.equal((await google.confirm('a', updatedProposal.proposal_id, 'update-confirm-key-123456')).result.title, '새 독서 모임');
  const after = await google.get('a', created.result.google_event_id);
  const removal = await google.propose('a', { kind: 'delete', google_event_id: after.google_event_id, etag: after.etag }, 'delete-proposal-key-123456');
  assert.equal((await google.confirm('a', removal.proposal_id, 'delete-confirm-key-123456')).result.status, 'deleted');
  assert.equal((await google.list('a', '2026-11-10', '2026-11-10')).items.length, 0);
  assert.equal(local.get('scheduleEvents', 'a', localEvent.event_id).title, '로컬 일정');
});

test('all-day events, external changes, stale ETags, expired tokens and unknown outcomes are isolated', async (t) => {
  const { vault, google, provider, state } = setup(t);
  await connect(google, 'a');
  const day = { title: '휴가', all_day: true, time_zone: 'Asia/Seoul', start_date: '2026-11-12', end_date: '2026-11-13' };
  const proposal = await google.propose('a', { kind: 'create', event: day }, 'all-day-proposal-key-123456');
  const created = (await google.confirm('a', proposal.proposal_id, 'allday-confirm-key-123456')).result;
  assert.equal(created.all_day, true);
  assert.deepEqual([created.start_date, created.end_date], ['2026-11-12', '2026-11-13']);
  const update = await google.propose('a', { kind: 'update', google_event_id: created.google_event_id,
    etag: created.etag, event: { ...day, title: '가족 휴가' } }, 'stale-proposal-key-123456');
  provider.changeDirectly('a', created.google_event_id, { title: 'Google에서 변경' });
  await assert.rejects(() => google.confirm('a', update.proposal_id, 'stale-confirm-key-123456'), { code: 'VERSION_CONFLICT' });
  assert.equal((await google.get('a', created.google_event_id)).title, 'Google에서 변경');
  const expiring = vault.get('a'); vault.set('a', { ...expiring, expires_at: Date.now() - 1 });
  provider.failNext = new Error('refresh failed');
  await assert.rejects(() => google.list('a', '2026-11-12', '2026-11-12'), { code: 'OAUTH_EXPIRED' });
  assert.equal(google.status('a').status, 'reauth_required');
  vault.set('a', expiring); await connect(google, 'a');
  const retry = await google.propose('a', { kind: 'create', event: { ...day, title: '새 휴가' } }, 'unknown-proposal-key-123456');
  const originalInsert = provider.insert.bind(provider);
  provider.insert = async () => { throw new Error('network dropped'); };
  await assert.rejects(() => google.confirm('a', retry.proposal_id, 'unknown-confirm-key-123456'), { code: 'GOOGLE_OUTCOME_UNKNOWN' });
  provider.insert = originalInsert;
  assert.equal(state.data.googleCalendar.proposals[retry.proposal_id].status, 'outcome_unknown');
  await assert.rejects(() => google.confirm('a', retry.proposal_id, 'unknown-confirm-key-123456'), { code: 'INVALID_STATE_TRANSITION' });
});

test('invalid time zones, duplicate proposal keys and missing OAuth scope fail closed', async (t) => {
  const { google, provider, state } = setup(t);
  const start = google.beginConnect('a');
  const oauthState = new URL(start.authorization_url).searchParams.get('state');
  const exchange = provider.exchangeCode.bind(provider);
  provider.exchangeCode = async (input) => ({ ...await exchange(input), scopes: [] });
  await assert.rejects(() => google.completeConnect(oauthState, 'mock:a'), { code: 'OAUTH_SCOPE_MISSING' });
  assert.equal(google.status('a').connected, false);
  provider.exchangeCode = exchange;
  await connect(google, 'a');
  await assert.rejects(() => google.propose('a', { kind: 'create', event: { ...event, time_zone: 'invalid/zone' } },
    'invalid-timezone-key-123456'), { code: 'VALIDATION_ERROR' });
  const first = await google.propose('a', { kind: 'create', event }, 'same-proposal-key-123456');
  assert.equal((await google.propose('a', { kind: 'create', event }, 'same-proposal-key-123456')).proposal_id, first.proposal_id);
  await assert.rejects(() => google.propose('a', { kind: 'create', event: { ...event, title: '다른 일정' } },
    'same-proposal-key-123456'), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(Object.keys(state.data.scheduleEvents ?? {}).length, 0);
});

test('authenticated HTTP mock routes keep Google connection and write approvals owner-scoped', async (t) => {
  const { state, google } = setup(t);
  const server = createServer(createApiHandler({ repositories: { state }, googleCalendar: google, maxMediaBytes: 1024,
    auth: { async authenticate(header) { return header === 'Bearer a' ? { ownerId: 'a' } :
      header === 'Bearer b' ? { ownerId: 'b' } : null; } } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/v1/schedule/google';
  google.redirectUri = base + '/oauth/callback';
  const headers = { authorization: 'Bearer a', 'idempotency-key': 'http-mock-key-123456' };
  assert.equal((await fetch(base + '/connection')).status, 401);
  const started = await fetch(base + '/connection/start', { method: 'POST', headers });
  assert.equal(started.status, 201);
  const stateValue = new URL((await started.json()).authorization_url).searchParams.get('state');
  google.redirectUri = base.replace('127.0.0.1', 'localhost') + '/oauth/callback';
  const rejectedHost = await fetch(base + '/oauth/callback?state=' + encodeURIComponent(stateValue) + '&code=mock:a');
  assert.equal(rejectedHost.status, 403);
  google.redirectUri = base + '/oauth/callback';
  const callback = await fetch(base + '/oauth/callback?state=' + encodeURIComponent(stateValue) + '&code=mock:a');
  assert.equal(callback.status, 200);
  assert.equal((await (await fetch(base + '/connection', { headers })).json()).connected, true);
  const request = await fetch(base + '/proposals', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'create', event }) });
  assert.equal(request.status, 201);
  const planned = await request.json();
  assert.equal((await fetch(base + '/events?from=2026-11-10&to=2026-11-10', { headers })).status, 200);
  assert.equal((await fetch(base + '/proposals/' + planned.proposal_id + '/confirm',
    { method: 'POST', headers: { authorization: 'Bearer b', 'idempotency-key': 'other-key-123456789' } })).status, 404);
  assert.equal((await fetch(base + '/proposals/' + planned.proposal_id + '/confirm', { method: 'POST', headers })).status, 200);
  const listed = await (await fetch(base + '/events?from=2026-11-10&to=2026-11-10', { headers })).json();
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].source, 'google');
});

test('production-style unconfigured Google routes never call a provider', async (t) => {
  const { state } = setup(t);
  const unconfigured = new GoogleCalendarService({ state });
  const server = createServer(createApiHandler({ repositories: { state }, googleCalendar: unconfigured, maxMediaBytes: 1024,
    auth: { async authenticate(header) { return header === 'Bearer a' ? { ownerId: 'a' } : null; } } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/v1/schedule/google';
  const headers = { authorization: 'Bearer a', 'idempotency-key': 'unconfigured-test-key-123456' };
  assert.deepEqual(await (await fetch(base + '/connection', { headers })).json(), {
    configured: false, connected: false, status: 'disconnected', calendar_id: null,
    sync_status: 'not_synced', last_synced_at: null });
  assert.equal((await fetch(base + '/connection/start', { method: 'POST', headers })).status, 503);
  assert.equal((await fetch(base + '/events?from=2026-11-10&to=2026-11-10', { headers })).status, 503);
});
