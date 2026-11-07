# 프론트엔드–백엔드 API 계약서

## 다중 미디어 업로드 확장 기록 (2026-11-03, 제안 계약)

`POST /api/v1/media/uploads`는 선택한 미디어 1~20개의 순서 있는 `items` 배열을 받습니다. 여러 항목인 경우 `PUT /media/uploads/{upload_id}/parts/{part_number}`의 번호는 1부터 시작하는 항목 순서이며 파일마다 한 조각입니다. `complete`는 동일 순서의 `items`와 canonical manifest SHA-256을 요구합니다. 단일 파일의 기존 완료 형식은 유지합니다. 프로젝트 생성은 순서 있는 `media_ids`를 받으며 조회 응답의 `media_manifest`에 순서·ID·검증된 해시를 담습니다. 서버 운영 상한은 `HAEJUMI_MAX_SELECTED_MEDIA`로 1~30개에서 설정할 수 있습니다. 이 경로의 정식 계약 승인 여부는 별도 결정 사항입니다.

`PUT /api/v1/tasks/{task_id}/plan`은 현재 버전·해시와 장면별 미디어 ID·길이·선택 영상 시작 위치를 받습니다. 서버는 미디어 집합과 길이 합을 검증하고 새 콘텐츠 버전을 만들며 승인·미리보기를 무효화합니다. 같은 멱등 키의 동일 요청은 저장된 결과를 돌려줍니다.

> 프로젝트: **해주미(Haejumi)** · AI 비서 이름: **예투**  
> 상태: **v0.3.3 기준 OpenAPI 3.1 설계 초안 v0.5 [제안/승인 대기]** · 수정일: 2026-10-30 · 대상: 1인 개인용, 향후 다중 사용자 확장  
> 원칙: **존댓말 응답 / 크리에이터 상업적 수익화 / 권리 검증 / 사용자 통제 / 로컬 우선**  
> 표기: **[확정]** 합의된 목표 · **[제안]** 구현 선택 · **[검증 필요]** 정책·환경 확인 전 결정 보류

## 원칙
- 버전: `/api/v1`. JSON UTF-8; 인증된 단일 사용자도 토큰/세션 기반 처리.
- 상태 전이는 서버에서 검증하며 파일 업로드는 크기·확장자·실제 MIME 확인.
- 모든 쓰기 요청은 `Idempotency-Key`를 지원하도록 설계.
- 오류: `{error:{code,message,details}, request_id}`. 토큰과 파일 경로 노출 금지.
- 게시 재시도는 요청 멱등 기록과 durable outbox를 남기며, 결과 불명 시 `outcome_unknown`으로 보류 후 공식 API 조회로 조정합니다. 불명 상태에서 자동 재업로드하지 않습니다.

## Creator 렌더 출력 v0.4 — 규격 확정, 세부 API 승인 대기
- Creator 공통 프로필은 9:16, 1080×1920, MP4/H.264/AAC, 30fps입니다. 기본 30초, 사용자 설정 3~59초이며 60초 이상은 거부합니다.
- 렌더 요청 제안은 `fit_pad`(전체 원본 표시, 여백 허용) 또는 `fill_crop`(0~1 정규화 초점 좌표)을 지원합니다. 자막·오버레이는 좌우 10%, 상단 15%, 하단 20% 예약 영역 안에 둡니다.
- 로컬 FFmpeg 이후 ffprobe가 규격을 확인하며 실패/불일치 시 ready 상태가 될 수 없습니다. API 초안은 계약 승인 대기입니다. 참조 구현은 plan·draft 각각의 `continue` 승인 뒤 렌더 job을 만들고 테스트 결과와 실영상 검증 결과를 구분합니다.

## 통일 API 후보 계약 v0.5 — [제안/승인 대기]

> **아직 사용자 승인이 없는 API 설계안입니다.** 아래 경로는 오직 하나의 `/api/v1` 접두사를 사용합니다. 이전 전달서의 `/api/projects` 형태 및 과거 `/content/projects` 예시는 역사 기록(archive)에 보관하고 이 문서에서는 실행 기준에서 제외합니다. 실제 OpenAPI 및 backend validation adapter 확정 전엔 계약 변경 금지.

