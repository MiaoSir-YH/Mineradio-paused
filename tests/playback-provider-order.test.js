'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, 'public/js/modules', file), 'utf8');
const search = read('05-playback/07-search.js');
const noop = () => {};

function track(provider, name = '晴天') {
  return { provider, id: provider + '-' + name, mid: provider + '-' + name, name, artist: '周杰伦', album: '叶惠美', duration: 269 };
}

function media() {
  return {
    src: '', paused: true, ended: false, currentTime: 0, duration: 269, volume: 1, readyState: 4,
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
    load: noop, addEventListener: noop,
    removeAttribute(key) { if (key === 'src') this.src = ''; },
  };
}

function createRuntime(order = ['qq', 'netease', 'kugou', 'qishui']) {
  const values = new Map([['mineradio-account-provider-order-v1', JSON.stringify(order)]]);
  const node = {
    dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, querySelectorAll: () => [],
  };
  const calls = [];
  const warnings = [];
  const timers = [];
  const ctx = vm.createContext({
    console: { log: noop, warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout: noop,
    setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
    localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
    document: { getElementById: () => node, body: { appendChild: noop } },
    window: {},
    Audio: function () { return media(); },
    loginStatus: { loggedIn: true },
    qqLoginStatus: { loggedIn: true, playbackKeyReady: true, isVip: true },
    kugouLoginStatus: { loggedIn: true, playbackKeyReady: true },
    qishuiLoginStatus: { loggedIn: true, playbackMode: 'direct-url' },
    normalizePlaybackProvider: provider => ['qq', 'kugou', 'qishui', 'spotify'].includes(provider) ? provider : 'netease',
    normalizePlaybackQualityForProvider: value => value || 'standard',
    normalizePlaybackQuality: value => value || 'standard',
    getProviderPlaybackQuality: () => 'standard',
    hasProviderSvip: () => false,
    playbackQualityCapValue: () => '', playbackQualityAboveCap: () => false,
    playbackQualityWasDowngraded: () => false, playbackResolvedQualityText: () => 'standard',
    playbackQualityLabel: value => value,
    hydrateCustomCover: value => value, cloneSong: value => ({ ...value }),
    queueItemKey: song => song && song.provider + ':' + song.id,
    playQueue: [], currentIdx: -1, trackSwitchToken: 0, playMode: 'order',
    audio: media(), audioFadeSerial: 0, playing: false,
    albumGaplessState: { enabled: false, serial: 0, monitorTimer: 0, preload: null },
    localBeatAnalysis: { active: false }, beatMapToken: 0, beatMapCache: {},
    pendingPlaybackResumeAt: 0, startupRestoreHomePending: false,
    restoredLastPlaybackSnapshot: null, miniQueueOpen: false,
    uniforms: { uAlpha: { value: 0 } }, targetVolume: 0.8,
    playbackResumeRecovery: { serial: 0, timerIds: [] },
    getCustomCoverForSong: () => '', coverUrlWithSize: value => value,
    beatMapSongKey: song => song && song.provider + ':' + song.id, isPodcastSong: () => false,
    readBeatDiskCache: async () => null,
    clampRange: (value, min, max) => Math.max(min, Math.min(max, value)),
    audioSilentFloor: () => 0.0001,
    apiJson: async function (url, opts) {
      const parsed = new URL(url, 'http://localhost');
      const provider = parsed.pathname.split('/')[2] === 'search' || parsed.pathname === '/api/song/url'
        ? 'netease' : parsed.pathname.split('/')[2];
      calls.push({ url, provider, opts, kind: parsed.pathname.endsWith('/search') ? 'search' : 'url' });
      if (parsed.pathname.endsWith('/search')) {
        const name = parsed.searchParams.get('keywords').split(' ')[0];
        return { songs: [track(provider, name)] };
      }
      return { url: 'https://audio.invalid/' + provider, level: 'standard' };
    },
    calls, warnings, timers,
  });
  const noops = [
    'hideLoading', 'showLoading', 'forcePlaybackControlsInteractive', 'clearAudioFadeTimers',
    'cancelBeatAnalysisTimer', 'cancelBeatPrefetchTimer', 'closeGsapModal', 'markRenderInteraction',
    'safeRenderQueuePanel', 'safeShelfRebuild', 'scheduleShelfRebuild', 'suppressShelfPreviewForPlaybackSwitch',
    'finalizeListenSession', 'beginListenSession', 'switchPlaybackVisualToEmily',
    'setDjModeActive', 'updateCustomCoverButton', 'updateLikeButtons', 'syncLikeStatusForSong',
    'resetCinemaTrackProfile', 'updateEmptyHomeVisibility', 'updateControlTrackInfo',
    'resetLyricsForTrackSwitch', 'fetchLyric', 'scheduleTrackSwitchFallbackLyrics',
    'applyPreferredLyricsForCurrent',
    'loadCoverFromUrl', 'applyCoverDataUrl', 'tweenParticleAlpha',
    'resetPlaybackAudioGraphForSourceSwitch', 'bindPlaybackProgressEvents', 'applyVolumeToAudio',
    'applyAudioOutputDevice', 'updatePlaybackProgressUi', 'setAudioOutputGainImmediate',
    'resetAudioVisualState', 'resetBeatCameraSync', 'scheduleBeatAnalysis', 'hideBeatChip',
    'markPlaybackQualityRuntimeCap', 'showToast', 'clearPlaybackResumeWatchdogs',
  ];
  for (const name of noops) ctx[name] = noop;
  for (const file of [
    '08-account/01-login-modal-utils.js',
    '05-playback/11-provider-fallback.js',
    '05-playback/12-playback-switch-core.js',
    '05-playback/13-playback-start-audio.js',
    '05-playback/14-player-controls.js',
  ]) vm.runInContext(read(file), ctx, { filename: file });
  vm.runInContext(search.slice(search.indexOf('function songProviderKey('), search.indexOf('function songSourceTagHtml(')), ctx);
  vm.runInContext(search.slice(search.indexOf('function simpleSearchNorm('), search.indexOf('function controlSourceIssueLabel(')), ctx);
  ctx.playAudio = async function () { ctx.audio.paused = false; return true; };
  ctx.showSourceFallbackNotice = noop;
  return ctx;
}

test('catalogue origin does not override the saved account order', async () => {
  const ctx = createRuntime();
  const result = await ctx.resolvePlaybackByProviderOrder(track('netease'));
  assert.equal(result.song.provider, 'qq');
  assert.deepEqual(ctx.calls.map(call => call.provider), ['qq', 'qq']);
  assert.deepEqual(Array.from(result.attempted), ['qq']);
});

test('tries each configured provider in order on missing URLs, errors and trials', async () => {
  const ctx = createRuntime(['kugou', 'qishui', 'qq', 'netease']);
  const api = ctx.apiJson;
  ctx.apiJson = async function (url, opts) {
    const data = await api(url, opts);
    if (url.includes('/song/url')) {
      if (url.includes('/kugou/')) throw new Error('request timed out');
      if (url.includes('/qishui/')) return { url: 'https://trial.invalid', trial: true };
      if (url.includes('/qq/')) return { url: '', reason: 'copyright_unavailable' };
    }
    return data;
  };
  const result = await ctx.resolvePlaybackByProviderOrder(track('netease'));
  assert.equal(result.song.provider, 'netease');
  assert.deepEqual(ctx.calls.filter(call => call.kind === 'url').map(call => call.provider), ['kugou', 'qishui', 'qq', 'netease']);
});

test('a slow first provider cannot skip the next provider in a new playback request', async () => {
  const ctx = createRuntime();
  const api = ctx.apiJson;
  let now = Date.now();
  ctx.Date = { now: () => now };
  ctx.apiJson = async function (url, opts) {
    const data = await api(url, opts);
    if (url.includes('/qq/song/url')) {
      now += 22000;
      return { url: '' };
    }
    return data;
  };
  const result = await ctx.resolvePlaybackByProviderOrder(track('netease'));
  assert.equal(result.song.provider, 'netease');
  assert.deepEqual(ctx.calls.filter(call => call.kind === 'url').map(call => call.provider), ['qq', 'netease']);
});

test('skips missing playback authorizations and accepts authenticated Qishui direct playback', async () => {
  const ctx = createRuntime(['qq', 'kugou', 'qishui', 'netease']);
  ctx.qqLoginStatus.playbackKeyReady = false;
  ctx.kugouLoginStatus.loggedIn = false;
  const result = await ctx.resolvePlaybackByProviderOrder(track('netease'));
  assert.equal(result.song.provider, 'qishui');
  assert.deepEqual(ctx.calls.map(call => call.provider), ['qishui', 'qishui']);
  ctx.qishuiLoginStatus = { loggedIn: true, playbackMode: 'recommend-match' };
  ctx.calls.length = 0;
  assert.equal((await ctx.resolvePlaybackByProviderOrder(track('netease'))).song.provider, 'netease');
  assert.deepEqual(ctx.calls.map(call => call.provider), ['netease']);
});

test('cross-platform matching rejects other singers, covers and live versions', async () => {
  const ctx = createRuntime();
  const api = ctx.apiJson;
  ctx.apiJson = async function (url, opts) {
    const data = await api(url, opts);
    if (url.includes('/qq/search')) return { songs: [
      { ...track('qq'), artist: '其他歌手' },
      { ...track('qq'), name: '晴天 (Cover)' },
      { ...track('qq'), name: '晴天 (Live)' },
    ] };
    return data;
  };
  const result = await ctx.resolvePlaybackByProviderOrder(track('netease'));
  assert.equal(result.song.provider, 'netease');
  assert.deepEqual(ctx.calls.map(call => call.provider), ['qq', 'netease']);
});

test('a late response cannot commit after a newer track starts', async () => {
  const ctx = createRuntime();
  const api = ctx.apiJson;
  let release;
  ctx.apiJson = async function (url, opts) {
    if (url.includes('/qq/search') && url.includes(encodeURIComponent('晴天'))) {
      return new Promise(resolve => { release = resolve; });
    }
    return api(url, opts);
  };
  ctx.playQueue = [track('netease'), track('netease', '夜曲')];
  const first = ctx.playQueueAt(0, { manual: true });
  assert.equal(typeof release, 'function');
  assert.equal(await ctx.playQueueAt(1, { manual: true }), true);
  release({ songs: [track('qq')] });
  assert.equal(await first, false);
  assert.equal(ctx.currentIdx, 1);
  assert.equal(ctx.playQueue[0].provider, 'netease');
  assert.equal(ctx.playQueue[1].provider, 'qq');
  assert.equal(ctx.warnings.length, 0);
});

test('next-track playback reads a newly saved UI order, including for a QQ catalogue entry', async () => {
  const ctx = createRuntime();
  ctx.playQueue = [track('netease'), track('qq', '夜曲')];
  assert.equal(await ctx.playQueueAt(0, { manual: true }), true);
  assert.equal(ctx.playQueue[0].provider, 'qq');
  ctx.saveAccountProviderOrder(['netease', 'qq', 'kugou', 'qishui']);
  ctx.calls.length = 0;
  let next;
  const play = ctx.playQueueAt;
  ctx.playQueueAt = function (...args) { return next = play(...args); };
  ctx.nextTrack(true);
  assert.equal(await next, true);
  assert.equal(ctx.playQueue[1].provider, 'netease');
  assert.deepEqual(ctx.calls.map(call => call.provider), ['netease', 'netease']);
  assert.equal(ctx.warnings.length, 0);
});

test('natural next-track playback uses the same priority for every item in a Netease queue', async () => {
  const ctx = createRuntime();
  ctx.playQueue = [track('netease'), track('netease', '夜曲')];
  assert.equal(await ctx.playQueueAt(0, { manual: true }), true);
  let next;
  const play = ctx.playQueueAt;
  ctx.playQueueAt = function (...args) { return next = play(...args); };
  ctx.nextTrack();
  assert.equal(await next, true);
  assert.deepEqual(ctx.playQueue.map(song => song.provider), ['qq', 'qq']);
  assert.deepEqual(ctx.calls.filter(call => call.kind === 'url').map(call => call.provider), ['qq', 'qq']);
  assert.equal(ctx.warnings.length, 0);
});

test('changing order during a lookup restarts with the new first provider', async () => {
  const ctx = createRuntime();
  const api = ctx.apiJson;
  let release;
  ctx.apiJson = function (url, opts) {
    if (url.includes('/qq/search')) return new Promise(resolve => { release = resolve; });
    return api(url, opts);
  };
  ctx.playQueue = [track('netease')];
  const pending = ctx.playQueueAt(0, { manual: true });
  ctx.saveAccountProviderOrder(['netease', 'qq', 'kugou', 'qishui']);
  release({ songs: [track('qq')] });
  assert.equal(await pending, true);
  assert.equal(ctx.playQueue[0].provider, 'netease');
  assert.deepEqual(ctx.calls.map(call => call.provider), ['netease']);
  assert.equal(ctx.warnings.length, 0);
});

test('explicit per-song switches and quality retries keep their chosen provider', async () => {
  for (const opts of [{ sourceSwitch: true }, { qualitySwitch: true }, { resumeRecovery: true }]) {
    const ctx = createRuntime();
    ctx.playQueue = [track('netease')];
    assert.equal(await ctx.playQueueAt(0, { manual: true, ...opts }), true);
    assert.deepEqual(ctx.calls.map(call => call.provider), ['netease']);
    assert.equal(ctx.warnings.length, 0);
  }
});

test('manual next still falls through to the next provider when the selected audio cannot start', async () => {
  const ctx = createRuntime();
  ctx.playQueue = [track('netease')];
  ctx.playAudio = async function () {
    const started = ctx.playQueue[ctx.currentIdx].provider !== 'qq';
    ctx.audio.paused = !started;
    return started;
  };
  assert.equal(await ctx.playQueueAt(0, { manual: true }), true);
  assert.equal(ctx.playQueue[0].provider, 'netease');
  assert.deepEqual(ctx.calls.filter(call => call.kind === 'url').map(call => call.provider), ['qq', 'netease']);
  assert.equal(ctx.warnings.length, 0);
});

test('media failure does not retry an earlier provider whose URL already failed', async () => {
  const ctx = createRuntime();
  const api = ctx.apiJson;
  ctx.apiJson = async function (url, opts) {
    const data = await api(url, opts);
    return url.includes('/qq/song/url') ? { url: '' } : data;
  };
  ctx.playQueue = [track('netease')];
  ctx.playAudio = async function () {
    const started = ctx.playQueue[ctx.currentIdx].provider === 'kugou';
    ctx.audio.paused = !started;
    return started;
  };
  assert.equal(await ctx.playQueueAt(0, { manual: true }), true);
  assert.equal(ctx.playQueue[0].provider, 'kugou');
  assert.deepEqual(ctx.calls.filter(call => call.kind === 'url').map(call => call.provider), ['qq', 'netease', 'kugou']);
  assert.equal(ctx.warnings.length, 0);
});

test('all-provider failure stops finite recovery instead of looping over the queue', async () => {
  const ctx = createRuntime();
  const api = ctx.apiJson;
  ctx.apiJson = async function (url, opts) {
    const data = await api(url, opts);
    return url.includes('/song/url') ? { url: '', reason: 'copyright_unavailable' } : data;
  };
  ctx.playQueue = [track('netease'), track('netease', '夜曲'), track('netease', '稻香'), track('netease', '七里香')];
  assert.equal(await ctx.playQueueAt(0, { manual: true }), false);
  assert.equal(ctx.currentIdx, 2, 'recovery may advance at most two queue entries');
  assert.equal(ctx.activeSourceFallbackRecovery, null);
  assert.equal(ctx.audio.src, '');
  assert.deepEqual(ctx.calls.filter(call => call.kind === 'url').map(call => call.provider), [
    'qq', 'netease', 'kugou', 'qishui',
    'qq', 'netease', 'kugou', 'qishui',
    'qq', 'netease', 'kugou', 'qishui',
  ]);
  assert.equal(ctx.warnings.length, 0);
});

test('local files and podcasts are never searched on another platform', async () => {
  const ctx = createRuntime();
  for (const song of [{ type: 'local', id: 'local' }, { source: 'local', id: 'local' }, { type: 'podcast', id: 123 }]) {
    assert.equal(ctx.shouldResolvePlaybackProviderOrder(song, {}), false);
    assert.equal(await ctx.resolvePlaybackByProviderOrder(song), null);
  }
  assert.deepEqual(ctx.calls, []);
});

test('album gapless preloads the preferred provider and retains the album context', async () => {
  const ctx = createRuntime();
  ctx.playQueue = [track('netease'), { ...track('netease', '夜曲'), albumId: 'album', __albumTrackIndex: 1 }];
  ctx.currentIdx = 0;
  ctx.albumGaplessQueueCanAdvance = () => true;
  ctx.armAlbumGaplessMonitor = noop;
  assert.equal(await ctx.scheduleAlbumGaplessPreloadForCurrent(0, 'test'), true);
  const preload = ctx.albumGaplessState.preload;
  assert.equal(preload.song.provider, 'qq');
  assert.equal(preload.song.__albumGaplessKey, 'netease:album');
  assert.equal(preload.song.__albumTrackIndex, 1);
  ctx.calls.length = 0;
  let handoff;
  const play = ctx.playQueueAt;
  ctx.playQueueAt = function (...args) { return handoff = play(...args); };
  assert.equal(ctx.startAlbumGaplessHandoff(preload, 'test'), true);
  assert.equal(await handoff, true);
  assert.equal(ctx.playQueue[1].provider, 'qq');
  assert.deepEqual(ctx.calls, []);
  assert.equal(ctx.warnings.length, 0);
});

test('reordering invalidates prepared album audio and resolves the new preferred provider', async () => {
  const ctx = createRuntime();
  const source = track('netease');
  const first = await ctx.resolvePlaybackByProviderOrder(source);
  assert.equal(first.song.provider, 'qq');
  const oldMedia = media();
  oldMedia.src = 'https://old.invalid';
  ctx.albumGaplessState.preload = { media: oldMedia };
  ctx.saveAccountProviderOrder(['netease', 'qq', 'kugou', 'qishui']);
  assert.equal(oldMedia.src, '');
  assert.equal(ctx.albumGaplessState.preload, null);
  const second = await ctx.resolvePlaybackByProviderOrder(source);
  assert.equal(second.song.provider, 'netease');
  assert.notEqual(first.data.url, second.data.url);
  ctx.playQueue = [source];
  assert.equal(await ctx.playQueueAt(0, {
    albumGaplessHandoff: true, preloadedAudio: media(), preloadedData: first.data,
    preloadedSong: first.song, preloadedProxyAudioUrl: '/api/audio?url=' + encodeURIComponent(first.data.url),
  }), true);
  assert.equal(ctx.playQueue[0].provider, 'qq', 'adopting a prepared stream must use its actual provider metadata');
  assert.equal(ctx.warnings.length, 0);
});
