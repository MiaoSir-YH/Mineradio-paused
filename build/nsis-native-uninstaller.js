'use strict';

// NSIS 3.0's 32-bit helper cannot run in a Wine installation without WoW64.
// electron-builder already provides a native extractor for the same helper on
// macOS. Use that extractor for Linux builds too, without changing the actual
// installer/uninstaller scripts or the later signing step.
if (process.platform === 'linux') {
  const path = require('path');
  const { WineVmManager } = require('app-builder-lib/out/vm/WineVm');
  const { UninstallerReader } = require('app-builder-lib/out/targets/nsis/nsisUtil');
  const execWine = WineVmManager.prototype.exec;

  WineVmManager.prototype.exec = async function (file, args, options, ...rest) {
    if ((!args || !args.length) && options && options.env && options.env.__COMPAT_LAYER === 'RunAsInvoker' && file.endsWith('.exe')) {
      const uninstaller = path.join(path.dirname(file), path.basename(file, 'exe') + '__uninstaller.exe');
      try {
        await UninstallerReader.exec(file, uninstaller);
        return '';
      } catch (error) {
        console.warn('Native NSIS uninstaller extraction failed; trying Wine:', error.message);
      }
    }
    return execWine.call(this, file, args, options, ...rest);
  };
}
