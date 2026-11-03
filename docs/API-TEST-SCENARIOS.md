# `/api/v1` API 계약·보안 테스트 시나리오

## 다중 미디어 업로드 확인 (2026-11-03)

- 사진 5~10장, 영상 여러 개, 사진·영상 혼합을 직접 선택한 뒤 선언 순서와 완료 응답 순서가 같은지 확인합니다.
- 한 파일 전송 후 완료 요청은 409, 같은 부분 재전송은 204, 해시가 다른 재전송은 409를 확인합니다.
- 완료 manifest의 순서·SHA-256을 바꾸면 409가 나고 정상 파일은 그대로 남아야 합니다.
- 다른 사용자 토큰으로 미디어를 프로젝트에 연결하면 404를 확인합니다.
- PC 웹과 Android에서 선택 순서 변경·개별 제외·전체 취소, 재시도, 프로젝트 조회를 확인합니다. Android 실기기는 별도 검증이 필요합니다.
- 기획 승인 후 장면 순서를 뒤집고 재생 초·영상 시작 위치를 바꾸면 버전이 1 증가하고 이전 승인 요청이 409를 반환하는지 확인합니다.
- 장면 미디어 누락·중복, 목표 길이와 다른 합계, 사진의 영상 trim 요청은 422로 거부하는지 확인합니다.

## PC·Android 공통 상태 조회 — 2026-11-03 추가

- 인증 없이 `GET /content/projects`는 401, 다른 소유자 토큰으로는 빈 목록을 반환합니다. 본인 목록에는 로컬 파일 경로·소유자 내부 ID가 노출되지 않습니다.
- `GET /tasks/{task_id}/jobs`는 본인 작업의 렌더 이력을 새 항목 우선으로 반환합니다. 타인 작업 ID는 404이며 산출물 로컬 경로를 반환하지 않습니다.
- PC와 Android가 같은 작업을 조회한 뒤 한쪽이 기획·자막을 수정하면 다른 쪽의 구버전 승인·렌더 요청은 409로 거절되고 서버 최신 버전/해시/체크포인트를 다시 읽어야 합니다. 실제 두 기기 동시 E2E는 미검증입니다.
- PC 웹은 직접 고른 파일만 업로드하고 토큰을 메모리에서만 사용합니다. 외부 AI 동의/호출 및 실제 SNS 게시 UI는 없습니다.

> 상태: OpenAPI v0.5 수용 기준 **[승인 대기]**. 일부 보안·Creator 기본 흐름은 `backend/tests`에서 실행되며, 전체 시나리오의 테스트 구현/실행을 뜻하지 않습니다.
> 계약 원본: [`openapi-v1.yaml`](openapi-v1.yaml) · 정책: [`09-API-CONTRACT.md`](09-API-CONTRACT.md) · 설명: [`API-GUIDE.md`](API-GUIDE.md)

모든 테스트는 가짜 미디어·계정과 mock 외부 서비스로 시작합니다. 실제 SNS 게시나 개인정보 외부 전송은 하지 않습니다. 모든 행의 응답은 `error.code`와 HTTP를 함께 검증하고, 상태 변경 및 외부 HTTP 호출 수를 확인합니다.

## 인증·소유권·Agent scope

