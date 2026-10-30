# 해주미 `/api/v1` API 초보자 안내서

> 상태: OpenAPI 3.1 계약 v0.5 **[제안/승인 대기]**  
> 사양 원본: [`openapi-v1.yaml`](openapi-v1.yaml)  
> 경로·상태·오류 기준: [`09-API-CONTRACT.md`](09-API-CONTRACT.md)

이 문서는 앱과 PC 서버 사이의 약속을 쉬운 말로 풀이합니다. 아직 사용자 승인과 정식 OpenAPI 검증 전이므로 실제 구현 계약으로 간주하지 않습니다.

## API가 하는 일

API는 Android 앱이 PC 서버에 “선택한 파일을 올려 주세요”, “이 버전으로 영상을 렌더해 주세요”, “이 게시물을 승인합니다”처럼 요청할 때 사용하는 약속입니다. 모든 경로는 `/api/v1`로 시작합니다.

## 모든 요청에 적용되는 권한 규칙

1. 로그인 토큰을 확인합니다. 토큰은 요청자의 신원만 증명합니다.
2. 서버는 요청에 적힌 `user_id`를 소유권 증거로 믿지 않습니다. 인증된 사용자를 소유자로 삼아 모든 파일·프로젝트·작업·승인 ID와 부모 관계를 검사합니다.
3. 소유권이 없거나 리소스가 없으면 같은 `404 RESOURCE_NOT_FOUND`로 답해 ID를 추측할 수 없게 합니다.
4. Agent별 허용 범위도 확인합니다. Creator는 사용자가 선택한 미디어·Creator 프로젝트만 기본 접근하고 Diary/Wellness 원문을 열람하지 않습니다. Diary는 해당 날짜에 사용자가 허용한 자료만 받습니다. 확장 모듈은 Registry에 선언된 scope만 가집니다.
5. 권리, 승인, 외부 전송 동의는 각각 별도 확인합니다. 한 종류의 승인이 다른 종류 권한을 대신하지 않습니다.

## 외부 AI 전송: 공통 PrivacyGate

외부 LLM·STT·비전·분석 서비스로 나가는 모든 요청은 API 경로나 Agent에 관계없이 Backend의 공통 PrivacyGate/LLMGateway를 거쳐야 합니다. 서버는 제공자 허용 목록, 목적, 데이터 종류, 소유권, 최소 전송 범위, 현재 동의 상태를 요청을 받을 때와 실제 네트워크 전송 직전에 확인합니다.

동의가 없거나, 철회·만료됐거나, 전송 범위가 동의와 다르거나 검사를 완료할 수 없으면 PrivacyGate가 provider dispatch를 거부해 외부 요청을 **0회** 발생시킵니다. Creator plan API는 안전한 local-rules fallback 결과를 반환하고 `generation.gate_reason`에 사유를 담습니다. 현재 동기식 plan 흐름에는 대기 중 provider job이 없습니다. 사용자의 문장, STT 전사문, 중간 승인 또는 게시 승인은 외부 전송 동의가 아닙니다.

## Creator 사진·영상 제작 흐름

프로젝트 목표 길이는 3~59초 정수이며 기본 30초입니다. 렌더 요청은 `vertical_9_16_h264_aac` 프로필과 승인된 프로젝트의 `fit_pad`(기본) 또는 `fill_crop` 초점 설정을 사용합니다. plan checkpoint와 자막·오디오 구성 초안 checkpoint에 각각 `continue` 승인이 있어야 `render_ready`가 됩니다. 테스트 렌더 결과는 `simulated`로 표시되고 MP4 미리보기로 제공되지 않습니다.

