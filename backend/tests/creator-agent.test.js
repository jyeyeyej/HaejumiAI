import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorAgent } from '../src/agents/creator-agent.js';
import { buildAss } from '../src/media-engine/ffmpeg-renderer.js';
import { validCaptionTimeline } from '../src/media-engine/caption-timeline.js';

test('30-second scene timeline supports two short captions and a silent scene', () => {
  const scenes = [
    { start_seconds: 0, end_seconds: 7, subtitle_style: 'emphasis' },
    { start_seconds: 7, end_seconds: 16, subtitle_style: 'information' },
    { start_seconds: 16, end_seconds: 30, subtitle_style: 'default' },
  ];
  const captions = [
    { order: 1, start_seconds: 0.5, end_seconds: 2.5, text: '어느 길로 갈까요?' },
    { order: 2, start_seconds: 3, end_seconds: 6.5, text: '천천히 풍경을 따라갑니다' },
    { order: 3, start_seconds: 17, end_seconds: 21, text: '잠시 머무는 순간' },
  ];
  assert.equal(validCaptionTimeline(captions, scenes, 30), true);
  const ass = buildAss(captions, 30, scenes);
  assert.match(ass, /0:00:00\.50,0:00:02\.50,Emphasis/);
  assert.match(ass, /0:00:17\.00,0:00:21\.00,Default/);
  assert.equal((ass.match(/Dialogue:/g) ?? []).length, 3);
  assert.equal(validCaptionTimeline([{ ...captions[0], text: '여행 분위기를 참고해 장면별 효과를 제안해 주세요' }], scenes, 30), false);
  assert.equal(validCaptionTimeline([{ ...captions[0], text: '장면 1을 소개합니다' }], scenes, 30), false);
  assert.equal(validCaptionTimeline([{ ...captions[0], end_seconds: 8 }], scenes, 30), false);
  const longKorean = '창밖으로 펼쳐지는 풍경을 천천히 바라보며 오늘의 순간을 남깁니다';
  const wrapped = buildAss([{ order: 1, start_seconds: 17, end_seconds: 29, text: longKorean }], 30, scenes);
  assert.match(wrapped, /\\N/u);
});

test('Creator local fallback fits every selected media item into short target durations', async () => {
  let gatewayCalls = 0;
  const agent = new CreatorAgent({ gateway: { async generate() { gatewayCalls += 1; return { available: false, reason: 'llm_disabled', usage: { calls_for_task: 0, estimated_cost_usd: 0 } }; } } });
  const media = Array.from({ length: 8 }, (_, index) => ({ mediaId: `media-${index}`, mediaType: 'image/png', imageDataUrl: 'data:image/jpeg;base64,dGVzdA==' }));
  const result = await agent.createPlan({ taskId: 'task', project: { target_seconds: 3 }, media, requestText: '짧은 쇼츠를 만들어줘' });
  assert.equal(result.plan.scenes.length, 8);
  assert.equal(result.captions.length, 0);
  assert.equal(result.plan.scenes.every((scene) => scene.caption_text === ''), true);
  assert.equal(result.plan.scenes.every((scene) => scene.end_seconds > scene.start_seconds), true);
  assert.equal(result.plan.scenes[0].start_seconds, 0);
  assert.equal(result.plan.scenes.at(-1).end_seconds, 3);
  assert.equal(result.generation.source, 'local_rules');
  assert.equal(result.generation.fallback_used, true);
  assert.equal(gatewayCalls, 0);
  assert.equal(result.generation.gate_reason, 'llm_disabled');
  assert.equal(result.captions.some((caption) => /장면\s*\d+을 소개합니다/.test(caption.text)), false);
});

