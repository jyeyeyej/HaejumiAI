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

test('Vision Mock drops game and food captions bound to the wrong photo interval', async () => {
  const media = ['game', 'ramen', 'sunset'].map((id, index) => ({ mediaId: id, mediaType: 'image/jpeg',
    imageDataUrl: `data:image/jpeg;base64,${index}`, sampleSha256: String(index + 1).repeat(64) }));
  const scenes = media.map((item, index) => ({ order: index + 1, media_id: item.mediaId, media_type: item.mediaType,
    start_seconds: index * 4, end_seconds: (index + 1) * 4,
    caption_text: ['게임 장면', '게임 중이에요', '라면 두 그릇'][index] }));
  const wrong = { plan: { scenes, media_insights: media.map((item) => ({ media_id: item.mediaId,
    description: { game: '보드게임이 보입니다.', ramen: '컵라면 두 개와 음료가 보입니다.', sunset: '노을빛 호수가 보입니다.' }[item.mediaId],
    mood: '확인 필요', subjects: [], usable_detail: '', uncertainty: '', category: 'other', orientation: 'landscape' })) }, captions: [
    { order: 1, media_id: 'game', start_seconds: 4, end_seconds: 6, text: '게임 중이에요' },
    { order: 2, media_id: 'ramen', start_seconds: 8, end_seconds: 10, text: '라면 두 그릇' },
  ] };
  const makeAgent = (output) => new CreatorAgent({ gateway: { enabled: true, provider: { mode: 'mock', model: 'synthetic-model' },
    generate: async () => ({ available: true, output, usage: { calls_for_task: 1, estimated_cost_usd: 0.001 } }) } });
  const input = { ownerId: 'owner', taskId: 'task', project: { target_seconds: 12, current_version: 1 }, media,
    requestText: '사진으로 쇼츠를 만들어줘', privacyConsentId: 'synthetic-consent' };
  const blocked = await makeAgent(wrong).createPlan(input);
  assert.equal(blocked.generation.source, 'local_rules');
  assert.deepEqual(blocked.captions, []);
  const partial = structuredClone(wrong);
  partial.captions.push({ order: 3, media_id: 'sunset', start_seconds: 10, end_seconds: 12, text: '노을빛 하늘' });
  const kept = await makeAgent(partial).createPlan(input);
  assert.deepEqual(kept.captions.map((caption) => [caption.media_id, caption.text]), [['sunset', '노을빛 하늘']]);
  assert.equal(kept.captions[0].scene_id, kept.plan.scenes[2].scene_id);
  assert.equal(kept.captions[0].caption_source, 'vision');
  assert.equal(kept.captions[0].caption_status, 'needs_review');
  // A plausible ID/time pair cannot prove the model actually described that photo.
  const semanticMismatch = structuredClone(wrong);
  semanticMismatch.captions = [{ order: 1, media_id: 'ramen', start_seconds: 4, end_seconds: 6,
    text: '친구들과 신나게 게임 중이에요', caption_kind: 'observed_fact', evidence: '게임하는 장면' }];
  const unverified = await makeAgent(semanticMismatch).createPlan(input);
  assert.equal(unverified.captions[0].media_id, 'ramen');
  assert.equal(unverified.captions[0].caption_status, 'needs_review');
  assert.equal(unverified.captions[0].caption_kind, 'observed_fact');
  assert.equal(unverified.captions[0].caption_review_reason, 'visual_fact_unverified');
  assert.equal(unverified.captions[0].caption_basis.insight_description, '컵라면 두 개와 음료가 보입니다.');
  assert.equal(unverified.captions[0].caption_basis.model_evidence, '게임하는 장면');
  assert.equal(unverified.captions[0].caption_basis.analysis_id, unverified.plan.media_insights[1].analysis_provenance.analysis_id);
  assert.equal(unverified.plan.media_insights[1].analysis_provenance.sample_sha256, '2'.repeat(64));
  assert.equal(unverified.plan.media_insights[1].analysis_provenance.model, 'synthetic-model');
  assert.equal(unverified.plan.media_insights[1].analysis_provenance.content_version, 2);
  assert.equal(unverified.plan.scenes[1].visual_analysis_status, 'ai_unverified');
  const emotional = structuredClone(wrong);
  emotional.captions = [{ order: 1, media_id: 'sunset', start_seconds: 8, end_seconds: 10,
    text: '여유로운 시간', caption_kind: 'emotional', evidence: '노을빛 호수 분위기' }];
  const expressive = await makeAgent(emotional).createPlan(input);
  assert.equal(expressive.captions[0].caption_kind, 'emotional');
  assert.equal(expressive.captions[0].caption_review_reason, 'editorial_confirmation');
  assert.equal(expressive.captions[0].caption_status, 'needs_review', 'even editorial text still requires draft approval');
});

