# intent_DNA — PHONE FRIEND / ARKAON

## 2026-09-10 — Runtime hardening bundle

### 조사 (Luna, 최초 1회)

- 범위 확정: ActionRuntime 상태 전이, CapabilityRuntime 실행 의미, 대화 세션 주체·기기 결속, Android 연락처 읽기 fail-closed 및 Core 통합, 감사 민감정보 축소, 실제 Node 검증·CI.
- KEEP: Decision/Gate/Authority 분리, 연락처는 READ → ANALYZE → PROPOSE만 지원, 외부 효과 미실행.
- NEVER: Authority를 제품·커넥터·Android adapter가 만들지 않음. 연락처 MERGE/DELETE/WRITE, 실결제·문자·메일·실주문·운영 데이터 삭제를 수행하지 않음.
- ACCEPTANCE: 상태 전이 우회 불가, `FAILED`/`VERIFY_FAILED`/`ROLLED_BACK`는 완료 실행으로 표시되지 않음, 결속 불일치는 DENY+Audit, `permission_granted === true`와 `client === ANDROID`가 아니면 연락처 분석 불가, Audit에 SMS 본문·전화번호·연락처 원문 없음.

### 결정 (Terra)

- ActionRuntime에 허용 전이 표를 단일 진실원천으로 둔다. ExecutionEngine의 정상 전이 및 재검증/롤백만 허용한다.
- `executed`는 성공적으로 완료된 `SUCCEEDED` 또는 `VERIFIED`만 의미하며, 실행 시도는 별도 `attempted`로 제공한다.
- 기존 세션의 저장된 subject/device와 명시 입력이 다르면 처리 전에 DENY하고 안전한 메타데이터만 감사한다.
- Android 연락처 엔드포인트는 ephemeral snapshot을 받아 `Decision → Gate → ActionRuntime → Execution → Verify → Audit`을 통과한다. permission/client 불일치는 그 이전에 fail-closed 감사만 남긴다.
- Audit은 민감 키를 hash/count/redacted 메타데이터로 대체한다. resource id와 상태·건수는 유지한다.

### 구현·검증 기록

- 변경: ActionRuntime 전이표, CapabilityRuntime `attempted`/완료 `executed`, Session binding DENY+Audit, Android endpoint Core 경로, Audit redaction, `npm run verify`, GitHub Actions workflow를 한 묶음으로 반영. 구현 커밋 `a42f653`.
- Sol BLOCK delta: Public Web 세션은 `session_id`만으로 재개할 수 없도록 cryptographically random continuation token을 1회 발급하고 SHA-256 hash만 저장한다. follow-up은 token·subject·device 모두 존재·일치해야 하며, Web body의 고정/위조 subject·device만으로는 재개되지 않는다. raw token은 Audit redaction 대상이다.
- Sol BLOCK delta: pending confirmation 경로의 nested DENY는 즉시 top-level `DENY`로 반환한다. `VERIFY_FAILED → VERIFY_FAILED` 재검증 실패 전이를 명시하고, 비가역 action은 Runtime 레벨에서도 rollback을 거부한다. lockfile이 없으므로 CI의 npm cache를 제거했다.
- Node 전체 테스트 및 정적 검사: `npm run verify` PASS — Node test files 17개, assertion 718개 PASS; 모든 `.cjs`에 `node --check` PASS.
- Android: `android/gradlew` wrapper 부재. Kotlin 컴파일 테스트 대신 permission/client 전달 정적 계약 검사를 `npm run verify`에 포함했고 PASS.
- CI: `PENDING` (최종 HEAD에서 감사 통과 후 1회 실행)
- 배포: `PENDING` (CI GREEN 이후 별도 확인, 본 작업에서 실행하지 않음)
- 실패 원인 및 수정: 기존 `verify` 스크립트가 가리키는 `tests/verify-core.cjs`가 없어서 실제 전체 검증이 불가능한 상태였음. 전체 Node test runner와 정적 검사로 교체해 수정. Sol 검토에서 continuation token 미구현·pending DENY 미전파·VERIFY_FAILED 재검증 불일치·lockfile 없는 npm cache를 발견해 본 delta로 수정.
- 원격 반영 차단: 일반 Git push는 HTTPS 자격증명이 없어 실패했고, 연결된 GitHub integration의 branch 생성도 `403 Resource not accessible by integration`으로 거부됨. 동일 상태 재시도 없이 중단. 로컬 최종 HEAD `1d4cba8` 이후 본 실패 기록 커밋만 추가하며, 원격 쓰기 권한 복구 후 최종 원격 HEAD에서 CI를 1회 실행해야 함.
