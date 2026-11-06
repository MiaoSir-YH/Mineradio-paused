const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('node:vm');

const appRoot = path.resolve(__dirname, '..');
const mainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
const preloadText = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');

test('the update-specific bridge is removed while generic trusted HTTPS links remain usable', async () => {
  assert.doesNotMatch(mainText + preloadText, /mineradio-open-update-page|openUpdatePage/);
  assert.match(preloadText, /openExternalUrl: \(url\) => ipcRenderer\.invoke\('mineradio-open-external-url', String\(url \|\| ''\)\)/);
  let handle;
  const opened = [];
  const ctx = vm.createContext({ URL, ipcMain: { handle: (_channel, handler) => { handle = handler; } }, isTrustedMainWindowIpc: event => event === 'main', shell: { openExternal: async url => opened.push(url) } });
  const start = mainText.indexOf("ipcMain.handle('mineradio-open-external-url'");
  const end = mainText.indexOf("ipcMain.handle('mineradio-restart-app'", start);
  assert(start >= 0 && end > start);
  vm.runInContext(mainText.slice(start, end), ctx);
  for (const url of ['http://example.invalid/', 'file:///C:/fixture', 'javascript:alert(1)', 'https://example.invalid/' + 'x'.repeat(2048)]) {
    assert.equal((await handle('main', url)).ok, false);
  }
  assert.equal((await handle('untrusted', 'https://example.invalid/')).ok, false);
  assert.deepEqual(opened, []);
  assert.equal((await handle('main', 'https://example.invalid/account')).ok, true);
  assert.deepEqual(opened, ['https://example.invalid/account']);
});

test('local update installer and update-cache bridges are absent', () => {
  const bridgeText = mainText + '\n' + preloadText;
  assert.doesNotMatch(bridgeText, /mineradio-open-update-installer/);
  assert.doesNotMatch(bridgeText, /openUpdateInstaller/);
  assert.doesNotMatch(mainText, /getUpdateDownloadDir/);
  assert.doesNotMatch(mainText, /MINERADIO_UPDATE_DIR/);
  assert.doesNotMatch(mainText, /shell\.openPath\(/);
});
