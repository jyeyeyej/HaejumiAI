const PLATFORMS = ['youtube', 'tiktok', 'instagram'];
const CATEGORY_LABELS = { food: '음식', cafe: '카페', travel: '여행 풍경' };
const CATEGORY_TAGS = { food: ['음식', '푸드영상'], cafe: ['카페', '카페영상'], travel: ['여행', '여행브이로그'] };
const INSTRUCTION = /(?:해줘|해주세요|제안|분석|기획|편집|프롬프트|장면\s*\d+|소개합니다|참고해|만들어|스타일로|자막을)/u;
const UNSUPPORTED = /(?:맛있|방문했|추천해요|평점|가격|\d[\d,]*\s*원)/u;

export function publicationDraftsFromPlan(plan, generation) {
  if (generation?.source !== 'gateway' && generation?.source !== 'mock') return blankDrafts();
  const insights = Array.isArray(plan?.media_insights) ? plan.media_insights.filter((item) => item && CATEGORY_LABELS[item.category] &&
    item.uncertainty !== '외부 AI 분석 없음') : [];
  if (!insights.length) return blankDrafts();
  const categories = [...new Set(insights.map((item) => item.category))];
  const subjects = [...new Set(insights.flatMap((item) => Array.isArray(item.subjects) ? item.subjects : [])
    .map((item) => typeof item === 'string' ? item.trim() : '').filter((item) => item.length > 0 && item.length <= 16 &&
      /^[가-힣A-Za-z0-9 ]+$/u.test(item) && !INSTRUCTION.test(item) && !UNSUPPORTED.test(item)))].slice(0, 2);
  const label = categories.length > 1 ? categories.map((item) => CATEGORY_LABELS[item]).join('·') : CATEGORY_LABELS[categories[0]];
  const focus = subjects.length ? subjects.join('·') : label;
  const topic = focus.length > 28 ? label : focus;
  const baseTags = [...new Set([...categories.flatMap((item) => CATEGORY_TAGS[item]),
    ...subjects.map((item) => item.replaceAll(' ', '')).filter((item) => item.length <= 12)])].slice(0, 8);
  return PLATFORMS.map((platform) => {
    const platformTag = { youtube: 'Shorts', tiktok: 'TikTok', instagram: 'Reels' }[platform];
    const title = { youtube: `${topic} | 짧은 기록`, tiktok: `${topic}, 짧은 순간`, instagram: `${topic}의 순간들` }[platform];
    const description = { youtube: `${focus} 장면을 짧은 영상으로 엮었습니다.`, tiktok: `${focus} 장면을 짧게 이어 봅니다.`,
      instagram: `${focus} 순간들을 모았습니다.` }[platform];
    return { platform, title, description, hashtags: [...new Set([...baseTags, platformTag])] };
  });
}

function blankDrafts() { return PLATFORMS.map((platform) => ({ platform, title: '', description: '', hashtags: [] })); }