| Method | `/api/v1` 이후 경로 | 목적 | 필수 통제 |
|---|---|---|---|
| POST | `/assistant/messages` | 예투 요청/라우팅 | 인증, 개인정보 게이트 |
| GET | `/capabilities` | 사용 가능한 모듈 조회 | 목록 조회가 권한 부여를 뜻하지 않음 |
| GET | `/privacy/processing-notice?provider_id=openai&purpose=vision_analysis` | 외부 처리 전 제공자·목적·데이터 범위 고지 | 사용자 화면에 먼저 표시 |
| GET/POST | `/privacy/consents` | 외부 처리 동의 조회/기록 | 제공자·목적·데이터 범위·고지 버전 묶음; 기록만으로 호출되지 않음 |
| DELETE | `/privacy/consents/{consent_id}` | 외부 처리 동의 철회 | 실제 egress 경계에서 소유자·동의 활성상태 재검사 |
| POST | `/tasks/{id}/plan` | Creator 쇼츠 기획·자막 초안 생성/수정 | 소유 프로젝트 미디어, Idempotency-Key, 버전 증가/승인 무효화 |
| GET | `/tasks/{id}/plan` | 현재 기획안·승인 checkpoint 조회 | 인증·소유권 |
| GET | `/tasks/{id}/draft` | plan 승인 후 자막 초안 읽기 | 현재 버전의 활성 plan 승인 |
| PATCH | `/tasks/{id}/draft` | 자막·음원·원음/BGM 음량·페이드 수정 | 현재 버전/hash와 멱등 키, 새 버전 및 과거 승인 무효화 |
| GET/POST | `/music/tracks` | 소유자의 로컬 음원 목록·메타데이터 등록 | 사용자 선택 음원, 권리·증빙, 소유권 |
| PUT | `/music/tracks/{id}/content` | 선택 WAV/MP3 업로드 | 크기·SHA-256·형식 signature 검증 |
| PATCH | `/music/tracks/{id}/rights` | 음원별 권리·증빙 수정 | 권리 revision 검사 및 관련 최종 승인 무효화 |
| POST | `/media/uploads` | 업로드 세션 생성 | 사용자가 선택한 항목만, 파일 한도 검증 |
| PUT | `/media/uploads/{upload_id}/parts/{part_number}` | 파일 조각 업로드 | 업로드 세션 소유권·조각 멱등성 |
| POST | `/media/uploads/{upload_id}/complete` | manifest 검증·업로드 완료 | 해시·크기·실제 형식, 제안 중복 방지 |
| POST | `/content/projects` | 콘텐츠 프로젝트 생성 | 소유권, 멱등성 |
| GET | `/content/projects` | 소유자의 Creator 프로젝트 목록 | 인증·소유권, 새 항목 우선, 로컬 저장 경로 비노출 |
| POST | `/tasks` | 모듈 작업 생성 | Registry 활성화·scope·입력 스키마 검사 |
| POST | `/tasks/{id}/plan` | 기획 생성/조회 | 관련 자료만 사용 |
| POST | `/tasks/{id}/feedback` | 수정·승인·보류·취소 | checkpoint, version, hash |
| GET | `/tasks/{id}/checkpoints` | 승인 대기·이력 | 인증/소유권 |
| GET | `/tasks/{id}/jobs` | 소유 작업의 렌더 이력 | 다른 기기에서 현재 버전 영상 재조회, 로컬 산출물 경로 비노출 |
| GET | `/tasks/{id}` | 상태·진행률 | 인증/소유권 |
| POST | `/tasks/{id}/approvals` | plan/draft/preview 중간 승인 증거 생성 | continue scope·현재 version/hash 서버 검증; 게시 최종 승인은 publication별 경로 사용 |
| POST/GET | `/tasks/{id}/publications` | 플랫폼 게시 정보 생성/목록 조회 | 계정·공개범위·제목·설명·해시태그별 저장 |
| GET/PATCH | `/tasks/{id}/publications/{publication_id}` | 게시 정보 단건 조회/수정 | 소유권/revision/hash 검사; 변경 시 연결 승인 무효화 |
| POST | `/tasks/{id}/publications/{publication_id}/approvals` | 해당 플랫폼 독립 최종 승인 | 실 FFmpeg+ffprobe+현재 preview 승인 및 모든 해시 검증 |
| POST | `/tasks/{id}/render` | 특정 버전 렌더 요청 | version/hash 검사; 렌더는 게시 승인 아님 |
| GET | `/jobs/{id}` | 비동기 작업 상태 조회 | 인증/소유권, 민감 오류 제거 |
| POST | `/jobs/{id}/cancel` | 소유한 대기/실행 렌더 작업 취소 | 인증/소유권; 실행 중 취소는 best effort |
| GET | `/tasks/{id}/preview` | 승인 전 영상 미리보기 | 인증/소유권, 비공개 |
| GET | `/content/projects/{id}/rights` | 라이선스·권리 상태 | REVIEW/BLOCK 구분 |
| POST | `/publishes` | 게시물별 승인된 버전 게시 | 승인 해시, 권리, 계정/범위, 멱등성 |
| GET | `/publishes/{id}` | 게시 결과·URL 확인 | 소유권, 중복 재게시 금지 |
| POST | `/diaries/drafts` | 승인 전 초안 | 허용된 하루 자료만 |
| PATCH | `/diaries/drafts/{id}` | 일기 수정·버전 증가 | 기존 최종 승인 무효화 |
| POST | `/diaries/drafts/{id}/finalize` | 최종 일기 저장 | 최종 승인·버전·해시 검사 |

