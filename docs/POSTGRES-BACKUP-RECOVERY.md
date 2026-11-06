\# 해주미 PostgreSQL 백업·복구 운영 가이드



\## 1. 목적



해주미 AI의 PostgreSQL 데이터를 백업하고, 장애 발생 시 별도의 데이터베이스에서 안전하게 복구하는 절차를 정의합니다.



이 문서는 실제 PostgreSQL 16.15 환경에서 수행한 백업 및 복원 검증 결과를 기준으로 작성했습니다.



\## 2. 운영 환경



| 항목 | 값 |

|---|---|

| 프로젝트 | `C:\\HaejumiAI` |

| Docker 컨테이너 | `haejumi-postgres` |

| PostgreSQL | 16.15 |

| 개발 DB | `haejumi` |

| 스키마 | `haejumi\_dev` |

| DB 사용자 | `haejumi\_user` |

| Windows 연결 포트 | `5434` |

| 백업 위치 | `C:\\HaejumiAI-backups\\postgres` |

| 복구 검증 DB | `haejumi\_restore\_test` |



\## 3. 백업 실행



PowerShell에서 다음 명령어를 실행합니다.



```powershell

cd C:\\HaejumiAI

.\\backend\\scripts\\backup-postgres.ps1

```



PostgreSQL 비밀번호를 입력하면 자동으로 다음 작업을 수행합니다.



1\. PostgreSQL Custom Format 백업 생성

2\. Docker 컨테이너에서 Windows 백업 폴더로 파일 복사

3\. 파일 존재 및 크기 확인

4\. `pg\_restore --list`로 아카이브 목록 확인

5\. SHA-256 체크섬 출력

6\. Docker 임시 파일 및 비밀번호 환경변수 정리



백업 파일명에는 생성 날짜와 시간이 포함됩니다.



백업 파일은 Git 저장소 밖에 보관하며, Git에 추가하지 않습니다.



\## 4. 백업 범위와 제한



백업 대상은 `haejumi` DB의 `haejumi\_dev` 스키마입니다.



포함되는 항목:



\- Creator 관련 PostgreSQL 테이블

\- 마이그레이션 관리 테이블

\- 백업 시점의 테이블 데이터

\- 인덱스 및 제약조건



포함되지 않는 항목:



\- Windows PC에 저장된 원본 사진·영상

\- FFmpeg 렌더 결과 파일

\- JSON 기반 Creator 데이터

\- `.env` 및 인증 정보

\- PostgreSQL의 다른 스키마 및 서버 전역 설정



따라서 이 백업만으로 해주미 전체 서비스를 복원할 수 있다고 판단하면 안 됩니다.



\## 5. 복구 전 필수 확인



실제 개발 DB에 바로 복원하지 않습니다.



먼저 별도 복구 테스트 DB를 준비하고, 다음 조건을 확인합니다.



\- 대상 DB 이름이 정확한지 확인

\- 복구 DB에 기존 사용자 데이터가 없는지 확인

\- `haejumi\_dev` 테이블이 없는 빈 DB인지 확인

\- 백업 파일이 존재하는지 확인

\- 현재 개발 DB와 복구 DB가 서로 다른지 확인



기존 DB에 `pg\_restore --clean` 또는 `DROP DATABASE`를 임의로 실행하지 않습니다.



\## 6. 복구 테스트 DB 생성



PowerShell에서 PostgreSQL에 접속합니다.



```powershell

docker exec -it haejumi-postgres psql -U haejumi\_user -d haejumi

```



PostgreSQL 화면에서 다음 SQL로 기존 DB가 있는지 확인합니다.



```sql

SELECT datname

FROM pg\_database

WHERE datname = 'haejumi\_restore\_test';

```



`(0 rows)`인 경우에만 생성합니다.



```sql

CREATE DATABASE haejumi\_restore\_test

OWNER haejumi\_user;

```



이미 존재한다면 덮어쓰거나 삭제하지 않습니다.



복구 DB에 접속합니다.



```text

\\c haejumi\_restore\_test

```



대상 DB를 확인합니다.



```sql

SELECT current\_database(), current\_user;

```



기존 테이블이 없는지 확인합니다.



```sql

SELECT COUNT(\*) AS existing\_tables

FROM information\_schema.tables

WHERE table\_schema = 'haejumi\_dev'

&#x20; AND table\_type = 'BASE TABLE';

```



`existing\_tables = 0`인 경우에만 다음 절차를 진행합니다.



PostgreSQL을 종료합니다.



```text

\\q

```



\## 7. 백업 파일 복원



PowerShell에서 백업 파일을 Docker 컨테이너로 복사합니다.



아래 파일명은 실제 복원할 백업 파일명으로 변경합니다.



```powershell

docker cp "C:\\HaejumiAI-backups\\postgres\\haejumi\_dev\_backup\_20261105.dump" haejumi-postgres:/tmp/haejumi\_restore\_check.dump

```



복원 대상이 `haejumi\_restore\_test`인지 확인한 후 실행합니다.



```powershell

docker exec haejumi-postgres pg\_restore -U haejumi\_user -d haejumi\_restore\_test --no-owner --no-privileges --exit-on-error --single-transaction -v /tmp/haejumi\_restore\_check.dump

```



복원 직후 종료 코드를 확인합니다.



```powershell

Write-Host "Restore exit code: $LASTEXITCODE"

```



