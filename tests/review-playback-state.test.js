'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const directory = path.join(__dirname, '..', 'public/js/modules/05-playback');
const read = file => fs.readFileSync(path.join(directory, file), 'utf8');
function evaluate(context, file, from, to) {
  const text = read(file); const start = text.indexOf(from); const end = text.indexOf(to, start);
  assert(start >= 0 && end > start);
  vm.runInContext(text.slice(start, end), context);
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const noop = () => {};

test('next-up inserts the first song and removing earlier rows preserves the current song and its successor', async () => {
  const context = vm.createContext({
    playQueue: [], currentIdx: -1, trackSwitchToken: 0,
    cloneSong: song => ({ ...song }), queueItemKey: song => song.id,
    safeRenderQueuePanel: noop, safeShelfRebuild: noop, updateCustomCoverButton: noop,
    updateCustomLyricControls: noop, updateEmptyHomeVisibility: noop, saveLastPlaybackSnapshot: noop,
    forcePlaybackControlsInteractive: noop, console,
    finalizeListenSession: noop, pauseCurrentAudioForTrackSwitch: () => { context.paused = true; },
    clearQueue: () => { context.playQueue = []; context.currentIdx = -1; },
    playQueueAt: index => { context.currentIdx = index; context.started = context.playQueue[index].id; return Promise.resolve(true); },
  });
  evaluate(context, '10-queue-actions.js', 'function queueSong(', 'function queueSearchResult(');
  evaluate(context, '14-player-controls.js', 'function removeFromQueue(', 'function playModeLabel(');
  assert.equal(context.queueSongNext({ id: 'A' }), 0);
  assert.equal(context.playQueue.length, 1);
  context.playQueue = ['A', 'B', 'C', 'D'].map(id => ({ id })); context.currentIdx = 1;
  context.removeFromQueue(0);
  assert.equal(context.currentIdx, 0);
  assert.equal(context.playQueue[context.currentIdx].id, 'B');
  assert.equal(context.playQueue[context.currentIdx + 1].id, 'C');
  context.removeFromQueue(0);
  assert.equal(context.started, 'C');
  context.removeFromQueue(1);
  context.removeFromQueue(0);
  assert.equal(context.currentIdx, -1);
  assert.equal(context.paused, true);
});

test('a superseded local track waiting for the audio output cannot replace or record the newer track', async () => {
  const firstOutput = deferred(); const secondOutput = deferred(); let outputCount = 0; const sessions = [];
  const a = { id: 'A', localUrl: 'mineradio-local://A' }, b = { id: 'B', localUrl: 'mineradio-local://B' };
  const media = { pause: noop, load: noop };
  const context = vm.createContext({
    playQueue: [a, b], currentIdx: 0, currentLocalSong: null, trackSwitchToken: 1, audio: media,
    audioFadeSerial: 0, beatMapToken: 0, djBeatMapToken: 0, miniQueueOpen: false,
    document: { getElementById: () => ({ classList: { remove: noop } }) },
    applyAudioOutputDevice: () => ++outputCount === 1 ? firstOutput.promise : secondOutput.promise,
    playAudio: async options => { assert.equal(options.expectedMedia, media); assert.equal(options.expectedToken, 2); return true; },
    beginListenSession: song => sessions.push(song.id), queueItemKey: song => song.id,
    setTimeout: noop, console,
    syncActiveAudioRepeatMode: value => { value.loop = true; },
  });
  for (const name of ['updateCustomCoverButton', 'clearAudioFadeTimers', 'resetPlaybackAudioGraphForSourceSwitch', 'bindPlaybackProgressEvents', 'applyVolumeToAudio', 'updatePlaybackProgressUi', 'scheduleAudioResumePosition', 'resetAudioVisualState', 'resetBeatCameraSync', 'cancelBeatAnalysisTimer', 'cancelDjBeatAnalysisTimer', 'resetDjBeatMapState', 'setDjModeActive', 'forcePlaybackControlsInteractive', 'applyLocalTrackLyricOnDemand', 'safeRenderQueuePanel', 'scheduleShelfRebuild', 'scheduleAlbumGaplessPreloadForCurrent']) context[name] = noop;
  evaluate(context, '13-playback-start-audio.js', 'async function playLocalQueueSong(', 'async function playQueueAt(');
  const first = context.playLocalQueueSong(a, 0, 1, false, {}, 0);
  context.currentIdx = 1; context.trackSwitchToken = 2;
  const second = context.playLocalQueueSong(b, 1, 2, false, {}, 0);
  secondOutput.resolve(); assert.equal(await second, true);
  firstOutput.resolve(); assert.equal(await first, false);
  assert.equal(media.src, b.localUrl);
  assert.equal(media.loop, true);
  assert.deepEqual(sessions, ['B']);
  context.playQueue = [b, a]; context.currentIdx = 0;
  context.lyricSourceMode = 'online'; media.duration = 123;
  media.onloadedmetadata();
  assert.equal(b.duration, 123, 'reordering a queue must keep the current local track callbacks active');
});

test('duplicate search pages advance cursors; repeated duplicates pause automatic loading without discarding later pages', async () => {
  const context = vm.createContext({ console, searchRequestSeq: 1, searchLastResultQuery: 'song|q', searchMode: 'song', $input: { value: 'q' }, MUSIC_SEARCH_MAX_RESULTS: 180,
    searchMusicRenderState: { key: 'song|q', query: 'q', mode: 'song', songs: [{ id: 'A' }], providerPages: { netease: { nextOffset: 1 } }, remoteHasMore: true },
    refreshSearchLoadMoreSentinel: noop,
    mergeUniqueSearchSongPools: (a, b) => [...new Map(a.concat(b).map(s => [s.id, s])).values()],
    appendNextSearchResults: () => true,
  });
  evaluate(context, '07-search.js', 'async function loadNextMusicSearchPage(', 'function appendNextSearchResults(');
  const offsets = [];
  context.fetchMusicSearchResults = async (_q, _mode, pages) => {
    const offset = pages.netease.nextOffset; offsets.push(offset);
    return { songs: [{ id: offset < 2 ? 'A' : 'B' }], providerPages: { netease: { nextOffset: offset + 1, hasMore: true } }, hasMore: true };
  };
  assert.equal(await context.loadNextMusicSearchPage('song|q'), true);
  assert.deepEqual(offsets, [1, 2]);
  assert.equal(context.searchMusicRenderState.songs.length, 2);
  context.fetchMusicSearchResults = async (_q, _mode, pages) => ({ songs: [{ id: 'A' }], providerPages: { netease: { nextOffset: pages.netease.nextOffset + 1, hasMore: true } }, hasMore: true });
  const before = context.searchMusicRenderState.providerPages.netease.nextOffset;
  assert.equal(await context.loadNextMusicSearchPage('song|q'), false);
  assert.equal(context.searchMusicRenderState.providerPages.netease.nextOffset, before + 4);
  assert.equal(context.searchMusicRenderState.remoteHasMore, true);
  assert.equal(context.searchMusicRenderState.manualMore, true);
});

test('search thumbnail markup escapes attribute delimiters and rejects active URL schemes', () => {
  const context = vm.createContext({ coverUrlWithSize: value => value, isInlineCoverSrc: () => false, isProxyableCoverUrl: value => /^https?:/.test(value), escHtml: value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') });
  evaluate(context, '07-search.js', 'function searchThumbHtml(', 'function renderPodcastRadios(');
  const html = context.searchThumbHtml('https://media.example/" onload="example');
  assert.match(html, /&quot; onload=&quot;/);
  assert.doesNotMatch(html, /" onload="/);
  assert.equal(context.searchImageAttribute('javascript:example'), '');
});

test('daily totals and streaks include repeated plays from the persistent daily rollup', () => {
  const now = new Date(); const today = new Date(now); today.setHours(0, 0, 0, 0);
  const context = vm.createContext({ listenStatsState: { history: [{ id: 'A', name: 'A', artist: 'artist', playedAt: now.getTime(), listenMs: 60000 }] }, listenSession: { startedAt: now.getTime(), listenMs: 30000, key: 'B' } });
  evaluate(context, '03a-home-dashboard.js', 'function homeDashboardDayKey(', 'function homeDashboardListenDurationText(');
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  context.loadListenRollupV2 = () => ({ daily: { [context.homeDashboardDayKey(today.getTime())]: { listenMs: 180000, sessions: 3 }, [context.homeDashboardDayKey(yesterday.getTime())]: { listenMs: 60000, sessions: 1 } } });
  const result = context.homeDashboardTodayListenMetrics();
  assert.equal(result.listenMs, 210000);
  assert.equal(result.streak, 2);
});