**OpenAPI 3.1 상세 초안 [제안/승인 대기]:** [`openapi-v1.yaml`](openapi-v1.yaml)을 기준으로 검토합니다. 초보자용 설명은 [`API-GUIDE.md`](API-GUIDE.md), 계약·보안 수용 시나리오는 [`API-TEST-SCENARIOS.md`](API-TEST-SCENARIOS.md)에 둡니다. 세 문서 모두 구현 계약이 아니며 사용자 검토 전 구현 근거로 사용하지 않습니다.

**안전 경계:**
- 게시 요청은 `final_publish` 승인 ID와 승인 시점의 정확한 콘텐츠 버전/해시/플랫폼/계정/공개 범위/문구를 다시 대조하고, 해당 플랫폼 기준 권리 결과가 `ALLOW`일 때만 처리합니다. 중간 승인이나 STT 인식문만으로 게시할 수 없습니다.
- 외부 LLM/STT/비전 처리는 `external_processing` 동의와 별도 처리 요청을 요구합니다. 사용자 메시지나 게시 승인만으로 동의를 추정하지 않습니다. 동의 부재·철회·범위 불일치·정책 검사 실패는 fail closed로 거부합니다.
- API는 호출자의 `user_id`를 신뢰하지 않습니다. 소유자는 인증 주체에서 결정하고 모든 참조 ID를 소유권 검사합니다.
- 모든 변경 요청은 멱등 키 적용 대상으로 제안합니다. 키의 보존 기간·scope·충돌 규칙은 아직 승인되지 않았습니다.

### 최소 Creator 준비 슬라이스 — [제안/승인 대기]
선택 업로드 완료 뒤 참조 `POST /content/projects`는 초기 `waiting_plan_approval` Creator task와 plan checkpoint를 만들고 응답 `task_id`로 조회할 수 있게 합니다. API 초안의 계약 상태는 여전히 승인 대기입니다. 참조 어댑터는 업로드 세션당 미디어 1개·part 1개만 받으므로 여러 선택 파일은 각각 별도 세션으로 올립니다. 동일 소유자·순서 있는 미디어 ID·프로젝트 설정으로 다시 요청하면 다른 멱등 키를 써도 기존 프로젝트와 task를 돌려줍니다. 여러 파일 한 세션·재개 chunk 계약은 승인 대기입니다.

현재 manifest 규칙은 한 항목 배열을 UTF-8 compact JSON으로 직렬화하고, 키 순서를 `client_item_id`(소문자 UUID), `sha256`(소문자 hex), `size_bytes`로 고정한 뒤 SHA-256을 계산합니다. 이 규칙은 기존 동작을 명확히 적은 **제안/승인 대기**이며, 다중 항목 정렬 규칙은 정하지 않았습니다. 서버는 파일 signature와 컨테이너 구조·CRC/box 경계를 검사합니다. 전체 영상/이미지 codec decoding은 별도 도구가 없어 보장하지 않습니다.

## 공통 인증·소유권·권한 정책 — [제안/승인 대기]

모든 API는 `POST /auth/session`을 제외하고 Bearer 인증을 요구합니다. 인증은 신원 확인일 뿐, 리소스 권한을 자동으로 부여하지 않습니다.

