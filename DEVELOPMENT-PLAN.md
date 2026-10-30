# 해주미 AI 실전 개발계획서 v1.1

> 2026-10-30 · 상태: **제안/착수 전** · 근거: `docs/CODEX_HANDOFF_HAEJUMI.md`, `docs/01-PRD.md`~`docs/26-EXTENSIBILITY.md`, `docs/DECISIONS.md`.
> 제품 확정 기능은 바꾸지 않습니다. 기술, 세부 API 및 추정 일정은 승인 전까지 [제안]입니다.

## A. 목표와 첫 동작 시나리오
**첫 성공 기준:** Android Photo Picker에서 본인 사진 8장·짧은 영상 2개를 직접 선택 → 인증된 PC 서버로 업로드 → 업로드 완료 제안 → 기획/자막·음악 중간 컨펌 → FFmpeg로 1080×1920, 9:16, H.264/AAC, 30fps MP4 생성(사용자 설정 3~59초, 기본 30초) → ffprobe 검증 → Android 미리보기·수정→ 버전 갱신·저작권 게이트 → 게시물별 최종 승인 준비. SNS 실제 게시 성공은 별도 API 승인 단계입니다.

**Supervisor(예투)**는 라우팅·승인상태를 조정합니다. 전문 Agent는 **Creator(최우선), Schedule, Wellness, Diary** 4개이며 Work Agent는 제외. 1인용 Android 앱 중심, Windows PC 로컬 서버; Kotlin/Compose·FastAPI·PostgreSQL은 현재 구현 **제안**이며, Android 모바일 우선 제품 방향만 확정입니다. APK 직접 설치·Play Store 미등록은 승인 근거가 없어 **결정 대기**입니다.

## B. 작업 방법 / 1회 작업 단위
1. 해당 작업의 기능 ID(F-xxx), 관련 docs 파일, 테스트 ID(T-xxx)를 TASKS에서 지정.
2. 구현 전 개인정보 데이터 흐름, 로컬/외부 처리 여부, 승인 게이트, 저작권 게이트를 적음.
3. 기능별 세로 슬라이스를 작게 구현하고 테스트. 코드·API·Mock/실연동 상태 기록.
4. 결과 시연 화면/명령, 로그(민감정보 마스킹), 변경 파일, 테스트 실패·미해결 위험을 보고.
5. 사용자 확정 요구를 바꾸는 변경은 `docs/DECISIONS.md` 승인 기록 후 착수.

