# 첫 Creator 참조 구현 상태

> 기준일: 2026-10-30 · 구현 범위: 프로젝트 생성, Photo Picker 선택 파일 업로드/완료, 작업 상태 조회

## 확정 제품 요구사항 유지

- Android 모바일 우선 제품, Android Photo Picker로 사용자가 직접 선택한 파일만 처리.
- Creator 최우선이며 전문 Agent는 Creator / Schedule / Wellness / Diary 4개. Blog와 Music은 확장 후보.
- 소유권·인증 검사를 서버에서 강제하고, 비선택 미디어는 탐색하지 않음.
- 외부 LLM/STT/비전/분석 전송은 기본 차단. 이 참조 구현에는 외부 egress adapter가 없음.
- SNS 게시·LLM 실행은 구현 범위 밖이며 승인 없이 실행하지 않음. 현재 참조 서버는 중간 승인 뒤 로컬 render job 흐름을 지원함.

## 구현된 참조 범위

- `/api/v1/media/uploads`, 업로드 part 및 complete: 세션당 선택 파일 하나/단일 part, 파일명·확장자/MIME·container 구조·PNG CRC/MP4 box·크기·SHA-256 검사, owner 격리 및 manifest 중복 제거.
- `/api/v1/content/projects`: 인증된 사용자의 검증 완료 미디어만 연결. 같은 owner+ordered media IDs+설정 재요청은 기존 Creator project/task와 `task_id`를 반환.
- `/api/v1/tasks/{task_id}`: 인증 및 소유권 검사 후 안전한 상태만 반환.
- fail-closed `PrivacyGate`와 외부 dispatcher 부재.
- 표준 라이브러리 참조 HTTP adapter와 교체 가능한 저장소/auth 인터페이스.
- Creator 영상 규격 상수, `fit_pad`/초점 조절형 `fill_crop`, 로컬 FFmpeg 명령 생성, ffprobe 출력 계약 검증. 출력 오디오 트랙은 현재 무음 AAC이며 원음/BGM 믹스는 미구현.
- `/tasks/{id}/checkpoints`, `/tasks/{id}/approvals`, `/tasks/{id}/render`, `/jobs/{id}`, `/jobs/{id}/cancel`, `/tasks/{id}/preview`를 인증·소유권 검사와 연결. 기획·초안 승인 전 렌더 요청은 거부하고 프로젝트에 연결된 업로드 미디어만 입력으로 사용.
- 테스트 renderer의 작업 상태는 `simulated`; 검증되지 않은 marker body는 `application/x-haejumi-test-preview`로 반환하며 MP4로 표기하지 않음.

이는 제품 완성이나 실제 개발 PC 검증을 뜻하지 않습니다. 업로드는 참조 구현에서 세션당 1개 파일·단일 part로 제한합니다. 미디어 검사기는 구조 및 checksum 검증이며 완전한 codec decode·백신/악성 파일 검사기는 아닙니다.

## 테스트 및 계약 검증

- `npm test`: 19개 테스트 통과. 가짜 PNG bytes, 테스트 renderer marker, 합성 ffprobe 결과만 사용.
- FFmpeg/ffprobe 실파일 생성·검증: 실행 파일을 찾지 못해 미검증. 자막 burn-in, 원음/BGM 믹스, Android 호출 통합도 미구현.
- 외부 SNS 게시, 외부 개인정보 전송, LLM 호출: 0회.
- OpenAPI 3.1 정식 검증: 미검증. 실행 시도와 이유는 [`OPENAPI-VALIDATION.md`](OPENAPI-VALIDATION.md)에 기록.

## 승인/결정 대기

- API draft 및 `ContentProject.task_id` 확장 승인.
- 최종 Backend/Android 기술, DB/persistence, 인증·세션 발급과 다중 사용자 모델.
- 다중 미디어 세션, chunk 재개·part 식별, manifest canonicalization, 업로드 제한값.
- LAN/TLS 접근 방식, 개인정보 보존·삭제·백업 정책.
- PrivacyGate 동의 UI·공급자·목적별 범위 및 외부 전송 사용 승인.
- Android Kotlin/Compose, APK 설치·배포 방식은 기존 결정 기록대로 미확정.
