# PostgreSQL Creator 무결성 검증 보고서

## 1. 검증 개요

- 프로젝트: Haejumi AI
- DBMS: PostgreSQL 16
- Docker 컨테이너: haejumi-postgres
- 호스트 포트: 5434
- 스키마: haejumi_dev
- 검증 기준일: 2026-11-06

### 검증 목적

Creator 프로젝트, 작업, 체크포인트, 승인, 렌더링 및 SNS 게시 정보 사이의 관계를 데이터베이스 수준에서 보호한다.

애플리케이션 검증만으로 방지하기 어려운 소유자 불일치 및 작업 ID 불일치를 복합 제약조건으로 차단하는 것이 목적이다.

### 데이터베이스 구분

| DB | 용도 | 처리 |
|---|---|---|
| haejumi | 실제 개발 DB | 변경 금지, 미적용 |
| haejumi_integrity_test | 수동 무결성 테스트 | 검증 완료 |
| haejumi_integrity_migration_test | 정식 SQL 적용 검증 | 적용 성공 |
| haejumi_migration_test | 기존 마이그레이션 테스트 | 기록 구조 확인 |

## 2. 발견한 무결성 문제

다음 다섯 가지 관계에서 불일치가 발생할 수 있는 구조를 확인했다.

1. Creator 프로젝트와 작업의 소유자 불일치
2. 체크포인트와 승인 기록의 작업 ID 불일치
3. 렌더링 작업과 Creator 작업의 소유자 불일치
4. SNS 게시 정보와 Creator 작업의 소유자 불일치
5. SNS 최종 승인과 게시물의 소유자 또는 작업 ID 불일치

## 3. 정식 마이그레이션

파일:

`backend/db/migrations/001_add_creator_integrity_constraints.sql`

이 SQL에는 기존 데이터의 관계 불일치 사전 검사 및 8개 제약조건 추가 작업이 포함되어 있다.

### 추가된 제약조건 8개

| 번호 | 제약조건 | 종류 |
|---|---|---|
| 1 | creator_tasks_project_owner_fkey | 복합 FK |
| 2 | creator_checkpoints_id_task_key | 복합 UNIQUE |
| 3 | creator_approvals_checkpoint_task_fkey | 복합 FK |
| 4 | creator_tasks_id_owner_key | 복합 UNIQUE |
| 5 | creator_render_jobs_task_owner_fkey | 복합 FK |
| 6 | creator_publications_task_owner_fkey | 복합 FK |
| 7 | creator_publications_id_task_owner_key | 복합 UNIQUE |
| 8 | creator_publication_approvals_relation_fkey | 복합 FK |

복합 UNIQUE 제약조건은 관련 복합 FK가 참조할 수 있는 키를 제공한다.

### 데이터 보존

기존 사용자 프로젝트 및 원본 미디어를 삭제하는 SQL은 포함되지 않는다.

기존 관계 불일치가 발견되면 예외를 발생시키도록 구성했다.

단, 기존 NULL 값, 참조 키 유효성, 기타 스키마 조건까지 모두 사전 검사에서 확인하는 것은 아니다. 실제 적용 전 별도 점검이 필요하다.

## 4. 수동 무결성 검증

이전 작업에서 다음 결과를 확인했다.

| 검증 항목 | 결과 |
|---|---|
| SNS 최종 승인 소유자 불일치 차단 | PASS |
| 테스트 데이터 ROLLBACK | PASS |
| 추가 제약조건 8개 확인 | PASS |
| 테스트 데이터 정리 | PASS |

이 결과는 이전 수동 테스트의 보고된 실행 결과다.

## 5. 자동 회귀 테스트

PostgreSQL 자동 회귀 테스트 결과:

- Passed files: 10
- Failed files: 0
- Total selected files: 10
- ALL SELECTED TEST FILES PASSED

테스트 연결 시 Windows 호스트 포트 5434를 사용한다.

이 결과는 선택된 PostgreSQL 테스트 파일 10개의 통과를 의미한다. 모든 애플리케이션 기능의 검증 완료를 의미하지 않는다.

## 6. 정식 SQL 적용 검증

검증 DB:

`haejumi_integrity_migration_test`

정식 마이그레이션 SQL을 별도의 테스트 DB에 psql로 직접 적용하여 성공한 것으로 확인했다.

이는 정식 SQL의 테스트 DB 적용 검증이며, apply-migrations.mjs 실행기를 통한 정식 SQL 적용 검증은 아니다.

실제 개발 DB haejumi에는 적용하지 않았다.

## 7. 마이그레이션 실행기 분석

실행기:

`backend/db/apply-migrations.mjs`

### 구현이 확인된 기능

