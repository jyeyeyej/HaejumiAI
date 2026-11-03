# 첫 Creator 참조 구현 상태

> 최신 점검: 2026-11-03 · 교체 가능한 Node 참조 백엔드 · 전체 제품 완성 아님

## 2026-11-03 localhost PC 웹 첫 버전

- 사용자가 확정한 Android Kotlin/Compose + PC React 웹 + 공통 Node `/api/v1` 방향을 D123~D125에 기록했습니다. `web/`은 예투 홈, 네 Agent 카드(Creator만 사용 가능), 브라우저 수동 파일 선택·단일 업로드, 소유 프로젝트 목록, 기획·자막/BGM 중간 승인, 렌더 상태·취소, 인증된 실제 FFmpeg MP4 해시 확인 후 재생을 구현했습니다.
- 백엔드에 인증·소유권이 적용된 프로젝트 목록과 작업별 렌더 목록 조회를 추가했습니다. 웹은 현재 버전·해시와 체크포인트를 새로 읽고, 409 충돌 뒤 재조회하며 주기적으로 서버 상태를 갱신합니다. 토큰은 브라우저 탭 메모리에서만 사용합니다. PC 웹과 API 프록시는 loopback 전용입니다.
- PC 웹 `npm run build` 성공·단위 테스트 4개 통과, 백엔드 `npm test` 43개 통과(합성 FFmpeg 테스트 포함), Android `assembleDebug testDebugUnitTest` 성공·단위 테스트 4개 통과. Redocly OpenAPI lint 오류 0건·기존 경고 13건. 웹 빌드 미리보기는 127.0.0.1:4173에서 HTML 200/CSP 헤더를 확인했습니다. 백엔드를 시작하지 않은 상태의 프록시 요청은 예상대로 502였습니다. Android 앱/서버 실제 연결, 두 기기 동시 수정 E2E, 브라우저에서 개인 파일 업로드·영상 재생은 아직 미검증입니다.
- PC 첫 버전에 플랫폼별 게시 정보·최종 승인 UI, 음성 입력, 로컬 음원 등록·권리 증빙 UI는 없습니다. Android의 해당 게시 정보 화면 코드는 있으나 실기기 미검증입니다. 실제 SNS 게시와 동의 없는 외부 AI 호출은 실행하지 않았습니다.

## 2026-11-03 Creator Android 검토 화면 추가

- Kotlin/Compose에서 기획 조회·텍스트 수정 요청·중간 승인, 자막/등록된 로컬 BGM/음량/페이드 편집·초안 승인, 렌더 요청·폴링·취소, 인증된 실제 MP4 해시 확인·앱 캐시 재생·미리보기 승인, 플랫폼별 게시 정보 및 독립 최종 승인 UI를 추가했습니다. API 전송에는 기존 Bearer 토큰, 현 버전/hash, 게시 정보 revision/hash 및 멱등 키를 사용하며 서버가 소유권·권리 조건을 재검사합니다.
- Android `assembleDebug testDebugUnitTest`: 성공, 단위 테스트 4개 통과. 백엔드 `npm.cmd test`: 42개 통과. 앱에서 실제 HTTPS 연결·화면 실행·미디어 선택·게시 승인 요청을 보내는 실기기 테스트는 진행하지 않았습니다.
- PC 연결은 신뢰된 HTTPS 사설 경로가 미구성이고, Android 기기는 ADB에서 발견되지 않았습니다. 앱은 외부 AI 동의/호출·SNS 실제 게시를 제공하지 않습니다. 게시 계정 ID는 메타데이터이며 OAuth 연동은 아닙니다. 미확인 BGM 및 원본 오디오는 서버 최종 승인 게이트에서 차단됩니다.

## 2026-11-03 Android 첫 화면 구현

- `android/`에 Kotlin/Compose 앱, 한국어 예투 홈과 네 Agent 카드, PC 연결 설정, Photo Picker 단일 파일 확인·업로드·취소·재시도 및 업로드 후 프로젝트 생성 코드를 추가했습니다. 최근 작업 상태를 조회할 수 있습니다.
- 앱은 인증 토큰을 Android Keystore 키로 암호화하여 보관하고, HTTPS 사설 IPv4 또는 `*.ts.net` 주소만 허용합니다. Android의 기본 인증서 검증을 사용하며 미디어 전체 접근 권한을 요청하지 않습니다.
- 서버는 loopback만 수신하고 신뢰된 HTTPS 프록시/사설망은 아직 제공되지 않습니다. 앱의 실제 PC 연결, 인증, 선택 파일 업로드 및 Android 기기 화면은 검증되지 않았습니다. 이 당시에는 이어받기, 다중 선택, 기획/자막/음악/영상 승인과 SNS 화면이 후속 작업이었습니다. 이후 화면 코드 추가는 위의 최신 항목을 참조합니다.
- 공식 Android Studio, SDK 35/ADB, JDK 17 및 Gradle 8.11.1을 준비하고 `assembleDebug testDebugUnitTest`에 성공했습니다. 주소 제한과 Node.js 기준 단일 파일 manifest 해시 단위 테스트 2개 통과. `aapt dump permissions`에서 INTERNET과 라이브러리의 비공개 receiver 권한만 확인했습니다. `adb devices -l`에는 연결 기기가 없었습니다. APK는 `android/app/build/outputs/apk/debug/app-debug.apk`입니다.
- 백엔드 `npm.cmd test` 42개 통과(합성 미디어를 사용하는 실제 FFmpeg 테스트 포함). 외부 AI 호출과 실제 SNS 게시는 실행하지 않았습니다. Android 빌드 중 SDK XML 버전 경고와 디버그 네이티브 라이브러리 strip 경고가 있었으나 빌드는 성공했습니다.

