# 해주미 `/api/v1` API 초보자 안내서

PC 웹은 최초 Bearer 인증을 `POST /api/v1/auth/web-session`으로 교환해 30일 HttpOnly·SameSite=Strict 쿠키를 받습니다. 이후 웹은 같은 출처의 쿠키로 `/api/v1`을 호출하며 쓰기 요청에는 `Origin`과 `X-Haejumi-Web: 1` 검사를 적용합니다. `GET /auth/web-session`은 로그인 상태 확인, `DELETE /auth/web-session`은 서버 세션 폐기와 쿠키 삭제입니다. 원본 Bearer 토큰은 웹 저장소에 두지 않으며 Android의 기존 Bearer API는 유지됩니다. 로컬 웹 접속 주소는 `http://127.0.0.1:5173`으로 통일합니다.

## OpenAI 연결 준비 (2026-11-03)

서버는 `HAEJUMI_OPENAI_API_KEY`/`HAEJUMI_OPENAI_MODEL` 또는 기존 `.env`의 `OPENAI_API_KEY`/`OPENAI_MODEL`을 읽습니다. 키 존재만으로 외부 요청을 허용하지 않습니다. `HAEJUMI_OPENAI_LIVE_ENABLED` 기본값은 `false`이며, 기존 `HAEJUMI_LLM_ENABLED`와 함께 명시적으로 켜야 제공자 어댑터가 활성화됩니다. 활성화 후에도 요청별 PrivacyGate 동의, 작업·일·월 비용 한도가 적용됩니다. 2026-11-04 사용자가 승인한 합성 문장 1건만 격리된 일회성 게이트웨이에서 실제 Responses API로 검증했습니다. 운영 서버의 실호출 스위치는 켜지 않았습니다.

`POST /api/v1/assistant/messages`는 기존 정확한 로컬 명령을 우선 처리합니다. 유효한 `privacy_consent_id`가 있는 일반 텍스트는 활성화된 Gateway가 OpenAI Responses JSON 해석을 시도할 수 있습니다. 해석 결과는 허용된 Schedule·Wellness·Diary 로컬 명령 형식이거나 Creator 라우팅일 때만 채택합니다. 기록 쓰기는 실행 제안으로 돌아오며 `/assistant/proposals/{id}/confirm`에 사용자가 별도 요청해야 저장됩니다. 종료 시간이 빠진 일정 요청은 질문으로 돌려주며 저장하지 않습니다. 해석 실패나 동의 부재 시 규칙 기반 동작을 유지합니다.

예투의 인사·감정 표현·일상 대화는 기록 요청과 구분합니다. 동의된 현재 문구만 OpenAI 텍스트 해석에 전달하며 과거 대화나 저장된 Schedule·Wellness·Diary 기록은 이 경로에서 전송하지 않습니다. AI 비활성 상태에서는 짧은 로컬 응답만 가능하므로 자유 대화 품질이 제한됩니다. 인증된 `GET /assistant/history`는 최근 30일·최대 100개의 로컬 대화를 조회하고 `DELETE /assistant/history`는 현재 저장소의 대화 이력을 지웁니다. 백업에 이미 복사된 과거 이력은 별도 백업 삭제 정책을 따라야 합니다. 과거 이력은 화면에 표시하며 외부 AI 프롬프트에 자동 첨부하지 않습니다.

일기 AI 초안은 `GET /privacy/processing-notice?provider_id=openai&purpose=diary_draft`의 고지를 확인한 뒤, 그 초안에 사용할 Schedule·Wellness 기록 ID만 `resource_ids`로 지정한 동의를 별도로 만들어야 요청할 수 있습니다. `POST /diaries/drafts`에는 같은 `allowed_source_ids`, 직접 쓴 `user_notes`, `privacy_consent_id`를 보냅니다. 서버는 선택한 일정 제목·기분·수면·활동 시간과 직접 쓴 메모만 전달하며 상세 메모와 다른 날짜의 기록은 제외합니다. Gateway 비활성·동의 거부·비용 제한·제공자 오류 시 로컬 초안으로 대체합니다. AI 초안은 정식 저장본이 아니며 중간 승인과 현재 버전의 최종 승인이 별도로 필요합니다.

`POST /backups`는 인증된 사용자의 로컬 상태·미디어·음원·렌더·업로드 파일을 SHA-256 manifest와 함께 별도 디렉터리에 복사합니다. `POST /backups/{backup_id}/restore-copy`는 소유권·해시·JSON 형식을 검증한 뒤 별도의 복구 사본을 만듭니다. 운영 중인 데이터는 자동 교체하지 않습니다. 복구 사본의 활성화와 기기 간 백업 전달은 후속 운영 절차입니다.

PC 웹 다중 업로드는 `POST /media/uploads`로 세션을 만든 뒤 각 `PUT /media/uploads/{upload_id}/parts/{number}`를 전송하고 `POST /media/uploads/{upload_id}/complete`로 목록·순서·SHA-256을 확인합니다. 파일당 기본 상한은 50 MiB(`HAEJUMI_MAX_MEDIA_BYTES=52428800`), 기본 선택 수는 20개입니다. 실패 후 같은 멱등 키로 세션을 조회해 `accepted_items[].received_parts`에 있는 조각은 다시 보내지 않습니다. 파일을 특정할 수 있는 검증 오류에는 안전한 1부터 시작하는 `error.item_index`와 `error.field`만 포함하며 파일 내용이나 로컬 경로는 응답하지 않습니다. `file_structure`는 JPEG/영상 컨테이너 구조 검사 실패를 뜻합니다. 완료된 파일 목록과 순서를 유지한 채 재시도하거나 문제 파일만 제외할 수 있습니다.