1. **선택 파일 업로드:** 앱은 사용자가 Photo Picker에서 직접 고른 파일만 업로드 세션에 선언합니다. 서버는 실제 파일 유형·크기·SHA-256을 검사합니다. 업로드가 게시 권한을 만들지는 않습니다.
2. **프로젝트와 작업:** 프로젝트는 원본 미디어와 편집 결과를 묶습니다. 참조 API는 소유자 미디어만 연결하고 응답 `task_id`와 `waiting_plan_approval` 작업, 기획 checkpoint를 만듭니다. API 초안 전체는 계약 승인 대기 상태입니다.
3. **기획·중간 확인:** `GET /tasks/{id}/checkpoints`로 `plan`을 확인하고 `POST /tasks/{id}/approvals`에 같은 버전/hash의 `continue` 승인을 제출합니다. 승인 뒤 draft checkpoint가 만들어집니다.
4. **초안 확인과 렌더:** 현재 참조 범위의 초안은 자막 없음·무음 AAC임을 명시합니다. 별도 승인 뒤 `POST /tasks/{id}/render`는 프로젝트에 연결된 소유자 미디어만 큐에 넣습니다. `GET /jobs/{id}`로 상태 조회, `POST /jobs/{id}/cancel`로 취소할 수 있습니다.
5. **인증된 미리보기:** `GET /tasks/{id}/preview?content_version=...`는 같은 소유자의 최신 버전만 제공합니다. 실제 MP4는 ffprobe 검증 성공 시에만 `video/mp4`로 반환합니다.
6. **권리 확인:** 권리 상태는 대문자 `ALLOW`, `REVIEW`, `BLOCK` 중 하나입니다. `ALLOW`만 게시 후보이며, 서버는 게시 직전 다시 검사합니다.
7. **최종 게시 승인:** 정확한 콘텐츠 버전/hash, 렌더 파일 hash, 플랫폼, 계정, 공개범위, 문구를 한 승인에 묶습니다.
8. **게시 요청:** 서버가 현재 결과·승인·권리·계정 권한·멱등 기록을 재검사합니다. 불명확한 조건은 차단합니다.

### 예투 라우팅·Creator 기획

`GET /capabilities`는 Creator·Schedule·Wellness·Diary 등록 상태와 확장용 Blog·Music 비활성 상태를 알려줍니다. `POST /assistant/messages`는 한국어 규칙 기반으로 한 Agent를 선택합니다. 요청이 여러 Agent에 걸치거나 분류되지 않으면 질문을 되돌리고, 계획 상태인 Agent는 등록됐지만 아직 기능을 실행하지 않는다고 답합니다. 기획을 만들려면 사용자 인증된 Creator `task_id`가 필요합니다.

Creator의 `POST /tasks/{task_id}/plan`은 그 프로젝트에 연결된 선택 미디어만 사용해 구조화된 쇼츠 장면 기획과 자막 초안을 만듭니다. 기획은 콘텐츠 버전/hash와 `plan` 중간 승인 checkpoint에 저장됩니다. `GET /tasks/{task_id}/plan`으로 현재 기획을 읽을 수 있습니다. 자막은 기획 승인 뒤 `GET /tasks/{task_id}/draft`에서 표시되며, 별도 `draft` 승인 전에 렌더할 수 없습니다. 기획을 수정하면 새 콘텐츠 버전이 되고 이전 승인은 모두 무효화됩니다.

외부 처리를 요청하려면 먼저 `GET /privacy/processing-notice?provider_id=openai&purpose=vision_analysis`의 제공자·목적·전송 범위·보존 고지를 사용자에게 보여 주세요. 사용자가 확인한 경우에만 그 고지 ID/버전, 목적 `vision_analysis`, `selected_media`·`user_text` 범위와 정확한 업로드 미디어 `resource_ids`를 담아 `POST /privacy/consents`를 호출합니다. 동의 저장은 그 자체로 OpenAI를 호출하지 않습니다. Creator 요청에 반환된 `consent_id`를 `POST /assistant/messages` 또는 `/tasks/{task_id}/plan`의 `privacy_consent_id`로 전달해야 하며, 동의된 resource ID와 요청 프로젝트의 미디어 ID가 정확히 일치해야 합니다. 철회는 `DELETE /privacy/consents/{consent_id}`입니다.

실제 OpenAI 처리는 다음 조건이 모두 있을 때만 가능합니다: `HAEJUMI_LLM_ENABLED=true`, `.env`의 `HAEJUMI_OPENAI_API_KEY`와 모델 설정, 유효한 소유자 동의, Gateway 예산 허용, PrivacyGate의 마지막 권한 검사. 기본값은 비활성입니다. 서버는 사진을 로컬에서 축소하고 메타데이터를 제거하며, 선택 영상은 로컬 FFmpeg에서 프레임 하나를 뽑습니다. 최대 5개의 준비된 이미지만 OpenAI Responses API 입력에 포함하고 출력은 2,500 token 상한을 적용합니다. 파일 원본이나 갤러리 전체, 일기·건강 기록은 보내지 않습니다. `store=false`도 제공자 보존에 관한 보증은 아니므로 고지에 있는 제공자 정책을 확인해야 합니다. OpenAI 출력은 schema 검증 후 Creator 기획/자막 초안으로 저장되고, 사용자 기획 승인은 계속 필요합니다.

