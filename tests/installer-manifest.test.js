'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeInstallManifest, MANIFEST_NAME } = require('../build/install-manifest');
const model = require('./helpers/nsis-model.cjs');
const root = 'E:\\Apps\\Mineradio', appId = 'com.mineradio.desktop';
const marker = `Mineradio install root\r\nappId=${appId}\r\n`;

test('NSIS nested path helpers preserve registers and recognize a dedicated legacy install', () => {
  for (const files of [
    { [root + '\\.mineradio-install-root']: marker },
    { [root + '\\Mineradio.exe']: '', [root + '\\resources\\app.asar']: '' },
    { [root + '\\Mineradio.exe']: '', [root + '\\resources\\app\\package.json']: '', [root + '\\resources\\app\\server.js']: '' },
  ]) {
    const runtime = model({ installDir: root, files });
    for (let i = 0; i <= 6; i++) runtime.variables['$' + i] = 'caller-' + i;
    runtime.stack.push('caller-stack'); const before = { ...runtime.variables };
    assert.equal(runtime.call('MineradioExistingInstallPathCanBeAdopted', root + '\\'), '1');
    assert.equal(runtime.call('MineradioOldInstallPathNeedsQuarantine', root), files[root + '\\.mineradio-install-root'] ? '0' : '1');
    assert.deepEqual(runtime.variables, before); assert.deepEqual(runtime.stack, ['caller-stack']);
  }
  const unknown = model({ files: { 'E:\\Apps\\other.txt': '' } });
  assert.equal(unknown.call('MineradioExistingInstallPathCanBeAdopted', 'E:\\Apps'), '0');
  assert.equal(unknown.call('MineradioOldInstallPathNeedsQuarantine', 'E:\\Apps'), '1');
});

test('registered upgrade paths survive nested adoption and normalization', () => {
  const runtime = model({ files: { [root + '\\Mineradio.exe']: '', [root + '\\resources\\app.asar']: '' }, registry: { 'HKCU|Software\\app-guid|InstallLocation': root } });
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
  const runtime = model({ files: { [root + '\\' + MANIFEST_NAME]: manifest, [root + '\\.mineradio-install-root']: marker, [root + '\\Mineradio.exe']: '', [root + '\\resources\\app\\server.js']: '', [root + '\\locales\\zh-CN.pak']: '', [root + '\\resources\\my-notes.txt']: 'keep', [root + '\\libEGL.dll']: 'unlisted-user-file' } });
  runtime.invoke('un.MineradioRemoveInstalledFiles');
  assert.deepEqual([...runtime.entries.keys()], [(root + '\\resources\\my-notes.txt').toLowerCase(), (root + '\\libEGL.dll').toLowerCase()]);
  assert(!runtime.directories.has((root + '\\resources\\app').toLowerCase()));
  assert(!runtime.directories.has((root + '\\locales').toLowerCase()));
  const clean = model({ files: { [root + '\\' + MANIFEST_NAME]: `appId=${appId}\r\nF|Mineradio.exe\r\n`, [root + '\\Mineradio.exe']: '', [root + '\\.mineradio-install-root']: marker } });
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
  assert.equal(mismatch.stack.pop(), 'invalid');
});

test('generic Electron payloads and invalid or other-edition markers cannot be adopted', () => {
  for (const evidence of ['Mineradio.exe', 'resources\\app.asar', 'resources\\app\\package.json', 'resources\\app\\server.js']) {
    const runtime = model({ files: { [root + '\\' + evidence]: '' } });
    assert.equal(runtime.call('MineradioExistingInstallPathCanBeAdopted', root), '0', evidence);
  }
  for (const invalid of ['', 'marker', 'Mineradio install root\r\nappId=com.mineradio.desktop.beta\r\n']) {
    const runtime = model({ files: { [root + '\\.mineradio-install-root']: invalid, [root + '\\Mineradio.exe']: '', [root + '\\resources\\app.asar']: '' } });
    assert.equal(runtime.call('MineradioExistingInstallPathCanBeAdopted', root), '0');
    assert.equal(runtime.call('MineradioOldInstallPathNeedsQuarantine', root), '1');
    assert.throws(() => runtime.invoke('un.MineradioRemoveInstalledFiles'), /NSIS Quit/);
    assert.deepEqual(runtime.removed, []);
  }
});

test('opening the interactive wizard preserves old installation and registry until install is confirmed', () => {
  const registry = {
    'HKCU|Software\\app-guid|InstallLocation': root,
    'HKCU|Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\uninstall-key|InstallLocation': root,
    'HKCU|Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\uninstall-key|UninstallString': `"${root}\\Uninstall Mineradio.exe"`,
  };
  const files = { [root + '\\Mineradio.exe']: '', [root + '\\resources\\app.asar']: '', [root + '\\Uninstall Mineradio.exe']: 'legacy' };
  const runtime = model({ files, registry: { ...registry } });
  runtime.invoke('macro:customInit');
  assert.deepEqual(runtime.registry, registry);
  assert.deepEqual(runtime.removed, []);
  runtime.invoke('MineradioDisableUnsafeOldUninstallers');
  assert.deepEqual(runtime.registry, {});
  assert.deepEqual(runtime.removed, []);
  assert.equal(runtime.entries.get((root + '\\Uninstall Mineradio.exe').toLowerCase()), 'legacy');
  const unattended = model({ files, registry: { ...registry }, silent: true });
  unattended.invoke('macro:customInit');
  assert.deepEqual(unattended.registry, {});
  assert.deepEqual(unattended.removed, []);
});

test('root, ancestor, marker and inventory reparse points stop uninstall before any deletion', () => {
  const files = { [root + '\\.mineradio-install-root']: marker, [root + '\\' + MANIFEST_NAME]: `appId=${appId}\r\nF|Mineradio.exe\r\n`, [root + '\\Mineradio.exe']: '' };
  for (const linked of [root, 'E:\\Apps', root + '\\.mineradio-install-root', root + '\\' + MANIFEST_NAME]) {
    const runtime = model({ files, reparse: [linked] });
    assert.throws(() => runtime.invoke('un.MineradioRemoveInstalledFiles'), /NSIS Quit/, linked);
    assert.deepEqual(runtime.removed, [], linked);
    if (!linked.endsWith(MANIFEST_NAME)) assert.equal(runtime.call('MineradioExistingInstallPathCanBeAdopted', root), '0');
  }
});

test('invalid inventory never deletes earlier valid records or invokes legacy filename cleanup', () => {
  for (const manifest of [
    `appId=another.app\r\nF|Mineradio.exe\r\n`,
    `appId=${appId}\r\nF|Mineradio.exe\r\nbroken\r\n`,
    `appId=${appId}\r\nF|Mineradio.exe\r\nF|..\\outside.txt\r\n`,
    `appId=${appId}\r\n`,
  ]) {
    const runtime = model({ files: { [root + '\\.mineradio-install-root']: marker, [root + '\\' + MANIFEST_NAME]: manifest, [root + '\\Mineradio.exe']: '', [root + '\\libEGL.dll']: '' } });
    assert.throws(() => runtime.invoke('un.MineradioRemoveInstalledFiles'), /NSIS Quit/);
    assert.deepEqual(runtime.removed, []);
  }
  const legacy = model({ files: { [root + '\\.mineradio-install-root']: marker, [root + '\\Mineradio.exe']: '', [root + '\\libEGL.dll']: '', [root + '\\my-file.txt']: 'keep' } });
  legacy.invoke('un.MineradioRemoveInstalledFiles');
  assert.deepEqual([...legacy.entries.keys()], [(root + '\\my-file.txt').toLowerCase()]);
});
