import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api.js';

const currentCheckpoint = (items, kind, task) => items.find((item) => item.kind === kind && item.content_version === task.current_version &&
  item.content_hash === task.content_hash && ['pending', 'approved'].includes(item.status));

export function CreatorWorkspace({ api, project, onChanged }) {
  const [snapshot, setSnapshot] = useState(null);
  const [message, setMessage] = useState('작업을 불러오고 있습니다.');
  const [requestText, setRequestText] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const previewRef = useRef(null);
  const keys = useRef(new Map());
  const taskId = project.task_id;

  const refresh = useCallback(async () => {
    const task = await api.task(taskId);
    const [checkpoints, jobs, tracks] = await Promise.all([api.checkpoints(taskId), api.jobs(taskId), api.tracks()]);
    const optional = async (call) => { try { return await call(); } catch (error) { if (error instanceof ApiError && error.status === 409) return null; throw error; } };
    const [plan, draft] = await Promise.all([optional(() => api.plan(taskId)), optional(() => api.draft(taskId))]);
    const latest = jobs.items.find((job) => job.content_version === task.current_version && job.content_hash === task.content_hash) ?? null;
    if (!latest || latest.artifact_sha256 !== previewRef.current?.hash) {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current.url);
      previewRef.current = null; setPreviewUrl(null);
    }
    setSnapshot({ task, checkpoints: checkpoints.items, job: latest, plan, draft, tracks: tracks.items });
    setMessage('서버의 현재 버전과 승인 상태를 불러왔습니다.');
  }, [api, taskId]);

  useEffect(() => {
    setSnapshot(null); setRequestText(''); setMessage('작업을 불러오고 있습니다.'); keys.current.clear();
    refresh().catch((error) => setMessage(error.message));
    const listener = () => { if (document.visibilityState === 'visible') refresh().catch(() => setMessage('최신 상태를 갱신하지 못했습니다.')); };
    document.addEventListener('visibilitychange', listener);
    const timer = setInterval(listener, 5000);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', listener);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current.url); previewRef.current = null; };
  }, [refresh]);

  function keyFor(fingerprint) {
    if (!keys.current.has(fingerprint)) keys.current.set(fingerprint, crypto.randomUUID());
    return keys.current.get(fingerprint);
  }

  async function run(action, success) {
    if (busy) return;
    setBusy(true);
    try { await action(); await refresh(); await onChanged(); if (success) setMessage(success); }
    catch (error) {
      if (error.status === 409) await refresh().catch(() => {});
      setMessage(error.message);
    } finally { setBusy(false); }
  }

  async function loadPreview() {
    const { task, job } = snapshot;
    if (!verified(task, job)) return;
    setBusy(true); setMessage('인증된 영상을 내려받아 해시를 확인하고 있습니다.');
    try {
      const url = await api.preview(taskId, task.current_version, job.artifact_sha256);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current.url);
      previewRef.current = { url, hash: job.artifact_sha256 }; setPreviewUrl(url);
      setMessage('실제 FFmpeg MP4의 해시를 확인했습니다.');
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  if (!snapshot) return <section className="card workspace-card"><p role="status">{message}</p></section>;
  const { task, checkpoints, job, plan, draft, tracks } = snapshot;
  const planCheck = currentCheckpoint(checkpoints, 'plan', task);
  const draftCheck = currentCheckpoint(checkpoints, 'draft', task);
  const previewCheck = currentCheckpoint(checkpoints, 'preview', task);
  const invalidated = checkpoints.some((item) => item.status === 'invalidated');

  return <div className="workspace-stack">
    <section className="card workspace-card"><div className="section-head"><div><p className="eyebrow">CURRENT TASK</p><h2>작업 상태</h2></div><button className="text-button" onClick={() => refresh().catch((error) => setMessage(error.message))}>최신 상태 조회</button></div>
      <div className="status-line"><span className="pill">버전 {task.current_version}</span><span className="pill light">{task.status}</span></div>
      <p className="muted">콘텐츠 해시 {task.content_hash?.slice(0, 12)}… · 다른 기기에서 수정한 경우 새로고침 후 승인해 주세요.</p>
      {invalidated && <p className="warning">이전 버전 승인이 무효화되었습니다. 현재 버전의 단계별 승인을 다시 확인해 주세요.</p>}
      <p className="notice" role="status">{message}</p>
    </section>
    <section className="card workspace-card"><p className="eyebrow">01 · PLAN</p><h2>쇼츠 기획안</h2>
      {plan ? <><h3>{plan.plan.title_idea}</h3><p className="muted">{plan.plan.aspect_ratio} · {plan.plan.target_seconds}초 · 버전 {plan.content_version}</p>
        <div className="scenes">{plan.plan.scenes.map((scene) => <div key={scene.order} className="scene"><span className="scene-number">{String(scene.order).padStart(2, '0')}</span><div><strong>{scene.start_seconds}–{scene.end_seconds}초</strong><p>{scene.visual_direction}</p><small>자막 제안: {scene.caption_text}</small></div></div>)}</div>
        <PlanSceneEditor key={`${taskId}:${task.current_version}`} api={api} taskId={taskId} task={task} plan={plan.plan} busy={busy} run={run} keyFor={keyFor} />
      </> : <p className="muted">기획안을 아직 만들지 않았습니다. 로컬 규칙 기획을 요청해 주세요.</p>}
      <label htmlFor="plan-request">{plan ? '기획 수정 요청' : '기획 요청'}</label><textarea id="plan-request" rows="3" maxLength="4000" value={requestText} onChange={(event) => setRequestText(event.target.value)} placeholder="원하는 분위기와 장면 구성을 적어 주세요." />
      <div className="button-row"><button disabled={busy || !requestText.trim()} onClick={() => run(() => api.revisePlan(taskId, task.current_version, requestText.trim(), keyFor(`plan:${task.current_version}:${requestText.trim()}`)), '새 기획안이 준비됐습니다. 현재 버전을 다시 확인해 주세요.')}>{plan ? '수정안 만들기' : '기획안 만들기'}</button>
        {plan && planCheck?.status === 'pending' && <button className="secondary" disabled={busy} onClick={() => run(() => api.approve(taskId, planCheck, keyFor(`approve:${planCheck.checkpoint_id}`)), '현재 기획을 중간 승인했습니다.')}>기획 중간 승인</button>}</div>
      <small>수정 요청은 새 버전을 만들고 기존 승인을 무효화합니다. 외부 AI 동의는 전송하지 않습니다.</small>
    </section>
    <DraftSection key={`${taskId}:${task.current_version}:${draft?.checkpoint?.checkpoint_id ?? 'none'}`} api={api} task={task} taskId={taskId} draft={draft} tracks={tracks} checkpoint={draftCheck} busy={busy} run={run} keyFor={keyFor} />
    <section className="card workspace-card"><p className="eyebrow">03 · RENDER</p><h2>영상 미리보기</h2>
      <p className="muted">9:16 · 1080×1920 · 30fps · MP4(H.264/AAC)</p>
      {job && <p>렌더 작업: <strong>{job.status}</strong> · {job.progress_percent ?? 0}% {job.renderer_mode === 'test' && '· 테스트 렌더러'}</p>}
      <div className="button-row"><button disabled={busy || task.status !== 'render_ready'} onClick={() => run(() => api.render(taskId, task, keyFor(`render:${task.current_version}:${task.content_hash}`)), '렌더를 요청했습니다.')}>렌더 요청</button>
        {job && ['queued', 'running'].includes(job.status) && <button className="secondary" disabled={busy} onClick={() => run(() => api.cancel(job.job_id, keyFor(`cancel:${job.job_id}`)), '렌더 취소를 요청했습니다.')}>렌더 취소</button>}
        <button className="secondary" disabled={busy || !verified(task, job)} onClick={loadPreview}>인증된 MP4 불러오기</button></div>
      {previewUrl && <video controls playsInline src={previewUrl} className="video-preview" aria-label="Creator MP4 미리보기" />}
      {previewCheck?.status === 'pending' && <button disabled={busy || !previewUrl} onClick={() => run(() => api.approve(taskId, previewCheck, keyFor(`approve:${previewCheck.checkpoint_id}`)), '현재 영상의 미리보기를 중간 승인했습니다.')}>현재 영상 미리보기 승인</button>}
      <p className="muted">권리 검사와 플랫폼별 최종 게이트는 서버가 담당합니다. 이 PC 첫 버전에는 SNS 게시 화면과 실제 게시 호출이 없습니다.</p>
    </section>
  </div>;
}

