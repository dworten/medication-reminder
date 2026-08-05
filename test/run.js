'use strict';

// Runs every suite in its own process, so one suite's Prisma connection or a
// hard failure cannot take the others with it.
//
//   npm test
//
// scheduleMatch needs nothing. The other two read and write a real database and
// truncate every table between cases — they refuse to run if they find data
// that is not obviously a fixture (see helpers.assertScratchDatabase).

const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  ['frontend',      'frontend.test.js',      'pure — no database'],
  ['scheduleMatch', 'scheduleMatch.test.js', 'pure — no database'],
  ['scheduler',     'scheduler.test.js',     'needs DATABASE_URL'],
  ['twiml',         'twiml.test.js',         'needs DATABASE_URL'],
  ['sweeper',       'sweeper.test.js',       'needs DATABASE_URL'],
  ['escalation',    'escalation.test.js',    'needs DATABASE_URL'],
  ['api',           'api.test.js',           'needs DATABASE_URL'],
];

let failed = 0;

for (const [name, file, note] of SUITES) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${name}  (${note})`);
  console.log('='.repeat(70));

  const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
    stdio: 'inherit',
    env:   process.env,
  });

  if (result.status !== 0) {
    failed++;
    console.log(`\n  ${name} FAILED (exit ${result.status})`);
  }
}

console.log(`\n${'='.repeat(70)}`);
console.log(failed === 0 ? '  ALL SUITES PASSED' : `  ${failed} SUITE(S) FAILED`);
console.log('='.repeat(70));

process.exit(failed === 0 ? 0 : 1);
