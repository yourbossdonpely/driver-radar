'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HEADERS = { 'User-Agent': UA, Accept: '*/*' };

async function fileSize(p) {
  try {
    const st = await fsp.stat(p);
    return st.size;
  } catch {
    return 0;
  }
}

async function probe(url, signal) {
  let total = 0;
  let ranges = false;

  try {
    const head = await fetch(url, { method: 'HEAD', headers: HEADERS, signal });
    total = Number(head.headers.get('content-length')) || 0;
    ranges = /bytes/i.test(head.headers.get('accept-ranges') || '');
  } catch {
    /* fall through to a range GET */
  }

  if (!total) {
    const res = await fetch(url, { headers: { ...HEADERS, Range: 'bytes=0-0' }, signal });
    const cr = res.headers.get('content-range');
    if (cr) {
      total = Number(cr.split('/')[1]) || 0;
      ranges = true;
    } else {
      total = Number(res.headers.get('content-length')) || 0;
    }
    res.body?.cancel?.().catch(() => {});
  }

  return { total, ranges };
}

/**
 * Parallel range download with per-part resume, retries and live progress.
 * Writes `destPath` (and transient `.pN` shards next to it).
 */
async function downloadMultipart(url, destPath, options = {}) {
  const { parts = 8, onProgress = () => {}, signal, expectedSize = 0 } = options;

  await fsp.mkdir(path.dirname(destPath), { recursive: true });

  const { total, ranges } = await probe(url, signal);
  const size = total || expectedSize;
  if (!size) throw new Error('Could not determine the download size.');

  const started = Date.now();
  let downloaded = 0;
  let speed = 0;
  let lastTick = Date.now();
  let lastBytes = 0;
  let lastEmit = 0;

  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 200) return;
    lastEmit = now;
    const elapsed = (now - started) / 1000;
    onProgress({
      downloaded,
      total: size,
      speed,
      percent: Math.min(100, Math.round((downloaded / size) * 1000) / 10),
      elapsed,
    });
  };

  const track = (n) => {
    downloaded += n;
    const now = Date.now();
    const dt = (now - lastTick) / 1000;
    if (dt >= 0.35) {
      const inst = (downloaded - lastBytes) / dt;
      speed = speed ? speed * 0.65 + inst * 0.35 : inst;
      lastTick = now;
      lastBytes = downloaded;
    }
    emit();
  };

  if (!ranges || size < 1024 * 1024) {
    // Single stream fallback.
    const res = await fetch(url, { headers: HEADERS, signal });
    if (!res.ok) throw new Error(`Download failed with HTTP ${res.status}`);
    const fh = await fsp.open(destPath, 'w');
    try {
      for await (const chunk of res.body) {
        await fh.write(chunk);
        track(chunk.length);
      }
    } finally {
      await fh.close();
    }
    emit(true);
    const got = await fileSize(destPath);
    if (got !== size) throw new Error(`Size mismatch: expected ${size} bytes, got ${got}.`);
    return { path: destPath, bytes: got, seconds: (Date.now() - started) / 1000, parts: 1 };
  }

  const count = Math.max(1, Math.min(parts, Math.ceil(size / (1024 * 1024))));
  const chunkSize = Math.ceil(size / count);
  const shards = [];

  for (let i = 0; i < count; i += 1) {
    const from = i * chunkSize;
    const to = Math.min(size - 1, from + chunkSize - 1);
    shards.push({ index: i, from, to, path: `${destPath}.p${i}` });
  }

  // Seed progress from any shards left by a previous run.
  for (const shard of shards) {
    const have = Math.min(await fileSize(shard.path), shard.to - shard.from + 1);
    downloaded += have;
  }
  emit(true);

  const fetchShard = async (shard) => {
    let attempts = 0;
    for (;;) {
      if (signal?.aborted) throw new Error('cancelled');
      const have = Math.min(await fileSize(shard.path), shard.to - shard.from + 1);
      const start = shard.from + have;
      if (start > shard.to) return;

      try {
        const res = await fetch(url, {
          headers: { ...HEADERS, Range: `bytes=${start}-${shard.to}` },
          signal,
        });
        if (res.status !== 206) throw new Error(`Range request rejected (HTTP ${res.status})`);
        const fh = await fsp.open(shard.path, 'a');
        try {
          for await (const chunk of res.body) {
            await fh.write(chunk);
            track(chunk.length);
          }
        } finally {
          await fh.close();
        }
        const finalSize = await fileSize(shard.path);
        if (finalSize < shard.to - shard.from + 1) throw new Error('Shard ended early');
        return;
      } catch (err) {
        if (signal?.aborted) throw new Error('cancelled');
        attempts += 1;
        if (attempts >= 4) throw err;
        await new Promise((r) => setTimeout(r, 400 * attempts));
      }
    }
  };

  await Promise.all(shards.map(fetchShard));

  // Stitch the shards into the final file.
  const out = fs.createWriteStream(destPath);
  out.on('error', () => {});
  for (const shard of shards) {
    for await (const chunk of fs.createReadStream(shard.path, { highWaterMark: 1 << 20 })) {
      if (!out.write(chunk)) await once(out, 'drain');
    }
  }
  await new Promise((resolve, reject) => {
    out.on('error', reject);
    out.end(resolve);
  });

  for (const shard of shards) await fsp.unlink(shard.path).catch(() => {});

  const got = await fileSize(destPath);
  if (got !== size) throw new Error(`Size mismatch: expected ${size} bytes, got ${got}.`);

  emit(true);
  return { path: destPath, bytes: got, seconds: (Date.now() - started) / 1000, parts: count };
}

module.exports = { downloadMultipart, probe };
