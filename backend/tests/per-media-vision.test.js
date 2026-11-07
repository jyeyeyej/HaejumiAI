import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorAgent } from '../src/agents/creator-agent.js';
import { LLMGateway } from '../src/application/llm-gateway.js';
import { PrivacyGate } from '../src/security/privacy-gate.js';
import { OpenAIProvider } from '../src/application/openai-provider.js';
import { validCaptionTimeline } from '../src/media-engine/caption-timeline.js';
import { LocalRepositories, PRIVACY_NOTICE_ID, PRIVACY_NOTICE_VERSION } from '../src/adapters/filesystem/repositories.js';
import { JsonState } from '../src/adapters/filesystem/json-state.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const insight = (description, caption_suggestion = description) => ({ description, mood: '차분함', subjects: [], usable_detail: '', uncertainty: '',
  category: 'other', orientation: 'landscape', caption_suggestion });
const media = (ids) => ids.map((mediaId, index) => ({ mediaId, mediaType: 'image/jpeg',
  imageDataUrl: `data:image/jpeg;base64,${Buffer.from(`synthetic-${index}`).toString('base64')}`,
  sampleSha256: String(index + 1).repeat(64) }));
const story = (ids) => ({ story: { title_idea: '두 장면', theme: '사진 이야기', story_flow: '선택한 사진을 차례로 봅니다.',
  mood: '차분함', opening_hook: '사진을 볼까요?', ending_line: '마무리합니다', recommended_media_order: ids } });

function setup(ids, options = {}) {
  const calls = []; const entries = new Map(); let consent = true;
  const provider = { providerId: 'openai', mode: 'external', model: 'synthetic-model', supportsPerMediaVision: true,
    estimateCostUsd: async () => 0.01,
    generateStructured: async ({ input }) => {
      calls.push(input);
      if (input.operation === 'creator_plan_from_insights') return options.storyResponse ?? story(ids);
      const id = input.media[0].media_id;
      if (options.fail?.includes(id)) throw new Error('synthetic failure');
      if (options.wrongId?.includes(id)) return { media_insight: { ...insight('잘못 붙은 설명'), media_id: ids.find((item) => item !== id) } };
      if (options.duplicate?.includes(id)) return { media_insights: [insight('첫 설명'), insight('중복 설명')] };
      if (options.missing?.includes(id)) return { media_insight: { mood: '내용 누락' } };
      if (Object.hasOwn(options.responses ?? {}, id)) return options.responses[id];
      if (options.revokeAfter === id) consent = false;
      return { media_insight: insight(id === 'A' ? '숫자 타일이 보입니다' : '라면 두 그릇이 보입니다') };
    } };
  const gate = new PrivacyGate({ enabled: true, providerAllowlist: ['openai'],
    consentVerifier: ({ resourceIds }) => consent && resourceIds.every((id) => ids.includes(id)) });
  const gateway = new LLMGateway({ enabled: true, provider, privacyGate: gate,
    limits: { dailyUsd: options.dailyUsd ?? 1, monthlyUsd: 1, maxCallsPerTask: options.maxCalls ?? 5 } });
  const cache = { get: (id, hash, model) => {
    const entry = entries.get(id);
    return entry?.sample_sha256 === hash && entry.model === model ? entry : null;
  }, put: (id, hash, model, value) => entries.set(id, { insight: value, sample_sha256: hash, model,
    analysis_id: `analysis-${id}`, analyzed_at: '2026-11-07T00:00:00.000Z' }) };
  const agent = new CreatorAgent({ gateway });
  const run = () => agent.createPlan({ ownerId: 'owner', taskId: 'task', project: { target_seconds: ids.length * 5, current_version: 1 },
    media: media(ids), requestText: options.requestText ?? '사진 쇼츠', privacyConsentId: 'synthetic-consent', visionCache: cache });
  return { run, calls, entries, gateway, revoke: () => { consent = false; } };
}