| ID | 상황 | 기대 결과 |
|---|---|---|
| AUTH-01 | `/auth/session` 외 보호 경로에 토큰 없이 호출 | `401 AUTHENTICATION_REQUIRED`; 리소스/작업 변화 없음 |
| AUTH-02 | 사용자 A가 사용자 B의 media/project/task/checkpoint/consent/approval/publish/draft ID 참조 | `404 RESOURCE_NOT_FOUND`; 데이터 유출·변경 없음 |
| PUBMETA-01 | 한 task에서 YouTube/TikTok/Instagram 게시 정보 각각 생성·조회 | 플랫폼별 독립 레코드와 요청 필드 유지; 플랫폼 API 호출 0회 |
| PUBMETA-02 | 동일 task/platform 게시 정보 중복 생성 | `409 PUBLICATION_ALREADY_EXISTS`; 기존 정보 유지 |
| PUBMETA-03 | 타인 task/게시 레코드 조회·수정 | `404 RESOURCE_NOT_FOUND`; 정보 노출·변경 없음 |
| PUBMETA-04 | 수정된 revision이 오래된 PATCH에 사용됨 | `409 VERSION_CONFLICT`; 새 값 보존 |
| PUBMETA-05 | 게시 정보 수정 후 해당 플랫폼 기존 final approval | revision 증가, 해당 승인 invalidated, status draft |
| PUBMETA-06 | YouTube 정보 수정 후 TikTok 승인 | YouTube 승인만 무효화; TikTok 승인은 독립적으로 유지 |
| PUBMETA-07 | 테스트 렌더 artifact로 플랫폼 최종 승인 | `409 RENDER_REQUIRED`; publish_ready 전환 없음 |
| PUBMETA-08 | 실제 ffmpeg+ffprobe+현재 preview 승인 없는 final approval | `409 RENDER_REQUIRED`; 승인과 외부 호출 모두 0 |
| PUBMETA-09 | 중간 승인/다른 플랫폼 승인 ID를 플랫폼 final approval에 재사용 | 거부; 플랫폼/콘텐츠/계정/공개범위/문구 간 권한 전이 없음 |
| SUP-01 | `GET /capabilities` | Creator/Schedule/Wellness/Diary 등록, Blog/Music disabled 상태 반환 |
| SUP-02 | 단일 Creator/Schedule/Wellness/Diary 표현으로 assistant 요청 | 규칙 기반 단일 Agent route; 호출하지 않은 Agent 데이터 접근 0 |
| SUP-03 | 여러 Agent에 걸친 모호한 요청 | `needs_clarification`; Agent 실행·LLM 호출 0 |
| SUP-04 | 비소유 task 또는 연결되지 않은 media ID로 Creator plan 요청 | `404 RESOURCE_NOT_FOUND`; 계획/LLM 호출 0 |
| SUP-05 | plan checkpoint 승인 전 caption draft 읽기 | `409 INVALID_STATE_TRANSITION`; 초안 비공개 |
| SUP-06 | plan 승인 후 초안 읽기, draft 승인 전 렌더 | 초안 제공; 렌더 승인 조건은 계속 유지 |
| SUP-07 | 기획 재수정 후 이전 plan/draft approval 사용 | content_version 증가, 과거 승인 invalidated, 구버전 승인 거부 |
| SUP-08 | 새로운 기획 생성 요청에 오래된 `content_version` 사용 | `409 VERSION_CONFLICT`; 새 기획과 승인 상태 변경 없음. 동일 멱등 요청 재전송은 기존 결과 반환 |
| SUP-09 | 기획 생성에 `request_text` 누락 또는 `base_content_version` 사용 | `422 VALIDATION_ERROR`; 기획 생성 없음 |
| COMP-01 | plan 승인 뒤 자막·음악·음량 편집 | 새 버전/hash와 plan checkpoint 생성, 과거 승인 무효화; 새 plan/draft 승인 전 렌더 거부 |
| COMP-02 | 본인 로컬 WAV/MP3 등록·업로드 | 크기/해시/signature 검사; 타 소유자 접근 거부, 검증 실패 시 등록 차단 |
| COMP-03 | 권리 미확인 또는 대상 플랫폼 미허용 음원으로 최종 승인 | `403 RIGHTS_REVIEW_REQUIRED`; SNS 호출 0 |
| COMP-04 | 음원 권리·증빙 수정 또는 확인 철회 | 권리 revision 증가, 해당 음원을 사용하는 최종 게시 승인 무효화 |
| COMP-05 | 실제 FFmpeg에 한글 자막·합성 원음·합성 BGM 제공 | 안전 영역의 자막 픽셀, 두 음원의 주파수와 페이드, ffprobe 출력 규격 확인 |
| COMP-06 | 기존 영상의 자막은 그대로 두고 오디오 설정만 변경 | 이전 검증 영상 비트스트림 재사용, 오디오 재합성, 새 승인 필수 |
| COMP-07 | 음량이 0보다 큰 원본 영상 오디오의 권리가 미확인 | `403 RIGHTS_REVIEW_REQUIRED`; 대상 플랫폼별 확인과 필요한 표기 이후 승인 가능 |
| LLM-01 | Gateway 기본 설정 또는 LLM enabled=false | 공급자 호출 0; local rules fallback |
| LLM-02 | PrivacyGate에 검증된 명시 동의/allowlist 없음 | 외부 호출 0; `CONSENT_REQUIRED` fallback |
| LLM-03 | Mock provider 테스트 | LLM Gateway만 호출; 실제 OpenAI/외부 요청 0 |
| LLM-04 | 일·월 비용 한도 또는 작업 호출 제한 도달 | 추가 provider 호출 0; `LLM_BUDGET_EXCEEDED` fallback |
| LLM-05 | 외부 처리 timeout/결과 불명 | 자동 재요청 없음; local fallback, 예약된 한도 유지 |
| LLM-06 | OpenAI Responses adapter에 synthetic key/fake fetch 사용 | 형식·timeout·오류 축약·store=false 확인; 실네트워크 0 |
| LLM-07 | 5개 초과 선택 항목 | 이미지 입력 최대 5개; 나머지 파일 본문 미전송 |
| LLM-08 | API key 누락 또는 모델 미설정 | OpenAI provider 구성 안 됨; local fallback; 호출 0 |
| AUTH-03 | request body에 위조 `user_id` 포함 | 소유권은 인증 주체로만 계산; 위조 ID 무시 또는 `422 VALIDATION_ERROR` |
| AUTH-04 | Creator가 Diary/Wellness scope를 요청 | `403 FORBIDDEN`; 민감 데이터 조회 0회 |
| AUTH-05 | Diary가 요청 날짜 외 source 또는 허용되지 않은 source ID 참조 | `404 RESOURCE_NOT_FOUND`; 원문 접근 0회 |

