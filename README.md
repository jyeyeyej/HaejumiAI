# 해주미 AI — Creator 우선 개발

> 2026-11-03 현재: Android Kotlin/Compose 앱과 Windows PC localhost React 웹이 같은 Node.js 참조 `/api/v1` 백엔드를 사용합니다. PC 웹 실행은 [`web/README.md`](web/README.md), Android 상태는 [`android/README.md`](android/README.md)를 참조하세요. Schedule·Wellness·Diary는 준비 중이며 실제 SNS 게시 기능은 없습니다.

두 화면과 서버의 역할, 버전 충돌 처리, 후속 Agent 경계는 [`docs/PC-ANDROID-COMMON-ARCHITECTURE.md`](docs/PC-ANDROID-COMMON-ARCHITECTURE.md)에 정리했습니다.

이 저장소에는 개발 문서, 교체 가능한 Node.js 참조 백엔드, Android 앱과 PC 웹 첫 버전이 있습니다. 참조 백엔드는 선택 미디어 업로드·검증, Creator 기획/자막·BGM 승인, FFmpeg 렌더와 인증된 미리보기를 제공합니다. 외부 LLM은 서버에서 기본 비활성화되며 명시 동의와 PrivacyGate 없이는 전송되지 않습니다. 실제 SNS 게시 연동은 없습니다.

## 로컬 테스트

백엔드는 Node.js 표준 라이브러리로 동작하며 루트 `npm test`로 회귀 테스트를 실행합니다. PC 웹은 `web/`에서 `npm ci`, `npm run dev`, `npm test`, `npm run build`를 사용합니다. 서버는 시작할 때 루트 `.env`의 허용된 설정을 읽습니다. 실행 방법은 `backend/README.md`, `web/README.md`와 `.env.example`을 확인해 주세요.

Node.js는 장래 최종 백엔드 스택을 확정한 결정이 아닙니다. OpenAPI 3.1 문서는 Redocly 문법 검증을 통과했지만 전체 계약은 승인 대기이며, Android 실기기·사설 HTTPS 연결과 PC/Android 동시 사용은 아직 검증되지 않았습니다.

1. `AGENTS.md`
2. `docs/CODEX_HANDOFF_HAEJUMI.md` 및 `docs/DECISIONS.md`
3. `docs/RECONCILIATION-REPORT.md`
4. `DEVELOPMENT-PLAN.md` → `DEVELOPMENT-GUIDE.md` → `IMP-PLAN.md` → `TASKS.md`
5. 필요한 `docs/01~26` 상세 문서 및 루트 통합 문서

API 제안과 구현에서 계약 승인이 필요한 세부 사항은 `[제안/승인 대기]`로 표시합니다. 기존 확정 제품 요구사항을 유지합니다.

## 확장형 설계(v0.3.2)
현재는 Creator·Schedule·Wellness·Diary 4개 Agent를 유지하고, 블로그와 AI 음악 제작 등은 추후 모듈 또는 Agent로 확장합니다. 설계 기준은 `docs/26-EXTENSIBILITY.md`를 참조합니다.