- 3자리 버전 기반 파일 관리
- SQL 파일명 형식 검사
- 중복 버전 검사
- SHA-256 체크섬 계산
- baseline 등록 확인
- baseline 체크섬 비교
- 적용 이력과 SQL 체크섬 비교
- 이미 적용한 마이그레이션 SKIP
- 알 수 없는 적용 버전 차단
- 역순 마이그레이션 차단
- BEGIN / COMMIT / ROLLBACK
- PostgreSQL 트랜잭션 advisory lock

위 항목은 소스코드에서 확인한 구현 기능이다.

실제 실행을 통한 모든 실패 시나리오 검증을 완료했다는 의미는 아니다.

### 마이그레이션 기록 테이블

`haejumi_dev.schema_migrations`

확인한 컬럼:

- version: TEXT NOT NULL
- description: TEXT NOT NULL
- checksum: TEXT NOT NULL
- applied_at: TIMESTAMPTZ NOT NULL, 기본값 now()

확인한 제약조건:

- version PRIMARY KEY
- checksum 64자리 소문자 16진수 형식 CHECK

### 기존 테스트 DB 적용 이력

DB: `haejumi_migration_test`

| 버전 | 설명 |
|---|---|
| baseline | Existing 11 Creator tables |
| 001 | 001_create_migration_probe.sql |

기록된 baseline 체크섬:

`655395d43767e0be7f4fd61314b402bd9a0f309c5b9bec4d7f9329587c6a6190`

기록된 001 체크섬:

`c969b410e0264ebddadb49863a1f2674a9a016d36aad498000534717ad0dea32`

현재 파일의 SHA-256과 기록 값이 일치하는지는 별도 계산 검증이 필요하다.

### 실행기 제한

현재 실행기가 허용하는 DB:

- haejumi
- haejumi_migration_test

DB 이름별 폴더:

- haejumi: migrations
- haejumi_migration_test: migrations-test

따라서 기존 실행기로 haejumi_integrity_migration_test에 정식 SQL을 직접 적용할 수 없다.

또한 두 migration 폴더에 각각 서로 다른 버전 001 파일이 존재한다.

이 때문에 기존 테스트 DB의 001 적용 기록을 정식 Creator 무결성 SQL의 적용 증거로 취급해서는 안 된다.

## 8. 실제 개발 DB 적용 전 점검사항

다음 항목은 운영상 사전 확인 또는 승인 대상이다.

1. 실제 개발 DB의 백업 및 복구 절차 확보
2. 기존 데이터의 소유자·작업 관계 불일치 조회
3. 참조 컬럼의 NULL 값 및 기존 FK 유효성 확인
4. 복합 FK가 참조하는 UNIQUE 키 존재 확인
5. 정식 SQL의 모든 대상 제약조건이 이미 존재하는지 확인
6. 적용 중 테이블 잠금 및 서비스 영향 검토
7. 현재 baseline 파일과 적용 이력 체크섬 비교
8. 정식 마이그레이션 실행 경로 및 버전 충돌 여부 확인
9. 적용 실패 시 롤백 및 복구 계획 확인
10. 사용자 승인 후 적용

실제 개발 DB haejumi의 변경은 이번 작업 범위에서 제외한다.

## 9. 미해결 위험 및 후속 작업

### 미해결 위험

- 실행기 중복 적용 방지의 실제 DB 실행 검증 미완료
- 체크섬 불일치 발생 시 차단 동작의 실제 실행 검증 미완료
- 마이그레이션 실패 시 전체 트랜잭션 롤백의 실제 실행 검증 미완료
- 실행기를 통한 정식 무결성 SQL의 격리된 테스트 DB 재현 미완료
- PostgreSQL 복합 FK의 NULL 허용 조건에 따른 예외 가능성
- 실제 개발 DB 데이터 상태 미점검
- 마이그레이션 실행기 테스트용 001과 정식 001의 내용 차이

### 후속 작업

1. 실제 개발 DB를 변경하지 않는 실행기 통합 테스트 환경 마련
2. 체크섬·중복 실행·롤백·실행 순서 오류에 대한 자동 테스트
3. 정식 SQL의 테스트 DB 재현 절차 확립
4. NULL 및 기존 데이터 정합성 추가 검증
5. 필요시 실행기 개선안을 먼저 검토하고 승인 후 수정
6. 실제 개발 DB 적용 여부는 별도 승인 절차로 결정

## 10. 최종 판정

- Creator 관계 무결성 SQL 작성: 완료
- 수동 무결성 검증: PASS
- PostgreSQL 자동 회귀 테스트: 10/10 PASS
- 별도 테스트 DB의 정식 SQL 적용: PASS
- 마이그레이션 실행기 코드 분석: 완료
- 실행기 실패 시나리오 실제 동작 검증: 미완료
- 실제 개발 DB 적용: 미실행

**최종 상태: 무결성 제약조건의 테스트 DB 검증 완료. 정식 실행기 통합 검증과 실제 개발 DB 적용은 후속 작업으로 남음.**