## 선택 미디어 업로드·버전

| ID | 상황 | 기대 결과 |
|---|---|---|
| UP-01 | 지원 미디어의 선택 업로드와 manifest 완료 | signature·확장자·container 구조/CRC·크기·SHA-256 일치; owner+manifest의 import/proposal 최대 1회 |
| UP-02 | path traversal, 미등록 파일 경로 또는 비선택 미디어를 참조 | `422 VALIDATION_ERROR` 또는 `404 RESOURCE_NOT_FOUND`; 서버 파일 탐색/비선택 파일 읽기 0회 |
| UP-03 | 선언은 JPEG지만 실제 파일이 금지 형식 | `415 UNSUPPORTED_MEDIA_TYPE`; 격리 및 downstream 사용 금지 |
| UP-04 | 크기 제한 초과 | `413 PAYLOAD_TOO_LARGE`; 완료 상태/프로젝트 연결 없음 |
| UP-05 | 같은 조각·같은 멱등 키·같은 body 재전송 | 기존 결과 반환; 중복 저장 0회 |
| UP-06 | 같은 멱등 키를 다른 body로 재사용 | `409 IDEMPOTENCY_CONFLICT`; 두 번째 요청 미실행 |
| UP-07 | 프로젝트 생성 후 반환된 `task_id` 조회 | 소유자에게 `GET /tasks/{task_id}`가 `waiting_plan_approval` 반환; 다른 소유자는 `404` |
| UP-08 | 세션에 여러 파일 선언 | `422 VALIDATION_ERROR`; 각 파일을 별도 session으로 전송 |
| UP-09 | part 2 이상 요청 | `409 INVALID_STATE_TRANSITION`; 승인 전 단일 part 제한 |
| UP-10 | 실제 signature와 선언 MIME 또는 파일 확장자가 다름 | `415 UNSUPPORTED_MEDIA_TYPE`; 파일 저장·import 없음 |
| UP-11 | PNG CRC, JPEG marker segment, WebP RIFF length, MP4 box 경계가 손상됨 | `422 VALIDATION_ERROR`; media import 없음 |
| UP-12 | 같은 소유자·manifest로 upload complete 재시도 | 기존 `import_id`, `media_id`, `proposal_id`; 새 media/proposal 0건 |
| UP-13 | 같은 미디어/설정으로 새 project idempotency key 사용 | 기존 `project_id`와 `task_id`; 추가 project/task 0건 |
| UP-14 | 다른 소유자가 `GET /content/projects/{project_id}` | `404 RESOURCE_NOT_FOUND`; 프로젝트 필드 0개 노출 |
| UP-15 | `.env`, data, 개인 사진/영상, 로컬 백업 추적 여부 | `.env`/data ignored 및 untracked; tracked sensitive media/key 0개 |
| RENDER-01 | 프로젝트 길이 3초 또는 59초로 생성 | `201`; 기본 길이는 30초 |
| RENDER-02 | 프로젝트 길이를 2초, 60초 또는 비정수로 요청 | `422 VALIDATION_ERROR`; 프로젝트 미생성 |
| RENDER-03 | fit_pad로 세로 출력 | 원본 전체 보존, 1080×1920 / 30fps / H.264 / AAC MP4 |
| RENDER-04 | fill_crop와 초점 좌표 제공 | 0~1 범위 좌표를 crop focal point로 적용; 범위 초과는 `422` |
| RENDER-05 | ffprobe 누락·형식·해상도·길이·코덱·fps 불일치 | 렌더는 실패 처리되며 미검증 파일을 ready로 노출하지 않음 |
| RENDER-06 | plan 또는 draft 중간 승인 없이 render 요청 | `409 INVALID_STATE_TRANSITION`; 렌더러 호출 0회 |
| RENDER-07 | plan 승인 후 draft 승인 없이 render 요청 | `409 INVALID_STATE_TRANSITION`; plan 승인만으로 렌더 불가 |
| RENDER-08 | 게시/일기 final scope를 plan/draft에 사용 | `409 APPROVAL_SCOPE_MISMATCH`; 단계 변경 없음 |
| RENDER-09 | 타인 project/task/job/preview 접근 | `404 RESOURCE_NOT_FOUND`; 파일 bytes 0개 노출 |
| RENDER-10 | render 같은 key 또는 다른 key로 중복 요청 | 진행/완료 job ID 재사용; 두 번째 renderer 호출 0회 |
| RENDER-11 | test renderer 완료 | Job `simulated`, `artifact_verified=false`; 테스트 전용 미리보기이며 실제 MP4 아님 |
| RENDER-12 | FFmpeg 오류·ffprobe 실패 | Job `failed`와 안전한 오류 코드; preview 없음; 내부 경로/stderr 미노출 |
| RENDER-13 | 실행 중 cancel | owner만 취소 가능; Job `cancelled`; 결과 preview 제공 안 함 |
| RENDER-14 | 업로드 완료 후 저장된 media bytes가 바뀜 | 렌더 renderer 호출 0회; Job `failed`/`VERSION_CONFLICT`; preview 없음 |
| HASH-01 | 업로드 파일 바이트가 선언 SHA-256과 다름 | `409 VERSION_CONFLICT`; 임시 파일 정리, media는 사용 가능 상태가 되지 않음 |
| HASH-02 | 컷 순서·자막·음악/license 참조·render 설정 수정 | 새 `content_version`, 새 `content_hash`; 해당 task의 과거 모든 approval은 `invalidated` |
| HASH-03 | 수정 후 예전 편집으로 되돌림 | 과거 approval 재활성화 없음; 현재 버전 재승인 필요 |
| HASH-04 | 자막/렌더 결과 artifact 바이트가 승인 후 변경 | `artifact_sha256` 불일치로 `409 STALE_APPROVAL`; publish 호출 0회 |
| HASH-05 | 플랫폼·계정·공개범위·문구 변경 | `final_publish` 승인/해당 rights 판정 무효; 재검사·재승인 전 게시 불가 |

