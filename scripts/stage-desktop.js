#!/usr/bin/env node
'use strict';

/**
 * Stages everything the Tauri shell ships, for one platform.
 *
 *   node scripts/stage-desktop.js                          # this machine
 *   node scripts/stage-desktop.js --platform darwin --arch arm64
 *   node scripts/stage-desktop.js --skip-node              # reuse a staged runtime
 *
 * Two payloads are produced:
 *
 *   desktop/src-tauri/resources/app    the engine (server.js, lib/, public/, scripts/)
 *   desktop/src-tauri/resources/node   a bundled Node runtime, so the installed
 *                                      app never asks the user to install Node
 *
 * The version is copied from package.json into every desktop manifest, so the
 * tag, the installer and /api/health cannot disagree.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TAURI = path.join(ROOT, 'desktop', 'src-tauri');
const RESOURCES = path.join(TAURI, 'resources');
const CACHE = path.join(ROOT, 'desktop', '.cache');

const NODE_VERSION = process.env.DRIVERRADAR_NODE_VERSION || '22.23.4';

const APP_FILES = [
  'server.js',
  'cli.js',
  'supervisor.js',
  'check-nvidia.js',
  'package.json',
  'requirements.txt',
  'LICENSE',
  'appicon.png',
  'lib',
  'public',
  'scripts',
];

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : true;
}

const platform = String(arg('platform', process.platform));
const arch = String(arg('arch', process.arch));
const skipNode = Boolean(arg('skip-node', false));

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

function nodeArchiveUrl() {
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  if (platform === 'win32') {
    const a = arch === 'arm64' ? 'arm64' : arch === 'ia32' ? 'x86' : 'x64';
    return { url: `${base}/node-v${NODE_VERSION}-win-${a}.zip`, ext: 'zip' };
  }
  if (platform === 'darwin') {
    const a = arch === 'arm64' ? 'arm64' : 'x64';
    return { url: `${base}/node-v${NODE_VERSION}-darwin-${a}.tar.gz`, ext: 'tar.gz', a };
  }
  if (platform === 'linux') {
    const a = arch === 'arm64' || arch === 'aarch64' ? 'arm64' : 'x64';
    return { url: `${base}/node-v${NODE_VERSION}-linux-${a}.tar.xz`, ext: 'tar.xz', a };
  }
  fail(`Unsupported platform: ${platform}`);
  return null;
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) fail(`Could not download ${url} (HTTP ${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fsp.writeFile(destination, buffer);
  return buffer.length;
}

function extract(archive, ext, into) {
  if (ext === 'zip') {
    // The Windows build always has PowerShell; unzip is not guaranteed.
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${into}' -Force`],
      { stdio: 'inherit' },
    );
    return;
  }
  const flag = ext === 'tar.xz' ? '-xJf' : '-xzf';
  execFileSync('tar', [flag, archive, '-C', into], { stdio: 'inherit' });
}

async function stageNode() {
  const target = path.join(RESOURCES, 'node');
  await fsp.mkdir(target, { recursive: true });

  const info = nodeArchiveUrl();
  await fsp.mkdir(CACHE, { recursive: true });
  const archive = path.join(CACHE, path.basename(info.url));

  if (!fs.existsSync(archive)) {
    process.stdout.write(`  downloading Node ${NODE_VERSION} for ${platform}/${arch}… `);
    const bytes = await download(info.url, archive);
    console.log(`${(bytes / 1024 / 1024).toFixed(0)} MB`);
  } else {
    console.log(`  using cached ${path.basename(archive)}`);
  }

  const unpacked = path.join(CACHE, `unpacked-${platform}-${arch}`);
  await fsp.rm(unpacked, { recursive: true, force: true });
  await fsp.mkdir(unpacked, { recursive: true });
  extract(archive, info.ext, unpacked);

  const [folder] = (await fsp.readdir(unpacked)).filter((entry) => entry.startsWith('node-'));
  if (!folder) fail(`The Node archive ${archive} unpacked to nothing.`);
  const base = path.join(unpacked, folder);

  if (platform === 'win32') {
    const source = path.join(base, 'node.exe');
    if (!fs.existsSync(source)) fail(`node.exe is missing from ${base}`);
    await fsp.copyFile(source, path.join(target, 'node.exe'));
    console.log('  staged resources/node/node.exe');
  } else {
    const source = path.join(base, 'bin', 'node');
    if (!fs.existsSync(source)) fail(`bin/node is missing from ${base}`);
    const name = info.a === 'arm64' ? 'node-arm64' : 'node-x64';
    const destination = path.join(target, name);
    await fsp.copyFile(source, destination);
    await fsp.chmod(destination, 0o755);
    console.log(`  staged resources/node/${name}`);
  }
}

async function stageApp(version) {
  const target = path.join(RESOURCES, 'app');
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.mkdir(target, { recursive: true });

  for (const entry of APP_FILES) {
    const source = path.join(ROOT, entry);
    if (!fs.existsSync(source)) fail(`Missing engine file: ${entry}`);
    await fsp.cp(source, path.join(target, entry), { recursive: true });
  }
  console.log(`  staged resources/app (DriverRadar ${version})`);
}

async function syncVersions(version) {
  const manifests = [
    {
      file: path.join(ROOT, 'desktop', 'package.json'),
      read: (json) => ({ ...json, version }),
    },
    {
      file: path.join(TAURI, 'Cargo.toml'),
      read: null,
    },
    {
      file: path.join(TAURI, 'tauri.conf.json'),
      read: (json) => ({ ...json, version }),
    },
  ];

  for (const manifest of manifests) {
    if (manifest.read) {
      const json = JSON.parse(await fsp.readFile(manifest.file, 'utf8'));
      await fsp.writeFile(manifest.file, `${JSON.stringify(manifest.read(json), null, 2)}\n`);
    } else {
      const text = await fsp.readFile(manifest.file, 'utf8');
      const next = text.replace(/^version = "[^"]*"$/m, `version = "${version}"`);
      if (next !== text) await fsp.writeFile(manifest.file, next);
    }
  }
  console.log(`  version ${version} written to the desktop manifests`);
}

(async () => {
  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  console.log(`\nStaging DriverRadar desktop ${version} for ${platform}/${arch}`);

  await syncVersions(version);
  await stageApp(version);
  if (skipNode) {
    console.log('  --skip-node: keeping the runtime already in resources/node');
  } else {
    await stageNode();
  }

  const nodeCheck = path.join(RESOURCES, 'node');
  if (!fs.existsSync(nodeCheck) || !(await fsp.readdir(nodeCheck)).length) {
    fail('No Node runtime staged. Run without --skip-node.');
  }
  console.log('Done.\n');
})().catch((err) => fail(err.stack || err.message));