1. **공통 인증:** 토큰 상태와 세션 만료를 검사합니다. 세션 생성·초기 등록 방식은 미확정입니다.
2. **공통 소유권:** `user_id`는 인증 주체에서 결정합니다. 모든 ID 참조는 소유자와 부모 리소스 관계를 검사합니다. 미존재 또는 타 사용자 리소스는 같은 `404 RESOURCE_NOT_FOUND`로 응답하여 ID 탐색을 막습니다.
3. **공통 권한:** 리소스 소유권 검사 후 capability/tool scope, 요청 목적, 상태 전이, 최종 side effect 승인, 권리/동의 게이트를 각각 검사합니다. LLM 출력은 권한 근거가 아닙니다.
4. **Agent별 scope:**

| 모듈 | 기본 접근 범위 | 금지/추가 승인 |
|---|---|---|
| Creator | 사용자가 선택·업로드한 미디어와 본인 Creator 프로젝트 | Diary/Wellness 원문 기본 접근 금지 |
| Schedule | 사용자가 허용한 일정 리소스 | 캘린더 연결·scope 및 쓰기 승인 필요 |
| Wellness | 사용자가 직접 기록했거나 명시 허용한 웰니스 자료 | 다른 Agent에 자동 공유 금지 |
| Diary | 요청 날짜에 대해 사용자가 허용한 source ID만 | 원문 전체/다른 날짜 자동 탐색 금지; 정식 저장은 최종 승인 필요 |
| Blog/Music/미래 모듈 | Registry에 등록된 capability와 선언된 scope만 | 활성화만으로 개인정보 접근·외부 전송·발행 권한 부여 금지 |

모든 외부 LLM/STT/비전/분석 요청은 API를 호출한 경로와 관계없이 동일한 Backend `PrivacyGate`/`LLMGateway`를 거칩니다. 승인된 제공자 allowlist, 목적, 데이터 범주, 리소스 소유권, 최소화 정책 및 현재 consent를 실제 dispatch 직전에 다시 확인합니다. 하나라도 부재·철회·만료·불일치·검사불가이면 provider dispatch를 거부하고 **외부 요청 0회**여야 합니다. 현재 Creator plan은 `local_rules` fallback과 `generation.gate_reason`을 반환합니다. 향후 직접 외부처리 API를 추가할 때는 같은 거부를 `403 CONSENT_REQUIRED`/`403 PRIVACY_POLICY_DENIED`로 표현해야 합니다.

현재 reference 구현의 외부 비전 범위는 OpenAI `vision_analysis`만 지원합니다. 사용자가 고지에서 확인한 목적/data categories 외에 정확한 `resource_ids` 집합을 consent에 저장하고, Creator task의 현재 소유 미디어 IDs와 일치해야 합니다. 사진 축소·메타데이터 제거 및 영상 frame 추출은 로컬 어댑터이며, 준비된 최대 N개(기본 5개) 시각 입력만 전송합니다. OpenAI 연결 flag/key/model 부재, 준비 실패, 예산 초과 또는 consent 검증 실패 시 해당 요청은 로컬 규칙 처리로 완료되고 provider egress는 0회입니다. 실제 사용자 대상 consent UI와 실계정 호출은 아직 구현/검증되지 않았습니다.

신규 JSON Creator 기획은 위 **전체 미디어 ID 집합 동의**를 시작 전에 검사하고, 사진별 독립 Vision 호출마다 해당 ID 하나가 그 집합에 속하는지 PrivacyGate에서 다시 검사합니다. 한 요청에 축소 이미지 한 장만 전송합니다. 사진별 성공·실패·캐시 상태는 `generation.media_analysis`로 반환하며, 사진별 결과가 있더라도 자막은 `needs_review`입니다. 남은 작업당 호출·일/월 예약 예산에서 허용할 때만 이미지 없는 전체 스토리 요청을 추가합니다. 기존 프로젝트의 기획과 승인 이력을 자동 변환하지 않습니다.

## 승인 종류·상태 전이 — [제안/승인 대기]

### 독립된 권한

| 종류 | 계약 값 | 허용 효과 | 다른 권한을 대신할 수 없음 |
|---|---|---|---|
| 중간 승인 | `approval_scope=continue` | 승인된 체크포인트 다음 단계 진행 | 최종 게시, 일기 저장, 외부 전송 불가 |
| 최종 게시 승인 | `approval_scope=final_publish` | 정확한 Creator 결과·게시 대상에 대한 한 번의 게시 작업 생성 | 외부 개인정보 전송, 일기 저장 불가 |
| 일기 최종 승인 | `approval_scope=final_diary` | 승인된 일기 버전의 정식 저장 | 게시, 외부 전송 불가 |
| 외부 처리 동의 | 독립 `consent_id`와 `active/revoked/expired` 상태 | 동의된 provider·purpose·data categories에 한해 PrivacyGate가 외부 호출 허용 | 중간/최종 승인 및 게시 불가 |

