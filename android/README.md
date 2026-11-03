# 해주미 Android 앱

2026-11-03 사용자 요청으로 Kotlin + Jetpack Compose 네이티브 앱과 APK 직접 설치를 선택했습니다. Google Play 등록은 이번 배포 방향에 포함되지 않습니다. 기존 Node.js 백엔드 계약을 사용합니다.

## 빌드

Android Studio에서 `android/`를 열고 Android SDK 35와 JDK 17을 설정한 뒤 `gradlew.bat assembleDebug`를 실행합니다. 생성된 디버그 APK는 `app/build/outputs/apk/debug/app-debug.apk`입니다. 디버그 APK는 개인 검증용이며 배포 서명과 업데이트 정책은 후속 작업입니다.

Photo Picker는 사진·영상을 함께 최대 20개 선택합니다. 선택 상한은 Gradle 속성 `haejumi.maxSelectedMedia`로 1~30개 사이에서 변경할 수 있으며 PC 서버의 `HAEJUMI_MAX_SELECTED_MEDIA`와 맞춰야 합니다. Android는 파일마다 기존 업로드 세션을 사용한 뒤 같은 Creator 프로젝트에 순서대로 연결합니다. 다중 세션 방식 통합 및 실기기 검증은 남아 있습니다.

2026-11-03 이 PC에서 Android Studio, SDK 35/ADB, JDK 17 및 Gradle 8.11.1을 준비했습니다. SDK와 JDK는 이 저장소의 Git 제외 개발 도구 폴더에 있으며 PC 전체 PATH를 수정하지 않았습니다. `assembleDebug testDebugUnitTest` 성공 및 단위 테스트 4개 통과. SDK XML 버전 경고는 남았습니다. 기기/에뮬레이터 실행은 확인하지 못했습니다.

## 안전한 연결

백엔드는 PC의 `127.0.0.1:8765`에서만 수신하므로 휴대폰에서 직접 접근할 수 없습니다. 사용자가 관리하는 사설 네트워크에 TLS 인증서 검증이 가능한 HTTPS 종단점과 PC loopback으로 연결하는 신뢰된 프록시를 별도로 준비해야 합니다. 앱은 HTTPS 및 인증을 요구하며 사설 IPv4 또는 `*.ts.net` 주소만 허용합니다. 이 저장소는 프록시 구성이나 인증서를 제공하지 않습니다. HTTPS 종단점의 신원과 경로는 사용자가 확인해야 합니다. 임의의 인증서나 평문 HTTP는 허용하지 않습니다. 앱 설정에 PC 주소와 토큰을 직접 입력하며 토큰은 Android Keystore로 암호화됩니다.

## 현재 범위

시스템 Photo Picker에서 한 파일을 선택해 확인 후 업로드합니다. 현재 백엔드는 한 파일을 단일 part로 처리하며 이어받기를 지원하지 않습니다. 재시도는 같은 업로드 요청을 재전송하며 앱 종료 후의 복구는 지원하지 않습니다. 업로드 후 사용자가 직접 프로젝트 생성 여부를 선택합니다.

Creator 화면은 현재 task의 기획안 조회·텍스트 기반 수정 요청·기획 중간 승인, 자막 문구/시간·로컬 등록 BGM·음량/페이드 편집·초안 중간 승인, 렌더 요청/상태 조회/취소를 제공합니다. 실제 FFmpeg 검증이 끝난 MP4만 인증된 API에서 내려받아 해시를 확인하고 앱 전용 캐시에서 재생합니다. 미리보기 중간 승인 후 YouTube·TikTok·Instagram 각각 게시 정보와 독립 최종 승인 요청을 제공합니다. 최종 승인은 서버의 권리 및 버전 검사에 종속되며 SNS 게시는 호출하지 않습니다. 기획 장면 구조 직접 편집, PC 음원 등록·권리 증빙 입력, 실제 계정 연동은 아직 화면에 없습니다. 외부 AI 동의나 SNS 게시 요청도 앱에서 제공하지 않습니다.

실제 휴대폰이 없어 화면 동작·Photo Picker·Android에서 PC까지의 HTTPS 요청은 미검증입니다. PC 서버는 계속 `127.0.0.1` 전용이며 보안 프록시/사설망 구성이 필요합니다.
