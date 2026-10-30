# 해주미 AI — 개발 문서 정렬 패키지 v0.3.1

이 패키지는 **실행 가능한 애플리케이션이 아닌 문서 정렬본**입니다. 개발 환경·코드·테스트는 확인/수행하지 않았습니다.

1. `AGENTS.md`
2. `docs/CODEX_HANDOFF_HAEJUMI.md` 및 `docs/DECISIONS.md`
3. `docs/RECONCILIATION-REPORT.md`
4. `DEVELOPMENT-PLAN.md` → `DEVELOPMENT-GUIDE.md` → `IMP-PLAN.md` → `TASKS.md`
5. 필요한 `docs/01~26` 상세 문서 및 루트 통합 문서

Git에 반영하기 전에 사용자가 문서 변경 및 API 제안을 검토해야 합니다. 역사적 원본은 `archive/v0.3-original/`에 보존했습니다.

## 확장형 설계(v0.3.2)
현재는 Creator·Schedule·Wellness·Diary 4개 Agent를 유지하고, 블로그와 AI 음악 제작 등은 추후 모듈 또는 Agent로 확장합니다. 설계 기준은 `docs/26-EXTENSIBILITY.md`를 참조합니다.
