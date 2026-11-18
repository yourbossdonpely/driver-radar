'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const BACKUP_DIR = path.join(__dirname, '..', 'data', 'driver-backup');

async function summarize(root) {
  let packages = 0;
  let sizeBytes = 0;
  let newest = 0;

  const walk = async (dir) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat) continue;
      sizeBytes += stat.size;
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      if (/\.inf$/i.test(entry.name)) packages += 1;
    }
  };

  await walk(root);
  return { packages, sizeBytes, newest };
}

/**
 * Snapshots written by `pnputil /export-driver *` before an install. A folder
 * without an INF is a failed export and is not offered.
 */
async function listBackups() {
  let entries;
  try {
    entries = await fsp.readdir(BACKUP_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(BACKUP_DIR, entry.name);
    const summary = await summarize(dir);
    if (!summary.packages) continue;
    out.push({
      id: entry.name,
      dir,
      packages: summary.packages,
      sizeBytes: summary.sizeBytes,
      createdAt: summary.newest ? new Date(summary.newest).toISOString() : null,
    });
  }

  out.sort(
    (a, b) =>
      String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || b.id.localeCompare(a.id),
  );
  return out;
}

/**
 * Map an id from the UI onto a directory inside BACKUP_DIR. Returns null for
 * anything that escapes it, so a request can never point pnputil at C:\Windows.
 */
function resolveBackup(id) {
  const name = String(id || '').trim();
  if (!name || name.includes('..') || /[\\/]/.test(name)) return null;
  const dir = path.join(BACKUP_DIR, name);
  if (!dir.startsWith(BACKUP_DIR + path.sep)) return null;
  return dir;
}

module.exports = { BACKUP_DIR, listBackups, resolveBackup };
