# 해주미 AI — Creator 우선 개발 scaffold

이 저장소에는 개발 문서와 첫 Creator 참조 백엔드가 있습니다. 참조 백엔드는 선택 미디어 업로드·완료 검증, 업로드한 미디어 기반 프로젝트 생성, 작업 상태 조회만 제공합니다. SNS 게시, 외부 개인정보 전송, LLM 호출은 연결되어 있지 않습니다.

## 로컬 테스트

이미 설치된 Node.js 표준 라이브러리만 사용합니다. 패키지 설치 없이 `npm test`로 테스트할 수 있습니다. 서버는 시작할 때 루트 `.env`의 허용된 설정을 읽습니다. 실행 방법은 `backend/README.md`와 `.env.example`을 확인해 주세요.

이 구현은 기술 선택이 승인되기 전의 교체 가능한 참조 어댑터입니다. 실제 개발 PC에서의 실행·배포 적합성은 확인되지 않았고, OpenAPI 정식 검증도 완료되지 않았습니다.

1. `AGENTS.md`
2. `docs/CODEX_HANDOFF_HAEJUMI.md` 및 `docs/DECISIONS.md`
3. `docs/RECONCILIATION-REPORT.md`
4. `DEVELOPMENT-PLAN.md` → `DEVELOPMENT-GUIDE.md` → `IMP-PLAN.md` → `TASKS.md`
5. 필요한 `docs/01~26` 상세 문서 및 루트 통합 문서

API 제안과 구현에서 계약 승인이 필요한 세부 사항은 `[제안/승인 대기]`로 표시합니다. 기존 확정 제품 요구사항을 유지합니다.

## 확장형 설계(v0.3.2)
현재는 Creator·Schedule·Wellness·Diary 4개 Agent를 유지하고, 블로그와 AI 음악 제작 등은 추후 모듈 또는 Agent로 확장합니다. 설계 기준은 `docs/26-EXTENSIBILITY.md`를 참조합니다.
