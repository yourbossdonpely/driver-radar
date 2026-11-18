'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const bus = require('./lib/bus');
const scan = require('./lib/scan');
const jobs = require('./lib/jobs');
const { checkAdmin, isAdminSync } = require('./lib/admin');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 7788);
const VERSION = '1.0.0';

// A dead local server looks like "Failed to fetch" in the browser, so log any
// stray error and keep serving instead of exiting silently.
function logCrash(kind, err) {
  try {
    fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
    fs.appendFileSync(
      path.join(ROOT, 'data', 'server.err.log'),
      `[${new Date().toISOString()}] ${kind}: ${err?.stack || err}\n`,
    );
  } catch {
    /* logging must never throw */
  }
}

process.on('uncaughtException', (err) => logCrash('uncaughtException', err));
process.on('unhandledRejection', (err) => logCrash('unhandledRejection', err));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) {
    return json(res, 403, { error: 'forbidden' });
  }
  try {
    const data = await fsp.readFile(file);
    const ext = path.extname(file).toLowerCase();
    const noStore = rel === 'index.html' || ext === '.js' || ext === '.css';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noStore ? 'no-store' : 'public, max-age=3600',
    });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

function localOnly(req) {
  const host = String(req.headers.host || '');
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
}

function statePayload() {
  return {
    scan: scan.snapshot(),
    admin: isAdminSync(),
    jobs: jobs.listJobs(),
    version: VERSION,
    downloads: jobs.DOWNLOAD_DIR,
  };
}

async function handleApi(req, res, url) {
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/api/state') {
    return json(res, 200, statePayload());
  }

  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    bus.add(res);
    res.write(`data: ${JSON.stringify({ type: 'state', data: statePayload() })}\n\n`);
    return undefined;
  }

  if (req.method === 'POST' && pathname === '/api/scan') {
    const result = await scan.scan();
    return json(res, 200, result);
  }

  if (req.method === 'POST' && pathname === '/api/install') {
    const body = await readBody(req);
    const byId = new Map(scan.state.rows.map((row) => [row.id, row]));
    const items = [];

    for (const selection of body.items || []) {
      const row = byId.get(selection.rowId);
      if (!row || !row.latest) continue;
      items.push({
        rowId: row.id,
        name: row.name,
        hardwareId: row.hardwareId,
        version: row.latest.version,
        source: row.latest.source,
        kind: row.latest.downloadKind,
        catalogId: row.latest.catalogId,
        downloadUrl: row.latest.downloadUrl,
        updateId: row.latest.updateId,
        sizeBytes: row.latest.sizeBytes,
      });
    }

    if (!items.length) return json(res, 400, { error: 'No installable updates were selected.' });
    const result = await jobs.startJob({
      items,
      install: body.install !== false,
      parts: body.parts,
      restorePoint: body.restorePoint,
    });
    return json(res, result.error ? 409 : 200, result);
  }

  if (req.method === 'POST' && pathname === '/api/cancel') {
    const body = await readBody(req);
    const ok = jobs.cancelJob(body.jobId);
    return json(res, ok ? 200 : 404, { ok });
  }

  if (req.method === 'POST' && pathname === '/api/open') {
    const body = await readBody(req);
    let target = jobs.DOWNLOAD_DIR;
    if (body.file) {
      const resolved = path.resolve(body.file);
      if (!resolved.startsWith(jobs.DOWNLOAD_DIR)) return json(res, 403, { error: 'forbidden' });
      target = resolved;
    }
    const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/elevate') {
    // Absolute path: an elevated shell may not have the user PATH that holds node.
    // Start the supervisor (not the server directly) so the elevated instance is
    // also crash-protected and "Retry now" keeps working after the hand-off.
    const nodeExe = process.execPath.replace(/'/g, "''");
    const script =
      `Start-Process -FilePath '${nodeExe}' -ArgumentList 'supervisor.js' ` +
      `-WorkingDirectory '${ROOT.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden`;
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
    json(res, 200, { ok: true, restarting: true });
    setTimeout(() => process.exit(0), 900);
    return undefined;
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, { ok: true, version: VERSION, admin: isAdminSync() });
  }

  return json(res, 404, { error: 'unknown endpoint' });
}

const server = http.createServer(async (req, res) => {
  if (!localOnly(req)) return json(res, 403, { error: 'local access only' });

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    return await serveStatic(res, url.pathname);
  } catch (err) {
    logCrash('request', err);
    if (!res.headersSent) json(res, 500, { error: err.message || String(err) });
    return undefined;
  }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  else socket.destroy();
});

function listen(attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 24) {
      setTimeout(() => listen(attempt + 1), 500);
    } else {
      console.error('Server error:', err.message);
      process.exit(1);
    }
  });

  server.listen(PORT, '127.0.0.1', async () => {
    await checkAdmin();
    const url = `http://127.0.0.1:${PORT}`;
    console.log(`\n  DriverRadar running at ${url}`);
    console.log(`  Administrator: ${isAdminSync() ? 'yes' : 'no (installations disabled)'}`);
    console.log(`  Downloads: ${jobs.DOWNLOAD_DIR}\n`);

    if (process.argv.includes('--open')) {
      spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
  });
}

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

listen();
