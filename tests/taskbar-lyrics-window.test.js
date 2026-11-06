'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const layout = require('../desktop/taskbar-lyrics-layout');
const { TaskbarLyricsRuntime } = require('../desktop/taskbar-lyrics-runtime');
const source = fs.readFileSync(path.join(__dirname, '../desktop/main.js'), 'utf8');

const primary = { id: 101, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const secondary = { id: 202, scaleFactor: 1, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } };
function bar(display, handle) {
  return { monitorX: display.bounds.x, monitorY: display.bounds.y, monitorWidth: 1920, monitorHeight: 1080,
    x: display.bounds.x, y: 1040, width: 1920, height: 40, handle, pid: 42, visible: true };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

class FakeWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.bounds = { x: 0, y: 0, width: options.width || 920, height: options.height || 190 };
    this.destroyed = false; this.visible = false; this.sent = [];
    this.webContents = new EventEmitter();
    this.webContents.send = (channel, payload) => this.sent.push({ channel, payload: structuredClone(payload) });
    this.webContents.setFrameRate = () => {};
    this.webContents.setZoomFactor = () => {};
    this.webContents.startPainting = () => {};
    this.webContents.invalidate = () => {};
    this.webContents.getURL = () => 'http://127.0.0.1:1234/desktop-lyrics.html';
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  getBounds() { return { ...this.bounds }; }
  setBounds(value) { this.bounds = { ...value }; this.emit('moved'); }
  setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} setOpacity() {} setIgnoreMouseEvents() {}
  loadURL() { return Promise.resolve(); }
  showInactive() { this.visible = true; this.emit('show'); }
  hide() { this.visible = false; this.emit('hide'); }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; this.emit('closed'); }
  close() { this.destroy(); }
}

class FakeHost extends EventEmitter {
  constructor() { super(); this.layouts = []; this.frames = []; this.child = { pid: 700 }; this.stopped = false; }
  start(args) { this.args = args; return true; }
  setLayout(value) { this.layouts.push(structuredClone(value)); return true; }
  sendFrame(value) { this.frames.push(value); return true; }
  stop() { if (this.stopped) return false; this.stopped = true; queueMicrotask(() => this.emit('exit', { intentional: true })); return true; }
}