test('one image per Vision call, server-owned IDs, local captions and text-only story', async () => {
  const f = setup(['A', 'B']);
  const result = await f.run();
  assert.deepEqual(f.calls.map((input) => input.operation), ['creator_media_insight', 'creator_media_insight', 'creator_plan_from_insights']);
  assert.ok(f.calls.slice(0, 2).every((input) => input.media.length === 1));
  assert.equal(f.calls[2].media, undefined, 'planning must not send the image bytes');
  assert.deepEqual(result.plan.media_insights.map((item) => item.media_id), ['A', 'B']);
  assert.deepEqual(result.captions.map((item) => [item.media_id, item.caption_status]), [['A', 'needs_review'], ['B', 'needs_review']]);
  assert.equal(result.generation.llm_calls, 3);
  assert.equal(result.generation.planning_source, 'vision_text_plan');
  assert.equal(f.entries.size, 2);
});

test('explicit user caption is reviewed and repeated river wording is reduced without moving photo facts', async () => {
  const requestText = '양화 한강공원에 친구들과 놀러가서 라면도 먹고 게임도 했어. 양화 한강공원이라는 자막이 나오면 좋겠어';
  const f = setup(['A', 'B'], { requestText, responses: {
    A: { media_insight: insight('숫자 타일이 보입니다.', '강가에서 게임 중') },
    B: { media_insight: insight('라면 두 그릇이 보입니다.', '강가에서 라면 한잔') },
  } });
  const result = await f.run();
  assert.deepEqual(f.calls.map((input) => input.operation),
    ['creator_media_insight', 'creator_media_insight', 'creator_plan_from_insights']);
  assert.equal(f.calls[2].request, requestText);
  assert.deepEqual(result.captions.map((row) => [row.media_id, row.text]),
    [['A', '양화 한강공원'], ['A', '게임 중'], ['B', '라면 한잔']]);
  assert.equal(result.captions[0].caption_kind, 'user_information');
  assert.equal(result.captions[0].caption_status, 'needs_review');
  assert.equal(result.captions[1].caption_basis.media_id, 'A');
  assert.equal(result.captions[2].caption_basis.media_id, 'B');
  assert.equal(result.generation.caption_refinement.requested_caption_added, true);
  assert.equal(result.generation.caption_refinement.repeated_location_prefixes_removed, 2);
  assert.deepEqual(result.plan.scenes.map((scene) => scene.caption_text), ['양화 한강공원', '라면 한잔']);
  assert.ok(validCaptionTimeline(result.captions, result.plan.scenes, 10, requestText));
});

test('user picnic location reaches the caption timeline while generic river and lake labels do not', async () => {
  const requestText = '양화 한강공원에 친구들과 놀러가서 라면도 먹고 게임도 하고 피크닉을 즐기다 왔어. 노을도 예쁘고 너무 좋았어. 양화 한강공원에서 피크닉을 했다는 장소에 대한 자막이 들어가면 좋겠어.';
  const f = setup(['A', 'B', 'C', 'D'], { requestText, responses: {
    A: { media_insight: insight('숫자 타일이 보입니다.', '강가에서 숫자 타일 게임') },
    B: { media_insight: insight('라면 두 그릇과 음료가 보입니다.', '호숫가에서 라면 두 그릇') },
    C: { media_insight: insight('분홍빛 하늘과 강이 보입니다.', '강변에서 분홍빛 하늘') },
    D: { media_insight: insight('파란 하늘과 나무가 보입니다.', '파란 하늘 아래 여유') },
  } });
  const result = await f.run();
  assert.equal(result.plan.user_context.place, '양화 한강공원');
  assert.deepEqual(result.plan.user_context.activities, ['라면', '게임', '피크닉']);
  assert.equal(result.generation.caption_refinement.requested_caption_reflected, true);
  assert.equal(result.captions.filter((row) => row.text.includes('양화 한강공원')).length, 1);
  assert.equal(result.captions.some((row) => /강가에서|강변에서|호숫가/u.test(row.text)), false);
  assert.equal(result.captions[0].caption_kind, 'user_information');
  assert.equal(result.captions[0].caption_status, 'needs_review');
  assert.deepEqual(result.captions.filter((row) => row.caption_source === 'vision').map((row) => [row.media_id, row.text]),
    [['A', '숫자 타일 게임'], ['B', '라면 두 그릇'], ['C', '분홍빛 하늘'], ['D', '파란 하늘 아래 여유']]);
  assert.ok(validCaptionTimeline(result.captions, result.plan.scenes, 20, requestText));
});