렌더 서버는 시작 시 FFmpeg·ffprobe 실행 파일을 확인합니다. `HAEJUMI_FFMPEG_PATH`와 `HAEJUMI_FFPROBE_PATH`로 절대 경로를 지정할 수 있고, 없으면 PATH와 Windows의 Gyan.FFmpeg WinGet 설치 위치를 확인합니다. 실행 파일을 찾지 못하면 서버 시작 단계에서 오류가 납니다. 렌더 작업의 `progress_percent=5`는 인코딩 진행률이 아니라 작업 단계 표시입니다. 실패한 작업은 `safe_error_code`, `failure_stage`, 허용된 숫자형 `ffmpeg_exit_code` 및 제한된 `diagnostic_code`만 제공합니다. 원본 FFmpeg stderr에는 개인 파일 경로가 들어갈 수 있어 API나 상태 파일에 저장하지 않습니다. 기존 버전의 기획·초안 중간 승인이 유효한 실패 작업은 `GET /tasks/{task_id}/draft`로 승인된 초안을 계속 조회하고, 새 멱등 키로 렌더를 다시 요청할 수 있습니다. 재시도 응답은 HTTP 202와 새 `job_id`이며 이전 작업 및 승인 이력은 유지됩니다.

`GET /api/v1/llm/usage`는 서버의 사용 가능 상태, 일·월 예약 비용과 설정 한도를 인증된 사용자에게 보여줍니다. PC 웹 설정에서 예투 텍스트 해석 고지를 읽고 24시간 동의를 저장하거나 철회할 수 있습니다. 이 화면은 키 값이나 토큰을 표시하지 않습니다. 예약 비용은 실제 청구 금액이 아닙니다.

## 다중 선택 업로드 (2026-11-03)

사용자가 직접 선택한 사진·영상만 `POST /api/v1/media/uploads`의 `items` 배열에 순서대로 선언합니다. 기본 상한은 20개이며 서버 설정 `HAEJUMI_MAX_SELECTED_MEDIA`로 1~30개 사이에서 변경할 수 있습니다. 여러 항목이면 `PUT /media/uploads/{upload_id}/parts/{part_number}`의 번호가 1부터 시작하는 파일 순서입니다. 파일마다 한 조각으로 전송하며 각 요청은 별도 멱등 키를 사용합니다. 완료 요청에는 순서대로 정렬한 `items`와 canonical JSON SHA-256인 `manifest_sha256`을 함께 보냅니다. 단일 항목 완료 요청은 기존처럼 `items`를 생략할 수 있습니다. 완료 응답의 `media` 순서대로 `media_ids`를 프로젝트 생성 요청에 넣습니다. 프로젝트 조회의 `media_manifest`에는 순서·media_id·검증된 SHA-256이 기록됩니다. 부분 전송 실패 후 같은 세션과 멱등 키로 재시도할 수 있습니다.

기획이 생성된 후 `PUT /api/v1/tasks/{task_id}/plan`에 현재 `content_version`, `content_hash`, `scenes`를 보낼 수 있습니다. 각 scene은 `media_id`, `duration_seconds`, 영상인 경우 선택적인 `trim_start_seconds`를 담습니다. 모든 미디어 ID는 한 번씩 들어가야 하며 길이 합은 프로젝트 목표 초와 같아야 합니다. 저장하면 새 버전과 대기 중인 기획 체크포인트가 생성되고 이전 승인이 무효화됩니다. 렌더는 이 순서·시간·영상 시작 위치를 사용합니다.

> 상태: OpenAPI 3.1 계약 v0.5 **[제안/승인 대기]**  
> 사양 원본: [`openapi-v1.yaml`](openapi-v1.yaml)  

## 2026-11-03 개인 기록 API 추가 범위

인증된 단일 사용자의 로컬 상태에 `schedule/events`, `wellness/entries`, `diaries/drafts`, `diaries/entries` 경로를 추가했습니다. 모든 경로는 `/api/v1` 아래에 있고 Bearer 인증과 소유권 검사를 거칩니다. 쓰기에는 `Idempotency-Key`가 필요하며 수정·삭제에는 현재 `version`, 일기 초안 수정에는 `base_content_version`이 필요합니다. 충돌은 HTTP 409로 응답합니다.

- 일정: 생성·날짜별 조회·수정·소프트 삭제. 반복 규칙과 알림 시간은 저장하지만 반복 일정 전개 및 실제 알림 발송은 아직 구현되지 않았습니다. PC가 꺼져 있을 때 알림은 보장되지 않습니다.
- 생활 기록: 기분·수면·활동·습관·메모의 생성·조회·수정·소프트 삭제와 날짜 범위의 설명적 요약. 의료 진단이나 치료 권고가 아닙니다.
- 일기: 명시적으로 고른 같은 날짜·같은 사용자 기록만 초안에 포함합니다. 초안 수정은 버전과 해시를 바꾸고 승인을 무효화합니다. `continue` 중간 승인 후 `final_diary` 별도 승인과 현재 버전·해시·승인 ID가 일치할 때에만 정식 저장합니다. 저장본 수정은 아직 지원하지 않습니다.

이 API는 PC 웹과 Android의 초기 기록 화면에 연결됐습니다. 아래 규칙 기반 자연어 명령은 자동 테스트 범위에서만 확인했습니다. 실기기 동기화 및 백업·복구는 아직 검증되지 않았습니다.

