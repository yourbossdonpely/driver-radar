'use strict';

const cache = new Map();

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const INTEL_FEEDS = {
  wifi: {
    page: 'https://www.intel.com/content/www/us/en/download/19351/windows-10-and-windows-11-wi-fi-drivers-for-intel-wireless-adapters.html',
    title: 'Intel Wireless Wi-Fi Driver',
    fileRegex: /https:\/\/downloadmirror\.intel\.com\/[^"']+\/WiFi-([0-9.]+)-Driver64[^"']*\.exe/i,
  },
  bluetooth: {
    page: 'https://www.intel.com/content/www/us/en/download/18649/intel-wireless-bluetooth-drivers-for-windows-10-and-windows-11.html',
    title: 'Intel Wireless Bluetooth Driver',
    fileRegex: /https:\/\/downloadmirror\.intel\.com\/[^"']+\/BT-([0-9.]+)-[^"']*\.exe/i,
  },
  graphics: {
    page: 'https://www.intel.com/content/www/us/en/download/785597/intel-arc-iris-xe-graphics-windows.html',
    title: 'Intel Arc & Iris Xe Graphics Driver',
    fileRegex: /https:\/\/downloadmirror\.intel\.com\/[^"']+\/gfx_win_([0-9.]+)\.exe/i,
  },
};

async function fetchPage(url, timeoutMs = 8000) {
  const res = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Intel HTTP ${res.status}`);
  return res.text();
}

/**
 * Fetch the latest package for a given category (wifi, bluetooth, graphics)
 */
async function getLatestPackage(category) {
  const config = INTEL_FEEDS[category];
  if (!config) return null;

  if (cache.has(category)) {
    const cached = cache.get(category);
    if (Date.now() - cached.fetchedAt < 3600000) {
      return cached.data;
    }
  }

  try {
    const html = await fetchPage(config.page);
    const match = config.fileRegex.exec(html);
    if (!match) return null;

    const downloadUrl = match[0];
    const rawVersion = match[1];

    let version = rawVersion;
    if (category === 'graphics' && rawVersion.startsWith('101.')) {
      // Windows Intel graphics versions are formatted as 32.0.101.xxxx or 31.0.101.xxxx
      version = `32.0.${rawVersion}`;
    }

    const data = {
      version,
      rawVersion,
      downloadUrl,
      detailsUrl: config.page,
      title: config.title,
      source: 'intel',
      sourceLabel: 'Intel',
      downloadKind: 'exe',
      date: new Date().toISOString().slice(0, 10),
    };

    cache.set(category, { fetchedAt: Date.now(), data });
    return data;
  } catch (err) {
    return null;
  }
}

/**
 * Checks whether an inventory device qualifies for an Intel direct driver update
 */
function classifyIntelDevice(device) {
  const name = String(device.name || '');
  const provider = String(device.provider || '');
  const className = String(device.className || '').toUpperCase();

  const isIntel = /intel|killer/i.test(name) || /intel/i.test(provider);
  if (!isIntel) return null;

  if (className === 'NET' && /wi-fi|wireless|killer/i.test(name)) {
    return 'wifi';
  }

  if (className === 'BLUETOOTH' && /bluetooth/i.test(name)) {
    return 'bluetooth';
  }

  if (className === 'DISPLAY' && /arc|iris|uhd|hd graphics/i.test(name)) {
    return 'graphics';
  }

  return null;
}

/**
 * Direct lookup for Intel devices: returns latest package info if applicable
 */
async function latestDriver(device) {
  const category = classifyIntelDevice(device);
  if (!category) return null;
  return getLatestPackage(category);
}

module.exports = {
  latestDriver,
  classifyIntelDevice,
  getLatestPackage,
};
