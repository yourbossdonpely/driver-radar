'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const bus = require('./bus');
const { resolveDownloadUrl } = require('./catalog');
const { downloadMultipart } = require('./downloader');
const { runPowerShell } = require('./ps');
const installer = require('./installer');
const { isAdminSync } = require('./admin');
const { formatBytes, mapLimit } = require('./util');

const DOWNLOAD_DIR = path.join(__dirname, '..', 'data', 'downloads');
const jobs = new Map();

function safeName(value) {
  return String(value || 'driver')
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 70);
}

function snapshot(job) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    status: job.status,
    install: job.install,
    parts: job.parts,
    restorePoint: job.restorePoint,
    error: job.error,
    rebootRequired: job.rebootRequired,
    items: job.items.map((i) => ({ ...i })),
    totals: {
      bytes: job.items.reduce((a, i) => a + (i.size || 0), 0),
      downloaded: job.items.reduce((a, i) => a + (i.downloaded || 0), 0),
      speed: job.items.reduce((a, i) => a + (i.speed || 0), 0),
    },
  };
}

function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return () => {
    const now = Date.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      last = now;
      fn();
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn();
      }, wait);
      timer.unref?.();
    }
  };
}

function listJobs() {
  return [...jobs.values()].slice(-8).map(snapshot);
}

function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'running') return false;
  job.cancelled = true;
  job.controller.abort();
  return true;
}

