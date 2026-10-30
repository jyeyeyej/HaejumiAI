# 전체 시스템 아키텍처

> 프로젝트: **해주미(Haejumi)** · AI 비서 이름: **예투**  
> 상태: 설계 초안 v0.2 · 수정일: 2026-10-30 · 대상: 1인 개인용, 향후 다중 사용자 확장  
> 원칙: **존댓말 응답 / 크리에이터 상업적 수익화 / 권리 검증 / 사용자 통제 / 로컬 우선**  
> 표기: **[확정]** 합의된 목표 · **[제안]** 구현 선택 · **[검증 필요]** 정책·환경 확인 전 결정 보류

## 권장 토폴로지
```text
Android (Kotlin/Compose 제안; Photo Picker 선택 업로드, 업로드 완료 알림)
  └─ Tailscale 사설 연결 ── Windows PC / WSL2 / Docker Compose
                         ├─ React 웹 UI (PC)
                         ├─ FastAPI (인증·API·에이전트 라우팅)
                         ├─ LangGraph Supervisor + Creator
                         ├─ Worker (FFmpeg, STT, 음악 생성 선택)
                         ├─ PostgreSQL + pgvector
                         ├─ Redis (큐/상태; 필요 시)
                         └─ 로컬 파일 볼륨 / 백업
                         └─ 외부: Google OAuth·SNS API·LLM API(선택)
```

## 컴포넌트 기준
| 컴포넌트 | 초기 선택 | 이유 |
|---|---|---|
| Android | Kotlin + Jetpack Compose | 사진 권한·알림·백그라운드 기능 |
| Web | React + TypeScript | PC 상세 편집·관리 화면 |
| API | FastAPI + Pydantic | 명확한 계약과 검증 |
| AI | LangGraph | Supervisor 상태/분기/승인 |
| 편집 | FFmpeg + Pillow | 무료 로컬 영상 처리 |
| 자막 | faster-whisper | 로컬 음성 전사 |
| 음악 | 승인된 라이브러리 → 허가된 생성 모델 | 상업용 우선 |
| 데이터 | PostgreSQL + pgvector | 구조화/의미 검색 |
| 파일 | 로컬 볼륨 + 백업 | 1인용, 비용 최소화 |
| 원격 | Tailscale | 공유기 포트 개방 회피 |

## 경계와 제약
- PC 전원 차단/절전 시 렌더링·에이전트 서버 정지. Android 알림/대기열에 오프라인 상태 반영.
- **MVP는 선택 업로드 완료 기반 제안만 구현한다.** 전체 갤러리 자동 감지·MediaStore 주기 스캔은 현 범위 제외.
- 외부 플랫폼이 가져와야 하는 영상 URL은 Tailscale 전용 주소로 대체할 수 없음. 일시적 안전 업로드 수단 설계 필요.
- 공개 서비스로 확장할 때는 인증·격리·스토리지·관측·백업·규약을 재검토.

## 성능·운영 선택 보류
- [ ] 실제 Windows PC GPU 사양 및 로컬 음악 생성 가능 여부 측정
- [ ] Docker 볼륨 저장 용량 및 백업 경로 지정
- [ ] HTTPS 및 토큰 보관 방안 확정

---

## v0.2 물리 구성
- **Android 앱(우선 UI)**: Photo Picker, 텍스트/음성 입력, 업로드·승인·미리보기·게시 상태.
- **Windows PC(로컬 서버)**: FastAPI, LangGraph, PostgreSQL/pgvector, 파일 폴더, FFmpeg Worker, 음악 생성 모델(하드웨어·라이선스 확인).
- **연결**: 동일 Wi-Fi 또는 인증된 Tailscale 네트워크. 서버가 꺼진 경우 작업 전송 대기/안내. 외부 공개 포트 최소화.
- **갤러리 전수 감지 없음**: 선택 업로드 후 이벤트만 감지해 제작을 제안.
- **승인 계층**: 서버의 작업 상태·버전·해시 기반 컨펌 및 권리 게이트. Android 화면만으로 승인 검증하지 않습니다.

## v0.3 — 모델 게이트웨이 및 예산 제어
- FastAPI 서비스에 `LLM Gateway`(모델 선택·호출/토큰 계측·재시도 한도)와 `Budget Guard`(일/월 예산 검사)를 둔다.
- 로컬: FFmpeg, Pillow, faster-whisper, 음악 라이브러리 매칭. 선택: Ollama. 클라우드 API는 문장 품질·복합 판단이 필요할 때만 호출한다.
- 모델별 가격은 날짜를 포함한 설정으로 관리하고, 이미지/오디오 부가요금과 재시도 비용을 별도 측정한다. 상세: `25-LLM-COST-OPTIMIZATION.md`.