승인 조합 허용표:

| Checkpoint kind | 허용 approval scope | 필수 바인딩 |
|---|---|---|
| `plan`, `draft`, `preview` | `continue` | `task_id`, `checkpoint_id`, 현재 `content_version`, `content_hash` |
| `final_publish` | `final_publish` | 위 필드 + `artifact_sha256` + 플랫폼·계정·공개범위·게시 문구 |
| `final_diary` | `final_diary` | 초안 ID, 현재 버전/hash, 대상 날짜 |
| 그 밖의 조합 | 없음 | `409 APPROVAL_SCOPE_MISMATCH`; 상태 변경 없음 |

콘텐츠 작업 상태는 다음 경로만 허용하도록 제안합니다. 실패·취소·보류는 각 진행 상태에서 가능한 종결/대기 전이이며 자동으로 다음 승인 단계를 통과하지 않습니다.

```text
created → planning → waiting_plan_approval → drafting → waiting_draft_approval
→ revising/rendering → waiting_preview_approval
→ waiting_final_publish_approval → ready_to_publish → publish_queued → publishing
→ published

Diary: drafting → waiting_draft_approval → revising → waiting_final_diary_approval
→ saved

Publishing uncertainty: publishing → outcome_unknown → reconciling
→ published | failed | needs_user_action
```

외부 동의는 위 콘텐츠 승인 상태와 별도 객체 상태입니다. consent `revoked`/`expired` 전이는 승인 상태를 만들거나 되살리지 않습니다. 모든 전이는 서버에서 현재 상태를 확인하며, 앱 UI나 음성 인식만으로 상태를 건너뛸 수 없습니다.

## 콘텐츠 버전·해시 및 승인 무효화 — [제안/승인 대기]

- `content_version`은 작업의 불변 버전 번호입니다. 콘텐츠에 영향을 주는 수정은 원자적으로 `+1`하고 새 `content_hash`를 생성합니다.
- `content_hash`는 canonical immutable version manifest의 SHA-256입니다. 제안 범위: 순서가 고정된 source media ID와 각 원본 SHA-256, 타임라인/컷, 자막, 음악 및 license reference, 렌더 설정. JSON canonicalization·정규화 규칙은 승인 전 미확정입니다.
- `artifact_sha256`은 렌더된 MP4 정확한 바이트의 SHA-256입니다. 게시 최종 승인과 게시 요청은 둘 다 현재 `content_hash`와 `artifact_sha256`을 포함해야 합니다.
- `approval_hash`는 승인 scope, checkpoint, 버전/hash를 묶으며, `final_publish`에서는 artifact hash와 플랫폼·계정·공개범위·문구도 포함합니다.
- 새 content version 생성 시 해당 작업의 이전 버전에 결합된 **모든 중간·최종 승인**을 `invalidated`로 처리합니다. 과거 버전으로 되돌아가도 승인을 복구하지 않습니다.
- 게시 대상 메타데이터만 바뀌어도 최종 게시 승인과 권리 결과를 무효화하고 해당 대상에 대해 재검사·재승인을 요구합니다.
- stale version/hash/approval 요청은 `409 STALE_APPROVAL` 또는 `409 VERSION_CONFLICT`; 어떤 저장·게시도 수행하지 않습니다.

## 게시 중복 방지·결과 조정 — [제안/승인 대기]

1. 게시 접수는 현재 `final_publish` approval의 모든 binding, `RightsDecision=ALLOW`, 계정 권한과 소유권을 다시 검사합니다.
2. 서버는 외부 호출 전 멱등 기록과 durable outbox를 같은 트랜잭션 경계에서 저장합니다. 기록에는 owner, operation, 요청 fingerprint, `publish_id`, approval ID가 연결됩니다. 원문/비밀은 기록하지 않습니다.
3. 같은 멱등 키와 같은 fingerprint 재전송은 기존 `publish_id`/job을 반환하며 외부 업로드를 새로 시작하지 않습니다. 같은 키에 다른 fingerprint면 `409 IDEMPOTENCY_CONFLICT`입니다. 이미 같은 approval로 게시 작업이 있으면 새 키여도 `409 PUBLISH_ALREADY_EXISTS`입니다.
4. 외부 업로드 요청 후 응답이 유실되거나 연결이 끊기면 성공/실패로 추정하지 않고 `outcome_unknown`에 둡니다. 자동 재업로드는 금지합니다.
5. 제한된 게시 Worker가 플랫폼의 공식 API로 기존 upload/operation ID 또는 승인된 검색 기준을 조회해 `reconciling`합니다. 일치하는 게시를 찾으면 원래 `publish_id`를 `succeeded/published`로 갱신하고, 명확한 실패만 `failed`로 둡니다.
6. 공식 API로 결과를 확인할 수 없거나 여러 결과가 일치하면 `needs_user_action`으로 보류하고 사용자에게 확인을 요청합니다. 이는 새 게시 요청이 아닙니다.

