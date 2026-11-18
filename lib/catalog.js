'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { decodeEntities } = require('./util');

const BASE = 'https://www.catalog.update.microsoft.com';
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

const CACHE_FILE = path.join(__dirname, '..', 'data', 'catalog-cache.json');
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const cache = new Map();

function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    for (const [key, entry] of Object.entries(raw)) {
      if (entry && Date.now() - entry.t < CACHE_TTL_MS) cache.set(key, entry);
    }
  } catch {
    /* first run */
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const obj = {};
    for (const [key, entry] of cache) obj[key] = entry;
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fsp.writeFile(CACHE_FILE, JSON.stringify(obj)).catch(() => {});
  }, 2000);
  saveTimer.unref?.();
}

loadCache();

async function fetchText(url, { timeout = 30000, init = {} } = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { ...HEADERS, ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`Catalog HTTP ${res.status}`);
  return res.text();
}

/**
 * Search the public Microsoft Update Catalog.
 * Returns normalised driver rows sorted by version (newest first).
 */
async function searchCatalog(query) {
  const key = String(query || '').trim().toLowerCase();
  if (!key) return [];

  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.rows;

  const url = `${BASE}/Search.aspx?q=${encodeURIComponent(query)}&print=true`;
  let html;
  try {
    html = await fetchText(url);
  } catch {
    return [];
  }

  const table = html.match(/id="ctl00_catalogBody_updateMatches"[\s\S]*?<\/table>/);
  if (!table) {
    cache.set(key, { t: Date.now(), rows: [] });
    scheduleSave();
    return [];
  }

  const rows = [];
  const rowRe = /<tr id="([0-9a-f-]{36})_R(\d+)"[\s\S]*?<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(table[0])) !== null) {
    const id = m[1];
    const body = m[0];

    const cells = {};
    const cellRe = /<td[^>]*id="[0-9a-f-]{36}_C(\d+)_R\d+"[^>]*>([\s\S]*?)<\/td>/gi;
    let c;
    while ((c = cellRe.exec(body)) !== null) {
      cells[Number(c[1])] = decodeEntities(c[2]);
    }

    const sizeMatch = body.match(/_originalSize">(\d+)</);
    const title = cells[1] || '';
    if (!title) continue;

    let date = cells[4] || '';
    const usDate = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (usDate) {
      const [, m, d, y] = usDate;
      date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    rows.push({
      catalogId: id,
      title,
      products: cells[2] || '',
      classification: cells[3] || '',
      date,
      version: cells[5] || '',
      sizeLabel: cells[6] || '',
      sizeBytes: sizeMatch ? Number(sizeMatch[1]) : 0,
    });
  }

  rows.sort((a, b) => {
    const va = a.version.match(/\d+/g)?.map(Number) ?? [0];
    const vb = b.version.match(/\d+/g)?.map(Number) ?? [0];
    for (let i = 0; i < Math.max(va.length, vb.length); i += 1) {
      const d = (vb[i] ?? 0) - (va[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });

  cache.set(key, { t: Date.now(), rows });
  scheduleSave();
  return rows;
}

function textOf(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function spanById(html, id) {
  const re = new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</span>`, 'i');
  return textOf(re.exec(html)?.[1] || '');
}

/**
 * Read the package detail page. The search index is fuzzy full-text, so a row
 * can match a hardware ID without containing it. `Supported Hardware IDs` is
 * the authoritative list and is what we use before offering a package.
 */
async function getPackageDetails(catalogId) {
  const key = `detail:${catalogId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.detail;

  let html;
  try {
    html = await fetchText(`${BASE}/ScopedViewInline.aspx?updateid=${encodeURIComponent(catalogId)}`, {
      timeout: 30000,
    });
  } catch {
    return null;
  }

  const start = html.indexOf('id="driverhwIDs"');
  const end = html.indexOf('id="ScopedViewHandler_labelSupportedUpdateIDs"');
  const block = start >= 0 ? html.slice(start, end > start ? end : start + 20000) : '';

  const hardwareIds = [];
  for (const m of block.matchAll(/<div[^>]*>([\s\S]*?)<\/div>/gi)) {
    const value = textOf(m[1]).toLowerCase();
    if (value) hardwareIds.push(value);
  }

  const detail = {
    catalogId,
    hardwareIds,
    models: spanById(html, 'ScopedViewHandler_driverModel')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    provider: spanById(html, 'ScopedViewHandler_driverProvider'),
    version: spanById(html, 'ScopedViewHandler_version'),
  };

  cache.set(key, { t: Date.now(), detail });
  scheduleSave();
  return detail;
}

/**
 * True when one of the package's supported hardware IDs identifies this device.
 * Handles ACPI\INTC1082-style IDs and PCI VEN/DEV/SUBSYS IDs.
 */
function hardwareIdMatches(supported, deviceHardwareIds) {
  if (!supported.length) return false;
  const norm = (v) =>
    String(v || '')
      .toUpperCase()
      .replace(/&REV_[0-9A-F]+/g, '')
      .replace(/\s+/g, '')
      .trim();

  const supportedNorm = supported.map(norm);
  const deviceNorm = (deviceHardwareIds || []).map(norm).filter(Boolean);

  for (const dev of deviceNorm) {
    for (const sup of supportedNorm) {
      if (!sup) continue;
      if (dev === sup) return true;
      if (dev.startsWith(`${sup}\\`) || sup.startsWith(`${dev}\\`)) return true;

      const devPair = /(?:VEN|VID)_[0-9A-F]+&(?:DEV|PID)_[0-9A-F]+/.exec(dev)?.[0];
      const supPair = /(?:VEN|VID)_[0-9A-F]+&(?:DEV|PID)_[0-9A-F]+/.exec(sup)?.[0];
      if (devPair && supPair && devPair === supPair) {
        const devSub = /SUBSYS_[0-9A-F]+/.exec(dev)?.[0];
        const supSub = /SUBSYS_[0-9A-F]+/.exec(sup)?.[0];
        if (!supSub || !devSub || devSub === supSub) return true;
      }
    }
  }
  return false;
}

/**
 * Ask the catalog's download dialog for the real CDN URL of an update.
 */
async function resolveDownloadUrl(catalogId) {
  const body = new URLSearchParams({
    updateIDs: JSON.stringify([{ size: 0, updateID: catalogId, uidInfo: catalogId }]),
    updateIDsBlockedForImport: '',
    wsusApiPresent: '',
    contentImport: '',
    sku: '',
    serverName: '',
    ssl: '',
    portNumber: '',
    version: '',
  });

  const html = await fetchText(`${BASE}/DownloadDialog.aspx`, {
    timeout: 45000,
    init: {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    },
  });

  const links = [...html.matchAll(/https:\/\/[^"'<>\\\s]+\.(?:cab|exe|msi|zip)/gi)].map((x) => x[0]);
  if (!links.length) throw new Error('Catalog returned no download links for this package.');

  const cab = links.find((l) => /\.cab$/i.test(l));
  return cab || links[0];
}

module.exports = { searchCatalog, getPackageDetails, hardwareIdMatches, resolveDownloadUrl, BASE };
