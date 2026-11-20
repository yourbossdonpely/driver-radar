'use strict';

/* Regression tests for lib/util.js — pure helpers, no network, no Windows APIs. */

const assert = require('node:assert');
const { compareVersions, formatBytes, mapLimit } = require('../lib/util');

let checks = 0;
function ok(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg);
  checks += 1;
}

// Numeric dotted comparison, tail blocks matter.
ok(compareVersions('32.0.16.2124', '32.0.16.1687'), 1, 'newer tail wins');
ok(compareVersions('32.0.16.1687', '32.0.16.2124'), -1, 'older tail loses');
ok(compareVersions('32.0.16.2124', '32.0.16.2124'), 0, 'equal versions');
// Missing parts compare as zero.
ok(compareVersions('1.2', '1.2.0'), 0, 'trailing zero parts equal');
ok(compareVersions('1.2.1', '1.2'), 1, 'extra part wins');
// Non-numeric text is tolerated.
ok(compareVersions('10.0.1.2 (beta)', '10.0.1.2'), 0, 'beta suffix ignored');
ok(compareVersions('n/a', '1.0'), 0, 'unparseable vs real is equal (no parts)');
ok(compareVersions('', '1.0'), 0, 'empty vs real is equal');
ok(compareVersions('', ''), 0, 'empty vs empty equal');
ok(compareVersions('2.0', '10.0'), -1, '2.0 < 10.0 component-wise');
ok(compareVersions('10', '2'), 1, '10 > 2 component-wise');

assert.strictEqual(formatBytes(0), '0 B');
assert.strictEqual(formatBytes(1024), '1.0 KB');
assert.strictEqual(formatBytes(1536), '1.5 KB');
assert.strictEqual(formatBytes(35.8 * 1024 * 1024), '35.8 MB');
checks += 4;

console.log(`util: ${checks} checks passed`);

// mapLimit respects concurrency cap.
(async () => {
  const active = [];
  let max = 0;
  await mapLimit([1, 2, 3, 4, 5], 2, async (i) => {
    active.push(i);
    max = Math.max(max, active.length);
    await new Promise((r) => setTimeout(r, 20));
    active.splice(active.indexOf(i), 1);
  });
  assert.strictEqual(max, 2, 'concurrency capped at limit');
  console.log('util: mapLimit concurrency OK');
})();
