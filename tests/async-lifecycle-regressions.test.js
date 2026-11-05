'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '../public/js/modules', file), 'utf8');
const noop = () => {};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('failed dynamic script loads can retry and simultaneous callers share the load', async () => {
  const scripts = [];
  const document = { querySelector: () => scripts.find(sc => !sc.removed) || null,
    createElement: () => ({ remove() { this.removed = true; } }), head: { appendChild(sc) { scripts.push(sc); } } };
  const source = read('09-idle-toast-libraries.js');
  const ctx = vm.createContext({ document, Promise });
  vm.runInContext(source.slice(source.indexOf('var dynamicScriptLoads')), ctx);
  const first = ctx.loadScriptOnce('https://example.invalid/hands.js');
  assert.strictEqual(ctx.loadScriptOnce('https://example.invalid/hands.js'), first);
  scripts[0].onerror(); await assert.rejects(first, /Script load failed/);
  const second = ctx.loadScriptOnce('https://example.invalid/hands.js');
  assert.equal(scripts.length, 2); scripts[1].onload(); await second;
  await ctx.loadScriptOnce('https://example.invalid/hands.js'); assert.equal(scripts.length, 2);
});

test('closing a login modal invalidates an outstanding QR creation response', async () => {
  const qr = deferred(), timers = [], elements = {}; let open = true;
  const element = id => elements[id] ||= { classList: { contains: () => open, toggle: noop }, textContent: '', src: '' };
  const ctx = vm.createContext({ console, Promise, Date, document: { getElementById: element, querySelector: () => ({ classList: { toggle: noop } }) }, window: {},
    loginProvider: 'qishui', qrKey: null, qrPollTimer: null, qishuiQrPollGeneration: 0, qishuiQrPollBusy: false, qishuiOAuthBusy: false,
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; }, setInterval(fn, delay) { timers.push({ fn, delay }); return timers.length; }, clearInterval: noop, clearTimeout: noop,
    apiJson: () => qr.promise, closeGsapModal() { open = false; } });
  vm.runInContext(read('08-account/03-login-modal-flows.js'), ctx); ctx.updateLoginProviderUi = noop;
  const pending = ctx.refreshQr(); ctx.closeLoginModal(); qr.resolve({ token: 'late-token', qrcode: 'data:image/png;base64,AA==' }); await pending;
  assert.equal(open, false); assert.equal(ctx.qrKey, null); assert.equal(ctx.qrPollTimer, null); assert.equal(timers.length, 0);
});

test('an obsolete camera start only disposes resources owned by that start', async () => {
  for (const failOldStart of [false, true]) {
    const cameras = [], hands = [], elements = {};
    const el = id => elements[id] ||= { style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, getContext: () => ({ setTransform: noop, clearRect: noop }), remove() { this.removed = true; } };
    const ctx = vm.createContext({ console, Promise, performance: { now: () => 1000 }, window: { addEventListener: noop },
      document: { hidden: false, body: { appendChild: noop, classList: { contains: () => false } }, getElementById: el, querySelectorAll: () => [], createElement: () => el('video-' + Math.random()) },
      fx: { cam: 'gesture', gestureHandOverlay: true }, uniforms: { uHandActive: { value: 0 }, uGestureGrip: { value: 0 } }, innerWidth: 1000, innerHeight: 600, devicePixelRatio: 1,
      loadScriptOnce: async () => {}, showToast: noop, saveLyricLayout: noop, setTimeout, clearTimeout,
      Hands: class { constructor() { this.closed = false; hands.push(this); } setOptions() {} onResults(fn) { this.onResult = fn; } close() { this.closed = true; } },
      Camera: class { constructor(video, options) { this.video = video; this.options = options; this.pending = deferred(); this.stopped = false; cameras.push(this); } start() { return this.pending.promise; } stop() { this.stopped = true; } }
    });
    vm.runInContext(read('10-shell/00-gesture-control.js'), ctx);
    ctx.applyGestureSettingsUi = ctx.showGestureHUD = ctx.resetGesturePlayerActionState = noop;
    const binding = read('07-fx/07-bindings-shelf-immersive.js'), start = binding.indexOf('async function setCamMode(m) {');
    vm.runInContext(binding.slice(start, binding.indexOf('\n}\n', start) + 2), ctx);
    const first = ctx.setCamMode('gesture'); await flush(); await ctx.setCamMode('off'); const second = ctx.setCamMode('gesture'); await flush();
    cameras[1].pending.resolve(); await second; assert.equal(ctx.gestureActive, true);
    if (failOldStart) cameras[0].pending.reject(new Error('old camera cancelled')); else cameras[0].pending.resolve();
    await first;
    assert.equal(ctx.gestureActive, true); assert.equal(cameras[1].stopped, false); assert.equal(hands[1].closed, false);
    assert.equal(cameras[0].stopped, true); assert.equal(hands[0].closed, true);
    assert.strictEqual(ctx.gestureCamera, cameras[1]);
    ctx.stopGestureControl(); assert.equal(cameras[1].stopped, true);
  }
});