## C. 단계별 우선순위와 작업 단위
| 단계 | 작업 묶음 | 통과 기준 | 의존 관계 |
|---|---|---|---|
| P0A 문서 | API 후보 계약·변경 충돌 정리, 원본 보존 | 충돌 보고서/미확정 결정 기록 | 지금 수행 가능 |
| P0B 개발환경 | Git init/ignore, 환경 조사, Python·Docker·FFmpeg·Android Studio/SDK 확인 | 버전 확인 출력, 초기 Git 안전 상태, 설치법 문서화 | 개발 PC 접속 필요 |
| P0C API 승인 | `/api/v1` OpenAPI 요청/응답·오류·상태/권한 계약 확정 | API 리뷰 승인, 계약 테스트 초안 | 사용자의 선택 필요 |
| P1A 보안 | 사용자 인증, 파일 경로 격리, PrivacyGate, 비밀관리 | 무인증/외부전송/경로탐색 차단 테스트 | P0B |
| P1B 업로드 | 선택 파일만 받아 검증·해시·원본 저장, manifest 완료 | 위변조·부분·중복 검증, 원본 불변 | P1A |
| P1C 로컬 렌더 | 선택 업로드 → plan/draft 승인 → 소유 미디어만 render job → 상태/취소 → 인증 미리보기 | 9:16 MP4 재현·ffprobe 검증·실패/중복 처리; 테스트 렌더는 simulated 표기 | P1B |
| P1D 게시 정보·독립 승인 | 공통 렌더 task에 플랫폼별 문구/계정/공개범위 저장, 수정·조회, 각 플랫폼의 독립 final approval | 현재 revision/hash와 영상 버전/파일 해시를 결합; 실제 FFmpeg+ffprobe와 미리보기 승인 전 publish_ready 금지; SNS 호출 없음 | P1C |
| P1E 예투 Supervisor·Creator 기획 | Capability Registry, 규칙 라우터, Creator 구조화 기획/자막 초안, 순차 중간 승인 | 인증·소유 task의 선택 미디어만, 버전 수정/승인 무효화, 기본 외부 LLM 차단, 테스트 Mock | P1C |
| P2 Creator | 컷 순서/스타일, 자막, 권리 검증된 무료 로컬 음악 | 미검증 음원 게시 차단, 렌더 개선 | P1C |
| P3 승인·복구 | 계획/자막·음악/미리보기 체크포인트, 최신 버전 해시, 보류·재개 | 수정 후 이전 승인 409, 무승인 저장·게시 0건 | P2 |
| P4 Android | [제안] Kotlin/Compose 앱 후보, Photo Picker, 선택 업로드 진행률·제안·STT 교정 | 실기기에서 업로드→제안→미리보기·수정·승인 | P1~P3 |
| P5 SNS | YouTube 공식 OAuth/API부터 정책 확인, Instagram/TikTok은 허용 범위만 | 게시물별 승인을 통과한 최신 파일만, 중복 게시 0건 | P3~P4 + 외부 심사 |
| P6 비서 확장 | Schedule/Wellness/Diary, 권한별 기억 | 실제 일정과 수행 구분, 일기 최종 승인 시에만 확정 | 공통 보안/승인 |
| P7 최적화 | LLM Gateway·예산 고도화, 캐시·부분 재실행, 선택 후속 AI 음악 연구 | 단순 경로 LLM 0회, 예산 초과 차단 | P1에 기본 계측 선행 |
| P8 출고 | Android E2E, 권리/보안 회귀, 백업·복원, 운영 지침 | 치명 보안 결함 0건 및 정의된 E2E 전부 통과 | 전 단계 |

### P1E/P7 AI 기반 구현 기록 (2026-10-30)
- `OpenAIProvider`는 Gateway 뒤에 있고 Responses API의 구조화 JSON+이미지 입력을 사용합니다. `.env` 키/model/명시적 `HAEJUMI_LLM_ENABLED=true`가 모두 있어야 provider가 만들어집니다. 예시 설정은 비활성/빈칸이며 실제 OpenAI 요청은 실행하지 않았습니다.
- 먼저 고지 API를 읽고 `vision_analysis` + `selected_media,user_text`에 명시 동의해야 합니다. consent는 owner/purpose/provider/category/resource/expiry를 서버가 실제 egress 직전에 재검증하고, 철회·불일치·오류 시 외부 요청은 0회입니다.
- 선택 사진은 로컬 FFmpeg 축소·메타데이터 제거, 선택 영상은 로컬에서 프레임을 한 장 추출합니다. 최대 5개 준비 이미지만 전달하고 구조화 장면/자막 결과를 현재 Creator plan version에 연결합니다. FFmpeg 준비 실패 시 외부 모델 호출 대신 규칙 fallback.
- API/Consent notice, 소유권·철회, fake OpenAI fetch, output schema, timeout·비재시도, zero-egress 테스트를 추가했습니다. 실제 provider 정책/계정 보존 설정, 선택 모델 지원 여부 및 실제 유료 호출은 미검증·대기 상태입니다.

## D. P0 환경 점검 표 (기록 후 진행)
- [ ] 프로젝트 루트 Git 초기화 여부/원본 스냅샷/`.gitignore` 확인. `data/`, `.env`, 토큰·백업 저장소는 Git 제외.
- [ ] Windows/WSL2, CPU/RAM/GPU, 디스크 용량 및 설치 권한 확인.
- [ ] Python/uv, Docker Compose, FFmpeg/ffprobe, Java/Gradle, Android Studio SDK/adb 버전 확인.
- [ ] Android 기종/OS, 케이블 또는 무선 디버깅, Photo Picker 지원 여부 점검.
- [ ] 같은 Wi-Fi/인증 접속 또는 Tailscale 경로 결정. HTTP 평문으로 개인 데이터를 외부 공용망 전송하지 않음.
- [ ] API 계약(프로젝트/미디어/작업/승인/게시) 최종 검토; 필드/상태/409/권한 정책 확정.
- [ ] 음원·폰트 증빙 수집 및 정책 검증 담당/시점 지정.

