'use strict';

/* Regression tests for lib/intel.js — device classification, no network. */

const assert = require('node:assert');
const { classifyIntelDevice } = require('../lib/intel');

let checks = 0;
function ok(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg);
  checks += 1;
}

// Graphics: Arc
ok(classifyIntelDevice({ name: 'Intel(R) Arc(TM) A770 Graphics', className: 'DISPLAY', provider: 'Intel' }), 'graphics', 'Arc graphics');
// Graphics: Iris Xe
ok(classifyIntelDevice({ name: 'Intel(R) Iris(R) Xe Graphics', className: 'DISPLAY', provider: 'Intel' }), 'graphics', 'Iris Xe graphics');
// Graphics: UHD
ok(classifyIntelDevice({ name: 'Intel(R) UHD Graphics 630', className: 'DISPLAY', provider: 'Intel' }), 'graphics', 'UHD graphics');
// Graphics: HD
ok(classifyIntelDevice({ name: 'Intel(R) HD Graphics Family', className: 'DISPLAY', provider: 'Intel' }), 'graphics', 'HD graphics');
// Graphics: generic Intel Graphics
ok(classifyIntelDevice({ name: 'Intel(R) Graphics', className: 'DISPLAY', provider: 'Intel' }), 'graphics', 'generic Intel graphics');
// Not graphics: DISPLAY but non-Intel name
ok(classifyIntelDevice({ name: 'NVIDIA GeForce RTX 3060', className: 'DISPLAY', provider: 'NVIDIA' }), null, 'NVIDIA display not Intel');
// Not Intel at all
ok(classifyIntelDevice({ name: 'Realtek Audio', className: 'MEDIA', provider: 'Realtek' }), null, 'non-Intel device');

// Wi-Fi
ok(classifyIntelDevice({ name: 'Intel(R) Wi-Fi 6 AX201', className: 'NET', provider: 'Intel' }), 'wifi', 'Intel Wi-Fi');
// Wi-Fi: Killer
ok(classifyIntelDevice({ name: 'Killer Wi-Fi 6 AX1650', className: 'NET', provider: 'Intel' }), 'wifi', 'Killer Wi-Fi');

// Bluetooth
ok(classifyIntelDevice({ name: 'Intel(R) Wireless Bluetooth', className: 'BLUETOOTH', provider: 'Intel' }), 'bluetooth', 'Intel Bluetooth');

// CPU
ok(classifyIntelDevice({ name: 'Intel(R) Core(TM) i7-10700K', className: 'PROCESSOR', provider: 'Intel' }), 'cpu', 'Intel CPU');
// CPU: Intel provider on processor class
ok(classifyIntelDevice({ name: 'Intel Processor', className: 'PROCESSOR', provider: 'Intel' }), 'cpu', 'Intel processor class');

// Chipset
ok(classifyIntelDevice({ name: 'Intel(R) Chipset Device', className: 'SYSTEM', provider: 'Intel' }), 'chipset', 'Intel chipset');

// Not Intel provider on SYSTEM
ok(classifyIntelDevice({ name: 'ACPI Fixed Button', className: 'SYSTEM', provider: 'Microsoft' }), null, 'non-Intel system');

// Unknown class with Intel name
ok(classifyIntelDevice({ name: 'Intel(R) Unknown Device', className: 'UNKNOWN', provider: 'Intel' }), null, 'unknown class not classified');

console.log(`intel: ${checks} checks passed`);
