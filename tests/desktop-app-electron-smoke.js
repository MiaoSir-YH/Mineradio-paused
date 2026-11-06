'use strict';
// Explicit integration check of the real main process, preload and renderer.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
if (process.versions.electron) {
  const { app, session } = require('electron');
  const timer = setTimeout(() => { console.error('Desktop app smoke timeout'); app.exit(1); }, 40000);
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('mute-audio');
  app.on('browser-window-created', (_event, win) => {
    let checked = false;
    win.webContents.on('did-finish-load', async () => {
      if (checked || !/^http:\/\/127\.0\.0\.1:\d+\/\?startupAttempt=/.test(win.webContents.getURL())) return;
      checked = true;
      try {
        const result = await win.webContents.executeJavaScript(`(${async function () {
          const check = (ok, message) => { if (!ok) throw new Error(message); };
          const until = Date.now() + 10000;
          while (typeof playQueueAt !== 'function' && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
          check(typeof playQueueAt === 'function', 'renderer modules unavailable');
          const version = await fetch('/api/app/version'); const versionBody = await version.json();
          check(version.ok && versionBody.update.disabled === false && versionBody.update.provider === 'github'
            && versionBody.update.owner === 'MiaoSir-YH' && versionBody.update.repo === 'Mineradio-paused', 'fork update configuration unavailable');
          const state = await fetch('/api/login/status'); check(state.ok, 'account status request rejected');
          const grant = await desktopWindow.requestGestureCameraPermission(); check(grant.ok, 'grant IPC rejected');
          const stream = await navigator.mediaDevices.getUserMedia({ video: true }); stream.getTracks().forEach(track => track.stop());
          let secondDenied = false;
          try { const second = await navigator.mediaDevices.getUserMedia({ video: true }); second.getTracks().forEach(track => track.stop()); }
          catch (_) { secondDenied = true; }
          check(secondDenied, 'camera grant was reusable');
          const audioGrant = await desktopWindow.requestGestureCameraPermission();
          let audioDenied = false;
          try { const microphone = await navigator.mediaDevices.getUserMedia({ audio: true }); microphone.getTracks().forEach(track => track.stop()); }
          catch (_) { audioDenied = true; }
          await desktopWindow.revokeGestureCameraPermission(audioGrant.grantId);
          check(audioDenied, 'video grant allowed microphone capture');
          return { ok: true, origin: location.origin, apiStatus: state.status, cameraSingleUse: secondDenied, microphoneDenied: audioDenied };
        }.toString()})()`, true);
        clearTimeout(timer);
        console.log('MINERADIO_DESKTOP_SMOKE:' + JSON.stringify(result));
        app.quit();
      } catch (error) { console.error(error.stack || error); clearTimeout(timer); app.exit(1); }
    });
  });
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) && !/^http:\/\/127\.0\.0\.1:/.test(details.url) })));
  require('../desktop/main');
} else {
  const { spawnSync } = require('node:child_process');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-desktop-smoke-'));
  try {
    const result = spawnSync(require('electron'), [__filename, '--no-sandbox', '--headless', '--ozone-platform=headless'], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 50000,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', MINERADIO_STARTUP_QA_HIDDEN: '1', MINERADIO_STARTUP_QA_USER_DATA: temp, MINERADIO_NO_DESKTOP_SHORTCUT: '1' },
    });
    const line = String(result.stdout || '').split(/\r?\n/).find(value => value.startsWith('MINERADIO_DESKTOP_SMOKE:'));
    if (result.error || result.status !== 0 || !line) { process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); throw result.error || new Error('Desktop app Electron smoke failed'); }
    console.log(line);
  } finally { if (path.dirname(temp) === os.tmpdir()) fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }); }
}
