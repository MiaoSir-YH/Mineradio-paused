'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { TaskbarLyricsRuntime } = require('../desktop/taskbar-lyrics-runtime');

class FakeContents extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
    this.frameRates = [];
    this.zoom = [];
    this.invalidations = 0;
  }
  send(channel, payload) { this.messages.push({ channel, payload }); }
  setFrameRate(value) { this.frameRates.push(value); }
  setZoomFactor(value) { this.zoom.push(value); }
  startPainting() {}
  invalidate() { this.invalidations++; }
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeContents();
    this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
    this.destroyed = false;
  }
  loadURL(url) { this.url = url; return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  getBounds() { return { ...this.bounds }; }
  setBounds(bounds) { this.bounds = { ...bounds }; }
  destroy() { this.destroyed = true; this.emit('closed'); }
}

class FakeHost extends EventEmitter {
  constructor() { super(); this.layouts = []; this.frames = []; this.stopped = false; }
  start(args) { this.startArgs = args; return true; }
  setLayout(value) { this.layouts.push(value); return true; }
  sendFrame(value) { this.frames.push(value); return true; }
  stop() { this.stopped = true; return true; }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const layout = (changes = {}) => ({
  handle: '123', pid: 456, displayId: 'screen-1',
  physical: { x: 100, y: 200, width: 1200, height: 96 },
  logical: { width: 600, height: 48 },
  minX: 0, maxX: 1000, scaleFactor: 2,
  ...changes,
});
const bounds = (changes = {}) => ({
  left: 10.25, top: 4.5, right: 100.75, bottom: 30.25,
  viewportWidth: 600, viewportHeight: 48,
  ...changes,
});
function image(width, height, value = 1) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toBitmap: () => Buffer.alloc(width * height * 4, value),
    resize: ({ width: w, height: h }) => image(w, h, value),
  };
}
function fixture() {
  const hosts = [];
  const runtime = new TaskbarLyricsRuntime({
    BrowserWindow: FakeWindow, preload: 'preload', url: 'file:///desktop-lyrics.html',
    executable: 'host.exe', retryMs: 5,
    hostFactory: () => { const host = new FakeHost(); hosts.push(host); return host; },
  });
  runtime.start();
  runtime.window.webContents.emit('did-finish-load');
  return { runtime, hosts, win: runtime.window };
}
async function finish(runtime, host) {
  const closed = runtime.close();
  if (host) host.emit('exit', { code: 0, intentional: true });
  await closed;
}

test('maps current-generation hot bounds using actual frame dimensions and rejects old bounds', async () => {
  const { runtime, hosts, win } = fixture();
  runtime.setState({ opacity: 0.92, frameRate: 60 });
  assert.equal(runtime.setLayout(layout()), true);
  const host = hosts[0];
  host.emit('ready', { hwnd: '999' });
  assert.equal(runtime.generation, 1);
  assert.equal(host.layouts.at(-1).threshold, 8);
  assert.deepEqual(host.startArgs, { handle: '123', pid: 456 });
  assert.ok(win.webContents.messages.some(item =>
    item.channel === 'mineradio-desktop-lyrics-state' && item.payload.taskbarLayoutId === 1));
  assert.ok(win.webContents.messages.some(item =>
    item.channel === 'mineradio-desktop-lyrics-request-hot-bounds' && item.payload.layoutId === 1));
  assert.equal(runtime.setHotBounds(bounds(), 0), false);
  assert.equal(runtime.setHotBounds(bounds(), 1), true);
  win.webContents.emit('paint', {}, {}, image(1200, 96));
  assert.deepEqual(host.frames.at(-1).hot, { left: 20, top: 9, right: 202, bottom: 61 });
  assert.equal(host.frames.at(-1).generation, 1);
  assert.equal(host.frames.at(-1).opacity, 235);
  const oversized = image(2400, 192, 7);
  let resizeOptions;
  oversized.resize = options => { resizeOptions = options; return image(options.width, options.height, 7); };
  win.webContents.emit('paint', {}, {}, oversized);
  assert.deepEqual(resizeOptions, { width: 1200, height: 96, quality: 'better' });
  assert.equal(host.frames.at(-1).pixels.length, 1200 * 96 * 4);
  assert.deepEqual(host.frames.at(-1).hot, { left: 20, top: 9, right: 202, bottom: 61 });
  assert.equal(runtime.setLayout(layout({ physical: { x: 130, y: 200, width: 1200, height: 96 } })), true);
  assert.equal(runtime.generation, 1, 'horizontal movement keeps the layout generation');
  assert.equal(runtime.setLayout(layout({
    physical: { x: 130, y: 200, width: 900, height: 72 }, scaleFactor: 1.5,
  })), true);
  assert.equal(runtime.generation, 2);
  assert.equal(runtime.setHotBounds(bounds(), 1), false);
  assert.equal(runtime.hot, null);
  assert.equal(runtime.lastFrame, null);
  await finish(runtime, host);
});

