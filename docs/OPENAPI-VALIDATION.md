# OpenAPI 검증 기록

> 대상: `docs/openapi-v1.yaml` · 초안 버전: 0.5.0-draft · 상태: **정식 OpenAPI 3.1 미검증**
> 기록일: 2026-10-30

## 실행 결과

| 점검 | 결과 | 근거 |
|---|---|---|
| OpenAPI 3.1 전용 lint/schema validator | 미실행 | 로컬에서 `@redocly/cli`, `swagger-cli`, `@apidevtools/swagger-parser`, `openapi-schema-validator`를 찾지 못함 |
| 오프라인 Redocly 실행 시도 | 불가 | `npx --offline --yes @redocly/cli lint docs/openapi-v1.yaml`가 캐시에 패키지가 없어 `ENOTCACHED`로 종료 |
| YAML parser 실행 | 미실행 | Python/py 실행 환경이 설치되어 있지 않음. npm에 캐시된 parser만으로는 정식 OpenAPI 스키마 검증을 대체하지 않음 |
| 외부 설치·네트워크 접근 | 수행하지 않음 | 개발 PC 환경 최적화 및 도구 설치를 요청하지 않음 |

따라서 YAML 문법이나 OpenAPI 3.1 구조가 통과했다고 주장하지 않습니다. 검증 상태는 `openapi-v1.yaml`의 `info.x-validation-status`에도 `unverified-no-local-openapi-validator`로 표시했습니다. 정식 검증은 별도 승인된 개발 환경에서 validator를 사용할 수 있을 때 실행해야 합니다.

## 구현과 계약의 대기 항목

- 프로젝트 생성 응답의 `task_id`는 상태 조회를 연결하기 위한 추가 제안이며 계약 승인 대기입니다.
- 현재 참조 업로드 어댑터는 한 세션에 선택 파일 1개, 단일 part만 수용합니다. OpenAPI의 다중 항목·재개 업로드 계약은 아직 확정되지 않았습니다.
- manifest canonicalization은 어댑터 내부에서만 임시 규칙을 사용합니다. 이 규칙은 호환성 보장이나 승인된 wire 계약이 아닙니다.
- 테스트 서버의 정적 Bearer 토큰과 파일 저장소는 교체용 개발 adapter입니다. 최종 인증, DB, 배포·TLS 선택을 확정하지 않습니다.
