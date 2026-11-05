'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '../public/js/modules', file), 'utf8');
const noop = () => {};
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(setImmediate);
function queueContext() {
  const pages = {}, podcasts = {}, played = [], notices = [];
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, document: { getElementById: () => null }, showLoading: noop, hideLoading: noop, showToast: value => notices.push(value), updateEmptyHomeVisibility: noop,
    playQueue: [], currentIdx: -1, trackSwitchToken: 0, playMode: 'loop', queueHydrationState: { token: 0 },
    PLAYLIST_QUEUE_INITIAL_BATCH_SIZE: 24, PLAYLIST_QUEUE_BACKGROUND_BATCH_SIZE: 96, PLAYLIST_LAZY_BATCH_SIZE: 24,
    fetchPlaylistTracksPage(provider, id) { return (pages[id] = deferred()).promise; }, apiJson(url) { return (podcasts[new URL(url, 'http://localhost').searchParams.get('id') || 'collection'] = deferred()).promise; },
    cloneSong: song => ({ ...song }), userPlaylists: [], myPodcastItems: {}, normalizePlaylistProvider: value => value || 'netease', isLikedPlaylistContext: () => false, syncLikeStatusForSongs: noop,
    safeRenderQueuePanel: noop, safeSwitchPlaylistTab: noop, safeShelfRebuild: noop, forcePlaybackControlsInteractive: noop,
    playQueueAt: async index => { ctx.trackSwitchToken++; played.push(ctx.playQueue[index].name); }
  });
  vm.runInContext(read('06-lyrics/03-podcast-playlist-loaders.js'), ctx);
  return { ctx, pages, podcasts, played, notices };
}
const page = name => ({ tracks: [{ name }], hasMore: false, total: 1 });
test('a late first playlist page cannot replace or start over a newer requested playlist', async () => {
  const { ctx, pages, played } = queueContext();
  const a = ctx.loadPlaylistIntoQueueById('a', true, 'A'), b = ctx.loadPlaylistIntoQueueById('b', true, 'B');
  pages.b.resolve(page('B')); assert.equal(await b, true); pages.a.resolve(page('A')); assert.equal(await a, false);
  assert.equal(ctx.playQueue[0].name, 'B'); assert.deepEqual(played, ['B']);
});
test('a pending playlist cannot resurrect a cleared queue or overwrite a manual playback choice', async () => {
  for (const manualPlay of [false, true]) {
    const { ctx, pages, played } = queueContext();
    const load = ctx.loadPlaylistIntoQueueById('slow', true, 'slow');
    if (manualPlay) { ctx.playQueue = [{ name: 'Manual' }]; ctx.currentIdx = 0; await ctx.playQueueAt(0); }
    else { ctx.cancelPlaylistQueueHydration('clear-queue'); ctx.playQueue = []; }
    pages.slow.resolve(page('stale')); assert.equal(await load, false);
    assert.deepEqual(played, manualPlay ? ['Manual'] : []); assert.equal(ctx.playQueue.length, manualPlay ? 1 : 0);
  }
});
test('podcast and playlist first-page requests share the same current queue intent', async () => {
  const { ctx, pages, podcasts, played } = queueContext();
  const radio = ctx.loadPodcastRadioIntoQueue('radio', true, 'radio');
  const collection = ctx.openMyPodcastCollection('collection', 'collection');
  const playlist = ctx.loadPlaylistIntoQueueById('b', true, 'B');
  pages.b.resolve(page('B')); await playlist;
  podcasts.radio.resolve({ programs: [{ name: 'Old Radio' }] }); await radio;
  podcasts.collection.resolve({ itemType: 'voice', items: [{ name: 'Old Voice', type: 'podcast' }] }); await collection;
  assert.equal(ctx.playQueue[0].name, 'B'); assert.deepEqual(played, ['B']);
});
test('waiting for the old queue tail cannot advance a replacement queue', async () => {
  const { ctx, pages, played } = queueContext();
  ctx.playQueue = [{ name: 'A1' }]; ctx.currentIdx = 0;
  ctx.queueHydrationState = { token: 1, queueRef: ctx.playQueue, provider: 'netease', sourceId: 'a', nextOffset: 1, active: true };
  const controls = read('05-playback/14-player-controls.js');
  vm.runInContext(controls.slice(controls.indexOf('function nextTrack('), controls.indexOf('function prevTrack(')), ctx);
  ctx.nextTrack(true); ctx.playQueue = [{ name: 'B1' }, { name: 'B2' }]; ctx.currentIdx = 0; ctx.trackSwitchToken++;
  pages.a.resolve(page('A2')); await flush();
  assert.equal(ctx.currentIdx, 0); assert.deepEqual(played, []);
});
test('a genuine end of pagination still loops the same queue', async () => {
  const { ctx, played } = queueContext(), tail = deferred();
  ctx.playQueue = [{ name: 'A1' }]; ctx.currentIdx = 0;
  ctx.queueHydrationState = { queueRef: ctx.playQueue, active: true };
  ctx.hydratePlaylistQueueNextPage = () => tail.promise;
  const controls = read('05-playback/14-player-controls.js');
  vm.runInContext(controls.slice(controls.indexOf('function nextTrack('), controls.indexOf('function prevTrack(')), ctx);
  ctx.nextTrack(true); ctx.queueHydrationState.active = false; tail.resolve(false); await flush();
  assert.deepEqual(played, ['A1']);
});

