'use strict';

/* Regression tests for lib/nvidia.js — pure helpers only (no network calls). */

const assert = require('node:assert');
const nvidia = require('../lib/nvidia');

const { key, tail4, installedTail, isNotebook, seriesScore, productScore, normaliseGpuName } = nvidia;

let checks = 0;
function ok(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg);
  checks += 1;
}

ok(key('NVIDIA GeForce RTX 3060'), 'geforce rtx 3060', 'drops NVIDIA prefix, lowercases');
ok(key('GeForce GTX 1660 Ti Max-Q'), 'geforce gtx 1660 ti max-q', 'keeps tier and suffix');
ok(normaliseGpuName('NVIDIA GeForce® RTX 3060'), 'NVIDIA GeForce RTX 3060', 'strips trademark glyphs');

ok(tail4('32.0.16.2124'), 2124, 'windows build tail');
ok(tail4('32.0.16.1687'), 1687, 'older build tail');
ok(tail4('621.24'), 2124, 'marketing version maps to same build tail');
ok(tail4('n/a'), 0, 'unparseable tail is 0');
ok(tail4(''), 0, 'empty tail is 0');

ok(installedTail('32.0.16.2124'), 2124, 'installed build tail');
ok(installedTail('31.0.15.3632'), 3632, 'installed legacy tail');
ok(installedTail(''), 0, 'empty installed tail');

ok(isNotebook('NVIDIA GeForce RTX 3060 Laptop GPU'), true, 'laptop gpu is notebook');
ok(isNotebook('NVIDIA GeForce RTX 2080 with Max-Q Design'), true, 'max-q is notebook');
ok(isNotebook('NVIDIA GeForce RTX 2060 Mobile'), true, 'mobile is notebook');
ok(isNotebook('NVIDIA GeForce RTX 3060'), false, 'desktop is not notebook');

// seriesScore: notebook device must land in notebook series.
ok(seriesScore('GeForce RTX 30 Series (Notebooks)', 'NVIDIA GeForce RTX 3060 Laptop GPU') > 0, true, 'notebook device accepts notebook series');
ok(seriesScore('GeForce RTX 30 Series', 'NVIDIA GeForce RTX 3060 Laptop GPU'), 0, 'notebook device rejects desktop series');
// desktop device: notebook series only as fallback (base 1 + generation bonus 2), desktop series preferred (10 + 2).
ok(seriesScore('GeForce RTX 30 Series (Notebooks)', 'NVIDIA GeForce RTX 3060'), 3, 'desktop device falls back to notebook series');
ok(seriesScore('GeForce RTX 30 Series', 'NVIDIA GeForce RTX 3060') > seriesScore('GeForce RTX 30 Series (Notebooks)', 'NVIDIA GeForce RTX 3060'), true, 'desktop series outranks notebook fallback');
// generation bonus.
ok(seriesScore('GeForce RTX 30 Series (Notebooks)', 'NVIDIA GeForce RTX 3060 Ti Laptop GPU') > seriesScore('GeForce RTX 30 Series (Notebooks)', 'NVIDIA GeForce RTX 2060 Laptop GPU'), true, 'generation match scores higher');
// tier must match exactly.
ok(productScore('GeForce RTX 3060', 'NVIDIA GeForce RTX 3060 Ti'), 0, 'non-ti does not match ti');
ok(productScore('GeForce RTX 3060 Ti', 'NVIDIA GeForce RTX 3060 Ti'), 4, 'exact product match');
// prefix: product is a leading chunk of the device name.
ok(productScore('GeForce RTX 3060', 'NVIDIA GeForce RTX 3060 Mobile'), 3, 'product is prefix of device');
// wrong model: the model gate kills it before any fuzzy match.
ok(productScore('GeForce RTX 30', 'NVIDIA GeForce RTX 3060 Ti'), 0, 'model number missing from product');
ok(productScore('Quadro', 'NVIDIA GeForce RTX 3060'), 0, 'wrong model no match');
ok(productScore('', 'NVIDIA GeForce RTX 3060'), 0, 'empty product no match');
ok(productScore('GeForce RTX 3060', ''), 0, 'empty device no match');

console.log(`nvidia: ${checks} checks passed`);