### 추가된 로컬 작업 흐름

`GET /api/v1/schedule/occurrences?from=YYYY-MM-DD&to=YYYY-MM-DD`는 366일 이내의 반복 발생일을 조회합니다. 원래 입력한 숫자 UTC 오프셋을 사용하므로 일광절약시간제 전환은 아직 처리하지 않습니다. 알림 발송은 D126에 따라 구현하지 않습니다.

`POST /api/v1/diaries/entries/{entry_id}/revisions`는 현재 저장본 `version`으로 수정 초안을 만듭니다. 이후 초안을 수정해도 저장본은 그대로이며, 새 초안의 중간 승인과 별도 최종 승인·finalize를 모두 거친 경우에만 저장본 버전과 이력이 갱신됩니다.

예투의 로컬 텍스트 명령은 `일정 등록 YYYY-MM-DD HH:MM HH:MM 제목`, `일정 조회 YYYY-MM-DD`, `기분 기록 YYYY-MM-DD 좋음`, `생활 조회 YYYY-MM-DD`, `일기 초안 YYYY-MM-DD 내용`, `일기 조회 YYYY-MM-DD` 형식을 우선 지원합니다. 세미콜론으로 최대 네 작업을 분리합니다. 읽기는 즉시 조회하고 쓰기는 `/assistant/messages`가 제안을 돌려주며, 사용자가 각 `proposal_id`를 `POST /api/v1/assistant/proposals/{proposal_id}/confirm`으로 확인한 뒤에만 저장합니다. 일기 초안 명령은 사용자 입력 내용만 사용하고 저장본 최종 승인을 수행하지 않습니다.
> 경로·상태·오류 기준: [`09-API-CONTRACT.md`](09-API-CONTRACT.md)

이 문서는 앱과 PC 서버 사이의 약속을 쉬운 말로 풀이합니다. 아직 사용자 승인과 정식 OpenAPI 검증 전이므로 실제 구현 계약으로 간주하지 않습니다.

## API가 하는 일

API는 Android 앱이 PC 서버에 “선택한 파일을 올려 주세요”, “이 버전으로 영상을 렌더해 주세요”, “이 게시물을 승인합니다”처럼 요청할 때 사용하는 약속입니다. 모든 경로는 `/api/v1`로 시작합니다.

## 모든 요청에 적용되는 권한 규칙

1. 로그인 토큰을 확인합니다. 토큰은 요청자의 신원만 증명합니다.
2. 서버는 요청에 적힌 `user_id`를 소유권 증거로 믿지 않습니다. 인증된 사용자를 소유자로 삼아 모든 파일·프로젝트·작업·승인 ID와 부모 관계를 검사합니다.
3. 소유권이 없거나 리소스가 없으면 같은 `404 RESOURCE_NOT_FOUND`로 답해 ID를 추측할 수 없게 합니다.
4. Agent별 허용 범위도 확인합니다. Creator는 사용자가 선택한 미디어·Creator 프로젝트만 기본 접근하고 Diary/Wellness 원문을 열람하지 않습니다. Diary는 해당 날짜에 사용자가 허용한 자료만 받습니다. 확장 모듈은 Registry에 선언된 scope만 가집니다.
5. 권리, 승인, 외부 전송 동의는 각각 별도 확인합니다. 한 종류의 승인이 다른 종류 권한을 대신하지 않습니다.

## 외부 AI 전송: 공통 PrivacyGate

외부 LLM·STT·비전·분석 서비스로 나가는 모든 요청은 API 경로나 Agent에 관계없이 Backend의 공통 PrivacyGate/LLMGateway를 거쳐야 합니다. 서버는 제공자 허용 목록, 목적, 데이터 종류, 소유권, 최소 전송 범위, 현재 동의 상태를 요청을 받을 때와 실제 네트워크 전송 직전에 확인합니다.

동의가 없거나, 철회·만료됐거나, 전송 범위가 동의와 다르거나 검사를 완료할 수 없으면 PrivacyGate가 provider dispatch를 거부해 외부 요청을 **0회** 발생시킵니다. Creator plan API는 안전한 local-rules fallback 결과를 반환하고 `generation.gate_reason`에 사유를 담습니다. 현재 동기식 plan 흐름에는 대기 중 provider job이 없습니다. 사용자의 문장, STT 전사문, 중간 승인 또는 게시 승인은 외부 전송 동의가 아닙니다.

Vision 공급자 실패는 앞으로 `generation.gate_reason`에 인증·요청 거부·응답 형식·시간 초과·네트워크·공급자 오류를 구분해 기록합니다. 공급자가 반환한 경우에만 `generation.diagnostic.provider_http_status`와 안전한 요청 ID를 기록하며 오류 본문·이미지·키는 저장하지 않습니다. 출력 검증 실패는 `generation.validation_field`에 필드 범주 코드만 남깁니다. 요청별 예약이 시작된 뒤 실패한 경우 `generation.llm_calls`와 예약 추정액을 유지하며, 실제 공급자 도달·과금 여부와 구분해야 합니다. 이전 기록의 포괄적인 `SERVICE_UNAVAILABLE`은 세부 오류를 소급 복원할 수 없습니다.

