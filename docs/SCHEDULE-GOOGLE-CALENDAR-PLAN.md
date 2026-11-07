# Schedule Agent · Google Calendar 연동 변경안

상태: Mock 구현 완료, 실제 Google 연동 미구현 · 2026-11-08. 아래의 기존 기준선과 제안은 설계 당시 기록입니다. 이번 구현은 격리된 테스트 데이터에서만 Google 공급자 대역을 사용하며 실제 계정 연결·외부 API 호출은 없습니다.

## 이번에 구현한 경계

- 기존 로컬 `scheduleEvents` CRUD·반복 발생일 조회를 변경하지 않았습니다. 신규 `googleCalendar` 영역은 연결 메타데이터, Google 이벤트 캐시, 변경 제안, 멱등 기록을 소유자별로 보관합니다. 실제 사용자의 JSON 상태는 이번 테스트에서 변경하지 않았습니다.
- 테스트에서만 `MockGoogleCalendar`를 주입합니다. 운영 서버는 공급자·토큰 보관소를 연결하지 않아 상태에 `configured: false`를 반환하고 연결 시작·조회·변경을 거부합니다. Mock 결과를 실제 Google 동기화 완료로 표시하지 않습니다.
- 토큰 보관 인터페이스는 별도 파일의 AES-256-GCM 암호문과 소유자 AAD를 사용합니다. 32바이트 키는 생성자에서 별도로 공급하며 현재 서버의 `.env`나 소스에 키를 추가하지 않았습니다. 운영 연결 전에 키 공급·복구·백업 정책과 실제 Google 어댑터가 필요합니다.
- OAuth 대역은 10분짜리 일회용 `state`, PKCE S256, 정확한 127.0.0.1 콜백 주소, `calendar.events.owned` 권한을 검사합니다. 재시작하면 대기 중인 연결 시도는 만료됩니다.
- Google 일정 생성·수정·삭제는 10분 만료 제안과 별도 확인 요청을 거칩니다. 생성 중복은 같은 날짜의 제목·시간·장소를 조회해 차단하고, 수정·삭제는 최신 ETag를 확인합니다. 결과가 불확실하면 자동 재시도하지 않고 `outcome_unknown`으로 보류합니다. 외부에서 바뀐 일정은 명시적 목록·상세 재조회 때 반영됩니다.
- 신규 API 계약과 실제 경로는 `docs/openapi-v1.yaml` 및 `docs/API-GUIDE.md`에 기록했습니다. PC 웹·Android 연결 화면, 예투의 Google 일정 제안, 실제 OAuth/Calendar 어댑터는 후속 작업입니다. 로컬 직접 입력의 확인 카드도 후속 UI 작업입니다.

## 확인된 기준선

- 로컬 `/api/v1/schedule/events` CRUD는 인증·소유권·멱등 키·버전 충돌을 검사합니다. `/schedule/occurrences`는 반복 규칙의 발생일을 조회합니다. 로컬 모델은 `title`, `start_at`, `end_at`, `notes`, `recurrence`, `reminder_minutes`를 사용합니다.
- 예투의 정확한 일정 등록·조회 명령은 제안을 만들고 별도 확인 후 로컬 저장합니다. 자연어 수정·삭제와 폭넓은 상대 날짜 해석은 아직 없습니다.
- PC 웹과 Android에는 로컬 기록 화면이 있으나 Google 연결 화면은 없습니다. Google OAuth, 토큰 보관, Calendar API 어댑터, 외부 이벤트 ID, 동기화 코드는 없습니다.
- 현재 PC 웹의 직접 일정 입력은 로컬 API를 즉시 호출합니다. 요청하신 미리보기·확인 카드 정책을 적용하려면 이 화면의 저장 동작도 변경해야 합니다.
- 현재 일정 모델에는 하루 종일 일정, 장소, IANA 시간대, 외부 캘린더 ID·이벤트 ID·ETag를 표현할 필드가 없습니다. 기존 로컬 항목과 Google 항목을 자동 병합해서는 안 됩니다.
- Schedule 알람·푸시·로컬 알림 실행은 D126에 따라 범위 밖입니다. Google에 이미 있는 알림 설정도 임의 변경하지 않습니다.

