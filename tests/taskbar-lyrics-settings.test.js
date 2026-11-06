'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const defaultsSource = read('public/js/modules/00-state/04-fx-defaults.js');
const persistenceSource = read('public/js/modules/02-visual/04-visual-settings-persistence.js');

function persistenceHarness() {
  const store = new Map();
  const warnings = [];
  let diskPayload = null;
  const ctx = vm.createContext({
    console: { warn: (...args) => warnings.push(args) },
    localStorage: {
      getItem: key => store.get(key) || null,
      setItem: (key, value) => store.set(key, value),
      removeItem: key => store.delete(key),
    },
    document: { addEventListener() {} },
    window: { addEventListener() {}, desktopWindow: {
      saveCurrentFxAutosaveSync: payload => { diskPayload = JSON.parse(JSON.stringify(payload)); },
      readCurrentFxAutosaveSync: () => ({ payload: diskPayload }),
    } },
    CURRENT_FX_AUTOSAVE_STORE_KEY: 'current', LYRIC_LAYOUT_STORE_KEY: 'legacy',
    CURRENT_FX_AUTOSAVE_SCHEMA: 'test', VISUAL_PRESET_SCHEMA: 'test',
    MAX_VISUAL_PRESET_INDEX: 11, BASE_FOV: 45,
    presetMeta: Array.from({ length: 12 }, () => ({})),
    startupVisualPreviewActive: false, playing: false, currentIdx: -1,
    normalizeCustomBackgroundMedia: () => null,
    normalizeCustomBackgroundImage: () => '',
    normalizeLyricFontKey: value => value || 'default',
    normalizeLyricDisplayMode: value => value,
    normalizeLyricTranslationMode: value => value,
    normalizeLyricMotionStyle: value => value,
    packagedDefaultLyricLayoutRaw: () => ({}),
    setTimeout, clearTimeout,
  });
  vm.runInContext(defaultsSource, ctx);
  vm.runInContext(persistenceSource, ctx);
  ctx.fx = { ...ctx.fxDefaults };
  return { ctx, store, warnings, disk: () => diskPayload };
}

test('taskbar settings and smaller desktop lyric scale survive a full save and reload', () => {
  for (const position of [0, 0.5, 1]) {
    const h = persistenceHarness();
    Object.assign(h.ctx.fx, {
      desktopLyrics: true,
      desktopLyricsTaskbar: true,
      desktopLyricsTaskbarDisplayId: '-1404422055',
      desktopLyricsTaskbarX: position,
      desktopLyricsSize: 0.2,
      desktopLyricsY: 0.42,
    });
    h.ctx.saveLyricLayout({ user: true, force: true, syncDisk: true, reason: 'taskbar-settings' });
    assert.equal(h.warnings.length, 0, `save failed: ${h.warnings.map(x => String(x[1])).join('; ')}`);
    const disk = h.disk();
    assert.ok(disk, 'settings are written to the desktop autosave mirror');
    assert.equal(disk.desktopLyricsTaskbar, true);
    assert.equal(disk.desktopLyricsTaskbarDisplayId, '-1404422055');
    assert.equal(disk.desktopLyricsTaskbarX, position);
    assert.equal(disk.desktopLyricsSize, 0.2);

    const restored = h.ctx.readSavedLyricLayout();
    assert.equal(h.warnings.length, 0, `reload failed: ${h.warnings.map(x => String(x[1])).join('; ')}`);
    assert.equal(restored.desktopLyricsTaskbar, true);
    assert.equal(restored.desktopLyricsTaskbarDisplayId, '-1404422055');
    assert.equal(restored.desktopLyricsTaskbarX, position);
    assert.equal(restored.desktopLyricsSize, 0.2);
    assert.equal(restored.desktopLyricsY, 0.42, 'desktop vertical position is retained');
  }
});

test('changing one taskbar setting preserves the others during scoped autosave', () => {
  const h = persistenceHarness();
  Object.assign(h.ctx.fx, {
    desktopLyrics: true, desktopLyricsTaskbar: true,
    desktopLyricsTaskbarDisplayId: '123', desktopLyricsTaskbarX: 0.8,
    desktopLyricsSize: 0.2, desktopLyricsY: 0.42,
  });
  h.ctx.saveLyricLayout({ user: true, force: true, syncDisk: true });
  h.ctx.fx.desktopLyricsTaskbarX = 0;
  h.ctx.saveLyricLayout({ user: true, syncDisk: true, reason: 'desktopLyricsTaskbarX' });
  assert.equal(h.warnings.length, 0, `save failed: ${h.warnings.map(x => String(x[1])).join('; ')}`);
  const restored = h.ctx.readSavedLyricLayout();
  assert.equal(restored.desktopLyricsTaskbarX, 0);
  assert.equal(restored.desktopLyricsTaskbar, true);
  assert.equal(restored.desktopLyricsTaskbarDisplayId, '123');
  assert.equal(restored.desktopLyricsSize, 0.2);
  assert.equal(restored.desktopLyricsY, 0.42);
});

