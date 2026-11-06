const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function readSource(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

function rendererModule(file) {
  return readSource('public/js/modules/' + file);
}

function sourceRange(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `Missing source section ${from}`);
  return source.slice(start, end);
}

test('continue listening resolves a legacy local ID through the live library', async () => {
  const track = { id: 'local:abcdef0123456789abcdef01', localFileId: 'abcdef0123456789abcdef01', type: 'local', localUrl: 'mineradio-local://audio/track?cap=current' };
  const toasts = [];
  const ctx = vm.createContext({
    playQueue: [], currentLocalSong: null, currentIdx: -1, activeRadioContext: null, persistentLocalLibraryTracks: [track],
    cloneSong: (song) => ({ ...song }), safeRenderQueuePanel() {}, safeShelfRebuild() {}, forcePlaybackControlsInteractive() {},
    showToast: (message) => toasts.push(message), playQueueAt: (index) => assert.equal(ctx.playQueue[index].localUrl, track.localUrl),
  });
  const upload = rendererModule('06-lyrics/05-upload-dragdrop.js');
  const home = rendererModule('05-playback/05-home-actions.js');
  vm.runInContext(sourceRange(upload, 'function localMusicTrackId', 'function restoredLocalTrackIndex') + sourceRange(home, 'function songFromListenRecord', 'function openHomeInsight'), ctx);
  await ctx.playHomeRecent({ id: track.id, type: 'local', name: 'Old history' });
  assert.equal(ctx.playQueue[0].localFileId, track.localFileId);
  const queue = ctx.playQueue;
  await ctx.playHomeRecent({ key: 'local:missing', name: 'Missing' });
  assert.equal(ctx.playQueue, queue);
  assert.match(toasts[0], /重新导入/);
});

test('out-of-order removal replies preserve the newest playlist and let the next page load', async () => {
  const tracks = ['A', 'B', 'C', 'D'].map((name) => ({ name, builtInIdentity: 'netease:' + name }));
  const detail = { key: 'mineradio:p', tracks: tracks.slice(0, 3), total: 4, nextOffset: 3, token: 1, hasMore: true, builtInRevision: 4 };
  const finish = new Map();
  const ctx = vm.createContext({
    console, window: { desktopWindow: { listBuiltInPlaylists() {}, removeBuiltInPlaylistTrack: (_id, identity) => new Promise((resolve) => finish.set(identity, resolve)) } },
    playlistPanelDetailState: detail, builtInPlaylists: [], neteasePlaylists: [], qqPlaylists: [], kugouPlaylists: [], qishuiPlaylists: [], spotifyPlaylists: [], playlistCatalogRevision: 0,
    cancelPlaylistPanelDetailRequest() {}, renderPlaylistPanelDetailRows() {}, showToast() {},
    normalizePlaylistProvider: (provider) => provider, PLAYLIST_DETAIL_BATCH_SIZE: 48, cloneSong: (song) => ({ ...song }),
    appendPlaylistPanelDetailTracks(target, incoming) { target.push(...incoming); return incoming.length; },
    fetchPlaylistTracksPage(_provider, _id, { offset }) {
      assert.equal(offset, 1);
      return { tracks: [tracks[3]], total: 2, nextOffset: 2, hasMore: false, revision: 6 };
    },
  });
  vm.runInContext(rendererModule('06-lyrics/00-built-in-playlists.js'), ctx);
  vm.runInContext(sourceRange(rendererModule('06-lyrics/02-playlist-detail.js'), 'async function loadMorePlaylistPanelDetailTracks', 'async function openPlaylistPanelDetail'), ctx);
  const removeA = ctx.removeTrackFromBuiltInPlaylist('p', tracks[0].builtInIdentity);
  const removeB = ctx.removeTrackFromBuiltInPlaylist('p', tracks[1].builtInIdentity);
  assert.equal(await ctx.loadMorePlaylistPanelDetailTracks('scroll'), false);
  function response(revision, count) {
    const playlist = { id: 'p', trackCount: count };
    return { ok: true, revision, playlist, playlists: [playlist] };
  }
  finish.get(tracks[1].builtInIdentity)(response(6, 2));
  assert.equal(await removeB, true);
  finish.get(tracks[0].builtInIdentity)(response(5, 3));
  assert.equal(await removeA, true);
  assert.equal(ctx.builtInPlaylists[0].trackCount, 2);
  assert.equal(detail.total, 2);
  assert.equal(detail.hasMore, true);
  assert.equal(await ctx.loadMorePlaylistPanelDetailTracks('scroll'), true);
  assert.deepEqual(detail.tracks.map((track) => track.name), ['C', 'D']);
  assert.equal(detail.hasMore, false);
});

