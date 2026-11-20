'use strict';

/* Regression tests for lib/backup.js — INF parsing (UTF-8 and UTF-16LE BOM). */

const assert = require('node:assert');
const { parseInf } = require('../lib/backup');

const utf8 = parseInf('test/fixtures/nvidia.inf');
assert.ok(utf8, 'utf8 inf parsed');
assert.strictEqual(utf8.version, '32.0.16.2124', 'utf8 DriverVer version');
assert.strictEqual(utf8.date, '03/15/2024', 'utf8 DriverVer date');
assert.strictEqual(utf8.provider, 'NVIDIA', 'utf8 provider');
assert.strictEqual(utf8.filePath, 'test/fixtures/nvidia.inf');

const utf16 = parseInf('test/fixtures/nvidia-legacy.inf');
assert.ok(utf16, 'utf16le BOM inf parsed');
assert.strictEqual(utf16.version, '31.0.15.3632', 'utf16 DriverVer version');
assert.strictEqual(utf16.date, '01/10/2023', 'utf16 DriverVer date');
assert.strictEqual(utf16.provider, 'NVIDIA', 'utf16 provider');
assert.strictEqual(utf16.textLower.indexOf('provider = nvidia') >= 0, true, 'textLower present');

// Missing DriverVer / missing file degrades gracefully instead of throwing.
assert.strictEqual(parseInf('test/fixtures/does-not-exist.inf'), null);

console.log('backup: parseInf checks passed');
