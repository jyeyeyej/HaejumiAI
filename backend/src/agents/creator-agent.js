export class CreatorAgent {
  constructor({ gateway }) { this.gateway = gateway; }

  async createPlan({ taskId, project, media, requestText, revision = false }) {
    const minimizedMedia = media.map(({ mediaId, mediaType }) => ({ media_id: mediaId, media_type: mediaType }));
    const result = await this.gateway.generate({ taskId, revision, dataCategories: ['user_text', 'selected_media'],
      resourceIds: media.map((item) => item.mediaId), prompt: 'Create a concise Korean vertical short-video storyboard and timed Korean caption draft. Return JSON only.',
      input: { request: requestText, target_seconds: project.target_seconds, media: minimizedMedia } });
    if (result.available && validPlan(result.output, project, media)) {
      return { plan: result.output.plan, captions: result.output.captions, generation: { source: this.gateway.provider?.mode === 'mock' ? 'mock' : 'gateway', fallback_used: false,
        llm_calls: result.usage.calls_for_task, estimated_cost_usd: result.usage.estimated_cost_usd, gate_reason: null } };
    }
    return { ...makeRuleBasedPlan(project, media, requestText), generation: { source: 'local_rules', fallback_used: true,
      llm_calls: result.usage.calls_for_task, estimated_cost_usd: result.usage.estimated_cost_usd, gate_reason: result.reason ?? 'INVALID_MODEL_OUTPUT' } };
  }
}

function makeRuleBasedPlan(project, media, requestText) {
  const duration = project.target_seconds;
  const title = deriveTitle(requestText);
  const scenes = media.map((item, index) => {
    const start = roundTime((duration * index) / media.length);
    const end = index === media.length - 1 ? duration : roundTime((duration * (index + 1)) / media.length);
    return { order: index + 1, media_id: item.mediaId, media_type: item.mediaType, start_seconds: start, end_seconds: end,
      visual_direction: item.mediaType.startsWith('video/') ? '선택한 영상에서 핵심 장면을 사용합니다.' : '사진 전체가 보이도록 배치하고 초점을 확인합니다.',
      caption_text: index === 0 ? title : `장면 ${index + 1}을 소개합니다.` };
  });
  const captions = scenes.map(({ order, start_seconds, end_seconds, caption_text }) => ({ order, start_seconds, end_seconds, text: caption_text }));
  return { plan: { title_idea: title, format: 'vertical_short', aspect_ratio: '9:16', target_seconds: duration, scenes }, captions };
}

function validPlan(value, project, media) {
  return value && typeof value.plan === 'object' && Array.isArray(value.plan.scenes) && Array.isArray(value.captions) &&
    value.plan.target_seconds === project.target_seconds && value.plan.aspect_ratio === '9:16' &&
    typeof value.plan.title_idea === 'string' && value.plan.title_idea.length <= 64 && value.plan.scenes.length === media.length &&
    value.plan.scenes.every((scene, index) => scene.order === index + 1 && scene.media_id === media[index].mediaId && scene.media_type === media[index].mediaType &&
      Number.isFinite(scene.start_seconds) && Number.isFinite(scene.end_seconds) && scene.start_seconds < scene.end_seconds &&
      scene.start_seconds >= 0 && scene.end_seconds <= project.target_seconds && typeof scene.visual_direction === 'string' &&
      scene.visual_direction.length <= 500 && typeof scene.caption_text === 'string' && scene.caption_text.length <= 500) &&
    value.captions.length === media.length && value.captions.every((caption, index) => caption.order === index + 1 &&
      Number.isFinite(caption.start_seconds) && Number.isFinite(caption.end_seconds) && caption.start_seconds < caption.end_seconds &&
      caption.start_seconds >= 0 && caption.end_seconds <= project.target_seconds && typeof caption.text === 'string' && caption.text.length <= 500);
}

function deriveTitle(text) {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  return cleaned.length > 64 ? `${cleaned.slice(0, 61)}…` : cleaned;
}

function roundTime(value) { return Math.round(value * 100) / 100; }