정상적인 복원은 종료 코드 `0`을 반환해야 합니다.



실패했다면 해당 DB의 상태를 먼저 조사하고, 같은 복원 명령을 무조건 반복하지 않습니다.



\## 8. 복구 결과 검증



복구 DB에 접속합니다.



```powershell

docker exec -it haejumi-postgres psql -U haejumi\_user -d haejumi\_restore\_test

```



테이블 수를 확인합니다.



```sql

SELECT COUNT(\*) AS restored\_tables

FROM information\_schema.tables

WHERE table\_schema = 'haejumi\_dev'

&#x20; AND table\_type = 'BASE TABLE';

```



2026년 11월 5일 기준 복원 테스트에서는 Creator 테이블 11개와 마이그레이션 관리 테이블 1개, 총 12개가 확인됐습니다.



마이그레이션 이력도 확인합니다.



```sql

SELECT version, description

FROM haejumi\_dev.schema\_migrations;

```



테이블별 데이터 건수는 다음 명령으로 조회합니다.



```sql

SELECT format(

&#x20; 'SELECT %L AS table\_name, COUNT(\*) AS row\_count FROM %I.%I;',

&#x20; table\_name, table\_schema, table\_name

)

FROM information\_schema.tables

WHERE table\_schema = 'haejumi\_dev'

&#x20; AND table\_type = 'BASE TABLE'

ORDER BY table\_name

\\gexec

```



원본 DB와 복원 DB의 데이터 건수를 비교합니다.



단, 백업 시점 이후 원본 DB가 변경됐다면 현재 행 수가 다를 수 있습니다.



행 수가 같다는 것만으로 모든 데이터 값이 동일하다는 뜻은 아닙니다. 필요한 경우 데이터 내용이나 체크섬도 추가 검증합니다.



\## 9. 실제 검증 이력



\### 2026-11-05



\- Custom Format 백업 생성 성공

\- 백업 파일 내부 목록 검사 성공

\- 별도 DB 복원 성공

\- `pg\_restore` 종료 코드 0

\- Creator 테이블 11개 복원 확인

\- `schema\_migrations` 포함 총 12개 테이블 확인

\- 원본과 복원 테이블별 행 수 12/12 일치



당시 Creator 관련 11개 테이블은 각각 0건이었고, `schema\_migrations`에는 1건이 존재했습니다.



따라서 실제 Creator 프로젝트 데이터가 저장된 상태의 복원 검증은 추가로 필요합니다.



\### 2026-11-06



\- `backup-postgres.ps1` 자동 백업 실행 성공

\- 백업 파일 생성 및 SHA-256 출력 확인

\- Git 커밋 `4560299`





\### 2026-11-06 — 실제 테스트 데이터 백업·복원 검증



\*\*검증 목적:\*\* PostgreSQL 백업 파일에 저장된 프로젝트 데이터가 다른 데이터베이스에 동일하게 복원되는지 확인



\*\*테스트 환경\*\*

\- 원본 DB: `haejumi\_backup\_source\_test`

\- 복원 DB: `haejumi\_backup\_target\_test`

\- 스키마: `haejumi\_dev`

\- PostgreSQL: 16.15

\- 테스트 데이터: Creator 프로젝트 1건



\*\*검증 결과\*\*

\- 원본 DB에 테이블 구조 12개 복원 성공

\- `creator\_projects`에 샘플 프로젝트 1건 입력 성공

\- Custom Format 백업 파일 생성 성공

\- 백업 파일: `haejumi\_data\_test.dump`

\- 백업 파일 크기: 27,531 bytes

\- SHA-256: `E49BD5534D33A8522DAF3D3B14BCCA9B73D0006D2BE73FA4356B1FC8F9211253`

\- `pg\_restore --list` 검사 성공

\- 복원 대상 DB에 테이블 12개 확인

\- 원본과 복원된 프로젝트 데이터 비교 결과: `True`

\- 프로젝트 ID, 사용자 ID, 상태, 버전, JSON 데이터, 생성·수정 시간 일치 확인



\*\*최종 판정: PASS\*\*



이번 검증은 실제 샘플 데이터 1건의 백업·복원 결과를 확인한 것입니다. 여러 Creator 테이블의 관계형 데이터, 대용량 데이터 및 장애 상황에 대한 검증은 별도 진행이 필요합니다.





\## 10. 운영 시 주의사항



\- 백업 파일에 민감한 데이터가 포함될 수 있으므로 접근 권한을 관리합니다.

\- PC 고장에 대비한 별도 저장 장치 또는 안전한 보관 위치를 마련합니다.

\- PostgreSQL 백업과 원본 미디어·JSON 데이터 백업은 별도로 관리합니다.

\- 백업 파일을 Git에 업로드하지 않습니다.

\- 백업 파일만 믿지 말고 주기적으로 별도 DB 복원을 검증합니다.

\- 실제 개발 DB를 복원할 때는 별도 절차와 명시적 승인 후 진행합니다.



\## 11. 남은 과제



\- 실제 데이터가 들어 있는 테스트 DB의 백업·복원 검증

\- 백업 시점의 데이터 건수 및 체크섬 기록

\- 복구 자동화 및 검증 스크립트

\- 백업 파일 보존 기간과 삭제 정책

\- DB 외부의 원본 미디어 및 JSON 데이터 백업 전략



이 문서는 현재 검증된 기능과 아직 검증하지 않은 기능을 구분하여 관리합니다.

