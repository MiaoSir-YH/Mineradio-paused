'use strict';
// Run explicitly: node tests/system-media-session-electron-smoke.js
// Exercises the complete page and real Chromium Media Session with synthetic
// local audio. Windows GSMTC/BrimDeck still need an on-device integration check.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-system-media-'));
const electron = require('electron');
const preload = path.join(temp, 'preload.js');
fs.writeFileSync(preload, "localStorage.setItem('mineradio-startup-fast-skip-v1', 'true'); const errors = []; require('electron').contextBridge.exposeInMainWorld('mediaSmokeDiagnostics', { errors: () => errors }); window.addEventListener('error', e => errors.push(e.message)); window.addEventListener('unhandledrejection', e => errors.push(String(e.reason && e.reason.stack || e.reason)));");

async function runElectronSmoke() {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
  const publicDir = path.join(process.env.MINERADIO_MEDIA_SMOKE_ROOT, 'public');
  app.setPath('userData', process.env.MINERADIO_MEDIA_SMOKE_TEMP);
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('mute-audio');
  const timer = setTimeout(() => finish(1, { error: 'Electron media smoke timed out' }), 35000);
  function finish(code, result) { clearTimeout(timer); console.log('MINERADIO_MEDIA_SMOKE:' + JSON.stringify(result)); app.exit(code); }
  try {
    await app.whenReady();
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ loggedIn: false, songs: [], tracks: [], playlists: [], items: [], list: [] })); return; }
      const file = path.resolve(publicDir, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
      if (!file.startsWith(publicDir + path.sep)) { res.writeHead(403); res.end(); return; }
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
      try { res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file)); }
      catch (_) { res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const win = new BrowserWindow({ width: 1280, height: 720, show: false, webPreferences: { offscreen: true, contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false, preload: process.env.MINERADIO_MEDIA_SMOKE_PRELOAD } });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) && !details.url.startsWith('http://127.0.0.1:') }));
    const logs = [];
    win.webContents.on('console-message', event => { if (/error|failed|exception/i.test(event.message || '')) logs.push(String(event.message).slice(0, 250)); });
    win.webContents.on('render-process-gone', (_event, details) => finish(1, { error: 'renderer crashed', details }));
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    const result = await win.webContents.executeJavaScript(`(${async function () {
      const check = (ok, message) => { if (!ok) throw new Error(message); };
      const wait = async (predicate, message) => {
        const until = Date.now() + 6500;
        while (Date.now() < until) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
        throw new Error(message);
      };
      await wait(() => typeof syncSystemMediaSession === 'function' && typeof playQueueAt === 'function', 'page modules not initialized');
      check(mediaSmokeDiagnostics.errors().length === 0, mediaSmokeDiagnostics.errors().join('; '));
      const session = navigator.mediaSession, actions = {}, positions = [];
      check(!!session && typeof MediaMetadata === 'function', 'native Media Session unavailable');
      const nativeAction = session.setActionHandler.bind(session), nativePosition = session.setPositionState.bind(session);
      session.setActionHandler = (name, fn) => { nativeAction(name, fn); actions[name] = fn; };
      session.setPositionState = value => { nativePosition(value); positions.push(value); };
      systemMediaSessionState.actions = {};
      const samples = 8000 * 60, wav = new ArrayBuffer(44 + samples * 2), view = new DataView(wav);
      const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
      text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples * 2, true);
      for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i * Math.PI * 2 * 440 / 8000) * 512), true);
      const localUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      const cover = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
      playQueue = ['A', 'B'].map(name => ({ type: 'local', source: 'local', localKey: 'media-smoke-' + name, localUrl, name: 'Media smoke ' + name, artist: 'Fixture Artist', album: 'Fixture Album', cover }));
      currentIdx = 0;
      check(await playQueueAt(0, { manual: true, preserveHomeState: true }), 'local playback failed');
      await wait(() => session.playbackState === 'playing' && positions.some(position => position && position.duration > 0), 'playing state or duration missing');
      check(session.metadata.title === 'Media smoke A' && session.metadata.artist === 'Fixture Artist' && session.metadata.artwork.length === 1, 'metadata or artwork missing');
      actions.pause(); await wait(() => audio.paused, 'system pause failed'); actions.pause(); check(audio.paused, 'repeat pause resumed audio');
      actions.play(); await wait(() => !audio.paused, 'system play failed'); actions.play(); check(!audio.paused, 'repeat play paused audio');
      check(typeof actions.seekto === 'function', 'system seek not registered'); actions.seekto({ seekTime: 12 });
      await wait(() => audio.currentTime >= 11.5 && audio.currentTime < 15, 'system seek failed');
      actions.nexttrack(); await wait(() => currentIdx === 1 && session.metadata.title === 'Media smoke B' && session.playbackState === 'playing', 'system next failed');
      actions.previoustrack(); await wait(() => currentIdx === 0 && session.metadata.title === 'Media smoke A' && session.playbackState === 'playing', 'system previous failed');
      actions.pause(); await wait(() => audio.paused, 'final pause failed');
      check(mediaSmokeDiagnostics.errors().length === 0, mediaSmokeDiagnostics.errors().join('; '));
      return { ok: true, title: session.metadata.title, playbackState: session.playbackState, duration: audio.duration, actions: Object.keys(actions).filter(key => !!actions[key]), pageErrors: mediaSmokeDiagnostics.errors() };
    }.toString()})()`, true);
    finish(0, { ...result, logs: logs.slice(-8) });
  } catch (error) { finish(1, { ok: false, error: String(error && error.stack || error) }); }
}

try {
  const qa = path.join(temp, 'main.js'); fs.writeFileSync(qa, '(' + runElectronSmoke.toString() + ')();');
  const result = spawnSync(electron, [qa, '--no-sandbox', '--headless', '--ozone-platform=headless'], { cwd: root, encoding: 'utf8', timeout: 45000,
    // Packaged apps skip Electron's development security-warning scanner. Its
    // v42 ResourceTiming URL parser throws on relative resource names in QA.
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', MINERADIO_MEDIA_SMOKE_ROOT: root, MINERADIO_MEDIA_SMOKE_TEMP: temp, MINERADIO_MEDIA_SMOKE_PRELOAD: preload } });
  const match = String(result.stdout || '').match(/MINERADIO_MEDIA_SMOKE:(\{.*\})/);
  if (result.error || result.status !== 0 || !match || JSON.parse(match[1]).ok !== true) {
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); throw result.error || new Error('Electron Media Session smoke failed');
  }
  console.log(match[0]);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