## E. 개인정보 보안 설계(개발 초기부터 강제)
- 민감도: 일기/건강/음성/위치/얼굴/일정/기억/토큰; 원본은 PC 로컬에 제한 접근.
- **외부 전송 기본 금지**; 로컬 처리 우선. 외부 LLM/STT/비전 호출은 Backend `PrivacyGate`가 사용 목적·업체·전송 항목·최소화·별도 동의 범위를 검사할 때만 허용. 승인 없으면 실패하도록 구현.
- LLM은 임의의 네트워크/게시/전체 파일 읽기 도구 사용 불가. Agent Tool allowlist, 프롬프트 인젝션 방어.
- 게시 승인과 개인정보 외부 전송 동의는 별도. 게시마다 최신 `version+sha256+account+platform+visibility`를 서버에서 검증.
- `.env`/OAuth는 서버만 보관, 로그/오류에서 원문·경로·비밀 가림; 암호화 저장·최소 보존·완전 삭제 가능 범위와 백업 잔존 기간 명시.
- 테스트: 무동의 외부 호출 0회, 타 Agent 웰니스 조회 차단, 악성 미디어/EXIF, 무승인 게시 차단, 재시도 멱등 보장.

## F. LLM 비용·운영 기준
- 규칙/일반 코드 및 로컬 FFmpeg·OpenCV·STT·상업 권리 확인 음악 우선. 소형 클라우드 LLM은 필요한 문장 생성만, 고성능 LLM은 선택·예산 허용 시에만.
- 일 `$0.20`/월 `$5`/작업 최대 5회/수정 3회는 **초기 실험 제안값**, 외부 업체의 결제액 보장은 아님. 사용자 설정 가능.
- P1부터 예상 비용 기록·클라우드 호출 비활성 기본값·예산 검사·실패시 로컬/보류. P7은 캐시·대시보드·비용 보고 최적화.
- 음악 변경 시 기존 사진 분석과 자막 LLM 호출은 0회. 보안/권리/최종 승인은 비용 이유로 생략 불가.

## G. 정의된 완료(DoD) 및 보고 양식
각 작업은 (1) 해당 기능 ID, (2) 실제 동작/스크린샷 또는 재현 명령, (3) 정상/실패 테스트 결과, (4) 개인정보·권리·승인·비용 영향, (5) 수정 파일/DB/마이그레이션, (6) Mock/실서비스 구별, (7) 미완료 항목을 기록한 뒤에만 `[x]` 처리.

## H. 아직 확정되지 않은 결정
1. `/api/v1` 후보 라우트와 JSON 요청/응답 스키마, 업로드 chunk/manifest 구체 규격 (사용자 승인 필요).
2. Android 모바일 우선은 확정. Kotlin/Compose 구현 기술 및 PC React 범위는 **제안·검증 필요**; APK 직접 설치·Play Store 미등록 여부는 **결정 대기**(사용자 승인 전 확정 금지).
3. 테스트 PC 사양, Android OS 버전, LAN/HTTPS/Tailscale 방식.
4. 음악별 권리·광고 표시, SNS 계정 유형/권한/심사 결과.
5. 데이터 보존 기간/삭제·백업 암호화 정책, 외부 모델 공급자별 정보 처리 약관.

**첫 Codex 구현 명령:** “AGENTS.md → CODEX_HANDOFF → DECISIONS → DEVELOPMENT-PLAN.md → DEVELOPMENT-GUIDE.md → IMP-PLAN.md → TASKS.md → 관련 docs 순으로 읽고, P0B 환경 점검과 P0C API 계약 검토만 수행하세요. 승인 전에는 외부 게시/실데이터 테스트/기존 문서 삭제 금지. 변경 파일·검증 결과를 보고하세요.”
