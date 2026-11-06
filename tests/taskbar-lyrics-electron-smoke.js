'use strict';

// Explicit Windows integration check: node tests/taskbar-lyrics-electron-smoke.js
// Creates a disposable profile and unique app identity; never attaches to an existing app.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

if (process.versions.electron) {
  const { app, BrowserWindow, screen, session } = require('electron');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const output = process.env.MINERADIO_LYRICS_QA_OUTPUT;
  fs.mkdirSync(output, { recursive: true });
  const timer = setTimeout(() => { console.error('Taskbar lyrics smoke timed out'); app.quit(); }, 85000);

  async function waitFor(label, predicate, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try { const value = await predicate(); if (value) return value; } catch (error) { lastError = error; }
      await sleep(80);
    }
    throw new Error(`${label} timed out${lastError ? ': ' + lastError.message : ''}`);
  }

  function mainWindow() {
    return BrowserWindow.getAllWindows().find(win => !win.isDestroyed() && /^http:\/\/127\.0\.0\.1:\d+\/\?startupAttempt=/.test(win.webContents.getURL()));
  }
  function lyricsWindow() {
    return BrowserWindow.getAllWindows().find(win => !win.isDestroyed() && /\/desktop-lyrics\.html(?:[?#]|$)/.test(win.webContents.getURL()));
  }
  async function evalMain(win, expression) { return win.webContents.executeJavaScript(expression, true); }
  async function overlayInfo(win) {
    return win.webContents.executeJavaScript(`(() => {
      const line = document.getElementById('line');
      const viewport = document.getElementById('lyricViewport');
      const translation = document.getElementById('taskbarTranslation');
      const canvas = document.getElementById('skyline');
      if (!line || !viewport || !translation || !canvas) return null;
      const root = getComputedStyle(document.documentElement);
      const lineStyle = getComputedStyle(line);
      const overlay = getComputedStyle(line, '::after');
      const viewStyle = getComputedStyle(viewport);
      const lr = line.getBoundingClientRect(), tr = translation.getBoundingClientRect(), vr = viewport.getBoundingClientRect();
      let alphaPixels = 0, hash = 2166136261;
      if (canvas.width && canvas.height) {
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3]) alphaPixels++;
          hash = Math.imul(hash ^ pixels[i], 16777619);
          hash = Math.imul(hash ^ pixels[i + 1], 16777619);
          hash = Math.imul(hash ^ pixels[i + 2], 16777619);
          hash = Math.imul(hash ^ pixels[i + 3], 16777619);
        }
      }
      return {
        taskbar: document.body.classList.contains('taskbar'),
        skylineClass: document.body.classList.contains('skyline'),
        skylineOn: !!(skyline && skyline.on), skylineLines: skyline && skyline.inst ? skyline.inst.lines.length : 0,
        canvasWidth: canvas.width, canvasHeight: canvas.height, canvasAlphaPixels: alphaPixels, canvasHash: hash >>> 0,
        progress: parseFloat(root.getPropertyValue('--lyric-progress')),
        size: parseFloat(root.getPropertyValue('--lyric-size')),
        clip: overlay.clipPath, afterContent: overlay.content,
        text: line.textContent, textFill: lineStyle.webkitTextFillColor, highlightFill: overlay.webkitTextFillColor,
        fontSize: parseFloat(lineStyle.fontSize),
        animation: lineStyle.animationName, whiteSpace: lineStyle.whiteSpace,
        viewportOverflow: viewStyle.overflowX,
        viewport: { x: vr.x, y: vr.y, width: vr.width, height: vr.height },
        line: { x: lr.x, y: lr.y, width: lr.width, height: lr.height },
        translation: { text: translation.textContent, display: getComputedStyle(translation).display,
          x: tr.x, y: tr.y, width: tr.width, height: tr.height },
        stageTransform: document.getElementById('stage').style.transform,
        wrapTransform: document.querySelector('.wrap').style.transform,
        beat: live.beat, scale: live.scale, cinema: state.cinema,
        motionBeatEnabled: state.lyricGlowBeat, playing: state.playing
      };
    })()`);
  }
  async function screenshot(win, name) {
    const image = await win.webContents.capturePage();
    assert.ok(!image.isEmpty(), `${name}: captured page is empty`);
    const file = path.join(output, name + '.png');
    fs.writeFileSync(file, image.toPNG());
    const pixels = image.toBitmap();
    let goldPixels = 0, visiblePixels = 0, alphaPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const blue = pixels[i], green = pixels[i + 1], red = pixels[i + 2], alpha = pixels[i + 3];
      if (alpha > 16) alphaPixels++;
      if (alpha > 16 && Math.max(red, green, blue) > 25) visiblePixels++;
      if (alpha > 16 && red > 140 && green > 90 && red > blue * 1.5 && green > blue * 1.25) goldPixels++;
    }
    assert.ok(alphaPixels > 25 && visiblePixels > 25, `${name}: capture contains no visible rendered pixels`);
    return { file, goldPixels, alphaPixels, visiblePixels };
  }
  async function pushFixture(main, expression) {
    await evalMain(main, `${expression}; pushDesktopLyricsState(true);`);
  }

  async function run() {
    const main = await waitFor('main window', mainWindow, 25000);
    await waitFor('renderer initialization', () => evalMain(main, `typeof fx === 'object' && typeof toggleFx === 'function' && typeof desktopWindow.getDesktopLyricsDisplays === 'function' && !!document.getElementById('t-desktopLyricsTaskbar')`));
    const displays = await evalMain(main, 'desktopWindow.getDesktopLyricsDisplays()');
    assert.equal(displays.ok, true, 'display-list IPC failed');
    const primary = displays.displays.find(display => display.isPrimary);
    assert.ok(primary && primary.taskbarAvailable && primary.taskbarVisible, 'the primary display needs a visible horizontal taskbar');

    await evalMain(main, `(() => {
      window.__lyricsQa = { text: 'Smoke taskbar lyric', translation: 'QA translation', progress: 0.2, start: performance.now(),
        motion: { lyricGlow: true, lyricGlowBeat: true, lyricGlowStrength: 0.65, highBloom: 0, beatGlow: 1, beatPulse: 1, bass: 0.1 } };
      fx.desktopLyrics = false; fx.desktopLyricsTaskbar = false;
      fx.desktopLyricsSize = 0.2; fx.desktopLyricsClickThrough = false;
      fx.desktopLyricsTaskbarDisplayId = ''; fx.desktopLyricsTaskbarX = 0.5;
      fx.desktopLyricsHighlight = true; fx.desktopLyricsCinema = true;
      fx.lyricSkyline = false; playing = false;
      currentDesktopLyricSnapshot = () => ({ text: window.__lyricsQa.text, progress: window.__lyricsQa.progress, progressSpan: 6 });
      currentTaskbarLyricTranslation = () => fx.desktopLyricsTaskbar ? window.__lyricsQa.translation : '';
      desktopLyricsMotionPayload = () => ({ ...window.__lyricsQa.motion });
      desktopOverlayColors = () => ({ primary:'#e6e6e6', secondary:'#94efe4', highlight:'#ffd000', glow:'#9cffdf' });
      desktopLyricsPlaybackPayload = () => ({ time: 1 + (performance.now() - window.__lyricsQa.start) / 1000, duration: 60, rate: 1, lyricOffset: 0 });
      desktopLyricsBeatMapPayload = () => ({ beatMapKey: 'qa-none', beatMap: null });
      lyricsLines = [
        { t: 0, duration: 3, text: 'Smoke taskbar lyric', words: [{ text:'Smoke ', t:0, d:1, c0:0, c1:6 },{ text:'taskbar ', t:1, d:1, c0:6, c1:14 },{ text:'lyric', t:2, d:1, c0:14, c1:19 }] },
        { t: 3.2, duration: 2, text: 'Next animated words' },
        { t: 6.4, duration: 2, text: 'Third lyric line' },
        { t: 9.6, duration: 2, text: 'Fourth lyric line' }
      ];
      document.getElementById('t-desktopLyrics').click();
    })()`);
    const overlay = await waitFor('desktop lyrics window', lyricsWindow);
    await waitFor('desktop minimum font size', async () => { const info = await overlayInfo(overlay); return info && !info.taskbar && info.size === 12; });
    await evalMain(main, `(() => { const input = document.getElementById('fx-desktoplyricssize'); input.value = '0.25'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor('desktop 0.25 font size', async () => (await overlayInfo(overlay)).size === 14.5);
    await sleep(250);
    const moved = await overlay.webContents.executeJavaScript('desktopOverlay.moveLyricsBy(70, -40)');
    assert.equal(moved.ok, true, 'desktop lyric move IPC failed');
    const desktopBounds = overlay.getBounds();
    await pushFixture(main, 'fx.desktopLyricsSize = 1');
    await sleep(1000);
    await screenshot(overlay, 'desktop-effects');

    await evalMain(main, "document.getElementById('t-desktopLyricsTaskbar').click()");
    await waitFor('visible taskbar lyrics', async () => { const info = await overlayInfo(overlay); return info && info.taskbar && info.text === 'Smoke taskbar lyric' && overlay.isVisible(); });
    await waitFor('translation', async () => { const info = await overlayInfo(overlay); return info.translation.text.includes('QA translation') && info.translation.display !== 'none'; });
    const translated = await overlayInfo(overlay);
    assert.ok(Math.abs((translated.line.y + translated.line.height / 2) - (translated.translation.y + translated.translation.height / 2)) < Math.max(translated.line.height, translated.translation.height), 'translation is not on the same line');
    await pushFixture(main, 'fx.desktopLyricsSize = 0.2');
    const small = await waitFor('taskbar minimum font', async () => { const info = await overlayInfo(overlay); return info.size < 50 && info; });
    const effectiveSmallFont = small.fontSize * overlay.getBounds().height / 120;
    assert.ok(effectiveSmallFont >= 11.5, `taskbar minimum font is too small: ${effectiveSmallFont}`);
    await sleep(900);
    const smallImage = await screenshot(overlay, 'taskbar-size-020');
    await pushFixture(main, "fx.desktopLyricsSize = 1; fx.desktopLyricsCinema = false; window.__lyricsQa.motion.lyricGlow = false; window.__lyricsQa.translation = ''");
    await waitFor('low progress', async () => { const info = await overlayInfo(overlay); return Math.abs(info.progress - 20) < 3; });
    await sleep(1000);
    const low = await overlayInfo(overlay);
    assert.equal(low.whiteSpace, 'nowrap');
    assert.ok(['hidden', 'clip'].includes(low.viewportOverflow), 'taskbar viewport does not clip');
    assert.ok(low.textFill && !/transparent|rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(low.textFill), 'taskbar text fill is transparent');
    assert.match(low.afterContent, /Smoke taskbar lyric/);
    assert.match(low.clip, /^inset\(/, 'taskbar highlight is not a partial text overlay');
    assert.notEqual(low.highlightFill, low.textFill, 'highlight and base glyph colors must differ');
    assert.equal(low.translation.display, 'none', 'progress comparison should contain only the original lyric');
    const lowImage = await screenshot(overlay, 'taskbar-progress-20');
    const images = [smallImage.file, lowImage.file];

    await pushFixture(main, 'window.__lyricsQa.progress = 0.8');
    await waitFor('high progress', async () => { const info = await overlayInfo(overlay); return Math.abs(info.progress - 80) < 3; });
    const high = await overlayInfo(overlay);
    assert.notEqual(high.clip, low.clip, 'highlight clip did not advance across the text');
    assert.equal(high.textFill, low.textFill, 'the entire base line changed color instead of progressively highlighting');
    const highImage = await screenshot(overlay, 'taskbar-progress-80');
    images.push(highImage.file);
    assert.ok(highImage.goldPixels > lowImage.goldPixels * 1.5 + 10, `highlight did not grow in captured pixels: ${lowImage.goldPixels} -> ${highImage.goldPixels}`);

    await pushFixture(main, "window.__lyricsQa.text = 'New line enters'; window.__lyricsQa.progress = 0.1; fx.desktopLyricsCinema = true; window.__lyricsQa.motion.lyricGlow = true");
    const entered = await waitFor('line entry animation', async () => { const info = await overlayInfo(overlay); return info.text === 'New line enters' && /lyr-in/.test(info.animation) && info; });
    assert.match(entered.animation, /lyr-in/);

    await waitFor('beat effect', async () => { const info = await overlayInfo(overlay); return info.cinema && info.motionBeatEnabled && info.beat > 0.5 && info; });
    const beatOn = await overlayInfo(overlay);
    assert.match(beatOn.stageTransform, /translate3d\(/);
    await sleep(1000);
    images.push((await screenshot(overlay, 'taskbar-beat-on')).file);
    await pushFixture(main, 'fx.desktopLyricsCinema = false');
    const cinemaOff = await waitFor('cinema disabled', async () => { const info = await overlayInfo(overlay); return !info.cinema && info.beat < 0.08 && info; });
    assert.ok(beatOn.scale > cinemaOff.scale + 0.03, 'cinema beat did not change stage scale');
    await pushFixture(main, 'fx.desktopLyricsCinema = true; window.__lyricsQa.motion.lyricGlowBeat = false');
    const beatDisabled = await waitFor('beat binding disabled', async () => { const info = await overlayInfo(overlay); return info.cinema && !info.motionBeatEnabled && info.beat < 0.08 && info; });
    assert.ok(beatDisabled.beat < beatOn.beat - 0.3, 'beat binding did not respond to its switch');

    const positions = [];
    for (const position of [0, 0.5, 1]) {
      await evalMain(main, `(() => { const input = document.getElementById('fx-desktoplyricstaskbarx'); input.value = ${JSON.stringify(position)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(500);
      positions.push(overlay.getBounds());
    }
    const bounds = screen.getPrimaryDisplay().bounds;
    assert.ok(positions[0].x < positions[1].x && positions[1].x < positions[2].x, 'position slider did not move lyrics left to right');
    assert.ok(Math.abs((positions[0].x + positions[2].x) / 2 - positions[1].x) <= 1, 'middle position is not centered');
    assert.ok(positions.every(rect => rect.x >= bounds.x && rect.x + rect.width <= bounds.x + bounds.width), 'lyrics left the selected display');

    await pushFixture(main, 'fx.lyricSkyline = true; playing = true; window.__lyricsQa.start = performance.now()');
    const skylineFirst = await waitFor('nonempty Skyline frame', async () => { const info = await overlayInfo(overlay); return info.skylineClass && info.skylineOn && info.skylineLines > 0 && info.canvasAlphaPixels > 0 && info; });
    images.push((await screenshot(overlay, 'taskbar-skyline-first')).file);
    await sleep(800);
    const skylineNext = await overlayInfo(overlay);
    assert.ok(skylineNext.canvasAlphaPixels > 0, 'Skyline stopped rendering');
    assert.notEqual(skylineNext.canvasHash, skylineFirst.canvasHash, 'Skyline canvas did not change as playback advanced');
    images.push((await screenshot(overlay, 'taskbar-skyline-next')).file);

    await evalMain(main, "document.getElementById('t-desktopLyricsTaskbar').click()");
    const restored = await waitFor('desktop Skyline restoration', async () => { const info = await overlayInfo(overlay); return !info.taskbar && info.skylineOn && info.skylineLines > 0 && overlay.isVisible() && info; });
    assert.deepEqual(overlay.getBounds(), desktopBounds, 'desktop position was not restored');
    images.push((await screenshot(overlay, 'desktop-skyline-restored')).file);
    await evalMain(main, "document.getElementById('t-desktopLyrics').click()");
    await waitFor('lyrics window to close', () => overlay.isDestroyed());
    return { ok: true, output, images, primaryDisplayId: primary.id, scaleFactor: primary.scaleFactor,
      low, high, effectiveSmallFont, lowGoldPixels: lowImage.goldPixels, highGoldPixels: highImage.goldPixels,
      beatOn, cinemaOff, beatDisabled, skylineFirst, skylineNext, restored, positions };
  }

  app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) && !/^http:\/\/127\.0\.0\.1:/.test(details.url) }));
    return run();
  }).then(result => {
    clearTimeout(timer);
    console.log('MINERADIO_TASKBAR_LYRICS_SMOKE:' + JSON.stringify(result));
    app.quit();
  }).catch(async error => {
    clearTimeout(timer);
    console.error(error.stack || error);
    const main = mainWindow();
    try { if (main) await evalMain(main, 'desktopWindow.setDesktopLyricsEnabled(false, {})'); } catch (_) {}
    app.quit();
  });
  require('../desktop/main');
} else {
  if (process.platform !== 'win32') throw new Error('This smoke requires Windows and a visible horizontal taskbar.');
  const { spawnSync } = require('node:child_process');
  const tempRoot = path.resolve(os.tmpdir());
  const temp = fs.mkdtempSync(path.join(tempRoot, 'mineradio-lyrics-smoke-'));
  const suffix = `${process.pid}-${Date.now()}`;
  const output = path.join('D:', 'OneDrive', 'AIDoc', 'Mineradio-paused', 'qa-effects', suffix);
  try {
    const env = {
      ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      MINERADIO_RUNTIME_NAME: `Mineradio-Lyrics-Smoke-${suffix}`,
      MINERADIO_APP_USER_MODEL_ID: `com.mineradio.lyrics.smoke.${suffix}`,
      MINERADIO_STARTUP_QA_HIDDEN: '1', MINERADIO_STARTUP_QA_USER_DATA: temp,
      MINERADIO_NO_DESKTOP_SHORTCUT: '1', MINERADIO_LYRICS_QA_OUTPUT: output,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [__filename], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 105000, windowsHide: true, env,
    });
    const line = String(result.stdout || '').split(/\r?\n/).find(value => value.startsWith('MINERADIO_TASKBAR_LYRICS_SMOKE:'));
    if (result.error || result.status !== 0 || !line || !JSON.parse(line.slice(line.indexOf(':') + 1)).ok) {
      process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
      throw result.error || new Error(`Taskbar lyrics Electron smoke failed; partial captures: ${output}`);
    }
    console.log(line);
  } finally {
    if (path.dirname(path.resolve(temp)) === tempRoot && path.basename(temp).startsWith('mineradio-lyrics-smoke-')) {
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    }
  }
}
