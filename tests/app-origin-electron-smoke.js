'use strict';
// Explicit integration check: node tests/app-origin-electron-smoke.js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function electronSmoke() {
  const { app, BrowserWindow, session } = require('electron');
  const http = require('node:http');
  const crypto = require('node:crypto');
  const { loadRendererOrigin, createLocalProtocolHandler } = require('../desktop/app-origin');
  const { migrateChromiumProfile } = require('../desktop/profile-migration');
  const root = process.env.MINERADIO_ORIGIN_SMOKE_ROOT;
  const phase = Number(process.env.MINERADIO_ORIGIN_SMOKE_PHASE);
  const userData = path.join(root, 'profile'), oldSession = path.join(root, 'old-cache', 'Mineradio');
  const stableSession = path.join(userData, 'chromium-session');
  fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(oldSession, { recursive: true }); fs.mkdirSync(stableSession, { recursive: true });
  const blocker = http.createServer((_req, res) => { res.writeHead(418); res.end('occupied'); });
  await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(phase === 1 ? 0 : Number(new URL(loadRendererOrigin(userData, false)).port), '127.0.0.1', resolve); });
  if (phase === 1) fs.writeFileSync(path.join(userData, 'startup-state.json'), JSON.stringify({ port: blocker.address().port }));
  const origin = loadRendererOrigin(userData);
  app.setPath('userData', userData);
  if (phase !== 1) migrateChromiumProfile(stableSession, [oldSession, userData]);
  app.setPath('sessionData', phase === 1 ? oldSession : stableSession);
  app.commandLine.appendSwitch('disk-cache-dir', path.join(root, `cache-${phase}`));
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('mute-audio');
  const timeout = setTimeout(() => { console.error('Origin smoke timeout'); app.exit(1); }, 35000);
  try {
    await app.whenReady();
    const token = crypto.randomBytes(16).toString('hex');
    let calls = 0;
    const wav = Buffer.alloc(44 + 16000);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
    const backend = http.createServer(async (req, res) => {
      if (!req.url.startsWith('/api/')) { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Origin fixture</title>'); return; }
      calls++;
      if (req.headers['x-mineradio-token'] !== token) { res.writeHead(403); res.end('Forbidden'); return; }
      if (req.url === '/api/image') { res.setHeader('content-type', 'image/png'); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')); return; }
      if (req.url === '/api/audio') { res.setHeader('content-type', 'audio/wav'); res.end(wav); return; }
      let body = ''; for await (const chunk of req) body += chunk;
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, body, origin: req.headers.origin, range: req.headers.range }));
    });
    await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
    const backendOrigin = `http://127.0.0.1:${backend.address().port}`;
    session.defaultSession.protocol.handle('http', createLocalProtocolHandler({ origin, backendOrigin: () => backendOrigin, tokenHeaders: () => ({ 'x-mineradio-token': token }), remoteFetch: request => session.defaultSession.fetch(request, { bypassCustomProtocolHandlers: true }) }));
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadURL(origin + '/');
    const data = await win.webContents.executeJavaScript(`(${async function (phase) {
      const check = (ok, message) => { if (!ok) throw new Error(message); };
      const api = await (await fetch('/api/test', { method: 'POST', body: 'hello', headers: { Range: 'bytes=0-4' } })).json();
      check(api.ok && api.body === 'hello' && api.range === 'bytes=0-4', 'API streaming/body/range failed');
      await new Promise((resolve, reject) => { const img = new Image(); img.onload = resolve; img.onerror = () => reject(new Error('image denied')); img.src = '/api/image'; });
      await new Promise((resolve, reject) => { const audio = new Audio(); audio.onloadedmetadata = () => { audio.removeAttribute('src'); audio.load(); resolve(); }; audio.onerror = () => reject(new Error('audio denied')); audio.src = '/api/audio'; });
      const db = await new Promise((resolve, reject) => { const req = indexedDB.open('origin-smoke', 1); req.onupgradeneeded = () => req.result.createObjectStore('records'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      if (phase === 1) {
        localStorage.setItem('saved-history', 'fixture-A');
        await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put('fixture-playlist', 'saved'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      } else {
        check(localStorage.getItem('saved-history') === 'fixture-A', 'localStorage lost after cache or backend-port change');
        const saved = await new Promise((resolve, reject) => { const req = db.transaction('records').objectStore('records').get('saved'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
        check(saved === 'fixture-playlist', 'IndexedDB lost after migration/restart');
      }
      db.close();
      return { ok: true, phase, origin: location.origin, apiOrigin: api.origin, localStorage: localStorage.getItem('saved-history') };
    }.toString()})(${phase})`, true);
    assert.equal(data.apiOrigin, backendOrigin);
    const remote = new BrowserWindow({ show: false, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
    await remote.loadURL(backendOrigin + '/');
    const before = calls;
    await remote.webContents.executeJavaScript(`fetch(${JSON.stringify(origin + '/api/test')}, { mode: 'no-cors' }).then(() => true, () => false)`);
    assert.equal(calls, before, 'a different port on 127.0.0.1 must not receive app credentials');
    remote.destroy();
    session.defaultSession.flushStorageData(); await session.defaultSession.cookies.flushStore();
    await new Promise(resolve => setTimeout(resolve, 100));
    win.destroy(); backend.close(); blocker.close(); clearTimeout(timeout);
    console.log('MINERADIO_ORIGIN_SMOKE:' + JSON.stringify(data));
    app.exit(0);
  } catch (error) { console.error(error.stack || error); clearTimeout(timeout); app.exit(1); }
}

if (process.versions.electron) {
  electronSmoke().catch(error => { console.error(error.stack || error); require('electron').app.exit(1); });
} else {
  const { spawnSync } = require('node:child_process');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-origin-smoke-'));
  try {
    for (let phase = 1; phase <= 3; phase++) {
      const result = spawnSync(require('electron'), [__filename, '--no-sandbox', '--headless', '--ozone-platform=headless'], {
        cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 45000,
        env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', MINERADIO_ORIGIN_SMOKE_ROOT: temp, MINERADIO_ORIGIN_SMOKE_PHASE: String(phase) },
      });
      const line = String(result.stdout || '').split(/\r?\n/).find(value => value.startsWith('MINERADIO_ORIGIN_SMOKE:'));
      if (result.error || result.status !== 0 || !line) { process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); throw result.error || new Error('Electron origin smoke failed'); }
      console.log(line);
    }
  } finally { if (path.dirname(temp) === os.tmpdir()) fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}