test('saving or deleting an open lyric editor writes its original track after a switch', () => {
  const tracks = [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }];
  const map = { A: { text: 'Original A' }, B: { text: 'Original B' } };
  const elements = new Map();
  const timers = [];
  const ctx = vm.createContext({
    currentIdx: 0, playQueue: tracks, currentLocalSong: null, customLyricMap: map, customLyricPrefs: {}, immersiveMode: false,
    songCustomCoverKey: (song) => song && song.id, parseCustomLyricText: (text) => [text],
    setCustomLyricStatus() {}, showToast() {}, openGsapModal() {}, closeGsapModal() {}, saveCustomLyricMap: () => true, saveCustomLyricPrefs() {},
    applyCustomLyricState: () => assert.fail('Changed the currently playing lyric'),
    applyOriginalLyricsState: () => assert.fail('Reset the currently playing lyric'),
    setTimeout: (fn) => timers.push(fn),
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); } },
  });
  const editor = rendererModule('05-playback/06-track-detail-lyrics-actions.js');
  vm.runInContext(sourceRange(editor, 'function songCustomLyricKey', 'function cloneLyricLine') + sourceRange(editor, 'var customLyricEditTarget', 'var QISHUI_LIKE_ACCOUNT_ACTIONS_ENABLED'), ctx);
  ctx.openCustomLyricModal();
  ctx.currentIdx = 1;
  elements.get('custom-lyric-input').value = 'Edited A';
  ctx.saveCustomLyricForCurrent();
  assert.equal(map.A.text, 'Edited A');
  assert.equal(map.B.text, 'Original B');
  ctx.deleteCustomLyricForCurrent();
  assert.equal(map.A, undefined);
  assert.equal(map.B.text, 'Original B');
  ctx.openCustomLyricModal();
  timers[1]();
  assert.equal(ctx.customLyricEditTarget.key, 'B');
});

test('a cover decoded and cropped after switching still belongs to the selected file’s original song', () => {
  const tracks = [{ id: 'A' }, { id: 'B' }];
  const canvases = () => ({ getContext: () => ({ drawImage() {} }) });
  const inputs = new Map();
  const ctx = vm.createContext({
    currentIdx: 0, playQueue: tracks, currentLocalSong: null, trackSwitchToken: 0, coverCropState: null,
    customCoverMap: { B: 'existing' }, songCustomCoverKey: (song) => song && song.id,
    saveCustomCoverMap: () => true, safeRenderQueuePanel() {}, safeShelfRebuild() {}, updateCustomCoverButton() {}, showToast() {}, miniQueueOpen: false,
    applyCoverDataUrl: () => assert.fail('Applied a cover to the wrong current track'),
    FileReader: class { readAsDataURL() { inputs.set('reader', this); } },
    Image: class { constructor() { this.naturalWidth = 640; this.naturalHeight = 480; inputs.set('image', this); } },
    document: { createElement: canvases, getElementById: () => ({ removeAttribute() {} }) },
    makeSquareCoverCanvas: canvases, coverCanvasToDataUrl: () => 'edited-cover',
    bindCoverCropModal() {}, openGsapModal() {}, closeGsapModal(_modal, after) { after(); }, requestAnimationFrame(fn) { fn(); },
    initCoverCropGeometry() {}, pulseCoverCropStage() {}, currentCoverCropRect: () => ({ width: 480 }),
  });
  const editor = rendererModule('05-playback/06-track-detail-lyrics-actions.js');
  const cover = rendererModule('03-beat/05-cover-loading-crop.js');
  vm.runInContext(sourceRange(editor, 'function currentCoverSong', 'function songDurationLabel') + sourceRange(editor, 'function setCustomCoverForSong', 'function updateCustomCoverButton'), ctx);
  vm.runInContext(sourceRange(cover, 'function commitCustomCoverCanvas', 'function bindCoverCropModal') + sourceRange(cover, 'function openCoverCropModal', 'function initCoverCropGeometry') + cover.slice(cover.indexOf('function closeCoverCropModal')), ctx);
  ctx.loadCoverFromFile({});
  ctx.currentIdx = 1;
  ctx.trackSwitchToken++;
  inputs.get('reader').onload({ target: { result: 'image-data' } });
  inputs.get('image').onload();
  ctx.commitCoverCrop();
  assert.equal(ctx.customCoverMap.A, 'edited-cover');
  assert.equal(ctx.customCoverMap.B, 'existing');
});

