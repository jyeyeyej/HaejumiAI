# 멀티 에이전트 아키텍처

> 프로젝트: **해주미(Haejumi)** · AI 비서 이름: **예투**  
> 상태: 설계 초안 v0.2 · 수정일: 2026-10-30 · 대상: 1인 개인용, 향후 다중 사용자 확장  
> 원칙: **존댓말 응답 / 크리에이터 상업적 수익화 / 권리 검증 / 사용자 통제 / 로컬 우선**  
> 표기: **[확정]** 합의된 목표 · **[제안]** 구현 선택 · **[검증 필요]** 정책·환경 확인 전 결정 보류

## 역할 및 실행 경계
```text
Android / React → FastAPI 인증·권한 → Supervisor(예투)
                                      ├─ Creator Agent [최우선]
                                      │   ├─ Media Analyzer
                                      │   ├─ Video Planner
                                      │   ├─ Caption Planner
                                      │   ├─ Music Planner / Generator Tool
                                      │   ├─ Render Worker (FFmpeg)
                                      │   ├─ License Guard + Quality Checker
                                      │   └─ Publisher (공식 API)
                                      ├─ Schedule Agent
                                      ├─ Wellness Agent
                                      └─ Diary Agent
                        ↕ PostgreSQL + pgvector / 파일 저장 / 작업 큐
```

## Supervisor 책임
1. 자연어 요청 의도 분류 및 권한·현재 상태 조회.
2. 단일/다중 Agent를 선택하고 작업 순서 의존성 정의.
3. 입·출력 Pydantic 스키마 검사, 허용 Tool 목록 실행.
4. 위험 작업(공개 게시, 일정 삭제, 민감 데이터 제공)은 승인 게이트로 이동.
5. 오류 시 재시도·대체 Tool·안전 중지와 사용자 설명.
6. 작업·승인·권리 판단을 추적 ID로 남김.

## 상태 흐름
`RECEIVED → ROUTED → PLANNING → PROCESSING → QUALITY_CHECK → RIGHTS_CHECK → REVIEW_REQUIRED → APPROVED → PUBLISHING → SUCCEEDED`

예외: `RETRY_WAIT`, `FAILED`, `BLOCKED_RIGHTS`, `CANCELLED`. 승인 전 파일이 변경되면 `REVIEW_REQUIRED`로 되돌립니다.

## 라우팅 예시
| 입력 | 라우팅 |
|---|---|
| “카페 사진으로 쇼츠” | Creator |
| “회의 일정 추가” | Schedule → 승인 후 캘린더 Tool |
| “주말 사진으로 쇼츠 만들어줘” | Creator; 보고서 전담 Work Agent는 현 범위 밖이므로 별도 기능처럼 라우팅하지 않음 |
| “오늘 기분이 우울해요” | Wellness: 비진단적 지원 |

## Agent가 아닌 일반 도구
FFmpeg, EXIF 파서, OAuth 클라이언트, 파일 검사, 자막 합성, DB CRUD는 결정적 서비스/Tool입니다. 모든 작업을 LLM Agent로 만들지 않습니다.

## 실패 복구
- 네트워크: 제한적 지수 백오프 + 멱등 키 확인.
- 렌더: 입력·설정 스냅샷으로 재실행, 최대 횟수 이후 안전 중지.
- 검증 실패: 자동 게시 차단, 수정 후보 제안.
- 승인 대기: 장기 작업과 분리 저장하여 프로세스 재시작 후에도 유지.

---

## v0.2 에이전트 및 승인 계층
`Android 선택 업로드/텍스트/음성 → (음성이면 STT·인식문 확인) → FastAPI → Supervisor(예투) → Creator | Schedule | Wellness | Diary`
- Supervisor는 에이전트 라우팅·도구 허용 목록·실행 상태를 관리하고, **Approval Gate**에서 사용자 답변을 기다립니다.
- `Diary Agent`는 일정·감정·건강 등 *사용자가 접근을 허용한 사실*을 가져와 초안을 작성합니다. 예정된 일정을 실제 경험으로 단정하지 않습니다.
- Creator의 자동 제안은 갤러리 감시가 아닌 **선택된 업로드 프로젝트의 완료 이벤트**로 시작합니다.
- 중간 승인 단계에서 작업 상태를 체크포인트에 보존하고, 최종 승인 시 버전+해시 검증 후 저장·게시합니다.
- 예투는 존댓말로 응답하며, 일기 본문 문체는 별도 사용자 설정을 따릅니다.

## v0.3 — 비용 인지형 Supervisor
- `Rule Router → 필요 시 소형 LLM → 복합 판단에 한하여 고성능 모델` 순서로 호출한다.
- 각 에이전트는 모델 호출 전에 예산·컨텍스트·중복 작업을 확인한다. 음악 교체, 일정 조회처럼 결정적 Tool로 해결 가능한 작업은 LLM을 호출하지 않는다.
- 비용 절감은 승인 게이트, 저작권 검증, 민감정보 접근 통제를 생략하는 근거가 될 수 없다.
- 상세 설계: `25-LLM-COST-OPTIMIZATION.md`.
