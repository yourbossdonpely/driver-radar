'use strict';

const { spawn } = require('node:child_process');

let cached = null;

function checkAdmin() {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
      ],
      { windowsHide: true },
    );
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.on('close', () => {
      cached = out.trim().toLowerCase() === 'true';
      resolve(cached);
    });
    child.on('error', () => resolve(false));
  });
}

function isAdminSync() {
  return cached === true;
}

module.exports = { checkAdmin, isAdminSync };
