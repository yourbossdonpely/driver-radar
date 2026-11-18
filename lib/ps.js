'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const { tmpFile } = require('./util');

const SCRIPTS = path.join(__dirname, '..', 'scripts');

/**
 * Run one of the PowerShell helpers in scripts/ and return its JSON payload.
 * The script writes UTF-8 JSON to a temp file so console code pages never
 * mangle device names.
 */
function runPowerShell(script, args = [], { timeout = 180000 } = {}) {
  const scriptPath = path.join(SCRIPTS, script);
  const outFile = tmpFile('.json');

  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        ...args,
        '-OutFile',
        outFile,
      ],
      { windowsHide: true },
    );

    let stderr = '';
    let settled = false;
    const finish = async (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const raw = await fsp.readFile(outFile, 'utf8');
        await fsp.unlink(outFile).catch(() => {});
        resolve(JSON.parse(raw.replace(/^\uFEFF/, '')));
      } catch (err) {
        resolve({
          ok: false,
          error: stderr.trim() || `PowerShell helper failed (${result}).`,
        });
      }
    };

    const timer = setTimeout(() => {
      child.kill();
      finish('timeout');
    }, timeout);

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => finish(err.message));
    child.on('close', (code) => finish(`exit ${code}`));
  });
}

module.exports = { runPowerShell };
