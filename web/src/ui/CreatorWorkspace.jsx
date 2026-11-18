import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api.js';
import { visionAvailability, visionGenerationMessage } from '../vision-availability.js';
import { publicationDraftsFromPlan } from '../../../shared/publication-drafts.js';
import { proposeBasicEdit, proposeReferenceEdit, hasVisibleEditDifference, summarizeTrend } from '../../../shared/trend-edit.js';
import '../caption-editor.css';

const currentCheckpoint = (items, kind, task) => items.find((item) => item.kind === kind && item.content_version === task.current_version &&
  item.content_hash === task.content_hash && ['pending', 'approved'].includes(item.status));

export function CreatorWorkspace({ api, project, onChanged, onBack }) {
  const [snapshot, setSnapshot] = useState(null);
  const [message, setMessage] = useState('작업을 불러오고 있습니다.');
  const [requestText, setRequestText] = useState('');
  const [visionNotice, setVisionNotice] = useState(null);
  const [visionChecked, setVisionChecked] = useState(false);
  const [visionConsentId, setVisionConsentId] = useState(null);
  const [usage, setUsage] = useState(null);
  const [trendResult, setTrendResult] = useState(null);
  const [styleReferences, setStyleReferences] = useState([]);
  const [selectedReferenceIds, setSelectedReferenceIds] = useState([]);
  const referencesLoaded = useRef(false);
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const previewRef = useRef(null);
  const keys = useRef(new Map());
  const taskId = project.task_id;
  const draftKey = `haejumi:creator-plan:${taskId}`;

  const refresh = useCallback(async () => {
    const task = await api.task(taskId);
    const [checkpoints, jobs, tracks, publications, references] = await Promise.all([api.checkpoints(taskId), api.jobs(taskId), api.tracks(), api.publications(taskId), api.styleReferences(taskId)]);
    setStyleReferences(references.items);
    if (!referencesLoaded.current) {
      let saved = null;
      try { saved = JSON.parse(sessionStorage.getItem(draftKey) ?? 'null'); } catch { /* Ignore stale local UI state. */ }
      setSelectedReferenceIds(Array.isArray(saved?.reference_ids) ? saved.reference_ids.filter((id) => references.items.some((item) => item.reference_id === id)) : references.selected_ids);
      setRequestText(typeof saved?.request_text === 'string' ? saved.request_text : '');
      referencesLoaded.current = true;
    }
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
  }, [api, taskId, draftKey]);

  useEffect(() => {
    setSnapshot(null); setRequestText(''); setTrendResult(null); setStyleReferences([]); setSelectedReferenceIds([]);
    referencesLoaded.current = false; setMessage('작업을 불러오고 있습니다.'); keys.current.clear();
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

  useEffect(() => {
    if (!referencesLoaded.current) return;
    try { sessionStorage.setItem(draftKey, JSON.stringify({ reference_ids: selectedReferenceIds, request_text: requestText })); } catch { /* Browser storage may be unavailable. */ }
  }, [draftKey, selectedReferenceIds, requestText]);

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
    const instruction = requestText.trim() || '선택한 미디어로 쇼츠 기획안을 만들어 주세요.';
    if (!useVision) return run(() => api.revisePlan(taskId, task.current_version, instruction,
      keyFor(`plan:local:${task.current_version}:${instruction}:${selectedReferenceIds.join(',')}`), null, selectedReferenceIds), '새 기획안이 준비됐습니다.');
    if (!visionNotice || !visionChecked || !visionAvailability(usage).ready) return;
    return run(async () => {
      const consent = await api.grantVisionConsent(visionNotice, project.media_ids);
      setVisionConsentId(consent.consent_id);
      const result = await api.revisePlan(taskId, task.current_version, instruction,
        keyFor(`plan:vision:${task.current_version}:${instruction}:${consent.consent_id}:${selectedReferenceIds.join(',')}`), consent.consent_id, selectedReferenceIds);
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
  const mediaAnalysis = plan?.generation?.media_analysis ?? [];
  const analyzedCount = mediaAnalysis.filter((item) => ['analyzed', 'cached'].includes(item.status)).length;
  const reviewCount = mediaAnalysis.filter((item) => item.caption_status === 'needs_review').length;

  return <div className="workspace-stack">
    <section className="card workspace-card creator-overview"><div className="section-head"><div><p className="eyebrow">예투와 쇼츠 만들기</p><h2>{plan?.plan?.title_idea || '새 쇼츠 프로젝트'}</h2></div><div className="button-row"><button className="text-button" onClick={onBack}>목록으로</button><button className="text-button" onClick={() => refresh().catch((error) => setMessage(error.message))}>새로고침</button></div></div>
      <div className="status-line"><span className="pill">버전 {task.current_version}</span><span className="pill light">{task.status}</span><span className="pill light">{busy ? '저장 중…' : '서버와 동기화됨'}</span></div>
      <div className="creator-steps" aria-label="쇼츠 제작 단계"><span className={planCheck?.status === 'approved' ? 'done' : 'current'}>1 기획</span><span className={draftCheck?.status === 'approved' ? 'done' : planCheck?.status === 'approved' ? 'current' : ''}>2 자막·음악</span><span className={previewCheck?.status === 'approved' ? 'done' : draftCheck?.status === 'approved' ? 'current' : ''}>3 영상 확인</span><span className={previewCheck?.status === 'approved' ? 'current' : ''}>4 게시 준비</span></div>
      {invalidated && <p className="warning">이전 버전 승인이 무효화되었습니다. 현재 버전의 단계별 승인을 다시 확인해 주세요.</p>}
      <p className="notice" role="status">{message}</p>
    </section>
    <section className="card workspace-card creator-stage"><p className="eyebrow">01 · PLAN</p><h2>예투에게 영상 부탁하기</h2>
      <label htmlFor="plan-request">어떤 영상으로 만들까요?</label>
      <textarea id="plan-request" rows="2" maxLength="4000" value={requestText} onChange={(event) => setRequestText(event.target.value)} placeholder="예: 피크닉 사진으로 따뜻하고 재미있는 쇼츠를 만들어줘." />
      <p className="muted">선택한 참고 자료 {selectedReferenceIds.length}개 · 확인 가능한 내용만 기획에 사용합니다.</p>
      <details className="workspace-disclosure"><summary>영상 스타일 참고 <small>최근 인기 영상 · URL · 직접 선택한 파일</small></summary>
      <TrendPanel api={api} taskId={taskId} requestText={requestText} onResult={setTrendResult}
        references={styleReferences} selectedIds={selectedReferenceIds} onSelect={setSelectedReferenceIds} onRefresh={refresh} busy={busy} />
      </details>
      {plan ? <><h3>{plan.plan.title_idea}</h3><p className="muted">{plan.plan.aspect_ratio} · {plan.plan.target_seconds}초 · 버전 {plan.content_version} · {plan.generation?.source === 'gateway' ? 'OpenAI 분석' : plan.generation?.source === 'mock' ? 'Mock 분석' : '로컬 규칙 초안'}</p>
        <p className="creator-plan-summary">{plan.plan.theme || '장면 주제 확인 필요'} · {plan.plan.scenes.length}장면 · {plan.plan.mood || '분위기 미지정'}</p>
        {mediaAnalysis.length > 0 && <p className="creator-analysis-summary" role="status">미디어 {analyzedCount}/{mediaAnalysis.length}개 분석 · 자막 후보 {reviewCount}개 검토 필요</p>}
        {plan.plan.user_context?.place && <p className="muted">사용자 제공 장소: {plan.plan.user_context.place} · 사진 분석으로 확인된 위치 정보는 아닙니다.</p>}
        {plan.generation?.caption_refinement?.requested_caption_reflected && <p className="muted">요청하신 장소 자막을 검토용 초안에 반영했습니다. 장소와 사진의 관계를 확인해 주세요.</p>}
        {plan.generation?.caption_refinement?.requested_caption_required && !plan.generation.caption_refinement.requested_caption_reflected && <p className="warning" role="alert">요청하신 {plan.plan.user_context?.place ? `'${plan.plan.user_context.place}' ` : ''}장소 자막이 아직 반영되지 않았습니다. 자막 초안에서 직접 추가하거나 요청을 구체적으로 다시 적어 주세요.</p>}
        {plan.generation?.caption_refinement?.repeated_location_prefixes_removed > 0 && <p className="muted">반복된 위치 표현 {plan.generation.caption_refinement.repeated_location_prefixes_removed}곳을 초안에서 줄였습니다.</p>}
        {plan.generation?.caption_refinement?.generic_location_captions_omitted > 0 && <p className="warning">확인되지 않은 일반 장소 표현이 포함된 자막 {plan.generation.caption_refinement.generic_location_captions_omitted}개를 초안에서 제외했습니다. 해당 장면에 필요한 문구를 직접 확인해 주세요.</p>}
        {plan.generation?.caption_style_review?.duplicate_captions_omitted > 0 && <p className="warning">같은 문구가 반복된 자막 {plan.generation.caption_style_review.duplicate_captions_omitted}개를 제외했습니다. 해당 사진의 자막을 직접 확인해 주세요.</p>}
        {(plan.generation?.caption_style_review?.repeated_endings_for_review > 0 || plan.generation?.caption_style_review?.formal_endings_for_review > 0) && <p className="muted">비슷한 어미나 설명체 자막이 남아 있을 수 있습니다. 사진과 자막을 함께 보며 자연스러운 문구로 수정해 주세요.</p>}
        {plan.generation?.source !== 'local_rules' && <p className="warning">AI 기획에 나온 장소·동행 관계·시간대 등은 확인되지 않은 추정일 수 있습니다. 실제 사진과 대조한 뒤 기획과 자막을 승인해 주세요.</p>}
        {plan.plan.media_insights?.length > 0 && <div className="creator-insight-grid" aria-label="사진별 분석과 자막 후보">{plan.plan.media_insights.map((insight, index) => {
          const scene = plan.plan.scenes.find((item) => item.media_id === insight.media_id);
          const analysis = mediaAnalysis.find((item) => item.media_id === insight.media_id);
          return <div className="creator-insight-card" key={insight.media_id}>
            {scene && !scene.media_type.startsWith('video/') ? <img src={`/api/v1/media/${insight.media_id}/image-preview`} alt={`미디어 ${index + 1} 사진`} loading="lazy" /> : <span className="creator-insight-placeholder">영상 {index + 1}</span>}
            <div><strong>미디어 {index + 1} · {analysis?.status === 'analyzed' ? 'AI 분석' : analysis?.status === 'cached' ? '기존 분석 재사용' : '내용 확인 필요'}</strong>
              <p>{insight.description || '사진 내용을 확인해 주세요.'}</p>
              <small>{draft ? '현재 자막 초안' : '기획 자막 후보'}: {draft ? draft.captions.filter((caption) => caption.media_id === insight.media_id).map((caption) => caption.text).join(' / ') || '없음 · 초안에서 직접 작성' : scene?.caption_text || '없음 · 초안에서 직접 작성'}</small>
              <small>{analysis?.caption_status === 'needs_review' ? '사진과 문구를 확인한 뒤 승인해 주세요.' : '자막 여부를 초안에서 확인해 주세요.'}</small>
            </div>
          </div>;
        })}</div>}
        <p className="muted">{draft ? <a href="#creator-captions">자막·음악 초안에서 문구와 시간을 수정할 수 있습니다.</a> : '기획을 승인한 뒤 자막·음악 초안에서 문구와 시간을 수정할 수 있습니다.'}</p>
        <details className="workspace-disclosure"><summary>기획 전체 내용·분석 근거·장면 효과 편집 <small>필요할 때 펼쳐 보세요</small></summary>
        {plan.generation?.media_analysis && <div className="scene"><div><strong>사진별 분석 상태 · {plan.generation.planning_source === 'vision_text_plan' ? '이미지 없는 전체 기획' : '분석 결과로 로컬 기획'}</strong>
          {plan.generation.media_analysis.map((item, index) => <p className="muted" key={item.media_id}>미디어 {index + 1}: {{ analyzed: '분석 완료 · 사진 내용은 확인 필요', cached: '기존 분석 재사용 · 사진 내용은 확인 필요', failed: '분석 실패', skipped: '동의·예산 차단으로 미분석', unavailable: '분석 샘플 없음' }[item.status] ?? '미확인'}{item.reason ? ` (${item.reason})` : ''}{item.caption_status === 'needs_review' ? ' · 자막 후보 검토 필요' : item.caption_status === 'unavailable' ? ` · 짧은 자막 후보 없음 (${item.caption_reason ?? item.caption_diagnostic?.validation_code ?? '생성 불가'})` : ''}</p>)}
          {plan.generation.story_analysis?.status === 'failed' && <p className="muted">전체 스토리 결과를 적용하지 못했습니다: {plan.generation.story_analysis.reason} · 검증 항목 {plan.generation.story_analysis.diagnostic?.field_path ?? '미확인'} · {plan.generation.story_analysis.diagnostic?.validation_code ?? '상세 진단 없음'}</p>}
        </div></div>}
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
        {plan.plan.style_references?.length > 0 && <div className="scene"><div><strong>현재 기획에 저장된 레퍼런스</strong>{plan.plan.style_references.map((item) => <p className="muted" key={item.reference_id}>{item.kind === 'trend' ? `최근 ${item.days}일 ${item.topic} 영상 ${item.trend_summary?.references.length ?? 0}편` : item.kind === 'upload' ? `직접 선택 영상 · ${item.analysis?.duration_seconds}초 · 화면 변화 추정 ${item.analysis?.pace ?? '미확인'}` : `${item.platform} · ${item.metadata?.title || '제목 미확인'}`} · {item.analysis_scope === 'metadata_only' ? '메타데이터 기반 참고 · 영상 내부 분석 없음' : item.analysis_scope === 'local_video_sample' ? '로컬 영상 샘플 분석' : '영상 내용 미분석'} · {item.note || '추가 스타일 설명 없음'}</p>)}{plan.plan.style_application && <p className="muted">실제 기획 장면 효과: 배치·움직임·전환·자막 스타일·색감에 해주미 로컬 규칙을 적용했습니다. {plan.plan.style_application.limitation}</p>}</div></div>}
        <div className="scenes">{plan.plan.scenes.map((scene) => <div key={scene.order} className="scene"><span className="scene-number">{String(scene.order).padStart(2, '0')}</span><div><strong>{scene.start_seconds}–{scene.end_seconds}초</strong><p>{scene.visual_direction}</p><small>저장된 렌더 효과: {scene.framing ?? '프로젝트 설정'} · {scene.motion ?? '고정'} · {scene.transition ?? '컷'} · {editStyleLabel(scene.edit_style)} · 자막 {scene.subtitle_style ?? '기본'}<br />{scene.caption_text ? `장면 문구 제안: ${scene.caption_text}` : '자막 제안 없음 · 초안에서 직접 작성'}</small></div></div>)}</div>
        <PlanSceneEditor key={`${taskId}:${task.current_version}`} api={api} taskId={taskId} task={task} plan={plan.plan} generation={plan.generation} trendResult={trendResult} references={selectedReferenceIds.map((id) => styleReferences.find((item) => item.reference_id === id)).filter(Boolean)} selectedReferenceIds={selectedReferenceIds} planApproval={planCheck?.status} draftApproval={draftCheck?.status} busy={busy} run={run} keyFor={keyFor} />
        </details>
      </> : <p className="muted">기획안을 아직 만들지 않았습니다. 로컬 규칙 기획을 요청해 주세요.</p>}
      {plan && planCheck?.status === 'pending' && <button className="secondary" disabled={busy} onClick={() => run(() => api.approve(taskId, planCheck, keyFor(`approve:${planCheck.checkpoint_id}`)), '현재 기획을 중간 승인했습니다.')}>기획 중간 승인</button>}
      <div className="creator-vision-consent">
        <strong>OpenAI Vision 분석 (선택)</strong>
        <p>체크하고 기획안을 생성하면 OpenAI에 선택 미디어 최대 {Math.min(project.media_ids.length, visionNotice?.vision_max_images ?? 5)}개의 축소 이미지·영상 프레임과 기획 요청을 전송합니다. 목적은 쇼츠 기획과 자막 후보 생성이며, 외부 업체 처리입니다.</p>
        <p className="muted">긴 변 최대 {visionNotice?.vision_max_side ?? 1024}px · 이미지당 최대 {Math.round((visionNotice?.vision_max_bytes_per_image ?? 2097152) / 1048576)}MiB · 예약 비용 추정 상한 ${((visionNotice?.estimated_cost_usd_max ?? 0.05) * Math.min(1, project.media_ids.length / (visionNotice?.vision_max_images ?? 5))).toFixed(3)} (실제 과금액 보증 아님)</p>
        <label className="check"><input type="checkbox" checked={visionChecked} disabled={!visionNotice || !visionState.ready || busy} onChange={(event) => setVisionChecked(event.target.checked)} />위 전송 범위와 비용을 확인했고, 이번 기획의 OpenAI Vision 분석에 동의합니다.</label>
        <details className="workspace-disclosure"><summary>전송 대상·동의 상세 보기</summary><div className="creator-disclosure-body"><p>{visionNotice?.disclosure ?? '동의 안내를 불러오지 못했습니다. Vision 분석을 선택할 수 없습니다.'}</p>
          <p className="muted">대상 미디어 ID: {project.media_ids.join(', ')} · 신규 사진은 사진당 1회 분석하며 호출 여유가 있으면 이미지 없는 전체 기획을 1회 요청합니다. 기존 분석 캐시를 사용하면 이미지 재전송이 없습니다. 이미 전송된 데이터는 동의 철회로 회수할 수 없습니다.</p></div></details>
        {!visionState.ready && <p className="muted" role="status">{visionState.message}</p>}
        {visionConsentId && <div className="creator-consent-status"><span>이 화면에서 발급한 Vision 동의가 있습니다.</span><button className="secondary caption-small-button" disabled={busy} onClick={() => run(async () => { await api.revokeConsent(visionConsentId); setVisionConsentId(null); setVisionChecked(false); }, 'Vision 동의를 철회했습니다. 이미 전송된 데이터는 회수할 수 없습니다.')}>이번 Vision 동의 철회</button></div>}
      </div>
      <button disabled={busy || (visionChecked && !visionState.ready)} onClick={() => generatePlan(task, visionChecked)}>쇼츠 기획안 생성</button>
      <small>체크하지 않으면 외부 AI를 호출하지 않고 로컬 기획안을 만듭니다. 새 기획은 콘텐츠 버전을 올리고 기존 승인을 무효화합니다.</small>
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
    <section className="card workspace-card"><p className="eyebrow">04 · PUBLICATION</p><h2>게시 준비</h2>
      <p className="muted">YouTube는 최종 업로드 확인 시 현재 영상과 게시 정보를 승인합니다. TikTok·Instagram은 수동 게시 준비용이며 자동 게시를 지원하지 않습니다.</p>
      {previewCheck?.status !== 'approved' && <p className="muted">영상 미리보기를 승인한 뒤 플랫폼별 정보를 확인할 수 있습니다.</p>}
      {previewCheck?.status === 'approved' && ['youtube', 'tiktok', 'instagram'].map((platform) => <PublicationEditor key={`${taskId}:${platform}:${publications.find((item) => item.platform === platform)?.revision ?? 0}`}
        api={api} taskId={taskId} task={task} job={job} platform={platform} publication={publications.find((item) => item.platform === platform)} refresh={refresh} previewUrl={previewUrl}
        suggestion={publicationDraftsFromPlan(plan?.plan, plan?.generation).find((item) => item.platform === platform)}
        previewApproved={previewCheck?.status === 'approved'} busy={busy} run={run} keyFor={keyFor} />)}
    </section>
  </div>;
}

function TrendPanel({ api, taskId, requestText, onResult, references, selectedIds, onSelect, onRefresh, busy: workspaceBusy }) {
  const [tab, setTab] = useState('popular');
  const [result, setResult] = useState(null); const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState(''); const [note, setNote] = useState(''); const [file, setFile] = useState(null);
  const [uploadedMediaId, setUploadedMediaId] = useState(null); const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [uploadState, setUploadState] = useState('idle');
  const [notice, setNotice] = useState('');
  const labels = { restaurant: '맛집', cafe: '카페', travel: '여행' };
  async function addAutomaticTrend() {
    const inferredTopic = /라면|음식|맛집|식당|메뉴|요리/.test(requestText) ? 'restaurant'
      : /카페|커피|디저트|베이커리/.test(requestText) ? 'cafe'
      : /여행|풍경|피크닉|바다|산|호수/.test(requestText) ? 'travel' : null;
    if (!inferredTopic) { setNotice('예투에게 원하는 영상에 여행·맛집·카페 중 어떤 내용이 담겼는지 적어 주세요. 사진 내용은 임의로 추측하지 않습니다.'); return; }
    setBusy(true); setNotice('최근 영상의 공개 메타데이터를 확인하고 있습니다.');
    try {
      const next = await api.trends(inferredTopic, 30); setResult(next); onResult(next);
      if (next.status !== 'ok' || next.items.length < 2) { setNotice('관련 영상이 부족하거나 검색을 사용할 수 없어 자동 참고를 추가하지 않았습니다. 로컬 기획은 계속 사용할 수 있습니다.'); return; }
      const added = await api.addStyleReference(taskId, { kind: 'trend', topic: inferredTopic, days: 30, note: '' });
      onSelect((prior) => prior.includes(added.reference_id) ? prior : [...prior, added.reference_id]);
      await onRefresh(); setNotice(`최근 30일 ${labels[inferredTopic]} 검색 메타데이터를 참고 목록에 추가했습니다. 영상 내부 효과는 분석하지 않았습니다.`);
    } catch (error) { setNotice(`자동 참고를 추가하지 못했습니다: ${error.message}`); } finally { setBusy(false); }
  }
  async function add(body) {
    setBusy(true); setNotice('참고 정보를 확인하고 있습니다.');
    try { const added = await api.addStyleReference(taskId, body); const alreadyRegistered = references.some((item) => item.reference_id === added.reference_id);
      onSelect((prior) => prior.includes(added.reference_id) ? prior : [...prior, added.reference_id]); await onRefresh();
      setNotice(alreadyRegistered ? '이미 등록된 레퍼런스를 선택했습니다. 중복 후보는 만들지 않았습니다.' : added.analysis_scope === 'local_video_sample' ? 'PC에서 선택한 영상의 길이와 화면 변화 샘플을 분석했습니다.' :
        added.analysis_scope === 'metadata_only' ? '공식 메타데이터만 확인했습니다. 영상 내부 편집은 분석하지 않았습니다.' : 'URL을 저장했습니다. 영상 내부 정보는 확인하지 못했습니다.');
    } catch (error) { setNotice(error.message); } finally { setBusy(false); }
  }
  async function addUpload() {
    if (!file || !rightsConfirmed) return;
    setBusy(true); setUploadState('analyzing'); setNotice('선택한 영상을 로컬 서버에 업로드하고 있습니다.');
    try { const mediaId = uploadedMediaId ?? await api.upload(file); setUploadedMediaId(mediaId);
      const added = await api.addStyleReference(taskId, { kind: 'upload', media_id: mediaId, note });
      onSelect((prior) => prior.includes(added.reference_id) ? prior : [...prior, added.reference_id]); await onRefresh(); setUploadState('complete'); setNotice('로컬 참고 영상 분석이 완료됐습니다. 원본 화면·음원은 출력 영상에 복사하지 않습니다.');
    } catch (error) { setUploadState('failed'); setNotice(`참고 영상 분석 실패: ${error.message} 선택한 파일은 유지되며 다시 시도할 수 있습니다.`); } finally { setBusy(false); }
  }
  async function remove(id) {
    setBusy(true); try { await api.deleteStyleReference(taskId, id); onSelect((prior) => prior.filter((item) => item !== id)); await onRefresh(); setNotice('레퍼런스를 삭제했습니다.'); }
    catch (error) { setNotice(error.message); } finally { setBusy(false); }
  }
  const move = (id, direction) => onSelect((prior) => { const next = [...prior]; const index = next.indexOf(id); const target = index + direction;
    if (index < 0 || target < 0 || target >= next.length) return prior; [next[index], next[target]] = [next[target], next[index]]; return next; });
  return <div className="scene"><div><h3>레퍼런스 가져오기</h3><p className="muted">세 가지 방법을 자유롭게 조합할 수 있습니다. 등록과 분석은 기획 실행과 별개이며, 선택한 항목은 아래에서 확인할 수 있습니다.</p>
    <div className="button-row" role="tablist" aria-label="레퍼런스 가져오기 방법">
      {[["popular", "인기 영상"], ["url", "URL 입력"], ["upload", "파일 업로드"]].map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? '' : 'secondary'} onClick={() => setTab(id)}>{label}</button>)}
    </div>
    {tab === 'popular' && <div role="tabpanel"><h4>최근 인기 영상 참고</h4><p className="muted">예투에게 쓴 요청에서 맛집·카페·여행 주제를 파악해 최근 30일의 공개 메타데이터를 참고합니다. 버튼을 누를 때만 공식 YouTube Data API를 검색하며 일일 10회 제한과 15분 캐시를 적용합니다. 영상 내부 효과는 분석하지 않습니다.</p>
    <button type="button" className="secondary" disabled={busy || workspaceBusy || references.length >= 8} onClick={addAutomaticTrend}>{busy ? '확인 중…' : '요청 내용으로 최근 영상 자동 참고'}</button>
    {result?.status === 'unavailable' && <p className="muted" role="status">공식 검색을 사용할 수 없습니다({result.reason}). 로컬 편집은 계속 사용할 수 있습니다.</p>}
    {result?.status === 'ok' && <><p className="muted">{result.period.from.slice(0, 10)} 이후 · 메타데이터 기반 참고 · 영상 내부 분석 없음</p>
      {result.items.length < 2 && <p className="muted">관련 영상이 두 편 이상 확인되지 않아 기간별 공통 경향은 추가할 수 없습니다.</p>}
      <details className="workspace-disclosure"><summary>검색된 영상 보기 <small>{result.items.length}편 · 개별 선택은 선택 사항</small></summary><div className="creator-disclosure-body">{result.items.map((item) => <p key={item.video_id}><a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a><br /><small>게시 {item.published_at?.slice(0, 10) ?? '미확인'} · 조회 {item.view_count ?? '미제공'} · 좋아요 {item.like_count ?? '미제공'} · {item.duration_seconds}초 · Shorts 여부 미확인</small><br /><button className="secondary" disabled={busy || references.length >= 8} onClick={() => add({ kind: 'search', topic: result.topic, days: 30, video_id: item.video_id, note })}>이 영상도 참고</button></p>)}</div></details>
      {!result.items.length && <p className="muted">해당 기간에 확인된 짧은 영상이 없습니다.</p>}
    </>}
    </div>}
    {tab === 'url' && <div role="tabpanel"><h4>참고 영상 URL 추가</h4><label>HTTPS YouTube Shorts·Instagram Reels·TikTok URL <input type="url" value={url} maxLength="500" onChange={(event) => setUrl(event.target.value)} placeholder="https://www.youtube.com/shorts/…" /></label>
    <button className="secondary" disabled={busy || workspaceBusy || !url.trim() || references.length >= 8} onClick={() => add({ kind: 'url', url: url.trim(), note })}>URL 등록·접근 정보 확인</button>
    <p className="muted">YouTube는 공식 API가 활성화된 경우 공개 메타데이터만 조회합니다. Instagram·TikTok은 현재 접근 권한이 없어 URL과 사용자 설명만 저장합니다. 영상을 다운로드하거나 로그인·DRM을 우회하지 않습니다.</p></div>}
    {tab === 'upload' && <div role="tabpanel"><h4>참고 영상 직접 업로드</h4><label>권리를 가진 MP4·MOV 선택 <input type="file" accept="video/mp4,video/quicktime,.mp4,.mov" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setUploadedMediaId(null); setRightsConfirmed(false); setUploadState('idle'); }} /></label>
    {file && <p className="muted">선택한 파일: {file.name} · {Math.round(file.size / 1048576 * 10) / 10} MiB · {uploadState === 'analyzing' ? '분석 중' : uploadState === 'complete' ? '분석 완료' : uploadState === 'failed' ? '실패 · 재시도 가능' : '미분석'}</p>}
    <label className="check"><input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} />이 영상의 분석 권한을 가지고 있으며 직접 선택했습니다.</label>
    <button className="secondary" disabled={busy || workspaceBusy || !file || !rightsConfirmed || references.length >= 8} onClick={addUpload}>{uploadedMediaId ? '업로드된 영상 분석 다시 시도' : '선택 영상 업로드·로컬 분석'}</button>
    <p className="muted">길이·화면 비율과 축소 샘플의 화면 변화만 분석합니다. 자막 글꼴·음악·감정·실제 컷은 자동 판정하지 않습니다. 외부 AI로 전송하지 않습니다.</p></div>}
    <label>원하는 편집 느낌 <textarea rows="3" maxLength="500" value={note} onChange={(event) => setNote(event.target.value)} placeholder="예: 빠르게 전개하되 자막은 깔끔하게" /></label>
    <h3>내 레퍼런스</h3><p className="muted">{selectedIds.length}개 선택 · 위에 있는 항목 우선 · 선택만으로 기존 승인이나 렌더가 바뀌지 않습니다.</p>
    {references.map((item) => <div className="scene" key={item.reference_id}><div><label className="check"><input type="checkbox" checked={selectedIds.includes(item.reference_id)} onChange={(event) => onSelect((prior) => event.target.checked ? [...prior, item.reference_id] : prior.filter((id) => id !== item.reference_id))} />{item.kind === 'trend' ? `최근 ${item.days}일 ${labels[item.topic]} 경향` : item.kind === 'upload' ? '직접 선택 영상' : item.metadata?.title || `${item.platform} URL`}</label>
      <small>{item.kind === 'trend' ? '트렌드' : item.kind === 'upload' ? '업로드' : 'URL·영상'} · {item.analysis_scope === 'metadata_only' ? '메타데이터만 확인' : item.analysis_scope === 'local_video_sample' ? '로컬 분석 완료' : '영상 내용 미분석'} · {item.trend_summary && `관련 영상 ${item.trend_summary.references.length}편 · 키워드 ${item.trend_summary.keywords.join(', ') || '없음'} · `}{item.analysis?.pace && `화면 변화 추정: ${item.analysis.pace} · `}{item.note || '스타일 설명 없음'}</small>
      <div className="button-row"><button className="secondary" disabled={busy || !selectedIds.includes(item.reference_id) || selectedIds[0] === item.reference_id} onClick={() => move(item.reference_id, -1)}>우선</button><button className="secondary" disabled={busy || !selectedIds.includes(item.reference_id) || selectedIds.at(-1) === item.reference_id} onClick={() => move(item.reference_id, 1)}>뒤로</button><button className="secondary" disabled={busy} onClick={() => remove(item.reference_id)}>삭제</button></div></div></div>)}
    {!references.length && <p className="muted">저장된 레퍼런스가 없습니다.</p>}
    <p className="muted" role="status">{notice}</p>
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

