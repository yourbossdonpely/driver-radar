'use strict';

// Runs every test/*.test.js file. Each module asserts at load time and throws
// on failure, so this runner needs no test framework — plain Node core only.
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

let failed = 0;
for (const file of files) {
  process.stdout.write(`  ${file} ... `);
  try {
    require(path.join(dir, file));
    console.log('PASS');
  } catch (err) {
    failed += 1;
    console.log('FAIL');
    console.log(`    ${err.message}`);
  }
}

if (failed) {
  console.log(`\n${failed} test file${failed === 1 ? '' : 's'} failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${files.length} test file${files.length === 1 ? '' : 's'} passed.`);
}
