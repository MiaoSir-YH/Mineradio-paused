'use strict';

const { EventEmitter } = require('node:events');
const { TaskbarLyricsHost } = require('./taskbar-lyrics-host');

// The renderer stays offscreen; a separate STA owns the taskbar child window.
class TaskbarLyricsRuntime extends EventEmitter {
  constructor({ BrowserWindow, preload, url, executable, session, hostFactory, retryMs = 1500 }) {
    super();
    this.BrowserWindow = BrowserWindow;
    this.preload = preload;
    this.url = url;
    this.executable = executable;
    this.session = session;
    this.hostFactory = hostFactory || (() => new TaskbarLyricsHost({ executable: this.executable }));
    this.retryMs = retryMs;
    this.window = null;
    this.host = null;
    this.layout = null;
    this.state = {};
    this.hot = null;
    this.lastFrame = null;
    this.generation = 0;
    this.loaded = false;
    this.closed = false;
    this.retryTimer = null;
    this.currentFps = 0;
    this.closePromise = null;
  }

  start() {
    if (this.closed || this.window) return;
    const win = new this.BrowserWindow({
      width: 600, height: 48, frame: false, transparent: true, backgroundColor: '#00000000',
      hasShadow: false, resizable: false, focusable: false, skipTaskbar: true, show: false,
      webPreferences: {
        preload: this.preload, contextIsolation: true, nodeIntegration: false, sandbox: false,
        backgroundThrottling: false, offscreen: { useSharedTexture: false }, session: this.session,
      },
    });
    this.window = win;
    win.webContents.on('paint', (_event, _dirty, image) => this.onPaint(win, image));
    win.webContents.on('did-finish-load', () => {
      if (this.closed || this.window !== win) return;
      this.loaded = true;
      this.applyViewport();
      this.sendState();
      this.requestHotBounds();
      this.emit('renderer-ready');
      if (typeof win.webContents.startPainting === 'function') win.webContents.startPainting();
      if (typeof win.webContents.invalidate === 'function') win.webContents.invalidate();
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      if (!this.closed && this.window === win) this.emit('renderer-gone', details || {});
    });
    win.on('closed', () => {
      if (this.window !== win) return;
      this.window = null;
      if (!this.closed) this.emit('renderer-gone', { reason: 'window-closed' });
    });
    win.loadURL(this.url).catch(error => {
      if (!this.closed) this.emit('runtime-error', error);
    });
  }

  setState(payload) {
    const oldOpacity = this.state.opacity;
    this.state = payload || {};
    if (this.window && !this.window.isDestroyed()) {
      const requested = Number(this.state.frameRate);
      const fps = Number.isFinite(requested) && requested > 0 ? Math.max(1, Math.min(240, Math.round(requested))) : 60;
      if (fps !== this.currentFps && typeof this.window.webContents.setFrameRate === 'function') {
        this.window.webContents.setFrameRate(fps);
        this.currentFps = fps;
      }
    }
    this.sendState();
    if (oldOpacity !== this.state.opacity) this.sendLastFrame();
  }

  sendState() {
    if (!this.loaded || !this.window || this.window.isDestroyed()) return;
    this.window.webContents.send('mineradio-desktop-lyrics-state', { ...this.state, taskbarLayoutId: this.generation });
  }

  requestHotBounds() {
    if (!this.loaded || !this.window || this.window.isDestroyed()) return;
    this.window.webContents.send('mineradio-desktop-lyrics-request-hot-bounds', { layoutId: this.generation });
  }

  suspend() {
    if (this.closed || !this.layout) return;
    this.layout = null;
    this.generation += 1;
    this.hot = null;
    this.lastFrame = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopHost();
    this.sendState();
  }

  setLayout(next) {
    if (this.closed || !next || !next.handle || !next.pid || !next.physical || !next.logical) return false;
    const old = this.layout;
    const parentChanged = !old || old.handle !== next.handle || old.pid !== next.pid;
    const viewportChanged = !old || parentChanged || old.displayId !== next.displayId || old.physical.width !== next.physical.width
      || old.physical.height !== next.physical.height || old.logical.width !== next.logical.width
      || old.logical.height !== next.logical.height || old.scaleFactor !== next.scaleFactor;
    const moved = !old || old.physical.x !== next.physical.x || old.physical.y !== next.physical.y
      || old.minX !== next.minX || old.maxX !== next.maxX;
    this.layout = next;
    if (viewportChanged) {
      this.generation += 1;
      this.hot = null;
      this.lastFrame = null;
      this.applyViewport();
      this.sendState();
      this.requestHotBounds();
      if (this.loaded && this.window && !this.window.isDestroyed() && typeof this.window.webContents.invalidate === 'function') {
        this.window.webContents.invalidate();
      }
    }
    if (parentChanged && this.host) { this.stopHost(); return true; }
    if (!this.host) this.startHost();
    if (this.host && (viewportChanged || moved)) this.sendLayout();
    return true;
  }

