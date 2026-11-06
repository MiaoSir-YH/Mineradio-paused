'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const text = fs.readFileSync(path.join(__dirname, '../desktop/main.js'), 'utf8');

function harness() {
  const handlers = new Map(), events = [], created = [];
  const ctx = vm.createContext({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    desktopLyricsRequestedEnabled: false, desktopLyricsState: {}, desktopLyricsWindow: null,
    taskbarLyricsRuntime: null, taskbarLyricsRecreateAfterClose: false,
    closeTaskbarLyricsRuntime() {},
    desktopLyricsLastTaskbarLayout: null,
    appQuitting: false, isTrustedMainWindowIpc: e => e === 'main',
    isTrustedDesktopLyricsIpc: e => e === 'main' || e === 'overlay',
    createDesktopLyricsWindow: payload => { created.push(payload); ctx.desktopLyricsState = payload; },
    cancelTaskbarLyricsDrag() {},
    stopTaskbarLyricsPointerPoller() {},
    taskbarLyricsStateWithProtectedPosition: payload => ({ ...ctx.desktopLyricsState, ...(payload || {}) }),
    broadcastDesktopLyricsEnabledState: value => events.push(value),
    stopDesktopLyricsMousePoller() {}, stopTaskbarLyricsWatcher() {}, stopTaskbarLyricsTopmostGuard() {}, sendDesktopLyricsState() {},
  });
  vm.runInContext(text.slice(text.indexOf('function closeDesktopLyricsWindow('), text.indexOf('function nativeWindowHandleDecimal(')), ctx);
  vm.runInContext(text.slice(text.indexOf("ipcMain.handle('mineradio-desktop-lyrics-set-enabled'"), text.indexOf("ipcMain.handle('mineradio-desktop-lyrics-set-dragging'")), ctx);
  return { ctx, events, created, handlers };
}

test('late lyrics frames do not reopen a user-disabled overlay', async () => {
  const { ctx, handlers, created, events } = harness();
  const set = handlers.get('mineradio-desktop-lyrics-set-enabled');
  const update = handlers.get('mineradio-desktop-lyrics-update');
  await set('main', true, { text: 'A' });
  await set('overlay', false, {});
  await update('main', { enabled: true, text: 'stale frame' });
  assert.equal(ctx.desktopLyricsRequestedEnabled, false);
  assert.equal(ctx.desktopLyricsState.enabled, false);
  assert.equal(created.length, 1);
  assert.deepEqual(events, [true, false]);
  assert.equal((await set('untrusted', true, {})).ok, false);
});

test('runtime teardown preserves enabled preference and later frames can restore the window', async () => {
  const { ctx, handlers, created, events } = harness();
  await handlers.get('mineradio-desktop-lyrics-set-enabled')('main', true, {});
  ctx.closeDesktopLyricsWindow({ preservePreference: true });
  assert.equal(ctx.desktopLyricsRequestedEnabled, true);
  assert.deepEqual(events, [true]);
  await handlers.get('mineradio-desktop-lyrics-update')('main', { text: 'restored' });
  assert.equal(created.length, 2);
  ctx.appQuitting = true;
  ctx.closeDesktopLyricsWindow({ preservePreference: true });
  await handlers.get('mineradio-desktop-lyrics-update')('main', { enabled: true });
  assert.equal(created.length, 2);
  assert.deepEqual(events, [true]);
});
