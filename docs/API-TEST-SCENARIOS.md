# `/api/v1` API 계약·보안 테스트 시나리오

> 상태: OpenAPI v0.5의 수용 기준 제안 **[승인 대기]**. 테스트 코드/실행 결과가 아닙니다.  
> 계약 원본: [`openapi-v1.yaml`](openapi-v1.yaml) · 정책: [`09-API-CONTRACT.md`](09-API-CONTRACT.md) · 설명: [`API-GUIDE.md`](API-GUIDE.md)

모든 테스트는 가짜 미디어·계정과 mock 외부 서비스로 시작합니다. 실제 SNS 게시나 개인정보 외부 전송은 하지 않습니다. 모든 행의 응답은 `error.code`와 HTTP를 함께 검증하고, 상태 변경 및 외부 HTTP 호출 수를 확인합니다.

## 인증·소유권·Agent scope

| ID | 상황 | 기대 결과 |
|---|---|---|
| AUTH-01 | `/auth/session` 외 보호 경로에 토큰 없이 호출 | `401 AUTHENTICATION_REQUIRED`; 리소스/작업 변화 없음 |
| AUTH-02 | 사용자 A가 사용자 B의 media/project/task/checkpoint/consent/approval/publish/draft ID 참조 | `404 RESOURCE_NOT_FOUND`; 데이터 유출·변경 없음 |
| AUTH-03 | request body에 위조 `user_id` 포함 | 소유권은 인증 주체로만 계산; 위조 ID 무시 또는 `422 VALIDATION_ERROR` |
| AUTH-04 | Creator가 Diary/Wellness scope를 요청 | `403 FORBIDDEN`; 민감 데이터 조회 0회 |
| AUTH-05 | Diary가 요청 날짜 외 source 또는 허용되지 않은 source ID 참조 | `404 RESOURCE_NOT_FOUND`; 원문 접근 0회 |

## 선택 미디어 업로드·버전

| ID | 상황 | 기대 결과 |
|---|---|---|
| UP-01 | 선택한 미디어를 업로드하고 manifest 완료 | 실제 MIME/크기/각 파일 SHA-256/manifest 일치; 업로드 완료 제안은 user+manifest당 최대 1회 |
| UP-02 | path traversal, 미등록 파일 경로 또는 비선택 미디어를 참조 | `422 VALIDATION_ERROR` 또는 `404 RESOURCE_NOT_FOUND`; 서버 파일 탐색/비선택 파일 읽기 0회 |
| UP-03 | 선언은 JPEG지만 실제 파일이 금지 형식 | `415 UNSUPPORTED_MEDIA_TYPE`; 격리 및 downstream 사용 금지 |
| UP-04 | 크기 제한 초과 | `413 PAYLOAD_TOO_LARGE`; 완료 상태/프로젝트 연결 없음 |
| UP-05 | 같은 조각·같은 멱등 키·같은 body 재전송 | 기존 결과 반환; 중복 저장 0회 |
| UP-06 | 같은 멱등 키를 다른 body로 재사용 | `409 IDEMPOTENCY_CONFLICT`; 두 번째 요청 미실행 |
| HASH-01 | 업로드 파일 바이트가 선언 SHA-256과 다름 | `422 VALIDATION_ERROR`; 파일은 사용 가능 상태가 되지 않음 |
| HASH-02 | 컷 순서·자막·음악/license 참조·render 설정 수정 | 새 `content_version`, 새 `content_hash`; 해당 task의 과거 모든 approval은 `invalidated` |
| HASH-03 | 수정 후 예전 편집으로 되돌림 | 과거 approval 재활성화 없음; 현재 버전 재승인 필요 |
| HASH-04 | 자막/렌더 결과 artifact 바이트가 승인 후 변경 | `artifact_sha256` 불일치로 `409 STALE_APPROVAL`; publish 호출 0회 |
| HASH-05 | 플랫폼·계정·공개범위·문구 변경 | `final_publish` 승인/해당 rights 판정 무효; 재검사·재승인 전 게시 불가 |

## 공통 PrivacyGate와 동의

| ID | 상황 | 기대 결과 |
|---|---|---|
| PRIV-01 | consent 없이 외부 LLM 요청 | `403 CONSENT_REQUIRED`; egress counter 0 |
| PRIV-02 | consent 없이 외부 STT 요청 | `403 CONSENT_REQUIRED`; egress counter 0; 원본 음성 잔존 없음 |
| PRIV-03 | 동의 없는 vision/분석 요청 | `403 CONSENT_REQUIRED`; image/media egress counter 0 |
| PRIV-04 | STT 동의로 vision 요청 | `403 PRIVACY_POLICY_DENIED`; egress counter 0 |
| PRIV-05 | consent provider가 서버 allowlist에 없음 | consent 생성 거부 `403 PRIVACY_POLICY_DENIED`; 이후 요청 egress 0 |
| PRIV-06 | consent 명시 확인/고지 ID 누락 또는 notice version 불일치 | `422 VALIDATION_ERROR` 또는 정책 거부; 활성 consent 생성 없음 |
| PRIV-07 | consent 철회 후 대기 작업 dispatch | 작업 취소/차단; 실제 전송 직전 검사에서 egress counter 0 |
| PRIV-08 | 동의가 만료된 뒤 재시도/백그라운드 재실행 | `403 CONSENT_REQUIRED`; 매 시도 egress 0 |
| PRIV-09 | 오류/timeout 이후 외부 처리 재시도 시 consent가 철회됨 | 재시도 차단; 추가 egress 0 |
| PRIV-10 | 사용자 프롬프트나 media metadata가 외부 전송을 지시 | 권한 승격 안 됨; PrivacyGate가 동일 판정 |
| PRIV-11 | 게시 승인 또는 중간 승인 ID를 외부 처리 동의로 제출 | `403 CONSENT_REQUIRED`/`403 PRIVACY_POLICY_DENIED`; egress 0 |

## 승인 상태와 허용 조합

| ID | 상황 | 기대 결과 |
|---|---|---|
| APR-01 | plan/draft/preview checkpoint + `continue` | 승인 기록 생성; 다음 단계만 진행; 게시·저장·외부전송 권한은 없음 |
| APR-02 | final_publish checkpoint + `final_publish` + 최신 version/hash/artifact hash/target | 최종 게시 승인 기록 생성 |
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