test('Creator does not call the LLM when local image preparation produced no selected visual input', async () => {
  let gatewayCalls = 0;
  const agent = new CreatorAgent({ gateway: { enabled: true, provider: {}, async generate() { gatewayCalls += 1; return { available: true, output: {} }; } } });
  const result = await agent.createPlan({ ownerId: 'owner', taskId: 'task', project: { target_seconds: 30 }, requestText: '사진으로 쇼츠',
    privacyConsentId: 'consent', media: [{ mediaId: 'selected', mediaType: 'image/jpeg' }] });
  assert.equal(gatewayCalls, 0);
  assert.equal(result.generation.gate_reason, 'LOCAL_MEDIA_PREPARATION_UNAVAILABLE');
});

test('Vision budget denial and invalid output remain labeled local empty drafts', async () => {
  const input = { ownerId: 'owner', taskId: 'task', project: { target_seconds: 8 }, requestText: '여행 쇼츠',
    privacyConsentId: 'synthetic-consent', media: [{ mediaId: 'selected', mediaType: 'image/jpeg', imageDataUrl: 'data:image/jpeg;base64,c3ludGhldGlj' }] };
  let providerCalls = 0;
  const blocked = await new CreatorAgent({ gateway: { enabled: true, provider: { mode: 'mock' }, generate: async () =>
    ({ available: false, reason: 'LLM_BUDGET_EXCEEDED', usage: { calls_for_task: 0, estimated_cost_usd: 0 } }) } }).createPlan(input);
  assert.equal(blocked.generation.source, 'local_rules');
  assert.equal(blocked.generation.gate_reason, 'LLM_BUDGET_EXCEEDED');
  assert.equal(blocked.generation.llm_calls, 0);
  assert.deepEqual(blocked.captions, []);
  const invalid = await new CreatorAgent({ gateway: { enabled: true, provider: { mode: 'mock' }, generate: async () => {
    providerCalls += 1;
    return { available: true, output: { plan: { scenes: [] }, captions: [] }, usage: { calls_for_task: 1, estimated_cost_usd: 0.01 } };
  } } }).createPlan(input);
  assert.equal(providerCalls, 1);
  assert.equal(invalid.generation.source, 'local_rules');
  assert.equal(invalid.generation.gate_reason, 'INVALID_MODEL_OUTPUT');
  assert.equal(invalid.generation.validation_field, 'SCENES_MEDIA_MISMATCH');
  assert.deepEqual(invalid.captions, []);
});

