'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Every writable file the app keeps (scan cache, catalog cache, downloads,
 * driver backups, ignored updates) lives here.
 *
 * A ZIP checkout or a source tree keeps its familiar `data\` beside the code.
 * The desktop installers cannot: they live in Program Files, /Applications or
 * /opt, which are read-only for the user, so the Tauri shell points
 * DRIVERRADAR_DATA at a per-user folder before it starts this server.
 */
const DATA_DIR = process.env.DRIVERRADAR_DATA
  ? path.resolve(process.env.DRIVERRADAR_DATA)
  : path.join(__dirname, '..', 'data');

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {
  /* a read-only folder is reported by the first write that needs it */
}

module.exports = { DATA_DIR };