function PlanSceneEditor({ api, taskId, task, plan, busy, run, keyFor }) {
  const [rows, setRows] = useState(() => plan.scenes.map((scene) => ({ media_id: scene.media_id, media_type: scene.media_type,
    duration_seconds: Number((scene.end_seconds - scene.start_seconds).toFixed(2)), trim_start_seconds: scene.trim_start_seconds ?? 0 })));
  const total = Math.round(rows.reduce((sum, row) => sum + Number(row.duration_seconds || 0), 0) * 100) / 100;
  const set = (index, field, value) => setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row));
  const move = (index, delta) => setRows((current) => { const next = [...current]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; return next; });
  const payload = rows.map((row) => ({ media_id: row.media_id, duration_seconds: Number(row.duration_seconds),
    ...(row.media_type.startsWith('video/') ? { trim_start_seconds: Number(row.trim_start_seconds) } : {}) }));
  const valid = Math.abs(total - plan.target_seconds) <= 0.01 && payload.every((row) => row.duration_seconds >= 0.1 && Number.isFinite(row.duration_seconds) &&
    (row.trim_start_seconds === undefined || Number.isFinite(row.trim_start_seconds) && row.trim_start_seconds >= 0 && row.trim_start_seconds <= 3600));
  return <div className="scenes"><h3>장면 순서와 재생 시간</h3><p className="muted">합계 {total}/{plan.target_seconds}초 · 영상은 시작 구간을 초 단위로 지정할 수 있습니다.</p>
    {rows.map((row, index) => <div className="scene" key={row.media_id}><span className="scene-number">{index + 1}</span><div>
      <small>{row.media_type.startsWith('video/') ? '영상' : '사진'} · {row.media_id.slice(0, 8)}</small>
      <label>재생 초 <input type="number" min="0.1" max="59" step="0.01" value={row.duration_seconds} onChange={(event) => set(index, 'duration_seconds', event.target.value)} /></label>
      {row.media_type.startsWith('video/') && <label>시작 위치(초) <input type="number" min="0" max="3600" step="0.01" value={row.trim_start_seconds} onChange={(event) => set(index, 'trim_start_seconds', event.target.value)} /></label>}
      <div className="button-row"><button className="secondary" disabled={busy || index === 0} onClick={() => move(index, -1)}>위로</button><button className="secondary" disabled={busy || index === rows.length - 1} onClick={() => move(index, 1)}>아래로</button></div>
    </div></div>)}
    <button disabled={busy || !valid} onClick={() => run(() => api.updateScenes(taskId, task, payload, keyFor(`scene:${task.current_version}:${JSON.stringify(payload)}`)), '새 장면 기획이 저장됐습니다. 현재 버전의 승인을 다시 확인해 주세요.')}>장면 구성 저장</button>
  </div>;
}

