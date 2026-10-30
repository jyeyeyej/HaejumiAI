# 해주미(Haejumi) AI — 프로젝트 문서 v0.3.3

> 비서 이름 **예투** · 정중한 존댓말 · 개인용 Android 모바일 우선 · Windows PC 로컬 AI 서버 · 상업용 크리에이터 지원

## 결정된 핵심
- Android Photo Picker로 **원하는 사진·영상만 직접 선택**해 PC 프로젝트 폴더로 전송(갤러리 전체 자동 감지 제외).
- 업로드 완료 후 예투가 콘텐츠 제작을 **먼저 제안**.
- Creator Agent가 사진·영상 편집, 자막, 상업 이용 가능 음악 생성·선택, FFmpeg 렌더링을 담당.
- Diary Agent가 일정·감정·건강 기록을 사용해 하루의 일기를 작성(Work Agent 교체).
- Schedule Agent·Wellness Agent 포함 총 4개 전문 에이전트.
- 텍스트·음성 입력을 모두 지원하고, STT 결과 확인 후 전송.
- **중간중간 사용자 컨펌 → 최종 컨펌 → 일기 저장 또는 SNS 게시**. 초안은 별도 임시 보관.
- 권리 증빙·상업용 라이선스·SNS 플랫폼별 게시 API 조건은 최종 컨펌 이후에도 통과해야 함.

## 문서 목록
- `01~22`: PRD·기능·화면·아키텍처·콘텐츠·저작권·보안·테스트·구현 계획·SNS 등 기존 22개 설계 문서(v0.3 수정).
- `23-APPROVAL-WORKFLOW.md`: 단계별 HITL 컨펌, 수정 버전, 승인-저장/게시 경계.
- `24-VOICE-INPUT.md`: 음성 STT, 사용자 교정, 안전한 승인 UI.
- `DECISIONS.md`, `CHANGELOG.md`: 결정 및 변경 이력.

## 문서 사용 순서
`01-PRD.md` → `02-FEATURES.md` → `03-USER-FLOW.md` → `04-SCREEN-SPEC.md` → `05-AGENT-ARCHITECTURE.md` → `11-CONTENT-PIPELINE.md` → `23-APPROVAL-WORKFLOW.md` → `15-IMP-PLAN.md`

## 상태 표기
[확정] 사용자와 합의한 목표 / [제안] 기술 구현 방법 / [검증 필요] API 심사·라이선스·PC 사양 의존 항목.

## v0.3 추가: LLM 비용 최소화
- `25-LLM-COST-OPTIMIZATION.md`를 새로 추가했습니다.
- **규칙/로컬 처리 우선 → 저비용 LLM → 필요할 때만 고성능 LLM** 단계로 요청을 처리합니다.
- 영상 편집·음악 태그 추천·STT·일정 조회는 가능한 로컬 도구를 쓰고, 수정 요청은 필요한 단계만 재실행합니다.
- 모델·작업별 토큰/예상 비용/재시도를 계측하고 예산 초과 시 추가 클라우드 호출을 제한합니다.


## v0.3.1 개발 시작 기준
- 최신 실행 지시: `CODEX_HANDOFF_HAEJUMI.md`; 현재 개발 계획: 루트 `DEVELOPMENT-PLAN.md`.
- 문서 충돌 해결 이력: `RECONCILIATION-REPORT.md`; 통합 뷰: 루트 `Haejumi_AI_All_Docs.md`.
- API: `09-API-CONTRACT.md`는 **승인 대기 제안**. 구현 전 필드·상태를 확정해야 함.
- 구 버전 원본: `archive/v0.3-original/`; 실제 코드가 없다는 Codex 확인은 변경되지 않음.

## v0.3.2 추가: 미래 기능 확장
현재 4개 Agent는 유지하되 블로그·AI 음악 제작 등 후속 모듈을 추가할 수 있게 코어 경계를 설계합니다. `26-EXTENSIBILITY.md` 참조.

## v0.3.3 API 계약 초안
- `09-API-CONTRACT.md`: `/api/v1` 후보 경로와 승인 필요 항목.
- `openapi-v1.yaml`: OpenAPI 3.1 계약 초안(**제안/승인 대기**).
- `API-GUIDE.md`: 초보자용 API 흐름 설명.
- `API-TEST-SCENARIOS.md`: 구현 전 계약·보안 수용 시나리오(테스트 실행 결과 아님).
