#!/usr/bin/env node
'use strict';

/* Command-line front end. Same engine the UI uses, no browser required. */

const scan = require('./lib/scan');
const jobs = require('./lib/jobs');
const { checkAdmin } = require('./lib/admin');
const { formatBytes } = require('./lib/util');

const args = process.argv.slice(2);
const command = args[0] || 'scan';

function pad(value, width) {
  const s = String(value ?? '');
  return s.length >= width ? s.slice(0, width - 1) + '…' : s + ' '.repeat(width - s.length);
}

async function runScan() {
  const started = await scan.scan();
  if (!started.started && started.error) throw new Error(started.error);

  let last = '';
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const s = scan.snapshot();
      const line = `${s.progress.toString().padStart(3)}%  ${s.stageLabel}`;
      if (line !== last) {
        last = line;
        process.stdout.write(`\r${line.padEnd(90)}`);
      }
      if (s.phase === 'ready' || s.phase === 'error') {
        clearInterval(timer);
        process.stdout.write('\n');
        resolve();
      }
    }, 300);
  });

  const s = scan.snapshot();
  if (s.phase === 'error') throw new Error(s.error);
  return s;
}

function printRows(rows, onlyUpdates) {
  const list = onlyUpdates ? rows.filter((r) => r.state === 'update') : rows;
  console.log(`\n${pad('DEVICE', 46)} ${pad('INSTALLED', 18)} ${pad('AVAILABLE', 18)} ${pad('SOURCE', 14)} STATUS`);
  console.log('-'.repeat(120));
  for (const row of list) {
    const latest = row.latest ? `${row.latest.version}` : '—';
    console.log(
      `${pad(row.name, 46)} ${pad(row.installed.version || '—', 18)} ${pad(latest, 18)} ${pad(
        row.latest?.sourceLabel || '—',
        14,
      )} ${row.state.toUpperCase()}`,
    );
  }
  console.log(`\n${list.length} row(s).`);
}

(async () => {
  await checkAdmin();

  if (command === 'scan' || command === 'list') {
    const s = await runScan();
    const updates = s.rows.filter((r) => r.state === 'update');
    console.log(
      `\n${s.stats.devices} devices · ${updates.length} updates · ${s.stats.problems} problems · ${s.stats.current} current\n`,
    );
    for (const note of s.notes) console.log(`  [${note.level}] ${note.text}`);
    printRows(s.rows, command === 'scan');
    if (updates.length) {
      const bytes = updates.reduce((a, r) => a + (r.latest.sizeBytes || 0), 0);
      console.log(`Total download: ${formatBytes(bytes)}`);
      console.log(`Run "node cli.js install" to install all of them (admin required).`);
    }
  } else if (command === 'install' || command === 'download') {
    const s = await runScan();
    const updates = s.rows.filter((r) => r.state === 'update');
    if (!updates.length) {
      console.log('Nothing to install.');
      return;
    }
    printRows(updates, true);
    const result = await jobs.startJob({
      install: command === 'install',
      parts: 8,
      items: updates.map((r) => ({
        rowId: r.id,
        name: r.name,
        version: r.latest.version,
        source: r.latest.source,
        kind: r.latest.downloadKind,
        catalogId: r.latest.catalogId,
        downloadUrl: r.latest.downloadUrl,
        updateId: r.latest.updateId,
        sizeBytes: r.latest.sizeBytes,
      })),
    });
    if (result.error) throw new Error(result.message || result.error);

    let done = false;
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        const job = jobs.listJobs().find((j) => j.id === result.job.id);
        if (!job) return;
        for (const item of job.items) {
          process.stdout.write(
            `\r${pad(item.name, 44)} ${pad(item.status, 12)} ${item.percent.toFixed(1).padStart(5)}%  ${formatBytes(
              item.speed,
            )}/s`.padEnd(110),
          );
        }
        if (job.status !== 'running') {
          clearInterval(timer);
          process.stdout.write('\n');
          console.log(`Job ${job.status}.`);
          done = true;
          resolve();
        }
      }, 400);
    });
    process.exit(done ? 0 : 1);
  } else {
    console.log('Usage: node cli.js [scan|list|download|install]');
    process.exit(1);
  }
})().catch((err) => {
  console.error('\n' + err.message);
  process.exit(1);
});
