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
- 현재 참조 업로드 어댑터와 YAML 스키마는 한 세션에 선택 파일 1개, 단일 part로 정렬했습니다. 여러 선택 파일은 별도 세션을 사용합니다. 다중 항목·재개 업로드 계약은 승인 대기입니다.
- manifest canonicalization은 한 파일 배열에 대한 임시 규칙으로 문서화했지만 승인 대기입니다. 다중 파일 정렬·정규화는 정하지 않았습니다.
- `ContentProject.task_id`는 최소 task polling에 필요한 추가 제안이며 승인 대기입니다. 완료 요청은 import를 반환하고 프로젝트/task 생성은 별도 프로젝트 API에서 수행하며, 동일 미디어/설정은 의미적 중복 키로 deduplicate합니다.
- 실제 파일 확인은 지원 형식 signature 및 컨테이너 구조를 검사합니다. 로컬 FFmpeg/ffprobe 등 decoder가 없어 전체 codec decoding은 미검증입니다.
- Creator 렌더 API의 상세 계약은 승인 대기 상태입니다. API 실행 흐름은 참조 어댑터에 구현했고 OpenAPI 3.1 정식 validator 검사는 미실행입니다. 현재 PC PATH에 FFmpeg/ffprobe가 없어 실영상 렌더·실제 ffprobe 검증도 실행하지 못했습니다.
- 테스트 서버의 정적 Bearer 토큰과 파일 저장소는 교체용 개발 adapter입니다. 최종 인증, DB, 배포·TLS 선택을 확정하지 않습니다.