function sourceContext() {
  const played = [], lookup = deferred();
  const a = { provider: 'netease', id: 'a', name: 'A' }, b = { provider: 'netease', id: 'b', name: 'B' }, qq = { provider: 'qq', id: 'qa', name: 'A' };
  const ctx = vm.createContext({ console, Date, document: { getElementById: () => null }, playQueue: [a, b], currentIdx: 0, trackSwitchToken: 1, miniQueueOpen: false,
    controlSourceSwitcherState: { requestId: 4, matches: { qq: { song: qq } }, open: true },
    normalizePlaybackProvider: value => value, songProviderKey: song => song.provider, queueItemKey: song => song ? song.provider + ':' + song.id : '', cloneSong: song => ({ ...song }), hydrateCustomCover: song => song,
    controlSourceProviders: () => [{ key: 'qq' }], findControlSourceMatchResult: () => lookup.promise,
    renderControlSourceSwitcher: noop, safeRenderQueuePanel: noop, updateControlTrackInfo: noop, showSourceFallbackNotice: noop, controlSourceProviderTitle: value => value, currentResumeSeconds: () => 12, forcePlaybackControlsInteractive: noop,
    playQueueAt: async index => { ctx.trackSwitchToken++; played.push(ctx.playQueue[index].name); }
  });
  const source = read('05-playback/07-search.js');
  vm.runInContext(source.slice(source.indexOf('function currentControlSong('), source.indexOf('function controlSourceSwitchQuery(')), ctx);
  vm.runInContext(source.slice(source.indexOf('function closeControlSourceSwitcher('), source.indexOf('function renderControlSourceSwitcher(')), ctx);
  vm.runInContext(source.slice(source.indexOf('async function loadControlSourceMatches('), source.indexOf('function toggleControlSourceSwitcher(')), ctx);
  vm.runInContext(source.slice(source.indexOf('async function switchCurrentSongSource('), source.indexOf("document.addEventListener('click'", source.indexOf('async function switchCurrentSongSource('))), ctx);
  Object.assign(ctx.controlSourceSwitcherState, { queue: ctx.playQueue, index: 0, songKey: 'netease:a', trackToken: 1 });
  return { ctx, played, lookup, a, b, qq };
}
test('cached source matches from a previous track cannot overwrite the next slot', async () => {
  const { ctx, played, a, b } = sourceContext(); ctx.currentIdx = 1; ctx.trackSwitchToken++;
  await ctx.switchCurrentSongSource('qq'); assert.strictEqual(ctx.playQueue[0], a); assert.strictEqual(ctx.playQueue[1], b); assert.deepEqual(played, []);
});
test('late source matching responses are ignored after a track change or closing the panel', async () => {
  for (const close of [false, true]) {
    const { ctx, played, lookup, qq, a, b } = sourceContext(); ctx.controlSourceSwitcherState.matches = {};
    const pending = ctx.switchCurrentSongSource('qq');
    if (close) ctx.closeControlSourceSwitcher(); else { ctx.currentIdx = 1; ctx.trackSwitchToken++; }
    lookup.resolve({ song: qq }); await pending;
    assert.strictEqual(ctx.playQueue[0], a); assert.strictEqual(ctx.playQueue[1], b); assert.deepEqual(played, []);
  }
});
test('a current source switch succeeds and a stale failed switch cannot roll back another queue', async () => {
  const first = sourceContext(); await first.ctx.switchCurrentSongSource('qq');
  assert.strictEqual(first.ctx.playQueue[0], first.qq); assert.deepEqual(first.played, ['A']);
  const second = sourceContext(), playback = deferred(); second.ctx.playQueueAt = () => { second.ctx.trackSwitchToken++; return playback.promise; };
  const pending = second.ctx.switchCurrentSongSource('qq');
  const replacement = [{ provider: 'qq', id: 'new', name: 'New' }]; second.ctx.playQueue = replacement; second.ctx.trackSwitchToken++;
  playback.reject(new Error('late failed switch')); await pending; assert.strictEqual(second.ctx.playQueue, replacement);
});