멱등 기록의 보존 기간, 플랫폼별 공식 조회 가능성 및 동일 artifact의 새 승인 후 재게시 정책은 **승인 대기**입니다. 플랫폼 API가 안전한 조회/멱등을 제공하지 않으면 결과 불명 상태에서 자동 재시도하지 않는 것이 기본 fail-closed 제안입니다.

## 표준 오류 및 권리 enum — [제안/승인 대기]

| HTTP | `error.code` | 의미 |
|---|---|---|
| 401 | `AUTHENTICATION_REQUIRED` | 인증 누락·만료·무효 |
| 403 | `FORBIDDEN`, `CONSENT_REQUIRED`, `PRIVACY_POLICY_DENIED`, `RIGHTS_BLOCKED`, `RIGHTS_REVIEW_REQUIRED`, `CAPABILITY_DISABLED`, `OAUTH_EXPIRED` | 인증은 됐으나 권한/정책/동의/권리에서 거부 |
| 404 | `RESOURCE_NOT_FOUND`, `CAPABILITY_NOT_FOUND` | 미존재 또는 접근 불가 리소스/미등록 capability |
| 409 | `VERSION_CONFLICT`, `STALE_APPROVAL`, `APPROVAL_SCOPE_MISMATCH`, `INVALID_STATE_TRANSITION`, `IDEMPOTENCY_CONFLICT`, `PUBLISH_ALREADY_EXISTS` | 충돌·오래된 증거·중복 게시 작업 |
| 413 | `PAYLOAD_TOO_LARGE` | 요청/파일 한도 초과 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 허용되지 않거나 내용과 선언이 다른 미디어 |
| 422 | `VALIDATION_ERROR`, `PLATFORM_NOT_SUPPORTED` | 입력 스키마 또는 현재 미지원 플랫폼 |
| 429 | `RATE_LIMITED` | 요청 빈도 제한 |
| 503 | `SERVICE_UNAVAILABLE` | 로컬 worker 또는 허가된 connector 불가 |

비동기 작업의 종료 코드 `RENDER_FAILED`는 HTTP 오류가 아니라 Job의 `safe_error_code`입니다. `outcome_unknown`도 오류 코드가 아니라 게시 작업 상태입니다. 응답 본문 모양은 항상 `{error:{code,message,details?},request_id}`이며 민감 원문·토큰·내부 경로를 포함하지 않습니다.

권리 상태 wire enum은 대문자 `ALLOW`, `REVIEW`, `BLOCK`으로 통일합니다. 게시 허용은 `ALLOW`만 가능합니다. `REVIEW`와 `BLOCK`은 게시 요청 전에 차단되며, 게시 시점에도 서버가 권리를 재검사합니다.

## Capability Registry 확장 — [제안/승인 대기]

`GET /capabilities`가 모듈 ID, capability ID, 모듈 버전, 입력 schema version, 활성 상태, data scopes, Tool allowlist 참조를 반환하도록 제안합니다. `module_id`와 capability ID는 closed enum이 아닌 제한 형식의 안정된 string입니다. 서버 Registry에 등록되고 `enabled`인 capability만 `/tasks`에서 실행할 수 있습니다. 미등록/비활성 항목은 각각 `404 CAPABILITY_NOT_FOUND`/`403 CAPABILITY_DISABLED`로 거부합니다.

현재 MVP의 핵심 Agent는 Creator·Schedule·Wellness·Diary로 유지합니다. Blog·Music은 미래 예시일 뿐이며 이 API 초안에 식별자가 있다는 이유만으로 활성화되지 않습니다. 신규 모듈은 모듈 자체 schema version, scope, 외부전송 정책, 승인 조합, 비용·권리 정책과 테스트를 Registry에 등록해야 하며 기존 모듈의 request/response를 변경하지 않는 방향을 제안합니다.