  applyViewport() {
    if (!this.layout || !this.window || this.window.isDestroyed()) return;
    const { physical, scaleFactor } = this.layout;
    const current = this.window.getBounds();
    if (current.width !== physical.width || current.height !== physical.height) {
      this.window.setBounds({ ...current, width: physical.width, height: physical.height }, false);
    }
    if (this.loaded && typeof this.window.webContents.setZoomFactor === 'function') {
      this.window.webContents.setZoomFactor(scaleFactor);
    }
  }

  startHost() {
    if (this.closed || this.host || !this.layout) return;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const host = this.hostFactory();
    this.host = host;
    host.on('ready', () => {
      if (this.closed || this.host !== host) return;
      this.sendLayout();
      this.requestHotBounds();
      this.sendLastFrame();
      if (this.loaded && this.window && !this.window.isDestroyed() && typeof this.window.webContents.invalidate === 'function') {
        this.window.webContents.invalidate();
      }
      this.emit('host-ready');
    });
    host.on('drag-end', event => {
      if (!this.closed && this.host === host && event && event.generation === this.generation) this.emit('drag-end', event);
    });
    host.on('host-error', error => { if (!this.closed && this.host === host) this.emit('runtime-error', error); });
    host.on('exit', info => {
      if (this.host !== host) return;
      this.host = null;
      if (!this.closed && this.layout) {
        if (!info || !info.intentional) {
          this.generation += 1;
          this.hot = null;
          this.lastFrame = null;
          this.sendState();
          this.requestHotBounds();
          if (this.loaded && this.window && !this.window.isDestroyed() && typeof this.window.webContents.invalidate === 'function') {
            this.window.webContents.invalidate();
          }
        }
        this.retryTimer = setTimeout(() => { this.retryTimer = null; this.startHost(); }, info && info.intentional ? 0 : this.retryMs);
        if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
      }
    });
    if (!host.start({ handle: this.layout.handle, pid: this.layout.pid })) {
      this.host = null;
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.startHost(); }, this.retryMs);
      if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
    }
  }

  stopHost() {
    if (this.host) this.host.stop();
  }

  sendLayout() {
    if (!this.host || !this.layout) return;
    const { physical, minX, maxX } = this.layout;
    this.host.setLayout({ x: physical.x, y: physical.y, width: physical.width, height: physical.height, minX, maxX,
      generation: this.generation, threshold: Math.max(1, Math.min(64, Math.ceil(4 * this.layout.scaleFactor))) });
  }

  setHotBounds(bounds, generation) {
    if (this.closed || Number(generation) !== this.generation || !this.layout) return false;
    if (bounds == null) {
      this.hot = null;
      this.sendLastFrame();
      return true;
    }
    const values = ['left', 'top', 'right', 'bottom', 'viewportWidth', 'viewportHeight'].map(key => Number(bounds[key]));
    if (!values.every(Number.isFinite) || values[2] <= values[0] || values[3] <= values[1]
        || values[4] <= 0 || values[5] <= 0
        || Math.abs(values[4] - this.layout.logical.width) > 2 || Math.abs(values[5] - this.layout.logical.height) > 2) {
      this.hot = null;
      this.sendLastFrame();
      return false;
    }
    this.hot = { left: values[0], top: values[1], right: values[2], bottom: values[3], viewportWidth: values[4], viewportHeight: values[5] };
    this.sendLastFrame();
    return true;
  }

  onPaint(win, image) {
    if (this.closed || this.window !== win || !this.layout || !image || image.isEmpty()) return;
    const size = image.getSize();
    const expected = this.layout.physical;
    if (!size.width || !size.height) return;
    const output = size.width === expected.width && size.height === expected.height
      ? image : image.resize({ width: expected.width, height: expected.height, quality: 'better' });
    const pixels = output.toBitmap();
    if (!Buffer.isBuffer(pixels) || pixels.length !== expected.width * expected.height * 4) return;
    this.lastFrame = { pixels, width: expected.width, height: expected.height, generation: this.generation };
    this.sendLastFrame();
  }

  sendLastFrame() {
    if (!this.host || !this.lastFrame || !this.layout || this.lastFrame.generation !== this.generation) return;
    const frame = this.lastFrame;
    const hot = this.hot && {
      left: Math.floor(this.hot.left * frame.width / this.hot.viewportWidth),
      top: Math.floor(this.hot.top * frame.height / this.hot.viewportHeight),
      right: Math.ceil(this.hot.right * frame.width / this.hot.viewportWidth),
      bottom: Math.ceil(this.hot.bottom * frame.height / this.hot.viewportHeight),
    };
    const value = Number(this.state.opacity);
    const opacity = Math.round((Number.isFinite(value) ? Math.max(0.28, Math.min(1, value)) : 0.92) * 255);
    this.host.sendFrame({ ...frame, hot, opacity });
  }

  close() {
    if (this.closed) return this.closePromise || Promise.resolve();
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const host = this.host;
    this.closePromise = host ? new Promise(resolve => {
      const timeout = setTimeout(resolve, 2000);
      if (typeof timeout.unref === 'function') timeout.unref();
      host.once('exit', () => { clearTimeout(timeout); resolve(); });
      host.stop();
    }) : Promise.resolve();
    this.host = null;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.lastFrame = null;
    this.hot = null;
    return this.closePromise;
  }
}

module.exports = { TaskbarLyricsRuntime };