test('Mock friendly food, game and sunset subtitles stay with their own observations and timing', async () => {
  const f = setup(['A', 'B', 'C'], { responses: {
    A: { media_insight: { ...insight('라면 두 그릇이 보입니다.', '라면 두 그릇, 잠깐 쉬어갈까?'), category: 'food' } },
    B: { media_insight: insight('숫자 타일을 놓은 게임판이 보입니다.', '게임판 앞에선 나도 진심!') },
    C: { media_insight: { ...insight('분홍빛 노을이 보입니다.', '노을빛이 몽글몽글해'), category: 'travel' } },
  } });
  const result = await f.run();
  assert.deepEqual(result.plan.media_insights.map((row) => row.description),
    ['라면 두 그릇이 보입니다.', '숫자 타일을 놓은 게임판이 보입니다.', '분홍빛 노을이 보입니다.']);
  assert.deepEqual(result.captions.map((row) => [row.media_id, row.text]),
    [['A', '라면 두 그릇, 잠깐 쉬어갈까?'], ['B', '게임판 앞에선 나도 진심!'], ['C', '노을빛이 몽글몽글해']]);
  assert.ok(result.captions.every((row) => row.caption_status === 'needs_review' && row.caption_basis.media_id === row.media_id));
  assert.deepEqual(result.generation.caption_style_review,
    { duplicate_captions_omitted: 0, repeated_endings_for_review: 0, formal_endings_for_review: 0 });
  assert.ok(validCaptionTimeline(result.captions, result.plan.scenes, 15, '사진 쇼츠'));
});

test('whole-video review omits an identical second subtitle and flags recurring report endings', async () => {
  const f = setup(['A', 'B', 'C'], { responses: {
    A: { media_insight: insight('음식 사진입니다.', '라면 두 그릇이 보입니다') },
    B: { media_insight: insight('다른 음식 사진입니다.', '라면 두 그릇이 보입니다') },
    C: { media_insight: insight('하늘 사진입니다.', '노을이 보입니다') },
  } });
  const result = await f.run();
  assert.deepEqual(result.captions.map((row) => [row.media_id, row.text]),
    [['A', '라면 두 그릇이 보입니다'], ['C', '노을이 보입니다']]);
  assert.equal(result.generation.caption_style_review.duplicate_captions_omitted, 1);
  assert.equal(result.generation.caption_style_review.repeated_endings_for_review, 1);
  assert.equal(result.generation.caption_style_review.formal_endings_for_review, 2);
  assert.equal(result.generation.media_analysis[1].caption_reason, 'REPEATED_CAPTION');
});

test('missing visual evidence leaves the place caption explicitly unfulfilled', async () => {
  const f = setup(['A'], { requestText: '양화 한강공원이라는 자막 넣어줘',
    responses: { A: { media_insight: { ...insight(''), description: '' } } } });
  const result = await f.run();
  assert.equal(result.generation.caption_refinement.requested_caption_required, true);
  assert.equal(result.generation.caption_refinement.requested_caption_reflected, false);
  assert.equal(result.generation.caption_refinement.requested_caption_unmet_reason, 'NO_VALID_VISUAL_ANALYSIS');
  assert.deepEqual(result.captions, []);
});

test('local wording pass does not invent a caption when user wording or visual analysis is absent', async () => {
  const plain = setup(['A', 'B'], { responses: {
    A: { media_insight: insight('숫자 타일이 보입니다.', '강가에서 게임 중') },
    B: { media_insight: insight('라면 두 그릇이 보입니다.', '강가에서 라면 한잔') },
  } });
  const result = await plain.run();
  assert.deepEqual(result.captions.map((row) => row.text), ['강가에서 게임 중', '라면 한잔']);
  assert.equal(result.generation.caption_refinement.requested_caption_added, false);
  const failed = setup(['A'], { requestText: '양화 한강공원이라는 자막이 나오면 좋겠어',
    responses: { A: { media_insight: { ...insight(''), description: '' } } } });
  assert.deepEqual((await failed.run()).captions, []);
});

test('wrong, duplicate and missing model IDs cannot reassign a photo', async () => {
  for (const mode of ['wrongId', 'duplicate', 'missing']) {
    const f = setup(['A', 'B'], { [mode]: ['A'] });
    const result = await f.run();
    assert.equal(result.plan.media_insights[0].category, 'unknown');
    assert.equal(result.plan.media_insights[1].description, '라면 두 그릇이 보입니다');
    assert.deepEqual(result.captions.map((item) => item.media_id), ['B']);
    assert.equal(result.generation.media_analysis[0].status, 'failed');
  }
});

