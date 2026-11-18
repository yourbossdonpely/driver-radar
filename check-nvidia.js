#!/usr/bin/env node
'use strict';

// Checks the NVIDIA matcher in lib/nvidia.js against the live NVIDIA lookup.
//
//   node check-nvidia.js
//   node check-nvidia.js "NVIDIA GeForce RTX 5070 Ti Laptop GPU"
//
// No test framework and no dependencies: one plain Node script that prints a
// line per case and exits 1 if any assertion fails. It only reads the public
// lookup API, so it is safe to run at any time (it needs internet).
//
// The rules being checked are the ones that stop a laptop getting a desktop
// package: a name with Laptop/Notebook/Mobile/Max-Q must land in a
// "… (Notebooks)" series and a notebook URL, a desktop name must land in a
// desktop series with a desktop URL, and a model NVIDIA does not list must
// return null so the catalog answers instead.

const nvidia = require('./lib/nvidia.js');

const CASES = [
  { kind: 'laptop', name: 'NVIDIA GeForce RTX 2080 with Max-Q Design' },
  { kind: 'laptop', name: 'NVIDIA GeForce GTX 1660 Ti Max-Q' },
  { kind: 'laptop', name: 'NVIDIA GeForce GTX 1650 Ti' },
  { kind: 'laptop', name: 'NVIDIA GeForce RTX 5070 Ti Laptop GPU' },
  { kind: 'laptop', name: 'NVIDIA GeForce RTX 3060 Laptop GPU' },
  { kind: 'laptop', name: 'NVIDIA GeForce RTX 2060 Mobile' },
  { kind: 'desktop', name: 'NVIDIA GeForce RTX 5070 Ti' },
  { kind: 'desktop', name: 'NVIDIA GeForce RTX 2080' },
  { kind: 'desktop', name: 'NVIDIA GeForce GTX 1660 Ti' },
  { kind: 'unknown', name: 'NVIDIA GeForce RTX 9999 Laptop GPU' },
  { kind: 'unknown', name: 'NVIDIA GeForce RTX 9999' },
];

const NOTEBOOK_SERIES = /notebook/i;
const NOTEBOOK_URL = /-notebook-/i;
const DESKTOP_URL = /-desktop-/i;

function label(kind) {
  return kind.padEnd(7);
}

/**
 * One case → { ok, detail } or { ok: false, reason }. Never throws: a network
 * failure has to be reported per case like any other failure.
 */
async function check(kind, name) {
  let found;
  let driver;
  try {
    found = await nvidia.findProduct(name);
    driver = found ? await nvidia.latestDriver(name) : null;
  } catch (err) {
    return { ok: false, reason: `lookup failed: ${err.message || err}` };
  }

  if (kind === 'unknown') {
    if (found) return { ok: false, reason: `expected null, got "${found.product.name}" in "${found.series.name}"` };
    return { ok: true, detail: 'no product (catalog decides)' };
  }

  if (!found) return { ok: false, reason: 'no product matched, expected one' };
  if (!driver) return { ok: false, reason: `matched "${found.product.name}" but no WHQL driver came back` };

  const seriesNotebook = NOTEBOOK_SERIES.test(found.series.name);
  const url = String(driver.downloadUrl || '');
  const detail = `${found.product.name} · ${found.series.name} · ${driver.version}`;

  if (kind === 'laptop') {
    if (!seriesNotebook) return { ok: false, reason: `resolved to desktop series "${found.series.name}"`, detail };
    if (!NOTEBOOK_URL.test(url)) return { ok: false, reason: `notebook series but URL is "${url}"`, detail };
    if (DESKTOP_URL.test(url)) return { ok: false, reason: `notebook series but desktop URL "${url}"`, detail };
    return { ok: true, detail };
  }

  // Desktop: the mirror image. A desktop part may legitimately fall back to a
  // notebook series only for parts whose Windows name carries no laptop marker,
  // so require a desktop resolution and flag anything else as a failure.
  if (seriesNotebook) return { ok: false, reason: `resolved to notebook series "${found.series.name}"`, detail };
  if (!DESKTOP_URL.test(url)) return { ok: false, reason: `desktop series but URL is "${url}"`, detail };
  return { ok: true, detail };
}

async function main() {
  const extra = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const cases = extra.length ? extra.map((name) => ({ kind: 'laptop', name })) : CASES;

  console.log(`DriverRadar — NVIDIA matcher check (${cases.length} case${cases.length === 1 ? '' : 's'})`);
  console.log('');

  let failed = 0;
  for (const { kind, name } of cases) {
    const result = await check(kind, name);
    if (result.ok) {
      console.log(`ok    ${label(kind)} ${name}`);
      console.log(`      ${result.detail}`);
    } else {
      failed += 1;
      console.log(`FAIL  ${label(kind)} ${name}`);
      console.log(`      ${result.reason}`);
      if (result.detail) console.log(`      ${result.detail}`);
    }
  }

  console.log('');
  if (failed) {
    console.log(`${failed} of ${cases.length} case${cases.length === 1 ? '' : 's'} failed.`);
    process.exitCode = 1;
    return;
  }
  console.log(`All ${cases.length} cases passed.`);
}

main().catch((err) => {
  console.error(`Check crashed: ${err.stack || err}`);
  process.exitCode = 1;
});
