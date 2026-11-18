import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { UPLOAD_SCOPE, CHANNEL_READ_SCOPE } from './youtube-provider.js';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const safeUpload = (row) => ({ upload_id: row.upload_id, task_id: row.task_id, publication_id: row.publication_id,
  status: row.status, channel_id: row.channel_id, content_version: row.content_version,
  made_for_kids: row.made_for_kids,
  artifact_sha256: row.artifact_sha256, video_id: row.video_id ?? null, url: row.url ?? null,
  created_at: row.created_at, completed_at: row.completed_at ?? null });

export class YouTubePublishingService {
  constructor({ state, repositories, provider = null, vault = null,
    redirectUri = 'http://127.0.0.1:8765/api/v1/publications/youtube/oauth/callback' }) {
    this.state = state; this.repositories = repositories; this.provider = provider; this.vault = vault;
    this.redirectUri = redirectUri; this.pendingOAuth = new Map(); this.uploadLocks = new Set();
    state.data.youtubePublishing ??= { connections: {}, uploads: {}, idempotency: {} };
    const data = state.data.youtubePublishing;
    for (const key of ['connections', 'uploads', 'idempotency']) data[key] ??= {};
    let changed = false;
    for (const row of Object.values(data.uploads)) if (row.status === 'uploading') { row.status = 'outcome_unknown'; changed = true; }
    if (changed) state.save();
  }
  ready() { if (!this.provider || !this.vault) fail(503, 'YOUTUBE_NOT_CONFIGURED'); }
  status(owner) {
    const row = this.state.data.youtubePublishing.connections[owner];
    const configured = Boolean(this.provider && this.vault), connected = configured && row?.status === 'connected';
    return { configured, connected, status: configured ? row?.status ?? 'disconnected' : 'unconfigured',
      channel_id: connected ? row.channel_id : null, channel_title: connected ? row.channel_title : null };
  }
  begin(owner, key = null) {
    this.ready();
    for (const [state, pending] of this.pendingOAuth) {
      if (pending.expires <= Date.now()) this.pendingOAuth.delete(state);
      else if (pending.owner === owner && key && pending.key === key) return pending.result;
    }
    for (const [state, pending] of this.pendingOAuth) if (pending.owner === owner) this.pendingOAuth.delete(state);
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const result = { authorization_url: this.provider.authorizationUrl({ state, challenge, redirectUri: this.redirectUri }), expires_in_seconds: 600 };
    this.pendingOAuth.set(state, { owner, key, verifier, expires: Date.now() + 600_000, result });
    return result;
  }
  async callback(state, code) {
    this.ready();
    const pending = this.pendingOAuth.get(state); this.pendingOAuth.delete(state);
    if (!pending || pending.expires <= Date.now() || typeof code !== 'string' || !code || code.length > 2048)
      fail(403, 'OAUTH_STATE_INVALID');
    let credential;
    try { credential = await this.provider.exchangeCode({ code, verifier: pending.verifier, redirectUri: this.redirectUri }); }
    catch { fail(503, 'OAUTH_EXCHANGE_FAILED'); }
    if (typeof credential?.access_token !== 'string' || typeof credential?.refresh_token !== 'string' ||
        !Number.isFinite(credential.expires_at) || credential.expires_at <= Date.now() ||
        !Array.isArray(credential.scopes) || !credential.scopes.includes(UPLOAD_SCOPE) ||
        !credential.scopes.includes(CHANNEL_READ_SCOPE)) fail(403, 'OAUTH_SCOPE_MISSING');
    let channel;
    try { channel = await this.provider.channel({ accessToken: credential.access_token }); }
    catch (error) {
      const code = ['YOUTUBE_CHANNEL_SIGNUP_REQUIRED', 'YOUTUBE_CHANNEL_PERMISSION_DENIED', 'YOUTUBE_CHANNEL_EMPTY', 'YOUTUBE_CHANNEL_INVALID'].includes(error?.code)
        ? error.code : 'YOUTUBE_CHANNEL_UNAVAILABLE';
      throw Object.assign(new Error(code), { code, status: code === 'YOUTUBE_CHANNEL_INVALID' ? 502 : 503,
        diagnostic: error?.diagnostic ?? { phase: 'youtube_channel_lookup', provider_http_status: null, provider_reason: null, items_count: null } });
    }
    if (!validChannel(channel)) fail(502, 'YOUTUBE_CHANNEL_INVALID');
    this.vault.set(pending.owner, credential);
    this.state.data.youtubePublishing.connections[pending.owner] = { status: 'connected',
      channel_id: channel.channel_id, channel_title: channel.channel_title, connected_at: new Date().toISOString() };
    this.state.save();
    return this.status(pending.owner);
  }
  async credential(owner) {
    this.ready();
    if (!this.status(owner).connected) fail(403, 'YOUTUBE_DISCONNECTED');
    const value = this.vault.get(owner);
    if (!value) { this.reauth(owner); fail(403, 'OAUTH_EXPIRED'); }
    if (value.expires_at > Date.now() + 30_000) return value.access_token;
    let refreshed;
    try { refreshed = await this.provider.refresh({ refreshToken: value.refresh_token }); }
    catch { this.reauth(owner); fail(403, 'OAUTH_EXPIRED'); }
    if (typeof refreshed?.access_token !== 'string' || !Number.isFinite(refreshed.expires_at) ||
        refreshed.expires_at <= Date.now()) { this.reauth(owner); fail(403, 'OAUTH_EXPIRED'); }
    this.vault.set(owner, { ...value, ...refreshed, refresh_token: refreshed.refresh_token ?? value.refresh_token,
      scopes: refreshed.scopes?.length ? refreshed.scopes : value.scopes });
    return refreshed.access_token;
  }
  reauth(owner) { this.state.data.youtubePublishing.connections[owner].status = 'reauth_required'; this.state.save(); }
  async disconnect(owner) {
    this.ready();
    for (const [state, pending] of this.pendingOAuth) if (pending.owner === owner) this.pendingOAuth.delete(state);
    const token = this.vault.get(owner)?.refresh_token;
    this.vault.delete(owner);
    this.state.data.youtubePublishing.connections[owner] = { status: 'disconnected' };
    this.state.save();
    if (token) try { await this.provider.revoke({ token }); } catch { /* Local connection stays disabled. */ }
    return this.status(owner);
  }
  list(owner, taskId, publicationId) {
    const publication = this.repositories.getPublication(owner, taskId, publicationId);
    if (!publication || publication.platform !== 'youtube') fail(404, 'RESOURCE_NOT_FOUND');
    return { items: Object.values(this.state.data.youtubePublishing.uploads)
      .filter((row) => row.owner_id === owner && row.task_id === taskId && row.publication_id === publicationId).map(safeUpload) };
  }
  async upload(owner, taskId, publicationId, key, input) {
    this.ready();
    if (typeof key !== 'string' || key.length < 16 || key.length > 200) fail(422, 'VALIDATION_ERROR');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 ||
        typeof input.made_for_kids !== 'boolean') fail(422, 'YOUTUBE_AUDIENCE_REQUIRED');
    // Check every gate immediately before dispatch, including rights and artifact bytes.
    const { bytes, approval, publication } = this.repositories.getApprovedYouTubeUpload(owner, taskId, publicationId);
    if (!['private', 'unlisted', 'public'].includes(publication.visibility)) fail(422, 'VALIDATION_ERROR');
    const hashtags = publication.hashtags.map((tag) => tag.trim().replace(/^#/, ''));
    const description = [publication.description, hashtags.map((tag) => `#${tag.replace(/\s+/g, '')}`).join(' ')].filter(Boolean).join('\n\n');
    const tagLength = hashtags.reduce((count, tag) => count + tag.length + (tag.includes(' ') ? 2 : 0), 0) + Math.max(0, hashtags.length - 1);
    if (!publication.title.trim() || Array.from(publication.title).length > 100 || /[<>]/.test(publication.title) ||
        hashtags.some((tag) => !tag || /[<>]/.test(tag)) || /[<>]/.test(description) ||
        Buffer.byteLength(description, 'utf8') > 5000 || tagLength > 500)
      fail(422, 'YOUTUBE_METADATA_INVALID');
    const connection = this.status(owner);
    if (!connection.connected) fail(403, 'YOUTUBE_DISCONNECTED');
    if (publication.account_id !== connection.channel_id) fail(409, 'YOUTUBE_CHANNEL_MISMATCH');
    const data = this.state.data.youtubePublishing;
    const semantic = [owner, approval.approval_id, approval.artifact_sha256, connection.channel_id].join(':');
    const keySlot = owner + ':youtube-upload:' + key;
    const fingerprint = `${semantic}:${input.made_for_kids}`;
    if (data.idempotency[keySlot] && data.idempotency[keySlot] !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT');
    const prior = Object.values(data.uploads).find((row) => row.semantic === semantic);
    if (prior) { data.idempotency[keySlot] = fingerprint; this.state.save(); return safeUpload(prior); }
    if (this.uploadLocks.has(semantic)) fail(409, 'YOUTUBE_UPLOAD_IN_PROGRESS');
    this.uploadLocks.add(semantic);
    try {
      const accessToken = await this.credential(owner);
      let channel;
      try { channel = await this.provider.channel({ accessToken }); }
      catch { fail(503, 'YOUTUBE_CHANNEL_UNAVAILABLE'); }
      if (!validChannel(channel) || channel.channel_id !== connection.channel_id) fail(409, 'YOUTUBE_CHANNEL_MISMATCH');
      const row = { upload_id: randomUUID(), owner_id: owner, task_id: taskId, publication_id: publicationId,
        semantic, channel_id: connection.channel_id, content_version: approval.content_version,
        made_for_kids: input.made_for_kids,
        artifact_sha256: approval.artifact_sha256, status: 'uploading', created_at: new Date().toISOString() };
      data.uploads[row.upload_id] = row; data.idempotency[keySlot] = fingerprint; this.state.save();
      try {
        const result = await this.provider.upload({ accessToken, bytes, title: publication.title,
          description, hashtags, visibility: publication.visibility, madeForKids: input.made_for_kids });
        if (typeof result?.video_id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(result.video_id)) throw new Error('Invalid upload result');
        row.status = 'succeeded'; row.video_id = result.video_id;
        row.url = `https://www.youtube.com/watch?v=${result.video_id}`; row.completed_at = new Date().toISOString();
        this.state.save(); return safeUpload(row);
      } catch {
        row.status = 'outcome_unknown'; this.state.save(); fail(503, 'YOUTUBE_OUTCOME_UNKNOWN');
      }
    } finally {
      this.uploadLocks.delete(semantic);
    }
  }
}

function validChannel(value) {
  return value && typeof value.channel_id === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(value.channel_id) &&
    typeof value.channel_title === 'string' && value.channel_title.length > 0 && value.channel_title.length <= 200;
}
