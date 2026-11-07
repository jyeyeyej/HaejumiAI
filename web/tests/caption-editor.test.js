import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicationDraftsFromPlan } from '../../shared/publication-drafts.js';
import { proposeBasicEdit, proposeMixedEdit, hasVisibleEditDifference, summarizeTrend } from '../../shared/trend-edit.js';

test('caption editor keeps full-width multiline text and paired times with compact actions', () => {
  const jsx = readFileSync(new URL('../src/ui/CreatorWorkspace.jsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/caption-editor.css', import.meta.url), 'utf8');
  assert.match(jsx, /className="caption-text-label">영상 자막<textarea rows="3"/);
  assert.match(jsx, /className="caption-time-grid"/);
  assert.match(jsx, /className="caption-small-button"|className="secondary caption-small-button"/);
  assert.match(css, /\.caption-text-label textarea\{[^}]*width:100%/);
  assert.match(css, /\.caption-time-grid\{[^}]*repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(max-width:480px\)/);
  assert.match(jsx, /src=\{`\/api\/v1\/media\/\$\{scene\.media_id\}\/image-preview`\}/);
  assert.match(jsx, /row\.caption_source === 'vision'.*'Vision 제안'.*'기존 자막'/);
  assert.match(jsx, /\(!row\.media_id \|\| row\.media_id === item\.media_id\)/);
  assert.match(jsx, /function changeCaption\(index, text\)/);
  assert.match(jsx, /function changeTime\(index, field, value\)/);
  assert.match(jsx, /api\.updateDraft\(taskId, body/);
  assert.match(jsx, /row\.caption_basis\?\.insight_description/);
  assert.match(jsx, /row\.caption_review_reason === 'visual_fact_unverified'/);
  assert.match(jsx, /기존 자막은 사진별 분석 근거와 생성 출처가 기록되지 않았습니다/);
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
  assert.match(jsx, /해주미의 효과는 자체 추천/);
  assert.match(jsx, /참고 영상 URL 추가/);
  assert.match(jsx, /참고 영상 직접 업로드/);
  assert.match(jsx, /메타데이터 기반 참고/);
  assert.match(jsx, /요청 내용으로 최근 영상 자동 참고/);
  assert.doesNotMatch(jsx, /최근 영상 찾기/);
  assert.match(jsx, /role="tablist"/);
  assert.match(jsx, /sessionStorage\.setItem\(draftKey/);
  assert.match(jsx, /쇼츠 기획안 생성/);
  assert.doesNotMatch(jsx, /이 주제를 기획 요청에 반영/);
  assert.match(jsx, /트렌드 혼합 편집 적용/);
  assert.match(jsx, /기본 효과 적용/);
  assert.match(jsx, /아직 영상에 반영되지 않았습니다/);
  assert.match(jsx, /렌더 적용: 화면 배치·움직임·전환·색감/);
  const plan = { target_seconds: 6, scenes: [{ media_id: 'synthetic', media_type: 'image/jpeg', start_seconds: 0, end_seconds: 6 }] };
  assert.equal(summarizeTrend({ status: 'unavailable', reason: 'API_LIMITED' }), null);
  assert.equal(hasVisibleEditDifference(proposeBasicEdit(plan), proposeMixedEdit(plan, { source: 'local_rules' })), false);
});
