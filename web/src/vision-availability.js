export function visionAvailability(usage) {
  if (!usage) return { ready: false, message: '서버의 AI 설정을 확인하고 있습니다.' };
  if (usage.enabled && usage.provider_ready) return { ready: true, message: 'Vision을 사용할 수 있습니다. 선택 미디어 전송은 동의 후 버튼을 누를 때만 시작됩니다.' };
  const messages = {
    LLM_SWITCH_OFF: '서버의 HAEJUMI_LLM_ENABLED 설정이 꺼져 있습니다.',
    LIVE_SWITCH_OFF: '외부 호출 안전 스위치 HAEJUMI_OPENAI_LIVE_ENABLED가 꺼져 있습니다. 설정 후 백엔드를 재시작해야 합니다.',
    PROVIDER_CONFIG_MISSING: 'OpenAI 키 또는 모델 설정을 확인해 주세요. 비밀값은 화면에 표시하지 않습니다.',
  };
  return { ready: false, message: messages[usage.availability_reason] ?? '서버에서 Vision을 사용할 수 없습니다. 로컬 기획안은 계속 사용할 수 있습니다.' };
}