test('Vision Mock maps reordered insights by ID and leaves invalid or duplicate IDs unassigned', async () => {
  const media = ['game', 'ramen'].map((mediaId, index) => ({ mediaId, mediaType: 'image/jpeg',
    imageDataUrl: `data:image/jpeg;base64,${index}`, sampleSha256: String(index + 1).repeat(64) }));
  const insight = (media_id, description) => ({ media_id, description, mood: '확인 필요', subjects: [],
    usable_detail: '', uncertainty: '', category: 'other', orientation: 'portrait' });
  const game = insight('game', '숫자 타일이 놓인 피크닉 매트');
  const ramen = insight('ramen', '라면 두 그릇과 음료 캔');
  const output = (media_insights) => ({ plan: { title_idea: '두 장면', format: 'vertical_short', aspect_ratio: '9:16',
    target_seconds: 8, theme: '피크닉', opening_hook: '장면을 볼까요?', story_flow: '두 사진을 차례로 보여줍니다.',
    mood: '차분함', ending_line: '마무리합니다', recommended_media_order: ['game', 'ramen'], media_insights,
    scenes: media.map((item, index) => ({ order: index + 1, media_id: item.mediaId, media_type: item.mediaType,
      start_seconds: index * 4, end_seconds: (index + 1) * 4, visual_direction: '사진을 보여줍니다.', caption_text: '' })) },
  captions: [{ order: 1, media_id: 'game', start_seconds: 0, end_seconds: 2, text: '숫자 타일이 보여요' },
    { order: 2, media_id: 'ramen', start_seconds: 4, end_seconds: 6, text: '라면 두 그릇이 보여요' }] });
  const run = async (insights) => new CreatorAgent({ gateway: { enabled: true, provider: { mode: 'mock', model: 'synthetic-model' },
    generate: async () => ({ available: true, output: output(insights), usage: { calls_for_task: 1, estimated_cost_usd: 0.001 } }) } })
    .createPlan({ ownerId: 'owner', taskId: 'task', project: { target_seconds: 8, current_version: 1 }, media,
      requestText: '피크닉 쇼츠', privacyConsentId: 'synthetic-consent' });

  const normal = await run([game, ramen]);
  assert.deepEqual(normal.plan.media_insights.map((item) => item.description), [game.description, ramen.description]);
  assert.equal(normal.generation.fallback_used, false);
  const reordered = await run([ramen, game]);
  assert.deepEqual(reordered.plan.media_insights.map((item) => item.description), [game.description, ramen.description]);
  assert.equal(reordered.generation.fallback_used, false, 'response array order does not alter ID mapping');

  for (const bad of [[game, { ...ramen, media_id: 'unknown' }], [game], [game, { ...ramen, media_id: undefined }]]) {
    const result = await run(bad);
    assert.equal(result.plan.media_insights[0].description, game.description);
    assert.equal(result.plan.media_insights[1].category, 'unknown');
    assert.equal(result.plan.media_insights[1].analysis_provenance, undefined);
    assert.equal(result.captions[1].caption_status, 'needs_review');
  }
  const duplicate = await run([game, { ...game, description: ramen.description }, ramen]);
  assert.equal(duplicate.plan.media_insights[0].category, 'unknown', 'duplicate ID must not use last-wins content');
  assert.equal(duplicate.plan.media_insights[0].analysis_provenance, undefined);
  assert.equal(duplicate.plan.media_insights[1].description, ramen.description);
  assert.equal(duplicate.plan.scenes[0].caption_text, '');
  assert.deepEqual(duplicate.captions.map((item) => item.media_id), ['ramen']);

  const semanticMismatch = await run([{ ...game, description: ramen.description }, { ...ramen, description: game.description }]);
  assert.equal(semanticMismatch.captions.every((item) => item.caption_status === 'needs_review'), true);
  assert.equal(semanticMismatch.plan.scenes.every((item) => item.visual_analysis_status === 'ai_unverified'), true);
  // Correct IDs cannot establish that the model described the matching image.
  assert.equal(semanticMismatch.plan.media_insights[0].description, ramen.description);
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

test('Vision Mock retains verified captions when five sampled photos produce scenes for a six-item project', async () => {
  const media = Array.from({ length: 6 }, (_, index) => ({ mediaId: `photo-${index + 1}`, mediaType: 'image/jpeg',
    ...(index < 5 ? { imageDataUrl: 'data:image/jpeg;base64,c3ludGhldGlj' } : {}) }));
  const output = { plan: { title_idea: '하루의 풍경', scenes: media.slice(0, 5).map((item, index) => ({
    order: index + 1, media_id: item.mediaId, media_type: item.mediaType, start_seconds: index * 6,
    end_seconds: (index + 1) * 6, visual_direction: '확인된 장면', caption_text: index === 0 ? '하늘을 올려다봐요' : '',
  })) }, captions: [
    { order: 1, media_id: 'photo-1', start_seconds: 0, end_seconds: 3.5, text: '하늘을 올려다봐요' },
    { order: 2, media_id: 'photo-5', start_seconds: 24, end_seconds: 27.5, text: '천천히 걸어가요' },
    { order: 3, media_id: 'photo-5', start_seconds: 27.5, end_seconds: 30, text: '장면 5를 소개합니다' },
  ] };
  let calls = 0;
  const agent = new CreatorAgent({ gateway: { enabled: true, provider: { mode: 'mock' }, generate: async () => {
    calls += 1;
    return { available: true, output, usage: { calls_for_task: 1, estimated_cost_usd: 0.01 } };
  } } });
  const result = await agent.createPlan({ ownerId: 'owner', taskId: 'task', project: { target_seconds: 30 }, media,
    requestText: '풍경 쇼츠를 만들어줘', privacyConsentId: 'consent' });
  assert.equal(calls, 1);
  assert.equal(result.generation.source, 'mock');
  assert.equal(result.generation.fallback_used, true);
  assert.equal(result.generation.validation_field, 'SCENES_MEDIA_MISMATCH');
  assert.equal(result.plan.scenes.length, 6);
  assert.equal(result.plan.scenes[5].media_id, 'photo-6');
  assert.equal(result.plan.scenes[5].caption_text, '');
  assert.equal(result.plan.media_insights[5].category, 'unknown');
  assert.deepEqual(result.captions.map((caption) => caption.text), ['하늘을 올려다봐요', '천천히 걸어가요']);
  assert.equal(result.captions[1].start_seconds, 20);
  assert.ok(result.captions[1].end_seconds <= 25);
  assert.equal(validCaptionTimeline(result.captions, result.plan.scenes, 30), true);
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
      { order: 1, media_id: 'photo', start_seconds: 0, end_seconds: 4, text: '이 길의 끝에는?' },
      { order: 2, media_id: 'clip', start_seconds: 4, end_seconds: 8, text: '천천히 바라봅니다' },
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
    { order: 1, media_id: 'photo', start_seconds: 0.2, end_seconds: 1.8, text: '이 길의 끝에는?' },
    { order: 2, media_id: 'photo', start_seconds: 2, end_seconds: 3.8, text: '잠깐 멈춰 볼까요?' },
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
  assert.equal(recovered.plan.scenes[0].visual_analysis_status, 'unavailable');
  assert.equal(recovered.captions[0].caption_basis.analysis_id, null);
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
    captions: scenes.map((scene) => ({ order: scene.order, media_id: scene.media_id,
      start_seconds: scene.start_seconds, end_seconds: scene.end_seconds, text: scene.caption_text })) };
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
