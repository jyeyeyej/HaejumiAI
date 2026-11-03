# OpenAPI 검증 기록

## 2026-11-03 다중 미디어·장면 편집 계약

`npm exec --yes --package=@redocly/cli -- redocly lint docs/openapi-v1.yaml`: 종료 코드 0, 오류 0건, 기존 경고 13건(라이선스 1건, 태그 설명 12건). 다중 업로드 세션, 순서 있는 프로젝트 manifest, 장면 편집 PUT을 반영했습니다. 계약 승인과 실제 기기 검증은 별도입니다.

## 2026-11-03 PC 웹 공통 목록 API 추가 후 재검증

`npm exec --yes --package=@redocly/cli -- redocly lint docs/openapi-v1.yaml`: 종료 코드 0, 오류 0건, 경고 13건. 인증된 소유자 프로젝트 목록과 작업 렌더 목록 경로를 추가했습니다. 경고는 기존의 라이선스 정보 1건과 태그 설명 12건이며 문법/스키마 오류는 발견되지 않았습니다. OpenAPI 전체 계약의 사용자 승인 대기 상태는 유지합니다.

> 대상: `docs/openapi-v1.yaml` · 초안 버전: 0.5.0-draft · 상태: **Redocly 검증 통과, 경고 13건**
> 최신 기록일: 2026-11-03 · 계약 자체는 **제안/승인 대기**

## 2026-11-03 검증 결과

- 자막·음원 API 추가 후 Redocly CLI 2.72.1 재검증: 종료 코드 0, 오류 0건, 기존 경고 13건. `npm test`는 실제 합성 미디어 FFmpeg 검증을 포함해 42개 통과했습니다. FFmpeg가 없는 환경에서는 해당 실제 렌더 테스트가 건너뛰어집니다.
- `npm exec --yes --package=@redocly/cli -- redocly lint docs/openapi-v1.yaml` — Redocly CLI 2.72.1, 종료 코드 0, 오류 0건, 경고 13건. 경고는 API 라이선스 정보 누락 1건과 태그 설명 누락 12건입니다. 라이선스는 임의로 지정하지 않았습니다.
- Creator 기획 경로의 중복 선언을 제거하고 구현에 맞는 `content_version`/`request_text` 요청 및 `201` 응답을 유지했습니다. 이전 초안의 `base_content_version`도 요청 기준 버전에 대한 동시성 통제를 의도했으나 이 경로의 실제 구현은 받지 않습니다. 정책상 `403` 응답 제안은 보존했으며 참조 구현에서 다른 소유자의 task는 `404`로 처리합니다.
- `npm test` — 38개 통과, 실패 0. 테스트의 외부 연동은 Mock이며 실제 OpenAI 호출 및 SNS 게시는 실행하지 않았습니다.
- Redocly 검증은 문서 구조 검사이며 실제 기능 전부의 구현·API 계약 승인·보안 검증을 뜻하지 않습니다.

## 이전 실행 결과 (2026-10-30)

| 점검 | 결과 | 근거 |
|---|---|---|
| OpenAPI 3.1 전용 lint/schema validator | 미실행 | 로컬에서 `@redocly/cli`, `swagger-cli`, `@apidevtools/swagger-parser`, `openapi-schema-validator`를 찾지 못함 |
| 오프라인 Redocly 실행 시도 | 불가 | `npx --offline --yes @redocly/cli lint docs/openapi-v1.yaml`가 캐시에 패키지가 없어 `ENOTCACHED`로 종료 |
| YAML parser 실행 | 미실행 | Python/py 실행 환경이 설치되어 있지 않음. npm에 캐시된 parser만으로는 정식 OpenAPI 스키마 검증을 대체하지 않음 |
| 외부 설치·네트워크 접근 | 수행하지 않음 | 개발 PC 환경 최적화 및 도구 설치를 요청하지 않음 |

당시에는 YAML 문법이나 OpenAPI 3.1 구조가 검증되지 않았습니다. 현재 상태는 위의 2026-11-03 결과를 따릅니다.

## 구현과 계약의 대기 항목

- 프로젝트 생성 응답의 `task_id`는 상태 조회를 연결하기 위한 추가 제안이며 계약 승인 대기입니다.
- 현재 참조 업로드 어댑터와 YAML 스키마는 한 세션에 선택 파일 1개, 단일 part로 정렬했습니다. 여러 선택 파일은 별도 세션을 사용합니다. 다중 항목·재개 업로드 계약은 승인 대기입니다.
- manifest canonicalization은 한 파일 배열에 대한 임시 규칙으로 문서화했지만 승인 대기입니다. 다중 파일 정렬·정규화는 정하지 않았습니다.
- `ContentProject.task_id`는 최소 task polling에 필요한 추가 제안이며 승인 대기입니다. 완료 요청은 import를 반환하고 프로젝트/task 생성은 별도 프로젝트 API에서 수행하며, 동일 미디어/설정은 의미적 중복 키로 deduplicate합니다.
- 실제 파일 확인은 지원 형식 signature 및 컨테이너 구조를 검사합니다. 로컬 FFmpeg/ffprobe 등 decoder가 없어 전체 codec decoding은 미검증입니다.
- Creator 렌더 API의 상세 계약은 승인 대기 상태입니다. 참조 어댑터의 실제 FFmpeg 렌더와 ffprobe 검증은 2026-11-03 합성 미디어로 확인했습니다.
- 테스트 서버의 정적 Bearer 토큰과 파일 저장소는 교체용 개발 adapter입니다. 최종 인증, DB, 배포·TLS 선택을 확정하지 않습니다.
