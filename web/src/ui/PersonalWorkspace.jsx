import React, { useCallback, useEffect, useState } from 'react';

const paths = { schedule: 'schedule/events', wellness: 'wellness/entries', diary: 'diaries/drafts' };
const today = () => new Date().toLocaleDateString('sv-SE');
const withLocalOffset = (value) => {
  const minutes = -new Date(value).getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  return `${value}:00${sign}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
};

export function PersonalWorkspace({ api, kind }) {
  const [items, setItems] = useState([]);
  const [saved, setSaved] = useState([]);
  const [occurrences, setOccurrences] = useState([]);
  const [date, setDate] = useState(today());
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [frequency, setFrequency] = useState('none');
  const [until, setUntil] = useState('');
  const [mood, setMood] = useState('neutral');
  const [sleep, setSleep] = useState('');
  const [activity, setActivity] = useState('');
  const [summary, setSummary] = useState(null);
  const [note, setNote] = useState('');
  const [selectedSources, setSelectedSources] = useState([]);
  const [sources, setSources] = useState([]);
  const [diaryAiNotice, setDiaryAiNotice] = useState(null);
  const [useDiaryAi, setUseDiaryAi] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSelectedSources([]); setUseDiaryAi(false); }, [date, kind]);
  useEffect(() => { if (api && kind === 'diary') api.privacyNotice('diary_draft').then(setDiaryAiNotice).catch(() => setDiaryAiNotice(null)); }, [api, kind]);

  const reload = useCallback(async () => {
    if (!api) return;
    const result = await api.personalList(paths[kind], date);
    setItems(result.items);
    if (kind === 'diary') setSaved((await api.personalList('diaries/entries', date)).items);
    if (kind === 'schedule') setOccurrences((await api.scheduleOccurrences(date, date)).items);
    if (kind === 'wellness') setSummary(await api.wellnessSummary(date, date));
    if (kind === 'diary') {
      const [events, wellness] = await Promise.all([api.personalList('schedule/events', date), api.personalList('wellness/entries', date)]);
      setSources([...events.items, ...wellness.items]);
    }
  }, [api, kind, date]);
  useEffect(() => { reload().catch((error) => setMessage(error.message)); }, [reload]);

  async function run(action, success) {
    setBusy(true); setMessage('서버에 저장하고 있습니다.');
    try { await action(); await reload(); setMessage(success); }
    catch (error) { setMessage(error.message); if (error.status === 409) await reload().catch(() => {}); }
    finally { setBusy(false); }
  }

  async function create(event) {
    event.preventDefault();
    if (!api) return;
    await run(async () => {
      if (kind === 'schedule') await api.personalCreate(paths.schedule, { title, start_at: withLocalOffset(start), end_at: withLocalOffset(end),
        ...(frequency === 'none' ? {} : { recurrence: { frequency, interval: 1, until } }) });
      if (kind === 'wellness') await api.personalCreate(paths.wellness, { date, mood, sleep_hours: sleep === '' ? null : Number(sleep),
        activity_minutes: activity === '' ? null : Number(activity), note });
      if (kind === 'diary') {
        const consent = useDiaryAi && diaryAiNotice ? await api.grantDiaryConsent(diaryAiNotice, selectedSources) : null;
        await api.personalCreate(paths.diary, { date, allowed_source_ids: selectedSources, user_notes: note,
          ...(consent ? { privacy_consent_id: consent.consent_id } : {}) });
        setUseDiaryAi(false);
      }
    }, '서버에 저장했습니다. 다른 기기에서 다시 조회하면 같은 기록을 볼 수 있습니다.');
  }

  const idOf = (item) => item.event_id ?? item.entry_id ?? item.draft_id;
  async function edit(item) {
    const value = window.prompt(kind === 'schedule' ? '일정 제목' : kind === 'wellness' ? '기록 메모' : '일기 초안', kind === 'schedule' ? item.title : kind === 'wellness' ? item.note : item.body);
    if (value === null || !value.trim()) return;
    await run(() => api.personalEdit(paths[kind], idOf(item), kind === 'schedule' ? { version: item.version, title: value } :
      kind === 'wellness' ? { version: item.version, note: value } : { base_content_version: item.content_version, feedback: value }), '수정했습니다. 기존 일기 승인은 무효화됩니다.');
  }
  async function remove(item) {
    if (!window.confirm('이 기록을 삭제하시겠습니까?')) return;
    await run(() => api.personalDelete(paths[kind], idOf(item), item.version), '삭제했습니다.');
  }
  async function approve(item, scope) {
    await run(() => api.diaryApproval(item.draft_id, { content_version: item.content_version, content_hash: item.content_hash, approval_scope: scope }),
      scope === 'continue' ? '초안 확인을 승인했습니다. 정식 저장은 별도의 최종 승인이 필요합니다.' : '현재 버전의 정식 저장을 승인했습니다.');
  }
  async function finalize(item) {
    await run(async () => {
      const approval = await api.diaryApproval(item.draft_id, { content_version: item.content_version, content_hash: item.content_hash, approval_scope: 'final_diary' });
      await api.diaryFinalize(item.draft_id, { content_version: item.content_version, content_hash: item.content_hash, approval_id: approval.approval_id });
    }, '일기를 정식 저장했습니다.');
  }
  async function reviseSaved(item) {
    const value = window.prompt('수정할 일기 내용', item.body);
    if (value === null || !value.trim()) return;
    await run(async () => {
      const draft = await api.beginDiaryRevision(item.entry_id, item.version);
      await api.personalEdit(paths.diary, draft.draft_id, { base_content_version: draft.content_version, feedback: value });
    }, '저장본 수정 초안을 만들었습니다. 초안 목록에서 중간 승인과 최종 승인을 진행해 주세요. 기존 저장본은 그대로 유지됩니다.');
  }

  const heading = { schedule: '일정 관리', wellness: '생활 기록', diary: '일기 초안과 저장' }[kind];
  return <section className="section"><div className="page-title"><h1>{heading}</h1><p>이 PC의 서버에 저장됩니다. 수정 충돌이 생기면 최신 상태를 다시 불러옵니다.</p></div>
    {!api && <p className="card">먼저 서버에 연결해 주세요.</p>}
    {api && <><form className="card" onSubmit={create}>
      <label>날짜 <input type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label>
      {kind === 'schedule' && <><label>일정 제목 <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} required /></label>
        <label>시작 <input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} required /></label>
        <label>종료 <input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} required /></label></>}
      {kind === 'schedule' && <><label>반복 <select value={frequency} onChange={(event) => setFrequency(event.target.value)}><option value="none">반복 안 함</option><option value="daily">매일</option><option value="weekly">매주</option><option value="monthly">매월</option></select></label>
        {frequency !== 'none' && <label>반복 종료일 <input type="date" value={until} onChange={(event) => setUntil(event.target.value)} required /></label>}</>}
      {kind === 'wellness' && <><label>기분 <select value={mood} onChange={(event) => setMood(event.target.value)}><option value="very_low">매우 낮음</option><option value="low">낮음</option><option value="neutral">보통</option><option value="good">좋음</option><option value="very_good">매우 좋음</option></select></label>
        <label>수면 시간 <input type="number" min="0" max="24" step="0.5" value={sleep} onChange={(event) => setSleep(event.target.value)} /></label></>}
      {kind === 'wellness' && <label>활동 시간(분) <input type="number" min="0" max="1440" step="1" value={activity} onChange={(event) => setActivity(event.target.value)} /></label>}
      {kind === 'diary' && <fieldset><legend>이 초안에 사용할 기록만 선택</legend>{sources.length === 0 && <p>선택할 일정·생활 기록이 없습니다.</p>}{sources.map((source) => {
        const id = source.event_id ?? source.entry_id;
        return <label key={id}><input type="checkbox" checked={selectedSources.includes(id)} onChange={(event) => setSelectedSources((prior) => event.target.checked ? [...prior, id] : prior.filter((value) => value !== id))} />{source.title ?? `${source.mood} · 수면 ${source.sleep_hours ?? '-'}시간`}</label>;
      })}</fieldset>}
      {kind === 'diary' && diaryAiNotice && <div><p>{diaryAiNotice.disclosure}</p><p className="muted">{diaryAiNotice.provider_retention}</p>
        <label className="check"><input type="checkbox" checked={useDiaryAi} onChange={(event) => setUseDiaryAi(event.target.checked)} />선택한 기록과 직접 쓴 메모를 OpenAI로 보내 AI 초안을 요청하는 데 동의합니다.</label>
        <small>서버에서 외부 AI가 비활성화되어 있으면 로컬 초안을 만듭니다. 동의 범위는 현재 선택 항목에만 적용됩니다.</small></div>}
      {kind !== 'schedule' && <label>{kind === 'diary' ? '직접 적은 내용' : '메모'} <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={4000} /></label>}
      <button disabled={busy}>{kind === 'diary' ? '초안 만들기' : '기록 저장'}</button>
    </form>
    <div className="card"><div className="section-head"><h2>{kind === 'diary' ? '초안 목록' : '기록 목록'}</h2><button onClick={() => reload().catch((error) => setMessage(error.message))}>새로고침</button></div>
      {items.length === 0 && <p>해당 날짜의 기록이 없습니다.</p>}
      {items.map((item) => <article key={idOf(item)} className="project-row"><strong>{item.title ?? item.body ?? `${item.mood} · 수면 ${item.sleep_hours ?? '-'}시간`}</strong>
        <small>버전 {item.content_version ?? item.version} · {item.status}</small>
        {item.status !== 'finalized' && <button disabled={busy} onClick={() => edit(item)}>수정</button>}
        {kind !== 'diary' && <button disabled={busy} onClick={() => remove(item)}>삭제</button>}
        {kind === 'diary' && item.status !== 'finalized' && <><button disabled={busy} onClick={() => approve(item, 'continue')}>중간 승인</button>
          <button disabled={busy} onClick={() => finalize(item)}>최종 승인 및 저장</button></>}
      </article>)}
    </div>
    {kind === 'schedule' && <div className="card"><h2>선택한 날짜의 발생 일정</h2>{occurrences.map((item) => <p key={`${item.event_id}-${item.date}`}>{item.title} · {new Date(item.start_at).toLocaleString()}</p>)}<small>반복 발생일 조회만 제공합니다. 알림은 실행하지 않습니다.</small></div>}
    {kind === 'diary' && <div className="card"><h2>정식 저장된 일기</h2>{saved.map((item) => <article key={item.entry_id}><p>{item.date} · {item.body} · 버전 {item.version}</p><button disabled={busy} onClick={() => reviseSaved(item)}>수정 초안 만들기</button><button disabled={busy} onClick={() => run(() => api.personalDelete('diaries/entries', item.entry_id, item.version), '정식 저장본을 삭제했습니다.')}>삭제</button></article>)}</div>}
    {kind === 'wellness' && <p>생활 기록이며 의료 진단이나 치료 권고가 아닙니다.</p>}
    {kind === 'wellness' && summary && <div className="card"><h2>선택한 날짜 요약</h2><p>기록 {summary.count}건 · 평균 수면 {summary.average_sleep_hours ?? '-'}시간 · 평균 활동 {summary.average_activity_minutes ?? '-'}분</p></div>}
    {kind === 'schedule' && <p>PC 서버가 꺼져 있거나 연결되지 않으면 알림을 보장할 수 없습니다. 현재 알림 발송 기능은 준비 중입니다.</p>}
    {message && <p role="status">{message}</p>}</>}
  </section>;
}