test('one image failure does not copy its facts from a successful image', async () => {
  const f = setup(['A', 'B'], { fail: ['A'] });
  const result = await f.run();
  assert.equal(result.plan.media_insights[0].category, 'unknown');
  assert.equal(result.plan.media_insights[1].description, '라면 두 그릇이 보입니다');
  assert.deepEqual(result.generation.media_analysis.map((item) => item.status), ['failed', 'analyzed']);
  assert.deepEqual(result.captions.map((item) => item.media_id), ['B']);
});

test('cache reuses only the same media, hash and model', async () => {
  const f = setup(['A', 'B']);
  await f.run();
  const before = f.calls.filter((item) => item.operation === 'creator_media_insight').length;
  const second = await f.run();
  assert.equal(f.calls.filter((item) => item.operation === 'creator_media_insight').length, before);
  assert.deepEqual(second.generation.media_analysis.map((item) => item.status), ['cached', 'cached']);
  f.entries.get('A').sample_sha256 = 'f'.repeat(64);
  const third = await f.run();
  assert.equal(third.generation.media_analysis[0].status, 'analyzed');
  const modelChange = setup(['A']);
  await modelChange.run();
  modelChange.gateway.provider.model = 'another-synthetic-model';
  const changed = await modelChange.run();
  assert.equal(changed.generation.media_analysis[0].status, 'analyzed');
});

test('five photos use five calls at the existing cap and compose a local story', async () => {
  const f = setup(['A', 'B', 'C', 'D', 'E']);
  const result = await f.run();
  assert.equal(f.calls.length, 5);
  assert.equal(result.generation.planning_source, 'local_from_vision');
  assert.equal(result.plan.scenes.length, 5);
});

test('preflight budget and call cap stop all external calls', async () => {
  for (const limits of [{ dailyUsd: 0.015 }, { maxCalls: 1 }]) {
    const f = setup(['A', 'B'], limits);
    const result = await f.run();
    assert.equal(f.calls.length, 0);
    assert.equal(result.generation.gate_reason, 'LLM_BUDGET_EXCEEDED');
  }
});

test('revoked consent stops later photos and prevents the story call', async () => {
  const f = setup(['A', 'B'], { revokeAfter: 'A' });
  const result = await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(result.generation.media_analysis[1].status, 'failed');
  assert.equal(result.generation.media_analysis[1].reason, 'CONSENT_REQUIRED');
});

test('OpenAI adapter isolates a single visual sample and sends no image in story step', async () => {
  const requests = [];
  const provider = new OpenAIProvider({ apiKey: 'synthetic-test-key', model: 'synthetic-model', fetchImpl: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ output: [{ content: [{ type: 'output_text',
      text: JSON.stringify({ media_insight: insight('합성 사진') }) }] }] }) };
  } });
  await provider.generateStructured({ purpose: 'vision_analysis', prompt: 'synthetic', input: {
    operation: 'creator_media_insight', media: [{ image_data_url: 'data:image/jpeg;base64,c3ludGhldGlj' }] } });
  await provider.generateStructured({ purpose: 'vision_analysis', prompt: 'synthetic', input: {
    operation: 'creator_plan_from_insights', request: '합성', target_seconds: 5, insights: [{ media_id: 'A', description: '합성 사진' }] } });
  const content = requests.map((body) => body.input[0].content);
  assert.deepEqual(content.map((items) => items.filter((part) => part.type === 'input_image').length), [1, 0]);
  assert.deepEqual(requests.map((body) => body.max_output_tokens), [900, 1800]);
  assert.equal(requests[0].text.format.type, 'json_schema');
  assert.equal(requests[0].text.format.strict, true);
  assert.match(content[0][0].text, /warm, cute, affectionate everyday vlog/);
  assert.match(content[0][0].text, /factual; apply the playful, soft tone ONLY to caption_suggestion/);
  assert.match(content[0][0].text, /Vary rhythm and endings naturally/);
  assert.match(content[0][0].text, /Avoid stock phrases, forced baby talk, excessive slang, and emoji/);
  assert.match(content[0][0].text, /Never copy the long description.*invent a person relationship/);
  assert.deepEqual(requests[0].text.format.schema.properties.media_insight.required,
    ['description', 'mood', 'subjects', 'usable_detail', 'uncertainty', 'category', 'orientation', 'caption_suggestion']);
  assert.equal(requests[1].text.format.type, 'json_schema');
  assert.deepEqual(requests[1].text.format.schema.properties.story.required,
    ['title_idea', 'theme', 'story_flow', 'mood', 'opening_hook', 'ending_line', 'recommended_media_order']);
  await assert.rejects(provider.generateStructured({ purpose: 'vision_analysis', prompt: 'synthetic', input: {
    operation: 'creator_media_insight', media: [{ image_data_url: 'data:image/jpeg;base64,MA==' },
      { image_data_url: 'data:image/jpeg;base64,MQ==' }] } }));
});

