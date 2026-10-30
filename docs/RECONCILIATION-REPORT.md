# 요구사항 충돌 정리 보고서 v1.1 (2026-10-30)

> 기준: 사용자 제공 `Haejumi_AI_Docs_v0.3.zip`의 개별 문서 + `CODEX_HANDOFF_HAEJUMI(1).md`. 25개 원본 문서 및 통합본은 `archive/v0.3-original/`에 바이트 그대로 보관. 과거 설계의 재해석을 신규 확정으로 취급하지 않는다.

| ID | 위치 | 구형/충돌 내용 | 현행 조치 | 상태 |
|---|---|---|---|---|
| R01 | `03-USER-FLOW.md` | 촬영 종료 추정·갤러리 주기 감지 | Photo Picker 선택 업로드 완료 후 제안으로 교체 | 정리 |
| R02 | `16-ANDROID-INTEGRATION.md` | MediaStore/WorkManager의 사진 후보 탐지 | 선택 업로드 재시도만 허용, 갤러리 스캔 제외 | 정리 |
| R03 | `05-AGENT-ARCHITECTURE.md` | Work + Creator 라우팅 예시 | Work 제거, Creator 예시로 교체 | 정리 |
| R04 | `06-AGENT-SPEC.md` | Work Agent 표 행 | Diary Agent로 교체 | 정리 |
| R05 | `06-AGENT-SPEC.md` | 게시 사용자 승인 '또는 사전 규칙' | **게시물별 최종 승인**으로 강화 | 정리 |
| R06 | `08-SYSTEM-ARCHITECTURE.md` | 갤러리 자동 감지·MediaStore 의존 | Photo Picker 모바일 우선, React PC는 선택 | 정리 |
| R07 | `19-MUSIC-GENERATION.md`/PRD | 작곡 기능이 당장 가능한 것처럼 읽힘 | 생성 음악은 후순위/검증 필요, MVP는 곡별 권리 확인된 라이브러리 | 범위 명시 |
| R08 | `09-API-CONTRACT.md`/전달서 | 이전 경로 vs `/api/v1` 혼합 | `/api/v1` 단일 **후보 계약**으로 묶음; 사용자 승인 전 확정 아님 | 승인 대기 |
| R09 | `15-IMP-PLAN.md` | v0.1·v0.2 순서 병기 | v0.2/루트 계획 우선으로 명시. 구 계획은 이력 참고 | 정리 |
| R10 | `13-SECURITY-PRIVACY.md` | LLM 외부 전송 통제가 모호 | Backend PrivacyGate·명시 동의·차단 테스트를 추가 | 정리 |
| R11 | 개발환경 | Git, Android SDK, FFmpeg, Docker 및 실제 코드 없음(사용자 전달한 Codex 결과) | 본 문서 패키지는 **문서만 수정**; 개발환경과 코드 미검증 | 보류 |

## 문서 해석 우선순위
1. 사용자 최신 명시 승인 결정
2. `docs/CODEX_HANDOFF_HAEJUMI.md`의 **최신 확정 사항**
3. `docs/DECISIONS.md`의 유효 최신 결정
4. 개별 `docs/01~26` 중 최신 확정 요구
5. 기술 제안/구형 예시(구형은 `archive/`에서만 참조)

## 아직 결정 필요
- API `/api/v1`의 request/response/OpenAPI 필드와 상태 코드 및 멱등 정책: **제안만 존재**.
- Android Kotlin/Compose 구현 선택, 실제 기기·PC 사양, 네트워크 인증/HTTPS, 보존·백업 기간.
- 각 SNS 계정·API 심사, 음악 파일별 사용권 검증.

## 주의
- 이 정리는 **문서 충돌 개선**이며 코드 동작이나 테스트 통과를 의미하지 않습니다.
- 과거 초안의 전체 문장을 하나씩 삭제한 것이 아니라, 실행 지시로 혼동될 위험이 높은 위치를 수정하고 현재 기준 문서를 명확히 했습니다.


## v0.3.3 P0 보완 점검 및 처리 결과 (2026-10-30)

| ID | 발견 사항 | 처리 | 상태 |
|---|---|---|---|
| R12 | `AGENTS.md`와 계획·작업의 Kotlin/Compose 확정/제안 불일치 | v0.3 전달서 §9와 D004에 따른 **기술 제안**으로 통일. Android 모바일 우선 요구는 확정 유지 | 문서 정렬 |
| R13 | 네이티브 Android·APK 직접 설치·Play Store 미등록 승인 이력 부재 | `DECISIONS.md` D114~D118에 근거와 **결정 대기** 명시 | 사용자 결정 대기 |
| R14 | 로컬 Codex 작업 트리에 `archive/` 없음(사용자가 전달한 P0 검사) | 현재 **배포 패키지에서는** `archive/v0.3-original/` 실제 존재 및 파일 확인. 사용자의 로컬 저장소는 직접 확인 불가하므로 로컬 복원 완료로 표시하지 않음 | 로컬 배치 미확인 |
| R15 | 일부 문서가 `docs/01~25`만 참조 | `docs/26-EXTENSIBILITY.md` 포함하도록 루트 개발 문서와 안내 문서 참조 범위 갱신 | 문서 정렬 |

### 남은 사용자 결정과 현장 점검
- Android 앱 구현 기술(Kotlin/Compose 여부), APK 직접 설치, Play Store 배포 여부, PC React 범위: **승인 대기**. 기존 제안을 확정으로 격상하지 않는다.
- API `/api/v1` 계약: **승인 대기**.
- 개발 PC/Android 기기 사양, Docker/FFmpeg/SDK, 인증된 LAN·HTTPS/Tailscale, 데이터 보존·백업: **현장 검증 필요**.
- 기존 사용자 PC의 `archive` 경로: **현장 재확인 필요**. 본 ZIP에 들어 있는 원본 파일을 선택적으로 복사할 수 있지만 코드/기존 파일을 덮어쓰기 전 비교한다.

### 비변경 범위
Creator 우선, Supervisor + 4개 Agent, Photo Picker 선택 업로드, 단계별 사용자 승인과 게시물별 최종 승인, Privacy Gate/외부 전송 제한, 로컬·규칙 우선/LLM 예산 통제, 확장성 요구는 그대로 유지. **소스코드 변경 및 실행 테스트 없음**.