function verified(task, job) {
  return job?.status === 'succeeded' && job.renderer_mode === 'ffmpeg' && job.artifact_verified === true &&
    job.content_version === task.current_version && job.content_hash === task.content_hash && /^[a-f0-9]{64}$/i.test(job.artifact_sha256 ?? '');
}

function DraftSection({ api, task, taskId, draft, tracks, checkpoint, busy, run, keyFor }) {
  const [captions, setCaptions] = useState(() => draft?.captions?.map((row) => ({ ...row })) ?? []);
  const [enabled, setEnabled] = useState(draft?.composition?.captions_enabled ?? true);
  const [trackId, setTrackId] = useState(draft?.composition?.music_track_id ?? '');
  const [sourceVolume, setSourceVolume] = useState(draft?.composition?.source_volume ?? 1);
  const [musicVolume, setMusicVolume] = useState(draft?.composition?.music_volume ?? 0.5);
  const [fadeIn, setFadeIn] = useState(draft?.composition?.fade_in_seconds ?? 0);
  const [fadeOut, setFadeOut] = useState(draft?.composition?.fade_out_seconds ?? 0);
  const [edited, setEdited] = useState(false);
  if (!draft) return <section className="card workspace-card"><p className="eyebrow">02 · CAPTIONS & MUSIC</p><h2>자막·음악</h2><p className="muted">현재 버전의 기획을 승인하면 초안을 확인할 수 있습니다.</p></section>;

  function changeCaption(index, text) {
    setCaptions((rows) => rows.map((row, i) => i === index ? { ...row, text } : row)); setEdited(true);
  }
  function save() {
    const body = { content_version: task.current_version, content_hash: task.content_hash,
      captions: captions.map((row, index) => ({ order: index + 1, start_seconds: row.start_seconds, end_seconds: row.end_seconds, text: row.text })),
      captions_enabled: enabled, music_track_id: trackId || null, source_volume: Number(sourceVolume), music_volume: Number(musicVolume),
      fade_in_seconds: Number(fadeIn), fade_out_seconds: Number(fadeOut) };
    run(() => api.updateDraft(taskId, body, keyFor(`draft:${task.current_version}:${JSON.stringify(body)}`)), '자막·음악 변경으로 버전이 올랐습니다. 기획부터 다시 승인해 주세요.');
  }
  return <section className="card workspace-card"><p className="eyebrow">02 · CAPTIONS & MUSIC</p><h2>자막·음악 초안</h2>
    <p className="muted">자막 시간은 현재 초안의 값을 유지합니다. 문구와 음량을 수정할 수 있습니다.</p>
    <label className="check"><input type="checkbox" checked={enabled} onChange={(event) => { setEnabled(event.target.checked); setEdited(true); }} /> 자막 합성</label>
    {captions.map((row, index) => <label key={index} className="caption-row">{row.start_seconds}–{row.end_seconds}초<input value={row.text} maxLength="80" onChange={(event) => changeCaption(index, event.target.value)} /></label>)}
    <label htmlFor="music">로컬 BGM</label><select id="music" value={trackId} onChange={(event) => { setTrackId(event.target.value); setEdited(true); }}><option value="">음악 없음</option>{tracks.filter((track) => track.status === 'available').map((track) => <option key={track.track_id} value={track.track_id}>{track.title} · {track.rights_status === 'user_verified' ? '사용자 권리 확인' : '권리 미확인'}</option>)}</select>
    <div className="number-grid">{[['원음 음량', sourceVolume, setSourceVolume, 2], ['BGM 음량', musicVolume, setMusicVolume, 2], ['페이드 인(초)', fadeIn, setFadeIn, 10], ['페이드 아웃(초)', fadeOut, setFadeOut, 10]].map(([label, value, setter, max]) => <label key={label}>{label}<input type="number" min="0" max={max} step="0.1" value={value} onChange={(event) => { setter(event.target.value); setEdited(true); }} /></label>)}</div>
    <div className="button-row"><button className="secondary" disabled={busy || !edited} onClick={save}>자막·음악 변경 저장</button>
      {checkpoint?.status === 'pending' && <button disabled={busy || edited} onClick={() => run(() => api.approve(taskId, checkpoint, keyFor(`approve:${checkpoint.checkpoint_id}`)), '현재 초안을 중간 승인했습니다.')}>초안 중간 승인</button>}</div>
    <small>선택한 음원의 플랫폼별 상업 이용 권리와 원본 오디오 권리는 최종 승인 시 서버에서 다시 검사합니다.</small>
  </section>;
}
