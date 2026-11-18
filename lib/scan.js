'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { runPowerShell } = require('./ps');
const { searchCatalog, getPackageDetails, hardwareIdMatches } = require('./catalog');
const nvidia = require('./nvidia');
const { compareVersions, mapLimit } = require('./util');
const bus = require('./bus');

const LAST_SCAN_FILE = path.join(__dirname, '..', 'data', 'last-scan.json');
const CONCURRENCY = 8;
const MAX_QUERIES = 46;
const WU_GRACE_MS = 5000;

const CLASS_WEIGHT = {
  DISPLAY: 60,
  NET: 50,
  MEDIA: 40,
  HDC: 42,
  SCSIADAPTER: 38,
  BLUETOOTH: 38,
  SYSTEM: 30,
  USB: 24,
  CAMERA: 26,
  IMAGE: 26,
  MOUSE: 16,
  KEYBOARD: 16,
  BATTERY: 14,
  FIRMWARE: 18,
  SMARTCARD: 10,
  PRINTER: 8,
};

const SKIP_CLASSES = new Set([
  'SOFTWARECOMPONENT',
  'SOFTWAREDEVICE',
  'VOLUME',
  'VOLUMESNAPSHOT',
  'PRINTQUEUE',
  'COMPUTER',
  'PROCESSOR',
  'AUDIOENDPOINT',
  'AUDIOPROCESSINGOBJECT',
]);

const CLASS_LABEL = {
  DISPLAY: 'Display',
  NET: 'Network',
  MEDIA: 'Audio',
  HDC: 'Storage controller',
  SCSIADAPTER: 'Storage controller',
  USB: 'USB',
  USBDEVICE: 'USB device',
  USB4: 'USB4',
  BLUETOOTH: 'Bluetooth',
  SYSTEM: 'Chipset / System',
  CAMERA: 'Camera',
  IMAGE: 'Imaging',
  MOUSE: 'Mouse',
  KEYBOARD: 'Keyboard',
  BATTERY: 'Power',
  FIRMWARE: 'Firmware',
  SMARTCARD: 'Smart card',
  PRINTER: 'Printer',
  HIDCLASS: 'Human interface',
  SECURITYDEVICES: 'Security device',
  MONITOR: 'Monitor',
  BIOMETRIC: 'Biometric',
  COMPUTEACCELERATOR: 'Compute accelerator',
  DISKDRIVE: 'Disk drive',
  MTD: 'Memory technology',
  DELLINSTRUMENTATION: 'Dell instrumentation',
  NETWORK: 'Network',
};

const NOISE_RE =
  /wan miniport|microsoft basic|hyper-v|virtual (switch|adapter)|remote desktop|ndis virtual|terminalserver|tunnel adapter|6to4|isatap|teredo|vJoy|Xbox (Composite|Controller)/i;

const STOPWORDS = new Set([
  'controller', 'adapter', 'device', 'family', 'series', 'windows', 'microsoft',
  'corporation', 'corp', 'inc', 'ltd', 'driver', 'update', 'system', 'standard',
  'high', 'definition', 'audio', 'interface', 'host', 'root', 'hub', 'port',
  'generic', 'compatible', 'based', 'internal', 'external', 'built', 'with',
  'wireless', 'wired', 'network', 'protocol', 'bus', 'the', 'and', 'for',
]);

function tokens(value) {
  return new Set(
    String(value || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !STOPWORDS.has(t)),
  );
}

function normHwid(id) {
  return String(id || '').toUpperCase().replace(/\\/g, '\\').trim();
}

function stripRev(hwid) {
  return String(hwid || '').replace(/&REV_[0-9A-F]+/gi, '');
}

function firstHwid(device) {
  const list = Array.isArray(device.hardwareId) ? device.hardwareId : [];
  return list.find((h) => /^(PCI|USB|HDAUDIO|ACPI|SCSI|IDE|STORAGE|BTHENUM|USBSTOR)\\/i.test(h)) || null;
}

