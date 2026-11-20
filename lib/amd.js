'use strict';

/**
 * AMD Radeon lookup.
 *
 * Two pages are needed because AMD splits the data:
 *   - the driver download page names the current Adrenalin release and the
 *     installer that ships it;
 *   - the release notes for that release list the Windows Driver Store
 *     versions ("32.0.21045.29003") that the release installs. AMD publishes
 *     one branch per GPU generation in the same release, so a version is only
 *     comparable when it matches the branch the machine already runs.
 *
 * Nothing is invented here: when either page cannot be read, the caller gets
 * no version rather than a guessed one. An unverifiable offer is still useful
 * as a link to AMD's own page, but it must never drive the update state.
 */

const cache = new Map();
const CACHE_MS = 6 * 60 * 60 * 1000;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const DRIVERS_PAGE = 'https://www.amd.com/en/support/download/drivers.html';
const RELEASE_NOTES = (label) =>
  `https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-${label.replace(/\./g, '-')}.html`;

async function fetchText(url, timeoutMs = 12000) {
  const res = await fetch(url, {
    headers: HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`AMD HTTP ${res.status}`);
  return res.text();
}

function isAmdGpu(name) {
  return /amd|radeon|firepro|instinct/i.test(String(name || ''));
}

/** The newest Adrenalin installer linked from AMD's driver page. */
function findRelease(html) {
  const links = [...html.matchAll(/href="([^"]*amd-software-adrenalin-edition-([0-9.]+)[^"]*\.exe)"/gi)];
  if (!links.length) return null;

  const valid = links
    .map((m) => ({ url: m[1].replace(/&amp;/g, '&'), label: m[2] }))
    .filter((x) => /^\d{2}\.\d{1,2}\.\d{1,2}$/.test(x.label));
  if (!valid.length) return null;

  // Prefer a WHQL build, then the highest release number.
  valid.sort((a, b) => {
    const whql = Number(/whql/i.test(b.url)) - Number(/whql/i.test(a.url));
    if (whql) return whql;
    return b.label.localeCompare(a.label, undefined, { numeric: true });
  });

  const chosen = valid[0];
  // .../whql/amd-software-adrenalin-edition-26.11.2-minimalsetup-261118_web.exe
  const stamp = /-(\d{2})(\d{2})(\d{2})_web\.exe$/i.exec(chosen.url);
  const date = stamp ? `20${stamp[1]}-${stamp[2]}-${stamp[3]}` : null;
  return { ...chosen, date, page: DRIVERS_PAGE };
}

/**
 * Driver Store versions published in one release's notes, plus the AMD driver
 * version each branch corresponds to. Example markup:
 *
 *   Driver Version 26.20.29.02 for Windows ... (Windows Driver Store Version 32.0.32029.2010).
 */
function parseBranches(html) {
  const branches = [];
  const re =
    /Driver Version\s+([0-9.]+)\s+for Windows[^()]{0,80}\(Windows Driver Store Version\s+([0-9.]+)\)/gi;
  for (const m of html.matchAll(re)) {
    if (!branches.some((b) => b.version === m[2])) {
      branches.push({ version: m[2], amdVersion: m[1] });
    }
  }

  // A single-store-version note can omit the "for Windows" wording.
  if (!branches.length) {
    for (const m of html.matchAll(/Windows Driver Store Version\s+([0-9.]+)/gi)) {
      if (!branches.some((b) => b.version === m[1])) branches.push({ version: m[1], amdVersion: null });
    }
  }

  const releaseLabel =
    /Adrenalin Edition\s+(\d{2}\.\d{1,2}\.\d{1,2})/i.exec(html)?.[1] || null;
  const date =
    /(?:Release Date|Released)\s*:?\s*([A-Z][a-z]+ \d{1,2}, \d{4})/i.exec(html)?.[1] || null;

  return { branches, releaseLabel, date };
}

function parts(version) {
  return String(version || '')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
}

/**
 * Pick the branch that applies to this machine.
 *
 * AMD ships 32.0.32029.2010 and 32.0.21045.29003 in the same release. The
 * first three components identify the branch (32.0.21045), so that is the
 * reliable match. Without a usable installed version the highest branch is
 * shown, flagged as unconfirmed rather than presented as "the" version.
 */
function chooseBranch(branches, installedVersion) {
  if (!branches.length) return { branch: null, confirmed: false };

  const installed = parts(installedVersion);
  if (installed.length >= 3 && installed.some(Boolean)) {
    const scored = branches
      .map((branch) => {
        const own = parts(branch.version);
        let common = 0;
        while (common < 3 && own[common] === installed[common]) common += 1;
        return { branch, common, own };
      })
      .sort((a, b) => b.common - a.common || parts(b.branch.version)[3] - parts(a.branch.version)[3]);

    if (scored[0].common >= 3) return { branch: scored[0].branch, confirmed: true };
  }

  const highest = [...branches].sort((a, b) =>
    b.version.localeCompare(a.version, undefined, { numeric: true }),
  )[0];
  return { branch: highest, confirmed: false };
}

/**
 * Latest public AMD driver for a Radeon GPU.
 *
 * Returns null when the release cannot be read at all. When the release is
 * known but the installed branch cannot be matched, `version` is null and
 * `unconfirmed` is true, so the UI can link to the release without claiming an
 * update that may not apply.
 */
async function latestDriver(gpuName, installedVersion = null) {
  if (!isAmdGpu(gpuName)) return null;

  const key = `${String(gpuName).toLowerCase()}|${installedVersion || ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_MS) return hit.data;

  let release;
  try {
    release = findRelease(await fetchText(DRIVERS_PAGE));
  } catch {
    return null;
  }
  if (!release) return null;

  let parsed = { branches: [], releaseLabel: release.label, date: null };
  try {
    parsed = parseBranches(await fetchText(RELEASE_NOTES(release.label)));
  } catch {
    /* The installer link is still valid; only the version is unknown. */
  }

  const label = parsed.releaseLabel || release.label;
  const { branch, confirmed } = chooseBranch(parsed.branches, installedVersion);
  const date =
    parsed.date ||
    release.date ||
    (/^\d{4}-\d{2}-\d{2}$/.test(release.date || '') ? release.date : null);

  const data = {
    version: confirmed && branch ? branch.version : null,
    installedBranch: branch ? branch.version : null,
    releaseLabel: `Adrenalin ${label}`,
    date: date && /\d{4}/.test(date) ? new Date(date).toISOString().slice(0, 10) : null,
    title: `AMD Software: Adrenalin Edition ${label}`,
    source: 'amd',
    sourceLabel: 'AMD',
    downloadKind: 'exe',
    downloadUrl: release.url,
    detailsUrl: DRIVERS_PAGE,
    unconfirmed: !confirmed,
    branches: parsed.branches.map((b) => b.version),
    sizeBytes: 0,
  };

  cache.set(key, { fetchedAt: Date.now(), data });
  return data;
}

module.exports = { latestDriver, isAmdGpu, chooseBranch, parseBranches, findRelease };
