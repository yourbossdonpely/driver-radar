'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const TMP = path.join(os.tmpdir(), 'driver-radar');
fs.mkdirSync(TMP, { recursive: true });

function tmpFile(ext = '.json') {
  return path.join(TMP, `du-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}${ext}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Compare dotted versions numerically. Handles 32.0.16.2124 vs 32.0.16.1687,
 * tolerates missing parts and stray text ("n/a", "10.0.1.2 (beta)").
 * Returns 1 when a > b, -1 when a < b, 0 when equal.
 */
function compareVersions(a, b) {
  const norm = (v) =>
    String(v == null ? '' : v)
      .match(/\d+/g)
      ?.map((n) => Number.parseInt(n, 10)) ?? [];
  const pa = norm(a);
  const pb = norm(b);
  if (!pa.length || !pb.length) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function decodeEntities(s) {
  return String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  let active = 0;
  await new Promise((resolve, reject) => {
    const pump = () => {
      if (cursor >= items.length && active === 0) return resolve();
      while (active < limit && cursor < items.length) {
        const index = cursor;
        cursor += 1;
        active += 1;
        Promise.resolve()
          .then(() => worker(items[index], index))
          .then((value) => {
            out[index] = value;
          })
          .catch(() => {
            out[index] = null;
          })
          .finally(() => {
            active -= 1;
            pump();
          });
      }
      if (cursor >= items.length && active === 0) resolve();
    };
    pump();
  });
  return out;
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  TMP,
  tmpFile,
  sleep,
  compareVersions,
  formatBytes,
  decodeEntities,
  mapLimit,
  exists,
};