## 제안하는 최소 범위와 영향

1. **계정 연결**: Windows 로컬 백엔드가 Google OAuth 웹 서버 흐름을 처리합니다. PC 웹의 연결 버튼만 OAuth를 시작하며, 서버가 `state`·PKCE·정확한 로컬 redirect URI를 검증합니다. Android는 기존 사설 HTTPS 백엔드에 연결해 동일 서버 계정 상태를 사용하며 Android 자체 OAuth 클라이언트와 Google 토큰은 이번 범위에 넣지 않습니다. 서버는 127.0.0.1 바인딩을 유지합니다.
2. **권한**: 이벤트 조회·작성·수정·삭제에 필요한 `calendar.events.owned` scope를 우선 제안합니다. 이 scope 자체는 사용자가 소유한 여러 캘린더에 대한 이벤트 권한을 주므로, 해주미 서버에서는 사용자가 고른 기본 캘린더 ID 한 개만 허용 목록으로 제한합니다. 공유 캘린더·다른 계정·캘린더 설정 권한은 요구하지 않습니다. 연결 해제는 해주미의 토큰 사용을 즉시 중단하고 가능하면 Google 토큰 철회를 요청합니다.
3. **비밀 저장**: Access/Refresh Token을 기존 평문 JSON 상태나 클라이언트에 넣지 않습니다. 서버 전용 별도 암호화 저장소와 외부에서 제공하는 암호화 키가 필요합니다. 키가 없거나 복호화에 실패하면 Google 기능을 닫고 로컬 일정은 유지합니다. 로그·백업에는 평문 토큰을 넣지 않습니다.
4. **데이터**: 기존 `scheduleEvents`는 그대로 둡니다. 소유자별 Google 연결 정보와 외부 이벤트 메타데이터를 별도 선택적 저장 영역에 추가합니다. 외부 항목에는 `calendar_id`, `google_event_id`, `etag`, `updated`, `all_day` 또는 시간·IANA 시간대, `location`, `sync_status`가 필요합니다. 신규 항목만 이 구조를 쓰며 기존 JSON 데이터를 변경하거나 자동 마이그레이션하지 않습니다. Google 원본을 기준으로 화면 진입·새로고침 때 재조회하며 오프라인이면 마지막 조회 시각과 미동기 상태를 표시합니다. 동기화 캐시가 없어도 로컬 항목은 보존합니다.
5. **API 계약**: 기존 로컬 `/schedule/events`는 호환 유지합니다. 별도 `/api/v1/schedule/google/connection`(상태·연결·해제), `/api/v1/schedule/google/events`(기간·검색·상세), 변경 제안과 확인 경로를 추가합니다. OAuth callback은 Google redirect와 서버 발급 `state`로만 수락하며 일반 Bearer 생략을 다른 경로에 확장하지 않습니다. 쓰기 제안에는 대상 외부 이벤트 ID·ETag·변경 전후·만료·멱등 키를 묶고, 사용자 확인 뒤에만 공급자에 전송합니다.
6. **안전한 쓰기**: 생성은 재시도에 대비해 안정적인 Google 이벤트 ID를 서버에서 정합니다. Mock은 결과 불명일 때 자동 재시도 없이 보류하며, 실제 Google 조회를 통한 결과 대조는 아직 구현하지 않았습니다. 수정·삭제는 최신 ETag와 대상 캘린더를 확인합니다. Google 오류·토큰 만료·오프라인 상태를 표시하고 로컬 일정에 성공으로 복사하지 않습니다. 반복 일정은 기존 로컬 발생일 조회만 유지하며 Google 반복 규칙 생성·편집은 제외합니다.
7. **UI**: PC 웹은 주간 날짜 선택, 선택일 카드, 상세 보기, 예투 요청과 변경 확인 카드를 우선합니다. Android는 같은 서버 API를 사용하되 기존 Compose 화면을 확장합니다. Google 연결 상태와 로컬/Google 출처를 구분합니다. 실제 휴대폰과 Google 계정은 별도 검증 대상입니다.

