import { CAPTION_TEXT_PATTERN } from './caption-font.js';

export function validCaptionText(text, requestText = '') {
  if (typeof text !== 'string' || !text.trim() || [...text].length > 80 || !CAPTION_TEXT_PATTERN.test(text)) return false;
  const normalized = text.trim().replace(/\s+/gu, ' ');
  if (/장면\s*\d+\s*(?:을|를)\s*소개합니다/u.test(normalized)) return false;
  if (/(?:장면별\s*효과|기획안|자막\s*초안|AI\s*분석|편집\s*스타일).*(?:제안|만들|생성|분석)/u.test(normalized)) return false;
  if (requestText && normalized === requestText.trim().replace(/\s+/gu, ' ')) return false;
  return true;
}

export function captionScene(caption, scenes) {
  return scenes?.find((scene) =>
    (!caption.scene_id || scene.scene_id === caption.scene_id) &&
    (!caption.media_id || scene.media_id === caption.media_id) &&
    caption.start_seconds >= scene.start_seconds - 0.001 && caption.end_seconds <= scene.end_seconds + 0.001);
}

export function validCaptionTimeline(captions, scenes, duration, requestText = '') {
  return Array.isArray(captions) && captions.length <= 30 && captions.every((caption, index) => caption && caption.order === index + 1 &&
    Number.isFinite(caption.start_seconds) && Number.isFinite(caption.end_seconds) && caption.start_seconds >= 0 &&
    caption.start_seconds < caption.end_seconds && caption.end_seconds <= duration + 0.001 &&
    (index === 0 || caption.start_seconds >= captions[index - 1].end_seconds - 0.001) &&
    (!scenes || captionScene(caption, scenes)) && validCaptionText(caption.text, requestText));
}
