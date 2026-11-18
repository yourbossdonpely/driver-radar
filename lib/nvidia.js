'use strict';

const os = require('node:os');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  Referer: 'https://www.nvidia.com/en-us/drivers/',
};

const API = 'https://www.nvidia.com/Download/API/lookupValueSearch.aspx';
const LOOKUP = 'https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php';

/**
 * NVIDIA numbers its OS lookup entries: 57 = Windows 10 64-bit, 135 = Windows 11.
 * Detecting the build keeps the lookup correct on every supported machine.
 */
function osId() {
  const build = Number(String(os.release() || '').split('.')[2]) || 0;
  return build >= 22000 ? 135 : 57;
}

const cache = new Map();

async function getJson(url, timeout = 20000) {
  const res = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`NVIDIA HTTP ${res.status}`);
  return res.json();
}

async function getXml(url, timeout = 20000) {
  const res = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`NVIDIA HTTP ${res.status}`);
  return res.text();
}

function parseLookup(xml) {
  const out = [];
  const re = /<LookupValue[^>]*ParentID="(\d+)"[^>]*>\s*<Name>([\s\S]*?)<\/Name>\s*<Value>(\d+)<\/Value>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push({
      parent: Number(m[1]),
      name: m[2].replace(/&amp;/g, '&').trim(),
      value: Number(m[3]),
    });
  }
  return out;
}

async function lookup(typeId, parentId) {
  const key = `${typeId}:${parentId ?? ''}`;
  if (cache.has(key)) return cache.get(key);
  const url = parentId ? `${API}?TypeID=${typeId}&ParentID=${parentId}` : `${API}?TypeID=${typeId}`;
  const values = parseLookup(await getXml(url));
  cache.set(key, values);
  return values;
}

/**
 * NVIDIA marketing versions map to the Windows driver version's last block:
 * 621.24 -> 32.0.16.2124 (last four digits 2124). We use that to compare an
 * installed OEM build against the vendor's newest release.
 */
function tail4(version) {
  const digits = String(version || '').replace(/\./g, '');
  const tail = digits.slice(-4);
  return Number.parseInt(tail, 10) || 0;
}

function installedTail(windowsVersion) {
  const parts = String(windowsVersion || '').split('.');
  const last = Number.parseInt(parts[parts.length - 1], 10);
  return Number.isFinite(last) ? last : 0;
}

