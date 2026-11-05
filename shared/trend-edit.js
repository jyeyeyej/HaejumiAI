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
  const weights = indexed.map(({ category }) => ({ food: 0.65, cafe: 1, travel: 1.3 }[category] ?? 1) * (category === focus ? 1.1 : 1));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const preserveDurations = indexed.some(({ scene }) => scene.trim_end_seconds !== undefined);
  let elapsed = 0;
  return indexed.map(({ scene, category }, index) => {
    const duration = preserveDurations ? Number((scene.end_seconds - scene.start_seconds).toFixed(2)) :
      index === indexed.length - 1 ? Number((total - elapsed).toFixed(2)) : Number((total * weights[index] / weightSum).toFixed(2));
    elapsed += duration;
    const style = category === 'food' ? 'highlight' : ['cafe', 'travel'].includes(category) ? 'emotional' :
      insights.get(scene.media_id)?.subjects?.length ? 'information' : 'basic';
    const suggested = category === 'food' ? { framing: 'fill_crop', motion: 'zoom_in', transition: 'cut', subtitle_style: 'emphasis', edit_style: 'food_pop' }
      : category === 'cafe' ? { framing: 'blur_pad', motion: 'pan_right', transition: 'fade', subtitle_style: 'default', edit_style: 'cafe_soft' }
        : category === 'travel' ? { framing: 'blur_pad', motion: 'zoom_in', transition: 'fade', subtitle_style: 'default', edit_style: 'travel_warm' }
          : { framing: 'inherit', motion: 'static', transition: 'cut', subtitle_style: style === 'information' ? 'information' : 'default', edit_style: style === 'information' ? 'information' : 'basic' };
    const basis = category === 'unknown' || category === 'other' ? '시각 분석 근거 없음: 기본 편집' :
      `해주미 추천: Vision ${category} 분류를 바탕으로 ${style === 'highlight' ? '하이라이트' : '감성'} 연출`;
    return { media_id: scene.media_id, duration_seconds: duration,
      ...(scene.media_type?.startsWith('video/') ? { trim_start_seconds: scene.trim_start_seconds ?? 0,
        ...(scene.trim_end_seconds === undefined ? {} : { trim_end_seconds: scene.trim_end_seconds }) } : {}),
      ...suggested, bgm_mood: scene.bgm_mood ?? '', edit_reason: basis, suggested_style: style };
  });
}

/** Only a locally inspected video or the user's own words can influence edit effects. */
export function proposeReferenceEdit(plan, generation, trend = null, references = []) {
  const rows = proposeMixedEdit(plan, generation, trend);
  const uploaded = references.find((item) => item.analysis_scope === 'local_video_sample');
  const userWords = references.map((item) => item.note ?? '').join(' ');
  const pace = uploaded?.analysis?.pace ?? 'unknown';
  const fast = pace === 'fast' || /빠르|하이라이트|역동/u.test(userWords);
  const soft = pace === 'slow' || /감성|부드럽|차분/u.test(userWords);
  if (!fast && !soft) return rows;
  const known = new Set((generation?.source === 'gateway' || generation?.source === 'mock' ? plan?.media_insights ?? [] : [])
    .filter((item) => ['food', 'cafe', 'travel'].includes(item.category)).map((item) => item.media_id));
  return rows.map((row) => known.has(row.media_id) ? row : {
    ...row, framing: fast ? 'fill_crop' : 'blur_pad', motion: fast ? 'zoom_in' : 'pan_right',
    transition: fast ? 'cut' : 'fade', subtitle_style: fast ? 'emphasis' : 'default',
    edit_style: fast ? 'food_pop' : 'travel_warm', suggested_style: fast ? 'highlight' : 'emotional',
    edit_reason: uploaded && pace !== 'unknown' ? `로컬 참고 영상의 화면 변화 샘플에서 ${pace === 'fast' ? '빠른' : '느린'} 전개가 관찰되어 해주미가 제안한 효과` :
      `사용자가 설명한 ${fast ? '빠른' : '부드러운'} 분위기에 맞춘 해주미 효과`,
  });
}

/** A visual baseline for comparing the same current media and scene lengths. */
export function proposeBasicEdit(plan) {
  if (!Array.isArray(plan?.scenes)) return [];
  return plan.scenes.map((scene) => ({ media_id: scene.media_id,
    duration_seconds: Number((scene.end_seconds - scene.start_seconds).toFixed(2)),
    ...(scene.media_type?.startsWith('video/') ? { trim_start_seconds: scene.trim_start_seconds ?? 0,
      ...(scene.trim_end_seconds === undefined ? {} : { trim_end_seconds: scene.trim_end_seconds }) } : {}),
    framing: 'inherit', motion: 'static', transition: 'cut', subtitle_style: 'default', edit_style: 'basic',
    bgm_mood: '', edit_reason: '기본 편집', suggested_style: 'basic' }));
}

export function hasVisibleEditDifference(left, right) {
  const renderFields = ['media_id', 'duration_seconds', 'trim_start_seconds', 'trim_end_seconds', 'framing', 'motion', 'transition', 'subtitle_style', 'edit_style'];
  const signature = (rows) => JSON.stringify(rows.map((row) => renderFields.map((field) => row[field] ?? null)));
  return Array.isArray(left) && Array.isArray(right) && signature(left) !== signature(right);
}