Vision 시간 초과 진단은 비민감 수치만 남깁니다. `generation.diagnostic`에는 로컬 샘플 준비 시간·성공/실패 개수·준비된 총 바이트, Gateway 경과 시간, Provider의 단계(`waiting_headers`, `reading_body`, `validating_output`), 경과/설정 제한 시간, JSON 요청 바이트 수, 로컬 fetch 호출 여부, 응답 헤더/본문 도착 여부를 기록합니다. Vision 제한은 `HAEJUMI_OPENAI_VISION_TIMEOUT_MS`로 설정하며 기본 60초이고, 다른 LLM 요청은 기존 `HAEJUMI_OPENAI_TIMEOUT_MS` 기본 20초를 사용합니다. Node HTTP 서버의 기본 요청 제한 300초보다 짧습니다. 실제 요청 경과 시간은 Provider가 fetch를 호출하기 직전부터 측정합니다. `waiting_headers`에서 제한 시간이 끝나면 로컬 요청 시작은 확인되지만 공급자 도달·과금 여부는 확인되지 않습니다. 응답 원문, 프롬프트, 미디어, 인증값은 기록하지 않습니다. 자동 재시도는 하지 않으며, 시간 초과 후 재요청은 별도 사용자 동작 및 기존 비용 제한을 따릅니다.

Creator 기획 요청 문구는 게시 제목으로 사용하지 않습니다. 로컬 대체 기획의 `publication_suggestions`는 제목·설명·해시태그가 비어 있어 사용자 작성이 필요합니다. Vision 기반 초안은 검증 가능한 `media_insights`의 분류·피사체에서 플랫폼별 문구를 만들며, 오래된 기획의 요청 문구나 공급자 원문 게시 문구를 PC 웹에서 그대로 가져오지 않습니다. 확인되지 않은 맛·가격·장소·방문 평가는 사용자가 직접 확인해야 합니다. 게시 정보 저장과 플랫폼별 최종 승인은 기존 버전·권리 검사를 그대로 거칩니다.

## Creator 사진·영상 제작 흐름

프로젝트 목표 길이는 3~59초 정수이며 기본 30초입니다. 렌더 요청은 `vertical_9_16_h264_aac` 프로필과 승인된 프로젝트의 `fit_pad`(기본) 또는 `fill_crop` 초점 설정을 사용합니다. plan checkpoint와 자막·오디오 구성 초안 checkpoint에 각각 `continue` 승인이 있어야 `render_ready`가 됩니다. 테스트 렌더 결과는 `simulated`로 표시되고 MP4 미리보기로 제공되지 않습니다.

1. **선택 파일 업로드:** 앱은 사용자가 Photo Picker에서 직접 고른 파일만 업로드 세션에 선언합니다. 서버는 실제 파일 유형·크기·SHA-256을 검사합니다. 업로드가 게시 권한을 만들지는 않습니다.
2. **프로젝트와 작업:** 프로젝트는 원본 미디어와 편집 결과를 묶습니다. 참조 API는 소유자 미디어만 연결하고 응답 `task_id`와 `waiting_plan_approval` 작업, 기획 checkpoint를 만듭니다. API 초안 전체는 계약 승인 대기 상태입니다.
3. **기획·중간 확인:** `GET /tasks/{id}/checkpoints`로 `plan`을 확인하고 `POST /tasks/{id}/approvals`에 같은 버전/hash의 `continue` 승인을 제출합니다. 승인 뒤 draft checkpoint가 만들어집니다.
4. **초안 확인과 렌더:** 자막과 선택한 음원·원음/BGM 음량·페이드를 확인하고 수정합니다. 새 버전의 plan과 draft를 각각 승인한 뒤 `POST /tasks/{id}/render`는 프로젝트에 연결된 소유자 미디어만 큐에 넣습니다. `GET /jobs/{id}`로 상태 조회, `POST /jobs/{id}/cancel`로 취소할 수 있습니다. 이전 버전의 무음 렌더는 호환성을 위해 그대로 처리됩니다.
5. **인증된 미리보기:** `GET /tasks/{id}/preview?content_version=...`는 같은 소유자의 최신 버전만 제공합니다. 실제 MP4는 ffprobe 검증 성공 시에만 `video/mp4`로 반환합니다.
6. **권리 확인:** 권리 상태는 대문자 `ALLOW`, `REVIEW`, `BLOCK` 중 하나입니다. `ALLOW`만 게시 후보이며, 서버는 게시 직전 다시 검사합니다.
7. **최종 게시 승인:** 정확한 콘텐츠 버전/hash, 렌더 파일 hash, 플랫폼, 계정, 공개범위, 문구를 한 승인에 묶습니다.
8. **게시 요청:** 서버가 현재 결과·승인·권리·계정 권한·멱등 기록을 재검사합니다. 불명확한 조건은 차단합니다.

### 예투 라우팅·Creator 기획

PC 웹과 Android는 서버 데이터를 공통으로 사용합니다. 참조 구현의 `GET /content/projects`는 인증된 소유자의 프로젝트 목록을 새 항목 우선으로 반환하고, `GET /tasks/{task_id}/jobs`는 소유 작업의 렌더 이력을 반환합니다. 화면은 작업의 현재 `content_version`/`content_hash`와 체크포인트를 다시 조회해 승인 상태를 표시하고, 수정 충돌 `409` 뒤 최신 상태를 불러와야 합니다. 두 목록 경로는 참조 구현의 상태 복원을 위한 추가 경로이며 OpenAPI 전체 승인 대기 상태는 유지됩니다.

