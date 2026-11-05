'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_NAME = '.mineradio-installed-files';

function writeInstallManifest(appOutDir, appId) {
  if (!appId || /[\r\n]/.test(appId)) throw new Error('A valid install manifest appId is required');
  const files = [], directories = [];
  function visit(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!prefix && entry.name === MANIFEST_NAME) continue;
      if (/[<>:"/\\|?*\x00-\x1f]/.test(entry.name) || /[. ]$/.test(entry.name)) throw new Error(`Unsafe Windows install entry: ${entry.name}`);
      const relative = prefix ? `${prefix}\\${entry.name}` : entry.name;
      // NSIS reads one UTF-16 line at a time with a bounded string buffer.
      if (relative.length > 900) throw new Error(`Install manifest path is too long: ${relative}`);
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Install manifest cannot follow symbolic links: ${relative}`);
      if (entry.isDirectory()) { directories.push(relative); visit(fullPath, relative); }
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`Unsupported install entry: ${relative}`);
    }
  }
  visit(appOutDir, '');
  // electron-builder's NSIS target copies this helper after afterPack returns.
  // Record it even before it exists so resources can become empty on uninstall.
  if (!files.includes('resources\\elevate.exe')) files.push('resources\\elevate.exe');
  files.sort();
  directories.sort((a, b) => b.split('\\').length - a.split('\\').length || a.localeCompare(b));
  const lines = [`appId=${appId}`, ...files.map(file => `F|${file}`), ...directories.map(dir => `D|${dir}`)];
  fs.writeFileSync(path.join(appOutDir, MANIFEST_NAME), lines.join('\r\n') + '\r\n', 'utf16le');
  return { files: files.length, directories: directories.length };
}

module.exports = { MANIFEST_NAME, writeInstallManifest };
