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

동의가 없거나, 철회·만료됐거나, 전송 범위가 동의와 다르거나 검사를 완료할 수 없으면 서버는 `403 CONSENT_REQUIRED` 또는 `403 PRIVACY_POLICY_DENIED`로 막고 외부 요청을 **0회** 발생시켜야 합니다. 재시도와 백그라운드 작업에도 같은 규칙이 적용됩니다. 사용자의 문장, STT 전사문, 중간 승인 또는 게시 승인은 외부 전송 동의가 아닙니다.

## Creator 사진·영상 제작 흐름

1. **선택 파일 업로드:** 앱은 사용자가 Photo Picker에서 직접 고른 파일만 업로드 세션에 선언합니다. 서버는 실제 파일 유형·크기·SHA-256을 검사합니다. 업로드가 게시 권한을 만들지는 않습니다.
2. **프로젝트와 작업:** 프로젝트는 원본 미디어와 편집 결과를 묶습니다. 최소 참조 흐름에서는 프로젝트 생성 시 초기 `created` Creator 작업도 만들고 응답 `task_id`를 돌려줍니다. 이 응답 확장은 계약 승인 대기입니다.
3. **기획·중간 확인:** `plan` 체크포인트는 `continue` 승인만 받을 수 있습니다. 이 승인은 다음 단계만 허용합니다.
4. **렌더·미리보기:** 현재 버전과 hash로 렌더를 요청합니다. 렌더 완료는 게시 승인이 아닙니다.
5. **권리 확인:** 권리 상태는 대문자 `ALLOW`, `REVIEW`, `BLOCK` 중 하나입니다. `ALLOW`만 게시 후보이며, 서버는 게시 직전 다시 검사합니다.
6. **최종 게시 승인:** 정확한 콘텐츠 버전/hash, 렌더 파일 hash, 플랫폼, 계정, 공개범위, 문구를 한 승인에 묶습니다.
7. **게시 요청:** 서버가 현재 결과·승인·권리·계정 권한·멱등 기록을 재검사합니다. 불명확한 조건은 차단합니다.

## 승인 종류는 서로 바꿔 쓸 수 없습니다

| checkpoint 종류 | 허용 scope | 뜻 |
|---|---|---|
| `plan`, `draft`, `preview` | `continue` | 확인한 단계에서 다음 단계로 진행 |
| `final_publish` | `final_publish` | 특정 영상 버전과 게시 대상을 최종 승인 |
| `final_diary` | `final_diary` | 특정 일기 버전을 정식 저장하도록 최종 승인 |
| 그 밖의 조합 | 없음 | 서버가 `409 APPROVAL_SCOPE_MISMATCH`로 거부 |

외부 전송 동의는 `consent_id`와 `active/revoked/expired` 상태로 별도 관리합니다. 중간 승인은 게시나 일기 저장을 허용하지 않고, 게시 승인도 외부 AI 전송이나 일기 저장을 허용하지 않습니다. 음성 명령은 사용자가 승인 화면에서 확인하는 절차를 대신할 수 없습니다.

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
