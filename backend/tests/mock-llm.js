export function createMockLLMProvider() {
  const provider = {
    mode: 'mock',
    calls: 0,
    async estimateCostUsd() { return 0.001; },
    async generateStructured({ input }) {
      this.calls += 1;
      if (!Array.isArray(input?.media)) return { mock_result: true };
      const duration = input.target_seconds;
      const scenes = input.media.map((media, index) => {
        const start = Math.round(duration * index / input.media.length * 100) / 100;
        const end = index === input.media.length - 1 ? duration : Math.round(duration * (index + 1) / input.media.length * 100) / 100;
        return { order: index + 1, media_id: media.media_id, media_type: media.media_type, start_seconds: start, end_seconds: end,
          visual_direction: 'Mock 장면 제안', caption_text: `Mock 자막 ${index + 1}`,
          framing: 'inherit', motion: 'static', transition: 'cut', subtitle_style: 'default', bgm_mood: '', edit_reason: '합성 테스트 기본값' };
      });
      return { plan: { title_idea: 'Mock 쇼츠 기획', format: 'vertical_short', aspect_ratio: '9:16', target_seconds: duration,
        theme: '선택한 미디어의 짧은 이야기', opening_hook: '오늘의 순간을 볼까요?', story_flow: '선택한 순서대로 보여줍니다.', mood: '밝음', ending_line: '다음에도 함께해요',
        recommended_media_order: input.media.map((media) => media.media_id),
        media_insights: input.media.map((media) => ({ media_id: media.media_id, description: '합성 테스트 미디어입니다.', mood: '밝음',
          subjects: [], usable_detail: '색상과 구도', uncertainty: '', category: 'unknown', orientation: 'unknown' })), scenes },
        captions: scenes.map(({ order, start_seconds, end_seconds, caption_text }) => ({ order, start_seconds, end_seconds, text: caption_text })) };
    },
  };
  return provider;
}