## 확정 제품 요구사항 유지

- Android 모바일 우선 제품, Android Photo Picker로 사용자가 직접 선택한 파일만 처리.
- Creator 최우선이며 전문 Agent는 Creator / Schedule / Wellness / Diary 4개. Blog와 Music은 확장 후보.
- 소유권·인증 검사를 서버에서 강제하고, 비선택 미디어는 탐색하지 않음.
- 외부 LLM/STT/비전/분석 전송은 기본 차단. OpenAI adapter는 명시적 설정·범위별 동의와 PrivacyGate 뒤에 있으며 실제 호출은 이번 검증에서 실행하지 않음.
- SNS 게시 실연동은 구현 범위 밖. 참조 서버는 중간 승인 뒤 로컬 render job 흐름을 지원함.

## 구현된 참조 범위

- `/api/v1/media/uploads`, 업로드 part 및 complete: 세션당 선택 파일 하나/단일 part, 파일명·확장자/MIME·container 구조·PNG CRC/MP4 box·크기·SHA-256 검사, owner 격리 및 manifest 중복 제거.
- `/api/v1/content/projects`: 인증된 사용자의 검증 완료 미디어만 연결. 같은 owner+ordered media IDs+설정 재요청은 기존 Creator project/task와 `task_id`를 반환.
- `/api/v1/tasks/{task_id}`: 인증 및 소유권 검사 후 안전한 상태만 반환.
- fail-closed `PrivacyGate`와 기본 비활성 OpenAI adapter.
- 표준 라이브러리 참조 HTTP adapter와 교체 가능한 저장소/auth 인터페이스.
- Creator 영상 규격 상수, `fit_pad`/초점 조절형 `fill_crop`, 로컬 FFmpeg 명령 생성 및 ffprobe 출력 계약 검증. 새 기획은 승인된 한글 자막과 원음·사용자 등록 로컬 BGM의 음량/페이드를 합성함. 기존 구성 없는 작업은 무음 렌더를 유지함.
- 자막/음악 수정은 새 버전과 체크포인트를 만들고 기존 승인을 무효화함. 원본·자막이 같은 오디오 전용 수정은 검증된 영상 비트스트림을 재사용함. 소유 음원과 소리가 포함된 원본 영상의 오디오 권리·상업 이용·플랫폼·증빙과 필수 표기가 불충분하면 최종 게시 승인을 차단함.
- `/tasks/{id}/checkpoints`, `/tasks/{id}/approvals`, `/tasks/{id}/render`, `/jobs/{id}`, `/jobs/{id}/cancel`, `/tasks/{id}/preview`를 인증·소유권 검사와 연결. 기획·초안 승인 전 렌더 요청은 거부하고 프로젝트에 연결된 업로드 미디어만 입력으로 사용.
- 테스트 renderer의 작업 상태는 `simulated`; 검증되지 않은 marker body는 `application/x-haejumi-test-preview`로 반환하며 MP4로 표기하지 않음.

이는 제품 완성이나 실제 개발 PC 검증을 뜻하지 않습니다. 업로드는 참조 구현에서 세션당 1개 파일·단일 part로 제한합니다. 미디어 검사기는 구조 및 checksum 검증이며 완전한 codec decode·백신/악성 파일 검사기는 아닙니다.

## 테스트 및 계약 검증

- 현재 `npm test`: 합성 미디어 기반 실제 FFmpeg 및 Creator API 검증을 포함해 42개 통과. FFmpeg/ffprobe가 없으면 실렌더 테스트는 건너뜀.
- 합성 영상의 한글 자막, 440Hz 원음·880Hz BGM, 페이드, 오디오만 변경한 영상 비트스트림 재사용 및 ffprobe 규격을 확인함. Android 렌더·승인 API 호출 코드는 연결했으며 실기기 E2E는 미검증.
- 외부 SNS 게시, 외부 개인정보 전송, 실제 LLM 호출: 이번 검증에서 0회.
- OpenAPI 3.1 Redocly 검사 결과는 [`OPENAPI-VALIDATION.md`](OPENAPI-VALIDATION.md)에 기록.

## 승인/결정 대기

- API draft 및 `ContentProject.task_id` 확장 승인.
- 최종 Backend 기술, DB/persistence, 인증·세션 발급과 다중 사용자 모델.
- 다중 미디어 세션, chunk 재개·part 식별, manifest canonicalization, 업로드 제한값.
- LAN/TLS 접근 방식, 개인정보 보존·삭제·백업 정책.
- PrivacyGate 동의 UI·공급자·목적별 범위 및 외부 전송 사용 승인.
- Android Kotlin/Compose 및 APK 직접 설치·Play Store 미등록은 D121·D122로 확정됨. 배포 서명과 실제 설치 검증은 남음.
