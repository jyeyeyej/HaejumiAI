import { randomUUID } from 'node:crypto';

const date = '(\\d{4}-\\d{2}-\\d{2})';
const time = '(\\d{2}:\\d{2})';
const MOODS = { '매우 나쁨': 'very_low', '나쁨': 'low', '보통': 'neutral', '좋음': 'good', '매우 좋음': 'very_good' };
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const error = (status, code) => { throw Object.assign(new Error(code), { status, code }); };

export class LocalAssistant {
  constructor(state, personal) { this.state = state; this.personal = personal; state.data.assistantProposals ??= {}; state.data.assistantHistory ??= {}; }

  history(owner) {
    const cutoff = Date.now() - 30 * 24 * 3600_000;
    const existing = this.state.data.assistantHistory[owner] ?? [];
    const current = existing.filter((item) => Date.parse(item.created_at) >= cutoff);
    if (current.length !== existing.length) { this.state.data.assistantHistory[owner] = current; this.state.save(); }
    return current
      .map(({ message_id, text, reply, created_at }) => ({ message_id, text, reply, created_at }));
  }

  remember(owner, key, text, reply) {
    const items = this.history(owner);
    if (!items.some((item) => item.message_id === key)) items.push({ message_id: key, text, reply, created_at: new Date().toISOString() });
    this.state.data.assistantHistory[owner] = items.slice(-100);
    this.state.save();
  }

  clearHistory(owner) { this.state.data.assistantHistory[owner] = []; this.state.save(); }

  previewIncompleteSchedule(command) {
    const match = new RegExp(`^일정\\s*등록\\s+${date}\\s+${time}\\s+종료시간미정\\s+(.+)$`).exec(command);
    if (!match || !validDate(match[1]) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(match[2]) || !match[3].trim() || match[3].length > 200) return null;
    return { status: 'needs_clarification', route: 'schedule', agent_id: 'schedule', capability_id: 'schedule.manage',
      reply: `${match[1]} ${match[2]}에 시작하는 ${match[3].trim()} 일정으로 이해했습니다. 몇 시에 끝나는지 알려주시고 날짜·제목도 확인해 주세요. 아직 저장하지 않았습니다.`,
      actions: [{ kind: 'schedule_create', planned_action: { date: match[1], start_time: match[2], title: match[3].trim(), missing_fields: ['end_time'] } }] };
  }

  parse(command) {
    let match = new RegExp(`^일정\\s*등록\\s+${date}\\s+${time}\\s+${time}\\s+(.+)$`).exec(command);
    if (match) return { kind: 'schedule_create', body: { title: match[4].trim(), start_at: `${match[1]}T${match[2]}:00+09:00`, end_at: `${match[1]}T${match[3]}:00+09:00` } };
    match = new RegExp(`^일정\\s*조회\\s+${date}$`).exec(command);
    if (match) return { kind: 'schedule_read', date: match[1] };
    match = new RegExp(`^(?:기분|생활)\\s*기록\\s+${date}\\s+(매우 좋음|매우 나쁨|좋음|나쁨|보통)(?:\\s+(.+))?$`).exec(command);
    if (match) return { kind: 'wellness_create', body: { date: match[1], mood: MOODS[match[2]], note: match[3] ?? '' } };
    match = new RegExp(`^생활\\s*조회\\s+${date}$`).exec(command);
    if (match) return { kind: 'wellness_read', date: match[1] };
    match = new RegExp(`^일기\\s*초안\\s+${date}\\s+(.+)$`).exec(command);
    if (match) return { kind: 'diary_create', body: { date: match[1], allowed_source_ids: [], user_notes: match[2].trim() } };
    match = new RegExp(`^일기\\s*조회\\s+${date}$`).exec(command);
    if (match) return { kind: 'diary_read', date: match[1] };
    return null;
  }

  prepare(owner, text) {
    const parts = text.split(';').map((part) => part.trim()).filter(Boolean);
    if (parts.length < 1 || parts.length > 4) return { status: 'needs_clarification', reply: '한 번에 최대 네 작업을 세미콜론으로 구분해 입력해 주세요.' };
    const actions = parts.map((part) => this.parse(part));
    if (actions.some((action) => !action)) return { status: 'needs_clarification', reply: '정해진 명령 형식으로 날짜와 내용을 적어 주세요. 예: 일정 등록 2026-11-03 09:00 10:00 산책' };
    const checked = actions.map((action) => {
      if (action.kind === 'schedule_read') return { kind: action.kind, result: this.personal.occurrences(owner, action.date, action.date) };
      if (action.kind === 'wellness_read') return { kind: action.kind, result: this.personal.list('wellnessEntries', owner, action.date) };
      if (action.kind === 'diary_read') return { kind: action.kind, result: this.personal.list('diaryEntries', owner, action.date) };
      if (action.kind === 'schedule_create') this.personal.scheduleInput(action.body);
      if (action.kind === 'wellness_create') this.personal.validateWellness(action.body);
      if (action.kind === 'diary_create' && (!validDate(action.body.date) || !action.body.user_notes || action.body.user_notes.length > 4000)) error(422, 'VALIDATION_ERROR');
      return action;
    });
    const results = checked.map((action) => {
      if (action.result) return action;
      const proposalId = randomUUID();
      this.state.data.assistantProposals[proposalId] = { proposal_id: proposalId, owner_id: owner, action, status: 'pending', created_at: new Date().toISOString() };
      return { kind: action.kind, proposal_id: proposalId, planned_action: action.body };
    });
    this.state.save();
    return { status: results.some((item) => item.proposal_id) ? 'needs_confirmation' : 'completed_read',
      reply: results.some((item) => item.proposal_id) ? '실행 예정 작업을 확인해 주세요. 각 작업은 확인 버튼을 누르기 전까지 저장되지 않습니다.' : '요청하신 로컬 기록을 조회했습니다.',
      actions: results };
  }

  confirm(owner, proposalId, key) {
    const proposal = this.state.data.assistantProposals[proposalId];
    if (!proposal || proposal.owner_id !== owner) error(404, 'RESOURCE_NOT_FOUND');
    return this.personal.idem(owner, `assistant:confirm:${proposalId}`, key, { proposalId }, () => {
      if (proposal.status !== 'pending' || Date.now() - Date.parse(proposal.created_at) > 3600_000) error(409, 'INVALID_STATE_TRANSITION');
      const { kind, body } = proposal.action;
      const result = kind === 'schedule_create' ? this.personal.createSchedule(owner, body, key) :
        kind === 'wellness_create' ? this.personal.createWellness(owner, body, key) :
        kind === 'diary_create' ? this.personal.createDraft(owner, body, key) : null;
      if (!result) error(422, 'VALIDATION_ERROR');
      proposal.status = 'confirmed'; return { kind, result };
    });
  }
}
