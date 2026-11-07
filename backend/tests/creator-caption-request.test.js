import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUserCaptionRequest } from '../src/agents/creator-caption-request.js';

test('local request parser distinguishes user supplied place, actions, emotion and caption intent', () => {
  const input = '양화 한강공원에 친구들과 놀러가서 라면도 먹고 게임도 하고 피크닉을 즐기다 왔어. 노을도 예쁘고 너무 좋았어. 양화 한강공원에서 피크닉을 했다는 장소에 대한 자막이 들어가면 좋겠어.';
  assert.deepEqual(parseUserCaptionRequest(input), {
    source: 'user_request', place: '양화 한강공원', activities: ['라면', '게임', '피크닉'],
    emotion_terms: ['예쁘', '좋았'], place_caption_requested: true,
    place_caption: '양화 한강공원에서 피크닉', place_caption_status: 'candidate',
  });
});

test('different Korean requests for a place caption use the same bounded user fact', () => {
  for (const [input, place] of [
    ['양화 한강공원이라는 자막 넣어줘', '양화 한강공원'],
    ['처음에 양화 한강공원이라고 소개해 줘', '양화 한강공원'],
    ['장소가 양화 한강공원이라는 걸 알려줬으면 좋겠어', '양화 한강공원'],
    ['서울숲에서 산책했어. 서울숲 자막 넣어줘', '서울숲'],
    ['성수 카페에서 쉬었어. 장소가 성수 카페라는 걸 알려줘', '성수 카페'],
  ]) {
    const result = parseUserCaptionRequest(input);
    assert.equal(result.place, place);
    assert.equal(result.place_caption_requested, true);
    assert.ok(result.place_caption.includes(place));
  }
});

test('parser does not turn unspecified or unknown locations into photo facts', () => {
  const styleOnly = parseUserCaptionRequest('강가에서 찍은 사진이야. 자막은 깔끔하게 만들어줘');
  assert.equal(styleOnly.place_caption_requested, false);
  assert.equal(styleOnly.place_caption, null);
  const unknown = parseUserCaptionRequest('우리만 아는 장소 이름을 자막에 넣어줘');
  assert.equal(unknown.place_caption_requested, true);
  assert.equal(unknown.place_caption, null);
  assert.equal(unknown.place_caption_status, 'place_unrecognized');
});