현재 외부 호출 기본 비활성화이며 이번 테스트에서는 Mock/가짜 `fetch`만 사용합니다. 초기 한도는 설정 가능한 제안값으로 일 `$0.20`, 월 `$5`, 작업당 5회입니다. 준비 미디어당 예상비용은 보수 예약 설정값이지 청구액 보증이 아닙니다. 예산 예약은 로컬 state에 기록하고 timeout이나 애매한 결과는 자동 재호출하지 않습니다.

## 승인 종류는 서로 바꿔 쓸 수 없습니다

| checkpoint 종류 | 허용 scope | 뜻 |
|---|---|---|
| `plan`, `draft`, `preview` | `continue` | 확인한 단계에서 다음 단계로 진행 |
| `final_publish` | `final_publish` | 특정 영상 버전과 게시 대상을 최종 승인 |
| `final_diary` | `final_diary` | 특정 일기 버전을 정식 저장하도록 최종 승인 |
| 그 밖의 조합 | 없음 | 서버가 `409 APPROVAL_SCOPE_MISMATCH`로 거부 |

외부 전송 동의는 `consent_id`와 `active/revoked/expired` 상태로 별도 관리합니다. 중간 승인은 게시나 일기 저장을 허용하지 않고, 게시 승인도 외부 AI 전송이나 일기 저장을 허용하지 않습니다. 음성 명령은 사용자가 승인 화면에서 확인하는 절차를 대신할 수 없습니다.

현재 참조 서버에서는 선택한 파일 하나마다 업로드 세션 하나를 만들고 `part 1`로 파일 전체를 보냅니다. 파일명 경로문자·지원 형식과 확장자 불일치·파일 크기·서명/컨테이너 구조·SHA-256을 확인합니다. manifest의 현재 정규화 규칙은 한 항목 기준 제안이며 승인 대기입니다. 검사기는 구조 오류를 걸러내지만 이미지나 영상의 모든 코덱을 디코딩한다고 보장하지 않습니다.

완료 요청 재시도는 동일 manifest의 import/media/proposal을 반환합니다. 프로젝트 생성은 별도 요청이며, 같은 소유자·미디어 순서·설정이면 새 멱등 키를 사용해도 기존 프로젝트와 task를 반환합니다.

## 버전과 hash

- `content_version`은 편집 내용 버전입니다. source 미디어 순서·컷·자막·음악·license 참조·렌더 설정처럼 결과에 영향을 주는 변경은 새 버전과 `content_hash`를 만듭니다.
- `content_hash`는 제안상 정규화된 불변 버전 manifest의 SHA-256입니다. 정확한 canonical JSON 규칙은 승인 대기입니다.
- `artifact_sha256`은 만들어진 MP4 파일 바이트 자체의 SHA-256입니다.
- 최종 게시 승인은 콘텐츠 hash, MP4 hash 및 게시 대상 정보를 함께 묶습니다. 해시 또는 버전이 다르면 `409 STALE_APPROVAL` 또는 `409 VERSION_CONFLICT`로 거부합니다.
- 새 콘텐츠 버전은 그 작업의 과거 중간·최종 승인을 모두 무효화합니다. 과거 편집으로 되돌려도 승인은 살아나지 않습니다. 플랫폼·계정·공개범위·문구 변경은 최종 게시 승인과 권리 검사를 다시 요구합니다.

## 네트워크 오류와 중복 게시 방지

게시를 시작하기 전에 서버가 `Idempotency-Key`와 요청 fingerprint를 기록하고 durable outbox에 게시 job을 저장한다는 설계입니다. 같은 키와 같은 요청을 다시 보내면 기존 `publish_id`를 돌려줘야 합니다. 같은 키를 다른 요청에 재사용하면 `409 IDEMPOTENCY_CONFLICT`입니다.

영상이 플랫폼에 올라간 직후 연결이 끊겨 성공 여부를 모르면 작업은 `outcome_unknown`이 됩니다. 서버는 새 업로드를 자동으로 시작하지 않습니다. 공식 플랫폼 API로 기존 upload/operation ID를 조회하고 결과를 `reconciling` 절차로 맞춥니다. 성공을 찾으면 기존 `publish_id`를 성공으로 갱신하고, 실패가 명확할 때만 실패로 기록합니다. 조회할 수 없거나 결과가 여러 개면 `needs_user_action`으로 보류하고 사용자에게 확인을 요청합니다.

멱등 보존 기간, 플랫폼별 결과 조회 가능 여부, 같은 artifact의 새 승인 후 재게시 허용은 모두 제안·승인 대기입니다.

## 플랫폼별 게시 정보와 독립 승인

