import React, { useCallback, useEffect, useState } from 'react';
import { HaejumiApi } from '../api.js';
import { UploadCard } from './UploadCard.jsx';
import { CreatorWorkspace } from './CreatorWorkspace.jsx';
import { PersonalWorkspace } from './PersonalWorkspace.jsx';
import { SettingsWorkspace } from './SettingsWorkspace.jsx';

const agents = [
  ['Creator', '쇼츠 만들기', '선택한 사진·영상으로 기획하고 미리봅니다.', true],
  ['Schedule', '일정 관리', '기록 저장·조회가 가능합니다. 알림은 준비 중입니다.', true],
  ['Wellness', '생활·건강', '생활 기록을 로컬에 저장합니다.', true],
  ['Diary', '일기', '초안과 승인 후 정식 저장을 구분합니다.', true],
];

export function App() {
  const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
  const [tokenInput, setTokenInput] = useState('');
  const [api, setApi] = useState(null);
  const [projects, setProjects] = useState([]);
  const [selected, setSelected] = useState(null);
  const [page, setPage] = useState('home');
  const [message, setMessage] = useState('');
  const [reply, setReply] = useState('안녕하세요. 예투입니다. 무엇을 도와드릴까요?');
  const [proposals, setProposals] = useState([]);
  const [conversation, setConversation] = useState([]);
  const [status, setStatus] = useState('');
  const [connectionState, setConnectionState] = useState('checking');
  const [textConsentId, setTextConsentId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [deletingProjectId, setDeletingProjectId] = useState(null);

  const reload = useCallback(async (active = api) => {
    if (!active) return;
    try { const result = await active.projects(); setProjects(result.items); }
    catch (error) { if (error.status === 401) { setApi(null); setConnectionState('error'); setStatus('로그인 세션이 만료됐습니다. 다시 인증해 주세요.'); } throw error; }
  }, [api]);

  useEffect(() => {
    if (!local) return;
    let mounted = true;
    const candidate = HaejumiApi.webSession();
    candidate.status().then(() => candidate.projects()).then((result) => {
      if (!mounted) return;
      setProjects(result.items); setApi(candidate); setConnectionState('connected'); setStatus('로그인 상태를 복원했습니다.');
      candidate.history().then((history) => { if (mounted) setConversation(history.items); }).catch(() => {});
    }).catch((error) => {
      if (!mounted) return;
      setConnectionState(error.status === 401 ? 'idle' : 'error');
      setStatus(error.status === 401 ? '' : error.message);
    });
    return () => { mounted = false; };
  }, [local]);

  useEffect(() => {
    if (!api) return;
    const listener = () => { if (document.visibilityState === 'visible') reload().catch(() => setStatus('목록을 갱신하지 못했습니다.')); };
    document.addEventListener('visibilitychange', listener);
    const timer = setInterval(listener, 20000);
    return () => { document.removeEventListener('visibilitychange', listener); clearInterval(timer); };
  }, [api, reload]);

  async function connect(event) {
    event.preventDefault();
    setBusy(true); setConnectionState('checking'); setStatus('서버 인증을 확인하고 있습니다.');
    try {
      const candidate = await HaejumiApi.signIn(tokenInput.trim());
      await reload(candidate);
      setApi(candidate); setTextConsentId(null); setTokenInput(''); setConnectionState('connected'); setStatus('로컬 서버에 연결되었습니다.');
      const history = await candidate.history(); setConversation(history.items);
    } catch (error) { setConnectionState('error'); setStatus(error.message); }
    finally { setBusy(false); }
  }

  async function logout() {
    if (!api) return;
    setBusy(true);
    try {
      await api.logout();
      setApi(null); setProjects([]); setSelected(null); setTextConsentId(null); setProposals([]); setConversation([]);
      setConnectionState('idle'); setStatus('로그아웃했습니다.'); setPage('home');
    } catch (error) { setStatus(error.message); }
    finally { setBusy(false); }
  }

  async function deleteProject(project) {
    if (!api || deletingProjectId || !window.confirm('이 쇼츠 프로젝트를 목록에서 삭제하시겠습니까? 연결된 작업·승인 기록은 삭제되고 원본 미디어와 렌더 파일은 보존됩니다.')) return;
    setDeletingProjectId(project.project_id);
    try {
      await api.deleteProject(project.project_id, project.current_version, project.content_hash);
      if (selected?.project_id === project.project_id) setSelected(null);
      await reload();
      setStatus('프로젝트를 삭제했습니다. 원본 미디어와 렌더 파일은 보존했습니다.');
    } catch (error) {
      await reload().catch(() => {});
      setStatus(error.code === 'RENDER_IN_PROGRESS' ? error.message
        : error.code === 'VERSION_CONFLICT' ? '프로젝트 버전이 변경됐습니다. 갱신된 목록에서 다시 확인해 주세요.'
          : error.code === 'INVALID_STATE_TRANSITION' ? '프로젝트의 연결 기록을 확인할 수 없어 삭제하지 않았습니다. 서버 기록을 점검해 주세요.'
            : error.message);
    } finally { setDeletingProjectId(null); }
  }

  async function send(event) {
    event.preventDefault();
    if (!api || !message.trim()) return;
    setBusy(true);
    try {
      const result = await api.message(message.trim(), selected?.task_id, textConsentId);
      setReply(result.reply); setProposals(result.actions ?? []); setMessage('');
      const history = await api.history(); setConversation(history.items);
      if (result.task_id) { await reload(); setStatus('작업 상태를 갱신했습니다.'); }
    } catch (error) { setStatus(error.message); }
    finally { setBusy(false); }
  }
  async function confirmProposal(item) {
    if (!api || !item.proposal_id) return;
    setBusy(true);
    try { await api.confirmProposal(item.proposal_id); setProposals((prior) => prior.filter((entry) => entry.proposal_id !== item.proposal_id));
      setStatus('선택한 작업을 서버에 저장했습니다. 해당 Agent 화면에서 다시 조회해 주세요.'); }
    catch (error) { setStatus(error.message); }
    finally { setBusy(false); }
  }

  if (!local) return <main className="shell"><h1>해주미</h1><p>PC 웹은 이 PC의 localhost에서만 사용해 주세요.</p></main>;

  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">ㅎ</span><div><strong>해주미</strong><small>예투와 함께 만드는 하루</small></div></div>
      <nav aria-label="주 메뉴">
        <button className={page === 'home' ? 'nav-active' : ''} onClick={() => setPage('home')}>⌂ <span>홈</span></button>
        <button className={page === 'creator' ? 'nav-active' : ''} onClick={() => setPage('creator')}>▣ <span>Creator</span></button>
        <button className={page === 'projects' ? 'nav-active' : ''} onClick={() => setPage('projects')}>◫ <span>프로젝트</span></button>
        <button className={page === 'schedule' ? 'nav-active' : ''} onClick={() => setPage('schedule')}>▤ <span>Schedule</span></button>
        <button className={page === 'wellness' ? 'nav-active' : ''} onClick={() => setPage('wellness')}>♡ <span>Wellness</span></button>
        <button className={page === 'diary' ? 'nav-active' : ''} onClick={() => setPage('diary')}>✎ <span>Diary</span></button>
        <button className={page === 'settings' ? 'nav-active' : ''} onClick={() => setPage('settings')}>⚙ <span>설정</span></button>
      </nav>
      <div className="sidebar-bottom"><span className="online-dot" />{connectionState === 'checking' ? '로그인 확인 중…' : api ? '로컬 PC 연결됨' : '연결 필요'}{api && <button className="text-button" disabled={busy} onClick={logout}>로그아웃</button>}<small>서버 데이터가 두 기기의 공통 기준입니다.</small></div>
    </aside>
    <main className="main">
      <header className="topbar"><span>PERSONAL WORKSPACE</span><span className="top-status">외부 공개 비활성 · 로컬 전용</span></header>
      {!api && connectionState === 'checking' && <section className="connect card"><p role="status">저장된 로그인 상태를 확인하고 있습니다…</p></section>}
      {!api && connectionState !== 'checking' && <section className="connect card"><div><p className="eyebrow">시작하기</p><h1>내 PC 서버에 연결</h1><p>백엔드를 실행한 뒤 Bearer 토큰을 한 번 입력해 주세요. 이후에는 서버가 발급한 로그인 쿠키를 사용합니다.</p></div>
        <form onSubmit={connect}><label htmlFor="token">인증 토큰</label><input id="token" type="password" autoComplete="off" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder="서버 .env의 토큰" /><button disabled={busy || !tokenInput.trim()} aria-busy={busy}>{busy ? '연결 중…' : '연결 확인'}</button><p className={`connection-feedback ${connectionState === 'error' ? 'connection-error' : ''}`} role={connectionState === 'error' ? 'alert' : 'status'} aria-live="polite">{status || '토큰을 입력하고 연결 확인을 눌러 주세요.'}</p></form></section>}
      {api && status && <p className="notice" role="status">{status}</p>}
      {page === 'home' && <>
        <section className="hero"><div><p className="eyebrow">HAEJUMI AI · 예투</p><h1>무엇을 도와드릴까요?</h1><p>직접 선택한 사진과 영상으로 쇼츠를 만들고, 진행 중인 작업을 이어서 확인하세요.</p><button className="hero-button" onClick={() => setPage('creator')}>Creator 시작하기 <span>→</span></button></div><div className="hero-art" aria-hidden="true"><div className="art-orbit"><span>✦</span></div></div></section>
        <section className="section"><div className="section-head"><div><p className="eyebrow">ASSISTANTS</p><h2>전문 에이전트</h2></div><span>4개의 도우미</span></div><div className="agent-grid">{agents.map(([name, title, desc, enabled]) => <button key={name} className="agent-card card" disabled={!enabled} onClick={() => setPage(name.toLowerCase())}><span className="agent-icon">{name[0]}</span><strong>{title}</strong><small>{desc}</small><em>{name === 'Creator' ? '사용 가능 →' : enabled ? '기록 기능 이용 →' : '준비 중'}</em></button>)}</div></section>
        <section className="section"><div className="section-head"><div><p className="eyebrow">YETU</p><h2>예투에게 말하기</h2></div><button className="text-button" disabled={!api || busy || conversation.length === 0} onClick={async () => { try { await api.clearHistory(); setConversation([]); setStatus('대화 이력을 삭제했습니다.'); } catch (error) { setStatus(error.message); } }}>대화 이력 삭제</button></div><div className="chat card"><p className="chat-reply">{reply}</p>{conversation.slice(-10).map((item) => <div className="project-row" key={item.message_id}><strong>{item.text}</strong><small>{item.reply}</small></div>)}<form onSubmit={send}><input aria-label="예투에게 입력" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="이야기를 나누거나 Agent에게 부탁해 주세요" disabled={!api || busy} /><button disabled={!api || busy || !message.trim()}>보내기</button></form><small>{textConsentId ? '명시적으로 동의한 현재 입력 문구만 외부 AI 해석에 사용할 수 있습니다. 기록은 자동 저장하지 않습니다.' : '외부 AI가 꺼져 있으면 자유 대화가 제한적입니다. 지원하는 로컬 명령은 계속 사용할 수 있습니다.'} 여러 기록 명령은 세미콜론으로 최대 네 작업을 구분할 수 있습니다.</small>{proposals.map((item, index) => <div key={item.proposal_id ?? index} className="project-row"><strong>{item.kind}</strong><small>{item.planned_action ? JSON.stringify(item.planned_action) : '조회 완료'}</small>{item.proposal_id && <button disabled={busy} onClick={() => confirmProposal(item)}>이 작업 확인 후 저장</button>}</div>)}</div></section>
      </>}
      {page === 'creator' && <><div className="page-title"><p className="eyebrow">CREATOR STUDIO</p><h1>쇼츠 만들기</h1><p>파일을 직접 고른 뒤 PC에서 기획과 렌더링을 진행합니다.</p></div><UploadCard api={api} onCreated={async (project) => { setSelected(project); await reload(); setPage('projects'); }} /></>}
      {page === 'projects' && <><div className="page-title"><p className="eyebrow">YOUR PROJECTS</p><h1>Creator 프로젝트</h1><p>PC와 Android가 같은 서버의 작업과 승인 상태를 사용합니다.</p></div>
        <div className="workspace-layout"><section className="project-list card"><div className="section-head"><h2>프로젝트 목록</h2><button className="text-button" disabled={!api} onClick={() => reload().catch((error) => setStatus(error.message))}>새로고침</button></div>
          {!api && <p className="muted">서버에 연결해 주세요.</p>}{api && projects.length === 0 && <p className="muted">아직 프로젝트가 없습니다. 직접 파일을 선택해 시작해 주세요.</p>}
          {projects.map((project, index) => <article key={project.project_id} className={`project-entry ${selected?.project_id === project.project_id ? 'selected' : ''}`}><button className="project-row" onClick={() => setSelected(project)}><strong>쇼츠 프로젝트 {projects.length - index}</strong><small>{project.target_seconds}초 · {project.framing} · 버전 {project.current_version}</small><span>작업 보기 →</span></button><button className="project-delete" disabled={deletingProjectId === project.project_id} onClick={() => deleteProject(project)} aria-label={`쇼츠 프로젝트 ${projects.length - index} 삭제`}>{deletingProjectId === project.project_id ? '삭제 중…' : '삭제'}</button></article>)}
        </section><div>{selected && api ? <CreatorWorkspace key={selected.task_id} api={api} project={selected} onChanged={reload} /> : <div className="empty card">프로젝트를 선택해 기획과 미리보기를 확인해 주세요.</div>}</div></div></>}
      {['schedule', 'wellness', 'diary'].includes(page) && <PersonalWorkspace api={api} kind={page} />}
      {page === 'settings' && <SettingsWorkspace api={api} onConsentChange={setTextConsentId} />}
    </main>
  </div>;
}
