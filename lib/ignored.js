'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IGNORED_FILE = path.join(__dirname, '..', 'data', 'ignored-updates.json');

/**
 * Persisted set of row IDs the user has dismissed ("ignore this update").
 * Stored in data/ignored-updates.json so the dismissal survives restarts.
 */

let ignored = new Set();

function loadIgnored() {
  try {
    const raw = JSON.parse(fs.readFileSync(IGNORED_FILE, 'utf8'));
    if (Array.isArray(raw)) {
      ignored = new Set(raw.map(String));
    }
  } catch {
    /* first run — empty set */
  }
}

function saveIgnored() {
  try {
    fs.mkdirSync(path.dirname(IGNORED_FILE), { recursive: true });
    fs.writeFileSync(IGNORED_FILE, JSON.stringify([...ignored]));
  } catch {
    /* best-effort persistence */
  }
}

loadIgnored();

function isIgnored(rowId) {
  return ignored.has(String(rowId));
}

function ignore(rowId) {
  const id = String(rowId);
  if (ignored.has(id)) return false;
  ignored.add(id);
  saveIgnored();
  return true;
}

function unignore(rowId) {
  const id = String(rowId);
  if (!ignored.has(id)) return false;
  ignored.delete(id);
  saveIgnored();
  return true;
}

function listIgnored() {
  return [...ignored];
}

module.exports = {
  isIgnored,
  ignore,
  unignore,
  listIgnored,
  loadIgnored,
};
