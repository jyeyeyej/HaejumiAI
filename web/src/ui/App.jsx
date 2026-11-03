import React, { useCallback, useEffect, useState } from 'react';
import { HaejumiApi } from '../api.js';
import { UploadCard } from './UploadCard.jsx';
import { CreatorWorkspace } from './CreatorWorkspace.jsx';

const agents = [
  ['Creator', '쇼츠 만들기', '선택한 사진·영상으로 기획하고 미리봅니다.', true],
  ['Schedule', '일정 관리', '준비 중입니다.', false],
  ['Wellness', '생활·건강', '준비 중입니다.', false],
  ['Diary', '일기', '준비 중입니다.', false],
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
  const [status, setStatus] = useState('');
  const [connectionState, setConnectionState] = useState('idle');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (active = api) => {
    if (!active) return;
    const result = await active.projects();
    setProjects(result.items);
  }, [api]);

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
      const candidate = new HaejumiApi(tokenInput.trim());
      await candidate.capabilities();
      await reload(candidate);
      setApi(candidate); setTokenInput(''); setConnectionState('connected'); setStatus('로컬 서버에 연결되었습니다.');
    } catch (error) { setConnectionState('error'); setStatus(error.message); }
    finally { setBusy(false); }
  }

  async function send(event) {
    event.preventDefault();
    if (!api || !message.trim()) return;
    setBusy(true);
    try {
      const result = await api.message(message.trim(), selected?.task_id);
      setReply(result.reply); setMessage('');
      if (result.task_id) { await reload(); setStatus('작업 상태를 갱신했습니다.'); }
    } catch (error) { setStatus(error.message); }
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
      </nav>
      <div className="sidebar-bottom"><span className="online-dot" />{api ? '로컬 PC 연결됨' : '연결 필요'}<small>서버 데이터가 두 기기의 공통 기준입니다.</small></div>
    </aside>
    <main className="main">
      <header className="topbar"><span>PERSONAL WORKSPACE</span><span className="top-status">외부 공개 비활성 · 로컬 전용</span></header>
      {!api && <section className="connect card"><div><p className="eyebrow">시작하기</p><h1>내 PC 서버에 연결</h1><p>백엔드를 실행한 뒤 Bearer 토큰을 입력해 주세요. 토큰은 이 탭의 메모리에만 보관하며 새로고침하면 지워집니다.</p></div>
        <form onSubmit={connect}><label htmlFor="token">인증 토큰</label><input id="token" type="password" autoComplete="off" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder="서버 .env의 토큰" /><button disabled={busy || !tokenInput.trim()} aria-busy={busy}>{busy ? '연결 중…' : '연결 확인'}</button><p className={`connection-feedback ${connectionState === 'error' ? 'connection-error' : ''}`} role={connectionState === 'error' ? 'alert' : 'status'} aria-live="polite">{status || '토큰을 입력하고 연결 확인을 눌러 주세요.'}</p></form></section>}
      {api && status && <p className="notice" role="status">{status}</p>}
      {page === 'home' && <>
        <section className="hero"><div><p className="eyebrow">HAEJUMI AI · 예투</p><h1>무엇을 도와드릴까요?</h1><p>직접 선택한 사진과 영상으로 쇼츠를 만들고, 진행 중인 작업을 이어서 확인하세요.</p><button className="hero-button" onClick={() => setPage('creator')}>Creator 시작하기 <span>→</span></button></div><div className="hero-art" aria-hidden="true"><div className="art-orbit"><span>✦</span></div></div></section>
        <section className="section"><div className="section-head"><div><p className="eyebrow">ASSISTANTS</p><h2>전문 에이전트</h2></div><span>4개의 도우미</span></div><div className="agent-grid">{agents.map(([name, title, desc, enabled]) => <button key={name} className="agent-card card" disabled={!enabled} onClick={() => setPage('creator')}><span className="agent-icon">{name[0]}</span><strong>{title}</strong><small>{desc}</small><em>{enabled ? '사용 가능 →' : '준비 중'}</em></button>)}</div></section>
        <section className="section"><div className="section-head"><div><p className="eyebrow">YETU</p><h2>예투에게 말하기</h2></div></div><div className="chat card"><p className="chat-reply">{reply}</p><form onSubmit={send}><input aria-label="예투에게 입력" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="예: 선택한 영상으로 쇼츠 기획해 주세요" disabled={!api || busy} /><button disabled={!api || busy || !message.trim()}>보내기</button></form><small>현재는 규칙 기반 안내와 Creator 기획만 연결되어 있습니다. 음성 입력은 준비 중입니다.</small></div></section>
      </>}
      {page === 'creator' && <><div className="page-title"><p className="eyebrow">CREATOR STUDIO</p><h1>쇼츠 만들기</h1><p>파일을 직접 고른 뒤 PC에서 기획과 렌더링을 진행합니다.</p></div><UploadCard api={api} onCreated={async (project) => { setSelected(project); await reload(); setPage('projects'); }} /></>}
      {page === 'projects' && <><div className="page-title"><p className="eyebrow">YOUR PROJECTS</p><h1>Creator 프로젝트</h1><p>PC와 Android가 같은 서버의 작업과 승인 상태를 사용합니다.</p></div>
        <div className="workspace-layout"><section className="project-list card"><div className="section-head"><h2>프로젝트 목록</h2><button className="text-button" disabled={!api} onClick={() => reload().catch((error) => setStatus(error.message))}>새로고침</button></div>
          {!api && <p className="muted">서버에 연결해 주세요.</p>}{api && projects.length === 0 && <p className="muted">아직 프로젝트가 없습니다. 직접 파일을 선택해 시작해 주세요.</p>}
          {projects.map((project, index) => <button key={project.project_id} className={`project-row ${selected?.project_id === project.project_id ? 'selected' : ''}`} onClick={() => setSelected(project)}><strong>쇼츠 프로젝트 {projects.length - index}</strong><small>{project.target_seconds}초 · {project.framing} · 버전 {project.current_version}</small><span>작업 보기 →</span></button>)}
        </section><div>{selected && api ? <CreatorWorkspace key={selected.task_id} api={api} project={selected} onChanged={reload} /> : <div className="empty card">프로젝트를 선택해 기획과 미리보기를 확인해 주세요.</div>}</div></div></>}
    </main>
  </div>;
}
