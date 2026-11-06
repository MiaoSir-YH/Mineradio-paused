'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const mainText = fs.readFileSync(path.join(__dirname, '../desktop/main.js'), 'utf8');
const gestureText = fs.readFileSync(path.join(__dirname, '../public/js/modules/10-shell/00-gesture-control.js'), 'utf8');

function permissions() {
  const webContents = { id: 17, isDestroyed: () => false, getURL: () => 'http://127.0.0.1:3000/' };
  const context = vm.createContext({
    URL, crypto: require('node:crypto'), Date,
    mainRendererOrigin: 'http://127.0.0.1:3000', path,
    mainWindow: { webContents, isDestroyed: () => false },
    GESTURE_CAMERA_PERMISSION_GRANT_MS: 45000, gestureCameraPermissionGrant: null,
  });
  vm.runInContext(mainText.slice(mainText.indexOf('function isLocalAppUrl('), mainText.indexOf('function isTrustedWallpaperEngineIpc(')), context);
  const event = { sender: webContents, senderFrame: { url: webContents.getURL(), parent: null } };
  return { context, webContents, event, allow: (details, consume = false) => context.isTrustedGestureCameraMediaPermission(webContents, webContents.getURL(), details, consume) };
}

test('gesture camera requires explicit video, is single-use and scoped to the main document', () => {
  const { context, event, allow, webContents } = permissions();
  assert.equal(allow({ mediaTypes: ['video'] }, true), false);
  const grant = context.createGestureCameraPermissionGrant(event);
  assert.ok(grant.id);
  assert.equal(allow({}), true);
  assert.equal(allow({}, true), false);
  assert.equal(allow({ mediaTypes: ['video', 'audio'] }, true), false);
  assert.equal(allow({ mediaTypes: ['video'], isMainFrame: false }, true), false);
  assert.equal(context.isTrustedGestureCameraMediaPermission(webContents, 'http://127.0.0.1:3001/', { mediaTypes: ['video'] }, true), false);
  assert.equal(allow({ mediaTypes: ['video'] }, true), true);
  assert.equal(allow({ mediaTypes: ['video'] }, true), false);
  const next = context.createGestureCameraPermissionGrant(event);
  context.clearGestureCameraPermissionGrant(grant.id);
  assert.equal(context.gestureCameraPermissionGrant.id, next.id);
  next.expiresAt = Date.now() - 1;
  assert.equal(allow({ mediaTypes: ['video'] }, true), false);
  assert.equal(context.createGestureCameraPermissionGrant({ ...event, senderFrame: { url: event.senderFrame.url, parent: {} } }), null);
});

test('slow scripts precede the camera grant and camera failure revokes only its grant', async () => {
  let release;
  const loaded = new Promise(resolve => { release = resolve; });
  const calls = [];
  const context = vm.createContext({
    window: { desktopWindow: {
      requestGestureCameraPermission: async () => { calls.push('grant'); return { ok: true, grantId: 'fixture' }; },
      revokeGestureCameraPermission: async id => { calls.push(`revoke:${id}`); },
    } },
    showToast() {}, loadScriptOnce: async () => { calls.push('script'); await loaded; },
    gestureStartEpoch: 1, fx: { cam: 'gesture' }, gestureHostVisible: () => true,
    document: { createElement: () => ({ style: {}, remove() {} }), body: { appendChild() {} } },
    Hands: class { setOptions() {} onResults() {} close() {} },
    Camera: class { async start() { calls.push('camera'); throw new Error('fixture camera failure'); } stop() {} },
    gestureModelComplexity: () => 0,
    cleanupGestureControlRuntime() {}, persistGestureCameraDisabled() {}, console: { warn() {} },
  });
  vm.runInContext(gestureText.slice(gestureText.indexOf('async function startGestureControlInternal('), gestureText.indexOf('function cleanupGestureControlRuntime(')), context);
  const pending = context.startGestureControlInternal(1);
  assert.deepEqual(calls, ['script']);
  release();
  assert.equal(await pending, false);
  assert.deepEqual(calls, ['script', 'script', 'grant', 'camera', 'revoke:fixture']);
});

test('cancelling while Camera.start is pending revokes the owned video grant immediately', () => {
  const calls = [];
  const ctx = vm.createContext({ window: { desktopWindow: { revokeGestureCameraPermission: id => { calls.push(id); return Promise.resolve(); } } } });
  vm.runInContext(gestureText.slice(gestureText.indexOf('function disposeGestureControlResources('), gestureText.indexOf('function cleanupGestureControlRuntime(')), ctx);
  const video = { __mineradioCameraPermissionGrantId: 'pending-grant', remove() {} };
  ctx.disposeGestureControlResources(video, null, null);
  assert.deepEqual(calls, ['pending-grant']);
  assert.equal(video.__mineradioCameraPermissionGrantId, '');
});
