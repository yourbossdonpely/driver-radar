'use strict';

/* Regression tests for lib/catalog.js — hardware ID verification, no network. */

const assert = require('node:assert');
const { hardwareIdMatches } = require('../lib/catalog');

let checks = 0;
function ok(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg);
  checks += 1;
}

// Exact match, REV suffix ignored.
ok(hardwareIdMatches(['PCI\\VEN_10DE&DEV_2488'], ['PCI\\VEN_10DE&DEV_2488&REV_A1']), true, 'REV stripped matches');
ok(hardwareIdMatches(['PCI\\VEN_10DE&DEV_2488&REV_A1'], ['PCI\\VEN_10DE&DEV_2488']), true, 'REV stripped matches (reverse)');
// VEN/DEV pair equivalence.
ok(hardwareIdMatches(['PCI\\VEN_10DE&DEV_2488'], ['PCI\\VEN_10DE&DEV_2489&SUBSYS_0000']), false, 'different DEV no match');
ok(hardwareIdMatches(['PCI\\VEN_10DE&DEV_2488&SUBSYS_1111'], ['PCI\\VEN_10DE&DEV_2488&SUBSYS_1111']), true, 'SUBSYS equal matches');
ok(hardwareIdMatches(['PCI\\VEN_10DE&DEV_2488'], ['PCI\\VEN_10DE&DEV_2488&SUBSYS_1111']), true, 'bare pair matches subsys device');
// Case and whitespace.
ok(hardwareIdMatches(['pci\\ven_10de&dev_2488'], ['PCI\\VEN_10DE&DEV_2488']), true, 'case insensitive');
// Empty edges.
ok(hardwareIdMatches([], ['PCI\\VEN_10DE&DEV_2488']), false, 'no supported ids');
ok(hardwareIdMatches(['PCI\\VEN_10DE&DEV_2488'], []), false, 'no device ids');
ok(hardwareIdMatches(['PCI\\VEN_10DE&DEV_2488'], ['ROOT\\SWITCH']), false, 'unrelated id no match');
// Exact match also covers compound ACPI/USB ids (segments use &, not \).
ok(hardwareIdMatches(['ACPI\\INT3305&COL04'], ['ACPI\\INT3305&COL04']), true, 'exact compound id');
ok(hardwareIdMatches(['USB\\VID_045E&PID_07FD'], ['USB\\VID_045E&PID_07FD&MI_00']), true, 'MI suffix device matches base');

console.log(`catalog: ${checks} checks passed`);
