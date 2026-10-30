# 문서 변경 이력

> 프로젝트: **해주미(Haejumi)** · AI 비서 이름: **예투**  
> 상태: 설계 초안 v0.1 · 작성일: 2026-10-30 · 대상: 1인 개인용, 향후 다중 사용자 확장  
> 원칙: **존댓말 응답 / 크리에이터 상업적 수익화 / 권리 검증 / 사용자 통제 / 로컬 우선**  
> 표기: **[확정]** 합의된 목표 · **[제안]** 구현 선택 · **[검증 필요]** 정책·환경 확인 전 결정 보류

## 2026-10-30 · v0.1 (설계 초안)
- 22개 번호 문서와 README, DECISIONS, CHANGELOG 최초 작성.
- 상업용 Creator 우선, 예투 존댓말, Android 능동형 제안, 로컬 PC 실행 조건 반영.
- 공식 SNS API·생성 음악 라이선스는 확인 근거와 미확정 사항을 분리 표기.

## 다음 수정 항목
- [ ] 실제 Android 기기 버전·PC 하드웨어 확인
- [ ] 영상 스타일 프리셋과 이용할 SNS 계정 유형 확정
- [ ] OAuth/음악 라이선스·보존 기간·비용 정책 상세화
- [ ] OpenAPI와 Alembic 실제 스키마 동기화

## v0.2 — 2026-10-30
- Android 모바일 선택 업로드를 기본 입력으로 확정; 갤러리 상시 자동 감지는 범위에서 제외.
- 예투의 제작 제안 트리거를 업로드 완료 이벤트로 변경.
- Work Agent 대신 Diary Agent 추가; 일정·감정·건강을 반영한 일기 초안 및 최종 저장 승인.
- 콘텐츠 기획/음악·자막/미리보기 중간 컨펌과 최종 SNS 게시 승인 체계 추가.
- 공통 텍스트·음성 입력 및 STT 인식문 수정 흐름 추가.
- 23 승인 워크플로, 24 음성 입력 문서 신설.

## v0.3 — 2026-10-30
- `25-LLM-COST-OPTIMIZATION.md` 신규 작성(로컬 우선, 규칙 라우팅, 작은 모델 우선, 컨텍스트 축소, 부분 재실행, 비용 예산 및 검증).
- PRD, Agent Architecture/Spec, Memory, System Architecture, Content Pipeline, Test, Implementation Plan, Observability, Approval Workflow와 README/Decisions 내용 동기화.
- 일 0.20 USD / 월 5 USD는 **해주미 자체 정책의 예시 기본값**이며 API 제공자의 자동 제한·최종 청구액 보증이 아님을 명시.


## 2026-10-30 — v0.3.1 실행 문서 정렬
- 03/05/06/08/09/13/15/16/19의 구형 실행 혼동 요소 정리, 원본은 `archive/v0.3-original/` 보존.
- Creator 우선, 4 Agent, 선택 업로드, 게시물별 최종 승인, 로컬 권리 확인 BGM, 외부 LLM 기본 전송 차단을 현행 기준으로 명확화.
- API는 `/api/v1` **후보 계약(승인 대기)**; 임의 최종 확정하지 않음.
- 루트 `DEVELOPMENT-PLAN.md` 및 `docs/RECONCILIATION-REPORT.md`, 현행 `Haejumi_AI_All_Docs.md` 생성. 코드 수정 및 테스트 실행 없음.

## 2026-10-30 — v0.3.2 확장성 보완
- `26-EXTENSIBILITY.md` 추가: Blog/AI Music 등 후속 모듈 확장과 공통 보안·승인·비용 계약.
- 루트 AGENTS/DEVELOPMENT-GUIDE/DEVELOPMENT-PLAN/IMP-PLAN/TASKS 및 DECISIONS에 확장성 방향 연결.
- 현재 MVP 네 Agent, Creator 우선, 선택 업로드, 단계별 승인 정책은 변경하지 않음.


## v0.3.3 — 2026-10-30 (문서 정합성 보완)
- Kotlin/Compose 제안 상태, APK 설치·Play Store 미등록 승인 대기, PC React 범위 미확정을 일치시킴.
- `DECISIONS.md` D114~D118 검토 이력 추가(사용자 승인으로 간주하지 않음).
- 문서 읽기 범위를 `docs/01~26`으로 확장.
- `archive`는 패키지에 존재하나 Codex 로컬 트리에는 없다는 보고를 구분 기록.
- 소스코드 변경 없음, 테스트 미실행.

## v0.3.3 — 2026-10-30 (`/api/v1` OpenAPI 설계 초안)
- `openapi-v1.yaml`에 OpenAPI 3.1 초안 추가: 인증, 외부 처리 동의, 선택 업로드, 프로젝트/작업, 체크포인트 승인, 렌더/미리보기, 권리 확인, 게시, 일기 흐름을 제안.
- `API-GUIDE.md` 초보자용 설명과 `API-TEST-SCENARIOS.md` 테스트 수용 기준 추가(테스트 코드는 아니며 실행하지 않음).
- 외부 전송 동의와 게시 최종 승인을 분리하고, 최신 버전·해시·계정·공개범위·문구 및 권리 `allow`를 서버에서 재검증하는 제안 명시.
- Blog/Music은 미래 Registry capability로만 표현; 현재 MVP 4개 Agent 결정은 변경하지 않음.
- 세부 계약은 사용자 승인 대기이며 기능 코드 변경 없음.