function PublicationEditor({ api, taskId, task, job, platform, publication, suggestion, previewApproved, busy, run, keyFor, refresh, previewUrl }) {
  const [account, setAccount] = useState(publication?.account_id ?? '');
  const [visibility, setVisibility] = useState(publication?.visibility ?? 'private');
  const [title, setTitle] = useState(publication?.title ?? '');
  const [description, setDescription] = useState(publication?.description ?? '');
  const [tags, setTags] = useState(publication?.hashtags?.join(', ') ?? '');
  const [youtube, setYoutube] = useState(null);
  const [youtubeUploads, setYoutubeUploads] = useState([]);
  const [youtubeBusy, setYoutubeBusy] = useState(false);
  const [youtubeError, setYoutubeError] = useState('');
  const [youtubeAudience, setYoutubeAudience] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmPreview, setConfirmPreview] = useState(null);
  const [uploadNotice, setUploadNotice] = useState('');
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalNotice, setApprovalNotice] = useState('');
  useEffect(() => {
    if (platform !== 'youtube') return;
    let active = true;
    Promise.all([api.youtubeConnection(), publication ? api.youtubeUploads(taskId, publication.publication_id) : Promise.resolve({ items: [] })])
      .then(([connection, uploads]) => { if (active) { setYoutube(connection); setYoutubeUploads(uploads.items); } })
      .catch((error) => { if (active) setYoutubeError(error.message); });
    return () => { active = false; };
  }, [api, platform, publication?.publication_id, taskId]);
  const youtubeAction = async (action) => {
    setYoutubeBusy(true); setYoutubeError('');
    try {
      await action();
      setYoutube(await api.youtubeConnection());
      if (publication) setYoutubeUploads((await api.youtubeUploads(taskId, publication.publication_id)).items);
    } catch (error) { setYoutubeError(error.message); }
    finally { setYoutubeBusy(false); }
  };
  const body = { platform, account_id: account.trim(), visibility, title: title.trim(), description: description.trim(),
    hashtags: tags.split(',').map((tag) => tag.trim().replace(/^#/, '')).filter(Boolean) };
  const changed = publication && JSON.stringify(body) !== JSON.stringify(Object.fromEntries(Object.keys(body).map((field) => [field, publication[field]])));
  const youtubeDescription = [body.description, body.hashtags.map((tag) => `#${tag.replace(/\s+/g, '')}`).join(' ')].filter(Boolean).join('\n\n');
  const valid = body.account_id.length > 0 && body.account_id.length <= 128 && body.title.length <= 200 && body.description.length <= 5000 && body.hashtags.length <= 30 && body.hashtags.every((tag) => tag.length <= 100) &&
    (platform !== 'youtube' || (body.title.length > 0 && Array.from(body.title).length <= 100 && !/[<>]/.test(body.title + youtubeDescription) && new TextEncoder().encode(youtubeDescription).length <= 5000));
  const label = { youtube: 'YouTube Shorts', tiktok: 'TikTok', instagram: 'Instagram Reels' }[platform];
  useEffect(() => () => { if (confirmPreview) URL.revokeObjectURL(confirmPreview); }, [confirmPreview]);
  const existingUpload = youtubeUploads.find((item) => item.content_version === task.current_version && item.artifact_sha256 === job?.artifact_sha256 &&
    ['uploading', 'outcome_unknown', 'succeeded'].includes(item.status));
  const uploadBlock = !youtube?.configured ? '서버 OAuth 설정을 확인해 주세요.' : !youtube.connected ? 'YouTube 계정 연결이 필요합니다.' :
    !publication || changed ? '게시 정보를 저장해 주세요.' : !previewApproved || !verified(task, job) ? '완성 영상 승인이 필요합니다.' :
    publication.account_id !== youtube.channel_id ? '게시 계정과 연결된 YouTube 채널이 다릅니다.' : !youtubeAudience ? '아동 대상 여부를 선택해 주세요.' :
    existingUpload?.status === 'succeeded' ? '이미 업로드한 영상입니다.' : existingUpload ? '기존 업로드 결과를 확인해 주세요. 자동 재업로드하지 않습니다.' : '';
  const openUploadConfirmation = async () => {
    if (uploadBlock || youtubeBusy || busy) return;
    setUploadNotice('');
    try {
      if (!previewUrl) setConfirmPreview(await api.preview(taskId, task.current_version, job.artifact_sha256));
      setConfirmOpen(true);
    } catch { setUploadNotice('인증된 영상 미리보기를 불러오지 못했습니다. 다시 시도해 주세요.'); }
  };
  const confirmUpload = async () => {
    if (youtubeBusy || !confirmOpen || uploadBlock) return;
    setYoutubeBusy(true); setUploadNotice('YouTube에 업로드 중...');
    try {
      const [currentTask, currentPublications, currentConnection] = await Promise.all([api.task(taskId), api.publications(taskId), api.youtubeConnection()]);
      const current = currentPublications.items.find((item) => item.publication_id === publication.publication_id);
      if (!current || current.revision !== publication.revision || current.metadata_hash !== publication.metadata_hash ||
          currentTask.current_version !== task.current_version || currentTask.content_hash !== task.content_hash ||
          !currentConnection.connected || currentConnection.channel_id !== publication.account_id)
        throw new Error('영상·게시 정보·연결 채널이 변경됐습니다. 최신 상태를 확인해 주세요.');
      if (current.status !== 'publish_ready') await api.approvePublication(taskId, publication.publication_id,
        { content_version: task.current_version, content_hash: task.content_hash, artifact_sha256: job.artifact_sha256,
          publication_revision: publication.revision, publication_hash: publication.metadata_hash },
        keyFor(`publication:approve:${publication.publication_id}:${publication.revision}:${task.current_version}`));
      const result = await api.youtubeUpload(taskId, publication.publication_id, youtubeAudience === 'yes',
        keyFor(`youtube:upload:${publication.publication_id}:${publication.revision}:${task.current_version}:${youtubeAudience}`));
      setYoutubeUploads((await api.youtubeUploads(taskId, publication.publication_id)).items);
      setUploadNotice(result.status === 'succeeded' ? 'YouTube 업로드가 완료됐습니다.' : '업로드 상태를 확인해 주세요.');
      setConfirmOpen(false); setConfirmPreview(null); await refresh().catch(() => {});
    } catch (error) {
      setUploadNotice(error instanceof ApiError ? error.message : '업로드 결과가 불확실합니다. 서버와 YouTube 채널 상태를 확인한 뒤 다시 시도해 주세요.');
      await api.youtubeUploads(taskId, publication.publication_id).then((result) => setYoutubeUploads(result.items)).catch(() => {});
      await refresh().catch(() => {});
      setConfirmOpen(false); setConfirmPreview(null);
    } finally { setYoutubeBusy(false); }
  };
  const approve = async () => {
    if (approvalBusy || busy || !publication) return;
    setApprovalBusy(true); setApprovalNotice('승인 처리 중...');
    const currentApproval = async () => {
      const current = (await api.publications(taskId)).items.find((item) => item.publication_id === publication.publication_id);
      if (!current || current.revision !== publication.revision || current.metadata_hash !== publication.metadata_hash) {
        await refresh().catch(() => {});
        throw new Error('게시 정보가 변경됐습니다. 최신 상태를 확인한 뒤 다시 승인해 주세요.');
      }
      return current;
    };
    try {
      // Read the server first, including after an uncertain previous request. Never retry automatically.
      if ((await currentApproval()).status === 'publish_ready') {
        setApprovalNotice(`이미 최종 승인된 영상입니다 · 게시 정보 버전 ${publication.revision}`);
        await refresh().catch(() => {});
        return;
      }
      await api.approvePublication(taskId, publication.publication_id, { content_version: task.current_version, content_hash: task.content_hash,
        artifact_sha256: job.artifact_sha256, publication_revision: publication.revision, publication_hash: publication.metadata_hash },
      keyFor(`publication:approve:${publication.publication_id}:${publication.revision}:${task.current_version}`));
      setApprovalNotice(`최종 승인 완료 · 게시 정보 버전 ${publication.revision} · 영상 버전 ${task.current_version}`);
      await refresh().catch(() => {});
    } catch (error) {
      if (error.message === '게시 정보가 변경됐습니다. 최신 상태를 확인한 뒤 다시 승인해 주세요.') {
        setApprovalNotice(error.message);
      } else if (!(error instanceof ApiError)) {
        try {
          if ((await currentApproval()).status === 'publish_ready') {
            setApprovalNotice(`최종 승인 완료 · 게시 정보 버전 ${publication.revision} · 영상 버전 ${task.current_version}`);
            await refresh().catch(() => {});
            return;
          }
        } catch { /* A failed status check must not cause an automatic approval retry. */ }
        setApprovalNotice('승인 결과를 확인하지 못했습니다. 서버 상태를 새로고침한 뒤 다시 확인해 주세요.');
      } else {
        if (error.status === 409) await refresh().catch(() => {});
        setApprovalNotice(error.code === 'RENDER_REQUIRED' ? '현재 영상의 렌더와 미리보기 승인을 먼저 확인해 주세요.' :
          error.code === 'RIGHTS_REVIEW_REQUIRED' ? '음악 또는 원본 오디오의 게시 권리를 먼저 확인해 주세요.' :
          error.code === 'INVALID_STATE_TRANSITION' ? '현재 게시 정보는 승인할 수 없는 상태입니다. 영상과 게시 정보를 다시 확인해 주세요.' :
          error.code === 'VERSION_CONFLICT' ? '영상 또는 게시 정보가 변경됐습니다. 최신 상태를 불러와 다시 확인해 주세요.' : error.message);
      }
    } finally { setApprovalBusy(false); }
  };
  return <details className="publication-card workspace-disclosure"><summary>{label}<small>{publication ? `게시 정보 버전 ${publication.revision} · ${changed ? '미저장 변경' : publication.status === 'publish_ready' ? '게시 준비됨' : '저장됨'}` : '게시 정보 입력 필요'}</small></summary><div className="publication-fields">
    {suggestion?.title ? <><button className="secondary" disabled={busy} onClick={() => { setTitle(suggestion.title); setDescription(suggestion.description); setTags(suggestion.hashtags.join(', ')); }}>분석 기반 게시 문구 초안 가져오기</button><p className="muted">장면 분석의 분류·피사체를 바탕으로 만든 초안입니다. 실제 내용과 권리를 확인하고 수정해 주세요.</p></>
      : <p className="warning">확인된 시각 분석 정보가 없어 게시 문구를 자동 작성하지 않았습니다. 제목·설명·해시태그를 직접 입력해 주세요.</p>}
    {platform === 'youtube' && <div className="publication-connection">
      <p><strong>YouTube 채널</strong> · {!youtube ? '확인 중' : youtube.connected ? `${youtube.channel_title} (${youtube.channel_id})` : youtube.configured ? '연결되지 않음' : '서버 OAuth 설정 또는 백엔드 재시작 필요'}</p>
      {youtube?.configured && <div className="button-row">{youtube.connected ? <>
        <button className="secondary" disabled={youtubeBusy || busy} onClick={() => setAccount(youtube.channel_id)}>이 채널을 게시 계정으로 사용</button>
        <button className="secondary" disabled={youtubeBusy || busy} onClick={() => youtubeAction(() => api.youtubeDisconnect())}>채널 연결 해제</button>
      </> : <button className="secondary" disabled={youtubeBusy || busy} onClick={() => youtubeAction(async () => {
        const result = await api.youtubeConnect();
        const target = new URL(result.authorization_url);
        if (target.protocol !== 'https:' || target.hostname !== 'accounts.google.com') throw new Error('Google 연결 주소를 확인할 수 없습니다.');
        window.location.assign(target.href);
      })}>Google 계정 연결</button>}</div>}
      {youtubeError && <p className="warning" role="alert">{youtubeError}</p>}
    </div>}
    <label>게시 계정 <input value={account} maxLength="128" onChange={(event) => setAccount(event.target.value)} /></label>
    <label>공개범위 <select value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="private">비공개</option><option value="unlisted">일부 공개</option>{platform !== 'youtube' && <option value="followers">팔로워</option>}<option value="public">전체 공개</option></select></label>
    <label>제목 <input value={title} maxLength="200" onChange={(event) => setTitle(event.target.value)} /></label>
    {platform === 'youtube' && <p className="muted">YouTube 제목은 100자 이하, 설명은 해시태그 포함 UTF-8 5000바이트 이하로 작성해 주세요.</p>}
    <label>설명 <textarea value={description} maxLength="5000" onChange={(event) => setDescription(event.target.value)} /></label>
    <label>해시태그(쉼표로 구분) <input value={tags} onChange={(event) => setTags(event.target.value)} /></label>
    <div className="button-row"><button disabled={busy || !valid || (publication && !changed)} onClick={() => run(() => publication
      ? api.updatePublication(taskId, publication.publication_id, { ...body, revision: publication.revision }, keyFor(`publication:update:${publication.publication_id}:${publication.revision}:${JSON.stringify(body)}`))
      : api.createPublication(taskId, body, keyFor(`publication:create:${taskId}:${platform}:${JSON.stringify(body)}`)), '게시 정보를 저장했습니다. 변경 전 승인은 무효화됩니다.')}>게시 정보 저장</button>
      {platform !== 'youtube' && publication && <button className="secondary" disabled={busy || approvalBusy || !valid || changed || !previewApproved || !verified(task, job) || publication.status === 'publish_ready'}
        onClick={approve}>{approvalBusy ? '승인 처리 중...' : '이 플랫폼 최종 승인'}</button>}</div>
    {platform !== 'youtube' && publication?.status === 'publish_ready' && !changed && <p className="notice" role="status">이미 최종 승인된 영상입니다 · 게시 정보 버전 {publication.revision} · 영상 버전 {task.current_version}</p>}
    {platform !== 'youtube' && approvalNotice && <p className="notice" role="status">{approvalNotice}</p>}
    {platform === 'youtube' && <div className="publication-upload">
      <p className="muted">완성 MP4 {previewApproved ? '미리보기 승인됨' : '미리보기 승인 필요'} · 영상 버전 {task.current_version} · 게시 정보 버전 {publication?.revision ?? '미저장'}. 업로드 최종 확인 전에는 YouTube로 전송되지 않습니다.</p>
      <label>아동 대상 여부 <select value={youtubeAudience} onChange={(event) => setYoutubeAudience(event.target.value)}>
        <option value="">선택해 주세요</option><option value="no">아동용 아님</option><option value="yes">아동용</option>
      </select></label>
      <button disabled={busy || youtubeBusy || Boolean(uploadBlock)} onClick={openUploadConfirmation}>{youtubeBusy ? 'YouTube에 업로드 중...' : 'YouTube에 업로드'}</button>
      {uploadBlock && <p className="muted" role="status">{uploadBlock}</p>}
      {uploadNotice && <p className="notice" role="status">{uploadNotice}</p>}
      {youtubeUploads.map((item) => <p key={item.upload_id}>{item.status === 'succeeded' ? <a href={item.url} target="_blank" rel="noopener noreferrer">업로드 완료 · 영상 ID {item.video_id} · YouTube에서 보기</a> :
        item.status === 'outcome_unknown' ? '업로드 결과 불확실 · YouTube 채널에서 확인 필요' : '업로드 진행 중'}</p>)}
      {confirmOpen && <div className="youtube-confirm-backdrop"><div className="youtube-confirm" role="dialog" aria-modal="true" aria-label="YouTube 업로드 최종 확인">
        <h3>YouTube 업로드 최종 확인</h3>
        <p>연결 채널: {youtube.channel_title} ({youtube.channel_id})</p>
        {(previewUrl || confirmPreview) && <video src={previewUrl || confirmPreview} preload="metadata" controls muted playsInline aria-label="업로드할 영상 미리보기" />}
        <p>영상 버전 {task.current_version} · 게시 정보 버전 {publication.revision}</p>
        <p>제목: {publication.title}</p><p>설명: {publication.description}</p>
        <p>해시태그: {publication.hashtags.map((tag) => `#${tag}`).join(' ') || '없음'}</p>
        <p>공개범위: {{ private: '비공개', unlisted: '일부 공개', public: '전체 공개' }[publication.visibility]}</p>
        <p>아동 대상: {youtubeAudience === 'yes' ? '예' : '아니요'}</p>
        <p className="muted">확인을 누르면 현재 YouTube 영상과 게시 정보에 대한 최종 승인 후 업로드를 시작합니다.</p>
        <div className="button-row"><button className="secondary" disabled={youtubeBusy} onClick={() => { setConfirmOpen(false); setConfirmPreview(null); }}>취소</button>
          <button disabled={youtubeBusy} onClick={confirmUpload}>{youtubeBusy ? 'YouTube에 업로드 중...' : '이 영상 YouTube에 업로드하기'}</button></div>
      </div></div>}
    </div>}
  </div></details>;
}

function PlanSceneEditor({ api, taskId, task, plan, generation, trendResult, references, selectedReferenceIds, planApproval, draftApproval, busy, run, keyFor }) {
  const initialRows = () => plan.scenes.map((scene) => ({ scene_id: scene.scene_id ?? scene.media_id, media_id: scene.media_id, media_type: scene.media_type,
    visual_description: scene.visual_description ?? '', visual_analysis_status: scene.visual_analysis_status ?? 'unavailable',
    duration_seconds: Number((scene.end_seconds - scene.start_seconds).toFixed(2)), trim_start_seconds: scene.trim_start_seconds ?? 0,
    trim_end_seconds: scene.trim_end_seconds ?? '', framing: scene.framing ?? 'inherit', motion: scene.motion ?? 'static',
    transition: scene.transition ?? 'cut', subtitle_style: scene.subtitle_style ?? 'default', edit_style: scene.edit_style ?? 'basic',
    bgm_mood: scene.bgm_mood ?? '', edit_reason: scene.edit_reason ?? '' }));
  const [rows, setRows] = useState(initialRows);
  const [trendQuery, setTrendQuery] = useState(undefined);
  const [edited, setEdited] = useState(false);
  const [showAllScenes, setShowAllScenes] = useState(false);
  const chosenTrend = references.find((item) => item.kind === 'trend');
  const chosenSearch = references.find((item) => item.kind === 'search');
  const selectedTrendResult = chosenSearch && trendResult?.topic === chosenSearch.topic ?
    { ...trendResult, items: trendResult.items?.filter((item) => item.video_id === chosenSearch.video_id) ?? [] } : null;
  const trend = chosenTrend?.trend_summary ?? summarizeTrend(selectedTrendResult);
  const decorate = (suggestions) => suggestions.map((row) => ({ ...row,
    scene_id: row.scene_id ?? plan.scenes.find((scene) => scene.media_id === row.media_id)?.scene_id ?? row.media_id,
    visual_description: row.visual_description ?? plan.scenes.find((scene) => scene.media_id === row.media_id)?.visual_description ?? '',
    visual_analysis_status: row.visual_analysis_status ?? plan.scenes.find((scene) => scene.media_id === row.media_id)?.visual_analysis_status ?? 'unavailable',
    media_type: plan.scenes.find((scene) => scene.media_id === row.media_id).media_type, trim_end_seconds: row.trim_end_seconds ?? '' }));
  const basicRows = decorate(proposeBasicEdit(plan));
  const proposedRows = decorate(proposeReferenceEdit(plan, generation, trend, references));
  const hasVisualChange = hasVisibleEditDifference(basicRows, proposedRows);
  const total = Math.round(rows.reduce((sum, row) => sum + Number(row.duration_seconds || 0), 0) * 100) / 100;
  const set = (index, field, value) => { setEdited(true); setRows((current) => current.map((row, rowIndex) => rowIndex === index ?
    { ...row, [field]: value, ...(field === 'visual_description' ? { visual_analysis_status: value.trim() ? 'user_described' : 'unavailable' } : {}) } : row)); };
  const move = (index, delta) => { setEdited(true); setRows((current) => { const next = [...current]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; return next; }); };
  const duplicate = (index) => { setEdited(true); setRows((current) => { const next = [...current]; const { scene_id: _oldId, ...copy } = next[index]; next.splice(index + 1, 0, { ...copy, duration_seconds: 0.1 }); return next; }); };
  const remove = (index) => { setEdited(true); setRows((current) => current.filter((_, i) => i !== index)); };
  const payload = rows.map((row) => ({ ...(row.scene_id ? { scene_id: row.scene_id } : {}), media_id: row.media_id,
    visual_description: row.visual_description, duration_seconds: Number(row.duration_seconds), framing: row.framing,
    motion: row.motion, transition: row.transition, subtitle_style: row.subtitle_style, edit_style: row.edit_style,
    bgm_mood: row.bgm_mood, edit_reason: row.edit_reason,
    ...(row.media_type.startsWith('video/') ? { trim_start_seconds: Number(row.trim_start_seconds),
      ...(row.trim_end_seconds === '' ? {} : { trim_end_seconds: Number(row.trim_end_seconds) }) } : {}) }));
  const valid = rows.length > 0 && rows.length <= 30 && Math.abs(total - plan.target_seconds) <= 0.01 && payload.every((row) => row.duration_seconds >= 0.1 && Number.isFinite(row.duration_seconds) &&
    (row.trim_start_seconds === undefined || Number.isFinite(row.trim_start_seconds) && row.trim_start_seconds >= 0 && row.trim_start_seconds <= 3600) &&
    (row.trim_end_seconds === undefined || Number.isFinite(row.trim_end_seconds) && row.trim_end_seconds <= 3600 && row.trim_end_seconds - (row.trim_start_seconds ?? 0) + 0.001 >= row.duration_seconds));
  function applyProposal() {
    if (!hasVisualChange) return;
    setRows(proposedRows); setEdited(true);
    setTrendQuery(trend ? { topic: trend.topic, days: trend.period_days,
      ...(chosenSearch ? { video_id: new URL(chosenSearch.url).searchParams.get('v') } : {}) } : null);
  }
  return <div className="scenes"><h3>장면 순서와 재생 시간</h3><p className="muted">합계 {total}/{plan.target_seconds}초 · 영상은 시작 구간을 초 단위로 지정할 수 있습니다.</p>
    <div className="button-row"><button type="button" className="secondary" disabled={busy || !hasVisualChange} onClick={applyProposal}>{trend ? '트렌드 혼합 편집 적용' : 'Vision 기반 혼합 편집 적용'}</button><button type="button" className="secondary" disabled={busy} onClick={() => { setRows(basicRows); setTrendQuery(null); setEdited(true); }}>기본 효과 적용</button></div>
    {!hasVisualChange && <p className="warning">확인된 장면 분류가 없어 혼합 제안에 시각적 변경이 없습니다. 기본 편집을 유지하고, 효과가 필요하면 아래에서 직접 선택해 주세요.</p>}
    <p className="muted">현재 기획 승인: {planApproval === 'approved' ? '승인됨' : '승인 대기'} · 자막·음악 초안 승인: {draftApproval === 'approved' ? '승인됨' : '승인 대기'}. 장면을 저장하면 콘텐츠 버전과 영상 해시가 바뀌므로 이전 승인으로 새 영상을 렌더할 수 없습니다.</p>
    {JSON.stringify(selectedReferenceIds) !== JSON.stringify(plan.style_reference_ids ?? []) && <p className="warning">레퍼런스 선택 변경은 아직 기획에 저장되지 않았습니다. 아래 장면 구성 저장을 누르고 다시 승인해 주세요.</p>}
    {edited && <p className="warning" role="status">화면의 편집 값은 아직 영상에 반영되지 않았습니다. 아래 장면 구성을 저장하고 현재 버전의 기획·초안을 다시 승인한 뒤 새로 렌더해 주세요.</p>}
    <div className="edit-comparison" aria-label="기본 편집과 혼합 편집 비교"><div><strong>기본 편집 · 같은 미디어로 비교</strong><ol>{basicRows.map((row) => <li key={row.media_id}>미디어 {plan.scenes.findIndex((scene) => scene.media_id === row.media_id) + 1} · {row.duration_seconds}초 · 컷 · 기본 색감 · 기본 자막</li>)}</ol></div>
      <div><strong>{trend ? '검색 메타데이터 + Vision 혼합 제안' : 'Vision 기반 로컬 혼합 제안'} · 저장 전</strong><ol>{proposedRows.map((row) => <li key={row.media_id}>미디어 {plan.scenes.findIndex((scene) => scene.media_id === row.media_id) + 1} · {row.duration_seconds}초 · {row.transition === 'fade' ? '페이드' : '컷'} · {editStyleLabel(row.edit_style)} · {row.motion} · {row.subtitle_style === 'emphasis' ? '강조 자막' : row.subtitle_style === 'information' ? '정보형 자막' : '기본 자막'}</li>)}</ol></div></div>
    <p className="muted">이 비교는 편집 설정을 보여줍니다. 현재 저장된 설정은 아래 장면 카드에서 확인하세요. 실제 MP4를 전후 비교하려면 기존 영상을 먼저 내려받고 새 버전을 렌더해 내려받으세요. 이전 버전의 서버 미리보기는 현재 버전 API에서 제공하지 않습니다.</p>
    <p className="muted">{trend ? `검색 사실: ${trend.keywords.join(', ') || '관련 제목'} · ${trend.queried_at} 조회. 검색 메타데이터는 영상 내부 효과의 근거가 아닙니다.` : '유효한 최근 검색 결과가 없습니다.'} {references.some((item) => item.analysis_scope === 'local_video_sample') ? '직접 업로드한 영상은 화면 변화 샘플만 참고합니다.' : '시각 분석이 없는 장면은 기본 효과 또는 사용자가 설명한 분위기를 적용합니다.'} 해주미의 효과는 자체 추천입니다.</p>
    {rows.slice(0, showAllScenes ? rows.length : 5).map((row, index) => <details className="creator-scene-card workspace-disclosure" key={row.scene_id ?? `new-${index}`}><summary><span className="scene-number">{index + 1}</span>{!row.media_type.startsWith('video/') && <img className="scene-thumbnail" src={`/api/v1/media/${row.media_id}/image-preview`} alt={`장면 ${index + 1}의 선택 사진`} loading="lazy" />}<span><strong>장면 {index + 1} · {row.duration_seconds}초</strong><small>{editStyleLabel(row.edit_style)} · {row.transition === 'fade' ? '페이드' : '컷'} · {row.motion === 'static' ? '고정' : row.motion}</small></span></summary><div className="creator-scene-fields">
      <small>{row.media_type.startsWith('video/') ? '영상' : '사진'} · {row.media_id.slice(0, 8)}</small>
      <small>장면 설명: {row.visual_analysis_status === 'ai_unverified' ? 'Vision 제안 · 사용자 확인 필요' : row.visual_analysis_status === 'user_described' ? '사용자 입력' : '시각 내용 미확인'} · 자막의 의미는 초안에서 직접 확인해 주세요.</small>
      <label>이 장면에 실제로 보이는 내용 (사용자 설명)<textarea rows="2" maxLength="500" value={row.visual_description} onChange={(event) => set(index, 'visual_description', event.target.value)} /></label>
      <label>재생 초 <input type="number" min="0.1" max="59" step="0.01" value={row.duration_seconds} onChange={(event) => set(index, 'duration_seconds', event.target.value)} /></label>
      {row.media_type.startsWith('video/') && <label>시작 위치(초) <input type="number" min="0" max="3600" step="0.01" value={row.trim_start_seconds} onChange={(event) => set(index, 'trim_start_seconds', event.target.value)} /></label>}
      {row.media_type.startsWith('video/') && <label>종료 위치(초, 선택) <input type="number" min="0" max="3600" step="0.01" value={row.trim_end_seconds} onChange={(event) => set(index, 'trim_end_seconds', event.target.value)} /></label>}
      <label>화면 배치 <select value={row.framing} onChange={(event) => set(index, 'framing', event.target.value)}><option value="inherit">프로젝트 설정</option><option value="fit_pad">전체 보기</option><option value="fill_crop">가득 채우기</option><option value="blur_pad">블러 배경</option></select></label>
      <label>움직임 <select value={row.motion} onChange={(event) => set(index, 'motion', event.target.value)}><option value="static">고정</option><option value="zoom_in">천천히 확대</option><option value="zoom_out">천천히 축소</option><option value="pan_left">왼쪽으로 이동</option><option value="pan_right">오른쪽으로 이동</option></select></label>
      <label>전환 <select value={row.transition} onChange={(event) => set(index, 'transition', event.target.value)}><option value="cut">컷</option><option value="fade">검정 페이드</option></select></label>
      <label>자막 스타일 <select value={row.subtitle_style} onChange={(event) => set(index, 'subtitle_style', event.target.value)}><option value="default">감성 브이로그 · 부드러운 흰 자막</option><option value="emphasis">음식 하이라이트 · 큰 팝업 자막</option><option value="information">깔끔한 정보형 · 상단 박스</option></select></label>
      <label>화면 색감 <select value={row.edit_style} onChange={(event) => set(index, 'edit_style', event.target.value)}><option value="basic">기본</option><option value="travel_warm">여행 · 따뜻함</option><option value="food_pop">음식 · 선명함</option><option value="cafe_soft">카페 · 부드러움</option><option value="information">정보형 · 또렷함</option></select></label>
      <small>추천 편집 스타일: {row.suggested_style === 'highlight' ? '빠른 하이라이트' : row.suggested_style === 'emotional' ? '감성' : row.suggested_style === 'information' ? '정보형' : '기본'} · 자막 문구와 음악은 별도 초안에서 확인해 주세요.</small>
      <small>렌더 적용: 화면 배치·움직임·전환·색감·자막 스타일. 자막은 초안 승인 후 실제 영상에 합성됩니다. 스타일을 저장하면 콘텐츠 버전이 바뀌므로 기획과 초안을 다시 승인해야 합니다. BGM 분위기와 추천 근거는 편집 안내이며 음원 변경은 별도 초안에서 합니다.</small>
      {row.edit_reason && <small>해주미 자체 추천 근거: {row.edit_reason}</small>}
      <div className="button-row"><button className="secondary" disabled={busy || index === 0} onClick={() => move(index, -1)}>위로</button><button className="secondary" disabled={busy || index === rows.length - 1} onClick={() => move(index, 1)}>아래로</button><button className="secondary" disabled={busy || rows.length >= 30} onClick={() => duplicate(index)}>같은 미디어로 장면 추가</button><button className="secondary" disabled={busy || rows.length <= 1} onClick={() => remove(index)}>장면 제외</button></div>
    </div></details>)}
    {rows.length > 5 && <button type="button" className="secondary" onClick={() => setShowAllScenes((value) => !value)}>{showAllScenes ? '장면 접기' : `나머지 장면 ${rows.length - 5}개 보기`}</button>}
    <button disabled={busy || !valid} onClick={() => run(() => api.updateScenes(taskId, task, payload, keyFor(`scene:${task.current_version}:${JSON.stringify({ payload, trendQuery, selectedReferenceIds })}`), trendQuery, selectedReferenceIds), '새 장면 기획과 레퍼런스가 저장됐습니다. 현재 버전의 승인을 다시 확인해 주세요.')}>장면 구성 저장</button>
  </div>;
}

function editStyleLabel(style) {
  return { basic: '기본 색감', travel_warm: '따뜻한 여행 색감', food_pop: '선명한 음식 색감', cafe_soft: '부드러운 카페 색감', information: '정보형 대비' }[style] ?? '기본 색감';
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
  const [showAllCaptions, setShowAllCaptions] = useState(false);
  if (!draft) return <section id="creator-captions" className="card workspace-card"><p className="eyebrow">02 · CAPTIONS & MUSIC</p><h2>자막·음악</h2><p className="muted">현재 버전의 기획을 승인하면 초안을 확인할 수 있습니다.</p></section>;

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
      scenes.some((scene) => (!row.scene_id || row.scene_id === (scene.scene_id ?? scene.media_id)) &&
        (!row.media_id || row.media_id === scene.media_id) && start >= scene.start_seconds && end <= scene.end_seconds) &&
      row.text.trim() && !/장면\s*\d+\s*을\s*소개합니다|장면별\s*효과.*제안/u.test(row.text);
  });
  function save() {
    const body = { content_version: task.current_version, content_hash: task.content_hash,
      captions: ordered.map((row, index) => ({ order: index + 1,
        ...(row.scene_id ? { scene_id: row.scene_id } : {}), ...(row.media_id ? { media_id: row.media_id } : {}),
        start_seconds: Number(row.start_seconds), end_seconds: Number(row.end_seconds), text: row.text })),
      captions_enabled: enabled, music_track_id: trackId || null, source_volume: Number(sourceVolume), music_volume: Number(musicVolume),
      fade_in_seconds: Number(fadeIn), fade_out_seconds: Number(fadeOut) };
    run(() => api.updateDraft(taskId, body, keyFor(`draft:${task.current_version}:${JSON.stringify(body)}`)), '자막·음악 변경으로 버전이 올랐습니다. 기획부터 다시 승인해 주세요.');
  }
  return <section id="creator-captions" className="card workspace-card"><p className="eyebrow">02 · CAPTIONS & MUSIC</p><h2>자막·음악 초안</h2>
    <p className="muted">자막 {captions.length}개 · {trackId ? 'BGM 선택됨' : '음악 없음'} · {checkpoint?.status === 'approved' ? '초안 승인됨' : '검토·승인 필요'}. 사진과 문구가 맞는지 확인해 주세요.</p>
    {captions.length === 0 && <p className="warning" role="status">{generation?.source === 'local_rules' ? `${visionGenerationMessage(generation)} 자막 없이 렌더하면 MP4에도 자막이 표시되지 않습니다.`
      : '이 버전에는 영상 자막이 없습니다. 자막 없이 렌더하면 MP4에도 자막이 표시되지 않습니다.'}</p>}
    <label className="check"><input type="checkbox" checked={enabled} onChange={(event) => { setEnabled(event.target.checked); setEdited(true); }} /> 자막 합성</label>
    <details className="workspace-disclosure"><summary>장면에 자막 추가</summary><div className="caption-add-actions">{scenes.map((scene) => <button type="button" className="secondary caption-small-button" key={scene.scene_id ?? scene.order} disabled={busy || captions.length >= 30} onClick={() => { setCaptions((rows) => [...rows, { scene_id: scene.scene_id ?? scene.media_id, media_id: scene.media_id, start_seconds: scene.start_seconds, end_seconds: scene.end_seconds, text: '', caption_source: 'user' }]); setEdited(true); }}>+ 장면 {scene.order} 자막</button>)}</div></details>
    <div className="caption-cards">{captions.slice(0, showAllCaptions ? captions.length : 5).map((row, index) => {
      const scene = scenes.find((item) => (!row.scene_id || row.scene_id === (item.scene_id ?? item.media_id)) &&
        (!row.media_id || row.media_id === item.media_id) &&
        Number(row.start_seconds) >= item.start_seconds && Number(row.end_seconds) <= item.end_seconds);
      return <details key={index} className="caption-edit-card workspace-disclosure"><summary>{scene && !scene.media_type.startsWith('video/') && <img className="scene-thumbnail" src={`/api/v1/media/${scene.media_id}/image-preview`} alt={`자막 ${index + 1}에 연결된 사진`} loading="lazy" />}<span><strong>장면 {scene?.order ?? '시간 확인'} · {row.start_seconds}–{row.end_seconds}초</strong><small>{row.text || '자막 없음 · 문구를 입력해 주세요'}</small></span></summary><div className="caption-card-body"><button type="button" className="secondary caption-small-button" onClick={() => { setCaptions((rows) => rows.filter((_, i) => i !== index)); setEdited(true); }}>이 자막 삭제</button>
        <small>{scene ? `${scene.media_type.startsWith('video/') ? '영상' : '사진'} ${scene.media_id.slice(0, 8)} · ${scene.visual_description || '장면 내용 미확인'}` : '연결할 장면을 확인해 주세요.'} · {row.caption_source === 'vision' ? 'Vision 제안' : row.caption_source === 'user' ? '사용자 요청·수정' : '기존 자막'} · {checkpoint?.status === 'approved' ? '초안 승인됨' : '내용·의미 확인 필요'}</small>
        {row.caption_kind === 'user_information' && <small className="warning">사용자가 제공한 정보입니다. 사진 내용과 사실 여부를 확인한 뒤 승인해 주세요.</small>}
        {row.caption_source === 'vision' && <small className="caption-basis">유형: {{ observed_fact: '사진 속 사실 주장', user_information: '사용자 제공 정보 주장', emotional: '감성 표현', narrative: '이야기 연결', unclassified: '유형 미확인' }[row.caption_kind] ?? '유형 미확인'} · {row.caption_review_reason === 'visual_fact_unverified' || row.caption_review_reason === 'user_fact_unverified' ? '사실 여부 직접 확인 필요' : '초안 승인 전 확인 필요'}<br />분석 근거 후보: {row.caption_basis?.insight_description || '사진별 분석 근거 없음'}{row.caption_basis?.model_evidence && ` · AI 제시 근거: ${row.caption_basis.model_evidence}`}<br />AI의 사진 설명과 근거는 사실 확인 결과가 아닙니다.</small>}
        {(!row.caption_source || row.caption_source === 'legacy_review') && <small className="caption-basis">기존 자막은 사진별 분석 근거와 생성 출처가 기록되지 않았습니다. 원본과 직접 대조해 주세요.</small>}
        <div className="caption-time-grid"><label>시작(초)<input type="number" min="0" max={task.target_seconds} step="0.01" value={row.start_seconds} onChange={(event) => changeTime(index, 'start_seconds', event.target.value)} /></label><label>종료(초)<input type="number" min="0" max={task.target_seconds} step="0.01" value={row.end_seconds} onChange={(event) => changeTime(index, 'end_seconds', event.target.value)} /></label></div>
        <label className="caption-text-label">영상 자막<textarea rows="3" value={row.text} maxLength="80" onChange={(event) => changeCaption(index, event.target.value)} /></label>
        {scene && <div className="caption-preview-wrap"><div className={`caption-preview caption-preview-${scene.subtitle_style ?? 'default'}`} aria-label={`장면 ${scene.order} 자막 스타일 미리보기`}>
          {!scene.media_type.startsWith('video/') && <img src={`/api/v1/media/${scene.media_id}/image-preview`} alt="" loading="lazy" />}
          <span>{row.text || '자막 미리보기'}</span>
        </div><small>{scene.subtitle_style === 'emphasis' ? '음식 하이라이트' : scene.subtitle_style === 'information' ? '깔끔한 정보형' : '감성 브이로그'} · 장면 구성에서 변경 · 실제 효과와 화면 배치는 MP4에서 확인해 주세요.</small></div>}
        {[...row.text].length > 28 && <small className="warning">긴 자막은 영상에서 글자 크기가 줄고 세 줄 이상으로 표시될 수 있습니다. 짧게 나누어 주세요.</small>}
      </div></details>;
    })}</div>
    {captions.length > 5 && <button type="button" className="secondary" onClick={() => setShowAllCaptions((value) => !value)}>{showAllCaptions ? '자막 접기' : `나머지 자막 ${captions.length - 5}개 보기`}</button>}
    {!valid && <p role="alert">자막 문구와 시간을 확인해 주세요. 자막은 한 장면 안에 있어야 하며 서로 겹칠 수 없습니다.</p>}
    <details className="workspace-disclosure"><summary>음악과 음량 설정 <small>{tracks.find((item) => item.track_id === trackId)?.title || '음악 없음'}</small></summary><div className="creator-disclosure-body"><label htmlFor="music">로컬 BGM</label><select id="music" value={trackId} onChange={(event) => { setTrackId(event.target.value); setEdited(true); }}><option value="">음악 없음</option>{tracks.filter((track) => track.status === 'available').map((track) => <option key={track.track_id} value={track.track_id}>{track.title} · {track.rights_status === 'user_verified' ? '사용자 권리 확인' : '권리 미확인'}</option>)}</select>
    <div className="number-grid">{[['원음 음량', sourceVolume, setSourceVolume, 2], ['BGM 음량', musicVolume, setMusicVolume, 2], ['페이드 인(초)', fadeIn, setFadeIn, 10], ['페이드 아웃(초)', fadeOut, setFadeOut, 10]].map(([label, value, setter, max]) => <label key={label}>{label}<input type="number" min="0" max={max} step="0.1" value={value} onChange={(event) => { setter(event.target.value); setEdited(true); }} /></label>)}</div></div></details>
    <div className="button-row"><button className="secondary" disabled={busy || !edited || !valid} onClick={save}>자막·음악 변경 저장</button>
      {checkpoint?.status === 'pending' && <button disabled={busy || edited} onClick={() => run(() => api.approve(taskId, checkpoint, keyFor(`approve:${checkpoint.checkpoint_id}`)), '현재 초안을 중간 승인했습니다.')}>초안 중간 승인</button>}</div>
    <small>선택한 음원의 플랫폼별 상업 이용 권리와 원본 오디오 권리는 최종 승인 시 서버에서 다시 검사합니다.</small>
  </section>;
}
