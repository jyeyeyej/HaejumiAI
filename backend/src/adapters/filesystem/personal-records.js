import { createHash, randomUUID } from 'node:crypto';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (status, code) => { const error = new Error(code); error.status = status; error.code = code; throw error; };
const day = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const instant = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s));
const keys = (v, allowed) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => allowed.includes(k));
const safe = (row) => { const { owner_id: _owner, ...value } = row; return structuredClone(value); };
const dateAt = (value) => new Date(`${value}T00:00:00Z`);
const addDays = (value, count) => { const date = dateAt(value); date.setUTCDate(date.getUTCDate() + count); return date.toISOString().slice(0, 10); };
const addMonths = (value, count) => { const [year, month, dayOfMonth] = value.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1 + count, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(dayOfMonth, last)); return first.toISOString().slice(0, 10); };

export class PersonalRecords {
  constructor(state) { this.state = state; for (const name of ['scheduleEvents', 'wellnessEntries', 'diaryDrafts', 'diaryEntries', 'personalApprovals']) state.data[name] ??= {}; }
  idem(owner, scope, key, input, action) {
    if (typeof key !== 'string' || key.length < 16 || key.length > 200) fail(422, 'VALIDATION_ERROR');
    const slot = `${owner}:personal:${scope}:${key}`, fingerprint = digest(input), prior = this.state.data.idempotency[slot];
    if (prior) { if (prior.fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT'); return structuredClone(prior.result); }
    const result = action(); this.state.data.idempotency[slot] = { fingerprint, result }; this.state.save(); return structuredClone(result);
  }
  owned(bucket, owner, id) { const row = this.state.data[bucket][id]; if (!row || row.owner_id !== owner || row.status === 'deleted') fail(404, 'RESOURCE_NOT_FOUND'); return row; }
  get(bucket, owner, id) { return safe(this.owned(bucket, owner, id)); }
  list(bucket, owner, date) {
    if (date && !day(date)) fail(422, 'VALIDATION_ERROR');
    return { items: Object.values(this.state.data[bucket]).filter((row) => row.owner_id === owner && row.status !== 'deleted' &&
      (!date || row.date === date || row.start_at?.slice(0, 10) === date)).map(safe) };
  }
  occurrences(owner, from, to) {
    if (!day(from) || !day(to) || to < from || (dateAt(to) - dateAt(from)) > 366 * 86400000) fail(422, 'VALIDATION_ERROR');
    const items = [];
    for (const row of Object.values(this.state.data.scheduleEvents)) {
      if (row.owner_id !== owner || row.status !== 'active') continue;
      const first = row.start_at.slice(0, 10), rule = row.recurrence;
      const max = rule ? (rule.until < to ? rule.until : to) : (first < to ? first : to);
      for (let index = 0; index < 1000; index++) {
        if (!rule && index > 0) break;
        const date = !rule ? first : rule.frequency === 'daily' ? addDays(first, index * rule.interval) :
          rule.frequency === 'weekly' ? addDays(first, index * rule.interval * 7) : addMonths(first, index * rule.interval);
        if (date > max) break;
        if (date < from) continue;
        const shift = dateAt(date) - dateAt(first);
        items.push({ event_id: row.event_id, date, title: row.title, start_at: new Date(Date.parse(row.start_at) + shift).toISOString(),
          end_at: new Date(Date.parse(row.end_at) + shift).toISOString(), version: row.version, recurrence: rule });
        if (items.length > 2000) fail(422, 'VALIDATION_ERROR');
      }
    }
    items.sort((a, b) => a.start_at.localeCompare(b.start_at) || a.event_id.localeCompare(b.event_id));
    return { from, to, items, notification_delivery: 'not_implemented' };
  }
  scheduleInput(v) {
    if (!keys(v, ['title', 'start_at', 'end_at', 'notes', 'recurrence', 'reminder_minutes']) ||
      typeof v.title !== 'string' || !v.title.trim() || v.title.length > 200 || !instant(v.start_at) || !instant(v.end_at) ||
      Date.parse(v.end_at) <= Date.parse(v.start_at) || Date.parse(v.end_at) - Date.parse(v.start_at) > 7 * 86400000 ||
      (v.notes !== undefined && (typeof v.notes !== 'string' || v.notes.length > 4000)) ||
      (v.reminder_minutes !== undefined && v.reminder_minutes !== null && (!Number.isInteger(v.reminder_minutes) || v.reminder_minutes < 0 || v.reminder_minutes > 10080)) ||
      (v.recurrence !== undefined && v.recurrence !== null && (!keys(v.recurrence, ['frequency', 'interval', 'until']) ||
        !['daily', 'weekly', 'monthly'].includes(v.recurrence.frequency) || !Number.isInteger(v.recurrence.interval) ||
        v.recurrence.interval < 1 || v.recurrence.interval > 365 || !day(v.recurrence.until) || v.recurrence.until < v.start_at.slice(0, 10)))) fail(422, 'VALIDATION_ERROR');
  }
  createSchedule(owner, v, key) { this.scheduleInput(v); return this.idem(owner, 'schedule:create', key, v, () => {
    const id = randomUUID(), now = new Date().toISOString(), row = { event_id: id, owner_id: owner, ...structuredClone(v),
      recurrence: v.recurrence ?? null, reminder_minutes: v.reminder_minutes ?? null, version: 1, status: 'active', created_at: now, updated_at: now };
    this.state.data.scheduleEvents[id] = row; return safe(row);
  }); }
  editSchedule(owner, id, v, key) {
    if (!keys(v, ['version', 'title', 'start_at', 'end_at', 'notes', 'recurrence', 'reminder_minutes']) || !Number.isInteger(v.version)) fail(422, 'VALIDATION_ERROR');
    return this.idem(owner, `schedule:edit:${id}`, key, v, () => {
      const row = this.owned('scheduleEvents', owner, id); if (row.version !== v.version) fail(409, 'VERSION_CONFLICT');
      const { version: _version, ...changes } = v;
      this.scheduleInput({ title: row.title, start_at: row.start_at, end_at: row.end_at, notes: row.notes,
        recurrence: row.recurrence, reminder_minutes: row.reminder_minutes, ...changes });
      Object.assign(row, structuredClone(changes), { version: row.version + 1, updated_at: new Date().toISOString() }); return safe(row);
    });
  }
  validateWellness(v) {
    if (!keys(v, ['date', 'mood', 'sleep_hours', 'activity_minutes', 'habits', 'note']) || !day(v.date) ||
      !['very_low', 'low', 'neutral', 'good', 'very_good'].includes(v.mood) ||
      (v.sleep_hours != null && (!Number.isFinite(v.sleep_hours) || v.sleep_hours < 0 || v.sleep_hours > 24)) ||
      (v.activity_minutes != null && (!Number.isInteger(v.activity_minutes) || v.activity_minutes < 0 || v.activity_minutes > 1440)) ||
      (v.habits !== undefined && (!Array.isArray(v.habits) || v.habits.length > 20 || v.habits.some((x) => typeof x !== 'string' || x.length > 80))) ||
      (v.note !== undefined && (typeof v.note !== 'string' || v.note.length > 4000))) fail(422, 'VALIDATION_ERROR');
  }
  createWellness(owner, v, key) { this.validateWellness(v); return this.idem(owner, 'wellness:create', key, v, () => {
    const id = randomUUID(), now = new Date().toISOString(), row = { entry_id: id, owner_id: owner, ...structuredClone(v),
      sleep_hours: v.sleep_hours ?? null, activity_minutes: v.activity_minutes ?? null, habits: v.habits ?? [], note: v.note ?? '',
      version: 1, status: 'active', created_at: now, updated_at: now };
    this.state.data.wellnessEntries[id] = row; return safe(row);
  }); }
  editWellness(owner, id, v, key) {
    if (!keys(v, ['version', 'date', 'mood', 'sleep_hours', 'activity_minutes', 'habits', 'note']) || !Number.isInteger(v.version)) fail(422, 'VALIDATION_ERROR');
    return this.idem(owner, `wellness:edit:${id}`, key, v, () => {
      const row = this.owned('wellnessEntries', owner, id); if (row.version !== v.version) fail(409, 'VERSION_CONFLICT');
      const { version: _version, ...changes } = v;
      this.validateWellness({ date: row.date, mood: row.mood, sleep_hours: row.sleep_hours, activity_minutes: row.activity_minutes,
        habits: row.habits, note: row.note, ...changes });
      Object.assign(row, structuredClone(changes), { version: row.version + 1, updated_at: new Date().toISOString() }); return safe(row);
    });
  }
  remove(bucket, owner, id, version, key) { return this.idem(owner, `delete:${bucket}:${id}`, key, { version }, () => {
    const row = this.owned(bucket, owner, id); if (row.version !== version) fail(409, 'VERSION_CONFLICT');
    row.status = 'deleted'; row.version++; row.updated_at = new Date().toISOString(); return { id, status: 'deleted' };
  }); }
  summary(owner, from, to) {
    if (!day(from) || !day(to) || to < from || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 366 * 86400000) fail(422, 'VALIDATION_ERROR');
    const items = this.list('wellnessEntries', owner).items.filter((x) => x.date >= from && x.date <= to);
    const avg = (field) => { const values = items.map((x) => x[field]).filter((x) => typeof x === 'number'); return values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : null; };
    return { from, to, count: items.length, average_sleep_hours: avg('sleep_hours'), average_activity_minutes: avg('activity_minutes'),
      mood_counts: Object.fromEntries(['very_low', 'low', 'neutral', 'good', 'very_good'].map((m) => [m, items.filter((x) => x.mood === m).length])),
      notice: '생활 기록 요약이며 의료 진단이나 치료 권고가 아닙니다.' };
  }
  createDraft(owner, v, key) {
    if (!keys(v, ['date', 'allowed_source_ids', 'tone', 'user_notes']) || !day(v.date) || !Array.isArray(v.allowed_source_ids) ||
      v.allowed_source_ids.length > 30 || v.allowed_source_ids.some((id) => typeof id !== 'string') ||
      new Set(v.allowed_source_ids).size !== v.allowed_source_ids.length ||
      (v.tone !== undefined && (typeof v.tone !== 'string' || v.tone.length > 80)) ||
      (v.user_notes !== undefined && (typeof v.user_notes !== 'string' || v.user_notes.length > 4000))) fail(422, 'VALIDATION_ERROR');
    const sources = v.allowed_source_ids.map((id) => {
      const e = this.state.data.scheduleEvents[id], w = this.state.data.wellnessEntries[id];
      const row = e?.owner_id === owner && e.status === 'active' && e.start_at.slice(0, 10) === v.date ? e :
        w?.owner_id === owner && w.status === 'active' && w.date === v.date ? w : null;
      if (!row) fail(404, 'RESOURCE_NOT_FOUND'); return row;
    });
    return this.idem(owner, 'diary:create', key, v, () => {
      const id = randomUUID();
      const facts = sources.map((x) => x.event_id ? `일정: ${x.title}` : `기분: ${x.mood}${x.sleep_hours == null ? '' : `, 수면 ${x.sleep_hours}시간`}`);
      const body = [v.user_notes?.trim(), ...facts].filter(Boolean).join('\n') || '오늘의 기록을 직접 작성해 주세요.';
      const row = { draft_id: id, owner_id: owner, date: v.date, allowed_source_ids: [...v.allowed_source_ids], tone: v.tone ?? '',
        body, content_version: 1, content_hash: digest({ date: v.date, body }), status: 'draft',
        history: [{ content_version: 1, body, at: new Date().toISOString() }] };
      this.state.data.diaryDrafts[id] = row; return safe(row);
    });
  }
  factsForDraft(owner, draftId) {
    const draft = this.owned('diaryDrafts', owner, draftId);
    return draft.allowed_source_ids.map((id) => {
      const event = this.state.data.scheduleEvents[id];
      if (event?.owner_id === owner && event.status === 'active' && event.start_at.slice(0, 10) === draft.date) {
        return { kind: 'schedule', title: event.title.slice(0, 200) };
      }
      const wellness = this.state.data.wellnessEntries[id];
      if (wellness?.owner_id === owner && wellness.status === 'active' && wellness.date === draft.date) {
        return { kind: 'wellness', mood: wellness.mood, sleep_hours: wellness.sleep_hours ?? null,
          activity_minutes: wellness.activity_minutes ?? null };
      }
      fail(404, 'RESOURCE_NOT_FOUND');
    });
  }
  applyGeneratedDraft(owner, draftId, body) {
    const row = this.owned('diaryDrafts', owner, draftId);
    if (row.status !== 'draft' || row.content_version !== 1 || typeof body !== 'string' || !body.trim() || body.length > 4000) fail(422, 'VALIDATION_ERROR');
    row.body = body.trim(); row.content_version = 2; row.content_hash = digest({ date: row.date, body: row.body });
    row.history.push({ content_version: 2, body: row.body, at: new Date().toISOString() });
    this.state.save(); return safe(row);
  }
  reviseDraft(owner, id, v, key) {
    if (!keys(v, ['base_content_version', 'feedback']) || !Number.isInteger(v.base_content_version) || typeof v.feedback !== 'string' ||
      !v.feedback.trim() || v.feedback.length > 4000) fail(422, 'VALIDATION_ERROR');
    return this.idem(owner, `diary:revise:${id}`, key, v, () => {
      const row = this.owned('diaryDrafts', owner, id);
      if (row.status === 'finalized' || row.content_version !== v.base_content_version) fail(409, 'VERSION_CONFLICT');
      row.body = v.feedback; row.content_version++; row.content_hash = digest({ date: row.date, body: row.body }); row.status = 'draft';
      row.history.push({ content_version: row.content_version, body: row.body, at: new Date().toISOString() });
      for (const a of Object.values(this.state.data.personalApprovals)) if (a.draft_id === id && a.status === 'active') a.status = 'invalidated';
      return safe(row);
    });
  }
  beginEntryRevision(owner, entryId, v, key) {
    if (!keys(v, ['version']) || !Number.isSafeInteger(v.version) || v.version < 1) fail(422, 'VALIDATION_ERROR');
    return this.idem(owner, `diary:entry-revision:${entryId}`, key, v, () => {
      const entry = this.owned('diaryEntries', owner, entryId);
      if (entry.version !== v.version) fail(409, 'VERSION_CONFLICT');
      const draftId = randomUUID(), now = new Date().toISOString();
      const draft = { draft_id: draftId, owner_id: owner, date: entry.date, allowed_source_ids: [], tone: '',
        revises_entry_id: entryId, base_entry_version: entry.version, body: entry.body,
        content_version: entry.approved_content_version + 1, content_hash: digest({ date: entry.date, body: entry.body }), status: 'draft',
        history: [{ content_version: entry.approved_content_version + 1, body: entry.body, at: now }] };
      this.state.data.diaryDrafts[draftId] = draft; return safe(draft);
    });
  }
  approveDraft(owner, id, v, key) {
    if (!keys(v, ['content_version', 'content_hash', 'approval_scope']) || !['continue', 'final_diary'].includes(v?.approval_scope)) fail(422, 'VALIDATION_ERROR');
    return this.idem(owner, `diary:approve:${id}`, key, v, () => {
      const row = this.owned('diaryDrafts', owner, id);
      if (row.status === 'finalized' || v.content_version !== row.content_version || v.content_hash !== row.content_hash) fail(409, 'VERSION_CONFLICT');
      if (v.approval_scope === 'final_diary' && !Object.values(this.state.data.personalApprovals).some((a) =>
        a.draft_id === id && a.status === 'active' && a.content_version === row.content_version && a.approval_scope === 'continue')) fail(409, 'INVALID_STATE_TRANSITION');
      const a = { approval_id: randomUUID(), draft_id: id, owner_id: owner, content_version: row.content_version,
        content_hash: row.content_hash, approval_scope: v.approval_scope, status: 'active', approved_at: new Date().toISOString() };
      this.state.data.personalApprovals[a.approval_id] = a; row.status = 'review_required'; return safe(a);
    });
  }
  finalizeDraft(owner, id, v, key) {
    if (!keys(v, ['content_version', 'content_hash', 'approval_id']) || typeof v.approval_id !== 'string') fail(422, 'VALIDATION_ERROR');
    return this.idem(owner, `diary:finalize:${id}`, key, v, () => {
      const row = this.owned('diaryDrafts', owner, id);
      if (row.status === 'finalized' || v.content_version !== row.content_version || v.content_hash !== row.content_hash) fail(409, 'VERSION_CONFLICT');
      const a = this.state.data.personalApprovals[v.approval_id];
      if (!a || a.owner_id !== owner || a.draft_id !== id || a.status !== 'active' || a.approval_scope !== 'final_diary' ||
        a.content_version !== row.content_version || a.content_hash !== row.content_hash) fail(409, 'APPROVAL_SCOPE_MISMATCH');
      if (row.revises_entry_id) {
        const entry = this.owned('diaryEntries', owner, row.revises_entry_id);
        if (entry.version !== row.base_entry_version) fail(409, 'VERSION_CONFLICT');
        entry.history ??= [{ version: entry.version, body: entry.body, content_hash: entry.content_hash, finalized_at: entry.finalized_at }];
        entry.body = row.body; entry.content_hash = row.content_hash; entry.approved_content_version = row.content_version;
        entry.version++; entry.finalized_at = new Date().toISOString();
        entry.history.push({ version: entry.version, body: entry.body, content_hash: entry.content_hash, finalized_at: entry.finalized_at });
        row.status = 'finalized'; return safe(entry);
      }
      const entry = { entry_id: randomUUID(), owner_id: owner, draft_id: id, date: row.date, body: row.body,
        approved_content_version: row.content_version, content_hash: row.content_hash, finalized_at: new Date().toISOString(), status: 'saved', version: 1,
        history: [{ version: 1, body: row.body, content_hash: row.content_hash, finalized_at: new Date().toISOString() }] };
      this.state.data.diaryEntries[entry.entry_id] = entry; row.status = 'finalized'; return safe(entry);
    });
  }
}