test('crop and zoom reuse a local video URL; a zero crop remains at the edge', async () => {
  const handlers = {}, attrs = {}; let loads = 0, creates = 0, revokes = 0;
  const style = { setProperty: noop };
  const video = { style, getAttribute: key => attrs[key] || '', setAttribute(key, value) { attrs[key] = value; }, removeAttribute(key) { delete attrs[key]; }, load() { loads++; }, pause: noop, play: async () => {} };
  const stage = { style, classList: { add: noop, remove: noop }, addEventListener(key, fn) { handlers[key] = fn; }, getBoundingClientRect: () => ({ width: 100, height: 100 }), setPointerCapture: noop };
  const ctx = vm.createContext({ console, fx: { backgroundMedia: { type: 'video', id: 'video-a' }, backgroundMediaCropX: 50, backgroundMediaCropY: 50, backgroundMediaZoom: 1 }, fxDefaults: {}, customBgApplyToken: 0, customBgObjectUrl: '',
    normalizeHexColor: value => value, hexToRgb: () => ({ r: 0, g: 0, b: 0 }), normalizeCustomBackgroundMedia: value => value, clampRange: (value, min, max) => Math.max(min, Math.min(max, value)), getCustomBackgroundBlob: async () => ({}),
    URL: { createObjectURL: () => 'blob:' + (++creates), revokeObjectURL() { revokes++; } },
    document: { documentElement: { style }, body: { classList: { toggle: noop, contains: () => false } }, getElementById(id) { if (id === 'custom-bg-video') return video; if (id === 'background-crop-stage') return stage; if (id === 'background-crop-zoom') return { addEventListener: noop }; return null; } }
  });
  vm.runInContext(read('07-fx/02-accent-background-controls.js'), ctx);
  ctx.applyCustomBackground(); await flush(); const initial = attrs.src;
  ctx.fx.backgroundMediaZoom = 1.2; ctx.applyCustomBackground(); await flush();
  assert.equal(loads, 1); assert.equal(creates, 1); assert.equal(attrs.src, initial);
  ctx.fx.backgroundMedia.id = 'video-b'; ctx.applyCustomBackground(); await flush();
  assert.equal(loads, 2); assert.equal(creates, 2); assert.equal(revokes, 1);
  ctx.bindCustomBackgroundCropModal(); ctx.customBackgroundCropModalState = { dragging: true, lastX: 0, lastY: 0 };
  ctx.fx.backgroundMediaCropX = ctx.fx.backgroundMediaCropY = 0; let snapshot;
  ctx.applyCustomBackgroundCropSnapshot = value => { snapshot = value; };
  handlers.pointermove({ preventDefault: noop, clientX: -1, clientY: -1 });
  assert(snapshot.x > 0 && snapshot.x < 2); assert(snapshot.y > 0 && snapshot.y < 2);
});

test('a late shelf cover callback draws the current recycled card', () => {
  const code = read('04-shelf/01-manager-core.js').replace('  return {\n    setMode:', '  return {\n    drawForTest: drawCard, rebindForTest: rebindShelfCard,\n    setMode:');
  const drawn = [], callbacks = {}, cache = {};
  const canvasContext = new Proxy({}, { get(target, key) {
    if (key === 'measureText') return text => ({ width: text.length * 10 });
    if (key === 'fillText') return text => drawn.push(text);
    if (key === 'clearRect') return () => { drawn.length = 0; };
    if (key === 'createLinearGradient') return () => ({ addColorStop: noop }); return noop;
  }, set: () => true });
  const ctx = vm.createContext({ console, playlistCoverCache: cache, bass: 0, beatPulse: 0, uniforms: { uTime: { value: 1 } }, shelfAccentHex: () => '#ffffff', shelfSettings: () => ({ bgOpacity: 0.8 }), shelfAccentRgba: () => '', requestPlaylistCover(url, cb) { cache[url] = { loading: true }; callbacks[url] = cb; } });
  vm.runInContext(code, ctx); const manager = ctx.makeShelfManager();
  const a = { type: 'playlist', title: 'Playlist A', cover: 'A' }, b = { type: 'playlist', title: 'Playlist B', cover: 'B' };
  const card = { canvas: { width: 720, height: 360 }, ctx: canvasContext, texture: {}, mesh: { userData: {}, parent: {} }, item: a, index: 0, isCenter: false, selected: false, drawKey: '' };
  manager.drawForTest(card, a); manager.rebindForTest(card, b, 10); cache.A = { loaded: true, img: {} }; callbacks.A();
  assert.equal(card.item.title, 'Playlist B'); assert(drawn.includes('Playlist B')); assert(!drawn.includes('Playlist A'));
});