## Schedule Google Calendar Mock 확장 (2026-11-08)

사용자가 승인한 분리 계약에 따라 기존 로컬 일정 경로와 별도로 `/api/v1/schedule/google/connection`, `/connection/start`, `/oauth/callback`, `/events`, `/events/{google_event_id}`, `/proposals`, `/proposals/{proposal_id}/confirm`을 추가했습니다. 정확한 메서드·입력·응답 및 오류는 `docs/openapi-v1.yaml`을 기준으로 합니다. Google 이벤트는 `source: google`, 외부 ID·ETag·시간대·하루 종일 날짜·동기화 상태를 갖고 로컬 일정으로 자동 변환하지 않습니다. 쓰기는 소유자별 10분짜리 제안과 별도 확인·멱등 키를 거치며 중복 일정과 ETag 충돌을 거부합니다. 운영 서버는 실제 공급자와 토큰 키를 주입하지 않아 외부 Google 요청을 실행할 수 없습니다. 실제 OAuth·Calendar API와 화면 연결은 별도 단계입니다.

## 프로젝트 생성 요청 예시
```json
{"media_ids":["m1","m2"],"style":"calm_cafe","target_seconds":30,"aspect_ratio":"9:16"}
```

## 상태·동시성
- Creator `POST /tasks/{id}/plan`의 필수 `content_version`은 요청의 기준 버전이며 새 요청에서 현재 task 버전과 다르면 `409 VERSION_CONFLICT`입니다. 동일 멱등 키와 동일 요청의 재전송은 이전 결과를 반환합니다. `request_text`도 필수이며 성공 시 새 버전의 기획을 `201`로 반환합니다. 이전 초안의 `base_content_version`은 이 경로에서 같은 동시성 확인을 의도한 이름이지만 참조 구현에서 받지 않습니다.
- 다른 제안 API에서 `base_content_version`을 명시한 경우에는 해당 경로의 계약을 따릅니다.
- 자막·음악 편집은 새 콘텐츠 버전을 만들고 이전 승인과 체크포인트를 무효화합니다. 현 참조 모델은 새 버전의 plan 및 draft 중간 승인을 다시 요구합니다. 음원만 바뀌고 이전 실렌더가 유효하면 검증된 영상 스트림을 재사용하고 오디오만 다시 합성합니다.
- `user_verified`는 사용자가 기록한 확인이며 공급자·플랫폼의 권리를 자동으로 보증하지 않습니다. 최종 게시 승인 시 음원 해시, 상업 이용, 대상 플랫폼, 출처·라이선스 버전·증빙·다운로드일과 필수 표기를 검사합니다. 나머지 원본·초상권·플랫폼 권리 게이트는 미완료입니다.
- 렌더 작업과 게시 작업은 비동기, 폴링 혹은 SSE로 상태 수신.
- 게시 결과 불명은 `outcome_unknown` 작업 상태이며 HTTP 오류 코드가 아닙니다. 공식 API 조정 전에는 재업로드하지 않습니다.
- OAuth 연결은 외부 공급자별 redirect URI와 state/PKCE 검증.

## 오류·상태 코드 기준

정식 후보 코드는 위의 **표준 오류 및 권리 enum** 표와 `components.schemas.ErrorCode`가 기준입니다. 과거 `MEDIA_UNAVAILABLE`, `NOT_AUTHORIZED`, `MODEL_LICENSE_UNVERIFIED` 같은 예시 코드는 이 계약의 wire code로 사용하지 않습니다. 권리 결과는 대문자 `ALLOW/REVIEW/BLOCK`, 비동기 게시 불명은 job status `outcome_unknown`으로 통일합니다.

> 이 문서는 **개발용 초안 계약**이며 실제 OpenAPI 스키마 생성 후 FE·Android·BE가 공동 검증해야 합니다.

---

## 이전 계약과의 관계
- 전달서와 v0.2의 경로는 1:1로 구현하지 않습니다. 본 문서의 후보 계약에 매핑하고 `docs/RECONCILIATION-REPORT.md`에서 차이를 추적합니다.
- 필드/응답 타입·multipart 업로드 규격·상태 기계·오류 코드·소유권 정책·버전 지정 방식은 **승인 및 OpenAPI 테스트 필요**.
- 음성 원본 미보관을 기본값으로 하며 원본 보존 예외는 별도 동의가 필요합니다.