## 공통 PrivacyGate와 동의

| ID | 상황 | 기대 결과 |
|---|---|---|
| PRIV-01 | consent 없이 외부 LLM 요청 | Gateway dispatch 거부; Creator plan은 local fallback; egress counter 0 |
| PRIV-02 | consent 없이 외부 STT 요청 | 외부 STT dispatch 거부; egress counter 0; 원본 음성 잔존 없음 |
| PRIV-03 | 동의 없는 vision/분석 요청 | local fallback; image/media egress counter 0 |
| PRIV-04 | STT 동의로 vision 요청 | 범위 불일치 dispatch 거부; egress counter 0 |
| PRIV-05 | consent provider가 서버 allowlist에 없음 | consent 생성 `422 VALIDATION_ERROR`; 이후 egress 0 |
| PRIV-06 | consent 명시 확인/고지 ID 누락 또는 notice version 불일치 | `422 VALIDATION_ERROR` 또는 정책 거부; 활성 consent 생성 없음 |
| PRIV-07 | consent 철회 후 대기 작업 dispatch | 작업 취소/차단; 실제 전송 직전 검사에서 egress counter 0 |
| PRIV-08 | 동의가 만료된 뒤 재요청 | local fallback; 매 시도 egress 0 |
| PRIV-09 | 오류/timeout 이후 요청 전에 consent 철회 | 재요청은 local fallback; 추가 egress 0 |
| PRIV-10 | 사용자 프롬프트나 media metadata가 외부 전송을 지시 | 권한 승격 안 됨; PrivacyGate가 동일 판정 |
| PRIV-11 | 게시 승인 또는 중간 승인 ID를 external consent ID 대신 제출 | consent lookup/scope 실패; local fallback; egress 0 |
| PRIV-12 | notice 미리보기·버전 확인 뒤 범위 일치 consent 생성 | `201`; consent 기록만으로 provider 호출 0 |
| PRIV-13 | 다른 소유자의 consent ID 또는 미디어 resource ID | PrivacyGate 거부; provider 호출 0 |
| PRIV-14 | Creator 요청에 consent 없이 OpenAI adapter가 설정됨 | Gateway fallback; OpenAI fetch 0 |
| PRIV-15 | consent 철회 후 같은 task 재시도 | `CONSENT_REQUIRED` fallback; 추가 OpenAI fetch 0 |
| PRIV-16 | 로컬 이미지 축소/영상 프레임 추출 실패 | 준비된 visual input 없음; OpenAI 호출 0; 규칙 fallback |
| PRIV-17 | 처리 notice와 다른 data category/purpose | consent 거부; provider 호출 0 |