test('per-photo validation reports only safe field metadata and isolates a bad response', async () => {
  const badCases = [
    [{ media_insight: { ...insight('synthetic'), mood: undefined } }, 'TYPE_MISMATCH', 'media_insight.mood', 'undefined'],
    [{ media_insight: { ...insight('synthetic'), subjects: 'invalid' } }, 'TYPE_MISMATCH', 'media_insight.subjects', 'string'],
    [{ media_insight: { ...insight('synthetic'), media_id: 'B' } }, 'MEDIA_ID_MISMATCH', 'media_insight.media_id', 'string'],
    [{ media_insights: [insight('synthetic')] }, 'BATCH_OUTPUT_UNEXPECTED', 'media_insights', 'array'],
    [{ media_insight: { ...insight('synthetic'), category: 'unapproved' } }, 'INVALID_ENUM', 'media_insight.category', 'string'],
  ];
  for (const [badResponse, code, path, actualType] of badCases) {
    const f = setup(['A', 'B'], { responses: { A: badResponse } });
    const result = await f.run();
    assert.equal(result.generation.media_analysis[0].reason, 'INVALID_MODEL_OUTPUT');
    assert.deepEqual(result.generation.media_analysis[0].diagnostic, {
      validation_code: code, field_path: path, expected_type: code === 'INVALID_ENUM' ? 'enum' :
        code === 'MEDIA_ID_MISMATCH' ? 'matching_media_id' : code === 'BATCH_OUTPUT_UNEXPECTED' ? 'absent' :
          path.endsWith('subjects') ? 'array' : 'string',
      actual_type: actualType, json_parse_succeeded: true, output_truncated: false,
    });
    assert.equal(result.generation.media_analysis[1].status, 'analyzed');
    assert.equal(f.calls.filter((item) => item.operation === 'creator_media_insight').length, 2);
    assert.equal(JSON.stringify(result.generation.media_analysis).includes('unapproved'), false);
  }
  const missing = setup(['A'], { responses: { A: { media_insight: { mood: 'synthetic' } } } });
  const result = await missing.run();
  assert.deepEqual(result.generation.media_analysis[0].diagnostic.missing_required_fields, ['description']);
  assert.equal(result.generation.media_analysis[0].diagnostic.field_path, 'media_insight.description');
});

test('two invalid photos produce a local uncaptained plan without retry or cache writes', async () => {
  const f = setup(['A', 'B'], { responses: { A: { media_insight: { ...insight('synthetic'), description: '' } }, B: {} } });
  const result = await f.run();
  assert.equal(result.generation.source, 'local_rules');
  assert.deepEqual(result.generation.media_analysis.map((item) => item.diagnostic.validation_code),
    ['EMPTY_DESCRIPTION', 'REQUIRED_FIELD_MISSING']);
  assert.deepEqual(result.captions, []);
  assert.equal(f.entries.size, 0);
  assert.equal(f.calls.length, 2);
  assert.equal(f.gateway.usage.callsByTask.task, 2);
  assert.equal(f.gateway.usage.dailyUsd, 0.02);
});

