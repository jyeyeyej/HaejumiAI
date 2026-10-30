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
          visual_direction: 'Mock 장면 제안', caption_text: `Mock 자막 ${index + 1}` };
      });
      return { plan: { title_idea: 'Mock 쇼츠 기획', format: 'vertical_short', aspect_ratio: '9:16', target_seconds: duration, scenes },
        captions: scenes.map(({ order, start_seconds, end_seconds, caption_text }) => ({ order, start_seconds, end_seconds, text: caption_text })) };
    },
  };
  return provider;
}