## 승인 상태와 허용 조합

| ID | 상황 | 기대 결과 |
|---|---|---|
| APR-01 | plan/draft/preview checkpoint + `continue` | 승인 기록 생성; 다음 단계만 진행; 게시·저장·외부전송 권한은 없음 |
| APR-02 | publication별 final approval + 최신 version/hash/artifact hash/publication revision/hash | 특정 플랫폼에 한정된 최종 승인 생성; 게시 API 호출 없음 |
| APR-03 | final_diary checkpoint + `final_diary` + 현재 draft version/hash | 일기 최종 승인 기록 생성 |
| APR-04 | plan/draft/preview와 final scope 조합 또는 final checkpoint에 continue | `409 APPROVAL_SCOPE_MISMATCH`; 승인/상태 변화 없음 |
| APR-05 | STT 전사문을 사용자 확인 없이 명령으로 전달 | transcript는 승인 증거가 아님; 최종 action 불가 |
| APR-06 | `continue` scope approval으로 `/publishes` 호출 | `409 APPROVAL_SCOPE_MISMATCH`; platform 호출 0회 |
| APR-07 | final_publish approval을 diary finalize에 사용 | `409 APPROVAL_SCOPE_MISMATCH`; 정식 일기 저장 0건 |
| APR-08 | final_diary approval을 publish에 사용 | `409 APPROVAL_SCOPE_MISMATCH`; platform 호출 0회 |
| APR-09 | consent ID를 approval ID로 사용하거나 approval ID를 consent ID로 사용 | 해당 scope 조회 실패; 외부 호출·저장·게시 0회 |
| APR-10 | 이전 버전 승인 또는 invalidated/consumed approval 재사용 | `409 STALE_APPROVAL`; side effect 0회 |
| APR-11 | 승인 후 version/artifact/target 변경 | 해당 approval은 `invalidated`; 새 승인 전 최종 action 불가 |

## 권리·게시 멱등성·outbox·재조정