test('Creator accepts labeled photo/video Mock insights and rejects template captions or unsupported output', async () => {
  const media = [{ mediaId: 'photo', mediaType: 'image/jpeg', imageDataUrl: 'data:image/jpeg;base64,cGhvdG8=' },
    { mediaId: 'clip', mediaType: 'video/mp4', imageDataUrl: 'data:image/jpeg;base64,ZnJhbWU=' }];
  const output = { plan: { title_idea: '작은 여행', format: 'vertical_short', aspect_ratio: '9:16', target_seconds: 8,
    theme: '짧은 여행', opening_hook: '어디로 가볼까요?', story_flow: '길에서 풍경으로 이어집니다.', mood: '차분함', ending_line: '다음 길에서 만나요',
    recommended_media_order: ['clip', 'photo'],
    media_insights: [
      { media_id: 'photo', description: '길이 보입니다.', mood: '차분함', subjects: ['길'], usable_detail: '길의 선', uncertainty: '장소는 알 수 없습니다.', category: 'travel', orientation: 'landscape' },
      { media_id: 'clip', description: '움직이는 풍경입니다.', mood: '차분함', subjects: ['풍경'], usable_detail: '움직임', uncertainty: '장소는 알 수 없습니다.', category: 'travel', orientation: 'landscape' },
    ], scenes: [
      { order: 1, media_id: 'photo', media_type: 'image/jpeg', start_seconds: 0, end_seconds: 4, visual_direction: '길을 보여줍니다.', caption_text: '이 길의 끝에는?' },
      { order: 2, media_id: 'clip', media_type: 'video/mp4', start_seconds: 4, end_seconds: 8, visual_direction: '움직이는 풍경을 보여줍니다.', caption_text: '천천히 바라봅니다' },
    ] }, captions: [
      { order: 1, start_seconds: 0, end_seconds: 4, text: '이 길의 끝에는?' },
      { order: 2, start_seconds: 4, end_seconds: 8, text: '천천히 바라봅니다' },
    ] };
  let result = await new CreatorAgent({ gateway: { enabled: true, provider: { mode: 'mock' }, generate: async () =>
    ({ available: true, output, usage: { calls_for_task: 1, estimated_cost_usd: 0.001 } }) } }).createPlan({
    ownerId: 'owner', taskId: 'task', project: { target_seconds: 8 }, media, requestText: '차분한 여행', privacyConsentId: 'consent' });
  assert.equal(result.generation.source, 'mock');
  assert.equal(result.plan.media_insights[1].uncertainty, '장소는 알 수 없습니다.');
  assert.notEqual(result.plan.publication_suggestions[0].title, '차분한 여행');
  assert.ok(result.plan.publication_suggestions[0].hashtags.includes('여행'));
  assert.deepEqual(result.plan.recommended_media_order, ['clip', 'photo']);
  const variable = structuredClone(output);
  variable.captions = [
    { order: 1, start_seconds: 0.2, end_seconds: 1.8, text: '이 길의 끝에는?' },
    { order: 2, start_seconds: 2, end_seconds: 3.8, text: '잠깐 멈춰 볼까요?' },
  ];
  const variableResult = await new CreatorAgent({ gateway: { enabled: true, provider: { mode: 'mock' }, generate: async () =>
    ({ available: true, output: variable, usage: { calls_for_task: 1, estimated_cost_usd: 0.001 } }) } }).createPlan({
    ownerId: 'owner', taskId: 'task', project: { target_seconds: 8 }, media, requestText: '차분한 여행', privacyConsentId: 'consent' });
  assert.equal(variableResult.generation.source, 'mock');
  assert.deepEqual(variableResult.captions.map((caption) => caption.end_seconds), [1.8, 3.8]);
  const sceneOnly = structuredClone(output);
  sceneOnly.captions = [];
  delete sceneOnly.plan.media_insights;
  const recovered = await new CreatorAgent({ gateway: { enabled: true, provider: { mode: 'mock' }, generate: async () =>
    ({ available: true, output: sceneOnly, usage: { calls_for_task: 1, estimated_cost_usd: 0.001 } }) } }).createPlan({
    ownerId: 'owner', taskId: 'task', project: { target_seconds: 8 }, media, requestText: '차분한 여행', privacyConsentId: 'consent' });
  assert.equal(recovered.generation.source, 'mock');
  assert.equal(recovered.generation.fallback_used, true);
  assert.deepEqual(recovered.captions.map((caption) => caption.text), ['이 길의 끝에는?', '천천히 바라봅니다']);
  assert.equal(recovered.captions[1].start_seconds, 4);
  assert.equal(recovered.captions[1].end_seconds, 7.5);
  result = await new CreatorAgent({ gateway: { enabled: true, provider: { mode: 'mock' }, generate: async () =>
    ({ available: true, output: { ...output, captions: [{ ...output.captions[0], text: '장면 1을 소개합니다' }, output.captions[1]] },
      usage: { calls_for_task: 1, estimated_cost_usd: 0.001 } }) } }).createPlan({
    ownerId: 'owner', taskId: 'task', project: { target_seconds: 8 }, media, requestText: '차분한 여행', privacyConsentId: 'consent' });
  assert.equal(result.generation.source, 'mock');
  assert.equal(result.generation.fallback_used, true);
  assert.equal(result.captions.some((caption) => /장면\s*\d+을 소개합니다/u.test(caption.text)), false);
  const invented = structuredClone(output);
  invented.plan.scenes[0].caption_text = '직접 방문해 맛있었어요';
  invented.captions[0].text = '직접 방문해 맛있었어요';
  const blocked = await new CreatorAgent({ gateway: { enabled: true, provider: { mode: 'mock' }, generate: async () =>
    ({ available: true, output: invented, usage: { calls_for_task: 1, estimated_cost_usd: 0.001 } }) } }).createPlan({
    ownerId: 'owner', taskId: 'task', project: { target_seconds: 8 }, media, requestText: '차분한 여행', privacyConsentId: 'consent' });
  assert.equal(blocked.generation.source, 'mock');
  assert.equal(blocked.generation.fallback_used, true);
  assert.equal(blocked.captions.some((caption) => caption.text.includes('맛있었어요')), false);
});