function isEligible(device) {
  if (!device.id) return false;
  if (SKIP_CLASSES.has(device.className)) return false;
  if (/^(ROOT|SWD|SW\\|HTREE|STORAGE\\VOLUME|DISPLAY\\DEFAULT)/i.test(device.id)) return false;
  if (NOISE_RE.test(device.name)) return false;
  const hw = firstHwid(device);
  return Boolean(hw);
}

function candidateScore(device) {
  let score = CLASS_WEIGHT[device.className] ?? 4;
  if (device.problem) score += 60;
  if (device.provider && !/microsoft/i.test(device.provider)) score += 22;
  if (!device.version) score += 18;
  if (device.date) {
    const years = (Date.now() - new Date(device.date).getTime()) / 31557600000;
    if (years > 2) score += Math.min(14, Math.floor(years) * 2);
  }
  return score;
}

function nameQuery(device) {
  const cleaned = String(device.name)
    .replace(/\(R\)|\(TM\)/gi, '')
    .replace(/\b(PCIe?|Wired|Wireless|Adapter|Controller|Device|Family|Series)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.split(' ').slice(0, 5).join(' ') || device.name;
}

function looksLikeWindowsDriver(row, device) {
  if (!row.version || !/\d/.test(row.version)) return false;
  if (!/driver/i.test(row.classification) && !/driver/i.test(row.title)) return false;
  if (!/windows\s*(10|11)/i.test(row.products)) return false;
  if (/firmware|bios/i.test(row.title) && device.className !== 'FIRMWARE') return false;
  if (/^system firmware/i.test(row.title)) return false;
  return true;
}

function winScore(text) {
  if (/25H2/i.test(text)) return 4;
  if (/24H2/i.test(text)) return 3;
  if (/23H2/i.test(text)) return 2;
  if (/windows\s*11/i.test(text)) return 1;
  return 0;
}

function rankRows(rows, device, kind) {
  const devTokens = tokens(device.name);
  const provTokens = tokens(device.provider);

  const eligible = rows.filter((row) => {
    if (!looksLikeWindowsDriver(row, device)) return false;
    if (kind === 'name') {
      const rowTokens = tokens(row.title);
      const sharesDevice = [...devTokens].some((t) => rowTokens.has(t));
      const sharesProvider = provTokens.size > 0 && [...provTokens].some((t) => rowTokens.has(t));
      if (!sharesDevice && !sharesProvider) return false;
    }
    return true;
  });

  eligible.sort((a, b) => {
    const v = compareVersions(b.version, a.version);
    if (v !== 0) return v;
    const w = winScore(b.products) - winScore(a.products);
    if (w !== 0) return w;
    return String(b.date).localeCompare(String(a.date));
  });

  return eligible;
}

const MAX_VERIFY = 4;

async function lookupDevice(device, stats) {
  const specific = stripRev(firstHwid(device));
  const generic = /VEN_[0-9A-F]+&DEV_[0-9A-F]+/i.exec(specific)?.[0] ?? null;

  const attempts = [];
  if (specific) attempts.push({ kind: 'hwid', query: specific });
  if (generic && generic !== specific) attempts.push({ kind: 'hwid', query: generic });
  attempts.push({ kind: 'name', query: nameQuery(device) });

  for (const attempt of attempts) {
    let rows = [];
    try {
      rows = await searchCatalog(attempt.query);
    } catch {
      rows = [];
    }
    if (!rows.length) continue;

    const ranked = rankRows(rows, device, attempt.kind);
    if (!ranked.length) continue;

    const installed = device.version || null;
    const newer = installed ? ranked.filter((r) => compareVersions(r.version, installed) > 0) : ranked;

    // Nothing newer than what is installed: no package has to be vetted.
    if (!newer.length) {
      return { ...ranked[0], queryKind: attempt.kind, query: attempt.query, verified: null };
    }

    let rejected = 0;
    for (const candidate of newer.slice(0, MAX_VERIFY)) {
      const detail = await getPackageDetails(candidate.catalogId);
      if (!detail) {
        // Detail page unavailable: keep the candidate and rely on the INF check at install.
        return { ...candidate, queryKind: attempt.kind, query: attempt.query, verified: null };
      }
      if (!detail.hardwareIds.length) {
        return {
          ...candidate,
          queryKind: attempt.kind,
          query: attempt.query,
          verified: null,
          models: detail.models,
        };
      }
      if (hardwareIdMatches(detail.hardwareIds, device.hardwareId)) {
        return {
          ...candidate,
          queryKind: attempt.kind,
          query: attempt.query,
          verified: true,
          models: detail.models,
          supportedHardwareIds: detail.hardwareIds,
        };
      }
      rejected += 1;
    }

    if (rejected && stats) stats.rejected += 1;
    // Every newer package on this query belongs to other hardware; try the next query.
  }
  return null;
}

function pickCandidates(devices) {
  const seen = new Set();
  return devices
    .filter(isEligible)
    .map((d) => ({ device: d, score: candidateScore(d) }))
    .sort((a, b) => b.score - a.score)
    .filter(({ device }) => {
      const key = stripRev(firstHwid(device) || device.id).toUpperCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_QUERIES)
    .map((x) => x.device);
}

function hwidIndex(device) {
  const list = Array.isArray(device.hardwareId) ? device.hardwareId : [];
  return list.map((h) => normHwid(stripRev(h)));
}

function matchWuOffer(offer, devices) {
  const hwids = (offer.hardwareId || []).map((h) => normHwid(stripRev(h)));
  if (hwids.length) {
    for (const d of devices) {
      const own = hwidIndex(d);
      if (own.some((h) => hwids.includes(h))) return d;
    }
  }
  const offerTokens = tokens(offer.title);
  let best = null;
  let bestScore = 0;
  for (const d of devices) {
    let score = 0;
    for (const t of tokens(d.name)) if (offerTokens.has(t)) score += 2;
    for (const t of tokens(d.provider)) if (offerTokens.has(t)) score += 1;
    if (offer.driverClass && CLASS_LABEL[d.className]?.toLowerCase().includes(offer.driverClass.toLowerCase())) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return bestScore >= 2 ? best : null;
}

const state = {
  phase: 'idle',
  stage: null,
  stageLabel: 'Ready',
  progress: 0,
  startedAt: null,
  finishedAt: null,
  system: {},
  rows: [],
  stats: { devices: 0, updates: 0, problems: 0, current: 0, missing: 0 },
  notes: [],
  scannedAt: null,
  error: null,
  sourceCounts: {},
  cached: false,
};

let activeScan = null;
let scanSeq = 0;

function computeStats(rows, instanceCount) {
  const stats = {
    devices: rows.length,
    instances: instanceCount || rows.length,
    updates: 0,
    problems: 0,
    current: 0,
    missing: 0,
  };
  const sourceCounts = {};
  for (const row of rows) {
    if (row.state === 'update') stats.updates += 1;
    if (row.state === 'problem' || row.problem) stats.problems += 1;
    if (row.state === 'current' || row.state === 'newer') stats.current += 1;
    if (row.state === 'missing') stats.missing += 1;
    if (row.latest?.source) sourceCounts[row.latest.source] = (sourceCounts[row.latest.source] || 0) + 1;
  }
  return { stats, sourceCounts };
}

function loadLastScan() {
  try {
    const saved = JSON.parse(fs.readFileSync(LAST_SCAN_FILE, 'utf8'));
    if (!saved || !Array.isArray(saved.rows) || !saved.rows.length || !saved.scannedAt) return;
    state.rows = saved.rows;
    state.stats = saved.stats || state.stats;
    state.system = saved.system || {};
    state.sourceCounts = saved.sourceCounts || {};
    state.scannedAt = saved.scannedAt;
    state.phase = 'ready';
    state.progress = 100;
    state.stage = 'cached';
    state.stageLabel = `${state.stats.devices} devices scanned`;
    state.cached = true;
    state.notes = [
      {
        level: 'info',
        text: `Showing the last saved scan. Press SCAN to refresh.`,
      },
    ];
  } catch {
    /* first run */
  }
}

function saveLastScan() {
  const payload = {
    system: state.system,
    rows: state.rows,
    stats: state.stats,
    sourceCounts: state.sourceCounts,
    scannedAt: state.scannedAt,
  };
  fsp
    .mkdir(path.dirname(LAST_SCAN_FILE), { recursive: true })
    .then(() => fsp.writeFile(LAST_SCAN_FILE, JSON.stringify(payload)))
    .catch(() => {});
}

loadLastScan();

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

function snapshot() {
  return {
    phase: state.phase,
    stage: state.stage,
    stageLabel: state.stageLabel,
    progress: state.progress,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    system: state.system,
    rows: state.rows,
    stats: state.stats,
    notes: state.notes,
    scannedAt: state.scannedAt,
    error: state.error,
    sourceCounts: state.sourceCounts,
    cached: state.cached,
  };
}

function setStage(stage, label, progress) {
  state.stage = stage;
  state.stageLabel = label;
  if (typeof progress === 'number') state.progress = Math.max(state.progress, Math.min(100, progress));
  bus.emit('scan', {
    phase: state.phase,
    stage,
    stageLabel: state.stageLabel,
    progress: state.progress,
    stats: state.stats,
  });
}

function classLabel(name) {
  return CLASS_LABEL[name] || (name ? name.charAt(0) + name.slice(1).toLowerCase() : 'Device');
}

function buildRows(devices, catalogMap, wuOffers, nvOffer) {
  const rows = [];
  const wuByDevice = new Map();

  for (const offer of wuOffers) {
    const device = matchWuOffer(offer, devices);
    if (!device) continue;
    const list = wuByDevice.get(device.id) || [];
    list.push(offer);
    wuByDevice.set(device.id, list);
  }

  devices.forEach((device, index) => {
    if (SKIP_CLASSES.has(device.className)) return;
    if (!device.name || !device.className) return;
    if (/^(ROOT|SWD)\\(HTREE|VMS_)/i.test(device.id)) return;

    const catalog = catalogMap.get(device.id) || null;
    const wu = wuByDevice.get(device.id) || [];
    const isNvidia =
      device.className === 'DISPLAY' && /nvidia/i.test(device.name) && /nvidia/i.test(device.provider || '');

    const installed = {
      version: device.version || null,
      date: device.date || null,
      provider: device.provider || null,
      inf: device.inf || null,
    };

    let latest = null;
    let stateName = 'unknown';
    let reason = null;
    const extraOffers = [];

    if (isNvidia && nvOffer) {
      const diff = nvOffer.tail - nvidia.installedTail(device.version);
      latest = {
        version: nvOffer.version,
        versionNote: device.version ? `Windows build ${device.version}` : null,
        date: nvOffer.date,
        title: nvOffer.title,
        source: 'nvidia',
        sourceLabel: 'NVIDIA',
        sizeBytes: nvOffer.sizeBytes,
        downloadUrl: nvOffer.downloadUrl,
        downloadKind: 'exe',
        detailsUrl: nvOffer.detailsUrl,
      };
      if (!device.version) stateName = 'missing';
      else if (diff > 0) stateName = 'update';
      else if (diff === 0) stateName = 'current';
      else {
        stateName = 'newer';
        reason = 'Installed OEM build is newer than NVIDIA’s public release.';
      }
      if (catalog && compareVersions(catalog.version, device.version) > 0) {
        extraOffers.push({
          version: catalog.version,
          date: catalog.date,
          title: catalog.title,
          source: 'catalog',
          catalogId: catalog.catalogId,
          sizeBytes: catalog.sizeBytes,
          verified: catalog.verified ?? null,
        });
      }
    } else {
      const offers = [];
      for (const offer of wu) {
        if (!offer.version) continue;
        offers.push({
          version: offer.version,
          date: offer.date,
          title: offer.title,
          source: 'wu',
          sourceLabel: 'Windows Update',
          sizeBytes: offer.sizeBytes,
          updateId: offer.updateId,
          downloadKind: 'wu',
        });
      }
      if (catalog) {
        offers.push({
          version: catalog.version,
          date: catalog.date,
          title: catalog.title,
          source: 'catalog',
          sourceLabel: 'Update Catalog',
          sizeBytes: catalog.sizeBytes,
          catalogId: catalog.catalogId,
          downloadKind: 'cab',
          verified: catalog.verified ?? null,
          models: catalog.models || null,
        });
      }

      offers.sort((a, b) => compareVersions(b.version, a.version));
      if (offers.length) {
        latest = offers[0];
        if (!device.version) stateName = 'missing';
        else {
          const diff = compareVersions(latest.version, device.version);
          if (diff > 0) stateName = 'update';
          else if (diff === 0) stateName = 'current';
          else {
            stateName = 'newer';
            reason = 'Installed driver is newer than the newest package in the catalog.';
          }
        }
        for (const offer of offers.slice(1)) extraOffers.push(offer);
      } else if (!device.version) {
        stateName = 'missing';
      } else {
        stateName = 'current';
      }
    }

    if (device.problem && stateName !== 'update') stateName = 'problem';
    if (device.problem && !latest && !device.version) stateName = 'missing';

    rows.push({
      id: `d${index + 1}`,
      instanceId: device.id,
      name: device.name,
      className: device.className,
      classLabel: classLabel(device.className),
      status: device.status,
      problem: device.problem || 0,
      installed,
      latest,
      extraOffers,
      state: stateName,
      reason,
      hardwareId: firstHwid(device),
      busy: false,
      jobState: null,
    });
  });

  // Identical hardware (24 CPU cores, 10 volumes, 7 motherboard resources...)
  // is one row in the UI, with an instance count.
  const grouped = new Map();
  const STATE_ORDER = { update: 0, missing: 1, problem: 2, newer: 3, current: 4, unknown: 5 };
  for (const row of rows) {
    const key = `${(row.hardwareId || row.instanceId).toUpperCase()}|${row.name}`;
    const hit = grouped.get(key);
    if (hit) {
      hit.instances += 1;
      hit.instanceIds.push(row.instanceId);
      if (row.problem && !hit.problem) hit.problem = row.problem;
      if ((STATE_ORDER[row.state] ?? 9) < (STATE_ORDER[hit.state] ?? 9)) {
        hit.state = row.state;
        hit.reason = row.reason;
      }
      continue;
    }
    row.instances = 1;
    row.instanceIds = [row.instanceId];
    grouped.set(key, row);
  }

  const merged = [...grouped.values()];
  merged.sort((a, b) => {
    const rank = { update: 0, missing: 1, problem: 2, newer: 3, current: 4, unknown: 5 };
    const d = (rank[a.state] ?? 9) - (rank[b.state] ?? 9);
    if (d !== 0) return d;
    return String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' });
  });

  return merged;
}

async function scan() {
  if (activeScan) return { started: false, reason: 'already-running' };

  scanSeq += 1;
  state.phase = 'scanning';
  state.progress = 0;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.error = null;
  state.notes = [];
  state.cached = false;

  activeScan = (async () => {
    try {
      setStage('enumerate', 'Reading the live device tree', 4);
      const inventory = await runPowerShell('inventory.ps1', [], { timeout: 120000 });
      if (!inventory.ok) throw new Error(inventory.error || 'Could not enumerate devices.');

      const devices = inventory.devices || [];
      // PowerShell reports class names in TitleCase ("Processor"); the rest of
      // the engine compares them in upper case.
      for (const device of devices) {
        device.className = String(device.className || '').toUpperCase();
      }
      state.system = {
        computer: inventory.computer,
        os: inventory.os,
        osVersion: inventory.osVersion,
        build: inventory.build,
        manufacturer: inventory.manufacturer,
        model: inventory.model,
      };
      state.stats.devices = devices.length;
      setStage('enumerate', `${devices.length} devices found`, 10);

      const wuPromise = runPowerShell('wu-drivers.ps1', [], { timeout: 180000 })
        .then((res) => {
          if (!res.ok) {
            state.notes.push({ level: 'warn', text: `Windows Update check failed: ${res.error}` });
            return [];
          }
          return res.updates || [];
        })
        .catch(() => []);

      const nvDevice = devices.find(
        (d) => d.className === 'DISPLAY' && /nvidia/i.test(d.name) && /nvidia/i.test(d.provider || ''),
      );
      const nvPromise = nvDevice
        ? nvidia.latestDriver(nvDevice.name).catch(() => null)
        : Promise.resolve(null);

      const candidates = pickCandidates(devices);
      setStage('catalog', `Matching ${candidates.length} devices against the catalog`, 14);

      const catalogMap = new Map();
      const lookupStats = { rejected: 0 };
      let done = 0;
      await mapLimit(candidates, CONCURRENCY, async (device) => {
        const best = await lookupDevice(device, lookupStats);
        if (best) catalogMap.set(device.id, best);
        done += 1;
        if (done % 2 === 0 || done === candidates.length) {
          const pct = 14 + Math.round((done / Math.max(1, candidates.length)) * 66);
          setStage('catalog', `Catalog ${done}/${candidates.length} · ${catalogMap.size} matches`, pct);
        }
        return null;
      });

      setStage('waiting', 'Collecting Windows Update results', 84);
      const nvOffer = await nvPromise;

      // Windows Update can take 20+ seconds and often returns nothing. Give it a
      // short grace period, publish the catalog result, then merge any late offer.
      const settled = await Promise.race([
        wuPromise.then((offers) => ({ offers })),
        sleep(WU_GRACE_MS).then(() => ({ timeout: true })),
      ]);

      let wuOffers = settled.offers || [];
      const wuLate = Boolean(settled.timeout);

      if (wuLate) {
        state.notes.push({
          level: 'info',
          text: 'Windows Update is still checking — any offers will merge in automatically.',
        });
      } else if (!wuOffers.length) {
        state.notes.push({
          level: 'ok',
          text: 'Windows Update is not offering any driver updates for this machine.',
        });
      }
      if (nvDevice && nvOffer) {
        state.notes.push({
          level: 'info',
          text: `NVIDIA: latest public WHQL release is ${nvOffer.version} (${nvOffer.date}).`,
        });
      }
      if (lookupStats.rejected) {
        state.notes.push({
          level: 'info',
          text: `${lookupStats.rejected} device${lookupStats.rejected === 1 ? '' : 's'} skipped a catalog package that does not list the hardware ID.`,
        });
      }

      setStage('merge', 'Comparing versions', 92);
      const rows = buildRows(devices, catalogMap, wuOffers, nvOffer);
      const { stats, sourceCounts } = computeStats(rows, devices.length);

      state.rows = rows;
      state.stats = stats;
      state.sourceCounts = sourceCounts;
      state.scannedAt = new Date().toISOString();
      state.finishedAt = state.scannedAt;
      state.phase = 'ready';
      state.progress = 100;
      state.stage = 'done';
      state.stageLabel = `${stats.devices} devices scanned`;
      state.cached = false;
      saveLastScan();

      bus.emit('scan', snapshot());

      if (wuLate) {
        const token = scanSeq;
        wuPromise
          .then((offers) => {
            if (token !== scanSeq || state.phase !== 'ready') return;
            state.notes = state.notes.filter((n) => !/still checking/i.test(n.text));
            if (!offers || !offers.length) {
              state.notes.push({
                level: 'ok',
                text: 'Windows Update is not offering any driver updates for this machine.',
              });
              bus.emit('scan', snapshot());
              return;
            }
            const merged = buildRows(devices, catalogMap, offers, nvOffer);
            const next = computeStats(merged, devices.length);
            state.rows = merged;
            state.stats = next.stats;
            state.sourceCounts = next.sourceCounts;
            state.notes.push({
              level: 'info',
              text: `Windows Update added ${offers.length} offer${offers.length === 1 ? '' : 's'}.`,
            });
            saveLastScan();
            bus.emit('scan', snapshot());
          })
          .catch(() => {});
      }

      return { started: true };
    } catch (err) {
      state.phase = 'error';
      state.error = err.message || String(err);
      state.stageLabel = 'Scan failed';
      bus.emit('scan', snapshot());
      return { started: false, error: state.error };
    } finally {
      activeScan = null;
    }
  })();

  return { started: true };
}

module.exports = {
  scan,
  snapshot,
  state,
  classLabel,
  CLASS_LABEL,
  isScanning: () => Boolean(activeScan),
};