test('long visual analysis is separate from a short Korean caption for its own scene', async () => {
  const longDescription = '숫자 타일과 피크닉 매트가 보입니다. '.repeat(18);
  const f = setup(['A', 'B'], { responses: { A: { media_insight: insight(longDescription, '숫자 타일로 즐기는 시간') },
    B: { media_insight: insight('라면 두 그릇과 음료가 놓여 있습니다.', '라면 두 그릇과 음료') } } });
  const result = await f.run();
  assert.ok(longDescription.length > 300 && longDescription.length < 500);
  assert.equal(result.plan.media_insights[0].description, longDescription);
  assert.deepEqual(result.captions.map((item) => [item.media_id, item.text, item.caption_status]),
    [['A', '숫자 타일로 즐기는 시간', 'needs_review'], ['B', '라면 두 그릇과 음료', 'needs_review']]);
  assert.deepEqual(result.captions.map((item) => [item.start_seconds, item.end_seconds]), [[0, 3.5], [5, 8.5]]);
  assert.equal(result.captions[0].caption_basis.media_id, 'A');
  assert.equal(result.captions[1].caption_basis.media_id, 'B');
});

test('four isolated observations keep game, food, sunset and blue-sky captions on their own media', async () => {
  const descriptions = {
    A: insight('피크닉 매트에 숫자 타일이 보입니다.', '피크닉 게임 한 장면'),
    B: insight('라면 두 그릇과 음료 캔이 보입니다.', '라면 두 그릇과 음료'),
    C: insight('노을빛 하늘과 호수가 보입니다.', '노을빛 호숫가'),
    D: insight('맑고 파란 하늘이 보입니다.', '파란 하늘 아래'),
  };
  const f = setup(['A', 'B', 'C', 'D'], { responses: Object.fromEntries(Object.entries(descriptions)
    .map(([id, value]) => [id, { media_insight: value }])) });
  const result = await f.run();
  assert.equal(f.calls.filter((item) => item.operation === 'creator_media_insight').length, 4);
  assert.equal(result.generation.planning_source, 'vision_text_plan', 'the text-only story cannot alter captions');
  assert.deepEqual(result.captions.map((item) => [item.media_id, item.text]),
    [['A', '피크닉 게임 한 장면'], ['B', '라면 두 그릇과 음료'], ['C', '노을빛 호숫가'], ['D', '파란 하늘 아래']]);
  assert.equal(result.captions[3].text.includes('노을'), false);
  assert.ok(result.captions.every((item) => item.caption_status === 'needs_review'));
});

test('overlong analysis is isolated while another photo keeps its caption', async () => {
  const f = setup(['A', 'B'], { responses: { A: { media_insight: insight('가'.repeat(501), '숫자 타일') } } });
  const result = await f.run();
  assert.equal(result.generation.media_analysis[0].diagnostic.validation_code, 'STRING_TOO_LONG');
  assert.equal(result.generation.media_analysis[0].diagnostic.field_path, 'media_insight.description');
  assert.deepEqual(result.captions.map((item) => item.media_id), ['B']);
  assert.equal(f.entries.size, 1);
});

test('an unusable subtitle is reported and never replaced by the visual description', async () => {
  for (const [candidate, reason] of [
    ['', 'CAPTION_NOT_PROVIDED'],
    ['라면 두 그릇과 음료가 보이는 야외 장면을 길게 설명하는 자막입니다', 'CAPTION_TOO_LONG'],
    ['Two bowls of ramen', 'CAPTION_NOT_KOREAN'],
  ]) {
    const f = setup(['A'], { responses: { A: { media_insight: insight('라면 두 그릇과 음료가 보입니다.', candidate) } } });
    const result = await f.run();
    assert.equal(result.generation.media_analysis[0].status, 'analyzed');
    assert.equal(result.generation.media_analysis[0].caption_status, 'unavailable');
    assert.equal(result.generation.media_analysis[0].caption_reason, reason);
    assert.deepEqual(result.captions, []);
  }
});

test('story schema failures retain safe field diagnostics and cannot move facts into captions', async () => {
  for (const [badStory, field, code] of [
    [{ story: { ...story(['A', 'B']).story, title_idea: '가'.repeat(65) } }, 'story.title_idea', 'STRING_TOO_LONG'],
    [{ story: { ...story(['A', 'B']).story, recommended_media_order: ['A', 'A'] } }, 'story.recommended_media_order', 'ORDER_MEDIA_MISMATCH'],
    [{ story: { ...story(['A', 'B']).story, scenes: [{ media_id: 'A', caption: '라면' }] } }, 'story.scenes', 'UNEXPECTED_STORY_FIELD'],
    [{ story: { ...story(['A', 'B']).story, mood: 42 } }, 'story.mood', 'TYPE_MISMATCH'],
  ]) {
    const f = setup(['A', 'B'], { storyResponse: badStory });
    const result = await f.run();
    assert.equal(result.generation.story_analysis.status, 'failed');
    assert.equal(result.generation.story_analysis.reason, 'INVALID_MODEL_OUTPUT');
    assert.equal(result.generation.story_analysis.diagnostic.field_path, field);
    assert.equal(result.generation.story_analysis.diagnostic.validation_code, code);
    assert.equal(result.generation.story_analysis.diagnostic.json_parse_succeeded, true);
    assert.deepEqual(result.captions.map((item) => item.text), ['숫자 타일이 보입니다', '라면 두 그릇이 보입니다']);
    assert.equal(JSON.stringify(result.generation.story_analysis).includes('라면'), false);
  }
});

