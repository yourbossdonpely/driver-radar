'use strict';

/**
 * Tiny server-sent-events hub. The UI keeps one EventSource open and every
 * long-running task (scan, download, install) pushes snapshots through here.
 */
const clients = new Set();

function add(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
  res.on('error', () => clients.delete(res));
}

function emit(type, data) {
  const payload = `data: ${JSON.stringify({ type, data, at: Date.now() })}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

function heartbeat() {
  for (const res of clients) {
    try {
      res.write(': ping\n\n');
    } catch {
      clients.delete(res);
    }
  }
}

setInterval(heartbeat, 20000).unref();

module.exports = { add, emit, count: () => clients.size };
