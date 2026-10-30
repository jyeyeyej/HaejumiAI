# 에이전트별 세부 명세

> 프로젝트: **해주미(Haejumi)** · AI 비서 이름: **예투**  
> 상태: 설계 초안 v0.2 · 수정일: 2026-10-30 · 대상: 1인 개인용, 향후 다중 사용자 확장  
> 원칙: **존댓말 응답 / 크리에이터 상업적 수익화 / 권리 검증 / 사용자 통제 / 로컬 우선**  
> 표기: **[확정]** 합의된 목표 · **[제안]** 구현 선택 · **[검증 필요]** 정책·환경 확인 전 결정 보류

## 공통 입출력 계약
```json
{"request_id":"uuid","user_id":"local-user","intent":"create_short","input_refs":["media-id"],"permissions":[],"context":{"tone":"polite_ko"}}
```
결과: `{task_id, status, summary, artifact_refs, requires_approval, error_code}`. 실제 스키마와 버전은 API 문서에서 확정합니다.

| Agent | 책임 | 읽는 데이터 | 허용 Tool | 결과 | 승인 조건 |
|---|---|---|---|---|---|
| Supervisor/예투 | 요청 분류·조정·통합 | 사용자 설정·작업 상태 | route, enqueue, approval | 작업 계획 | 위험 도구 사용 전 |
| Creator | 편집 작업 지휘 | 촬영 미디어·스타일 | analyze, plan, render | 영상 초안 | SNS 게시 전 |
| Media Analyzer | 후보 분류·컷 점수 | 선택/허용된 파일 | EXIF, ffprobe, CV | media groups | 갤러리 범위 준수 |
| Caption Planner | 대본·자막·해시태그 | 승인된 촬영 정보 | LLM, STT | caption track | 허위 사실 확인 |
| Music Planner | 스타일/음악 선택 | 스타일·권리 목록 | choose_track, generate_music | music asset | 라이선스 게이트 |
| License Guard | 출처와 사용 범위 검증 | 에셋·라이선스 기록 | policy_check | allow/block/review | 미확인 시 block |
| Publisher (일반 Tool) | 플랫폼별 공식 업로드 | 최종 승인된 영상/계정 토큰 | 허용된 공식 API | 게시 상태 | **게시물별 최종 승인 + 최신 버전·해시 + 권리 검증 필수** |
| Schedule | 일정 조회·변경 | 캘린더 | calendar API | 일정 변경 제안 | 생성/변경/삭제 시 |
| Wellness | 체크인과 패턴 요약 | 선택적 건강 기록 | safe journal | 비진단 조언 | 민감정보 외부 전송 시 |
| Diary | 승인받은 당일 일정·기분·건강 정보로 일기 초안 | 허용된 하루 기록만 | get_calendar_events, get_wellness_entries, save_diary_draft, finalize_diary | 일기 초안/확정본 | **최종 승인한 버전만 정식 저장** |

## 금지 행동
- Supervisor는 미승인 OAuth 게시, 진단, 불명확한 음원 사용, 임의의 갤러리 전체 업로드 금지.
- Publisher는 공개 범위를 변경하거나 비공식 자동화로 공식 API 심사를 우회하지 않음.
- Wellness는 긴급 위험 신호 시 적절한 현실 세계 지원을 권하되 치료 판단 대체 금지.

## 프롬프트 원칙
시스템 지침: 존댓말 / 의도·권한 확인 / 사용자의 실제 경험을 임의로 창작하지 않음 / 권리 미확인 시 게시 차단 / 도구 결과를 검증 후 보고.

---

## v0.2 Diary Agent 계약
- 입력: `date`, 허용된 `calendar_events`, `wellness_entries`, `user_notes`, `tone`, `approval_context`.
- 출력: `fact_summary`, `uncertainties`, `outline`, `draft`, `revision`, `version`.
- 도구: `get_calendar_events`, `get_wellness_entries`, `get_daily_notes`, `save_diary_draft`, `finalize_diary`.
- 제약: 부재한 사건·감정·병력 생성 금지, 민감한 기록은 허용 범위만 사용, `finalize_diary`는 최종 승인 필수.
## v0.2 공통 입력과 승인
- 입력 채널: `text | voice_transcript` (`raw_audio`는 STT 서비스에서만 처리), 사용자가 인식문 확인 후 전달.
- 각 에이전트 출력은 `task_id/version/checkpoint/status`를 포함. 승인 대기 중 임의의 다음 단계 실행 금지.

## v0.3 — 공통 모델 호출 계약
- 입력에 `task_id`, `max_calls`, `budget_remaining_usd`, `context_scope`, `artifact_version`을 포함한다.
- 출력에 `llm_calls`, `estimated_cost_usd`, `cache_reused`, `fallback_used`를 기록한다.
- Creator의 장면 편집·음악 태그 매칭·SNS 게시, Schedule의 명확한 조회는 코드/Tool로 우선 처리한다. Diary만 필요한 사실 요약을 소형 LLM에 전달한다.
