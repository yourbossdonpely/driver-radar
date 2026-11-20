'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { compareVersions } = require('./util');

const DEFAULT_BACKUP_DIR = path.join(__dirname, '..', 'data', 'driver-backup');
const DEST_FILE = path.join(__dirname, '..', 'data', 'backup-destination.json');

let customBackupDir = null;

function loadCustomDir() {
  try {
    const raw = JSON.parse(fs.readFileSync(DEST_FILE, 'utf8'));
    if (raw && raw.path) customBackupDir = raw.path;
  } catch {
    /* no custom destination set */
  }
}

function getBackupDir() {
  return customBackupDir || DEFAULT_BACKUP_DIR;
}

function setBackupDir(dir) {
  customBackupDir = dir;
  try {
    fs.mkdirSync(path.dirname(DEST_FILE), { recursive: true });
    fs.writeFileSync(DEST_FILE, JSON.stringify({ path: dir }));
  } catch {
    /* best-effort persistence */
  }
}

loadCustomDir();

const BACKUP_DIR = getBackupDir();

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

/**
 * Parse Windows INF file (handles UTF-16 LE and UTF-8).
 */
function parseInf(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const isUtf16 = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
    const text = isUtf16 ? buf.toString('utf16le') : buf.toString('utf8');

    const dvMatch = /DriverVer\s*=\s*([^,\r\n]+)\s*,\s*([^\r\n;]+)/i.exec(text);
    const date = dvMatch ? dvMatch[1].trim() : null;
    const version = dvMatch ? dvMatch[2].trim() : null;

    const provMatch = /Provider\s*=\s*([^\r\n;]+)/i.exec(text);
    const provider = provMatch ? provMatch[1].trim() : null;

    return {
      filePath,
      dir: path.dirname(filePath),
      date,
      version,
      provider,
      textLower: text.toLowerCase(),
    };
  } catch {
    return null;
  }
}

/**
 * Index all exported INF packages across all backups for fast rollback lookups.
 */
async function indexAllBackups() {
  const backups = await listBackups();
  const index = [];

  for (const b of backups) {
    const walk = (dir) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.inf$/i.test(entry.name)) {
          const parsed = parseInf(full);
          if (parsed && parsed.version) {
            index.push({
              backupId: b.id,
              backupDate: b.createdAt,
              ...parsed,
            });
          }
        }
      }
    };
    walk(b.dir);
  }

  return index;
}

function hwidList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(/[\r\n;]+/);
  return [];
}

/**
 * Find rollback candidate drivers for a list of scanned hardware devices.
 */
async function findRollbacks(devices) {
  const packages = await indexAllBackups();
  const rollbacks = {};

  for (const device of devices || []) {
    // Scan rows carry a single hardware ID; inventory devices carry an array.
    const hwids = hwidList(device.hardwareId)
      .map((h) => String(h).toLowerCase().trim())
      .filter(Boolean);
    if (!hwids.length) continue;

    // Look for matching INF packages in backups
    const matches = [];
    for (const pkg of packages) {
      const isMatch = hwids.some((hwid) => {
        if (pkg.textLower.includes(hwid)) return true;
        // Generic pair check (VEN_xxxx&DEV_xxxx)
        const pair = /(?:ven|vid)_[0-9a-f]+&(?:dev|pid)_[0-9a-f]+/i.exec(hwid)?.[0];
        return pair && pkg.textLower.includes(pair);
      });

      if (isMatch) {
        matches.push(pkg);
      }
    }

    if (!matches.length) continue;

    // Newest snapshot first, then prefer a package that is genuinely older
    // than what is installed. A different-but-newer package is not a rollback;
    // it is only a restore candidate when nothing is installed at all.
    matches.sort((a, b) => String(b.backupDate || '').localeCompare(String(a.backupDate || '')));
    const installed = String(device.version || '');
    const older = matches.find((m) => installed && compareVersions(m.version, installed) < 0);
    const different = matches.find((m) => m.version !== installed);
    const candidate = installed ? older : (different || null);
    if (candidate) {
      rollbacks[device.id] = {
        deviceId: device.id,
        backupId: candidate.backupId,
        backupDate: candidate.backupDate,
        dir: candidate.dir,
        infPath: candidate.filePath,
        name: device.name || null,
        version: candidate.version,
        date: candidate.date,
        provider: candidate.provider,
      };
    }
  }

  return rollbacks;
}

/**
 * Delete a backup folder to reclaim disk space.
 */
async function deleteBackup(id) {
  const dir = resolveBackup(id);
  if (!dir) return false;
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  BACKUP_DIR,
  getBackupDir,
  setBackupDir,
  listBackups,
  resolveBackup,
  findRollbacks,
  deleteBackup,
  parseInf,
};
