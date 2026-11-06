'use strict';

// Run against the real main window in a disposable profile:
// node tests/navigation-back-electron-smoke.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.versions.electron) {
  const { app, BrowserWindow, session } = require('electron');
  const assert = require('node:assert/strict');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const events = [];
  const timeout = setTimeout(() => { console.error('NAVIGATION_BACK_TIMEOUT'); app.exit(2); }, 45000);
  app.commandLine.appendSwitch('mute-audio');
  async function waitFor(label, predicate, timeoutMs = 20000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try { const result = await predicate(); if (result) return result; } catch (_) {}
      await sleep(100);
    }
    throw new Error(label + ' timed out');
  }
  function getMain() {
    return BrowserWindow.getAllWindows().find(win => !win.isDestroyed() && /^http:\/\/127\.0\.0\.1:\d+\/\?startupAttempt=/.test(win.webContents.getURL()));
  }
  async function run() {
    const main = await waitFor('main window', getMain);
    const contents = main.webContents;
    await waitFor('renderer initialization', () => contents.executeJavaScript("typeof fx === 'object' && document.readyState === 'complete'"));
    const initialUrl = contents.getURL();
    assert.ok(contents.navigationHistory.canGoBack(), 'startup should leave a previous document for this regression');
    const pidBefore = process.pid;
    const rendererPidBefore = contents.getOSProcessId();
    const token = 'same-document-' + Date.now();
    await contents.executeJavaScript(`(() => {
      window.__navigationBackToken = ${JSON.stringify(token)};
      window.__navigationMouseButtons = [];
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;inset:0 auto auto 0;width:40px;height:40px;z-index:2147483647;pointer-events:auto';
      probe.addEventListener('mousedown', event => window.__navigationMouseButtons.push(event.button));
      probe.addEventListener('contextmenu', event => event.preventDefault());
      document.body.appendChild(probe);
    })()`);
    contents.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
      if (mainFrame) events.push({ event: 'start-navigation', url: new URL(url).pathname, inPlace });
    });
    contents.on('did-finish-load', () => events.push({ event: 'finish-load', rendererPid: contents.getOSProcessId() }));
    contents.on('before-input-event', (_event, input) => events.push({ event: 'input', type: input.type, key: input.key }));
    contents.on('before-mouse-event', (_event, mouse) => events.push({ event: 'mouse', type: mouse.type, button: mouse.button }));
    main.on('app-command', (_event, command) => events.push({ event: 'app-command', command }));
    contents.debugger.attach('1.3');
    const click = async (button, buttons) => {
      await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10, button, buttons, clickCount: 1 });
      await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 10, button, buttons: 0, clickCount: 1 });
    };
    await click('back', 8);
    await sleep(1200);
    assert.ok(events.some(entry => entry.event === 'mouse' && entry.button === 'back'), 'back mouse event was not delivered to Electron');
    assert.equal(contents.getURL(), initialUrl, 'back mouse button navigated away from the player');
    assert.equal(await contents.executeJavaScript('window.__navigationBackToken || null'), token, 'back mouse button reloaded the player');
    assert.ok(!events.some(entry => entry.event === 'start-navigation'), 'back mouse button started navigation');

    await click('left', 1);
    await click('right', 2);
    const mouseButtons = await contents.executeJavaScript('window.__navigationMouseButtons');
    assert.ok(mouseButtons.includes(0) && mouseButtons.includes(2), 'ordinary mouse buttons must reach the page');
    assert.ok(!mouseButtons.includes(3), 'back mouse button must not reach the page');

    // The player is still allowed to navigate within its own document.
    await contents.executeJavaScript("history.pushState({}, '', '?navigation-back-regression=1'); history.back();");
    await waitFor('programmatic in-page back', () => contents.getURL() === initialUrl);
    assert.ok(contents.navigationHistory.canGoForward(), 'fixture needs a forward history entry');
    const eventCount = events.length;
    await click('forward', 16);
    await sleep(800);
    assert.ok(events.slice(eventCount).some(entry => entry.event === 'mouse' && entry.button === 'forward'), 'forward mouse event was not delivered to Electron');
    assert.equal(contents.getURL(), initialUrl, 'forward mouse button navigated the player');
    assert.equal(await contents.executeJavaScript('window.__navigationBackToken || null'), token);

    // BrowserBack and app commands are not blocked as a side effect.
    const key = { key: 'BrowserBack', code: 'BrowserBack', windowsVirtualKeyCode: 166, nativeVirtualKeyCode: 166 };
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { ...key, type: 'rawKeyDown' });
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { ...key, type: 'keyUp' });
    assert.ok(events.some(entry => entry.event === 'input' && entry.key === 'BrowserBack'));
    const { execFile } = require('node:child_process');
    const handle = main.getNativeWindowHandle();
    const hwnd = handle.length >= 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
    const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class NavigationBackNative { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }'; [NavigationBackNative]::PostMessage([IntPtr]::new(${hwnd}), 0x0319, [IntPtr]::new(${hwnd}), [IntPtr]::new(0x00010000))`;
    await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true }, error => error ? reject(error) : resolve()));
    await waitFor('native browser-backward app-command', () => events.some(entry => entry.event === 'app-command' && entry.command === 'browser-backward'));
    await sleep(300);
    assert.equal(contents.getURL(), initialUrl, 'browser-backward command navigated the player');
    assert.equal(await contents.executeJavaScript('window.__navigationBackToken || null'), token);

    // Popup WebContents are not governed by the player's mouse handler.
    const popup = new BrowserWindow({ show: false });
    await popup.loadURL('data:text/html,<title>first</title>');
    await popup.loadURL('data:text/html,<title>second</title>');
    popup.webContents.debugger.attach('1.3');
    await popup.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10, button: 'back', buttons: 8, clickCount: 1 });
    await popup.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 10, button: 'back', buttons: 0, clickCount: 1 });
    await waitFor('popup history navigation', () => popup.webContents.getURL().includes('first'));
    popup.webContents.debugger.detach();
    popup.destroy();

    const result = { ok: true, pidBefore, pidAfter: process.pid, rendererPidBefore, rendererPidAfter: contents.getOSProcessId(), mouseButtons, events };
    contents.debugger.detach();
    return result;
  }
  app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) && !/^http:\/\/127\.0\.0\.1:/.test(details.url) }));
    return run();
  }).then(result => {
    clearTimeout(timeout);
    console.log('NAVIGATION_BACK_RESULT:' + JSON.stringify(result));
    app.quit();
  }).catch(error => {
    clearTimeout(timeout);
    console.error('NAVIGATION_BACK_ERROR:' + (error && error.stack || error));
    process.exitCode = 2;
    app.quit();
  });
  require('../desktop/main');
} else {
  if (process.platform !== 'win32') throw new Error('Windows required');
  const { spawnSync } = require('node:child_process');
  const tempRoot = path.resolve(os.tmpdir());
  const temp = fs.mkdtempSync(path.join(tempRoot, 'mineradio-navigation-back-'));
  const suffix = `${process.pid}-${Date.now()}`;
  try {
    const result = spawnSync(require('electron'), [__filename], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 55000, windowsHide: true,
      env: {
        ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        MINERADIO_RUNTIME_NAME: `Mineradio-Navigation-Back-${suffix}`,
        MINERADIO_APP_USER_MODEL_ID: `com.mineradio.navigation.back.${suffix}`,
        MINERADIO_STARTUP_QA_HIDDEN: '1', MINERADIO_STARTUP_QA_USER_DATA: temp,
        MINERADIO_NO_DESKTOP_SHORTCUT: '1',
      },
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    const line = String(result.stdout || '').split(/\r?\n/).find(value => value.startsWith('NAVIGATION_BACK_RESULT:'));
    if (result.error || result.status !== 0 || !line || !JSON.parse(line.slice(line.indexOf(':') + 1)).ok) process.exitCode = result.status || 1;
  } finally {
    if (path.dirname(path.resolve(temp)) === tempRoot && path.basename(temp).startsWith('mineradio-navigation-back-')) {
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    }
  }
}
