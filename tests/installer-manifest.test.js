'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeInstallManifest, MANIFEST_NAME } = require('../build/install-manifest');
const model = require('./helpers/nsis-model.cjs');
const root = 'E:\\Apps\\Mineradio', appId = 'com.mineradio.desktop';

test('NSIS nested path helpers preserve registers and recognize a dedicated legacy install', () => {
  for (const evidence of ['.mineradio-install-root', 'Mineradio.exe', 'resources\\app.asar', 'resources\\app\\package.json']) {
    const runtime = model({ installDir: root, files: { [root + '\\' + evidence]: '' } });
    for (let i = 0; i <= 6; i++) runtime.variables['$' + i] = 'caller-' + i;
    runtime.stack.push('caller-stack'); const before = { ...runtime.variables };
    assert.equal(runtime.call('MineradioExistingInstallPathCanBeAdopted', root + '\\'), '1', evidence);
    assert.equal(runtime.call('MineradioOldInstallPathNeedsQuarantine', root), '0', evidence);
    assert.deepEqual(runtime.variables, before); assert.deepEqual(runtime.stack, ['caller-stack']);
  }
  const unknown = model({ files: { 'E:\\Apps\\other.txt': '' } });
  assert.equal(unknown.call('MineradioExistingInstallPathCanBeAdopted', 'E:\\Apps'), '0');
  assert.equal(unknown.call('MineradioOldInstallPathNeedsQuarantine', 'E:\\Apps'), '1');
});

test('registered upgrade paths survive nested adoption and normalization', () => {
  const runtime = model({ files: { [root + '\\Mineradio.exe']: '' }, registry: { 'HKCU|Software\\app-guid|InstallLocation': root } });
  assert.equal(runtime.call('MineradioRegisteredInstallDirCanBeAdopted', root), '1');
  runtime.invoke('MineradioUseRegisteredInstallDir'); assert.equal(runtime.stack.pop(), '1'); assert.equal(runtime.variables.$INSTDIR, root);
  assert.equal(runtime.call('MineradioNormalizeInstallDir', 'D:\\'), 'D:\\Mineradio');
  assert.equal(runtime.call('un.MineradioNormalizeInstallDir', root + '\\'), root);
});

test('packaging writes a complete UTF-16 inventory with deepest directories removed first', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-manifest-')); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temp, 'resources/app/中文'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'Mineradio.exe'), 'fixture');
  fs.writeFileSync(path.join(temp, 'resources/app/中文/封面.png'), 'fixture');
  const counts = writeInstallManifest(temp, appId); assert.equal(counts.files, 3); assert.equal(counts.directories, 3);
  const content = fs.readFileSync(path.join(temp, MANIFEST_NAME), 'utf16le');
  assert(content.startsWith(`appId=${appId}\r\n`)); assert(content.includes('F|resources\\app\\中文\\封面.png\r\n'));
  assert(content.includes('F|resources\\elevate.exe\r\n'));
  assert(content.indexOf('D|resources\\app\\中文') < content.indexOf('D|resources\r\n'));
  writeInstallManifest(temp, appId); assert.equal(fs.readFileSync(path.join(temp, MANIFEST_NAME), 'utf16le'), content);
  fs.symlinkSync(path.join(temp, 'resources'), path.join(temp, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => writeInstallManifest(temp, appId), /symbolic links/);
});

test('manifest uninstall removes bundled trees and retains unlisted user files', () => {
  const manifest = `appId=${appId}\r\nF|Mineradio.exe\r\nF|resources\\app\\server.js\r\nF|locales\\zh-CN.pak\r\nD|resources\\app\r\nD|resources\r\nD|locales\r\n`;
  const runtime = model({ files: { [root + '\\' + MANIFEST_NAME]: manifest, [root + '\\.mineradio-install-root']: 'marker', [root + '\\Mineradio.exe']: '', [root + '\\resources\\app\\server.js']: '', [root + '\\locales\\zh-CN.pak']: '', [root + '\\resources\\my-notes.txt']: 'keep' } });
  runtime.invoke('un.MineradioRemoveInstalledFiles');
  assert.deepEqual([...runtime.entries.keys()], [(root + '\\resources\\my-notes.txt').toLowerCase()]);
  assert(!runtime.directories.has((root + '\\resources\\app').toLowerCase()));
  assert(!runtime.directories.has((root + '\\locales').toLowerCase()));
  const clean = model({ files: { [root + '\\' + MANIFEST_NAME]: `appId=${appId}\r\nF|Mineradio.exe\r\n`, [root + '\\Mineradio.exe']: '', [root + '\\.mineradio-install-root']: 'marker' } });
  clean.invoke('un.MineradioRemoveInstalledFiles'); assert.equal(clean.entries.size, 0); assert(!clean.directories.has(root.toLowerCase()));
});

test('uninstall manifest paths reject traversal, wildcard, ADS and junction escapes', () => {
  const runtime = model({ files: { [root + '\\resources\\app\\safe.js']: '' }, reparse: [root + '\\junction'] });
  for (const unsafe of ['..\\other.txt', 'resources\\..\\..\\other.txt', '\\absolute.txt', 'C:\\other.txt', 'resources\\*', 'file:stream', 'resources\\..\\user.txt', 'junction\\outside.txt']) {
    assert.equal(runtime.call('un.MineradioManifestPathIsSafe', unsafe), '0', unsafe);
  }
  assert.equal(runtime.call('un.MineradioManifestPathIsSafe', 'resources\\app\\safe.js'), '1');
  const mismatch = model({ files: { [root + '\\' + MANIFEST_NAME]: 'appId=another.app\r\nF|keep.txt\r\n', [root + '\\keep.txt']: 'keep' } });
  mismatch.invoke('un.MineradioRemoveManifestFiles'); assert.equal(mismatch.entries.size, 2);
});