test('malformed or truncated provider JSON reports parse and length status without response text', async () => {
  for (const [payload, code, truncated] of [
    [{ output: [{ content: [{ type: 'output_text', text: '{"media_insight":' }] }] }, 'JSON_PARSE_FAILED', false],
    [{ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }, 'RESPONSE_INCOMPLETE', true],
    [{ output: {} }, 'OUTPUT_ITEMS_INVALID', false],
  ]) {
    let calls = 0;
    const provider = new OpenAIProvider({ apiKey: 'synthetic-private-test-key', model: 'synthetic-model',
      fetchImpl: async () => { calls += 1; return { ok: true, status: 200,
        headers: { get: () => 'req_safe_synthetic' }, json: async () => payload }; } });
    const gateway = new LLMGateway({ enabled: true, provider, privacyGate: new PrivacyGate({ enabled: true,
      providerAllowlist: ['openai'], consentVerifier: async () => true }) });
    const result = await gateway.generate({ ownerId: 'owner', taskId: 'task', consentId: 'consent', purpose: 'vision_analysis',
      dataCategories: ['selected_media'], resourceIds: ['synthetic-id'], prompt: 'synthetic',
      input: { operation: 'creator_media_insight', media: [{ image_data_url: 'data:image/jpeg;base64,c3ludGhldGlj' }] } });
    assert.equal(result.reason, 'OPENAI_RESPONSE_INVALID');
    assert.equal(result.diagnostic.validation_code, code);
    assert.equal(result.diagnostic.json_parse_succeeded, code === 'RESPONSE_INCOMPLETE' ? undefined : false);
    assert.equal(result.diagnostic.output_truncated, truncated);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes('synthetic-private-test-key'), false);
    assert.equal(JSON.stringify(result).includes('media_insight'), false);
  }
});