`GET /capabilities`는 Creator·Schedule·Wellness·Diary 등록 상태와 확장용 Blog·Music 비활성 상태를 알려줍니다. `POST /assistant/messages`는 한국어 규칙 기반으로 한 Agent를 선택합니다. 요청이 여러 Agent에 걸치거나 분류되지 않으면 질문을 되돌리고, 계획 상태인 Agent는 등록됐지만 아직 기능을 실행하지 않는다고 답합니다. 기획을 만들려면 사용자 인증된 Creator `task_id`가 필요합니다.

Creator의 `POST /tasks/{task_id}/plan`은 그 프로젝트에 연결된 선택 미디어만 사용해 구조화된 쇼츠 장면 기획과 자막 초안을 만듭니다. 기획은 콘텐츠 버전/hash와 `plan` 중간 승인 checkpoint에 저장됩니다. `GET /tasks/{task_id}/plan`으로 현재 기획을 읽을 수 있습니다. 자막은 기획 승인 뒤 `GET /tasks/{task_id}/draft`에서 표시되며, 별도 `draft` 승인 전에 렌더할 수 없습니다. 기획을 수정하면 새 콘텐츠 버전이 되고 이전 승인은 모두 무효화됩니다.

기획 생성 요청은 현재 task 버전인 `content_version`과 비어 있지 않은 `request_text`, `Idempotency-Key`가 필수입니다. 선택적으로 `privacy_consent_id`를 전달할 수 있습니다. 새 요청에 오래된 버전을 사용하면 `409 VERSION_CONFLICT`이며, 동일 멱등 키와 동일 요청의 재전송은 기록된 결과를 반환합니다. 성공하면 새 버전의 기획과 체크포인트가 `201`로 반환됩니다. 이 경로의 참조 구현은 `base_content_version`을 받지 않습니다.

### 자막·로컬 음악 편집

1. `POST /music/tracks`에 제목, 아티스트, `format`(`wav` 또는 `mp3`), `size_bytes`, SHA-256과 `rights`를 등록합니다. `PUT /music/tracks/{track_id}/content`에 사용자가 고른 원본 바이트를 `application/octet-stream`으로 업로드합니다. 두 쓰기 요청에 각각 `Idempotency-Key`가 필요합니다. `GET /music/tracks`는 본인 목록만 반환합니다.
2. `rights`는 `source_url`, `license_name`, `license_version`, `license_url`, `evidence`, `downloaded_at`(YYYY-MM-DD), `attribution_required`, `required_attribution`, `commercial_allowed`, `platforms`, `explicitly_verified`를 기록합니다. 미확인 항목은 빈 문자열·false·빈 배열로 둘 수 있습니다. `user_verified`는 사용자의 확인 기록이며 법률 검증 보증이 아닙니다. `PATCH /music/tracks/{track_id}/rights`는 `rights_revision`과 새 `rights`를 받아 관련 최종 게시 승인을 무효화합니다.
3. plan 승인 후 `PATCH /tasks/{task_id}/draft`에 현재 `content_version`/`content_hash`, 순서·시작/끝 초·텍스트로 된 `captions`, `captions_enabled`, `music_track_id`(사용하지 않으면 null), `source_volume`, `music_volume`, `fade_in_seconds`, `fade_out_seconds`를 모두 보냅니다. 음량은 0~2, 페이드는 각각 0~10초이며 영상 길이의 절반을 넘을 수 없습니다. 편집은 새 버전과 plan 체크포인트를 만들며 과거 승인을 무효화합니다. 새 plan과 draft를 재승인해야 렌더할 수 있습니다.
4. 자막은 항목당 최대 80자, 최대 30개이며 지원 한글·ASCII·일부 문장부호를 사용합니다. 자막 시간은 한 장면 안에 있어야 하고 서로 겹치지 않아야 합니다. 한 장면에 여러 자막 또는 자막 없는 구간을 둘 수 있습니다. 장면의 `caption_text`는 제안일 뿐 렌더 자막은 `captions` 목록만 사용합니다. 로컬 규칙 기획은 시각 분석 자막을 생성하지 않으므로 PC 웹에서 문구와 시작·종료 시간을 직접 작성합니다. 임시 문구와 기획 지시문은 저장·렌더 전에 거부합니다. Noto Sans KR과 FFmpeg/libass로 1080×1920의 보수적 안전 영역에 합성합니다. 실제 플랫폼 UI별 안전 영역은 기기 검증 전입니다.
5. 음원 권리가 미확인이면 비공개 미리보기는 가능하지만 해당 플랫폼의 최종 게시 승인에서 `403 RIGHTS_REVIEW_REQUIRED`로 차단됩니다. 상업 이용·플랫폼·출처·라이선스 버전·증빙·다운로드일이 확인되고, 필요한 출처 표기가 게시 설명에 포함되어야 합니다. 다른 자산에 대한 완전한 권리 검사는 아직 구현되지 않았습니다.

원본 영상에 소리가 있고 `source_volume`이 0보다 크면, 각 영상에 대해 선택 항목 `source_audio_rights`로 `media_id`, `explicitly_verified`, `commercial_allowed`, 허용 `platforms`, `evidence`, `attribution_required`, `required_attribution`을 기록해야 해당 플랫폼의 최종 게시 승인을 받을 수 있습니다. 생략하면 기존 확인 정보가 유지됩니다. 원본 오디오 권리가 불명확하면 음량을 0으로 설정하거나 권리 확인 후 새 버전을 승인해 주세요.

