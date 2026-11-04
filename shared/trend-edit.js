const TOPIC_WORDS = {
  restaurant: /맛집|음식|요리|식당|먹방|메뉴|디저트/u,
  cafe: /카페|커피|디저트|베이커리|브런치/u,
  travel: /여행|브이로그|풍경|바다|산책|관광/u,
};
const TOPIC_CATEGORY = { restaurant: 'food', cafe: 'cafe', travel: 'travel' };
const KEYWORDS = ['맛집', '음식', '디저트', '카페', '커피', '베이커리', '여행', '브이로그', '풍경', '바다', '산책'];
const TITLE_PATTERNS = ['브이로그', '코스', '하루', '추천', '핫플', '모음'];

/** Search metadata is evidence of topics only, never evidence of video editing technique. */
export function summarizeTrend(result, now = new Date()) {
  if (result?.status !== 'ok' || result.source !== 'youtube_data_api' || result.analysis_scope !== 'metadata_only' ||
      !Object.hasOwn(TOPIC_WORDS, result.topic) || !Array.isArray(result.items)) return null;
  const queried = Date.parse(result.period?.to ?? '');
  const from = Date.parse(result.period?.from ?? '');
  if (!Number.isFinite(queried) || !Number.isFinite(from) || queried < from || queried > now.getTime() + 60_000 ||
      now.getTime() - queried > 15 * 60_000) return null;
  const relevant = result.items.filter((item) => {
    const published = Date.parse(item?.published_at ?? '');
    return typeof item?.title === 'string' &&
      TOPIC_WORDS[result.topic].test(`${item.title} ${typeof item.description === 'string' ? item.description : ''}`) &&
      Number.isFinite(published) && published >= from && published <= queried &&
      /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(item.url ?? '');
  });
  if (!relevant.length) return null;
  const keywords = KEYWORDS.filter((word) => relevant.some((item) => `${item.title} ${typeof item.description === 'string' ? item.description : ''}`.includes(word)));
  const titlePatterns = TITLE_PATTERNS.filter((word) => relevant.some((item) => item.title.includes(word)));
  return { source: 'youtube_data_api', analysis_scope: 'metadata_only', topic: result.topic,
    queried_at: new Date(queried).toISOString(), period_days: Math.round((queried - from) / 86400000),
    keywords, title_patterns: titlePatterns, references: relevant.slice(0, 5).map((item) => ({ url: item.url, published_at: item.published_at,
      view_count: Number.isSafeInteger(item.view_count) ? item.view_count : null })) };
}

export function proposeMixedEdit(plan, generation, trend = null) {
  if (!Array.isArray(plan?.scenes) || !plan.scenes.length) return [];
  const insights = new Map((generation?.source === 'gateway' || generation?.source === 'mock' ? plan.media_insights ?? [] : [])
    .map((insight) => [insight.media_id, insight]));
  const focus = trend && TOPIC_CATEGORY[trend.topic];
  const indexed = plan.scenes.map((scene, index) => ({ scene, index, category: insights.get(scene.media_id)?.category ?? 'unknown' }));
  if (focus) {
    const first = indexed.findIndex((row) => row.category === focus);
    if (first > 0) indexed.unshift(indexed.splice(first, 1)[0]);
  }
  const total = plan.target_seconds;
  const weights = indexed.map(({ category }) => ({ food: 0.8, cafe: 1, travel: 1.2 }[category] ?? 1) * (category === focus ? 1.1 : 1));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const preserveDurations = indexed.some(({ scene }) => scene.trim_end_seconds !== undefined);
  let elapsed = 0;
  return indexed.map(({ scene, category }, index) => {
    const duration = preserveDurations ? Number((scene.end_seconds - scene.start_seconds).toFixed(2)) :
      index === indexed.length - 1 ? Number((total - elapsed).toFixed(2)) : Number((total * weights[index] / weightSum).toFixed(2));
    elapsed += duration;
    const style = category === 'food' ? 'highlight' : ['cafe', 'travel'].includes(category) ? 'emotional' :
      insights.get(scene.media_id)?.subjects?.length ? 'information' : 'basic';
    const suggested = category === 'food' ? { framing: 'fill_crop', motion: 'zoom_in', transition: 'cut', subtitle_style: 'emphasis' }
      : category === 'cafe' ? { framing: 'blur_pad', motion: 'pan_right', transition: 'fade', subtitle_style: 'default' }
        : category === 'travel' ? { framing: 'blur_pad', motion: 'zoom_in', transition: 'fade', subtitle_style: 'default' }
          : { framing: 'inherit', motion: 'static', transition: 'cut', subtitle_style: style === 'information' ? 'information' : 'default' };
    const basis = category === 'unknown' || category === 'other' ? '시각 분석 근거 없음: 기본 편집' :
      `해주미 추천: Vision ${category} 분류를 바탕으로 ${style === 'highlight' ? '하이라이트' : '감성'} 연출`;
    return { media_id: scene.media_id, duration_seconds: duration,
      ...(scene.media_type?.startsWith('video/') ? { trim_start_seconds: scene.trim_start_seconds ?? 0,
        ...(scene.trim_end_seconds === undefined ? {} : { trim_end_seconds: scene.trim_end_seconds }) } : {}),
      ...suggested, bgm_mood: scene.bgm_mood ?? '', edit_reason: basis, suggested_style: style };
  });
}
