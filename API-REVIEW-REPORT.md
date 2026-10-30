# 해주미 `/api/v1` API 계약·보안 검토 보고서

> 기준 문서: v0.3.3  
> 검토일: 2026-10-30  
> 범위: OpenAPI 3.1 형식·문서 정합성·인증/개인정보/승인/권리/재시도/확장성  
> 변경 제한: 이 보고서만 추가했습니다. OpenAPI와 기존 문서는 수정하지 않았습니다. 실제 SNS 게시 및 개인정보 외부 전송은 수행하지 않았습니다.

## 요약 판정

**구현 착수 전 계약 보완과 정식 OpenAPI 검증이 필요합니다.** 초안에는 중요한 보안 의도가 들어 있으나, 여러 항목이 설명(description)에만 있고 기계 검증 가능한 계약으로 충분히 표현되지 않았습니다. 일부 테스트가 기대하는 오류 코드가 OpenAPI에 없고, 권리 상태 표기도 문서끼리 다릅니다. 게시 재시도 중 외부 플랫폼에서 결과를 확인하는 방법과 모듈 추가 호환성도 확정되지 않았습니다.

이 검토는 문서 검토이며, API 서버 동작·보안 테스트 통과를 의미하지 않습니다. 미확정 정책을 승인하거나 확정하지 않았습니다.

## 1. OpenAPI 3.1 검증 방법 및 실행 결과

### 현재 도구 확인

- 실행 환경에 Node.js `v24.22.0`, npm `11.19.1`이 있습니다. 전역 npm 패키지는 `pnpm`만 확인됐으며 `redocly`, `swagger-cli`, `spectral`, `openapi-spec-validator`는 실행 명령으로 확인되지 않았습니다.
- OpenAPI 3.1 검증 CLI를 찾지 못했습니다. 오프라인 `npx --package=js-yaml` 실행도 npm 캐시 조회 실패(`ENOTCACHED`)로 YAML 파서 실행까지 진행되지 않았습니다.
- 네트워크를 사용해 패키지를 설치하거나 도구를 추가하지 않았습니다.

### 수행한 제한적 정적 검사

PowerShell 기반 텍스트 검사 결과:

- 경로 28개, operation ID 30개를 발견했습니다.
- 경로와 operation ID 중복은 발견되지 않았습니다.
- `$ref` 대상은 51개로 추출했고, 대상 이름 누락 후보는 발견되지 않았습니다. 이는 텍스트 참조 확인일 뿐 YAML 파싱이나 JSON Schema/OpenAPI 검증은 아닙니다.
- 상태 변경 operation 20개와 `Idempotency-Key` parameter 참조 20개를 확인했습니다. 이 수량 일치는 각 operation의 키 적용 의미나 런타임 동작까지 증명하지 않습니다.

**정식 OpenAPI 3.1 검증은 미실행**입니다. 이 환경에서는 문법·스키마·참조 해석을 보증할 수 없습니다.

### 권장 검증 절차

개발 PC에서 네트워크/설치가 허용될 때 Redocly CLI로 lint를 실행하는 방법을 권합니다. Redocly 공식 문서는 `lint`가 OpenAPI 설명을 검사한다고 안내하며, CLI v2는 Node.js 22.12 이상을 요구합니다. 현재 확인된 Node 버전은 그 조건 이상입니다.

```powershell
npx @redocly/cli@latest lint docs/openapi-v1.yaml
```

추가로 Python 환경을 준비할 수 있다면 `openapi-spec-validator`의 OpenAPI 3.1 검증 CLI 또는 라이브러리를 CI/계약 테스트에 연결하고, lint 규칙과 OAS 검증을 모두 통과해야 합니다. 도구 설치·실행은 다른 PC의 환경 확인 후 진행합니다.