test('a successful Qishui poll leaves a later provider’s login dialog open', async () => {
  const timers = [];
  const ctx = vm.createContext({
    console, loginProvider: 'qishui', loginRefreshRequestSeq: 2, qishuiQrPollGeneration: 1, qishuiQrPollBusy: false, qrKey: 'old',
    document: { getElementById: () => ({}) }, setTimeout(fn) { timers.push(fn); },
    apiJson: async (url, opts) => { assert.match(url, /^\/api\/qishui\/login\/check/); assert.equal(opts.method, 'POST'); return { loggedIn: true }; },
    stopQrPoll() { ctx.qishuiQrPollGeneration++; ctx.qishuiQrPollBusy = false; },
    normalizeQishuiLoginStatus: (result) => result, markLoginWorkflowConnected() {}, renderUserBtn() {}, refreshUserPlaylists: async () => {}, loadHomeDiscover() {},
    closeLoginModal: () => assert.fail('Closed the new provider dialog'), showToast() {},
  });
  const auth = rendererModule('08-account/03-login-modal-flows.js');
  vm.runInContext(sourceRange(auth, 'function isLoginRefreshCurrent', 'function normalizeLoginProviderKey') + sourceRange(auth, 'async function pollQishuiQr', 'function toggleQQCookiePanel'), ctx);
  await ctx.pollQishuiQr(1);
  assert.equal(ctx.qishuiLoginStatus.loggedIn, true);
  assert.equal(timers.length, 1);
  ctx.loginProvider = 'netease';
  ctx.loginRefreshRequestSeq++;
  ctx.qrKey = 'new';
  timers[0]();
  assert.equal(ctx.qrKey, 'new');
});

test('desktop Skyline applies middle lyric and word-timing changes with identical endpoints', () => {
  const ctx = vm.createContext({ state: { taskbarMode: false }, window: {}, document: { getElementById() {}, body: { classList: { toggle() {} } } } });
  vm.runInContext(readSource('public/js/skyline-lyrics.js'), ctx);
  const api = ctx.MineradioSkyline = ctx.window.MineradioSkyline;
  let replacements = 0, layouts = 0;
  api.create = () => ({ lines: [], pad: 0.25, relayout() { layouts++; }, setLines(lines) { replacements++; this.lines = lines; } });
  vm.runInContext(sourceRange(readSource('public/desktop-lyrics.html'), 'var skyline =', 'function applyDesktopPlayback'), ctx);
  const lines = [{ t: 0, text: 'First' }, { t: 1, text: 'Middle', words: [{ text: 'Middle', t: 1, d: 0.5 }] }, { t: 2, text: 'Last' }];
  const edited = structuredClone(lines);
  edited[1].words[0].d = 0.9;
  assert.notEqual(api.signature(lines), api.signature(edited));
  const middle = structuredClone(edited);
  middle[1].text = 'Changed middle';
  assert.notEqual(api.signature(edited), api.signature(middle));
  for (const data of [lines, edited, middle, structuredClone(middle)]) ctx.applySkylineState({ skyline: true, skylineKey: 'old-key', skylineLines: data });
  assert.equal(replacements, 3);
  assert.equal(ctx.skyline.inst.lines[1].text, 'Changed middle');
  ctx.state.taskbarMode = true;
  const taskbarEdit = structuredClone(middle);
  taskbarEdit[1].words[0].d = 1.2;
  ctx.applySkylineState({ skyline: true, skylineKey: 'old-key', skylineLines: taskbarEdit });
  assert.equal(ctx.skyline.on, true, 'taskbar mode keeps Skyline enabled');
  assert.equal(ctx.skyline.inst.pad, 0);
  assert.equal(replacements, 4, 'taskbar receives updated word timing');
  assert.equal(ctx.skyline.inst.lines[1].words[0].d, 1.2);
  ctx.state.taskbarMode = false;
  ctx.applySkylineState({ skyline: true, skylineKey: 'old-key', skylineLines: taskbarEdit });
  assert.equal(ctx.skyline.on, true, 'returning to desktop restores Skyline');
  assert.equal(ctx.skyline.inst.pad, 0.25);
  assert.equal(layouts, 2);
});

