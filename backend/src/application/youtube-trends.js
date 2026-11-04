const TOPICS = Object.freeze({ restaurant: '맛집 쇼츠', cafe: '카페 릴스', travel: '여행 브이로그 쇼츠' });
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Official YouTube Data API metadata only. Never downloads, embeds or analyzes reference video/audio. */
export class YouTubeTrends {
  constructor({ apiKey = '', enabled = false, fetchImpl = globalThis.fetch, now = () => new Date(), timeoutMs = 8000,
    cacheTtlMs = 15 * 60_000 } = {}) {
    this.apiKey = apiKey; this.enabled = enabled === true && Boolean(apiKey); this.fetchImpl = fetchImpl; this.now = now;
    this.timeoutMs = timeoutMs; this.cacheTtlMs = cacheTtlMs; this.cache = new Map();
  }

  getCached({ topic, days = 30 }) {
    const entry = this.cache.get(`${topic}:${days}`);
    if (!entry) return null;
    if (entry.expiresAt <= this.now().getTime()) { this.cache.delete(`${topic}:${days}`); return null; }
    return structuredClone(entry.result);
  }

  async search({ topic, days = 30 }) {
    if (!Object.hasOwn(TOPICS, topic) || !Number.isInteger(days) || days < 1 || days > 90) throw new Error('INVALID_TREND_QUERY');
    const period = { from: new Date(this.now().getTime() - days * 86400000).toISOString(), to: this.now().toISOString() };
    if (!this.enabled) return { status: 'unavailable', reason: 'API_NOT_ENABLED', source: 'local_fallback', topic, period,
      analysis_scope: 'none', items: [], suggestion: '최신 영상 메타데이터를 조회하지 않았습니다. 로컬 장면 효과를 직접 검토해 주세요.' };
    const cached = this.getCached({ topic, days });
    if (cached) return cached;
    try {
      const search = await this.get('search', { part: 'snippet', type: 'video', q: TOPICS[topic], order: 'viewCount',
        videoDuration: 'short', publishedAfter: period.from, maxResults: '20', regionCode: 'KR', relevanceLanguage: 'ko' });
      const ids = (search.items ?? []).map((item) => item?.id?.videoId).filter((id) => VIDEO_ID.test(id)).slice(0, 20);
      if (!ids.length) return this.remember(topic, days, { status: 'ok', source: 'youtube_data_api', topic, period, analysis_scope: 'metadata_only', items: [] });
      const details = await this.get('videos', { part: 'snippet,statistics,contentDetails', id: ids.join(',') });
      const items = (details.items ?? []).filter((item) => VIDEO_ID.test(item.id) && shortSeconds(item.contentDetails?.duration) <= 59)
        .map((item) => ({ video_id: item.id, url: `https://www.youtube.com/watch?v=${item.id}`, title: safeText(item.snippet?.title, 200),
          description: safeText(item.snippet?.description, 500),
          published_at: item.snippet?.publishedAt ?? null, view_count: safeCount(item.statistics?.viewCount),
          like_count: safeCount(item.statistics?.likeCount), comment_count: safeCount(item.statistics?.commentCount),
          duration_seconds: shortSeconds(item.contentDetails?.duration), analysis_scope: 'metadata_only' }));
      return this.remember(topic, days, { status: 'ok', source: 'youtube_data_api', topic, period, analysis_scope: 'metadata_only', items });
    } catch (error) {
      return { status: 'unavailable', reason: error?.code === 'API_LIMITED' ? 'API_LIMITED' : 'API_UNAVAILABLE',
        source: 'local_fallback', topic, period, analysis_scope: 'none', items: [],
        suggestion: '트렌드 메타데이터를 조회하지 못했습니다. 로컬 편집 효과를 사용할 수 있습니다.' };
    }
  }

  remember(topic, days, result) {
    this.cache.set(`${topic}:${days}`, { expiresAt: this.now().getTime() + this.cacheTtlMs, result: structuredClone(result) });
    return result;
  }

  async get(resource, params) {
    const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    url.searchParams.set('key', this.apiKey);
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { method: 'GET', signal: abort.signal, redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw Object.assign(new Error('YouTube API unavailable'), { code: [403, 429].includes(response.status) ? 'API_LIMITED' : 'API_UNAVAILABLE' });
      const data = await response.json();
      if (!data || !Array.isArray(data.items)) throw new Error('Invalid YouTube response');
      return data;
    } finally { clearTimeout(timer); }
  }
}

function shortSeconds(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value ?? '');
  return match ? Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) : Infinity;
}
function safeCount(value) { return /^\d+$/.test(String(value ?? '')) ? Number(value) : null; }
function safeText(value, max) { return typeof value === 'string' ? value.slice(0, max) : ''; }