test('JSON Creator persists owner-scoped per-photo results, reuses cache and invalidates prior approval on revision', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'haejumi-per-media-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new JsonState(join(dir, 'state.json'));
  const repositories = new LocalRepositories({ state, dataDir: dir, maxMediaBytes: 1024 * 1024,
    imagePreparer: async (path) => Buffer.from(`sample-${path.endsWith('a.jpg') ? 'a' : 'b'}`) });
  const ids = [randomUUID(), randomUUID()];
  ids.forEach((id, index) => {
    const bytes = Buffer.from(`private-synthetic-${index}`);
    const storageKey = `${index ? 'b' : 'a'}.jpg`;
    writeFileSync(join(repositories.blobDir, storageKey), bytes);
    state.data.media[id] = { mediaId: id, ownerId: 'owner', status: 'available', storageKey,
      sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/jpeg' };
  });
  state.data.creatorVisionInsights[ids[0]] = { owner_id: 'owner', media_id: ids[0],
    sample_sha256: '1'.repeat(64), model: 'synthetic-model', analysis_schema: 'per_media_v1',
    insight: { ...insight('기존 분석 설명'), caption_suggestion: undefined }, analysis_id: randomUUID() };
  state.data.creatorVisionInsights[`${ids[0]}:per_media_v2`] = { owner_id: 'owner', media_id: ids[0],
    sample_sha256: createHash('sha256').update(Buffer.from('sample-a')).digest('hex'),
    model: 'synthetic-model', analysis_schema: 'per_media_v2',
    insight: insight('이전 말투 분석 설명'), analysis_id: randomUUID() };
  state.save();
  const project = repositories.createForOwner('owner', { media_ids: ids, target_seconds: 10 }, 'project-per-media-test');
  const consent = repositories.createPrivacyConsent('owner', { provider_id: 'openai', purpose: 'vision_analysis',
    data_categories: ['selected_media', 'user_text'], resource_ids: ids, notice_id: PRIVACY_NOTICE_ID,
    notice_version: PRIVACY_NOTICE_VERSION, explicitly_confirmed: true,
    expires_at: new Date(Date.now() + 60_000).toISOString() }, 'consent-per-media-test');
  assert.equal(repositories.verifyPrivacyConsent({ ownerId: 'owner', consentId: consent.consent_id, providerId: 'openai',
    purpose: 'vision_analysis', dataCategories: ['selected_media'], resourceIds: [ids[0]] }), true);
  assert.equal(repositories.verifyPrivacyConsent({ ownerId: 'owner', consentId: consent.consent_id, providerId: 'openai',
    purpose: 'vision_analysis', dataCategories: ['selected_media'], resourceIds: [randomUUID()] }), false);
  const calls = [];
  const provider = { providerId: 'openai', mode: 'external', model: 'synthetic-model', supportsPerMediaVision: true,
    estimateCostUsd: async () => 0.01,
    generateStructured: async ({ input }) => {
      calls.push(input.operation);
      if (input.operation === 'creator_plan_from_insights') return story(ids);
      return { media_insight: insight(input.media[0].media_id === ids[0] ? '숫자 타일이 보입니다' : '라면 두 그릇이 보입니다') };
    } };
  const gateway = new LLMGateway({ enabled: true, provider, state,
    privacyGate: new PrivacyGate({ enabled: true, providerAllowlist: ['openai'],
      consentVerifier: (context) => repositories.verifyPrivacyConsent(context) }),
    limits: { dailyUsd: 1, monthlyUsd: 1, maxCallsPerTask: 5, maxRevisionsPerTask: 3 } });
  const agent = new CreatorAgent({ gateway });
  const first = await repositories.createCreatorPlan('owner', project.task_id, { content_version: 1,
    request_text: '사진 쇼츠', privacy_consent_id: consent.consent_id }, 'plan-per-media-1', agent);
  assert.equal(first.content_version, 2);
  assert.equal(Object.keys(state.data.creatorVisionInsights).length, 4, 'both legacy cache versions remain alongside new-contract entries');
  assert.equal(state.data.creatorVisionInsights[ids[0]].analysis_schema, 'per_media_v1');
  assert.equal(state.data.creatorVisionInsights[ids[0]].insight.description, '기존 분석 설명');
  assert.equal(state.data.creatorVisionInsights[`${ids[0]}:per_media_v2`].insight.description, '이전 말투 분석 설명');
  assert.match(state.data.creatorVisionInsights[`${ids[0]}:per_media_v3`].analysis_request_id, /^[0-9a-f-]{36}$/);
  assert.equal(state.data.creatorVisionInsights[`${ids[0]}:per_media_v3`].analysis_schema, 'per_media_v3');
  assert.deepEqual(first.plan.media_insights.map((row) => row.description), ['숫자 타일이 보입니다', '라면 두 그릇이 보입니다']);
  const approvalId = randomUUID();
  state.data.approvals[approvalId] = { approval_id: approvalId, task_id: project.task_id, status: 'active' };
  const second = await repositories.createCreatorPlan('owner', project.task_id, { content_version: 2,
    request_text: '사진 쇼츠 다시 기획', privacy_consent_id: consent.consent_id }, 'plan-per-media-2', agent);
  assert.equal(second.content_version, 3);
  assert.equal(state.data.approvals[approvalId].status, 'invalidated');
  assert.equal(calls.filter((op) => op === 'creator_media_insight').length, 2, 'revision must use photo cache');
  assert.equal(state.data.projects[project.project_id].caption_draft.every((caption) => caption.caption_status === 'needs_review'), true);
  const reloaded = new JsonState(join(dir, 'state.json'));
  assert.equal(Object.keys(reloaded.data.creatorVisionInsights).length, 4, 'all cache versions survive server restart');
  repositories.revokePrivacyConsent('owner', consent.consent_id);
  const before = calls.length;
  const denied = await repositories.createCreatorPlan('owner', project.task_id, { content_version: 3,
    request_text: '동의 철회 후', privacy_consent_id: consent.consent_id }, 'plan-per-media-3', agent);
  assert.equal(calls.length, before);
  assert.equal(denied.generation.source, 'local_rules');
});