function normaliseGpuName(name) {
  return String(name || '')
    .replace(/\(R\)|\(TM\)|\(r\)|\(tm\)|®|™/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Comparison key: case-insensitive, vendor prefix dropped (Windows adds "NVIDIA "). */
function key(name) {
  return normaliseGpuName(name).replace(/^nvidia\s+/i, '').toLowerCase();
}

/**
 * Laptop parts are named "… Laptop GPU", "… Notebook GPU" or "… with Max-Q
 * Design". Max-Q was the miss before: it is a laptop-only suffix, so a device
 * carrying it must be looked up in the notebook tree, not the desktop one.
 */
function isNotebook(name) {
  return /notebook|laptop|mobile|max[-\s]?q/i.test(String(name || ''));
}

function modelMatch(name) {
  return /\b(RTX|GTX|MX)\s*(\d{3,4})\b/i.exec(String(name || ''));
}

function generationOf(name) {
  const match = modelMatch(name);
  if (!match) return null;
  // The MX series is not split by generation.
  if (/^mx$/i.test(match[1])) return null;
  return match[2].slice(0, 2);
}

function seriesScore(name, wanted) {
  const seriesNotebook = /notebook/i.test(name);
  const deviceNotebook = isNotebook(wanted);

  // A part that says Laptop/Notebook/Mobile/Max-Q must never come back with a
  // desktop package: installing one on such a machine either fails or leaves
  // the GPU unaccelerated. Returning 0 drops the series from the candidate
  // list, so findProduct() answers null when no notebook product matches and
  // scan.js lets the catalog decide.
  if (deviceNotebook && !seriesNotebook) return 0;

  // For parts with no laptop marker the notebook series stays eligible as a
  // fallback: laptop-only parts such as the GTX 16 series are named without
  // any "Laptop" suffix on real machines. Kind outweighs the generation bonus
  // so that fallback is only reached when the same kind has no match: desktop
  // series are not always named after the model prefix (the desktop GTX 16
  // parts live in "GeForce 16 Series"), which used to tie with the notebook
  // series and let the notebook package win a desktop part.
  let score = seriesNotebook === deviceNotebook ? 10 : 1;

  const generation = generationOf(wanted);
  if (generation && new RegExp(`\\b(?:RTX|GTX)\\s*${generation}\\b`, 'i').test(name)) score += 2;
  return score;
}

/** Tier suffix that NVIDIA adds after the model number: 1650 Ti, 1660 Super. */
function tierOf(name) {
  const match = /(?:^|\s)(ti|super)(?=\s|$)/i.exec(key(name));
  return match ? match[1].toLowerCase() : null;
}

function productScore(name, wanted) {
  const product = key(name);
  const device = key(wanted);
  if (!product || !device) return 0;

  // The model number has to appear, so "RTX 5070" never answers for a 5070 Ti
  // (or a 5080) when the exact part is missing.
  const model = modelMatch(wanted)?.[2];
  if (model && !new RegExp(`\\b${model}\\b`).test(product)) return 0;

  // Tiers are part of the part: "GTX 1650" is not a "GTX 1650 Ti", and the
  // desktop 16 series has no Ti, so the prefix rule below must not claim it.
  if (tierOf(name) !== tierOf(wanted)) return 0;

  if (product === device) return 4;
  if (device.startsWith(`${product} `) || product.startsWith(`${device} `)) return 3;
  if (device.includes(product) || product.includes(device)) return 2;
  return 0;
}

async function findProduct(gpuName) {
  const wanted = normaliseGpuName(gpuName);
  if (!/nvidia|geforce|quadro|rtx/i.test(wanted)) return null;

  const candidates = (await lookup(2))
    .filter((s) => /geforce/i.test(s.name))
    .map((s) => ({ series: s, score: seriesScore(s.name, wanted) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  for (const { series: s } of candidates) {
    let products = [];
    try {
      products = await lookup(3, s.value);
    } catch {
      continue;
    }

    let best = null;
    for (const product of products) {
      const score = productScore(product.name, wanted);
      if (score <= 0) continue;
      if (!best || score > best.score) best = { product, score };
    }
    if (best) return { product: best.product, series: s, notebook: /notebook/i.test(s.name) };
  }

  return null;
}

/**
 * Latest WHQL desktop/notebook driver published for this GPU.
 */
async function latestDriver(gpuName) {
  const found = await findProduct(gpuName);
  if (!found) return null;

  const params = new URLSearchParams({
    func: 'DriverManualLookup',
    // There is no separate notebook psid: LookupValueSearch lists notebook
    // parts as an "… (Notebooks)" series under GeForce, and DriverManualLookup
    // selects the package by pfid. Probing psid 1/2/3/13 with a laptop pfid
    // returns identical results, so findProduct() picking the notebook pfid is
    // what actually decides the tree.
    psid: '1',
    pfid: String(found.product.value),
    osID: String(osId()),
    languageCode: '1033',
    isWHQL: '1',
    dch: '1',
    sort1: '0',
    numberOfResults: '6',
  });

  const data = await getJson(`${LOOKUP}?${params.toString()}`);
  const ids = Array.isArray(data?.IDS) ? data.IDS : [];
  const drivers = ids
    .map((x) => x.downloadInfo)
    .filter(Boolean)
    .filter((d) => String(d.IsWHQL) === '1' && String(d.IsActive) !== '0' && d.DownloadURL);

  if (!drivers.length) return null;

  drivers.sort((a, b) => {
    const va = String(a.Version).split('.').map(Number);
    const vb = String(b.Version).split('.').map(Number);
    for (let i = 0; i < Math.max(va.length, vb.length); i += 1) {
      const d = (vb[i] ?? 0) - (va[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });

  const best = drivers[0];
  return {
    version: String(best.Version),
    date: best.ReleaseDateTime ? new Date(best.ReleaseDateTime).toISOString().slice(0, 10) : null,
    downloadUrl: best.DownloadURL,
    detailsUrl: best.DetailsURL || null,
    title: decodeURIComponent(String(best.Name || 'NVIDIA driver')),
    sizeBytes: Number(best.DownloadURLFileSize) || 0,
    gpu: found.product.name,
    series: found.series.name,
    notebook: Boolean(found.notebook),
    // Notebook builds use the same Windows-style numbering (32.0.16.2124), so
    // scan.js keeps comparing `tail` against the installed build unchanged.
    tail: tail4(best.Version),
  };
}

module.exports = { latestDriver, tail4, installedTail, findProduct, isNotebook };
