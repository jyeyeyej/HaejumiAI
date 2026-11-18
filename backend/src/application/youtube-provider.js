const UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const CHANNEL_READ_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

/** Network adapter. Constructed only when YouTube publishing is explicitly enabled. */
export class YouTubeProvider {
  constructor({ clientId, clientSecret, fetcher = globalThis.fetch }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetcher = fetcher;
  }

  authorizationUrl({ state, challenge, redirectUri }) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for (const [key, value] of Object.entries({ client_id: this.clientId, redirect_uri: redirectUri,
      response_type: 'code', scope: `${UPLOAD_SCOPE} ${CHANNEL_READ_SCOPE}`, access_type: 'offline', prompt: 'consent',
      state, code_challenge: challenge, code_challenge_method: 'S256' })) url.searchParams.set(key, value);
    return url.toString();
  }

  async token(body) {
    const response = await this.fetcher('https://oauth2.googleapis.com/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...body, client_id: this.clientId, client_secret: this.clientSecret }),
      signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error('GOOGLE_TOKEN_ERROR');
    const result = await response.json();
    if (typeof result.access_token !== 'string' || !Number.isFinite(result.expires_in)) throw new Error('GOOGLE_TOKEN_INVALID');
    return { access_token: result.access_token, refresh_token: result.refresh_token,
      expires_at: Date.now() + result.expires_in * 1000,
      scopes: typeof result.scope === 'string' ? result.scope.split(' ') : [] };
  }
  exchangeCode({ code, verifier, redirectUri }) {
    return this.token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri });
  }
  refresh({ refreshToken }) { return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken }); }
  async revoke({ token }) {
    const response = await this.fetcher('https://oauth2.googleapis.com/revoke', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error('GOOGLE_REVOKE_ERROR');
  }
  async channel({ accessToken }) {
    let response;
    try { response = await this.fetcher('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
      headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) }); }
    catch { throw channelError('YOUTUBE_CHANNEL_UNAVAILABLE'); }
    let result;
    try { result = await response.json(); } catch { throw channelError('YOUTUBE_CHANNEL_INVALID', response.status); }
    if (!response.ok) {
      const reason = result?.error?.errors?.[0]?.reason;
      const safeReason = ['youtubeSignupRequired', 'insufficientPermissions'].includes(reason) ? reason : 'other';
      const code = response.status === 401 && safeReason === 'youtubeSignupRequired' ? 'YOUTUBE_CHANNEL_SIGNUP_REQUIRED' :
        response.status === 403 && safeReason === 'insufficientPermissions' ? 'YOUTUBE_CHANNEL_PERMISSION_DENIED' : 'YOUTUBE_CHANNEL_UNAVAILABLE';
      throw channelError(code, response.status, safeReason);
    }
    if (!Array.isArray(result?.items)) throw channelError('YOUTUBE_CHANNEL_INVALID', response.status);
    if (result.items.length === 0) throw channelError('YOUTUBE_CHANNEL_EMPTY', response.status, null, 0);
    if (result.items.length !== 1 || typeof result.items[0].id !== 'string' ||
        typeof result.items[0].snippet?.title !== 'string') throw channelError('YOUTUBE_CHANNEL_INVALID', response.status, null, result.items.length);
    return { channel_id: result.items[0].id, channel_title: result.items[0].snippet.title };
  }
  async upload({ accessToken, bytes, title, description, hashtags, visibility, madeForKids }) {
    const url = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
    const init = await this.fetcher(url, { method: 'POST', headers: {
      Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(bytes.length), 'X-Upload-Content-Type': 'video/mp4' },
    body: JSON.stringify({ snippet: { title, description, tags: hashtags, categoryId: '22' },
      status: { privacyStatus: visibility, selfDeclaredMadeForKids: madeForKids } }), signal: AbortSignal.timeout(30_000) });
    if (!init.ok) throw new Error('YOUTUBE_UPLOAD_INIT_FAILED');
    const session = init.headers.get('location');
    if (!session || !session.startsWith('https://www.googleapis.com/upload/youtube/v3/videos?')) throw new Error('YOUTUBE_UPLOAD_SESSION_INVALID');
    // Never log or persist the resumable session URI; an uncertain result blocks a new upload.
    const response = await this.fetcher(session, { method: 'PUT', headers: {
      Authorization: `Bearer ${accessToken}`, 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) },
    body: bytes, signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error('YOUTUBE_UPLOAD_OUTCOME_UNKNOWN');
    const result = await response.json();
    if (typeof result.id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(result.id)) throw new Error('YOUTUBE_UPLOAD_RESULT_INVALID');
    return { video_id: result.id, url: `https://www.youtube.com/watch?v=${result.id}` };
  }
}

export { UPLOAD_SCOPE, CHANNEL_READ_SCOPE };

function channelError(code, httpStatus = null, reason = null, itemsCount = null) {
  return Object.assign(new Error(code), { code, diagnostic: { phase: 'youtube_channel_lookup',
    provider_http_status: Number.isInteger(httpStatus) ? httpStatus : null,
    provider_reason: reason, items_count: Number.isInteger(itemsCount) ? itemsCount : null } });
}
