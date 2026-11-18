'use strict';

/**
 * Keeps the local server alive.
 *
 * The browser cannot start a process, so the only way "Retry now" can really
 * work is for something outside the browser to bring the server back. This
 * supervisor runs next to start.cmd, watches /api/health, relaunches the
 * server when it dies, and stays out of the way when another instance (for
 * example an elevated hand-off) is already serving the port.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 7788);
const args = process.argv.slice(2);
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`;

let child = null;
let firstLaunch = true;
let stopping = false;
let restarts = 0;

async function healthy() {
  try {
    const res = await fetch(HEALTH_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function schedule(delay) {
  // Must stay referenced: with the child gone, an unref'd timer would let the
  // supervisor's event loop exit and nobody would restart the server.
  setTimeout(tick, delay);
}

async function tick() {
  if (stopping || child) return;

  // Another instance may own the port (elevated hand-off or a second launch).
  if (await healthy()) {
    schedule(4000);
    return;
  }

  const nodeArgs = ['server.js'];
  if (firstLaunch && args.includes('--open')) nodeArgs.push('--open');
  firstLaunch = false;

  if (restarts > 0) {
    console.log(`[supervisor] restarting the server (attempt ${restarts})…`);
  }

  child = spawn(process.execPath, nodeArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });

  child.on('error', (err) => {
    console.error(`[supervisor] could not start the server: ${err.message}`);
  });

  child.on('exit', async (code, signal) => {
    child = null;
    if (stopping) {
      process.exit(0);
      return;
    }

    // A normal hand-off (/api/elevate) leaves an elevated instance behind.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (await healthy()) {
      restarts = 0;
      schedule(4000);
      return;
    }

    restarts += 1;
    const delay = Math.min(15000, 800 * restarts);
    console.log(
      `[supervisor] server exited (${code ?? signal ?? 'unknown'}); retrying in ${Math.round(delay / 1000)}s…`,
    );
    schedule(delay);
  });
}

function shutdown(signal) {
  stopping = true;
  if (child) {
    try {
      child.kill(signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

tick();
