# 로컬 설치·운영 설계

> 프로젝트: **해주미(Haejumi)** · AI 비서 이름: **예투**  
> 상태: 설계 초안 v0.2 · 수정일: 2026-10-30 · 대상: 1인 개인용, 향후 다중 사용자 확장  
> 원칙: **존댓말 응답 / 크리에이터 상업적 수익화 / 권리 검증 / 사용자 통제 / 로컬 우선**  
> 표기: **[확정]** 합의된 목표 · **[제안]** 구현 선택 · **[검증 필요]** 정책·환경 확인 전 결정 보류

## 초기 실행 환경
- Windows 노트북/PC + WSL2 Ubuntu + Docker Desktop.
- FastAPI, React, PostgreSQL, 선택적 Redis/Worker는 Docker Compose로 구동.
- FFmpeg 및 faster-whisper는 로컬 Worker에서 처리.
- Android 앱은 같은 Wi-Fi 또는 Tailscale로 PC에 연결.

## 실행 구성(예시)
```text
infra/docker-compose.yml
  backend     : API / LangGraph
  frontend    : React 웹 서버
  db          : PostgreSQL + pgvector
  worker      : FFmpeg/STT/작업 처리
  redis       : 작업 큐 도입 시
volumes/
  media/ originals/ renders/ music/ exports/
  postgres/ backups/
```

## 개발·실행 절차
1. `.env.example` 복사 후 비밀 키 설정(실제 키 Git 관리 금지).
2. Docker Compose로 DB/백엔드/Worker/프론트 실행.
3. `/health` 및 DB 연결 검사.
4. PC에서 테스트 미디어로 렌더 실행.
5. Android 기기에서 네트워크 연결 및 권한 테스트.
6. 외부 접속 필요 시 Tailscale 등록, 방화벽 최소 허용.

## 장애 대응
- PC 꺼짐/절전: Android는 작업 대기 상태 표시, 복구 후 재전송.
- 대용량 미디어: 디스크 여유 공간 검사, 임시 파일 정리.
- DB 오류: 자동 재시작보다 백업·복구 절차 확인.
- 비밀 키 노출: 즉시 폐기·재발급 및 로그 검토.

## 백업
- 주기적 `pg_dump`, 음악·원본·렌더·라이선스 증빙 파일 백업.
- 별도 드라이브에 암호화 백업 및 월별 복원 테스트.

## 클라우드 전환 트리거
PC 상시 가동 필요, 여러 사용자 가입, 대규모 영상 작업/스토리지, SNS 공개 미디어 URL 필요 시 분리 배포 검토.

---

## v0.2 Mobile First + PC 서버 운영
- **사용자 동선은 Android 앱 중심**, PC는 로컬 처리 서버·렌더링/AI 음악 작업을 수행합니다.
- 모바일의 선택 업로드만 프로젝트 `uploads`에 기록하며 원본은 변경하지 않습니다.
- PC 전원 종료/네트워크 단절 시 모바일에 '서버 연결 대기' 상태를 알리고, 자동 게시나 정식 저장이 완료되었다고 표시하지 않습니다.
- 원격 접근은 Tailscale 사설 연결, 인증 및 최소권한 접근을 사용합니다. 비밀키는 PC의 `.env`에만 보관합니다.
