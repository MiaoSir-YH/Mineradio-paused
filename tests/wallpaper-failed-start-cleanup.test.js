'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WallpaperEngineRuntime } = require('../desktop/wallpaper-engine-runtime');

test('a failed start remains tracked when closing its launched window fails, without replacing a newer pending start', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-failed-start-'));
  t.after(() => { if (path.dirname(root) === os.tmpdir()) fs.rmSync(root, { recursive: true, force: true }); });
  const scenePackage = path.join(root, 'scene.pkg'); fs.writeFileSync(scenePackage, 'fixture');
  const runtime = new WallpaperEngineRuntime({ nativeTempPath: root, nativeSleep: async () => {}, library: { getNativeSceneTarget: async id => ({ id, scenePackage }) } });
  runtime._discoverExecutable = async () => ({ available: true, executable: 'fixture.exe' });
  runtime._ensureEngineReady = async () => 'fixture.exe';
  runtime._muteSession = async () => {};
  runtime._openInitialSessionWindow = async session => { session.launched = true; };
  runtime._findWindowSource = async () => {
    runtime.pending = { sessionId: 'newer', launched: false };
    throw new Error('fixture discovery failed after launch');
  };
  let closeSucceeds = false;
  const closed = [];
  runtime._closeSession = async session => { closed.push(session.sessionId); return closeSucceeds; };
  await assert.rejects(runtime.start('fixture'));
  assert.equal(runtime.pending.sessionId, 'newer');
  assert.equal(runtime.retiredSessions.size, 1);
  const orphan = [...runtime.retiredSessions.values()][0];
  const generation = runtime.generation;
  closeSucceeds = true;
  const stopped = await runtime.stop(orphan.sessionId);
  assert.equal(stopped.stopped, true);
  assert.equal(runtime.retiredSessions.size, 0);
  assert.equal(runtime.pending.sessionId, 'newer');
  assert.equal(runtime.generation, generation);
  assert.equal(closed.filter(id => id === orphan.sessionId).length, 2);
  await runtime.dispose();
});

test('dispose retries and reports a retired orphan until it is actually closed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-orphan-dispose-'));
  t.after(() => { if (path.dirname(root) === os.tmpdir()) fs.rmSync(root, { recursive: true, force: true }); });
  const runtime = new WallpaperEngineRuntime({ nativeTempPath: root, nativeSleep: async () => {} });
  const orphan = { sessionId: 'failed', launched: true };
  runtime.retiredSessions.set(orphan.sessionId, orphan);
  runtime._closeSession = async () => false;
  runtime._stopSessionPointerRelay = () => {}; runtime._stopSessionDwmSurface = () => {};
  runtime._waitForSessionDwmSurfaceStop = async () => {}; runtime._clearSessionMuteReassertions = () => {};
  assert.equal((await runtime.dispose()).stopped, false);
  assert.equal(runtime.retiredSessions.size, 1);
  runtime._closeSession = async () => true;
  assert.equal((await runtime.dispose()).stopped, true);
  assert.equal(runtime.retiredSessions.size, 0);
});
