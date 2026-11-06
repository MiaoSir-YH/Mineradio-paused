'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

const MAGIC = 0x31524c4d;
const FRAME = 1;
const LAYOUT = 2;
const HEADER_BYTES = 48;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_LINE_BYTES = 16 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const STOP_TIMEOUT_MS = 1500;
const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

function isInt32(value) {
  return Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX;
}

function validDimensions(width, height) {
  return isInt32(width) && isInt32(height) && width > 0 && height > 0
    && width * height * 4 <= MAX_FRAME_BYTES;
}

function decimalHandle(value) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null;
  if (!['number', 'bigint', 'string'].includes(typeof value)) return null;
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text)) return null;
  try {
    const handle = BigInt(text);
    return handle <= 0x7fffffffffffffffn ? handle.toString() : null;
  } catch (_) {
    return null;
  }
}

function decimalPid(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text)) return null;
  const pid = Number(text);
  return Number.isSafeInteger(pid) && pid <= 0xffffffff ? String(pid) : null;
}

function packet(type, sequence, fields, pixels) {
  const length = pixels ? pixels.length : 0;
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(type, 4);
  header.writeInt32LE(sequence, 8);
  header.writeInt32LE(length, 12);
  fields.forEach((value, index) => header.writeInt32LE(value, 16 + index * 4));
  return pixels ? Buffer.concat([header, pixels], HEADER_BYTES + length) : header;
}

/**
 * Owns one taskbar child-host process. Frame pixels remain caller-owned until
 * sent; callers should pass a fresh, immutable BGRA buffer for each frame.
 */
class TaskbarLyricsHost extends EventEmitter {
  constructor({ executable, spawnImpl = spawn } = {}) {
    super();
    if (typeof executable !== 'string' || !executable.trim()) throw new TypeError('executable is required');
    if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl must be a function');
    this.executable = executable;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.ready = false;
    this.stopping = false;
    this.intentional = false;
    this.layout = null;
    this.pendingLayout = null;
    this.pendingFrame = null;
    this.writing = false;
    this.backpressured = false;
    this.sequence = 0;
    this.stdoutParts = [];
    this.stdoutBytes = 0;
    this.stderr = '';
    this.closedMessage = null;
    this.stopTimer = null;
  }

