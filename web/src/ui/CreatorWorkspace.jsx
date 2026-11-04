import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api.js';
import { visionAvailability, visionGenerationMessage } from '../vision-availability.js';
import { publicationDraftsFromPlan } from '../../../shared/publication-drafts.js';
import { proposeMixedEdit, summarizeTrend } from '../../../shared/trend-edit.js';
import '../caption-editor.css';

const currentCheckpoint = (items, kind, task) => items.find((item) => item.kind === kind && item.content_version === task.current_version &&
  item.content_hash === task.content_hash && ['pending', 'approved'].includes(item.status));

export function CreatorWorkspace({ api, project, onChanged }) {
  const [snapshot, setSnapshot] = useState(null);
  const [message, setMessage] = useState('작업을 불러오고 있습니다.');
  const [requestText, setRequestText] = useState('');
  const [visionNotice, setVisionNotice] = useState(null);
  const [visionChecked, setVisionChecked] = useState(false);
  const [visionConsentId, setVisionConsentId] = useState(null);
  const [usage, setUsage] = useState(null);
  const [trendResult, setTrendResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const previewRef = useRef(null);
  const keys = useRef(new Map());
  const taskId = project.task_id;

  const refresh = useCallback(async () => {
    const task = await api.task(taskId);
    const [checkpoints, jobs, tracks, publications] = await Promise.all([api.checkpoints(taskId), api.jobs(taskId), api.tracks(), api.publications(taskId)]);
    const optional = async (call) => { try { return await call(); } catch (error) { if (error instanceof ApiError && error.status === 409) return null; throw error; } };
    const planCheckpoint = currentCheckpoint(checkpoints.items, 'plan', task);
    const draftCheckpoint = currentCheckpoint(checkpoints.items, 'draft', task);
    const [plan, draft] = await Promise.all([
      planCheckpoint ? optional(() => api.plan(taskId)) : null,
      planCheckpoint?.status === 'approved' && draftCheckpoint ? optional(() => api.draft(taskId)) : null,
    ]);
    const latest = jobs.items.find((job) => job.content_version === task.current_version && job.content_hash === task.content_hash) ?? null;
    if (!latest || latest.artifact_sha256 !== previewRef.current?.hash) {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current.url);
      previewRef.current = null; setPreviewUrl(null);
    }
    setSnapshot({ task, checkpoints: checkpoints.items, job: latest, plan, draft, tracks: tracks.items, publications: publications.items });
    setMessage('서버의 현재 버전과 승인 상태를 불러왔습니다.');
  }, [api, taskId]);

  useEffect(() => {
    setSnapshot(null); setRequestText(''); setTrendResult(null); setMessage('작업을 불러오고 있습니다.'); keys.current.clear();
    refresh().catch((error) => setMessage(error.message));
    Promise.all([api.privacyNotice('vision_analysis'), api.llmUsage()]).then(([notice, currentUsage]) => {
      setVisionNotice(notice); setUsage(currentUsage);
    }).catch(() => setVisionNotice(null));
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
    try { const result = await action(); await refresh(); await onChanged(); if (success) setMessage(typeof success === 'function' ? success(result) : success); }
    catch (error) {
      if (error.status === 409) await refresh().catch(() => {});
      setMessage(error.message);
    } finally { setBusy(false); }
  }

  async function generatePlan(task, useVision) {
    if (!useVision) return run(() => api.revisePlan(taskId, task.current_version, requestText.trim(),
      keyFor(`plan:local:${task.current_version}:${requestText.trim()}`)), '새 기획안이 준비됐습니다.');
    if (!visionNotice || !visionChecked || !visionAvailability(usage).ready) return;
    return run(async () => {
      const consent = await api.grantVisionConsent(visionNotice, project.media_ids);
      setVisionConsentId(consent.consent_id);
      const result = await api.revisePlan(taskId, task.current_version, requestText.trim(),
        keyFor(`plan:vision:${task.current_version}:${requestText.trim()}:${consent.consent_id}`), consent.consent_id);
      setVisionChecked(false);
      setUsage(await api.llmUsage().catch(() => usage));
      return result;
    }, (result) => visionGenerationMessage(result?.generation));
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
  const { task, checkpoints, job, plan, draft, tracks, publications } = snapshot;
  const planCheck = currentCheckpoint(checkpoints, 'plan', task);
  const draftCheck = currentCheckpoint(checkpoints, 'draft', task);
  const previewCheck = currentCheckpoint(checkpoints, 'preview', task);
  const invalidated = checkpoints.some((item) => item.status === 'invalidated');
  const visionState = visionAvailability(usage);

  return <div className="workspace-stack">
    <section className="card workspace-card"><div className="section-head"><div><p className="eyebrow">CURRENT TASK</p><h2>작업 상태</h2></div><button className="text-button" onClick={() => refresh().catch((error) => setMessage(error.message))}>최신 상태 조회</button></div>
      <div className="status-line"><span className="pill">버전 {task.current_version}</span><span className="pill light">{task.status}</span></div>
      <p className="muted">콘텐츠 해시 {task.content_hash?.slice(0, 12)}… · 다른 기기에서 수정한 경우 새로고침 후 승인해 주세요.</p>
      {invalidated && <p className="warning">이전 버전 승인이 무효화되었습니다. 현재 버전의 단계별 승인을 다시 확인해 주세요.</p>}
      <p className="notice" role="status">{message}</p>
    </section>
    <section className="card workspace-card"><p className="eyebrow">01 · PLAN</p><h2>쇼츠 기획안</h2>
      <TrendPanel api={api} onResult={setTrendResult} onTopic={(topic) => setRequestText((prior) => `${prior.trim()} ${topic} 분위기를 참고해 장면별 효과를 제안해 주세요.`.trim())} />
      {plan ? <><h3>{plan.plan.title_idea}</h3><p className="muted">{plan.plan.aspect_ratio} · {plan.plan.target_seconds}초 · 버전 {plan.content_version} · {plan.generation?.source === 'gateway' ? 'OpenAI 분석' : plan.generation?.source === 'mock' ? 'Mock 분석' : '로컬 규칙 초안'}</p>
        {plan.generation?.source === 'gateway' && plan.generation?.fallback_used && <p className="warning">OpenAI 응답에서 검증 가능한 장면 자막만 부분 반영했습니다. 기획과 자막을 직접 확인해 주세요.</p>}
        {plan.generation?.source === 'local_rules' && <p className="warning" role="alert">{visionGenerationMessage(plan.generation)}</p>}
        {plan.generation?.validation_field && <p className="muted">AI 출력 검증 항목: {plan.generation.validation_field}</p>}
        {plan.generation?.diagnostic?.provider_http_status && <p className="muted">OpenAI 응답 상태: HTTP {plan.generation.diagnostic.provider_http_status}</p>}
        {plan.generation?.diagnostic?.provider_request_id && <p className="muted">OpenAI 요청 ID: {plan.generation.diagnostic.provider_request_id}</p>}
        {plan.generation?.gate_reason === 'OPENAI_TIMEOUT' && plan.generation?.diagnostic?.stage && <p className="muted">시간 초과 단계: {{ waiting_headers: '응답 헤더 대기', reading_body: '응답 본문 수신', validating_output: '응답 검증' }[plan.generation.diagnostic.stage]} · 경과 {plan.generation.diagnostic.elapsed_ms ?? '미확인'}ms · 제한 {plan.generation.diagnostic.timeout_ms ?? '미확인'}ms · 로컬 요청 {plan.generation.diagnostic.request_started ? '시작' : '미확인'} · 응답 헤더 {plan.generation.diagnostic.headers_received ? '도착' : '미도착'}</p>}
        {plan.generation?.diagnostic?.preparation_elapsed_ms !== undefined && <p className="muted">로컬 분석 입력 준비: {plan.generation.diagnostic.preparation_elapsed_ms}ms · 샘플 {plan.generation.diagnostic.prepared_samples}개 · 실패 {plan.generation.diagnostic.preparation_failures}개</p>}
        {plan.plan.theme && <p>주제: {plan.plan.theme} · 분위기: {plan.plan.mood}<br />오프닝: {plan.plan.opening_hook}<br />흐름: {plan.plan.story_flow}<br />엔딩: {plan.plan.ending_line}<br />추천 순서: {plan.plan.recommended_media_order?.map((id) => project.media_ids.indexOf(id) + 1).join(' → ')} (적용하려면 아래에서 장면 순서를 수정해 주세요)</p>}
        {plan.plan.media_insights?.map((insight, index) => <p className="muted" key={insight.media_id}>미디어 {index + 1}: {insight.description} · 분류 {insight.category ?? '미확인'} · 구도 {insight.orientation ?? '미확인'} · {insight.usable_detail}{insight.uncertainty && ` · 불확실: ${insight.uncertainty}`}</p>)}
        {plan.plan.trend_reference && <div className="scene"><div><strong>검색에서 확인된 사실</strong><p className="muted">YouTube 제목·설명 메타데이터 · 조회 기준 {plan.plan.trend_reference.queried_at} · 키워드 {plan.plan.trend_reference.keywords.join(', ') || '없음'} · 제목 표현 {plan.plan.trend_reference.title_patterns?.join(', ') || '없음'} · 영상 내부 효과 분석 없음</p>{plan.plan.trend_reference.references.map((item) => <small key={item.url}><a href={item.url} target="_blank" rel="noopener noreferrer">참고 영상</a> · 게시 {item.published_at?.slice(0, 10)} · 조회 {item.view_count ?? '미제공'}<br /></small>)}</div></div>}
        <div className="scenes">{plan.plan.scenes.map((scene) => <div key={scene.order} className="scene"><span className="scene-number">{String(scene.order).padStart(2, '0')}</span><div><strong>{scene.start_seconds}–{scene.end_seconds}초</strong><p>{scene.visual_direction}</p><small>효과: {scene.framing ?? '프로젝트 설정'} · {scene.motion ?? '고정'} · {scene.transition ?? '컷'} · 자막 {scene.subtitle_style ?? '기본'}<br />{scene.caption_text ? `장면 문구 제안: ${scene.caption_text}` : '자막 제안 없음 · 초안에서 직접 작성'}</small></div></div>)}</div>
        <PlanSceneEditor key={`${taskId}:${task.current_version}`} api={api} taskId={taskId} task={task} plan={plan.plan} generation={plan.generation} trendResult={trendResult} busy={busy} run={run} keyFor={keyFor} />
      </> : <p className="muted">기획안을 아직 만들지 않았습니다. 로컬 규칙 기획을 요청해 주세요.</p>}
      <label htmlFor="plan-request">{plan ? '기획 수정 요청' : '기획 요청'}</label><textarea id="plan-request" rows="3" maxLength="4000" value={requestText} onChange={(event) => setRequestText(event.target.value)} placeholder="원하는 분위기와 장면 구성을 적어 주세요." />
      <div className="button-row"><button disabled={busy || !requestText.trim()} onClick={() => generatePlan(task, false)}>{plan ? '로컬 수정안 만들기' : '로컬 기획안 만들기'}</button>
        {plan && planCheck?.status === 'pending' && <button className="secondary" disabled={busy} onClick={() => run(() => api.approve(taskId, planCheck, keyFor(`approve:${planCheck.checkpoint_id}`)), '현재 기획을 중간 승인했습니다.')}>기획 중간 승인</button>}</div>
      {visionNotice && <div className="scene"><div><strong>선택 미디어 Vision 분석</strong><p>{visionNotice.disclosure}</p>
        <p className="muted">대상: 이 프로젝트의 미디어 {project.media_ids.length}개 (ID: {project.media_ids.join(', ')}) · 전송: 앞에서 최대 {Math.min(project.media_ids.length, visionNotice.vision_max_images ?? 5)}개의 축소 이미지 또는 영상 추출 프레임 · 긴 변 최대 {visionNotice.vision_max_side ?? 1024}px · 이미지당 최대 {Math.round((visionNotice.vision_max_bytes_per_image ?? 2097152) / 1048576)}MiB · 요청 문구 포함</p>
        <p className="muted">예약 비용 추정 상한: ${((visionNotice.estimated_cost_usd_max ?? 0.05) * Math.min(1, project.media_ids.length / (visionNotice.vision_max_images ?? 5))).toFixed(3)}. 실제 과금액 보증은 아닙니다. 업체: OpenAI · 목적: 쇼츠 기획 및 자막 초안</p>
        <label className="check"><input type="checkbox" checked={visionChecked} onChange={(event) => setVisionChecked(event.target.checked)} />위 대상과 전송 범위를 확인하고 이번 분석에 동의합니다.</label>
        <button disabled={busy || !requestText.trim() || !visionChecked || !visionState.ready} onClick={() => generatePlan(task, true)}>동의하고 Vision 기획안 만들기</button>
        {visionConsentId && <button className="secondary" disabled={busy} onClick={() => run(async () => { await api.revokeConsent(visionConsentId); setVisionConsentId(null); }, 'Vision 동의를 철회했습니다. 이미 전송된 데이터는 회수할 수 없습니다.')}>이번 Vision 동의 철회</button>}
        <p className="muted" role="status">{visionState.message}</p></div></div>}
      <small>수정 요청은 새 버전을 만들고 기존 승인을 무효화합니다. 로컬 버튼은 외부 AI를 호출하지 않습니다.</small>
    </section>
    <DraftSection key={`${taskId}:${task.current_version}:${draft?.checkpoint?.checkpoint_id ?? 'none'}`} api={api} task={task} taskId={taskId} draft={draft} scenes={plan?.plan?.scenes ?? []} generation={plan?.generation} tracks={tracks} checkpoint={draftCheck} busy={busy} run={run} keyFor={keyFor} />
    <section className="card workspace-card"><p className="eyebrow">03 · RENDER</p><h2>영상 미리보기</h2>
      <p className="muted">9:16 · 1080×1920 · 30fps · MP4(H.264/AAC)</p>
      {job && <p>렌더 작업: <strong>{job.status}</strong> · 단계 표시 {job.progress_percent ?? 0}% (실제 FFmpeg 인코딩 진행률이 아닙니다) {job.renderer_mode === 'test' && '· 테스트 렌더러'}<br /><small>작업 ID: {job.job_id}</small></p>}
      {job?.status === 'failed' && <p className="warning" role="alert">{renderFailureMessage(job)}{job.ffmpeg_exit_code != null && ` · FFmpeg 종료 코드 ${job.ffmpeg_exit_code}`}</p>}
      <div className="button-row"><button disabled={busy || !['render_ready', 'failed'].includes(task.status) || planCheck?.status !== 'approved' || draftCheck?.status !== 'approved'} onClick={() => run(() => api.render(taskId, task), '렌더를 요청했습니다.')}>{task.status === 'failed' ? '렌더 다시 시도' : '렌더 요청'}</button>
        {job && ['queued', 'running'].includes(job.status) && <button className="secondary" disabled={busy} onClick={() => run(() => api.cancel(job.job_id, keyFor(`cancel:${job.job_id}`)), '렌더 취소를 요청했습니다.')}>렌더 취소</button>}
        <button className="secondary" disabled={busy || !verified(task, job)} onClick={loadPreview}>인증된 MP4 불러오기</button></div>
      {previewUrl && <video controls playsInline src={previewUrl} className="video-preview" aria-label="Creator MP4 미리보기" />}
      {previewCheck?.status === 'pending' && <button disabled={busy || !previewUrl} onClick={() => run(() => api.approve(taskId, previewCheck, keyFor(`approve:${previewCheck.checkpoint_id}`)), '현재 영상의 미리보기를 중간 승인했습니다.')}>현재 영상 미리보기 승인</button>}
      {previewUrl && previewCheck?.status === 'approved' && verified(task, job) && <a className="secondary" href={previewUrl} download={`haejumi-${taskId}-v${task.current_version}.mp4`}>승인된 영상 내려받기</a>}
      <p className="muted">영상 내려받기는 수동 게시 준비용입니다. 플랫폼 권리와 계정 설정을 확인한 뒤 직접 게시해 주세요.</p>
    </section>
    <section className="card workspace-card"><p className="eyebrow">04 · PUBLICATION</p><h2>플랫폼별 게시 정보와 최종 승인</h2>
      <p className="muted">플랫폼별 승인은 독립적이며, 현재 MP4와 게시 정보의 버전·해시에 묶입니다. 실제 SNS 게시 호출은 없습니다.</p>
      {['youtube', 'tiktok', 'instagram'].map((platform) => <PublicationEditor key={`${taskId}:${platform}:${publications.find((item) => item.platform === platform)?.revision ?? 0}`}
        api={api} taskId={taskId} task={task} job={job} platform={platform} publication={publications.find((item) => item.platform === platform)}
        suggestion={publicationDraftsFromPlan(plan?.plan, plan?.generation).find((item) => item.platform === platform)}
        previewApproved={previewCheck?.status === 'approved'} busy={busy} run={run} keyFor={keyFor} />)}
    </section>
  </div>;
}

function TrendPanel({ api, onTopic, onResult }) {
  const [topic, setTopic] = useState('restaurant'); const [days, setDays] = useState(30);
  const [result, setResult] = useState(null); const [busy, setBusy] = useState(false);
  const labels = { restaurant: '맛집', cafe: '카페', travel: '여행' };
  async function search() { setBusy(true); try { const next = await api.trends(topic, Number(days)); setResult(next); onResult(next); } catch { const next = { status: 'unavailable', reason: 'API_UNAVAILABLE', items: [] }; setResult(next); onResult(next); } finally { setBusy(false); } }
  return <div className="scene"><div><h3>최근 영상 메타데이터 참고</h3><p className="muted">공식 YouTube Data API의 제목·게시일·조회·반응 지표만 사용합니다. 영상 내부의 편집 효과는 분석하지 않습니다. <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">YouTube 이용약관</a> · <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Google 개인정보처리방침</a></p>
    <label>주제 <select value={topic} onChange={(event) => { setTopic(event.target.value); setResult(null); onResult(null); }}>{Object.entries(labels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <label>최근 기간(일) <input type="number" min="1" max="90" value={days} onChange={(event) => { setDays(event.target.value); setResult(null); onResult(null); }} /></label>
    <button disabled={busy || !Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 90} onClick={search}>{busy ? '검색 중…' : '최근 영상 찾기'}</button>
    {result?.status === 'unavailable' && <p className="muted" role="status">공식 검색을 사용할 수 없습니다({result.reason}). 로컬 편집 효과를 계속 사용할 수 있습니다.</p>}
    {result?.status === 'ok' && <><p className="muted">{result.period.from.slice(0, 10)} 이후 · 메타데이터만 확인 · 영상 내부 편집 분석 없음</p>
      {result.items.map((item) => <p key={item.video_id}><a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a><br /><small>게시 {item.published_at?.slice(0, 10) ?? '미확인'} · 조회 {item.view_count ?? '미제공'} · 좋아요 {item.like_count ?? '미제공'} · 댓글 {item.comment_count ?? '미제공'} · {item.duration_seconds}초</small></p>)}
      {!result.items.length && <p className="muted">해당 기간에 확인된 짧은 영상이 없습니다.</p>}
    </>}
    <button className="secondary" onClick={() => onTopic(labels[topic])}>이 주제를 기획 요청에 반영</button>
  </div></div>;
}

function renderFailureMessage(job) {
  if (job.safe_error_code === 'FFMPEG_UNAVAILABLE') return 'PC에서 FFmpeg를 실행할 수 없습니다. 서버의 FFmpeg 경로 설정을 확인한 뒤 다시 시도해 주세요.';
  if (job.safe_error_code === 'FFPROBE_UNAVAILABLE') return 'PC에서 ffprobe를 실행할 수 없습니다. 도구 경로를 확인해 주세요.';
  if (job.safe_error_code === 'VERSION_CONFLICT') return '렌더 입력 파일 또는 콘텐츠 버전이 변경되었습니다. 현재 프로젝트를 다시 확인해 주세요.';
  if (job.diagnostic_code === 'INPUT_FORMAT') return '선택한 미디어 형식을 FFmpeg가 읽지 못했습니다. 해당 파일의 형식을 확인해 주세요.';
  if (job.diagnostic_code === 'INPUT_UNAVAILABLE') return '렌더 입력 파일 또는 필요한 리소스를 찾지 못했습니다. 서버 저장 상태를 확인해 주세요.';
  if (job.diagnostic_code === 'FILTER_OR_ENCODER') return '영상 필터 또는 인코더 설정에서 실패했습니다. 서버의 FFmpeg 설치 상태를 확인해 주세요.';
  if (job.safe_error_code === 'RENDER_VALIDATION_FAILED') return '완성된 영상이 ffprobe 규격 검증을 통과하지 못했습니다.';
  return '렌더가 완료되지 않았습니다. 입력 미디어와 FFmpeg 설치 상태를 확인한 뒤 다시 시도해 주세요.';
}

function PublicationEditor({ api, taskId, task, job, platform, publication, suggestion, previewApproved, busy, run, keyFor }) {
  const [account, setAccount] = useState(publication?.account_id ?? '');
  const [visibility, setVisibility] = useState(publication?.visibility ?? 'private');
  const [title, setTitle] = useState(publication?.title ?? '');
  const [description, setDescription] = useState(publication?.description ?? '');
  const [tags, setTags] = useState(publication?.hashtags?.join(', ') ?? '');
  const body = { platform, account_id: account.trim(), visibility, title: title.trim(), description: description.trim(),
    hashtags: tags.split(',').map((tag) => tag.trim().replace(/^#/, '')).filter(Boolean) };
  const changed = publication && JSON.stringify(body) !== JSON.stringify(Object.fromEntries(Object.keys(body).map((field) => [field, publication[field]])));
  const valid = body.account_id.length > 0 && body.account_id.length <= 128 && body.title.length <= 200 && body.description.length <= 5000 && body.hashtags.length <= 30 && body.hashtags.every((tag) => tag.length <= 100);
  const label = { youtube: 'YouTube Shorts', tiktok: 'TikTok', instagram: 'Instagram Reels' }[platform];
  return <div className="scene"><div><h3>{label}</h3><p className="muted">{publication ? `게시 정보 버전 ${publication.revision} · ${publication.status === 'publish_ready' ? '최종 승인됨' : '승인 대기'}` : '게시 정보를 입력해 주세요.'}</p>
    {suggestion?.title ? <><button className="secondary" disabled={busy} onClick={() => { setTitle(suggestion.title); setDescription(suggestion.description); setTags(suggestion.hashtags.join(', ')); }}>분석 기반 게시 문구 초안 가져오기</button><p className="muted">장면 분석의 분류·피사체를 바탕으로 만든 초안입니다. 실제 내용과 권리를 확인하고 수정해 주세요.</p></>
      : <p className="warning">확인된 시각 분석 정보가 없어 게시 문구를 자동 작성하지 않았습니다. 제목·설명·해시태그를 직접 입력해 주세요.</p>}
    <label>게시 계정 <input value={account} maxLength="128" onChange={(event) => setAccount(event.target.value)} /></label>
    <label>공개범위 <select value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="private">비공개</option><option value="unlisted">일부 공개</option><option value="followers">팔로워</option><option value="public">전체 공개</option></select></label>
    <label>제목 <input value={title} maxLength="200" onChange={(event) => setTitle(event.target.value)} /></label>
    <label>설명 <textarea value={description} maxLength="5000" onChange={(event) => setDescription(event.target.value)} /></label>
    <label>해시태그(쉼표로 구분) <input value={tags} onChange={(event) => setTags(event.target.value)} /></label>
    <div className="button-row"><button disabled={busy || !valid || (publication && !changed)} onClick={() => run(() => publication
      ? api.updatePublication(taskId, publication.publication_id, { ...body, revision: publication.revision }, keyFor(`publication:update:${publication.publication_id}:${publication.revision}:${JSON.stringify(body)}`))
      : api.createPublication(taskId, body, keyFor(`publication:create:${taskId}:${platform}:${JSON.stringify(body)}`)), '게시 정보를 저장했습니다. 변경 전 승인은 무효화됩니다.')}>게시 정보 저장</button>
      {publication && <button className="secondary" disabled={busy || !valid || changed || !previewApproved || !verified(task, job) || publication.status === 'publish_ready'}
        onClick={() => run(() => api.approvePublication(taskId, publication.publication_id, { content_version: task.current_version, content_hash: task.content_hash,
          artifact_sha256: job.artifact_sha256, publication_revision: publication.revision, publication_hash: publication.metadata_hash },
        keyFor(`publication:approve:${publication.publication_id}:${publication.revision}:${task.current_version}`)), '현재 영상과 이 플랫폼 게시 정보를 최종 승인했습니다. 실제 게시는 실행되지 않았습니다.')}>이 플랫폼 최종 승인</button>}</div>
  </div></div>;
}

function PlanSceneEditor({ api, taskId, task, plan, generation, trendResult, busy, run, keyFor }) {
  const initialRows = () => plan.scenes.map((scene) => ({ media_id: scene.media_id, media_type: scene.media_type,
    duration_seconds: Number((scene.end_seconds - scene.start_seconds).toFixed(2)), trim_start_seconds: scene.trim_start_seconds ?? 0,
    trim_end_seconds: scene.trim_end_seconds ?? '', framing: scene.framing ?? 'inherit', motion: scene.motion ?? 'static',
    transition: scene.transition ?? 'cut', subtitle_style: scene.subtitle_style ?? 'default', bgm_mood: scene.bgm_mood ?? '', edit_reason: scene.edit_reason ?? '' }));
  const [rows, setRows] = useState(initialRows);
  const [trendQuery, setTrendQuery] = useState(undefined);
  const trend = summarizeTrend(trendResult);
  const total = Math.round(rows.reduce((sum, row) => sum + Number(row.duration_seconds || 0), 0) * 100) / 100;
  const set = (index, field, value) => setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row));
  const move = (index, delta) => setRows((current) => { const next = [...current]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; return next; });
  const payload = rows.map((row) => ({ media_id: row.media_id, duration_seconds: Number(row.duration_seconds), framing: row.framing,
    motion: row.motion, transition: row.transition, subtitle_style: row.subtitle_style, bgm_mood: row.bgm_mood, edit_reason: row.edit_reason,
    ...(row.media_type.startsWith('video/') ? { trim_start_seconds: Number(row.trim_start_seconds),
      ...(row.trim_end_seconds === '' ? {} : { trim_end_seconds: Number(row.trim_end_seconds) }) } : {}) }));
  const valid = Math.abs(total - plan.target_seconds) <= 0.01 && payload.every((row) => row.duration_seconds >= 0.1 && Number.isFinite(row.duration_seconds) &&
    (row.trim_start_seconds === undefined || Number.isFinite(row.trim_start_seconds) && row.trim_start_seconds >= 0 && row.trim_start_seconds <= 3600) &&
    (row.trim_end_seconds === undefined || Number.isFinite(row.trim_end_seconds) && row.trim_end_seconds <= 3600 && row.trim_end_seconds - (row.trim_start_seconds ?? 0) + 0.001 >= row.duration_seconds));
  function applyProposal() {
    const proposed = proposeMixedEdit(plan, generation, trend);
    setRows(proposed.map((row) => ({ ...row, media_type: plan.scenes.find((scene) => scene.media_id === row.media_id).media_type,
      trim_end_seconds: row.trim_end_seconds ?? '' })));
    setTrendQuery(trend ? { topic: trend.topic, days: trend.period_days } : null);
  }
  return <div className="scenes"><h3>장면 순서와 재생 시간</h3><p className="muted">합계 {total}/{plan.target_seconds}초 · 영상은 시작 구간을 초 단위로 지정할 수 있습니다.</p>
    <div className="button-row"><button type="button" className="secondary" disabled={busy} onClick={applyProposal}>장면별 자동 혼합 편집 제안</button><button type="button" className="secondary" disabled={busy} onClick={() => { setRows(initialRows()); setTrendQuery(null); }}>현재 기획의 기본 편집으로 되돌리기</button></div>
    <p className="muted">{trend ? `검색 사실: ${trend.keywords.join(', ') || '관련 제목'} · ${trend.queried_at} 조회. 해주미의 장면 효과는 Vision 분류를 바탕으로 한 자체 추천이며 참고 영상의 실제 편집 효과를 분석한 결과가 아닙니다.` : '유효한 최근 검색 결과가 없어 Vision 장면 분류만으로 로컬 편집을 제안합니다. 시각 분석이 없는 장면은 기본 효과를 사용합니다.'}</p>
    {rows.map((row, index) => <div className="scene" key={row.media_id}><span className="scene-number">{index + 1}</span><div>
      <small>{row.media_type.startsWith('video/') ? '영상' : '사진'} · {row.media_id.slice(0, 8)}</small>
      <label>재생 초 <input type="number" min="0.1" max="59" step="0.01" value={row.duration_seconds} onChange={(event) => set(index, 'duration_seconds', event.target.value)} /></label>
      {row.media_type.startsWith('video/') && <label>시작 위치(초) <input type="number" min="0" max="3600" step="0.01" value={row.trim_start_seconds} onChange={(event) => set(index, 'trim_start_seconds', event.target.value)} /></label>}
      {row.media_type.startsWith('video/') && <label>종료 위치(초, 선택) <input type="number" min="0" max="3600" step="0.01" value={row.trim_end_seconds} onChange={(event) => set(index, 'trim_end_seconds', event.target.value)} /></label>}
      <label>화면 배치 <select value={row.framing} onChange={(event) => set(index, 'framing', event.target.value)}><option value="inherit">프로젝트 설정</option><option value="fit_pad">전체 보기</option><option value="fill_crop">가득 채우기</option><option value="blur_pad">블러 배경</option></select></label>
      <label>움직임 <select value={row.motion} onChange={(event) => set(index, 'motion', event.target.value)}><option value="static">고정</option><option value="zoom_in">천천히 확대</option><option value="zoom_out">천천히 축소</option><option value="pan_left">왼쪽으로 이동</option><option value="pan_right">오른쪽으로 이동</option></select></label>
      <label>전환 <select value={row.transition} onChange={(event) => set(index, 'transition', event.target.value)}><option value="cut">컷</option><option value="fade">검정 페이드</option></select></label>
      <label>자막 분위기 <select value={row.subtitle_style} onChange={(event) => set(index, 'subtitle_style', event.target.value)}><option value="default">기본</option><option value="emphasis">강조</option><option value="information">정보형</option></select></label>
      <small>추천 편집 스타일: {row.suggested_style === 'highlight' ? '빠른 하이라이트' : row.suggested_style === 'emotional' ? '감성' : row.suggested_style === 'information' ? '정보형' : '기본'} · 자막 문구와 음악은 별도 초안에서 확인해 주세요.</small>
      {row.edit_reason && <small>추천 근거: {row.edit_reason}</small>}
      <div className="button-row"><button className="secondary" disabled={busy || index === 0} onClick={() => move(index, -1)}>위로</button><button className="secondary" disabled={busy || index === rows.length - 1} onClick={() => move(index, 1)}>아래로</button></div>
    </div></div>)}
    <button disabled={busy || !valid} onClick={() => run(() => api.updateScenes(taskId, task, payload, keyFor(`scene:${task.current_version}:${JSON.stringify({ payload, trendQuery })}`), trendQuery), '새 장면 기획이 저장됐습니다. 현재 버전의 승인을 다시 확인해 주세요.')}>장면 구성 저장</button>
  </div>;
}

function verified(task, job) {
  return job?.status === 'succeeded' && job.renderer_mode === 'ffmpeg' && job.artifact_verified === true &&
    job.content_version === task.current_version && job.content_hash === task.content_hash && /^[a-f0-9]{64}$/i.test(job.artifact_sha256 ?? '');
}

function DraftSection({ api, task, taskId, draft, scenes, generation, tracks, checkpoint, busy, run, keyFor }) {
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
  function changeTime(index, field, value) {
    setCaptions((rows) => rows.map((row, i) => i === index ? { ...row, [field]: value } : row)); setEdited(true);
  }
  const ordered = [...captions].sort((a, b) => Number(a.start_seconds) - Number(b.start_seconds));
  const valid = ordered.every((row, index) => {
    const start = Number(row.start_seconds); const end = Number(row.end_seconds);
    return String(row.start_seconds).trim() !== '' && String(row.end_seconds).trim() !== '' && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start < end &&
      (index === 0 || start >= Number(ordered[index - 1].end_seconds)) &&
      scenes.some((scene) => start >= scene.start_seconds && end <= scene.end_seconds) &&
      row.text.trim() && !/장면\s*\d+\s*을\s*소개합니다|장면별\s*효과.*제안/u.test(row.text);
  });
  function save() {
    const body = { content_version: task.current_version, content_hash: task.content_hash,
      captions: ordered.map((row, index) => ({ order: index + 1, start_seconds: Number(row.start_seconds), end_seconds: Number(row.end_seconds), text: row.text })),
      captions_enabled: enabled, music_track_id: trackId || null, source_volume: Number(sourceVolume), music_volume: Number(musicVolume),
      fade_in_seconds: Number(fadeIn), fade_out_seconds: Number(fadeOut) };
    run(() => api.updateDraft(taskId, body, keyFor(`draft:${task.current_version}:${JSON.stringify(body)}`)), '자막·음악 변경으로 버전이 올랐습니다. 기획부터 다시 승인해 주세요.');
  }
  return <section className="card workspace-card"><p className="eyebrow">02 · CAPTIONS & MUSIC</p><h2>자막·음악 초안</h2>
    <p className="muted">장면 안에서 자막의 시작·종료 시간과 문구를 수정하세요. 한 장면에 여러 자막을 넣거나 자막 없이 둘 수 있습니다.</p>
    {captions.length === 0 && <p className="warning" role="status">{generation?.source === 'local_rules' ? `${visionGenerationMessage(generation)} 자막 없이 렌더하면 MP4에도 자막이 표시되지 않습니다.`
      : '이 버전에는 영상 자막이 없습니다. 자막 없이 렌더하면 MP4에도 자막이 표시되지 않습니다.'}</p>}
    <label className="check"><input type="checkbox" checked={enabled} onChange={(event) => { setEnabled(event.target.checked); setEdited(true); }} /> 자막 합성</label>
    <div className="caption-add-actions">{scenes.map((scene) => <button type="button" className="secondary caption-small-button" key={scene.order} disabled={busy || captions.length >= 30} onClick={() => { setCaptions((rows) => [...rows, { start_seconds: scene.start_seconds, end_seconds: scene.end_seconds, text: '' }]); setEdited(true); }}>+ 장면 {scene.order} 자막</button>)}</div>
    <div className="caption-cards">{captions.map((row, index) => {
      const scene = scenes.find((item) => Number(row.start_seconds) >= item.start_seconds && Number(row.end_seconds) <= item.end_seconds);
      return <section key={index} className="caption-edit-card"><div className="caption-card-head"><strong>장면 {scene?.order ?? '시간 확인'} · 자막 {index + 1}</strong><button type="button" className="secondary caption-small-button" onClick={() => { setCaptions((rows) => rows.filter((_, i) => i !== index)); setEdited(true); }}>삭제</button></div>
        <div className="caption-time-grid"><label>시작(초)<input type="number" min="0" max={task.target_seconds} step="0.01" value={row.start_seconds} onChange={(event) => changeTime(index, 'start_seconds', event.target.value)} /></label><label>종료(초)<input type="number" min="0" max={task.target_seconds} step="0.01" value={row.end_seconds} onChange={(event) => changeTime(index, 'end_seconds', event.target.value)} /></label></div>
        <label className="caption-text-label">영상 자막<textarea rows="3" value={row.text} maxLength="80" onChange={(event) => changeCaption(index, event.target.value)} /></label>
      </section>;
    })}</div>
    {!valid && <p role="alert">자막 문구와 시간을 확인해 주세요. 자막은 한 장면 안에 있어야 하며 서로 겹칠 수 없습니다.</p>}
    <label htmlFor="music">로컬 BGM</label><select id="music" value={trackId} onChange={(event) => { setTrackId(event.target.value); setEdited(true); }}><option value="">음악 없음</option>{tracks.filter((track) => track.status === 'available').map((track) => <option key={track.track_id} value={track.track_id}>{track.title} · {track.rights_status === 'user_verified' ? '사용자 권리 확인' : '권리 미확인'}</option>)}</select>
    <div className="number-grid">{[['원음 음량', sourceVolume, setSourceVolume, 2], ['BGM 음량', musicVolume, setMusicVolume, 2], ['페이드 인(초)', fadeIn, setFadeIn, 10], ['페이드 아웃(초)', fadeOut, setFadeOut, 10]].map(([label, value, setter, max]) => <label key={label}>{label}<input type="number" min="0" max={max} step="0.1" value={value} onChange={(event) => { setter(event.target.value); setEdited(true); }} /></label>)}</div>
    <div className="button-row"><button className="secondary" disabled={busy || !edited || !valid} onClick={save}>자막·음악 변경 저장</button>
      {checkpoint?.status === 'pending' && <button disabled={busy || edited} onClick={() => run(() => api.approve(taskId, checkpoint, keyFor(`approve:${checkpoint.checkpoint_id}`)), '현재 초안을 중간 승인했습니다.')}>초안 중간 승인</button>}</div>
    <small>선택한 음원의 플랫폼별 상업 이용 권리와 원본 오디오 권리는 최종 승인 시 서버에서 다시 검사합니다.</small>
  </section>;
}
