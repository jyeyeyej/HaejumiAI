# 문서 변경 이력

## 2026-11-03 — Creator 다중 미디어 선택·업로드·장면 편집

- 사용자 요청에 따라 기본 20개 사진·영상 혼합 선택을 PC 웹과 Android Photo Picker에 추가했습니다. 백엔드에 다중 항목 세션, 파일별 해시·멱등 재시도, 순서 있는 프로젝트 manifest를 추가하고 단일 항목 API는 유지했습니다.
- 장면 순서·재생 길이·영상 시작 위치를 현재 버전·해시로 수정할 수 있게 했고 승인 무효화와 FFmpeg 타임라인을 연결했습니다. 외부 AI 전송과 SNS 게시는 실행하지 않았습니다.
- 합성 사진 5장·영상 2개의 실제 FFmpeg 렌더와 ffprobe 검증, 백엔드 45개·웹 5개 테스트, Redocly 검증을 실행했습니다. Android 실기기 동작은 미검증입니다.

## 2026-11-03 — Android·PC 공통 사용 방향 및 localhost 웹 첫 버전
- 사용자 확정 D123~D125: Android Kotlin/Compose와 localhost React PC 웹이 Node.js 참조 `/api/v1`의 서버 데이터를 공유. 네 Agent 중 미구현 세 개는 준비 중 표시. 사설 Android HTTPS는 실기기 검증 대기.
- React PC 웹의 예투 홈, 수동 선택 업로드, 소유 프로젝트 목록, 기획·초안 확인/수정·중간 승인, 렌더 상태/취소, 인증·해시 확인 MP4 미리보기 화면 추가. 실제 SNS 게시와 외부 AI 동의/호출 UI 없음.
- 참조 API에 소유자별 `GET /content/projects`, `GET /tasks/{task_id}/jobs` 추가. OpenAPI 계약 초안에 경로와 서버 소유권 조건 반영. 기존 계약의 확정 상태를 바꾸지 않음.
- PC 웹 빌드·단위 테스트, 백엔드 회귀 및 Android 빌드 결과는 `docs/IMPLEMENTATION-STATUS.md`에 기록. 실기기·두 클라이언트 동기화 E2E 미검증.

## 2026-11-03 — Android 앱 기술 및 설치 방식 승인
- 사용자 요청에 따라 Kotlin/Jetpack Compose 네이티브 앱, APK 직접 설치 및 Play Store 미등록을 D121·D122에 기록했습니다. D115~D117은 당시 결정 대기였던 이력으로 보존합니다.
- 앱은 선택 미디어 단일 업로드와 인증된 HTTPS 연결을 대상으로 하며 구체적인 PC 보안 경로 및 실기기 연결은 별도 검증이 필요합니다.

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

## 2026-10-30 — OpenAI Vision Gateway 기반 연결
- OpenAI Responses API adapter, server `.env` 설정, 기본 비활성/timeout/no-retry/cost reservation을 연결.
- 처리 notice 조회와 owner·목적·data category·정확한 선택 미디어 ID에 묶인 명시 동의 생성/철회 API를 구현. PrivacyGate dispatch 직전 재검증으로 미동의·철회·불일치 egress 0회.
- 선택 사진은 로컬 FFmpeg 크기 축소/메타데이터 제거, 선택 영상은 프레임 추출 후 최대 설정 개수(기본 5)만 시각 분석으로 전송. 구조화 scene 결과가 Creator 기획/자막 초안에 들어가며 기존 중간 승인/version hash 흐름 유지.
- 외부 기본 비활성, Fake fetch/Mock 검증만 실행. 실제 OpenAI/유료 요청 0회. OpenAPI/API 설명·테스트 계획·개발 문서 갱신.