test('opacity and null or invalid hot bounds resend the last static frame immediately', async () => {
  const { runtime, hosts, win } = fixture();
  runtime.setState({ opacity: 1, frameRate: 60 });
  runtime.setLayout(layout());
  const host = hosts[0]; host.emit('ready');
  runtime.setHotBounds(bounds(), 1);
  win.webContents.emit('paint', {}, {}, image(1200, 96));
  let count = host.frames.length;
  runtime.setState({ opacity: 0.4, frameRate: 30 });
  assert.equal(host.frames.length, ++count);
  assert.equal(host.frames.at(-1).opacity, 102);
  assert.equal(win.webContents.frameRates.at(-1), 30);
  assert.equal(runtime.setHotBounds(null, 1), true);
  assert.equal(host.frames.length, ++count);
  assert.equal(host.frames.at(-1).hot, null);
  assert.equal(runtime.setHotBounds(bounds({ viewportWidth: 900 }), 1), false);
  assert.equal(host.frames.length, ++count);
  assert.equal(host.frames.at(-1).hot, null);
  await finish(runtime, host);
});

test('retries a failed host with a new generation and waits for fresh bounds and frames', async () => {
  const { runtime, hosts, win } = fixture();
  runtime.setState({ opacity: 0.8 });
  runtime.setLayout(layout());
  const first = hosts[0]; first.emit('ready');
  runtime.setHotBounds(bounds(), 1);
  win.webContents.emit('paint', {}, {}, image(1200, 96, 23));
  const oldGeneration = runtime.generation;
  first.emit('exit', { code: 1, intentional: false });
  await delay(20);
  assert.equal(hosts.length, 2);
  const replacement = hosts[1]; replacement.emit('ready');
  assert.ok(runtime.generation > oldGeneration, 'a rebuilt host needs a new generation');
  assert.equal(replacement.layouts.at(-1).generation, runtime.generation);
  assert.equal(replacement.frames.length, 0, 'old frames must not be sent to the replacement');
  assert.equal(runtime.setHotBounds(bounds(), oldGeneration), false);
  assert.equal(runtime.setHotBounds(bounds(), runtime.generation), true);
  win.webContents.emit('paint', {}, {}, image(1200, 96, 42));
  assert.equal(replacement.frames.at(-1).pixels[0], 42);
  await finish(runtime, replacement);
});

test('switches taskbar parents without reviving the old host or accepting old drag events', async () => {
  const { runtime, hosts } = fixture();
  const drags = []; runtime.on('drag-end', value => drags.push(value));
  runtime.setLayout(layout());
  const first = hosts[0]; first.emit('ready');
  first.emit('drag-end', { x: 130, generation: 1 });
  runtime.setLayout(layout({ handle: '789', pid: 654, displayId: 'screen-2' }));
  assert.equal(runtime.generation, 2);
  assert.equal(first.stopped, true);
  first.emit('drag-end', { x: 140, generation: 1 });
  first.emit('exit', { code: 0, intentional: true });
  await delay(20);
  assert.equal(hosts.length, 2);
  const replacement = hosts[1]; replacement.emit('ready');
  assert.deepEqual(replacement.startArgs, { handle: '789', pid: 654 });
  assert.equal(runtime.setHotBounds(bounds(), 1), false);
  replacement.emit('drag-end', { x: 150, generation: 1 });
  replacement.emit('drag-end', { x: 160, generation: 2 });
  assert.deepEqual(drags, [{ x: 130, generation: 1 }, { x: 160, generation: 2 }]);
  await finish(runtime, replacement);
});

test('renderer failure followed by close waits for host exit and prevents retries', async () => {
  const { runtime, hosts, win } = fixture();
  runtime.setLayout(layout());
  const host = hosts[0]; host.emit('ready');
  let gone = 0, closePromise;
  runtime.on('renderer-gone', () => { gone++; closePromise = runtime.close(); });
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(gone, 1);
  assert.equal(host.stopped, true);
  assert.equal(win.destroyed, true);
  let resolved = false;
  closePromise.then(() => { resolved = true; });
  await delay(10);
  assert.equal(resolved, false, 'close waits for host exit');
  host.emit('exit', { code: 0, intentional: true });
  await closePromise;
  assert.equal(resolved, true);
  await delay(20);
  runtime.start();
  assert.equal(hosts.length, 1);
  assert.equal(runtime.window, null);
});