외부 처리를 요청하려면 먼저 `GET /privacy/processing-notice?provider_id=openai&purpose=vision_analysis`의 제공자·목적·전송 범위·보존 고지를 사용자에게 보여 주세요. 사용자가 확인한 경우에만 그 고지 ID/버전, 목적 `vision_analysis`, `selected_media`·`user_text` 범위와 정확한 업로드 미디어 `resource_ids`를 담아 `POST /privacy/consents`를 호출합니다. 동의 저장은 그 자체로 OpenAI를 호출하지 않습니다. Creator 요청에 반환된 `consent_id`를 `POST /assistant/messages` 또는 `/tasks/{task_id}/plan`의 `privacy_consent_id`로 전달해야 하며, 동의된 resource ID와 요청 프로젝트의 미디어 ID가 정확히 일치해야 합니다. 철회는 `DELETE /privacy/consents/{consent_id}`입니다.

실제 OpenAI 처리는 다음 조건이 모두 있을 때만 가능합니다: `HAEJUMI_LLM_ENABLED=true`, `HAEJUMI_OPENAI_LIVE_ENABLED=true`, `.env`의 API 키와 모델 설정, 유효한 소유자 동의, Gateway 예산 허용, PrivacyGate의 마지막 권한 검사. 기본값은 비활성입니다. PC 웹은 로컬 기획과 Vision 기획을 별도 버튼으로 구분하며, Vision 동의 전에 프로젝트 media_id, 전송 상한, 업체·목적·예약 비용을 표시합니다. 서버는 사진을 로컬에서 긴 변 최대 1024px로 축소하고 메타데이터를 제거하며, 선택 영상은 로컬 FFmpeg에서 최대 768px 프레임 하나를 뽑습니다. 기본 최대 5개의 준비된 이미지만 media_id별로 표시해 OpenAI Responses API 입력에 포함하고 출력은 6,000 token 상한을 적용합니다. 상한과 예약 비용은 `/privacy/processing-notice`가 서버 설정에 맞춰 반환합니다. 파일 원본이나 갤러리 전체, 일기·건강 기록은 보내지 않습니다. `store=false`도 제공자 보존에 관한 보증은 아니므로 고지에 있는 제공자 정책을 확인해야 합니다. OpenAI 출력은 장면별 설명·불확실성·스토리·자막 형식을 검증한 후 Creator 기획/자막 초안으로 저장되고, 사용자 기획·초안 승인은 계속 필요합니다. 미분석 미디어 내용은 AI가 확인한 사실로 표시하지 않습니다.

Vision 응답의 전체 기획 형식이 맞지 않아도 선택 미디어 ID와 장면에 연결되고 검증을 통과한 `captions[].text` 또는 장면별 `caption_text`만 자막 초안으로 부분 반영할 수 있습니다. 부분 반영은 생성 출처와 함께 표시하며, 안전하지 않은 임시 문구·기획 지시문·근거 없는 평가를 자막으로 복사하지 않습니다. 검증 가능한 자막이 없거나 제공자 요청이 실패하면 로컬 빈 자막 초안으로 돌아갑니다. 기획 승인 전 `GET /tasks/{task_id}/draft`는 열리지 않으며, 승인 후 자막 시간·문구를 확인하고 초안을 별도 승인해야 렌더할 수 있습니다. 기존 프로젝트에서 같은 미디어 ID로 새 기획을 요청할 수 있지만 새 콘텐츠 버전이 생성되고 이전 승인은 무효화됩니다.

### 장면별 효과와 트렌드 메타데이터 (2026-11-04)

Creator 기획 장면에 `framing`(`inherit`/`fit_pad`/`fill_crop`/`blur_pad`), `motion`(`static`/`zoom_in`/`zoom_out`/`pan_left`/`pan_right`), `transition`(`cut`/`fade`), `subtitle_style`(`default`/`emphasis`/`information`), `bgm_mood`, `edit_reason`을 선택적으로 저장합니다. 기존 프로젝트에 필드가 없으면 기존 정적 렌더와 동일한 기본 효과를 사용합니다. `PUT /tasks/{task_id}/plan`에서 효과를 바꾸면 콘텐츠 버전이 증가하고 현재 기획·초안·최종 승인을 다시 확인해야 합니다. `bgm_mood`는 제안 정보이며 사용 권리가 검증된 실제 음원을 자동으로 선택하지 않습니다.

Creator 기획안의 `publication_suggestions`는 YouTube·TikTok·Instagram별 제목·설명·해시태그 **초안**입니다. PC 웹은 사용자가 해당 문구를 불러와 직접 수정하게 하며 계정·공개범위는 AI가 설정하지 않습니다. 게시 정보 저장, 영상 미리보기, 플랫폼별 최종 승인과 실제 게시 금지는 기존 규칙을 따릅니다.

인증된 `GET /trends/status`는 외부 API 호출 없이 검색 활성화 상태와 제한을 반환합니다. `GET /trends/search?topic=restaurant|cafe|travel&days=30`은 YouTube Data API 메타데이터 검색입니다. `days`는 1~90일이며 라이브 사용에는 서버 측 `HAEJUMI_YOUTUBE_API_KEY` 또는 `YOUTUBE_API_KEY`와 `HAEJUMI_TRENDS_LIVE_ENABLED=true`가 필요합니다. 활성화 시 캐시가 없는 한 번의 검색에 `search.list`와 `videos.list` 최대 2회, UTC 하루 10회까지 예약합니다. 성공 결과는 서버 메모리에 15분 보관하며 서버 재시작 시 비워집니다. 결과는 제목·설명 일부·링크·게시일·조회수·좋아요·댓글·길이만 표시하며 짧은 영상 메타데이터로 한정합니다. 영상·음원·자막을 다운로드하거나 내부 편집 효과를 분석하지 않습니다. 비활성·할당량 초과·응답 실패 시 `analysis_scope=none` 로컬 안내로 돌아갑니다. 실제 API 호출은 사용자가 PC 웹에서 검색을 누를 때만 실행합니다.

