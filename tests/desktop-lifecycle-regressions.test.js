'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'desktop/main.js'), 'utf8');

test('an obsolete lyrics mouse poller cannot clear or write into its replacement', () => {
  const children = [], clicks = [];
  const ctx = vm.createContext({ process: { platform: 'win32' }, desktopLyricsMousePoller: null, desktopLyricsMousePollerBuffer: '',
    spawn() { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => { child.killed = true; }; children.push(child); return child; },
    handleDesktopLyricsGlobalMiddleClick() { clicks.push('click'); }
  });
  vm.runInContext(main.slice(main.indexOf('function startDesktopLyricsMousePoller('), main.indexOf('function broadcastDesktopLyricsLockState(')), ctx);
  ctx.startDesktopLyricsMousePoller(); ctx.stopDesktopLyricsMousePoller(); ctx.startDesktopLyricsMousePoller();
  children[0].stdout.emit('data', Buffer.from('MMB\n')); children[0].emit('exit'); children[0].emit('error', new Error('late'));
  assert.strictEqual(ctx.desktopLyricsMousePoller, children[1]); assert.equal(clicks.length, 0);
  children[1].stdout.emit('data', Buffer.from('MMB\n')); assert.equal(clicks.length, 1);
  ctx.startDesktopLyricsMousePoller(); assert.equal(children.length, 2);
  ctx.stopDesktopLyricsMousePoller(); assert.equal(children[1].killed, true);
});

test('restart requests relaunch through normal application shutdown', async () => {
  const calls = [], handlers = {};
  const ctx = vm.createContext({ app: { relaunch() { calls.push('relaunch'); }, quit() { calls.push('quit'); }, exit() { calls.push('exit'); } }, ipcMain: { handle(name, fn) { handlers[name] = fn; } } });
  const start = main.indexOf("ipcMain.handle('mineradio-restart-app'");
  vm.runInContext(main.slice(start, main.indexOf("ipcMain.handle('mineradio-desktop-lyrics-set-enabled'", start)), ctx);
  const result = await handlers['mineradio-restart-app'](); assert.equal(result.ok, true); assert.deepEqual(calls, ['relaunch', 'quit']);
});

test('effective production and beta packaging include mandatory Qishui startup modules', async () => {
  const { getConfig } = require('app-builder-lib/out/util/config/config');
  const minimatch = require('minimatch'); const matches = minimatch.minimatch || minimatch;
  for (const filename of ['package.json', 'electron-builder.internal-beta.json']) {
    const config = await getConfig(root, filename === 'package.json' ? null : path.join(root, filename), null);
    const patterns = config.files.flatMap(entry => typeof entry === 'string' ? [entry] : entry.filter || []);
    for (const file of ['qishui-qr-login.js', 'qishui-auth-v6.js', 'qishui-auth-v6/bdms.js', 'qishui-auth-v6/security_seed.html']) {
      assert(fs.existsSync(path.join(root, file)));
      assert(patterns.some(pattern => !pattern.startsWith('!') && matches(file, pattern)), filename + ' missing ' + file);
      assert(!patterns.some(pattern => pattern.startsWith('!') && matches(file, pattern.slice(1))), filename + ' excludes ' + file);
    }
  }
});
