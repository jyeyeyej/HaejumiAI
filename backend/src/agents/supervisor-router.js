const RULES = [
  { module_id: 'blog', patterns: [/\bblog\b/i, /블로그/, /포스팅/] },
  { module_id: 'music', patterns: [/\bmusic\b/i, /음악\s*(작곡|만들|생성)/, /작곡/] },
  { module_id: 'creator', patterns: [/쇼츠|릴스|틱톡|유튜브|영상|자막|콘텐츠 기획|shorts|reel|video/i] },
  { module_id: 'schedule', patterns: [/일정|약속|캘린더|스케줄|schedule/i] },
  { module_id: 'wellness', patterns: [/웰니스|건강|수면|운동|컨디션|감정|기분|wellness/i] },
  { module_id: 'diary', patterns: [/일기|하루 기록|하루를 정리|회고|diary/i] },
];

export class SupervisorRouter {
  constructor(registry) { this.registry = registry; }

  route(text) {
    if (typeof text !== 'string' || !text.trim()) return { status: 'needs_clarification', module_id: null, capability_id: null, reason: 'empty_request' };
    if (/(기분|감정|우울|힘들|슬프|속상|걱정|외롭|안녕|고마워|감사해)/.test(text) &&
        !/(기록|저장|등록|조회|요약|작성|일기|쇼츠|영상|일정\s*(?:추가|확인|알려))/.test(text)) {
      return { status: 'conversation', module_id: null, capability_id: null, reason: 'personal_talk' };
    }
    const hits = RULES.filter((rule) => rule.patterns.some((pattern) => pattern.test(text)));
    if (hits.length === 0) return { status: 'conversation', module_id: null, capability_id: null, reason: 'free_talk' };
    if (hits.length > 1) return { status: 'needs_clarification', module_id: null, capability_id: null, reason: 'ambiguous_request', candidates: hits.map((hit) => hit.module_id) };
    const module = this.registry.get(hits[0].module_id);
    const capability = module?.capability_ids[0] ?? null;
    if (!module) return { status: 'unsupported', module_id: null, capability_id: null, reason: 'unregistered' };
    if (module.status !== 'enabled') return { status: module.status === 'disabled' ? 'disabled' : 'not_implemented', module_id: module.module_id, capability_id: capability, reason: module.implementation_status };
    return { status: 'routed', module_id: module.module_id, capability_id: capability, reason: 'rule_match' };
  }
}