| ID | 상황 | 기대 결과 |
|---|---|---|
| PUB-01 | 권리 `REVIEW`인 게시 요청 | `403 RIGHTS_REVIEW_REQUIRED`; platform 호출 0회 |
| PUB-02 | 권리 `BLOCK`인 게시 요청 | `403 RIGHTS_BLOCKED`; platform 호출 0회 |
| PUB-03 | `final_publish` approval ID가 없음 | `403 FORBIDDEN`; publish job/outbox/platform 호출 없음 |
| PUB-03A | `final_publish` 대신 중간 approval ID 제출 | `409 APPROVAL_SCOPE_MISMATCH`; publish job/outbox/platform 호출 없음 |
| PUB-04 | 승인 당시 account/visibility/caption과 요청 본문 불일치 | `409 APPROVAL_SCOPE_MISMATCH`; platform 호출 0회 |
| PUB-05 | 모든 권한·rights=`ALLOW`·hash·계정 조건 일치 | 멱등 기록과 durable outbox 생성 후 `202`; 외부 게시는 승인된 adapter 경유 |
| PUB-06 | 같은 key와 같은 요청 재전송 | `200`으로 동일 `publish_id` 반환; 두 번째 outbox/platform 업로드 없음 |
| PUB-07 | 같은 key에 다른 요청 fingerprint | `409 IDEMPOTENCY_CONFLICT`; 기존 기록 불변, 새 업로드 없음 |
| PUB-08 | 다른 key로 같은 approval 재사용 | `409 PUBLISH_ALREADY_EXISTS`; 두 번째 publish job/outbox 없음 |
| PUB-09 | outbox 생성 전 DB 트랜잭션 실패 | `503 SERVICE_UNAVAILABLE`; 플랫폼 요청 0회 |
| PUB-10 | outbox 저장 후 플랫폼에 요청하기 전 네트워크 단절 | 작업은 안전하게 재개 가능; approval/hash/rights/privacy 조건 dispatch 직전 재검사 |
| PUB-11 | **플랫폼 업로드 성공 직후 응답 유실/네트워크 단절** | 작업은 `outcome_unknown`; 자동 재업로드 0회; 동일 `publish_id` 유지 |
| PUB-12 | `outcome_unknown`에서 공식 API가 기존 게시 성공을 찾음 | `reconciling → succeeded`; 원래 `publish_id`에 platform ID/URL 연결; 새 게시 0회 |
| PUB-13 | 공식 API 조회가 기존 실패를 확정 | 원래 job만 `failed`; 재게시 여부는 신규 사용자 승인/정책 판단 전 자동 진행 안 함 |
| PUB-14 | 공식 API 조회 불가 또는 복수 결과 | `needs_user_action`; 자동 재업로드 0회; 사용자가 확인할 안내 제공 |
| PUB-15 | mock publisher 성공 | `mode=mock`; 실제 플랫폼 게시 성공/URL로 표시하지 않음 |

## Capability Registry·호환성

| ID | 상황 | 기대 결과 |
|---|---|---|
| CAP-01 | 등록·활성된 기존 4개 Agent capability 요청 | 선언된 `input_schema_version`과 scope로 처리 |
| CAP-02 | Blog/Music 또는 새 module ID가 Registry에 없음 | `404 CAPABILITY_NOT_FOUND`; 암묵적 활성화 없음 |
| CAP-03 | Registry에는 있으나 disabled/planned 상태 | `403 CAPABILITY_DISABLED`; task/job 생성 없음 |
| CAP-04 | 기존 Agent에 새 모듈이 추가됨 | 기존 module/capability ID와 schema 의미 유지; 새 모듈만 별도 schema 버전 사용 |
| CAP-05 | 모듈이 선언하지 않은 data scope/tool 요청 | `403 FORBIDDEN`; 자료 조회·외부 호출 0회 |

## 오류/HTTP 일관성

| ID | 상황 | 기대 결과 |
|---|---|---|
| ERR-01 | 버전이 낡은 수정·렌더 요청 | `409 VERSION_CONFLICT`; 상태/파일 변경 없음 |
| ERR-02 | 현재 version/hash는 맞지만 승인 scope가 잘못됨 | `409 APPROVAL_SCOPE_MISMATCH` |
| ERR-03 | 인증 누락·만료 | `401 AUTHENTICATION_REQUIRED` |
| ERR-04 | 리소스 미존재 또는 타 사용자 소유 | `404 RESOURCE_NOT_FOUND` |
| ERR-05 | 각 실패 응답·안전 로그 검사 | 개인 원문, token, 내부 파일 경로 미포함; 공통 error envelope 준수 |

## 정식 테스트를 시작하기 전 승인 항목

- HTTP와 error code 최종 매핑, `outcome_unknown`에서 지원할 각 플랫폼의 official lookup 방식.
- idempotency key와 approval-bound 중복 정책의 범위 및 보존 기간.
- manifest/hash canonicalization, 콘텐츠 버전 증가 및 승인 무효화 경계.
- consent UI·notice evidence, 철회와 이미 진행 중인 외부 작업의 처리 정책.
- capability registry schema version 호환 및 신규 모듈 승인 절차.

이 문서는 테스트 구현 또는 테스트 통과를 주장하지 않습니다. 정식 OpenAPI validator와 승인된 계약을 준비한 후 이 시나리오를 계약·보안 테스트로 옮겨야 합니다.
