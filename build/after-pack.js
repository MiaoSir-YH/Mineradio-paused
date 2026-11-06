const fs = require('fs');
const path = require('path');
const { getRceditBundle } = require('app-builder-lib/out/toolsets/windows');
const { WineVmManager } = require('app-builder-lib/out/vm/WineVm');
const { writeInstallManifest } = require('./install-manifest');

function findNewestRceditInCache(cacheRoot) {
  if (!cacheRoot || !fs.existsSync(cacheRoot)) return null;
  var newest = null;
  var stack = [cacheRoot];
  while (stack.length) {
    var dir = stack.pop();
    var entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    entries.forEach(function(entry) {
      var fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        return;
      }
      if (entry.isFile() && entry.name.toLowerCase() === 'rcedit-x64.exe') {
        var stat = fs.statSync(fullPath);
        if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { path: fullPath, mtimeMs: stat.mtimeMs };
      }
    });
  }
  return newest && newest.path;
}

async function resolveRcedit(projectDir, winCodeSign) {
  var candidates = [
    path.join(projectDir, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe')
  ];
  var localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    var cached = findNewestRceditInCache(path.join(localAppData, 'electron-builder', 'Cache', 'winCodeSign'));
    if (cached) candidates.push(cached);
  }
  candidates.push(path.join(projectDir, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe'));
  var hit = candidates.find(function(candidate) { return candidate && fs.existsSync(candidate); });
  return hit || (await getRceditBundle(winCodeSign)).x64;
}

async function runRceditWithRetry(vm, executable, args, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  // Windows may still be scanning the freshly extracted/rebranded executable.
  // Retry resource-commit/sharing failures only; invalid inputs must fail at once.
  const delays = [500, 1000, 2000, 4000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await vm.exec(executable, args);
    } catch (error) {
      const transient = ['EPERM', 'EACCES', 'EBUSY'].includes(error && error.code) ||
        /Unable to commit changes|sharing violation|being used by another process/i.test(String(error && error.message));
      if (!transient || attempt >= delays.length) throw error;
      console.warn(`  • resource edit temporarily unavailable, retrying in ${delays[attempt]}ms`);
      await wait(delays[attempt]);
    }
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const appName = context.packager.appInfo.productFilename || 'Mineradio';
  const productName = context.packager.appInfo.productName || appName;
  const companyName = context.packager.appInfo.companyName || productName;
  const exePath = path.join(context.appOutDir, `${appName}.exe`);
  const iconPath = path.join(context.packager.info.buildResourcesDir, 'icon.ico');
  const toolsets = context.packager.config.toolsets || {};
  const rceditPath = await resolveRcedit(context.packager.projectDir, toolsets.winCodeSign);
  const vm = new WineVmManager(toolsets.wine);
  const resourcePath = file => process.platform === 'win32' ? file : vm.toVmFile(file);

  if (!fs.existsSync(exePath)) throw new Error(`Mineradio executable was not found: ${exePath}`);
  if (!fs.existsSync(iconPath)) throw new Error(`Mineradio icon was not found: ${iconPath}`);

  const version = context.packager.appInfo.version;
  console.log(`  • injecting Mineradio resources  rcedit=${rceditPath}`);
  await runRceditWithRetry(vm, rceditPath, [
    resourcePath(exePath),
    '--set-icon', resourcePath(iconPath),
    '--set-version-string', 'FileDescription', productName,
    '--set-version-string', 'ProductName', productName,
    '--set-version-string', 'CompanyName', companyName,
    '--set-version-string', 'OriginalFilename', `${appName}.exe`,
    '--set-file-version', version,
    '--set-product-version', version
  ]);
  writeInstallManifest(context.appOutDir, context.packager.appInfo.id);
};

module.exports.runRceditWithRetry = runRceditWithRetry;
