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
- CI: 원격 HEAD `e6b0053`의 GitHub Actions `verify` run #1 (`34433457116`) SUCCESS.
- 배포: 코드와 분리된 `BLOCKED`. 확인 1회차에서 GitHub commit status에 Netlify 상태가 없었고, 확인 2회차에서 연결된 Netlify 계정에 `phone` 관련 프로젝트가 없었다. 동일 상태 추가 조회 없이 중단했으며, 기존 site ID 제공 또는 신규 site 생성·연결 결정이 필요하다.
- 실패 원인 및 수정: 기존 `verify` 스크립트가 가리키는 `tests/verify-core.cjs`가 없어서 실제 전체 검증이 불가능한 상태였음. 전체 Node test runner와 정적 검사로 교체해 수정. Sol 검토에서 continuation token 미구현·pending DENY 미전파·VERIFY_FAILED 재검증 불일치·lockfile 없는 npm cache를 발견해 본 delta로 수정.
- 원격 반영 이력: 일반 Git push는 HTTPS 자격증명 부재로 실패했고 GitHub integration도 최초 `403 Resource not accessible by integration`으로 거부되어 동일 상태 재시도 없이 중단함. 사용자가 저장소 접근을 저장한 뒤 branch 생성과 19개 변경 파일 반영이 성공했으며, 구현 파일 반영 마지막 원격 커밋은 `79519b3`이다. 본 원장 갱신 커밋을 최종 pre-PR HEAD로 삼아 CI를 1회 실행한다.

## 2026-09-10 — 폰친구 테스트 APK 다운로드 체계

### 조사 (Luna, 최초 1회)

- Android에는 `gradle-wrapper.jar`·`gradle-wrapper.properties`·Windows wrapper만 있고 Unix `android/gradlew`가 없어 Linux CI에서 빌드 명령을 실행할 수 없다.
- 앱의 `PHONE_FRIEND_BASE_URL`은 이전 `arkaon.netlify.app`을 가리키며, 운영 Web/API origin인 `https://arkaonphone.netlify.app`과 다르다.
- Android unit test·debug APK·SHA-256·메타데이터를 하나의 재현 가능한 CI 산출물로 만드는 workflow와 안정된 다운로드 URL이 없다.
- Netlify는 `web/phone-friend`를 정적 publish 경로로 쓰므로 GitHub Release asset을 직접 링크할 수 있으며, 별도 Netlify redirect/header는 필요하지 않다.

### 범위 확정

- CHANGE: Unix Gradle wrapper, Java 17 Android CI, debug APK artifact·SHA-256·metadata, `main` 전용 커밋별 불변 prerelease/asset 생성, 모바일 다운로드 카드, API origin 정합성을 추가한다.
- KEEP: `versionName` `0.1.0`, `versionCode` `1`, `minSdk` 26(Android 8.0), `READ_CONTACTS`·`RECORD_AUDIO`만 유지한다.
- NEVER: `WRITE_CONTACTS` 추가, 정식 keystore/서명키 저장, Google Play 등록, 실문자·결제·메일·주문, 운영 데이터 삭제를 수행하지 않는다. PR 이벤트는 Release/tag 쓰기를 절대 수행하지 않는다.
- ACCEPTANCE: PR/main 모두 Core verify·Android unit test·debug APK를 검증하고 artifact를 남긴다. `main`에서만 `phone-friend-test-<commit>` 불변 prerelease의 APK·checksum·metadata를 만든다. Web은 내부 테스트·Android 8+·알 수 없는 앱 설치 허용·debug signer 변경 시 앱/데이터 삭제 후 재설치 가능성 및 확인 링크를 명시한다.

### 구현·검증·실패 원인

- Terra 구현: `android/gradlew`를 복구하고 CI에서 실행 권한을 부여한다. Base URL을 `arkaonphone.netlify.app`으로 맞춘다. `android-test-apk.yml`은 Gradle cache 없이 Core verify 후 `testDebugUnitTest`와 `assembleDebug`, APK 존재·SHA-256·Gradle 설정 추출 JSON을 검증하고 artifact로 올린다. main push 성공 뒤에만 커밋별 불변 prerelease와 세 asset을 생성한다.
- 검증: 로컬 `npm run verify` PASS(17개 suite, 718 passed/0 failed), `git diff --check` PASS, YAML 구조 검사 PASS, Release write 조건·URL·`WRITE_CONTACTS` 부재 정적 검사 PASS. `npm run verify`의 Kotlin 계약 검사는 Unix wrapper가 존재·실행 가능함도 확인한다.
- 실패 원인: 로컬은 `ANDROID_HOME`/`ANDROID_SDK_ROOT`가 비어 있고 Gradle 8.9 최초 다운로드가 격리 네트워크에서 `Network is unreachable`로 실패했다. wrapper launcher가 Gradle distribution 요청까지 도달한 것은 확인했으며, 이는 코드 실패가 아니라 로컬 SDK/네트워크 제약이다.
- PENDING: GitHub Actions의 Android SDK 환경에서 debug APK를 처음 생성한 뒤에만 다운로드 링크가 유효해진다. 이 단계에서는 keystore 없이 Android debug key로 내부 테스트 APK만 만든다.

### Sol BLOCK delta

- BLOCK 원인: 고정 force tag는 과거 APK를 바꿔 공급망 추적을 약화시키며, debug signer가 달라지면 덮어쓰기 설치 안내도 성립하지 않는다. checksum 파일은 asset 경로가 아닌 basename을 기록해야 독립 확인이 가능하다. action major tag와 무결성 미고정 Gradle 배포도 보완이 필요하다.
- 수정: 고정 tag/`softprops`/force push를 제거하고 `phone-friend-test-${GITHUB_SHA::12}` 불변 prerelease를 `gh release create`로 한 번만 생성한다. actions는 요청된 commit SHA로 pin하고 Gradle distribution SHA-256을 추가했다. checksum은 release asset basename으로 기록하며 version/minSdk는 Gradle 파일에서 추출한다. Web은 Releases 페이지를 기본 fallback으로 두고 GitHub public API에서 최신 prerelease의 세 asset URL을 DOM 속성·`textContent`로만 연결한다.
- 추가 검증: `main`만 `contents: write`이며 PR에는 release 작성 경로가 없고, main 최신 실행만 취소·우선하는 concurrency를 둔다. 새 빌드는 debug signer 변경 시 기존 앱과 데이터를 삭제한 뒤 재설치해야 할 수 있음을 UI에 명시한다.
- Delta 검증: `npm run verify` PASS(718 passed/0 failed), workflow YAML 구조·shell syntax PASS, metadata 추출(`0.1.0`/`1`/`26`) PASS, `git diff --check` PASS. 실제 Android build는 앞서 기록한 로컬 SDK/네트워크 제약 때문에 CI PENDING을 유지한다.
