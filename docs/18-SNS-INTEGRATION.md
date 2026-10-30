# SNS 플랫폼 연동 명세

> 프로젝트: **해주미(Haejumi)** · AI 비서 이름: **예투**  
> 상태: 설계 초안 v0.2 · 수정일: 2026-10-30 · 대상: 1인 개인용, 향후 다중 사용자 확장  
> 원칙: **존댓말 응답 / 크리에이터 상업적 수익화 / 권리 검증 / 사용자 통제 / 로컬 우선**  
> 표기: **[확정]** 합의된 목표 · **[제안]** 구현 선택 · **[검증 필요]** 정책·환경 확인 전 결정 보류

## 목표와 현실적 제한
1인용 서비스라도 SNS 공식 API 이용 조건이 적용됩니다. **게시 가능 여부는 기술적 가능성과 플랫폼의 허가/심사를 모두 충족해야 합니다.**

| 플랫폼 | 목표 | 요건/제약(확인 필요) | 초기 전략 |
|---|---|---|---|
| YouTube | Shorts 파일 업로드 | Google OAuth, 할당량, 앱 검증, 공개 범위 | 첫 API 연동 대상으로 제안 |
| Instagram | Reel/피드 게시 | 프로페셔널 계정, Meta 권한, 플랫폼이 접근 가능한 미디어 URL | 계정 요건 확인 후 구현 |
| TikTok | 게시 | Content Posting API scope 및 앱 감사; **개인/팀 계정 전용 내부 업로드 도구가 허용되지 않는 사례** | 정책 위반 자동 게시 대신 공식 앱 공유·수동 최종 게시 고려 |

## 플랫폼 공통 인터페이스
`connect_account()`, `validate_capabilities()`, `upload_media()`, `publish()`, `get_status()`, `disconnect()`.
- 플랫폼 계정 연결/해제와 토큰 갱신, 공개 범위·문구 미리보기 필수.
- 검토된 영상 파일의 SHA256, 사용자 승인 ID, 플랫폼·계정·공개 범위를 게시 요청에 결합.
- 업로드 타임아웃 후 즉시 재게시하지 않고 플랫폼 상태 조회/대조.

## Instagram 특수 고려
- Meta 서버가 가져갈 수 있는 안전한 임시 미디어 URL 준비. PC의 Tailscale 사설 주소는 외부 서버에서 접근할 수 없음.
- 계정·앱 권한 및 media container/publish 흐름은 공식 최신 문서로 개발 직전 확인.

## TikTok 특수 고려
- 사적 계정 업로드 유틸리티가 TikTok 가이드의 불허 사례에 해당할 수 있음.
- 감사를 거치지 않은 API 앱은 공개 게시 제한 가능.
- 비공식 API, 브라우저 자동 조작 등 정책 우회는 설계에 포함하지 않음.

## 공식 참고 링크
- YouTube 업로드: https://developers.google.com/youtube/v3/docs/videos/insert
- TikTok 공유 정책: https://developers.tiktok.com/docs/en/content-sharing-guidelines
- TikTok Direct Post: https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post
- Instagram 게시: https://developers.facebook.com/docs/instagram-platform/content-publishing

## 개발 전 확인표
- [ ] 연결할 채널 유형/권한 확인
- [ ] 앱 등록·심사/검증·OAuth redirect URI 구성
- [ ] 상업적 수익화·음원 정책 및 공개 게시 요건 확인
- [ ] 실제 게시/실패/취소/중복 방지 테스트

---

## v0.2 최종 게시 승인 경계
- 미리보기 최종본과 제목·설명·대상 플랫폼·공개범위를 표시하고, 사용자가 **최종 게시 승인**한 버전/해시만 업로드합니다.
- 이전 단계 중간 컨펌은 SNS 게시 권한을 의미하지 않습니다.
- Instagram/TikTok/YouTube의 개인 앱 게시 권한은 각 개발자 정책과 OAuth 심사에 따라 달라서 반드시 실제 계정으로 검증합니다.
- 일부 플랫폼이 개인용 자동 게시를 허용하지 않으면 공식 공유/내보내기로 대체하고 자동 게시로 표현하지 않습니다.