test('Mock food, cafe and travel insights carry different scene-level editing choices', async () => {
  const categories = ['food', 'cafe', 'travel'];
  const media = categories.map((category) => ({ mediaId: category, mediaType: 'image/jpeg', imageDataUrl: 'data:image/jpeg;base64,c3ludGhldGlj' }));
  const captions = ['한 접시의 순간', '잠시 쉬어갈까요?', '풍경을 따라가요'];
  const effects = [
    { framing: 'fill_crop', motion: 'zoom_in', transition: 'cut', subtitle_style: 'emphasis', bgm_mood: '경쾌함', edit_reason: '음식 클로즈업 강조' },
    { framing: 'blur_pad', motion: 'zoom_out', transition: 'fade', subtitle_style: 'default', bgm_mood: '차분함', edit_reason: '카페 분위기를 천천히 보여줌' },
    { framing: 'fill_crop', motion: 'pan_right', transition: 'fade', subtitle_style: 'information', bgm_mood: '잔잔함', edit_reason: '넓은 풍경 이동' },
  ];
  const scenes = media.map((item, index) => ({ order: index + 1, media_id: item.mediaId, media_type: item.mediaType,
    start_seconds: index * 3, end_seconds: (index + 1) * 3, visual_direction: `${categories[index]} 합성 장면`, caption_text: captions[index], ...effects[index] }));
  const output = { plan: { title_idea: '하루의 장면', format: 'vertical_short', aspect_ratio: '9:16', target_seconds: 9,
    theme: '하루', opening_hook: captions[0], story_flow: '음식에서 카페와 여행으로 이어집니다.', mood: '다양함', ending_line: captions[2],
    recommended_media_order: categories, media_insights: media.map((item, index) => ({ media_id: item.mediaId,
      description: `${categories[index]} 합성 입력`, mood: '확인 필요', subjects: [], usable_detail: '테스트용', uncertainty: '',
      category: categories[index], orientation: 'landscape' })), scenes },
    captions: scenes.map((scene) => ({ order: scene.order, start_seconds: scene.start_seconds, end_seconds: scene.end_seconds, text: scene.caption_text })) };
  const agent = new CreatorAgent({ gateway: { enabled: true, provider: { mode: 'mock' }, generate: async () =>
    ({ available: true, output, usage: { calls_for_task: 1, estimated_cost_usd: 0.001 } }) } });
  const result = await agent.createPlan({ ownerId: 'owner', taskId: 'task', project: { target_seconds: 9 }, media,
    requestText: '음식과 카페 여행 쇼츠', privacyConsentId: 'synthetic-consent' });
  assert.equal(result.generation.source, 'mock');
  assert.deepEqual(result.plan.scenes.map((scene) => scene.motion), ['zoom_in', 'zoom_out', 'pan_right']);
  assert.deepEqual(result.plan.scenes.map((scene) => scene.transition), ['cut', 'fade', 'fade']);
  const sceneOnlyFood = structuredClone(output);
  sceneOnlyFood.captions = [];
  const recoveredFood = await new CreatorAgent({ gateway: { enabled: true, provider: { mode: 'mock' }, generate: async () =>
    ({ available: true, output: sceneOnlyFood, usage: { calls_for_task: 1, estimated_cost_usd: 0.001 } }) } }).createPlan({ ownerId: 'owner', taskId: 'task', project: { target_seconds: 9 }, media,
    requestText: '음식과 카페 여행 쇼츠', privacyConsentId: 'synthetic-consent' });
  assert.equal(recoveredFood.captions[0].text, '한 접시의 순간');
});
