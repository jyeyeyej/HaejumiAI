// Test-only provider. The production server never constructs this class.
export class MockGoogleCalendar {
  constructor() { this.accounts = new Map(); this.calls = []; this.failNext = null; }
  authorizationUrl({ state, challenge, redirectUri, scope }) {
    const url = new URL('https://calendar-mock.invalid/authorize');
    url.searchParams.set('state', state); url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256'); url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', scope); return url.toString();
  }
  async exchangeCode({ code, verifier, redirectUri }) {
    this.calls.push('exchange'); this.maybeFail();
    if (!code.startsWith('mock:') || !verifier || !redirectUri.startsWith('http://127.0.0.1:')) throw new Error('mock oauth denied');
    const owner = code.slice(5);
    if (!this.accounts.has(owner)) this.accounts.set(owner, new Map());
    return { access_token: 'mock-access-' + owner, refresh_token: 'mock-refresh-' + owner,
      expires_at: Date.now() + 3600_000, scopes: ['https://www.googleapis.com/auth/calendar.events.owned'] };
  }
  async refresh({ refreshToken }) {
    this.calls.push('refresh'); this.maybeFail();
    if (!refreshToken.startsWith('mock-refresh-')) throw new Error('mock token expired');
    return { access_token: 'mock-access-' + refreshToken.slice(13), expires_at: Date.now() + 3600_000 };
  }
  async revoke() { this.calls.push('revoke'); this.maybeFail(); }
  account(token) {
    if (!token?.startsWith('mock-access-')) throw new Error('mock auth');
    const events = this.accounts.get(token.slice(12));
    if (!events) throw new Error('mock auth');
    return events;
  }
  maybeFail() { if (this.failNext) { const error = this.failNext; this.failNext = null; throw error; } }
  async list({ token, calendarId, from, to, q }) {
    this.calls.push('list'); this.maybeFail(); this.calendar(calendarId);
    return [...this.account(token).values()].filter((event) => {
      const start = event.all_day ? event.start_date : event.start_at.slice(0, 10);
      return start >= from && start <= to && (!q || [event.title, event.location, event.notes].join(' ').includes(q));
    }).map((event) => structuredClone(event));
  }
  async get({ token, calendarId, id }) {
    this.calls.push('get'); this.maybeFail(); this.calendar(calendarId);
    return structuredClone(this.account(token).get(id) ?? null);
  }
  async insert({ token, calendarId, id, event }) {
    this.calls.push('insert'); this.maybeFail(); this.calendar(calendarId);
    const rows = this.account(token);
    if (rows.has(id)) throw Object.assign(new Error('duplicate'), { code: 'VERSION_CONFLICT' });
    const saved = { ...structuredClone(event), google_event_id: id, calendar_id: calendarId, etag: 'mock-1' };
    rows.set(id, saved); return structuredClone(saved);
  }
  async update({ token, calendarId, id, etag, event }) {
    this.calls.push('update'); this.maybeFail(); this.calendar(calendarId);
    const rows = this.account(token), prior = rows.get(id);
    if (!prior || prior.etag !== etag) throw Object.assign(new Error('conflict'), { code: 'VERSION_CONFLICT' });
    const saved = { ...structuredClone(event), google_event_id: id, calendar_id: calendarId,
      etag: 'mock-' + (Number(prior.etag.slice(5)) + 1) };
    rows.set(id, saved); return structuredClone(saved);
  }
  async delete({ token, calendarId, id, etag }) {
    this.calls.push('delete'); this.maybeFail(); this.calendar(calendarId);
    const rows = this.account(token), prior = rows.get(id);
    if (!prior || prior.etag !== etag) throw Object.assign(new Error('conflict'), { code: 'VERSION_CONFLICT' });
    rows.delete(id);
  }
  calendar(id) { if (id !== 'primary') throw new Error('mock scope violation'); }
  changeDirectly(owner, id, patch) {
    const rows = this.accounts.get(owner), prior = rows?.get(id);
    if (!prior) throw new Error('mock event missing');
    rows.set(id, { ...prior, ...patch, etag: 'mock-' + (Number(prior.etag.slice(5)) + 1) });
  }
}