  start({ handle, pid } = {}) {
    if (this.child) return false;
    const handleText = decimalHandle(handle);
    const pidText = decimalPid(pid);
    if (!handleText || !pidText) {
      this.emit('host-error', { error: 'INVALID_TASKBAR_ARGUMENTS' });
      return false;
    }
    let child;
    try {
      child = this.spawnImpl(this.executable, [handleText, pidText], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (!child || !child.stdin || !child.stdout || !child.stderr) throw new Error('Host process has no pipes');
    } catch (error) {
      this.emit('host-error', { error: 'SPAWN_FAILED', message: String(error && error.message || error) });
      if (child && typeof child.kill === 'function') {
        try { child.kill(); } catch (_) {}
      }
      return false;
    }
    this.child = child;
    this.ready = false;
    this.stopping = false;
    this.intentional = false;
    this.layout = null;
    this.pendingLayout = null;
    this.pendingFrame = null;
    this.writing = false;
    this.backpressured = false;
    this.sequence = 0;
    this.stdoutParts = [];
    this.stdoutBytes = 0;
    this.stderr = '';
    this.closedMessage = null;

    child.stdout.on('data', chunk => {
      if (this.child === child) this._consumeStdout(chunk);
    });
    child.stdout.on('error', error => {
      if (this.child !== child || this.stopping) return;
      this.emit('host-error', { error: 'OUTPUT_FAILED', message: String(error && error.message || error) });
      this._shutdown(false);
    });
    child.stderr.on('data', chunk => {
      if (this.child !== child) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const tail = bytes.subarray(Math.max(0, bytes.length - MAX_STDERR_BYTES)).toString('utf8');
      this.stderr = (this.stderr + tail).slice(-MAX_STDERR_BYTES);
    });
    child.stderr.on('error', error => {
      if (this.child !== child || this.stopping) return;
      this.emit('host-error', { error: 'STDERR_FAILED', message: String(error && error.message || error) });
    });
    child.stdin.on('drain', () => {
      if (this.child !== child) return;
      this.backpressured = false;
      this._pump();
    });
    child.stdin.on('error', error => {
      if (this.child !== child || this.stopping) return;
      this.emit('host-error', { error: 'INPUT_FAILED', message: String(error && error.message || error) });
      this._shutdown(false);
    });
    child.on('error', error => {
      if (this.child !== child) return;
      this.emit('host-error', { error: 'PROCESS_FAILED', message: String(error && error.message || error) });
    });
    child.on('close', (code, signal) => this._closed(child, code, signal));
    return true;
  }

  setLayout({ x, y, width, height, minX, maxX, generation, threshold = 4 } = {}) {
    if (!this.child || this.stopping || !validDimensions(width, height)
        || ![x, y, minX, maxX, generation, threshold].every(isInt32)
        || threshold < 1 || threshold > 64
        || generation <= 0 || maxX < minX || x < minX || x > maxX) return false;
    if (this.layout && (generation < this.layout.generation
        || (generation === this.layout.generation
          && (width !== this.layout.width || height !== this.layout.height)))) return false;
    const next = { x, y, width, height, minX, maxX, generation, threshold };
    this.layout = next;
    this.pendingLayout = next;
    if (this.pendingFrame && this.pendingFrame.generation !== generation) this.pendingFrame = null;
    this._pump();
    return true;
  }

  sendFrame({ pixels, width, height, hot, opacity, generation } = {}) {
    if (!this.child || this.stopping || !this.layout || !validDimensions(width, height)
        || width !== this.layout.width || height !== this.layout.height
        || generation !== this.layout.generation || !isInt32(opacity) || opacity < 0 || opacity > 255
        || !(pixels instanceof Uint8Array) || pixels.byteLength !== width * height * 4) return false;
    let area = { left: 0, top: 0, right: 0, bottom: 0 };
    if (hot != null) {
      const values = [hot.left, hot.top, hot.right, hot.bottom];
      if (!values.every(isInt32) || hot.right < hot.left || hot.bottom < hot.top) return false;
      area = {
        left: Math.max(0, Math.min(width, hot.left)),
        top: Math.max(0, Math.min(height, hot.top)),
        right: Math.max(0, Math.min(width, hot.right)),
        bottom: Math.max(0, Math.min(height, hot.bottom)),
      };
    }
    const buffer = Buffer.isBuffer(pixels)
      ? pixels
      : Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    this.pendingFrame = { pixels: buffer, width, height, hot: area, opacity, generation };
    this._pump();
    return true;
  }

  stop() {
    if (!this.child || this.stopping) return false;
    this._shutdown(true);
    return true;
  }

  _nextSequence() {
    this.sequence = this.sequence >= INT32_MAX ? 1 : this.sequence + 1;
    return this.sequence;
  }

  _pump() {
    const child = this.child;
    if (!child || !this.ready || this.stopping || this.writing || this.backpressured) return;
    let message;
    if (this.pendingLayout) {
      const layout = this.pendingLayout;
      this.pendingLayout = null;
      message = packet(LAYOUT, this._nextSequence(),
        [layout.x, layout.y, layout.width, layout.height, layout.minX, layout.maxX, layout.generation, layout.threshold]);
    } else if (this.pendingFrame) {
      const frame = this.pendingFrame;
      this.pendingFrame = null;
      if (!this.layout || frame.generation !== this.layout.generation
          || frame.width !== this.layout.width || frame.height !== this.layout.height) return;
      message = packet(FRAME, this._nextSequence(),
        [frame.width, frame.height, frame.hot.left, frame.hot.top, frame.hot.right, frame.hot.bottom,
          frame.opacity, frame.generation], frame.pixels);
    } else {
      return;
    }
    this.writing = true;
    try {
      const accepted = child.stdin.write(message, error => {
        queueMicrotask(() => {
          if (this.child !== child) return;
          this.writing = false;
          if (error && !this.stopping) {
            this.emit('host-error', { error: 'INPUT_FAILED', message: String(error.message || error) });
            this._shutdown(false);
            return;
          }
          this._pump();
        });
      });
      this.backpressured = !accepted;
    } catch (error) {
      this.writing = false;
      if (!this.stopping) {
        this.emit('host-error', { error: 'INPUT_FAILED', message: String(error && error.message || error) });
        this._shutdown(false);
      }
    }
  }

  _consumeStdout(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.length : newline;
      const length = end - offset;
      if (this.stdoutBytes + length > MAX_OUTPUT_LINE_BYTES) {
        this.emit('host-error', { error: 'OUTPUT_LINE_TOO_LONG' });
        this._shutdown(false);
        return;
      }
      if (length) {
        this.stdoutParts.push(bytes.subarray(offset, end));
        this.stdoutBytes += length;
      }
      if (newline < 0) return;
      const line = Buffer.concat(this.stdoutParts, this.stdoutBytes).toString('utf8').trim();
      this.stdoutParts = [];
      this.stdoutBytes = 0;
      offset = newline + 1;
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch (_) {
        this.emit('host-error', { error: 'INVALID_HOST_OUTPUT' });
        this._shutdown(false);
        return;
      }
      if (!event || typeof event !== 'object') {
        this.emit('host-error', { error: 'INVALID_HOST_OUTPUT' });
        this._shutdown(false);
        return;
      }
      if (this.stopping && event.kind !== 'closed') continue;
      if (event.kind === 'ready' && !this.ready) {
        this.ready = true;
        this.emit('ready', event);
        this._pump();
      } else if (event.kind === 'drag-end' && isInt32(event.x)
          && isInt32(event.generation) && event.generation > 0) {
        this.emit('drag-end', { x: event.x, generation: event.generation });
      } else if (event.kind === 'error') {
        this.emit('host-error', { error: String(event.error || 'HOST_ERROR'), code: event.code });
      } else if (event.kind === 'closed') {
        this.closedMessage = event;
      }
    }
  }

  _shutdown(intentional) {
    const child = this.child;
    if (!child || this.stopping) return;
    this.stopping = true;
    this.intentional = !!intentional;
    this.ready = false;
    this.pendingLayout = null;
    this.pendingFrame = null;
    try { child.stdin.end(); } catch (_) {}
    this.stopTimer = setTimeout(() => {
      if (this.child !== child) return;
      try { child.kill(); } catch (_) {}
    }, STOP_TIMEOUT_MS);
    if (typeof this.stopTimer.unref === 'function') this.stopTimer.unref();
  }

  _closed(child, code, signal) {
    if (this.child !== child) return;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    const result = { code, signal, intentional: this.intentional, host: this.closedMessage, stderr: this.stderr };
    this.child = null;
    this.ready = false;
    this.stopping = false;
    this.layout = null;
    this.pendingLayout = null;
    this.pendingFrame = null;
    this.stdoutParts = [];
    this.stdoutBytes = 0;
    this.emit('exit', result);
  }
}

module.exports = { TaskbarLyricsHost };
