# 데이터베이스 스키마 초안

> 프로젝트: **해주미(Haejumi)** · AI 비서 이름: **예투**  
> 상태: 설계 초안 v0.2 · 수정일: 2026-10-30 · 대상: 1인 개인용, 향후 다중 사용자 확장  
> 원칙: **존댓말 응답 / 크리에이터 상업적 수익화 / 권리 검증 / 사용자 통제 / 로컬 우선**  
> 표기: **[확정]** 합의된 목표 · **[제안]** 구현 선택 · **[검증 필요]** 정책·환경 확인 전 결정 보류

## 설계 규칙
- PostgreSQL 1개 사용, 미디어 바이너리는 DB 대신 로컬 파일 저장소에 보관.
- 모든 주요 테이블에 `id UUID`, `created_at`, `updated_at`, 추후 확장을 위한 `user_id` 포함.
- 참조 무결성(FK), 중요 상태 열거값(CHECK/enum), 파일 해시 중복 검사.

| 테이블 | 주요 필드 | 설명 |
|---|---|---|
| users | id, display_name, locale, is_active | 초기 단일 사용자 |
| user_preferences | user_id, key, value_json, approved | 스타일·말투 설정 |
| memory_items | id, user_id, type, body, embedding, sensitivity | 장·단기 기억 |
| media_assets | id, owner_id, path, sha256, mime, captured_at, source_device | 원본 사진·영상 |
| media_groups | id, owner_id, group_key, status, suggested_at | 방문별 묶음 |
| group_members | group_id, asset_id, ordinal | 그룹–미디어 연결 |
| proposals | id, group_id, state, snooze_until, dedup_key | 능동형 제안 |
| content_projects | id, owner_id, style, target_seconds, state, current_version | 편집 프로젝트 |
| project_versions | project_id, version, edit_json, output_asset_id, sha256 | 불변 버전 기록 |
| caption_tracks | project_id, version, segments_json, language | 자막 |
| music_assets | id, path, origin, model, model_version, license_id, checksum | 음악 원본/생성 |
| licenses | id, source_url, terms_snapshot_path, commercial_ok, platforms_json, reviewed_at | 라이선스 증빙 |
| asset_rights | asset_id, license_id, status, evidence_ref | 에셋 권리 검증 |
| approvals | id, project_id, version, artifact_sha256, scope, approved_at | 승인 증거 |
| connected_accounts | id, platform, account_ref, token_secret_ref, scopes | OAuth 연결(토큰 별도 암호화) |
| publish_jobs | id, project_id, version, platform, idempotency_key, status, external_id | 게시 이력 |
| jobs | id, type, state, attempts, last_error_code, progress | 비동기 작업 |
| agent_traces | trace_id, agent, step, status, timings_json, safe_summary | 에이전트 추적 |
| wellness_records | id, user_id, encrypted_blob, recorded_at | 민감 데이터 별도 제한 |

## 주요 제약
- `UNIQUE(publish_jobs.platform, publish_jobs.idempotency_key)`.
- `UNIQUE(project_versions.project_id, project_versions.version)`.
- 파일 삭제는 참조가 없고 보존 정책에 위배되지 않는 경우에만 실행.
- `licenses.commercial_ok=true`만으로 허용하지 않고 플랫폼·용도·유효 기간 함께 확인.

## 마이그레이션
- Alembic 마이그레이션을 버전 관리하고 테스트 데이터로 업/다운 수행.
- 초기 단일 사용자라도 DB 스키마에는 `user_id` 포함하여 향후 데이터 분리 대비.

---

## v0.2 신규/변경 테이블
| 테이블 | 주요 컬럼 | 설명 |
|---|---|---|
| `diary_drafts` | `id,user_id,day,source_snapshot,body,version,status,updated_at` | 승인 전 임시 원고 |
| `diary_entries` | `id,user_id,day,body,approved_version,approved_hash,finalized_at` | 승인된 정식 일기 |
| `task_checkpoints` | `id,task_id,step,status,version,payload_hash,created_at` | 중간 확인 지점 |
| `approval_decisions` | `id,task_id,checkpoint_id,decision,base_version,hash,comment,created_at` | 컨펌·수정 이력 |
| `voice_transcripts` | `id,task_id,text,confirmed_at,retention_until` | 인식문, 원본 음성은 기본 미보관 |
| `media_imports` | `id,user_id,folder_key,manifest_hash,status,completed_at` | 선택 업로드와 중복 방지 |

제약: 최종 액션은 승인된 버전+해시 FK/검증 필요. 일기 및 민감 기록은 사용 목적별 권한 분리.