공통 영상에 YouTube Shorts, TikTok, Instagram Reels용 게시 정보를 각각 저장합니다. `POST /tasks/{task_id}/publications`로 플랫폼별 레코드를 만들고, 목록·단건 `GET`으로 읽으며, `PATCH`로 수정합니다. 레코드에는 계정 ID, 공개범위, 제목, 설명, 해시태그와 revision/hash가 들어갑니다. 한 작업·플랫폼당 레코드 하나만 허용하며 변경은 현재 revision을 보내야 합니다.

`POST /tasks/{task_id}/publications/{publication_id}/approvals`는 그 레코드에 한정된 별도 최종 승인을 받습니다. 현재 영상 버전/hash와 렌더 파일 SHA-256, 게시 정보 revision/hash를 묶습니다. 실제 FFmpeg 성공과 ffprobe 검증 및 미리보기 승인 전에는 `publish_ready`가 되지 않습니다. 테스트 렌더는 조건을 만족하지 않습니다. 게시 정보 수정은 해당 레코드 승인만 무효화하며, 영상 버전 변경은 연결된 모든 플랫폼 승인을 무효화해야 합니다. 중간 승인과 다른 플랫폼의 최종 승인은 재사용할 수 없습니다.

현재 기능은 게시 정보 저장과 승인 상태 관리까지만 합니다. 실제 SNS API 호출과 게시 실행은 없습니다. 공개범위의 플랫폼별 공식 API 매핑은 검증 대기입니다.

## Capability Registry와 미래 Agent

현재 MVP Agent는 Creator, Schedule, Wellness, Diary 네 개입니다. `/capabilities`는 모듈 ID, capability ID, 모듈 버전, 입력 schema 버전, 활성 상태와 scope를 알립니다. ID는 닫힌 enum이 아닌 안정된 문자열이라 Blog·Music 및 새 Agent를 추가해도 기존 enum을 바꾸지 않는 방향입니다.

문자열을 안다고 기능이 켜지지는 않습니다. 서버 Registry에 등록되어 활성화되고 입력 schema·scope 검증을 통과한 capability만 작업을 만들 수 있습니다. 미등록 기능은 `404 CAPABILITY_NOT_FOUND`, 등록됐지만 비활성인 기능은 `403 CAPABILITY_DISABLED`로 제안합니다. Blog·Music은 현재 활성 Agent가 아닙니다.

## 오류 코드를 읽는 법

모든 오류는 `{ "error": { "code": "...", "message": "..." }, "request_id": "..." }` 형태를 제안합니다.

| HTTP | 대표 코드 | 의미 |
|---|---|---|
| `401` | `AUTHENTICATION_REQUIRED` | 로그인 정보가 없거나 만료됨 |
| `403` | `CONSENT_REQUIRED`, `PRIVACY_POLICY_DENIED`, `RIGHTS_BLOCKED`, `RIGHTS_REVIEW_REQUIRED`, `FORBIDDEN` | 로그인은 됐지만 정책·동의·권리·권한이 허용하지 않음 |
| `404` | `RESOURCE_NOT_FOUND`, `CAPABILITY_NOT_FOUND` | 없거나 접근할 수 없는 리소스/기능 |
| `409` | `VERSION_CONFLICT`, `STALE_APPROVAL`, `APPROVAL_SCOPE_MISMATCH`, `IDEMPOTENCY_CONFLICT`, `PUBLISH_ALREADY_EXISTS` | 현재 버전·승인·상태 또는 중복 요청 충돌 |
| `413` / `415` | `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` | 파일 크기 또는 형식 문제 |
| `422` | `VALIDATION_ERROR`, `PLATFORM_NOT_SUPPORTED` | 요청 값이 계약/지원 범위를 벗어남 |
| `429` / `503` | `RATE_LIMITED` / `SERVICE_UNAVAILABLE` | 잠시 후 재시도하거나 서비스 상태 확인 필요 |

비동기 렌더가 실패하면 HTTP 응답 대신 job의 `safe_error_code=RENDER_FAILED`를 사용합니다. 게시 결과 불명은 오류 코드가 아니라 `outcome_unknown` 상태입니다.

## 아직 승인되지 않은 설계

초기 사용자 등록과 인증 토큰 발급, TLS/로컬 네트워크 방식, 동의 고지 UI와 철회 시점, 업로드 크기·조각·재개 규격, manifest canonicalization, 멱등 키 보존 기간, 플랫폼별 reconciliation 지원, account 연결 API, 모듈 입력 schema 호환 정책은 승인 대기입니다. API 전체 제안은 [`09-API-CONTRACT.md`](09-API-CONTRACT.md)에서 확인하실 수 있습니다.
