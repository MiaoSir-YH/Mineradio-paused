'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrateChromiumProfile, migrateAppOwnedFiles } = require('../desktop/profile-migration');
const { loadRendererOrigin } = require('../desktop/app-origin');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-profile-test-'));
  t.after(() => { if (path.dirname(root) === os.tmpdir()) fs.rmSync(root, { recursive: true, force: true }); });
  const old = path.join(root, 'old-cache'), stable = path.join(root, 'stable');
  fs.mkdirSync(old); fs.mkdirSync(stable);
  return { root, old, stable };
}

test('empty or deleted credentials cannot be resurrected by an old cache after logout', t => {
  const { old, stable } = fixture(t);
  fs.writeFileSync(path.join(old, '.cookie'), 'old-account');
  fs.writeFileSync(path.join(stable, '.cookie'), '');
  const options = { destination: stable, sources: [old], names: ['.cookie'], valid: (_, file) => fs.existsSync(file) && fs.statSync(file).size > 0, log: { log() {}, warn() {} } };
  migrateAppOwnedFiles(options);
  assert.equal(fs.readFileSync(path.join(stable, '.cookie'), 'utf8'), '');
  fs.unlinkSync(path.join(stable, '.cookie'));
  migrateAppOwnedFiles(options);
  assert.equal(fs.existsSync(path.join(stable, '.cookie')), false);
});

test('first migration preserves legacy login once and never replaces stable settings', t => {
  const { old, stable } = fixture(t);
  fs.writeFileSync(path.join(old, '.cookie'), 'legacy-account');
  const options = { destination: stable, sources: [old], names: ['.cookie'], valid: (_, file) => fs.existsSync(file), log: { log() {}, warn() {} } };
  migrateAppOwnedFiles(options);
  assert.equal(fs.readFileSync(path.join(stable, '.cookie'), 'utf8'), 'legacy-account');
  fs.writeFileSync(path.join(stable, '.cookie'), 'new-account');
  fs.writeFileSync(path.join(old, '.cookie'), 'stale-account-with-later-timestamp');
  migrateAppOwnedFiles(options);
  assert.equal(fs.readFileSync(path.join(stable, '.cookie'), 'utf8'), 'new-account');
});

test('profile migration preserves storage and partitions, excludes caches and cannot overwrite later values', t => {
  const { old, stable } = fixture(t);
  const put = (name, value) => { const file = path.join(old, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  put('Local Storage/leveldb/value', 'history'); put('IndexedDB/value', 'playlist');
  put('Partitions/provider/Network/Cookies', 'provider-cookie'); put('Partitions/provider/Cache/data', 'disposable');
  put('Cache/data', 'disposable');
  migrateChromiumProfile(stable, [old]);
  assert.equal(fs.readFileSync(path.join(stable, 'Local Storage/leveldb/value'), 'utf8'), 'history');
  assert.equal(fs.readFileSync(path.join(stable, 'Partitions/provider/Network/Cookies'), 'utf8'), 'provider-cookie');
  assert.equal(fs.existsSync(path.join(stable, 'Partitions/provider/Cache')), false);
  assert.equal(fs.existsSync(path.join(stable, 'Cache')), false);
  fs.writeFileSync(path.join(stable, 'IndexedDB/value'), 'new-playlist');
  migrateChromiumProfile(stable, [old]);
  assert.equal(fs.readFileSync(path.join(stable, 'IndexedDB/value'), 'utf8'), 'new-playlist');
});

test('first upgrade preserves the previous renderer origin, then ignores future backend-port changes', t => {
  const { stable } = fixture(t);
  fs.writeFileSync(path.join(stable, 'startup-state.json'), JSON.stringify({ port: 3001, targetUrl: 'http://127.0.0.1:3001/?startupAttempt=1' }));
  assert.equal(loadRendererOrigin(stable), 'http://127.0.0.1:3001');
  fs.writeFileSync(path.join(stable, 'startup-state.json'), JSON.stringify({ port: 3002 }));
  assert.equal(loadRendererOrigin(stable), 'http://127.0.0.1:3001');
});
