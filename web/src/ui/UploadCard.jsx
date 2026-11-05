import React, { useEffect, useRef, useState } from 'react';

const MAX_FILES = Math.max(1, Math.min(30, Number(import.meta.env.VITE_MAX_SELECTED_MEDIA) || 20));
const makeItem = (file) => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file), mediaId: null,
  status: '대기', error: null, keys: { itemId: crypto.randomUUID(), initKey: crypto.randomUUID(), partKey: crypto.randomUUID(), completeKey: crypto.randomUUID() } });

export function UploadCard({ api, onCreated }) {
  const input = useRef(null);
  const controller = useRef(null);
  const itemsRef = useRef([]);
  const projectKey = useRef(crypto.randomUUID());
  const batchKeys = useRef({ initKey: crypto.randomUUID(), completeKey: crypto.randomUUID() });
  const [items, setItems] = useState([]);
  const [message, setMessage] = useState('파일을 선택해 주세요. 자동 폴더 탐색은 하지 않습니다.');
  const [busy, setBusy] = useState(false);
  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => () => { itemsRef.current.forEach((item) => URL.revokeObjectURL(item.url)); }, []);

  function select(event) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length) return;
    try {
      if (items.length + files.length > MAX_FILES) throw new Error(`최대 ${MAX_FILES}개까지 선택할 수 있습니다.`);
      setItems((current) => [...current.map((entry) => ({ ...entry, keys: { ...entry.keys, partKey: crypto.randomUUID() } })), ...files.map(makeItem)]);
      batchKeys.current = { initKey: crypto.randomUUID(), completeKey: crypto.randomUUID() };
      setMessage('선택한 파일과 순서를 확인한 뒤 업로드해 주세요.');
    } catch (error) { setMessage(error.message); }
  }
  function remove(id) {
    setItems((current) => { const removed = current.find((item) => item.id === id); if (removed) URL.revokeObjectURL(removed.url); return current.filter((item) => item.id !== id).map((entry) => ({ ...entry, keys: { ...entry.keys, partKey: crypto.randomUUID() } })); });
    projectKey.current = crypto.randomUUID();
    batchKeys.current = { initKey: crypto.randomUUID(), completeKey: crypto.randomUUID() };
  }
  function clear() {
    items.forEach((item) => URL.revokeObjectURL(item.url));
    setItems([]); projectKey.current = crypto.randomUUID(); batchKeys.current = { initKey: crypto.randomUUID(), completeKey: crypto.randomUUID() }; setMessage('선택을 취소했습니다. 서버에 이미 업로드된 파일은 새 프로젝트에 포함하지 않습니다.');
  }
  function move(index, delta) {
    setItems((current) => { const next = current.map((entry) => ({ ...entry, keys: { ...entry.keys, partKey: crypto.randomUUID() } })); [next[index], next[index + delta]] = [next[index + delta], next[index]]; return next; });
    projectKey.current = crypto.randomUUID();
    batchKeys.current = { initKey: crypto.randomUUID(), completeKey: crypto.randomUUID() };
  }
  async function upload() {
    if (!api || !items.length) return;
    controller.current = new AbortController(); setBusy(true);
    const pending = items.filter((item) => !item.mediaId);
    try {
      const outcome = await api.uploadEach(pending, { signal: controller.current.signal, onStep: setMessage,
        onItem: (index, update) => setItems((current) => current.map((entry) => entry.id === pending[index].id ? { ...entry, ...update } : entry)) });
      const successful = items.length - pending.length + outcome.results.filter((result) => result.mediaId).length;
      const failed = outcome.results.filter((result) => result.error).length;
      setMessage(`${outcome.cancelled ? '업로드를 취소했습니다. ' : ''}성공 ${successful}개 / 실패 ${failed}개${failed ? ' · 실패한 파일만 다시 시도할 수 있습니다.' : outcome.cancelled ? ' · 남은 파일을 다시 시도할 수 있습니다.' : ' · 프로젝트를 만들 수 있습니다.'}`);
    } catch (error) {
      const failed = error.itemIndex ? pending[error.itemIndex - 1] : null;
      setItems((current) => current.map((entry) => entry.id === failed?.id ? { ...entry, status: '검사 실패' } : entry));
      setMessage(error.name === 'AbortError' ? '업로드를 취소했습니다. 같은 선택으로 다시 시도할 수 있습니다.' :
        `${failed ? `${error.itemIndex}번 파일 (${failed.file.name}): ` : ''}${error.message}`);
    }
    finally { controller.current = null; setBusy(false); }
  }
  async function create() {
    if (!api || !items.length || items.some((item) => !item.mediaId)) return;
    setBusy(true);
    try { const project = await api.createProject(items.map((item) => item.mediaId), projectKey.current); setMessage('프로젝트를 만들었습니다. 기획을 확인해 주세요.'); await onCreated(project); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  return <section className="upload-card card"><div className="upload-symbol" aria-hidden="true">↑</div><h2>내 파일 직접 선택</h2><p>JPEG, PNG, WebP, MP4, MOV · 최대 {MAX_FILES}개 · 파일당 최대 50 MiB</p>
    <input ref={input} type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" onChange={select} aria-label="업로드할 사진 또는 영상 선택" hidden />
    <div className="upload-actions"><button className="secondary" onClick={() => input.current?.click()} disabled={!api || busy || items.length >= MAX_FILES}>파일 선택</button><button onClick={upload} disabled={!api || busy || !items.length || items.every((item) => item.mediaId)}>업로드 · 재시도</button><button onClick={create} disabled={!api || busy || !items.length || items.some((item) => !item.mediaId)}>프로젝트 만들기</button><button className="secondary" onClick={clear} disabled={busy || !items.length}>전체 선택 취소</button></div>
    <ol>{items.map((item, index) => <li key={item.id}><div className="upload-actions">
      {item.file.type.startsWith('image/') ? <img src={item.url} alt="선택한 사진 미리보기" width="72" height="72" style={{ objectFit: 'cover' }} /> : <video src={item.url} muted preload="metadata" width="72" height="72" aria-label="선택한 영상 미리보기" />}
      <span>{item.file.name} · {item.file.type.startsWith('image/') ? '사진' : '영상'} · {(item.file.size / 1024 / 1024).toFixed(1)} MiB · {item.status}{item.error ? ` · ${item.error}` : ''}</span>
      <button className="secondary" onClick={() => move(index, -1)} disabled={busy || index === 0} aria-label={`${item.file.name} 위로`}>↑</button>
      <button className="secondary" onClick={() => move(index, 1)} disabled={busy || index === items.length - 1} aria-label={`${item.file.name} 아래로`}>↓</button>
      <button className="secondary" onClick={() => remove(item.id)} disabled={busy} aria-label={`${item.file.name} 제외`}>제외</button>
    </div></li>)}</ol>
    <p className="muted" role="status">{!api ? '먼저 로컬 서버에 연결해 주세요.' : message}</p>
    {busy && <button className="text-button" onClick={() => controller.current?.abort()}>업로드 취소</button>}
    <div className="upload-note">선택하지 않은 파일과 로컬 폴더에는 접근하지 않습니다. 외부 AI 전송과 SNS 게시는 이 화면에서 실행되지 않습니다.</div>
  </section>;
}