PC 웹의 장면별 자동 혼합 편집은 현재 검색 결과의 주제·키워드와 **기존에 검증된 Vision 장면 분류**를 결합해, 서버가 이미 지원하는 크롭·블러 배경·줌·팬·컷·페이드·자막 스타일만 제안합니다. 검색 메타데이터로 참고 영상의 컷 길이나 효과를 알아낼 수 없으므로 연출은 해주미 자체 추천으로 구분합니다. 사용자가 제안을 검토·수정한 후 `PUT /tasks/{task_id}/plan`으로 저장할 때 선택적 `trend_query: {topic, days}`를 보내면 서버는 해당 15분 캐시에서 최신·관련 결과만 다시 확인하고 출처·조회시각·키워드·영상 링크를 `plan.trend_reference`에 기록합니다. 캐시가 없거나 오래되면 409 `TREND_CACHE_MISSING`이며 검색 API를 자동 호출하지 않습니다. `trend_query: null`은 이전 참고 기록을 지웁니다. 검색 실패 시 로컬 효과 제안만 가능하며 Vision 정보가 없는 미디어에는 내용을 추측하지 않는 기본 효과를 적용합니다. 장면 저장은 기존 콘텐츠 버전 증가와 승인 무효화를 유지합니다.

현재 외부 호출 기본 비활성화이며 이번 테스트에서는 Mock/가짜 `fetch`만 사용합니다. 초기 한도는 설정 가능한 제안값으로 일 `$0.20`, 월 `$5`, 작업당 5회입니다. 준비 미디어당 예상비용은 보수 예약 설정값이지 청구액 보증이 아닙니다. 예산 예약은 로컬 state에 기록하고 timeout이나 애매한 결과는 자동 재호출하지 않습니다.

## 승인 종류는 서로 바꿔 쓸 수 없습니다

| checkpoint 종류 | 허용 scope | 뜻 |
|---|---|---|
| `plan`, `draft`, `preview` | `continue` | 확인한 단계에서 다음 단계로 진행 |
| `final_publish` | `final_publish` | 특정 영상 버전과 게시 대상을 최종 승인 |
| `final_diary` | `final_diary` | 특정 일기 버전을 정식 저장하도록 최종 승인 |
| 그 밖의 조합 | 없음 | 서버가 `409 APPROVAL_SCOPE_MISMATCH`로 거부 |

외부 전송 동의는 `consent_id`와 `active/revoked/expired` 상태로 별도 관리합니다. 중간 승인은 게시나 일기 저장을 허용하지 않고, 게시 승인도 외부 AI 전송이나 일기 저장을 허용하지 않습니다. 음성 명령은 사용자가 승인 화면에서 확인하는 절차를 대신할 수 없습니다.

현재 참조 서버에서는 선택한 파일 하나마다 업로드 세션 하나를 만들고 `part 1`로 파일 전체를 보냅니다. 파일명 경로문자·지원 형식과 확장자 불일치·파일 크기·서명/컨테이너 구조·SHA-256을 확인합니다. manifest의 현재 정규화 규칙은 한 항목 기준 제안이며 승인 대기입니다. 검사기는 구조 오류를 걸러내지만 이미지나 영상의 모든 코덱을 디코딩한다고 보장하지 않습니다.

완료 요청 재시도는 동일 manifest의 import/media/proposal을 반환합니다. 프로젝트 생성은 별도 요청이며, 같은 소유자·미디어 순서·설정이면 새 멱등 키를 사용해도 기존 프로젝트와 task를 반환합니다.

## 버전과 hash

- `content_version`은 편집 내용 버전입니다. source 미디어 순서·컷·자막·음악·license 참조·렌더 설정처럼 결과에 영향을 주는 변경은 새 버전과 `content_hash`를 만듭니다.
- `content_hash`는 제안상 정규화된 불변 버전 manifest의 SHA-256입니다. 정확한 canonical JSON 규칙은 승인 대기입니다.
- `artifact_sha256`은 만들어진 MP4 파일 바이트 자체의 SHA-256입니다.
- 최종 게시 승인은 콘텐츠 hash, MP4 hash 및 게시 대상 정보를 함께 묶습니다. 해시 또는 버전이 다르면 `409 STALE_APPROVAL` 또는 `409 VERSION_CONFLICT`로 거부합니다.
- 새 콘텐츠 버전은 그 작업의 과거 중간·최종 승인을 모두 무효화합니다. 과거 편집으로 되돌려도 승인은 살아나지 않습니다. 플랫폼·계정·공개범위·문구 변경은 최종 게시 승인과 권리 검사를 다시 요구합니다.

## 네트워크 오류와 중복 게시 방지

게시를 시작하기 전에 서버가 `Idempotency-Key`와 요청 fingerprint를 기록하고 durable outbox에 게시 job을 저장한다는 설계입니다. 같은 키와 같은 요청을 다시 보내면 기존 `publish_id`를 돌려줘야 합니다. 같은 키를 다른 요청에 재사용하면 `409 IDEMPOTENCY_CONFLICT`입니다.