function harness() {
  const watchers = [], hosts = [], runtimes = [], handlers = new Map(), events = [];
  let displays = [primary, secondary], pendingRead;
  class Runtime extends TaskbarLyricsRuntime {
    constructor(options) { super({ ...options, hostFactory: () => { const host = new FakeHost(); hosts.push(host); return host; } }); runtimes.push(this); }
  }
  const isolated = { protocol: { handle() {} }, fetch() {} };
  const ctx = vm.createContext({
    process: { platform: 'win32', pid: 123 }, console, BrowserWindow: FakeWindow, TaskbarLyricsRuntime: Runtime,
    app: { isPackaged: true }, path, __dirname: path.join(__dirname, '../desktop'),
    session: { fromPartition: () => isolated }, createLocalProtocolHandler: () => () => {}, localServer: null, mainServerPort: 1234,
    screen: {
      getAllDisplays: () => displays, getPrimaryDisplay: () => primary,
      getDisplayMatching: rect => displays.find(d => rect.x >= d.bounds.x && rect.x < d.bounds.x + d.bounds.width) || primary,
      screenToDipRect: (_win, rect) => rect,
    },
    ...layout,
    readWindowsTaskbars: () => new Promise(resolve => { pendingRead = resolve; }),
    watchWindowsTaskbars(callback, options = {}) {
      const watcher = new EventEmitter(); watcher.callback = callback; watcher.options = options;
      watcher.stdin = { destroyed: false, end() { watcher.stopped = true; queueMicrotask(() => watcher.emit('close', 0)); } };
      watcher.kill = () => { watcher.stopped = true; queueMicrotask(() => watcher.emit('close', null)); };
      watchers.push(watcher); return watcher;
    },
    desktopLyricsWindow: null, taskbarLyricsRuntime: null, taskbarLyricsRendererSession: null, taskbarLyricsRuntimeClosing: null,
    taskbarLyricsRecreateAfterClose: false, desktopLyricsState: {}, desktopLyricsRequestedEnabled: true,
    desktopLyricsSkylineCache: null, desktopLyricsCustomFontCache: null, desktopLyricsUserBounds: null, desktopLyricsProgrammaticMove: false,
    desktopLyricsPointerCapture: false, desktopLyricsMouseIgnored: null, desktopLyricsTaskbarDrag: null, desktopLyricsTaskbarDragSession: 0,
    desktopLyricsLastTaskbarLayout: null, desktopLyricsTaskbarPointerPoller: null, desktopLyricsPendingTaskbarPosition: null,
    desktopLyricsTaskbarPositionRevision: 0, desktopLyricsMousePoller: null, desktopLyricsMousePollerBuffer: '', desktopLyricsHotBounds: null,
    desktopLyricsLastMiddleAt: 0, taskbarLyricsPhysicalRects: [], taskbarLyricsSnapshotReady: false, taskbarLyricsSnapshotVersion: 0,
    taskbarLyricsWatcher: null, taskbarLyricsWatcherClosing: null, taskbarLyricsRetryTimer: null, taskbarLyricsGuardState: null,
    taskbarLyricsGuardStatus: null, appQuitting: false, mainRendererOrigin: 'http://127.0.0.1:1234',
    mainWindow: { isDestroyed: () => false, webContents: { send: (channel, value) => events.push({ channel, value: structuredClone(value) }) } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    isTrustedMainWindowIpc: event => event === 'main', ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  });
  const start = source.indexOf('function overlayUrl('), end = source.indexOf('function nativeWindowHandleDecimal(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), ctx);
  ctx.isTrustedDesktopLyricsIpc = event => event === 'main' || event === 'overlay';
  ctx.startDesktopLyricsMousePoller = () => {}; ctx.stopDesktopLyricsMousePoller = () => {};
  const ipcStart = source.indexOf("ipcMain.handle('mineradio-desktop-lyrics-set-dragging'");
  const ipcEnd = source.indexOf("ipcMain.handle('mineradio-wallpaper-set-enabled'", ipcStart);
  assert.ok(ipcStart >= 0 && ipcEnd > ipcStart); vm.runInContext(source.slice(ipcStart, ipcEnd), ctx);
  return { ctx, watchers, hosts, runtimes, handlers, events, setDisplays: value => { displays = value; }, finishRead: value => pendingRead(value) };
}

test('switching modes preserves desktop position and starts only the native taskbar host', async () => {
  const h = harness(), desktop = h.ctx.createDesktopLyricsWindow({ taskbarMode: false, clickThrough: false });
  desktop.emit('ready-to-show'); h.ctx.desktopLyricsProgrammaticMove = false;
  desktop.setBounds({ x: 100, y: 200, width: 920, height: 340 });
  const overlay = h.ctx.createDesktopLyricsWindow({ taskbarMode: true, taskbarDisplayId: '101', taskbarPosition: 0.5 });
  assert.equal(desktop.destroyed, true); assert.equal(overlay, h.runtimes[0].window);
  assert.deepEqual(h.watchers[0].options, {}, 'snapshot watcher never installs the obsolete popup guard');
  h.watchers[0].callback([bar(primary, '555')]);
  assert.equal(h.hosts.length, 1); assert.equal(h.hosts[0].args.handle, '555');
  assert.equal(h.runtimes[0].layout.physical.x, 660);
  h.ctx.createDesktopLyricsWindow({ taskbarMode: false }); await tick(); await tick();
  assert.equal(h.hosts[0].stopped, true); assert.equal(h.runtimes[0].closed, true);
  const restored = h.ctx.desktopLyricsWindow;
  assert.ok(restored && restored !== desktop); assert.deepEqual(restored.getBounds(), { x: 100, y: 200, width: 920, height: 340 });
  h.ctx.closeDesktopLyricsWindow();
});

test('same-screen snapshot loss preserves the host; switching to a missing taskbar stops the old host', async () => {
  const h = harness(); h.ctx.createDesktopLyricsWindow({ taskbarMode: true, taskbarDisplayId: '202', taskbarPosition: 0.5 });
  h.watchers[0].callback([bar(primary, '555'), bar(secondary, '777')]);
  const runtime = h.runtimes[0], first = h.hosts[0], original = runtime.layout.physical.x;
  assert.equal(runtime.layout.displayId, '202');
  h.watchers[0].callback([bar(primary, '555')]);
  assert.equal(runtime.layout.physical.x, original); assert.equal(first.stopped, false);
  h.ctx.createDesktopLyricsWindow({ taskbarDisplayId: '101' }); await tick(); await tick();
  assert.equal(first.stopped, true); assert.equal(runtime.layout.displayId, '101');
  h.watchers[0].callback([bar(primary, '555')]);
  h.ctx.createDesktopLyricsWindow({ taskbarDisplayId: '202' });
  assert.equal(runtime.layout, null, 'a missing newly selected taskbar must not leave lyrics on the previous screen');
  await tick(); h.watchers[0].callback([bar(primary, '555'), bar(secondary, '777')]); await tick();
  assert.equal(runtime.layout.displayId, '202');
  h.setDisplays([primary]); h.watchers[0].callback([bar(primary, '555')]);
  assert.equal(runtime.layout.displayId, '101', 'unplugging a display falls back to the primary');
  h.ctx.closeDesktopLyricsWindow();
});

test('native drag position is persisted and protected from stale frames until acknowledgement', async () => {
  const h = harness(); h.ctx.createDesktopLyricsWindow({ taskbarMode: true, taskbarDisplayId: '101', taskbarPosition: 0.5 });
  h.watchers[0].callback([bar(primary, '555')]);
  const runtime = h.runtimes[0], host = h.hosts[0]; host.emit('ready', { hwnd: '123', parent: '555' });
  host.emit('drag-end', { x: 880, generation: runtime.generation });
  const change = h.events.find(item => item.channel === 'mineradio-desktop-lyrics-taskbar-position-changed').value;
  assert.equal(change.position, 2 / 3); assert.equal(change.displayId, '101');
  h.ctx.createDesktopLyricsWindow({ taskbarPosition: 0.5 });
  assert.equal(h.ctx.desktopLyricsState.taskbarPosition, 2 / 3);
  assert.equal((await h.handlers.get('mineradio-desktop-lyrics-ack-taskbar-position')('main', change.revision)).ok, true);
  h.ctx.createDesktopLyricsWindow({ taskbarPosition: 0.8 }); assert.equal(h.ctx.desktopLyricsState.taskbarPosition, 0.8);
  h.ctx.closeDesktopLyricsWindow();
});

test('late snapshots and intentional close cannot resurrect the taskbar host', async () => {
  const h = harness(); h.ctx.createDesktopLyricsWindow({ taskbarMode: true, taskbarDisplayId: '101' });
  const watcher = h.watchers[0]; watcher.callback([bar(primary, '555')]);
  const pending = h.ctx.refreshTaskbarLyricsSnapshot();
  h.ctx.closeDesktopLyricsWindow(); watcher.callback([bar(primary, '555')]); h.finishRead([bar(primary, '555')]);
  await pending; await tick(); await tick();
  assert.equal(h.ctx.desktopLyricsRequestedEnabled, false); assert.equal(h.ctx.taskbarLyricsRuntime, null);
  assert.equal(h.hosts.length, 1); assert.equal(h.hosts[0].stopped, true);
});

test('an offscreen renderer crash rebuilds one runtime without disabling the user preference', async () => {
  const h = harness(); h.ctx.createDesktopLyricsWindow({ taskbarMode: true, taskbarDisplayId: '101' });
  h.watchers[0].callback([bar(primary, '555')]);
  const original = h.runtimes[0];
  original.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await tick(); await tick();
  assert.equal(original.closed, true); assert.equal(h.hosts[0].stopped, true);
  assert.equal(h.ctx.desktopLyricsRequestedEnabled, true);
  assert.equal(h.runtimes.length, 2); assert.equal(h.ctx.taskbarLyricsRuntime, h.runtimes[1]);
  assert.equal(h.events.some(item => item.channel === 'mineradio-desktop-lyrics-enabled-state' && item.value.enabled === false), false);
  h.ctx.closeDesktopLyricsWindow(); await tick();
  assert.equal(h.runtimes.length, 2);
});

test('offscreen renderer reload receives cached Skyline and custom font assets', () => {
  const h = harness(); const lines = [{ t: 0, text: 'Line', words: [{ text: 'Line', t: 0, d: 1 }] }];
  h.ctx.createDesktopLyricsWindow({ taskbarMode: true, skyline: true, skylineKey: 'A', skylineLines: lines,
    customFont: { id: 'font-A', dataUrl: 'data:font/woff2;base64,AA==' } });
  h.ctx.createDesktopLyricsWindow({ skylineLines: null, customFont: { id: 'font-A' } });
  const runtime = h.runtimes[0]; runtime.window.webContents.emit('did-finish-load');
  let frame = runtime.window.sent.filter(item => item.channel === 'mineradio-desktop-lyrics-state').at(-1).payload;
  assert.deepEqual(frame.skylineLines, lines); assert.equal(frame.customFont.dataUrl, 'data:font/woff2;base64,AA==');
  h.ctx.createDesktopLyricsWindow({ skylineKey: 'B', skylineLines: null, customFont: { id: 'font-B' } });
  h.ctx.sendDesktopLyricsState(true);
  frame = runtime.window.sent.filter(item => item.channel === 'mineradio-desktop-lyrics-state').at(-1).payload;
  assert.equal(frame.skylineLines, null); assert.equal(frame.customFont.dataUrl, undefined);
  h.ctx.closeDesktopLyricsWindow();
});

test('hot regions use the current renderer generation and accept null through IPC', async () => {
  const h = harness(); h.ctx.createDesktopLyricsWindow({ taskbarMode: true, taskbarDisplayId: '101' });
  h.watchers[0].callback([bar(primary, '555')]);
  const runtime = h.runtimes[0], set = h.handlers.get('mineradio-desktop-lyrics-set-hot-bounds');
  const bounds = { left: 4, top: 5, right: 100, bottom: 30, viewportWidth: 600, viewportHeight: 40 };
  assert.equal((await set('overlay', bounds, runtime.generation - 1)).ok, false);
  assert.equal((await set('overlay', bounds, runtime.generation)).ok, true);
  assert.equal((await set('overlay', null, runtime.generation)).ok, true); assert.equal(runtime.hot, null);
  h.ctx.closeDesktopLyricsWindow();
});

test('asar builds launch the explicitly unpacked taskbar helper', () => {
  const h = harness();
  h.ctx.process.resourcesPath = 'C:\\Mineradio\\resources';
  h.ctx.fs = { existsSync: file => file.endsWith(path.join('app.asar.unpacked', 'build', 'taskbar-lyrics-host.exe')) };
  h.ctx.createDesktopLyricsWindow({ taskbarMode: true, taskbarDisplayId: '101' });
  assert.equal(h.runtimes[0].executable, path.join('C:\\Mineradio\\resources', 'app.asar.unpacked', 'build', 'taskbar-lyrics-host.exe'));
  h.ctx.closeDesktopLyricsWindow();
});

test('native physical rectangles convert to DIP on a negative-coordinate scaled display', () => {
  const h = harness();
  const display = { id: 202, scaleFactor: 1.5, bounds: { x: -1280, y: -100, width: 1280, height: 1024 } };
  h.ctx.screen.screenToDipRect = () => display.bounds; h.ctx.screen.getDisplayMatching = () => display;
  h.ctx.taskbarLyricsPhysicalRects = [{ monitorX: -1920, monitorY: -150, monitorWidth: 1920, monitorHeight: 1536,
    x: -1920, y: 1326, width: 1920, height: 60, handle: '777', pid: 42 }];
  const result = h.ctx.taskbarLyricsDipRects(); assert.equal(result.length, 1); assert.equal(result[0].displayId, '202');
  assert.deepEqual(JSON.parse(JSON.stringify(result[0].bounds)), { x: -1280, y: 884, width: 1280, height: 40 });
  h.ctx.screen.getDisplayMatching = () => primary; assert.equal(h.ctx.taskbarLyricsDipRects().length, 0);
});

test('production and beta packages include the native taskbar host and its build hook', async () => {
  const { getConfig } = require('app-builder-lib/out/util/config/config');
  const minimatch = require('minimatch'), matches = minimatch.minimatch || minimatch;
  const root = path.resolve(__dirname, '..');
  for (const filename of ['package.json', 'electron-builder.internal-beta.json']) {
    const config = await getConfig(root, filename === 'package.json' ? null : path.join(root, filename), null);
    const patterns = config.files.flatMap(entry => typeof entry === 'string' ? [entry] : entry.filter || []);
    for (const file of ['desktop/taskbar-lyrics-layout.js', 'desktop/taskbar-lyrics-windows.js', 'desktop/taskbar-lyrics-runtime.js', 'desktop/taskbar-lyrics-host.js', 'build/taskbar-lyrics-host.exe']) {
      assert.ok(patterns.some(pattern => !pattern.startsWith('!') && matches(file, pattern)), `${filename} does not include ${file}`);
      assert.ok(!patterns.some(pattern => pattern.startsWith('!') && matches(file, pattern.slice(1))), `${filename} excludes ${file}`);
    }
    assert.equal(config.beforePack, 'scripts/build-taskbar-lyrics-host.js');
    if (config.asar) assert.ok(config.asarUnpack.includes('build/taskbar-lyrics-host.exe'), `${filename} must unpack the native host`);
  }
});