참고: [OpenAPI Specification](https://spec.openapis.org/oas/), [Redocly CLI lint](https://redocly.com/docs/cli/commands/lint), [Redocly CLI 설치](https://redocly.com/docs/cli/installation), [openapi-spec-validator](https://github.com/python-openapi/openapi-spec-validator).

## 2. 문서와 YAML 간 불일치

| 심각도 | 위치 | 발견 내용 | 권장 조치 |
|---|---|---|---|
| 중간 | `docs/09-API-CONTRACT.md` 경로 목록 | `/voice/transcriptions`가 표에 두 번 들어 있습니다. | 중복 행을 제거할 때 문서 수정 승인을 받은 뒤 한 항목만 남깁니다. |
| 높음 | `docs/09-API-CONTRACT.md` 권리 표기 ↔ YAML/테스트 | 문서 표는 `ALLOW/REVIEW/BLOCK` 대문자, YAML `RightsDecision`과 테스트는 `allow/review/block` 소문자입니다. | wire enum을 한 표기로 합의하고 설명·예제·테스트 기대값을 함께 정렬합니다. |
| 높음 | 오류 코드 | 테스트 시나리오는 `CONSENT_REQUIRED`, `IDEMPOTENCY_CONFLICT`, `APPROVAL_SCOPE_MISMATCH`, `STALE_APPROVAL`을 기대합니다. YAML의 `ApiError.code`는 임의 문자열이며 표준 오류 코드 목록이 없습니다. `09`의 기존 오류 목록에도 이 코드 일부가 없습니다. | HTTP 상태와 오류 코드 매핑표를 만들고 OpenAPI에서 코드 enum 또는 코드별 응답으로 표현합니다. `409` 하위 원인과 `403` 정책 거부를 구분합니다. |
| 중간 | 실패 응답 기대 | 테스트 표는 몇몇 경우 `403` 또는 `409`, 또는 스키마 거부를 허용해 계약 기대가 결정적이지 않습니다. YAML은 작업별 응답 상태를 더 좁게 나열합니다. | 각 테스트에 단일 기대 상태와 코드, 상태 변화/외부 호출 여부를 기재합니다. |
| 중간 | 계정 연결 | 게시 요청은 `account_id` UUID를 요구하지만, 계정 목록·연결 상태를 조회/관리하는 API가 없습니다. `09`는 OAuth state/PKCE를 언급하나 실제 경로는 제시하지 않습니다. | 게시 API 범위에서 계정 연결 API를 설계할지, 계정 연결이 외부 선행 작업인지 결정하고 명세에 표시합니다. |
| 중간 | `API-GUIDE.md`와 OpenAPI 세부 | 설명서에는 핵심 흐름이 있지만 정확한 요청 필드/오류 코드/응답 예시는 제한적입니다. `Idempotency-Key` 충돌 규칙과 상태 코드도 승인 대기로만 설명됩니다. | 승인된 계약 이후 초보자 안내 예제를 실제 schema·오류 매핑과 동기화합니다. |

경로 이름 자체는 대부분 `/api/v1` 초안과 설명서가 일치합니다. `09`는 일반화한 `{id}`를 사용하며 YAML은 `{task_id}`, `{project_id}` 등 구체 이름을 사용합니다. 이 차이는 경로 템플릿 의미상 동등하지만 표에 두 번 있는 음성 경로는 문서상 중복입니다.

## 3. 인증·소유권·권한·개인정보 외부 전송

### 확인된 보호 장치

- OpenAPI 전역 Bearer 인증이 적용되고 `POST /auth/session`만 인증 예외입니다. 이 예외는 로그인/세션 생성 용도지만, credential 형식과 최초 등록·복구 정책은 미정입니다.
- 소유자는 인증 주체에서 결정하고 요청의 `user_id`를 신뢰하지 않는다는 원칙이 `09`에 명시돼 있습니다.
- 외부 처리 동의와 게시 승인을 분리하고, 동의 부재·철회·범위 불일치 시 전송을 차단한다는 원칙이 있습니다.
- `POST /privacy/external-processing-requests`는 활성 동의·제공자·목적·데이터 범위·리소스 소유권을 검사한 뒤 최소화된 작업만 큐에 넣는다고 설명합니다.

### 보완이 필요한 부분

| 심각도 | 발견 내용 | 권장 조치 |
|---|---|---|
| 높음 | Bearer 인증은 신원 확인만 표현합니다. 각 미디어·프로젝트·작업·체크포인트·동의·게시·일기 경로에서 소유권 검사와 권한 거부 동작은 반복 가능한 공통 규칙으로 충분히 스키마화되지 않았습니다. | 공통 보안/권한 정책을 OAS description 또는 표준 확장으로 명시하고, 모든 객체 조회·변경이 인증 subject 기반 소유권 및 capability scope를 검사한다고 선언합니다. 소유권 불일치는 정보 노출을 줄이는 일관된 응답으로 통일합니다. |
| 높음 | `POST /assistant/messages`에서 작업이 시작될 때마다 외부 호출 직전 PrivacyGate를 강제해야 한다는 불변식은 설명에 있지만, 임의 서버 코드가 별도 외부 처리 경로를 만들지 못하게 하는 경계는 API 문서만으로 보장되지 않습니다. | 모든 외부 네트워크 호출을 제한된 backend gateway로만 수행하고 매 호출 전에 동의·수신자 allowlist·목적·최소 payload·철회 상태를 재검사하도록 계약/아키텍처 요구에 둡니다. 실패 시 네트워크 호출 0회 테스트를 필수화합니다. |
| 중간 | 동의 기록에는 provider, 목적, 범주, notice version, 만료가 있으나 사용자에게 실제 고지했고 명시 확인했다는 서버 기록 필드/영수증이 없습니다. 임의 `provider_id`도 입력 가능합니다. | 허용 업체만 동의 대상으로 노출하고 동의 시점·고지 버전·범위·사용자 행위의 서버 기록을 반환하는 영수증을 정의합니다. 동의 화면 확인 방식을 승인 전 임의 확정하지 않습니다. |
| 높음 | 외부 처리 요청은 `resource_ids`를 받지만 허용 자료의 세부 최소화 결과와 dispatch 전 동의 재검증·철회 경쟁 조건을 응답/작업 모델에서 추적하지 않습니다. | 서버 감사용 비민감 증거(동의 ID, 목적, 최소화 범주, 정책 판정 시점)를 남기되 원문은 기록하지 않습니다. 실제 전송 직전 동의를 원자적으로 다시 확인하고 취소/철회 경합 시 차단합니다. |
| 중간 | Diary는 `allowed_source_ids`를 받지만 소스별 사용자 권한·기록 종류·접근 목적 검증은 operation 본문에 드러나지 않습니다. Schedule/Wellness 경로도 개별 정의되지 않고 generic task 입력에 맡겨져 있습니다. | Diary의 각 소스를 사용자 허용 목록과 날짜·목적에 제한합니다. Schedule/Wellness는 구현 범위가 승인될 때 리소스별 scope/API를 정의하고, generic `input`만으로 민감 데이터 접근을 허용하지 않습니다. |

결론: 설계 의도는 fail closed지만 **모든 민감 정보 접근/전송 지점에서 인증·소유권·scope 검증이 API 계약 수준으로 완결됐다고 판정하기 어렵습니다.** 구현 전에 공통 강제 규칙과 테스트를 보완해야 합니다.

## 4. 중간 승인·최종 승인·게시 승인·외부 전송 동의

- **중간 승인:** `approval_scope=continue`가 최종 scope와 분리되어 있고 체크포인트를 통해 다음 단계만 진행하도록 의도되어 있습니다.
- **최종 게시 승인:** `final_publish`가 별도 scope이며 `publish_target`에 플랫폼·계정·공개범위·문구를 묶는 구조입니다.
- **일기 최종 승인:** `final_diary` scope와 별도 finalize 경로가 있습니다.
- **외부 처리 동의:** 동의 리소스와 외부 처리 요청이 게시 승인 API와 별도입니다.

분리 의도는 적절하나 다음 내용은 보완해야 합니다.

1. `/tasks/{task_id}/approvals` 하나의 endpoint와 scope 값으로 모든 승인을 수용합니다. 서버가 checkpoint 종류와 scope 조합을 검증하는 허용 조합표가 없습니다. 잘못된 조합(예: plan checkpoint에 `final_publish`)을 명시적으로 거부해야 합니다.
2. `Checkpoint.status`에는 대기/승인/수정/보류/취소/무효가 있지만, `Task.status`에는 중간 승인 대기·최종 게시 승인 대기·최종 일기 승인 대기를 세부 구분하는 값이 부족합니다. 실제 `docs/23` 상태 모델과 일치하는 단일 상태표가 필요합니다.
3. 테스트에는 `continue` 승인과 게시 승인 재사용이 있으나, 외부 동의 ID를 게시 승인으로 쓰는 경우와 반대로 게시 approval을 외부 처리 동의로 재사용하는 경우가 각각 명시되지 않았습니다.

**권장:** `checkpoint.kind × approval_scope × task/module` 허용 조합표를 정의합니다. 외부 동의는 어떤 approval ID도 대체하지 못하고, 게시 승인은 어떤 consent ID도 대체하지 못한다는 부정 테스트를 추가합니다. 서버는 UI 버튼만 신뢰하지 말고 모든 최종 action에서 현재 상태와 증거를 재검증해야 합니다.

## 5. 버전·SHA-256·승인 무효화

초안은 승인·렌더·게시 요청에 버전과 64자리 SHA-256을 요구하고, 오래된 승인을 `409`로 차단하려는 점이 좋습니다. 하지만 아직 **무엇을 해시하는지** 규격이 없습니다.

- 해시가 편집 manifest, 원본 묶음, 자막/게시 문구, 렌더된 MP4 바이트 중 어느 대상을 포함하는지 불명확합니다.
- `ApprovalRequest.content_hash`는 최종 게시 승인에서 결과 MP4 해시와 동일한 값인지 정의하지 않습니다.
- 수정 API의 명세가 feedback 문장에 의존해 새 artifact/version의 생성 경계와 승인 무효화 트랜잭션을 확정하지 않습니다.
- DB 초안은 `project_versions.sha256`을 언급하지만 canonical serialization, 인코딩, manifest 순서/정규화 방식은 없습니다.

**권장:** 결과 artifact와 승인 대상 메타데이터를 분리해 해시 범위를 정의하고, manifest canonicalization·알고리즘·버전 증가 원자성·승인 무효화 범위를 결정합니다. 어떤 입력이 바뀌면 어떤 approval을 무효화하는지 상태 전이 표와 테스트로 고정합니다. 현재 초안의 SHA-256 필드만으로 무효화 동작이 증명되지는 않습니다.

## 6. 게시 중복·재시도·네트워크 오류

초안은 게시 POST에 `Idempotency-Key`를 필수로 하고 동일한 요청 재시도에서 중복 게시를 막으려 합니다. 그러나 외부 게시 API와 로컬 DB 사이의 타임아웃 상황을 해결할 규칙이 없습니다.

- 키의 고유 범위(사용자·operation·플랫폼·계정), 보존 기간, 같은 키/다른 본문 처리 방식이 미정입니다.
- 같은 프로젝트·플랫폼·버전의 새 멱등 키 요청을 어떻게 차단하는지 OpenAPI에 명시되지 않았습니다.
- 서버가 외부 플랫폼 업로드를 성공시킨 뒤 응답을 받기 전에 연결이 끊기면, 재시도 전에 외부 상태를 어떻게 조회해 기존 결과를 회수하는지 정의되어 있지 않습니다.
- `PublishJob`은 `queued/uploading/succeeded/failed/blocked`만 있어 `outcome_unknown`/reconciliation 상태나 안전한 수동 확인 절차가 없습니다.
- 같은 멱등 요청의 재응답이 원래 `202`인지 기존 작업 `200/202`인지도 미정입니다.

**권장:** 승인 전 적어도 다음 동작을 계약에 반영합니다.

1. 사용자+operation+플랫폼+계정 기준 멱등 레코드와 요청 본문 hash를 원자적으로 생성합니다.
2. durable outbox/job을 통해 외부 호출 전후 상태를 기록합니다.
3. 외부 성공 여부가 불명확한 timeout은 자동 재게시하지 않고 `outcome_unknown`으로 두며, 공식 API 조회/재조정 후 같은 publish ID로 종료합니다.
4. 같은 키·같은 body는 같은 publish ID를 반환하고, 같은 키·다른 body는 명시 오류로 거부합니다.
5. 플랫폼이 조회 가능한 외부 operation ID/업로드 ID와 멱등 기능을 제공하지 않으면 자동 재시도를 제한하고 사용자 확인을 요구합니다.

따라서 현재 초안만으로 **네트워크 오류에도 중복 공개 게시가 방지된다고 보장할 수 없습니다.**

## 7. Blog·Music 확장 호환성

`TaskCreateRequest.module_id`와 `Capability.module_id`가 `[creator, schedule, wellness, diary, blog, music]`의 closed enum입니다. 향후 새 모듈을 추가하면 기존 생성 클라이언트의 enum validation이 실패할 수 있습니다. 반면 작업 입력 `input`은 임의 객체라 모듈별 검증·권한 경계가 약합니다.

**권장:** `module_id`는 안정적인 string 식별자로 두고 `/capabilities`가 활성 capability와 schema version을 제공하게 하며, 알 수 없거나 비활성인 capability는 서버가 명시적으로 거부합니다. 요청에는 `capability`와 `input_schema_version`을 포함하고, 모듈별 schema/permissions/tool allowlist를 Registry가 검증하게 합니다. 새 모듈 추가가 기존 네 Agent의 enum과 클라이언트 배포를 깨뜨리지 않는 호환성 원칙을 테스트로 고정합니다. Blog/Music 활성화나 기능 범위는 이 제안으로 승인된 것이 아닙니다.

## 8. 우선순위별 권고

| 심각도 | 이슈 | 구현 전 권고 |
|---|---|---|
| **P0 차단** | OAS 3.1 정식 파싱·검증 미실행 | 네트워크 가능한 승인 환경에서 공식 lint/validator 실행, 모든 오류 해결 후 계약 승인 요청 |
| **P0 차단** | 게시 timeout/중복 재시도의 외부 상태 조정 미정 | idempotency persistence, outbox, unknown outcome, reconciliation 계약 결정 |
| **P1 높음** | 소유권·scope 및 외부 egress 게이트가 일부 설명 수준 | 공통 보안 정책과 resource-specific authorization 테스트를 계약에 명시 |
| **P1 높음** | approval scope/checkpoint 조합과 `Task.status` 세부 상태 불일치 | 단일 상태 전이 및 허용 조합표 확정 |
| **P1 높음** | SHA-256 대상 및 수정 후 승인 무효화 범위 불명확 | canonical hash와 invalidation 규칙 확정 |
| **P1 높음** | 오류 코드·권리 enum의 문서 간 불일치 | 코드/HTTP 상태/권리 enum 단일 표준화 |
| **P1 높음** | Blog/Music closed enum으로 확장성 저해 가능 | Registry 기반 열린 식별자와 schema versioning 제안 검토 |
| **P2 보통** | consent 증거와 provider allowlist 정의 부족 | explicit confirmation record와 허용 provider 정책 결정 |
| **P2 보통** | 계정 연결 API와 사용자 문서 경로 중복 | publish 선행조건과 문서 표를 계약에 맞게 정리 |

## 9. 권장 다음 순서

1. 위 P0/P1 항목의 변경 제안과 영향 테스트를 검토합니다.
2. 정책 선택이 필요한 항목(인증 등록, 멱등 보존/외부 조회, consent UX, 해시 정의, capability 버전)은 사용자 승인 전까지 제안으로 유지합니다.
3. 승인된 계약으로 OpenAPI 3.1 validator와 API contract tests를 준비합니다.
4. 검증 결과를 근거로 API 계약을 확정한 다음 기능 구현을 별도로 승인받습니다.

이 보고서는 검토 결과만 제시합니다. `openapi-v1.yaml`, `09-API-CONTRACT.md`, 안내서, 테스트 시나리오, 소스 코드 및 외부 시스템 상태는 변경하지 않았습니다.
