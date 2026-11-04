import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorAgent } from '../src/agents/creator-agent.js';

test('Creator local fallback fits every selected media item into short target durations', async () => {
  let gatewayCalls = 0;
  const agent = new CreatorAgent({ gateway: { async generate() { gatewayCalls += 1; return { available: false, reason: 'llm_disabled', usage: { calls_for_task: 0, estimated_cost_usd: 0 } }; } } });
  const media = Array.from({ length: 8 }, (_, index) => ({ mediaId: `media-${index}`, mediaType: 'image/png', imageDataUrl: 'data:image/jpeg;base64,dGVzdA==' }));
  const result = await agent.createPlan({ taskId: 'task', project: { target_seconds: 3 }, media, requestText: '짧은 쇼츠를 만들어줘' });
  assert.equal(result.plan.scenes.length, 8);
  assert.equal(result.captions.length, 8);
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
  assert.deepEqual(result.plan.recommended_media_order, ['clip', 'photo']);
  result = await new CreatorAgent({ gateway: { enabled: true, provider: { mode: 'mock' }, generate: async () =>
    ({ available: true, output: { ...output, captions: [{ ...output.captions[0], text: '장면 1을 소개합니다' }, output.captions[1]] },
      usage: { calls_for_task: 1, estimated_cost_usd: 0.001 } }) } }).createPlan({
    ownerId: 'owner', taskId: 'task', project: { target_seconds: 8 }, media, requestText: '차분한 여행', privacyConsentId: 'consent' });
  assert.equal(result.generation.source, 'local_rules');
  assert.equal(result.generation.fallback_used, true);
  const invented = structuredClone(output);
  invented.plan.scenes[0].caption_text = '직접 방문해 맛있었어요';
  invented.captions[0].text = '직접 방문해 맛있었어요';
  const blocked = await new CreatorAgent({ gateway: { enabled: true, provider: { mode: 'mock' }, generate: async () =>
    ({ available: true, output: invented, usage: { calls_for_task: 1, estimated_cost_usd: 0.001 } }) } }).createPlan({
    ownerId: 'owner', taskId: 'task', project: { target_seconds: 8 }, media, requestText: '차분한 여행', privacyConsentId: 'consent' });
  assert.equal(blocked.generation.source, 'local_rules');
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
});