async function startJob(input = {}) {
  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length) return { error: 'No updates selected.' };

  const install = input.install !== false;
  if (install && !isAdminSync()) {
    return { error: 'admin', message: 'Administrator rights are required to install drivers.' };
  }

  const job = {
    id: `job_${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    status: 'running',
    install,
    parts: Math.min(16, Math.max(2, Number(input.parts) || 12)),
    restorePoint: Boolean(input.restorePoint),
    rebootRequired: false,
    error: null,
    cancelled: false,
    controller: new AbortController(),
    items: items.map((it) => ({
      rowId: it.rowId,
      name: it.name || 'Driver package',
      hardwareId: it.hardwareId || null,
      version: it.version || '',
      source: it.source || 'catalog',
      kind: it.kind || 'cab',
      catalogId: it.catalogId || null,
      downloadUrl: it.downloadUrl || null,
      updateId: it.updateId || null,
      status: 'queued',
      size: Number(it.sizeBytes) || 0,
      downloaded: 0,
      speed: 0,
      percent: 0,
      message: null,
      error: null,
      file: null,
    })),
  };

  jobs.set(job.id, job);
  const emit = throttle(() => bus.emit('job', snapshot(job)), 250);
  emit();

  (async () => {
    const { signal } = job.controller;

    const fail = (item, err) => {
      if (signal.aborted) {
        item.status = 'cancelled';
        item.message = 'Cancelled';
      } else {
        item.status = 'failed';
        item.error = err.message || String(err);
      }
      item.speed = 0;
      emit();
    };

    const downloadOne = async (item) => {
      try {
        let url = item.downloadUrl;
        if (!url) {
          if (!item.catalogId) throw new Error('No download source for this update.');
          item.status = 'resolving';
          item.message = 'Resolving download link';
          emit();
          url = await resolveDownloadUrl(item.catalogId);
        }

        const ext = item.kind === 'exe' ? '.exe' : '.cab';
        const dest = path.join(DOWNLOAD_DIR, `${safeName(item.name)}_${safeName(item.version)}${ext}`);

        item.status = 'downloading';
        item.message = `${job.parts} parallel connections`;
        item.file = dest;
        emit();

        const result = await downloadMultipart(url, dest, {
          parts: job.parts,
          signal,
          expectedSize: item.size,
          onProgress: (p) => {
            item.downloaded = p.downloaded;
            if (p.total) item.size = p.total;
            item.speed = p.speed;
            item.percent = p.percent;
            emit();
          },
        });

        item.downloaded = result.bytes;
        item.size = result.bytes;
        item.percent = 100;
        item.speed = 0;
        item.status = 'downloaded';
        item.message = `${formatBytes(result.bytes)} in ${result.seconds.toFixed(1)}s · ${result.parts} stream${result.parts === 1 ? '' : 's'}`;
        emit();
      } catch (err) {
        fail(item, err);
      }
    };

    const installPackage = async (item) => {
      try {
        if (item.kind === 'exe') {
          item.status = 'installing';
          item.message = 'Running vendor installer';
          emit();
          const res = await installer.runVendorInstaller(item.file);
          if (res.skipped) {
            item.status = 'downloaded';
            item.message = res.log;
          } else {
            if (!res.ok) throw new Error(res.log || 'Vendor installer returned an error.');
            if (res.reboot) job.rebootRequired = true;
            item.status = 'done';
            item.message = 'Installed';
          }
          emit();
          return;
        }

        item.status = 'extracting';
        item.message = 'Unpacking driver package';
        emit();
        const outDir = path.join(DOWNLOAD_DIR, `${safeName(item.name)}_${safeName(item.version)}`);
        await fsp.rm(outDir, { recursive: true, force: true });
        const extracted = await installer.extractCab(item.file, outDir);
        if (!extracted.ok) throw new Error(`Extraction failed: ${extracted.output.slice(-500)}`);

        if (item.hardwareId) {
          const matches = await installer.infsMatching(outDir, item.hardwareId);
          if (!matches.length) {
            throw new Error(
              'The package does not declare this device in any INF — skipped to avoid installing an unrelated driver.',
            );
          }
        }

        item.status = 'installing';
        item.message = 'Installing with pnputil';
        emit();
        const res = await installer.installInfRoot(outDir);
        if (res.reboot) job.rebootRequired = true;
        if (!res.ok) throw new Error(res.log.slice(-800) || 'pnputil reported an error.');
        item.status = 'done';
        item.message = res.count ? `${res.count} driver package(s) added` : 'Installed';
        emit();
      } catch (err) {
        fail(item, err);
      }
    };

    const installWu = async (item) => {
      try {
        item.status = 'installing';
        item.message = 'Handing over to Windows Update';
        emit();
        const res = await runPowerShell('wu-install.ps1', ['-UpdateId', item.updateId], {
          timeout: 30 * 60 * 1000,
        });
        if (!res.ok) throw new Error(res.error || 'Windows Update install failed.');
        if (res.reboot) job.rebootRequired = true;
        item.status = 'done';
        item.message = res.message || 'Installed via Windows Update';
        emit();
      } catch (err) {
        fail(item, err);
      }
    };

    try {
      if (install && job.restorePoint) {
        const rp = await installer.createRestorePoint();
        if (!rp.ok) {
          job.items[0].message = `Restore point unavailable: ${rp.error}`;
        }
        emit();
      }

      const packages = job.items.filter((item) => item.source !== 'wu');

      // Packages download in parallel; installs stay sequential so pnputil and
      // vendor setup programs never race each other.
      await mapLimit(packages, install ? 2 : 3, async (item) => {
        if (signal.aborted) {
          item.status = 'cancelled';
          item.message = 'Cancelled';
          emit();
          return null;
        }
        await downloadOne(item);
        return null;
      });

      for (const item of job.items) {
        if (signal.aborted) {
          if (['queued', 'resolving', 'downloaded'].includes(item.status)) {
            item.status = 'cancelled';
            item.message = 'Cancelled';
          }
          continue;
        }
        if (item.source === 'wu' && item.updateId) {
          await installWu(item);
          continue;
        }
        if (!install || item.status !== 'downloaded') continue;
        await installPackage(item);
      }

      const states = job.items.map((i) => i.status);
      if (job.cancelled) job.status = 'cancelled';
      else if (states.every((s) => s === 'done' || s === 'downloaded')) job.status = 'done';
      else if (states.some((s) => s === 'done' || s === 'downloaded')) job.status = 'partial';
      else job.status = 'failed';
    } catch (err) {
      job.status = 'failed';
      job.error = err.message || String(err);
    } finally {
      emit();
      bus.emit('job', snapshot(job));
    }
  })();

  return { job: snapshot(job) };
}

module.exports = { startJob, cancelJob, listJobs, snapshot, DOWNLOAD_DIR };
