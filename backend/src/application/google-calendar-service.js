import { createHash, randomBytes, randomUUID } from 'node:crypto';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const date = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every((key) => allowed.includes(key));
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicEvent = (event) => ({ source: 'google', calendar_id: event.calendar_id, google_event_id: event.google_event_id,
  etag: event.etag, title: event.title, location: event.location ?? '', notes: event.notes ?? '',
  all_day: event.all_day, time_zone: event.time_zone, start_at: event.start_at ?? null,
  end_at: event.end_at ?? null, start_date: event.start_date ?? null, end_date: event.end_date ?? null,
  sync_status: event.sync_status ?? 'current', last_checked_at: event.last_checked_at ?? null });

export class GoogleCalendarService {
  constructor({ state, provider = null, vault = null, redirectUri = 'http://127.0.0.1:8765/api/v1/schedule/google/oauth/callback' }) {
    this.state = state; this.provider = provider; this.vault = vault; this.redirectUri = redirectUri;
    this.pendingOAuth = new Map();
    state.data.googleCalendar ??= { connections: {}, events: {}, proposals: {}, idempotency: {} };
    for (const name of ['connections', 'events', 'proposals', 'idempotency']) state.data.googleCalendar[name] ??= {};
  }

  ready() { if (!this.provider || !this.vault) fail(503, 'GOOGLE_CALENDAR_NOT_CONFIGURED'); }
  status(owner) {
    const connection = this.state.data.googleCalendar.connections[owner];
    return { configured: Boolean(this.provider && this.vault), connected: connection?.status === 'connected',
      status: connection?.status ?? 'disconnected', calendar_id: connection?.status === 'connected' ? connection.calendar_id : null,
      sync_status: connection?.sync_status ?? 'not_synced', last_synced_at: connection?.last_synced_at ?? null };
  }
  beginConnect(owner) {
    this.ready();
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    this.pendingOAuth.set(state, { owner, verifier, expires: Date.now() + 600_000 });
    return { authorization_url: this.provider.authorizationUrl({ state, challenge, redirectUri: this.redirectUri,
      scope: 'https://www.googleapis.com/auth/calendar.events.owned' }), expires_in_seconds: 600 };
  }
  async completeConnect(state, code) {
    this.ready();
    const attempt = this.pendingOAuth.get(state);
    this.pendingOAuth.delete(state);
    if (!attempt || attempt.expires < Date.now() || typeof code !== 'string' || !code || code.length > 2048)
      fail(403, 'OAUTH_STATE_INVALID');
    let credential;
    try { credential = await this.provider.exchangeCode({ code, verifier: attempt.verifier, redirectUri: this.redirectUri }); }
    catch { fail(503, 'OAUTH_EXCHANGE_FAILED'); }
    if (!credential || typeof credential.access_token !== 'string' || typeof credential.refresh_token !== 'string' ||
        !Number.isFinite(credential.expires_at) || credential.expires_at <= Date.now() ||
        !credential.scopes?.includes('https://www.googleapis.com/auth/calendar.events.owned')) fail(403, 'OAUTH_SCOPE_MISSING');
    this.vault.set(attempt.owner, credential);
    this.state.data.googleCalendar.connections[attempt.owner] = { owner_id: attempt.owner, calendar_id: 'primary', status: 'connected',
      connected_at: new Date().toISOString() };
    this.state.save();
    return this.status(attempt.owner);
  }
  async credential(owner) {
    this.ready();
    if (this.status(owner).status !== 'connected') fail(403, 'GOOGLE_CALENDAR_DISCONNECTED');
    const credential = this.vault.get(owner);
    if (!credential) { this.requireReconnect(owner); fail(403, 'OAUTH_EXPIRED'); }
    if (credential.expires_at > Date.now() + 30_000) return credential.access_token;
    let renewed;
    try { renewed = await this.provider.refresh({ refreshToken: credential.refresh_token }); }
    catch { this.requireReconnect(owner); fail(403, 'OAUTH_EXPIRED'); }
    if (!renewed?.access_token || !Number.isFinite(renewed.expires_at) || renewed.expires_at <= Date.now()) {
      this.requireReconnect(owner); fail(403, 'OAUTH_EXPIRED');
    }
    this.vault.set(owner, { ...credential, ...renewed, refresh_token: renewed.refresh_token ?? credential.refresh_token });
    return renewed.access_token;
  }
  async disconnect(owner) {
    this.ready();
    const credential = this.vault.get(owner);
    this.vault.delete(owner);
    this.state.data.googleCalendar.connections[owner] = { owner_id: owner, calendar_id: 'primary', status: 'disconnected' };
    this.state.save();
    if (credential) try { await this.provider.revoke({ token: credential.refresh_token }); } catch { /* local access is already disabled */ }
    return this.status(owner);
  }
  requireReconnect(owner) {
    this.state.data.googleCalendar.connections[owner].status = 'reauth_required';
    this.state.save();
  }
  markSync(owner, status) {
    const connection = this.state.data.googleCalendar.connections[owner];
    if (connection) {
      connection.sync_status = status;
      if (status === 'current') connection.last_synced_at = new Date().toISOString();
      this.state.save();
    }
  }