test('older or invalid settings use the taskbar position default without changing a valid zero', () => {
  const h = persistenceHarness();
  h.store.set('mineradio-user-fx-archives-v1', '[]');
  vm.runInContext(read('public/js/modules/07-fx/00-preset-archive-data.js'), h.ctx);
  assert.equal(h.ctx.fxDefaults.desktopLyricsTaskbarX, 0.15);
  for (const input of [{}, { desktopLyricsTaskbarX: null }, { desktopLyricsTaskbarX: '' },
    { desktopLyricsTaskbarX: '   ' }, { desktopLyricsTaskbarX: 'invalid' }]) {
    h.store.set('current', JSON.stringify(input));
    assert.equal(h.ctx.readSavedLyricLayout().desktopLyricsTaskbarX, 0.15, `reload fallback for ${JSON.stringify(input)}`);
    assert.equal(h.ctx.normalizeFxArchiveSnapshot(input).desktopLyricsTaskbarX, 0.15, `archive fallback for ${JSON.stringify(input)}`);
  }
  h.store.set('current', JSON.stringify({ desktopLyricsTaskbarX: 0 }));
  assert.equal(h.ctx.readSavedLyricLayout().desktopLyricsTaskbarX, 0);
  assert.equal(h.ctx.normalizeFxArchiveSnapshot({ desktopLyricsTaskbarX: 0 }).desktopLyricsTaskbarX, 0);
});

test('taskbar toggle enables lyrics, returns to desktop, and saves both choices', () => {
  const h = persistenceHarness();
  const applied = [];
  Object.assign(h.ctx, {
    desktopLyricsDisplaysState: { supported: true },
    updateFxInputs() {}, showToast() {}, syncFxUniforms() {},
    isDevelopmentLockedFx: () => false,
    applyDesktopLyricsState() { applied.push([h.ctx.fx.desktopLyrics, h.ctx.fx.desktopLyricsTaskbar]); },
  });
  h.ctx.document.getElementById = () => null;
  const bindings = read('public/js/modules/07-fx/07-bindings-shelf-immersive.js');
  const start = bindings.indexOf('function toggleFx(key)');
  const end = bindings.indexOf('function toggleFxPanel(', start);
  assert.ok(start >= 0 && end > start, 'missing fx toggle handler');
  vm.runInContext(bindings.slice(start, end), h.ctx);
  Object.assign(h.ctx.fx, { desktopLyrics: false, desktopLyricsTaskbar: false });
  h.ctx.saveLyricLayout({ user: true, force: true, syncDisk: true });
  h.ctx.window.desktopWindow.readCurrentFxAutosaveSync = () => null;

  h.ctx.toggleFx('desktopLyricsTaskbar');
  let saved = h.ctx.readSavedLyricLayout();
  assert.equal(saved.desktopLyrics, true, 'opening taskbar lyrics also persists enabled state');
  assert.equal(saved.desktopLyricsTaskbar, true);
  assert.deepEqual(applied.at(-1), [true, true]);

  h.ctx.toggleFx('desktopLyricsTaskbar');
  saved = h.ctx.readSavedLyricLayout();
  assert.equal(saved.desktopLyrics, true, 'turning off taskbar mode keeps desktop lyrics enabled');
  assert.equal(saved.desktopLyricsTaskbar, false);
  assert.deepEqual(applied.at(-1), [true, false]);

  h.ctx.toggleFx('desktopLyricsTaskbar');
  h.ctx.toggleFx('desktopLyrics');
  saved = h.ctx.readSavedLyricLayout();
  assert.equal(saved.desktopLyrics, false, 'the master switch turns all lyrics off');
  assert.equal(saved.desktopLyricsTaskbar, true, 'the selected mode survives master switch off');
  assert.deepEqual(applied.at(-1), [false, true]);
  assert.equal(h.warnings.length, 0, `save failed: ${h.warnings.map(x => String(x[1])).join('; ')}`);
});

test('archive import and compact share keep the taskbar settings and minimum scale', () => {
  const h = persistenceHarness();
  h.store.set('mineradio-user-fx-archives-v1', '[]');
  vm.runInContext(read('public/js/modules/07-fx/00-preset-archive-data.js'), h.ctx);
  for (const position of [0, 0.5, 1]) {
    const input = {
      desktopLyrics: true, desktopLyricsTaskbar: true,
      desktopLyricsTaskbarDisplayId: '123', desktopLyricsTaskbarX: position,
      desktopLyricsSize: 0.2,
    };
    const normalized = h.ctx.normalizeFxArchiveSnapshot(input);
    const compact = h.ctx.compactUserFxArchiveSnapshot(input);
    const restored = h.ctx.expandUserFxArchiveSnapshot(compact);
    for (const snapshot of [normalized, restored]) {
      assert.equal(snapshot.desktopLyricsTaskbar, true);
      assert.equal(snapshot.desktopLyricsTaskbarDisplayId, '123');
      assert.equal(snapshot.desktopLyricsTaskbarX, position);
      assert.equal(snapshot.desktopLyricsSize, 0.2);
    }
  }
});