test('Skyline shares uploads between its canvas and word textures and hides on pause when requested', () => {
  let uploads = 0;
  const camera = { copy() { return this; }, clone() { return this; }, lerp() {}, x: 0, y: 0, z: 1 };
  const group = { children: [], add(mesh) { mesh.parent = this; }, remove(mesh) { mesh.parent = null; } };
  const root = { ...group, worldToLocal: (value) => value };
  const canvas = { width: 1, height: 1 };
  const view = { w: 960, focusSize: 1, items: [1, 2, 3].map((id) => ({ id, text: String(id), x: 0, y: 0, z: 0.5, blur: 0, alpha: 1 })) };
  const ctx = vm.createContext({
    fx: { lyricSkyline: true, particleLyrics: true, lyricPauseHold: true }, lyricsLines: [{ t: 0, text: 'Line' }],
    window: { MineradioSkyline: { FOCUS_Z: 0.55, themeFromColors: () => ({ cloud: '#fff' }) } },
    stageLyrics: { group }, camera: { position: camera }, innerWidth: 960, playing: true,
    audio: { paused: false, ended: false, currentTime: 15, playbackRate: 1 }, performance: { now: () => 100 },
    desktopOverlayColors() {}, document: { getElementById() { return null; } },
  });
  vm.runInContext(rendererModule('02-visual/16-skyline-lyrics.js'), ctx);
  ctx.skylineTmp = { cam: camera };
  Object.assign(ctx.skylineLyrics, {
    root, canvas, mesh: {}, color: { setStyle() {} }, texture: { set needsUpdate(value) { if (value) uploads++; } },
    inst: { setLines() {}, render() { canvas.width = this.size.w; canvas.height = this.size.h; }, cloudView: () => view, needsPausedFrame: () => false },
  });
  ctx.placeSkylinePlane = () => ({ unit: 1, mainRow: 0 });
  ctx.createSkylineWord = () => {
    uploads++;
    return { w: 1, h: 1, tex: { dispose() {} }, mesh: { position: { set() {} }, scale: { set() {} }, material: { dispose() {}, uniforms: { blurUv: { value: { set() {} } }, lod: {}, opacity: {} } } } };
  };
  ctx.updateSkylineLyrics(1 / 60, true);
  assert.equal(uploads, 1);
  ctx.updateSkylineLyrics(1 / 60, false);
  assert.equal(uploads, 1);
  for (let frame = 0; frame < 8; frame++) {
    const before = uploads;
    ctx.updateSkylineLyrics(1 / 60, true);
    assert.ok(uploads - before <= 1);
  }
  assert.equal(Object.keys(ctx.skylineLyrics.words).length, 3);
  ctx.audio.paused = true;
  ctx.playing = false;
  ctx.updateSkylineLyrics(1 / 60, true);
  const paused = uploads;
  ctx.updateSkylineLyrics(1 / 60, true);
  assert.equal(uploads, paused);
  ctx.fx.lyricPauseHold = false;
  ctx.updateSkylineLyrics(1 / 60, true);
  assert.equal(root.parent, null);
  assert.equal(uploads, paused);
});
