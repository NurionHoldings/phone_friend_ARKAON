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
console.log('Android Gradle wrapper is unavailable (android/gradlew absent); Kotlin static contract checks ran.');

console.log('\n═══ Node test suite ═══\n');
const tests = fs.readdirSync(__dirname)
  .filter((name) => /^test-.*\.cjs$/.test(name))
  .sort();
for (const test of tests) {
  run(node, [path.join(__dirname, test)], test);
}

process.exit(failed > 0 ? 1 : 0);