  static validateEvent(value) {
    if (!fields(value, ['title', 'location', 'notes', 'all_day', 'time_zone', 'start_at', 'end_at', 'start_date', 'end_date']) ||
      typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200 ||
      typeof value.all_day !== 'boolean' || typeof value.time_zone !== 'string' || value.time_zone.length > 100 ||
      (value.location !== undefined && (typeof value.location !== 'string' || value.location.length > 500)) ||
      (value.notes !== undefined && (typeof value.notes !== 'string' || value.notes.length > 4000))) fail(422, 'VALIDATION_ERROR');
    try { new Intl.DateTimeFormat('en-US', { timeZone: value.time_zone }); }
    catch { fail(422, 'VALIDATION_ERROR'); }
    if (value.all_day) {
      if (!date(value.start_date) || !date(value.end_date) || value.end_date <= value.start_date ||
          value.start_at != null || value.end_at != null) fail(422, 'VALIDATION_ERROR');
    } else if (typeof value.start_at !== 'string' || typeof value.end_at !== 'string' ||
      !/[+-]\d{2}:\d{2}$|Z$/.test(value.start_at) || !/[+-]\d{2}:\d{2}$|Z$/.test(value.end_at) ||
      !Number.isFinite(Date.parse(value.start_at)) || !Number.isFinite(Date.parse(value.end_at)) ||
      Date.parse(value.end_at) <= Date.parse(value.start_at) || value.start_date != null || value.end_date != null) fail(422, 'VALIDATION_ERROR');
  }
  normalize(event) {
    const value = { ...event, calendar_id: 'primary', sync_status: 'current', last_checked_at: new Date().toISOString() };
    try { GoogleCalendarService.validateEvent(valueForValidation(value)); }
    catch { fail(502, 'GOOGLE_RESPONSE_INVALID'); }
    if (typeof value.google_event_id !== 'string' || !/^[a-v0-9]{5,1024}$/.test(value.google_event_id) ||
      typeof value.etag !== 'string' || !value.etag) fail(502, 'GOOGLE_RESPONSE_INVALID');
    return publicEvent(value);
  }
  async list(owner, from, to, q = '') {
    if (!date(from) || !date(to) || to < from || (Date.parse(to) - Date.parse(from)) > 366 * 86400000 ||
        typeof q !== 'string' || q.length > 200) fail(422, 'VALIDATION_ERROR');
    const token = await this.credential(owner);
    let events;
    try { events = await this.provider.list({ token, calendarId: 'primary', from, to, q }); }
    catch { this.markSync(owner, 'failed'); fail(503, 'GOOGLE_CALENDAR_UNAVAILABLE'); }
    if (!Array.isArray(events) || events.length > 2500) fail(502, 'GOOGLE_RESPONSE_INVALID');
    const items = events.map((event) => this.normalize(event));
    this.state.data.googleCalendar.events[owner] ??= {};
    for (const item of items) this.state.data.googleCalendar.events[owner][item.google_event_id] = item;
    this.state.save();
    this.markSync(owner, 'current');
    return { source: 'google', sync_status: 'current', items };
  }
  async get(owner, id) {
    if (!/^[a-v0-9]{5,1024}$/.test(id)) fail(422, 'VALIDATION_ERROR');
    const token = await this.credential(owner);
    let event;
    try { event = await this.provider.get({ token, calendarId: 'primary', id }); }
    catch { this.markSync(owner, 'failed'); fail(503, 'GOOGLE_CALENDAR_UNAVAILABLE'); }
    if (!event) fail(404, 'RESOURCE_NOT_FOUND');
    const item = this.normalize(event);
    this.state.data.googleCalendar.events[owner] ??= {};
    this.state.data.googleCalendar.events[owner][id] = item; this.state.save(); this.markSync(owner, 'current');
    return item;
  }
  async assertNotDuplicate(token, event) {
    const day = event.all_day ? event.start_date : event.start_at.slice(0, 10);
    let nearby;
    try { nearby = await this.provider.list({ token, calendarId: 'primary', from: day, to: day, q: '' }); }
    catch { fail(503, 'GOOGLE_CALENDAR_UNAVAILABLE'); }
    if (!Array.isArray(nearby)) fail(502, 'GOOGLE_RESPONSE_INVALID');
    const exact = nearby.some((row) => row.title === event.title && row.all_day === event.all_day &&
      (row.location ?? '') === (event.location ?? '') && (event.all_day ? row.start_date === event.start_date && row.end_date === event.end_date :
        row.start_at === event.start_at && row.end_at === event.end_at));
    if (exact) fail(409, 'DUPLICATE_EVENT');
  }
  async propose(owner, input, key) {
    if (typeof key !== 'string' || key.length < 16 || key.length > 200) fail(422, 'VALIDATION_ERROR');
    const data = this.state.data.googleCalendar;
    const slot = owner + ':google:proposal:' + key, hash = fingerprint(input);
    if (data.idempotency[slot]) {
      if (data.idempotency[slot].hash !== hash) fail(409, 'IDEMPOTENCY_CONFLICT');
      return structuredClone(data.idempotency[slot].result);
    }
    if (!fields(input, ['kind', 'event', 'google_event_id', 'etag']) || !['create', 'update', 'delete'].includes(input.kind)) fail(422, 'VALIDATION_ERROR');
    const token = await this.credential(owner);
    let before = null;
    if (input.kind === 'create') {
      if (input.google_event_id || input.etag) fail(422, 'VALIDATION_ERROR');
      GoogleCalendarService.validateEvent(input.event);
      await this.assertNotDuplicate(token, input.event);
    } else {
      if (typeof input.google_event_id !== 'string' || typeof input.etag !== 'string' || !input.etag) fail(422, 'VALIDATION_ERROR');
      before = await this.get(owner, input.google_event_id);
      if (before.etag !== input.etag) fail(409, 'VERSION_CONFLICT');
      if (input.kind === 'update') GoogleCalendarService.validateEvent(input.event);
      else if (input.event !== undefined) fail(422, 'VALIDATION_ERROR');
    }
    const proposal_id = randomUUID();
    const proposal = { proposal_id, owner_id: owner, status: 'pending', kind: input.kind, before,
      after: input.event ?? null, google_event_id: input.google_event_id ?? randomBytes(16).toString('hex'),
      etag: input.etag ?? null, expires_at: new Date(Date.now() + 600_000).toISOString() };
    const result = publicProposal(proposal);
    data.proposals[proposal_id] = proposal;
    data.idempotency[slot] = { hash, result };
    this.state.save();
    return structuredClone(result);
  }
  async confirm(owner, id, key) {
    if (typeof key !== 'string' || key.length < 16 || key.length > 200) fail(422, 'VALIDATION_ERROR');
    const data = this.state.data.googleCalendar;
    const proposal = data.proposals[id];
    if (!proposal || proposal.owner_id !== owner) fail(404, 'RESOURCE_NOT_FOUND');
    const slot = owner + ':google:confirm:' + key;
    if (data.idempotency[slot]) {
      if (data.idempotency[slot].proposal_id !== id) fail(409, 'IDEMPOTENCY_CONFLICT');
      return structuredClone(data.idempotency[slot].result);
    }
    if (proposal.status !== 'pending' || Date.parse(proposal.expires_at) <= Date.now()) fail(409, 'INVALID_STATE_TRANSITION');
    const token = await this.credential(owner);
    if (proposal.kind === 'create') await this.assertNotDuplicate(token, proposal.after);
    else {
      const current = await this.get(owner, proposal.google_event_id);
      if (current.etag !== proposal.etag) fail(409, 'VERSION_CONFLICT');
    }
    proposal.status = 'executing'; this.state.save();
    let result;
    try {
      const args = { token, calendarId: 'primary', id: proposal.google_event_id, etag: proposal.etag };
      if (proposal.kind === 'create') result = this.normalize(await this.provider.insert({ ...args, event: proposal.after }));
      if (proposal.kind === 'update') result = this.normalize(await this.provider.update({ ...args, event: proposal.after }));
      if (proposal.kind === 'delete') { await this.provider.delete(args); result = { source: 'google', google_event_id: proposal.google_event_id, status: 'deleted' }; }
    } catch (error) {
      proposal.status = error?.code === 'VERSION_CONFLICT' ? 'pending' : 'outcome_unknown'; this.state.save();
      if (proposal.status === 'outcome_unknown') this.markSync(owner, 'unknown');
      fail(error?.code === 'VERSION_CONFLICT' ? 409 : 503, error?.code === 'VERSION_CONFLICT' ? 'VERSION_CONFLICT' : 'GOOGLE_OUTCOME_UNKNOWN');
    }
    proposal.status = 'confirmed';
    if (proposal.kind === 'delete') delete data.events[owner]?.[proposal.google_event_id];
    else { data.events[owner] ??= {}; data.events[owner][result.google_event_id] = result; }
    const response = { proposal_id: id, status: 'confirmed', result };
    data.idempotency[slot] = { proposal_id: id, result: response }; this.state.save();
    return structuredClone(response);
  }
}

function valueForValidation(event) {
  const { title, location, notes, all_day, time_zone, start_at, end_at, start_date, end_date } = event;
  return { title, location, notes, all_day, time_zone, start_at, end_at, start_date, end_date };
}
function publicProposal(value) {
  return { proposal_id: value.proposal_id, status: value.status, kind: value.kind,
    before: value.before, after: value.after, google_event_id: value.google_event_id,
    etag: value.etag, expires_at: value.expires_at };
}