test('taskbar translation is separate from original lyric and follows paused playback position', () => {
  const source = read('public/js/modules/10-shell/04-desktop-overlay-fullscreen.js');
  const start = source.indexOf('function normalizeDesktopLyricText(');
  const end = source.indexOf('function desktopOverlayColorValue(', start);
  assert.ok(start >= 0 && end > start, 'missing lyric snapshot functions');
  const ctx = vm.createContext({
    fx: { desktopLyricsTaskbar: true, lyricTranslationMode: 'current' },
    playing: true, audio: { currentTime: 1, duration: 20 },
    lyricsLines: [{ t: 0, text: 'First line', translation: '第一行' }, { t: 3, text: 'Second line', translation: '第二行' }],
    stageLyrics: { currentText: 'Second line' },
    normalizeLyricTranslationMode: value => value,
    lyricLineTranslationTextAt: index => ctx.lyricsLines[index].translation,
    getLyricLineProgress: () => 0.4, currentLyricFallbackText: () => '',
    clampRange: (value, min, max) => Math.max(min, Math.min(max, value)),
    currentDesktopSongMeta: () => ({ title: 'Fallback' }),
  });
  vm.runInContext(source.slice(start, end), ctx);
  assert.equal(ctx.currentDesktopLyricSnapshot().text, 'First line');
  assert.equal(ctx.currentTaskbarLyricTranslation(), '第一行');
  ctx.playing = false;
  ctx.audio.currentTime = 3.5;
  assert.equal(ctx.currentDesktopLyricSnapshot().text, 'Second line');
  assert.equal(ctx.currentTaskbarLyricTranslation(), '第二行');
  ctx.fx.lyricTranslationMode = 'off';
  assert.equal(ctx.currentTaskbarLyricTranslation(), '');
  ctx.fx.lyricTranslationMode = 'current';
  ctx.fx.desktopLyricsTaskbar = false;
  assert.equal(ctx.currentTaskbarLyricTranslation(), '');
});

test('enabling or forcing taskbar Skyline sends full lines; ordinary frames stay compact', () => {
  const source = read('public/js/modules/10-shell/04-desktop-overlay-fullscreen.js');
  const start = source.indexOf('function pushDesktopLyricsState(');
  const end = source.indexOf('function pushWallpaperState(', start);
  assert.ok(start >= 0 && end > start, 'missing lyrics sender functions');
  const calls = [], lines = [{ t: 0, text: 'Word', words: [{ text: 'Word', t: 0, d: 1, c0: 0, c1: 4 }] }];
  let now = 0;
  const ctx = vm.createContext({
    getDesktopWindowApi: () => ({
      setDesktopLyricsEnabled(enabled, payload) { calls.push({ type: 'set', enabled, payload }); return Promise.resolve(); },
      updateDesktopLyrics(payload) { calls.push({ type: 'update', payload }); return Promise.resolve(); },
    }),
    desktopOverlayPushState: {}, performance: { now: () => { now += 1000; return now; } },
    desktopLyricsPushInterval: () => 8, desktopLyricsCurrentCustomFontId: () => '',
    desktopLyricsPayload: () => ({ enabled: true, taskbarMode: true, text: 'Word', progress: 0.5, progressSpan: 4,
      skyline: true, skylineKey: 'track-A', colors: {}, motion: {} }),
    skylineDesktopLines: () => lines,
    normalizeDevelopmentLockedFxState() {}, console,
  });
  vm.runInContext(source.slice(start, end), ctx);
  ctx.applyDesktopLyricsState(true);
  assert.equal(calls[0].type, 'set');
  assert.deepEqual(calls[0].payload.skylineLines, lines);
  assert.equal(calls[1].type, 'update');
  assert.deepEqual(calls[1].payload.skylineLines, lines);
  ctx.pushDesktopLyricsState(false);
  assert.equal(calls.at(-1).payload.skylineLines, null);
  ctx.pushDesktopLyricsState(true);
  assert.deepEqual(calls.at(-1).payload.skylineLines, lines, 'forced refresh resends lines even for the same track');
});

