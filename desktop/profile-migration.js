'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PERSISTENT_CHROMIUM_FILES = [
  'Local Storage', 'IndexedDB', 'Session Storage', 'WebStorage', 'Storage',
  'Network', 'Cookies', 'Cookies-journal', 'Local State', 'Preferences',
  'Secure Preferences', 'Partitions', 'Service Worker', 'File System',
];
const CACHE_NAMES = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'CacheStorage', 'ScriptCache']);

function migrateChromiumProfile(destination, sources) {
  fs.mkdirSync(destination, { recursive: true });
  const marker = path.join(destination, 'mineradio-profile-migrated.json');
  if (fs.existsSync(marker)) return;
  for (const name of PERSISTENT_CHROMIUM_FILES) {
    const target = path.join(destination, name);
    if (fs.existsSync(target)) continue;
    for (const source of sources) {
      if (!source || path.resolve(source) === path.resolve(destination)) continue;
      const candidate = path.join(source, name);
      if (!fs.existsSync(candidate) || fs.lstatSync(candidate).isSymbolicLink()) continue;
      const staging = fs.mkdtempSync(path.join(destination, '.migration-'));
      try {
        const staged = path.join(staging, name);
        fs.cpSync(candidate, staged, {
          recursive: true,
          preserveTimestamps: true,
          filter: file => !CACHE_NAMES.has(path.basename(file)) && !fs.lstatSync(file).isSymbolicLink(),
        });
        fs.renameSync(staged, target);
      } finally {
        // mkdtemp is always an immediate child of our owned destination.
        if (path.dirname(path.resolve(staging)) === path.resolve(destination)) fs.rmSync(staging, { recursive: true, force: true });
      }
      break;
    }
  }
  fs.writeFileSync(marker, JSON.stringify({ version: 1, completedAt: Date.now() }), 'utf8');
}

function migrateAppOwnedFiles({ destination, sources, names, valid, log = console }) {
  fs.mkdirSync(destination, { recursive: true });
  const marker = path.join(destination, 'app-owned-migration.json');
  let completed = new Set();
  try { completed = new Set(JSON.parse(fs.readFileSync(marker, 'utf8')).completed || []); } catch (_) {}
  for (const name of names) {
    if (completed.has(name)) continue;
    const target = path.join(destination, name);
    try {
      // Even an empty target is an intentional local state (including logout).
      // A timestamp comparison must never resurrect an old cached credential.
      if (!fs.existsSync(target)) {
        let best = null;
        for (const source of sources) {
          if (!source || path.resolve(source) === path.resolve(destination)) continue;
          const candidate = path.join(source, name);
          if (!valid(name, candidate)) continue;
          const mtimeMs = fs.statSync(candidate).mtimeMs;
          if (!best || best.mtimeMs < mtimeMs) best = { file: candidate, mtimeMs };
        }
        if (best) {
          fs.copyFileSync(best.file, target, fs.constants.COPYFILE_EXCL);
          fs.utimesSync(target, new Date(), new Date(best.mtimeMs));
          log.log('[UserDataMigration] restored', name);
        }
      }
      // Persist per-file completion before a later startup can see logout as
      // missing data. Other files can still retry if their migration failed.
      completed.add(name);
      const temporary = `${marker}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, completed: [...completed] }), 'utf8');
      fs.renameSync(temporary, marker);
    } catch (error) {
      completed.delete(name);
      log.warn('[UserDataMigration] skipped', name, error.message);
    }
  }
}

module.exports = { migrateChromiumProfile, migrateAppOwnedFiles };
