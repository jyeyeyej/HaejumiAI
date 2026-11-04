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

export function visionGenerationMessage(generation) {
  if (generation?.source === 'gateway' && !generation.fallback_used) return 'OpenAI Vision 기획안이 생성됐습니다. 장면과 자막을 확인한 뒤 승인해 주세요.';
  if (generation?.source === 'gateway') return 'OpenAI 응답 중 검증된 장면과 자막만 부분 반영했습니다. 승인 전에 내용을 확인해 주세요.';
  if (generation?.source === 'mock') return 'Mock Vision 기획안입니다. 실제 OpenAI 분석 결과가 아닙니다.';
  const reasons = {
    LLM_BUDGET_EXCEEDED: 'AI 사용 한도 때문에 이번 Vision 요청은 OpenAI로 전송되지 않았습니다. 자막 없는 로컬 기획안이 저장됐습니다.',
    INVALID_MODEL_OUTPUT: 'OpenAI 응답이 기획·자막 검증을 통과하지 못했습니다. 자막 없는 로컬 기획안이 저장됐습니다.',
    SERVICE_UNAVAILABLE: 'AI 서비스 요청에 실패해 자막 없는 로컬 기획안이 저장됐습니다. 실제 전송 여부는 확인되지 않습니다.',
    OPENAI_AUTH_FAILED: 'OpenAI가 인증 또는 권한 오류를 반환했습니다. 자막 없는 로컬 기획안이 저장됐습니다.',
    OPENAI_REQUEST_INVALID: 'OpenAI가 요청 형식을 거부했습니다. 자막 없는 로컬 기획안이 저장됐습니다.',
    OPENAI_NOT_FOUND: 'OpenAI가 요청한 리소스를 찾지 못했습니다. 모델 또는 API 경로를 확인해 주세요.',
    OPENAI_PROVIDER_ERROR: 'OpenAI 서버 오류가 반환됐습니다. 자막 없는 로컬 기획안이 저장됐습니다.',
    OPENAI_TIMEOUT: 'OpenAI 응답 대기 시간이 초과됐습니다. 자동 재시도하지 않았습니다.',
    OPENAI_NETWORK_ERROR: 'OpenAI 연결 중 오류가 발생했습니다. 공급자 도달 여부는 확인되지 않습니다.',
    OPENAI_RESPONSE_INVALID: 'OpenAI 응답을 JSON으로 읽지 못했습니다. 자막 없는 로컬 기획안이 저장됐습니다.',
    CONSENT_REQUIRED: 'Vision 동의가 확인되지 않아 외부 분석 없이 로컬 기획안이 저장됐습니다.',
    LOCAL_MEDIA_PREPARATION_UNAVAILABLE: '선택 미디어를 분석용으로 준비하지 못해 외부 분석 없이 로컬 기획안이 저장됐습니다.',
  };
  return reasons[generation?.gate_reason] ?? '외부 Vision 분석 없이 로컬 기획안이 저장됐습니다. 자막을 직접 작성할 수 있습니다.';
}