영상이 플랫폼에 올라간 직후 연결이 끊겨 성공 여부를 모르면 작업은 `outcome_unknown`이 됩니다. 서버는 새 업로드를 자동으로 시작하지 않습니다. 공식 플랫폼 API로 기존 upload/operation ID를 조회하고 결과를 `reconciling` 절차로 맞춥니다. 성공을 찾으면 기존 `publish_id`를 성공으로 갱신하고, 실패가 명확할 때만 실패로 기록합니다. 조회할 수 없거나 결과가 여러 개면 `needs_user_action`으로 보류하고 사용자에게 확인을 요청합니다.

멱등 보존 기간, 플랫폼별 결과 조회 가능 여부, 같은 artifact의 새 승인 후 재게시 허용은 모두 제안·승인 대기입니다.

## 플랫폼별 게시 정보와 독립 승인

공통 영상에 YouTube Shorts, TikTok, Instagram Reels용 게시 정보를 각각 저장합니다. `POST /tasks/{task_id}/publications`로 플랫폼별 레코드를 만들고, 목록·단건 `GET`으로 읽으며, `PATCH`로 수정합니다. 레코드에는 계정 ID, 공개범위, 제목, 설명, 해시태그와 revision/hash가 들어갑니다. 한 작업·플랫폼당 레코드 하나만 허용하며 변경은 현재 revision을 보내야 합니다.

`POST /tasks/{task_id}/publications/{publication_id}/approvals`는 그 레코드에 한정된 별도 최종 승인을 받습니다. 현재 영상 버전/hash와 렌더 파일 SHA-256, 게시 정보 revision/hash를 묶습니다. 실제 FFmpeg 성공과 ffprobe 검증 및 미리보기 승인 전에는 `publish_ready`가 되지 않습니다. 테스트 렌더는 조건을 만족하지 않습니다. 게시 정보 수정은 해당 레코드 승인만 무효화하며, 영상 버전 변경은 연결된 모든 플랫폼 승인을 무효화해야 합니다. 중간 승인과 다른 플랫폼의 최종 승인은 재사용할 수 없습니다.

현재 기능은 게시 정보 저장과 승인 상태 관리까지만 합니다. 실제 SNS API 호출과 게시 실행은 없습니다. 공개범위의 플랫폼별 공식 API 매핑은 검증 대기입니다.

## Capability Registry와 미래 Agent

현재 MVP Agent는 Creator, Schedule, Wellness, Diary 네 개입니다. `/capabilities`는 모듈 ID, capability ID, 모듈 버전, 입력 schema 버전, 활성 상태와 scope를 알립니다. ID는 닫힌 enum이 아닌 안정된 문자열이라 Blog·Music 및 새 Agent를 추가해도 기존 enum을 바꾸지 않는 방향입니다.

문자열을 안다고 기능이 켜지지는 않습니다. 서버 Registry에 등록되어 활성화되고 입력 schema·scope 검증을 통과한 capability만 작업을 만들 수 있습니다. 미등록 기능은 `404 CAPABILITY_NOT_FOUND`, 등록됐지만 비활성인 기능은 `403 CAPABILITY_DISABLED`로 제안합니다. Blog·Music은 현재 활성 Agent가 아닙니다.

## 오류 코드를 읽는 법

모든 오류는 `{ "error": { "code": "...", "message": "..." }, "request_id": "..." }` 형태를 제안합니다.

| HTTP | 대표 코드 | 의미 |
|---|---|---|
| `401` | `AUTHENTICATION_REQUIRED` | 로그인 정보가 없거나 만료됨 |
| `403` | `CONSENT_REQUIRED`, `PRIVACY_POLICY_DENIED`, `RIGHTS_BLOCKED`, `RIGHTS_REVIEW_REQUIRED`, `FORBIDDEN` | 로그인은 됐지만 정책·동의·권리·권한이 허용하지 않음 |
| `404` | `RESOURCE_NOT_FOUND`, `CAPABILITY_NOT_FOUND` | 없거나 접근할 수 없는 리소스/기능 |
| `409` | `VERSION_CONFLICT`, `STALE_APPROVAL`, `APPROVAL_SCOPE_MISMATCH`, `IDEMPOTENCY_CONFLICT`, `PUBLISH_ALREADY_EXISTS` | 현재 버전·승인·상태 또는 중복 요청 충돌 |
| `413` / `415` | `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` | 파일 크기 또는 형식 문제 |
| `422` | `VALIDATION_ERROR`, `PLATFORM_NOT_SUPPORTED` | 요청 값이 계약/지원 범위를 벗어남 |
| `429` / `503` | `RATE_LIMITED` / `SERVICE_UNAVAILABLE` | 잠시 후 재시도하거나 서비스 상태 확인 필요 |

비동기 렌더가 실패하면 HTTP 응답 대신 job의 `safe_error_code=RENDER_FAILED`를 사용합니다. 게시 결과 불명은 오류 코드가 아니라 `outcome_unknown` 상태입니다.

## 아직 승인되지 않은 설계

초기 사용자 등록과 인증 토큰 발급, TLS/로컬 네트워크 방식, 동의 고지 UI와 철회 시점, 업로드 크기·조각·재개 규격, manifest canonicalization, 멱등 키 보존 기간, 플랫폼별 reconciliation 지원, account 연결 API, 모듈 입력 schema 호환 정책은 승인 대기입니다. API 전체 제안은 [`09-API-CONTRACT.md`](09-API-CONTRACT.md)에서 확인하실 수 있습니다.
