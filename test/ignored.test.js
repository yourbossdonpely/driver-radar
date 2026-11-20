'use strict';

/* Regression tests for lib/ignored.js — ignored-update persistence. */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const IGNORED_FILE = path.join(__dirname, '..', 'data', 'ignored-updates.json');

// Clean slate: remove any existing ignored file before testing.
try { fs.unlinkSync(IGNORED_FILE); } catch { /* ignore */ }

// Clear require cache so loadIgnored runs fresh.
delete require.cache[require.resolve('../lib/ignored')];
const ignored = require('../lib/ignored');

let checks = 0;
function ok(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg);
  checks += 1;
}

// Initially empty.
ok(ignored.listIgnored().length, 0, 'no ignored rows on fresh start');

// Ignore a row.
ok(ignored.ignore('d146'), true, 'ignore d146 returns true');
ok(ignored.ignore('d146'), false, 'ignore d146 again returns false (already ignored)');
ok(ignored.isIgnored('d146'), true, 'd146 is ignored');
ok(ignored.isIgnored('d999'), false, 'd999 is not ignored');
ok(ignored.listIgnored().length, 1, 'one ignored row');

// Ignore another.
ok(ignored.ignore('d205'), true, 'ignore d205 returns true');
ok(ignored.listIgnored().length, 2, 'two ignored rows');

// Unignore.
ok(ignored.unignore('d146'), true, 'unignore d146 returns true');
ok(ignored.unignore('d146'), false, 'unignore d146 again returns false');
ok(ignored.isIgnored('d146'), false, 'd146 no longer ignored');
ok(ignored.listIgnored().length, 1, 'one ignored row after unignore');

// Persist: reload module and verify data survived.
delete require.cache[require.resolve('../lib/ignored')];
const ignored2 = require('../lib/ignored');
ok(ignored2.isIgnored('d205'), true, 'd205 still ignored after reload (persisted)');
ok(ignored2.isIgnored('d146'), false, 'd146 not ignored after reload');
ok(ignored2.listIgnored().length, 1, 'one ignored row after reload');

// Cleanup.
try { fs.unlinkSync(IGNORED_FILE); } catch { /* ignore */ }

console.log(`ignored: ${checks} checks passed`);
