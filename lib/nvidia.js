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

async function findProduct(gpuName) {
  const wanted = normaliseGpuName(gpuName);
  if (!/nvidia|geforce|quadro|rtx/i.test(wanted)) return null;

  const families = [];
  const rtx = wanted.match(/RTX\s*(\d{2})\s*(\d{2})/i);
  if (rtx) families.push(`RTX ${rtx[1]}`);
  if (/laptop|notebook|mobile/i.test(wanted)) families.push('Notebooks');

  const series = await lookup(2);
  const candidates = series
    .filter((s) => /geforce/i.test(s.name))
    .filter((s) => {
      if (!families.length) return /rtx|gtx/i.test(s.name);
      return families.some((f) => new RegExp(f, 'i').test(s.name));
    })
    .sort((a, b) => {
      const an = /notebook/i.test(a.name) ? 1 : 0;
      const bn = /notebook/i.test(b.name) ? 1 : 0;
      const wantNotebook = /laptop|notebook/i.test(wanted) ? 1 : 0;
      return Math.abs(an - wantNotebook) - Math.abs(bn - wantNotebook);
    })
    .slice(0, 6);

  for (const s of candidates) {
    let products = [];
    try {
      products = await lookup(3, s.value);
    } catch {
      continue;
    }
    const exact = products.find((p) => normaliseGpuName(p.name).toLowerCase() === wanted.toLowerCase());
    if (exact) return { product: exact, series: s };

    const loose = products.find((p) => {
      const a = normaliseGpuName(p.name).toLowerCase();
      const b = wanted.toLowerCase();
      return a.includes(b) || b.includes(a);
    });
    if (loose) return { product: loose, series: s };
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
    psid: '1', // GeForce
    pfid: String(found.product.value),
    osID: '135', // Windows 11
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
    tail: tail4(best.Version),
  };
}

module.exports = { latestDriver, tail4, installedTail, findProduct };
