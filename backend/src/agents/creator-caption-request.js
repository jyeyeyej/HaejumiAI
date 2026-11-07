import { validCaptionText } from '../media-engine/caption-timeline.js';

// This is a deliberately bounded local parser. Unrecognized place names are
// reported as unmet requests instead of being guessed from a photo or story.
const PLACE = /(?:[가-힣A-Za-z0-9]{1,16}\s+)?[가-힣A-Za-z0-9]{0,20}(?:공원|카페|해변|시장|광장|거리|역|궁|섬|숲|호수)(?=에서|이라는|이라고|라고|에|을|를|은|는|가|인|[\s,.!?]|$)/gu;
const GENERIC_PLACE = /^(?:공원|카페|해변|시장|광장|거리|역|궁|섬|숲|호수)$/u;
const ACTIVITY = /([가-힣]{2,12})(?:을|를|도)\s*(?:먹|마시|하|했|즐기|놀|보)/gu;
const CAPTION_INTENT = /자막.{0,36}(?:넣|나오|보이|포함|표시|들어가|써|적)|(?:소개|알려)(?:해|줬|줘|주)/u;
const EMOTION = /(?:좋았|즐거웠|예뻤|예쁘|신났|여유로웠|평화로웠|따뜻했)/gu;

function unique(values) { return [...new Set(values)]; }
function placesIn(text) {
  return unique([...text.matchAll(PLACE)].map((match) => match[0].trim())
    .filter((value) => !GENERIC_PLACE.test(value) && !/^(?:장소|위치|사진|영상|자막)/u.test(value)));
}
function activitiesIn(text) {
  return unique([...text.matchAll(ACTIVITY)].map((match) => match[1]));
}

export function parseUserCaptionRequest(requestText) {
  const text = typeof requestText === 'string' ? requestText.trim() : '';
  const sentences = text.split(/[.!?\n]+/u).map((item) => item.trim()).filter(Boolean);
  const places = placesIn(text);
  const activities = activitiesIn(text).slice(0, 12);
  const emotions = unique([...text.matchAll(EMOTION)].map((match) => match[0])).slice(0, 12);
  const captionSentence = sentences.find((sentence) => CAPTION_INTENT.test(sentence) && placesIn(sentence).length) ??
    sentences.find((sentence) => CAPTION_INTENT.test(sentence) && /장소|위치/u.test(sentence));
  const place = captionSentence ? placesIn(captionSentence)[0] ?? (places.length === 1 ? places[0] : '') : '';
  let caption = '';
  if (place) {
    const quote = /[“"'‘]([^”"'’]{2,30})[”"'’]\s*(?:이라는|라는)?\s*자막/u.exec(captionSentence);
    const localActivity = activitiesIn(captionSentence).find((item) => activities.includes(item));
    caption = quote?.[1]?.includes(place) ? quote[1].trim() :
      localActivity ? `${place}에서 ${localActivity}` : place;
    if (!validCaptionText(caption, text)) caption = '';
  }
  return { source: 'user_request', place: place || null, activities, emotion_terms: emotions,
    place_caption_requested: Boolean(captionSentence), place_caption: caption || null,
    place_caption_status: caption ? 'candidate' : captionSentence ? 'place_unrecognized' : 'not_requested' };
}
