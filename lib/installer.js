'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runPowerShell } = require('./ps');

const SEVEN_ZIP = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  '7z.exe',
];

function run(cmd, args, { timeout = 600000, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, cwd });
    let out = '';
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output: out });
    };
    const timer = setTimeout(() => {
      child.kill();
      done(-1);
    }, timeout);
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      out += d.toString();
    });
    child.on('error', (e) => {
      out += e.message;
      done(-2);
    });
    child.on('close', (code) => done(code ?? -3));
  });
}

async function extractCab(cabPath, outDir) {
  await fsp.mkdir(outDir, { recursive: true });

  for (const exe of SEVEN_ZIP) {
    if (exe.includes('\\') && !fs.existsSync(exe)) continue;
    const res = await run(exe, ['x', '-y', '-o' + outDir, cabPath], { timeout: 600000 });
    if (res.code === 0) return { ok: true, tool: '7z', output: res.output };
  }

  // Built-in fallback.
  const res = await run('expand.exe', ['-F:*', cabPath, outDir], { timeout: 600000 });
  return { ok: res.code === 0, tool: 'expand', output: res.output };
}

async function findInf(root) {
  const found = [];
  const walk = async (dir) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.inf$/i.test(entry.name)) found.push(full);
    }
  };
  await walk(root);
  return found;
}

function readInfText(file) {
  const buf = fs.readFileSync(file);
  if (buf.length > 1 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
  const latin = buf.toString('latin1');
  // Most INFs shipped by OEMs are UTF-16LE without a BOM.
  return latin.includes('\u0000') ? buf.toString('utf16le') : latin;
}

/**
 * Confirm the extracted package actually declares this device. Guards against
 * installing a same-version package published for a different piece of hardware.
 */
async function infsMatching(root, hardwareId) {
  if (!hardwareId) return [];
  const files = await findInf(root);
  const needle = String(hardwareId).toUpperCase();
  const pair = /(?:VEN|VID)_[0-9A-F]+&(?:DEV|PID)_[0-9A-F]+/i.exec(needle)?.[0] || null;

  const matches = [];
  for (const file of files) {
    let text = '';
    try {
      text = readInfText(file).toUpperCase();
    } catch {
      continue;
    }
    if (text.includes(needle) || (pair && text.includes(pair))) matches.push(file);
  }
  return matches;
}

/**
 * Install an extracted driver package with pnputil.
 */
async function installInfRoot(root) {
  const result = await runPowerShell('install-inf.ps1', ['-Root', root], { timeout: 900000 });
  return {
    ok: Boolean(result.ok),
    reboot: Boolean(result.reboot),
    count: result.count || 0,
    results: result.results || [],
    log: result.log || result.error || '',
  };
}

/**
 * Silent vendor installer. Only NVIDIA is opted in — everything else is
 * left to the user, because vendor setup wizards mutate a lot of state.
 */
async function runVendorInstaller(exePath, { onLog = () => {} } = {}) {
  const name = path.basename(exePath).toLowerCase();
  const args = [];
  if (name.includes('nvidia')) args.push('-s', '-noreboot');
  else return { ok: false, skipped: true, log: 'No silent install recipe for this vendor package. Run it manually.' };

  onLog(`Running ${path.basename(exePath)} ${args.join(' ')}`);
  const res = await run(exePath, args, { timeout: 30 * 60 * 1000 });
  const reboot = /reboot/i.test(res.output);
  return { ok: res.code === 0, reboot, log: res.output.slice(-8000) };
}

/**
 * Export every third-party driver package currently on the machine with
 * `pnputil /export-driver *`, so a bad update can be rolled back without
 * relying on a restore point.
 */
async function exportDrivers(outDir) {
  const result = await runPowerShell('export-drivers.ps1', ['-OutDir', outDir], { timeout: 600000 });
  return {
    ok: Boolean(result.ok),
    path: result.path || outDir,
    count: result.count || 0,
    error: result.error || null,
  };
}

async function createRestorePoint() {
  return runPowerShell('restore-point.ps1', ['-Description', `DriverRadar ${new Date().toISOString()}`], {
    timeout: 300000,
  });
}

module.exports = {
  extractCab,
  findInf,
  infsMatching,
  installInfRoot,
  runVendorInstaller,
  createRestorePoint,
  exportDrivers,
};
