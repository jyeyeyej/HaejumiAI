import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicationDraftsFromPlan } from '../../shared/publication-drafts.js';
import { proposeMixedEdit, summarizeTrend } from '../../shared/trend-edit.js';

test('caption editor keeps full-width multiline text and paired times with compact actions', () => {
  const jsx = readFileSync(new URL('../src/ui/CreatorWorkspace.jsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/caption-editor.css', import.meta.url), 'utf8');
  assert.match(jsx, /className="caption-text-label">영상 자막<textarea rows="3"/);
  assert.match(jsx, /className="caption-time-grid"/);
  assert.match(jsx, /className="caption-small-button"|className="secondary caption-small-button"/);
  assert.match(css, /\.caption-text-label textarea\{[^}]*width:100%/);
  assert.match(css, /\.caption-time-grid\{[^}]*repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(max-width:480px\)/);
});

test('legacy local plan cannot copy a planning instruction into publication title', () => {
  const drafts = publicationDraftsFromPlan({ title_idea: '여행 분위기를 참고해 장면별 효과를 제안해 주세요',
    publication_suggestions: [{ platform: 'youtube', title: '여행 분위기를 참고해 장면별 효과를 제안해 주세요' }] }, { source: 'local_rules' });
  assert.equal(drafts[0].title, '');
  assert.equal(drafts[0].description, '');
});

test('trend edit controls show separate evidence and local recommendations with a reset action', () => {
  const jsx = readFileSync(new URL('../src/ui/CreatorWorkspace.jsx', import.meta.url), 'utf8');
  assert.match(jsx, /검색에서 확인된 사실/);
  assert.match(jsx, /해주미의 장면 효과는 Vision 분류를 바탕으로 한 자체 추천/);
  assert.match(jsx, /장면별 자동 혼합 편집 제안/);
  assert.match(jsx, /현재 기획의 기본 편집으로 되돌리기/);
  const plan = { target_seconds: 6, scenes: [{ media_id: 'synthetic', media_type: 'image/jpeg', start_seconds: 0, end_seconds: 6 }] };
  assert.equal(summarizeTrend({ status: 'unavailable', reason: 'API_LIMITED' }), null);
  assert.equal(proposeMixedEdit(plan, { source: 'local_rules' })[0].motion, 'static');
});