## 승인받아 Mock으로 구현한 범위

- 신규 선택적 JSON 저장 영역과 서버 전용 암호화 토큰 파일 인터페이스. 운영 암호화 키·OAuth 환경변수는 실제 연결 전까지 추가하지 않음.
- 위의 신규 `/api/v1/schedule/google/*` 경로와 OpenAPI 계약 추가. 기존 로컬 일정 API와 데이터는 변경하지 않음.
- PC 웹·Android 화면 및 예투의 Google 일정 제안/확인 경로는 후속 작업. 실제 계정 연결·외부 일정 변경은 별도 승인 전 실행하지 않음.

## 순서와 검증

1. Mock OAuth/Calendar 어댑터와 테스트 전용 저장소로 연결·취소·만료·철회·권한 범위를 검증합니다.
2. 날짜·시간대·하루 종일·반복 조회, 조회·검색·상세, 생성·수정·삭제 제안/확인, 중복·충돌·네트워크 결과 불명·해제 후 로컬 보존을 검증합니다.
3. PC 웹 및 Android 화면을 연결하고 기존 Creator·개인 기록 회귀 테스트와 OpenAPI 정식 검증을 실행합니다.
4. Google Cloud Console의 OAuth 동의 화면, Calendar API 사용 설정, 웹 애플리케이션 OAuth Client, 정확한 로컬 redirect URI 등록을 안내합니다. 실제 계정 연결과 쓰기 테스트는 대상 캘린더·변경 내용을 별도로 확인받은 뒤 실행합니다.

## 확인이 필요한 결정

- 첫 연결 범위는 **사용자가 소유한 Google 기본 캘린더 한 개**로 제한하는 안입니다. 공유/보조 캘린더 지원은 별도 설계가 필요합니다.
- 토큰 암호화 키를 로컬 서버 환경에서 어떻게 공급·복구할지 결정해야 합니다. 키를 잃으면 Google 연결을 다시 해야 하지만 기존 로컬 일정은 유지됩니다.
- Google 연결 해제 시 외부 일정 캐시는 삭제하지 않고 접근 중단 표시만 하는 안입니다. 캐시 삭제·보존 기간은 개인정보 정책 결정이 필요합니다.

## 실제 Google 계정 연결 전 준비

1. 실제 Google OAuth/Calendar 공급자 어댑터를 별도로 구현하고 Mock과 같은 인터페이스로 테스트해야 합니다. 현재 서버는 공급자를 주입하지 않아 `.env`에 자격증명만 추가해도 연결되지 않습니다.
2. Google Cloud 프로젝트에서 Calendar API, OAuth 동의 화면, 웹 애플리케이션 클라이언트와 정확한 로컬 redirect URI `http://127.0.0.1:8765/api/v1/schedule/google/oauth/callback`을 준비해야 합니다. 사용할 계정이 소유한 기본 캘린더 한 개만 서버에서 허용할지 재확인해야 합니다.
3. 서버 전용 32바이트 암호화 키를 토큰 파일 및 코드와 분리하여 공급·백업·복구할 방법, Windows 파일 ACL, 키 분실 시 재연결 절차를 확정해야 합니다. OAuth 클라이언트 비밀도 브라우저나 Android 앱에 넣지 않습니다.
4. 실제 연결과 일정 변경은 별도 사용자 승인 후 수행합니다. 그때 토큰 갱신·철회, Google 이벤트 ID의 중복 처리, ETag 충돌, 통신 중 결과 불명, 반복 일정·동기화 경계를 실제 API로 검증해야 합니다. 현재 Mock 테스트는 그 결과를 대체하지 않습니다.

## 공식 문서 근거

- [Google Calendar API 권한 범위](https://developers.google.com/workspace/calendar/api/auth)
- [Google OAuth 웹 서버 애플리케이션 및 localhost redirect 규칙](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google Calendar 일정 목록·반복 발생일 조회](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
- [Google Calendar 일정 생성과 중복 방지용 이벤트 ID](https://developers.google.com/workspace/calendar/api/guides/create-events)