test('live lyric payload carries taskbar selection, position and the reduced size', () => {
  const source = read('public/js/modules/10-shell/04-desktop-overlay-fullscreen.js');
  const start = source.indexOf('function desktopLyricsPayload(');
  const end = source.indexOf('function skylineDesktopLines(', start);
  assert.ok(start >= 0 && end > start, 'missing desktop lyrics payload function');
  const ctx = vm.createContext({
    fxDefaults: { desktopLyricsSize: 1, desktopLyricsOpacity: 0.92, desktopLyricsY: 0.76, desktopLyricsTaskbarX: 0.15 },
    fx: { desktopLyrics: true, desktopLyricsTaskbar: true, desktopLyricsTaskbarDisplayId: '123', desktopLyricsTaskbarX: 0, desktopLyricsSize: 0.2 },
    currentDesktopSongMeta: () => ({ title: 'Title', artist: 'Artist' }),
    currentDesktopLyricSnapshot: () => ({ text: 'Line', progress: 0.25, progressSpan: 1 }),
    currentTaskbarLyricTranslation: () => '',
    desktopLyricsBeatMapPayload: () => ({ beatMapKey: 'none' }),
    isDevelopmentLockedFx: () => false,
    clampRange: (value, min, max) => Math.max(min, Math.min(max, value)),
    layoutNumber: (value, fallback, min, max) => {
      const number = Number(value == null ? fallback : value);
      return Math.max(min, Math.min(max, Number.isFinite(number) ? number : fallback));
    },
    normalizeDesktopLyricsFps: () => 0,
    lyricFontStackForKey: () => 'sans-serif', desktopLyricsCustomFontPayload: () => null,
    lyricFontWeightValue: () => 600, lyricLineHeightFactor: () => 1,
    lyricsHasNativeKaraoke: false, desktopLyricsMotionPayload: () => ({}),
    desktopLyricsPlaybackPayload: () => ({}), desktopOverlayColors: () => ({}),
    playing: true, lyricsLines: [], window: {},
  });
  const normalizeStart = persistenceSource.indexOf('function normalizeDesktopLyricsTaskbarX(');
  const normalizeEnd = persistenceSource.indexOf('function layoutInteger(', normalizeStart);
  assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart, 'missing taskbar position normalization');
  vm.runInContext(persistenceSource.slice(normalizeStart, normalizeEnd), ctx);
  vm.runInContext(source.slice(start, end), ctx);
  for (const position of [0, 0.5, 1]) {
    ctx.fx.desktopLyricsTaskbarX = position;
    const payload = ctx.desktopLyricsPayload();
    assert.equal(payload.enabled, true);
    assert.equal(payload.taskbarMode, true);
    assert.equal(payload.taskbarDisplayId, '123');
    assert.equal(payload.taskbarPosition, position);
    assert.equal(payload.size, 0.2);
    assert.equal(payload.text, 'Line');
  }
  for (const position of [null, '', '   ', 'invalid']) {
    ctx.fx.desktopLyricsTaskbarX = position;
    assert.equal(ctx.desktopLyricsPayload().taskbarPosition, 0.15);
  }
  ctx.fx.desktopLyricsTaskbar = false;
  const desktop = ctx.desktopLyricsPayload();
  assert.equal(desktop.enabled, true);
  assert.equal(desktop.taskbarMode, false);

  ctx.fx.lyricSkyline = true;
  ctx.fx.desktopLyricsCinema = true;
  ctx.fx.desktopLyricsHighlight = true;
  ctx.window.MineradioSkyline = {};
  ctx.lyricsLines = [{ t: 0, text: 'Line', words: [{ text: 'Line', t: 0, d: 1, c0: 0, c1: 4 }] }];
  ctx.desktopSkylineSignature = () => 'fixture-line-signature';
  ctx.desktopLyricsBeatMapPayload = () => ({ beatMapKey: 'beat-fixture', beatMap: { beats: [1, 2] } });
  ctx.desktopLyricsMotionPayload = () => ({ lyricGlow: true, lyricGlowBeat: true, beatPulse: 0.8, bass: 0.3 });
  ctx.desktopLyricsPlaybackPayload = () => ({ time: 2.5, rate: 1 });
  ctx.desktopOverlayColors = () => ({ primary: '#eee', highlight: '#fc0' });
  ctx.fx.desktopLyricsTaskbar = true;
  const taskbarEffects = ctx.desktopLyricsPayload(true, true);
  ctx.fx.desktopLyricsTaskbar = false;
  const desktopEffects = ctx.desktopLyricsPayload(true, true);
  assert.equal(taskbarEffects.skyline, true, 'taskbar retains the active Skyline effect');
  assert.equal(taskbarEffects.skylineKey, 'fixture-line-signature');
  for (const key of ['text', 'progress', 'progressSpan', 'skyline', 'skylineKey', 'cinema', 'highlightFollow', 'beatMapKey', 'beatMap', 'motion', 'playback', 'colors']) {
    assert.deepEqual(taskbarEffects[key], desktopEffects[key], `${key} differs between taskbar and desktop payloads`);
  }
});
