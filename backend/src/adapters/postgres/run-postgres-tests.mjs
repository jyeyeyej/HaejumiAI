
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

const smokeTests = [
  'project-delete-test.mjs',
  'project-delete-render-test.mjs',
  'project-delete-rollback-test.mjs',
  'project-delete-relations-test.mjs'
];

const otherTests = [
  'approval-idempotency-test.mjs',
  'approval-concurrency-test.mjs',
  'render-claim-test.mjs',
  'render-lifecycle-test.mjs',
  'publication-test.mjs',
  'publication-approval-test.mjs'
];

const mode = process.argv[2] ?? '--smoke';

if (!['--smoke', '--all'].includes(mode)) {
  console.error('Usage: node run-postgres-tests.mjs --smoke|--all');
  process.exit(1);
}

if (!process.env.HAEJUMI_PG_PASSWORD) {
  console.error('HAEJUMI_PG_PASSWORD is required');
  process.exit(1);
}

const tests = mode === '--all'
  ? [...smokeTests, ...otherTests]
  : smokeTests;

let passed = 0;
let failed = 0;

for (const testFile of tests) {
  console.log(`\n[RUN] ${testFile}`);

  const result = spawnSync(
    process.execPath,
    [path.join(currentDir, testFile)],
    {
      cwd: currentDir,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true
    }
  );

  if (!result.error && result.status === 0) {
    passed++;
    console.log(`[PASS] ${testFile}`);
  } else {
    failed++;
    console.error(`[FAIL] ${testFile}`);

    if (result.error) {
      console.error(result.error.message);
    }

    break;
  }
}

console.log('\n=== PostgreSQL Test Summary ===');
console.log(`Passed files: ${passed}`);
console.log(`Failed files: ${failed}`);
console.log(`Total selected files: ${tests.length}`);

if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log('ALL SELECTED TEST FILES PASSED');
}
