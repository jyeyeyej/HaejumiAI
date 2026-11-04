import React, { useEffect, useState } from 'react';
import { visionAvailability } from '../vision-availability.js';

export function SettingsWorkspace({ api, onConsentChange }) {
  const [usage, setUsage] = useState(null);
  const [notice, setNotice] = useState(null);
  const [consents, setConsents] = useState([]);
  const [checked, setChecked] = useState(false);
  const [message, setMessage] = useState('설정을 불러오는 중입니다.');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    if (!api) return;
    const [u, n, c] = await Promise.all([api.llmUsage(), api.privacyNotice('llm_text'), api.consents()]);
    setUsage(u); setNotice(n); setConsents(c.items.filter((item) => item.purpose === 'llm_text'));
    onConsentChange(c.items.find((item) => item.purpose === 'llm_text')?.consent_id ?? null);
    setMessage('서버 설정과 사용량을 불러왔습니다.');
  }
  useEffect(() => { refresh().catch((error) => setMessage(error.message)); }, [api]);
  async function run(action, success) {
    setBusy(true);
    try { await action(); await refresh(); setMessage(success); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  if (!api) return <section className="card workspace-card">서버에 연결해 주세요.</section>;
  return <section className="card workspace-card"><p className="eyebrow">SETTINGS</p><h1>외부 AI와 개인정보</h1>
    <p role="status" className="notice">{message}</p>
    <p>OpenAI 외부 호출: <strong>{usage?.enabled && usage?.provider_ready ? '서버에서 사용 가능' : '서버에서 비활성'}</strong></p>
    <p className="muted">{visionAvailability(usage).message}</p>
    <p className="muted">동의만으로 서버 실행 설정이 켜지지 않습니다. 실제 유료 호출은 별도 승인 후 서버 운영자가 활성화해야 합니다.</p>
    {usage && <p>오늘 예약 비용 ${usage.daily_reserved_usd.toFixed(3)} / ${usage.daily_limit_usd.toFixed(3)} · 이번 달 예약 비용 ${usage.monthly_reserved_usd.toFixed(3)} / ${usage.monthly_limit_usd.toFixed(3)} · 작업당 최대 {usage.max_calls_per_task}회</p>}
    <p className="muted">표시된 금액은 사전 예약 추정치이며 공급자의 실제 청구 금액이 아닙니다.</p>
    {notice && <><h2>예투 텍스트 해석 동의</h2><p>{notice.disclosure}</p><p className="muted">{notice.provider_retention}</p>
      <label className="check"><input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />전송 항목·목적·업체를 확인하고 24시간 동의합니다.</label>
      <button disabled={busy || !checked || consents.length > 0} onClick={() => run(() => api.grantTextConsent(notice), '동의를 저장했습니다. 언제든 철회할 수 있습니다.')}>동의 저장</button></>}
    {consents.map((consent) => <div key={consent.consent_id} className="project-row"><strong>예투 텍스트 해석 동의</strong><small>만료 {new Date(consent.expires_at).toLocaleString('ko-KR')}</small>
      <button className="secondary" disabled={busy} onClick={() => run(() => api.revokeConsent(consent.consent_id), '동의를 철회했습니다.')}>동의 철회</button></div>)}
  </section>;
}
