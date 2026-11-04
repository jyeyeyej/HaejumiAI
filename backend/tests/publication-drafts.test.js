import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationDraftsFromPlan } from '../../shared/publication-drafts.js';

test('local or unverified plans leave publication fields for user review', () => {
  const plan = { title_idea: '여행 분위기를 참고해 장면별 효과를 제안해 주세요', media_insights: [{ category: 'unknown', subjects: [] }] };
  const local = publicationDraftsFromPlan(plan, { source: 'local_rules' });
  assert.deepEqual(local.map(({ title, description, hashtags }) => ({ title, description, hashtags })),
    Array.from({ length: 3 }, () => ({ title: '', description: '', hashtags: [] })));
  assert.equal(publicationDraftsFromPlan(plan, { source: 'gateway' })[0].title, '');
});

test('Vision food, cafe and travel insights yield distinct safe platform drafts without instruction leakage', () => {
  const plan = { title_idea: '요즘 유행하는 맛집 릴스처럼 만들어줘', publication_suggestions: [
    { platform: 'youtube', title: '장면별 효과를 제안해 주세요', description: '선택한 사진과 영상으로 만든 쇼츠입니다.', hashtags: ['쇼츠'] }],
    media_insights: [
      { category: 'food', subjects: ['접시', '접시'], uncertainty: '' },
      { category: 'cafe', subjects: ['커피'], uncertainty: '' },
      { category: 'travel', subjects: ['풍경', '장면별 효과를 제안해 주세요'], uncertainty: '' },
    ] };
  const drafts = publicationDraftsFromPlan(plan, { source: 'gateway' });
  assert.deepEqual(drafts.map((item) => item.platform), ['youtube', 'tiktok', 'instagram']);
  assert.equal(new Set(drafts.map((item) => item.title)).size, 3);
  for (const item of drafts) {
    assert.ok(item.title && item.description && item.hashtags.length);
    assert.equal(new Set(item.hashtags).size, item.hashtags.length);
    assert.doesNotMatch(`${item.title} ${item.description} ${item.hashtags.join(' ')}`, /만들어줘|제안해 주세요|선택한 사진과 영상|맛있|가격|방문했/u);
  }
  assert.ok(drafts[0].hashtags.includes('음식'));
  assert.ok(drafts[0].hashtags.includes('여행'));
  assert.ok(drafts[1].hashtags.includes('TikTok'));
});