## 플랫폼별 Creator 게시 정보 API — [구현됨, 계약 승인 대기]

공통 렌더 결과를 YouTube Shorts, TikTok, Instagram Reels 각각의 게시 정보 레코드와 연결합니다. 경로는 `POST/GET /tasks/{task_id}/publications`, 단건 `GET/PATCH /tasks/{task_id}/publications/{publication_id}`, 독립 승인 `POST /tasks/{task_id}/publications/{publication_id}/approvals`입니다. 게시 정보에는 `platform`, `account_id`, `visibility`, `title`, `description`, `hashtags`가 있고, 서버가 `revision`과 `metadata_hash`를 관리합니다. 한 task·platform 조합당 하나만 허용합니다.

모든 경로는 bearer 인증과 소유권 검사를 적용하고 비소유 응답은 `404 RESOURCE_NOT_FOUND`로 통일합니다. 변경 요청에는 `Idempotency-Key`가 필요하며 PATCH는 현재 `revision`과 일치해야 합니다. 게시 정보 변경은 해당 publication ID에 연결된 `final_publish` 승인만 무효화하고 새 revision을 발급합니다. 타 플랫폼 승인은 별도 publication ID에 묶여 유지됩니다.

플랫폼 최종 승인은 현재 콘텐츠 버전/hash, 실제 렌더 MP4의 SHA-256, 게시 정보 revision/hash에 묶입니다. 현재 task의 preview 승인, 성공한 FFmpeg 렌더, `artifact_verified=true`, ffprobe 검증 결과가 모두 있어야 publication 상태를 `publish_ready`로 바꿉니다. 테스트 렌더와 중간 승인, 다른 publication 승인으로는 전이할 수 없습니다. 프로젝트 콘텐츠 새 버전이 생기면 구버전에 연결된 모든 플랫폼 승인을 무효화해야 합니다. SNS 호출이나 게시 endpoint는 이 범위에 포함하지 않습니다.

공개범위 enum을 플랫폼 별 공식 API 값에 매핑하는 방법, 플랫폼별 제목/설명/해시태그 길이 제한, 계정 ID 연결/검증은 `[검증 필요]`입니다. 현재 공통값은 제안이며 게시 실행 허가가 아닙니다.

## 승인 필요 항목
- [참조 구현·정식 계약 검토 필요] JSON Creator의 장면 편집은 기존 선택 미디어를 `scene_id`별로 재배치·재사용·제외할 수 있고, 자막은 `scene_id`·`media_id` 및 시간 경계를 함께 검증합니다. 레거시 ID 없는 자막은 시간 연결을 유지하되 사용자 검토가 필요합니다. `GET /media/{media_id}/image-preview`는 소유자 인증된 로컬 사진 표시용입니다. 세부 필드와 응답은 `docs/openapi-v1.yaml`을 참조하며 정식 API 계약 확정은 별도입니다.
- 인증 방식·초기 사용자 등록/복구, 세션 수명, LAN HTTPS/Tailscale 경계.
- 업로드 크기/형식/청크 전송과 재개 방식, manifest canonicalization 및 해시 범위.
- 외부 처리 동의의 UI·만료·철회 시점, 공급자/목적별 세부 범위와 기존 작업 처리.
- 승인·게시의 멱등 키 scope/보존 기간, 중복 키 payload 충돌 응답.
- API 작업 상태와 checkpoint 상태 enum, 폴링 주기 또는 SSE 선택, 삭제/보존 규칙.
- 게시 멱등 키/approval-bound 중복 기준의 보존 기간, outbox 저장·복구와 플랫폼별 공식 API reconciliation 지원 범위.
- `outcome_unknown` 이후 공식 조회 결과가 없거나 복수 일치할 때 필요한 사용자 UI/행동.
- consent 고지 표시·확인 증거, 철회와 이미 전송 중인 외부 요청의 처리 경계.
- `content_hash` canonical serialization, manifest 순서/정규화, publish target의 approval hash 바인딩 필드.
- approval 조합표와 모듈별 상태 전이, 오류 코드/HTTP 매핑의 최종 승인.
- Capability Registry의 schema version 호환 정책, 미등록/비활성 capability 오류 및 새 모듈 권한 리뷰 절차.
- `docs/openapi-v1.yaml`의 모든 경로·스키마·오류·상태코드 및 확장 capability 허용 정책.
