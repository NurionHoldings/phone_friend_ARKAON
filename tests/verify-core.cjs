'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const node = process.execPath;
let failed = 0;

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const item = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') return [];
      return walk(item);
    }
    return entry.name.endsWith('.cjs') ? [item] : [];
  });
}

console.log('\n═══ Static checks ═══\n');
for (const file of walk(root)) {
  run(node, ['--check', file], `node --check ${path.relative(root, file)}`);
}

const kotlinChecks = [
  ['android/app/src/main/java/com/nurion/arkaon/phonefriend/PhoneFriendApiClient.kt', '"client", "ANDROID"'],
  ['android/app/src/main/java/com/nurion/arkaon/phonefriend/PhoneFriendApiClient.kt', '"permission_granted", true'],
  ['android/app/src/main/java/com/nurion/arkaon/bridge/ArkaonDeviceBridge.kt', 'permissionGranted = true'],
];
for (const [relative, required] of kotlinChecks) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  if (!source.includes(required)) {
    failed++;
    console.error(`FAIL: Kotlin static contract missing ${required} in ${relative}`);
  }
}
const gradleWrapper = path.join(root, 'android/gradlew');
if (!fs.existsSync(gradleWrapper) || (fs.statSync(gradleWrapper).mode & 0o111) === 0) {
  failed++;
  console.error('FAIL: Android Unix Gradle wrapper must exist and be executable at android/gradlew');
} else {
  console.log('Android Unix Gradle wrapper is present; Kotlin static contract checks ran.');
}

function requireStaticText(relative, required) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  for (const value of required) {
    if (!source.includes(value)) {
      failed++;
      console.error(`FAIL: static contract missing ${JSON.stringify(value)} in ${relative}`);
    }
  }
  return source;
}

const androidWorkflow = requireStaticText('.github/workflows/android-test-apk.yml', [
  'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  'actions/setup-java@cf277c60eb25467037889841efdb72551f06f6c3',
  'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
  'npm run verify',
  '(cd release-assets && sha256sum phone-friend-test.apk > phone-friend-test.apk.sha256)',
  'tag_name="phone-friend-test-${GITHUB_SHA::12}"',
  'gh release create "$tag_name"',
  "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
  'contents: write',
]);
if (
  androidWorkflow.includes('phone-friend-test-latest') ||
  androidWorkflow.includes('softprops/action-gh-release') ||
  androidWorkflow.includes('git push origin') ||
  androidWorkflow.includes('"versionName": "0.1.0"')
) {
  failed++;
  console.error('FAIL: Android release workflow must be immutable and extract version metadata from Gradle.');
}

requireStaticText('android/gradle/wrapper/gradle-wrapper.properties', [
  'distributionSha256Sum=d725d707bfabd4dfdc958c624003b3c80accc03f7037b5122c4b1d0ef15cecab',
]);

const downloadMarkup = requireStaticText('web/phone-friend/index.html', [
  'id="apkDownloadLink"',
  'id="apkChecksumLink"',
  'id="apkMetadataLink"',
  'https://github.com/NurionHoldings/phone_friend_ARKAON/releases',
  '기존 앱을 삭제한 뒤 설치해야 하며, 앱 데이터도 삭제됩니다.',
]);
if (downloadMarkup.includes('phone-friend-test-latest')) {
  failed++;
  console.error('FAIL: download markup must not point at a mutable fixed release asset.');
}

const webApp = requireStaticText('web/phone-friend/app.js', [
  'https://api.github.com/repos/NurionHoldings/phone_friend_ARKAON/releases',
  'release.prerelease === true',
  "release.tag_name.startsWith('phone-friend-test-')",
  'browser_download_url',
  'apkDownloadLink.textContent',
]);
const bindingStart = webApp.indexOf('async function bindLatestInternalTestApk');
const bindingEnd = webApp.indexOf('function isPermissionAllow');
if (
  bindingStart < 0 ||
  bindingEnd < bindingStart ||
  webApp.slice(bindingStart, bindingEnd).includes('innerHTML')
) {
  failed++;
  console.error('FAIL: APK release binding must use safe DOM attributes/textContent without innerHTML.');
}

console.log('\n═══ Node test suite ═══\n');
const tests = fs.readdirSync(__dirname)
  .filter((name) => /^test-.*\.cjs$/.test(name))
  .sort();
for (const test of tests) {
  run(node, [path.join(__dirname, test)], test);
}

process.exit(failed > 0 ? 1 : 0);
