'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/modules/05-playback/14a-system-media-session.js'), 'utf8');
function media() {
  const events = new Map();
  return { src: 'http://localhost/audio/a', currentSrc: '', duration: 180, currentTime: 30, playbackRate: 1, paused: false, ended: false,
    __mineradioQueueItemKey: 'qq:a', __mineradioTrackSwitchToken: 1,
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    removeEventListener(name, fn) { events.get(name)?.delete(fn); },
    emit(name) { for (const fn of events.get(name) || []) fn(); }, listenerCount(name) { return events.get(name)?.size || 0; }
  };
}
function setup(available = true) {
  const actions = {}, positions = [], calls = [];
  const session = { setActionHandler(name, fn) { actions[name] = fn; }, setPositionState(value) { positions.push(value); } };
  const ctx = vm.createContext({ console, URL, Date, isFinite, window: { navigator: { mediaSession: available ? session : undefined }, location: { href: 'http://localhost:3000/' }, MediaMetadata: class { constructor(value) { Object.assign(this, value); } } },
    audio: media(), playQueue: [{ id: 'a', provider: 'qq', name: 'Song A', artist: 'Singer', album: 'Album', cover: 'https://cover.invalid/a.jpg' }, { id: 'b', provider: 'qq', name: 'Song B', artist: 'Singer B' }], currentIdx: 0, currentLocalSong: null, trackSwitchToken: 1,
    queueHydrationState: { active: false }, queueItemKey: song => song.provider + ':' + song.id,
    getCustomCoverForSong: song => song.customCover || '', coverProxySrc: src => '/api/cover?url=' + encodeURIComponent(src),
    progressDragState: { active: false, previewDuration: 900, media: { src: 'old-media' }, mediaSrc: 'old-src' },
    togglePlay() { calls.push('toggle'); ctx.audio.paused = !ctx.audio.paused; ctx.audio.emit(ctx.audio.paused ? 'pause' : 'play'); },
    nextTrack(user) { calls.push(['next', user]); }, prevTrack(user) { calls.push(['previous', user]); },
    commitProgressSeek(target, resume) {
      assert.equal(ctx.progressDragState.media, ctx.audio); assert.equal(ctx.progressDragState.mediaSrc, ctx.audio.src);
      assert.equal(ctx.progressDragState.previewDuration, ctx.audio.duration);
      calls.push(['seek', target, resume]); ctx.audio.currentTime = target;
    }, clearAlbumGaplessPreload() { calls.push('clear-gapless'); }
  });
  vm.runInContext(source, ctx);
  return { ctx, session, actions, positions, calls };
}
test('publishes song, cover, state and a valid system timeline', () => {
  const { ctx, session, positions } = setup();
  assert.equal(session.metadata.title, 'Song A'); assert.equal(session.metadata.artist, 'Singer'); assert.equal(session.metadata.album, 'Album');
  assert.equal(new URL(session.metadata.artwork[0].src).searchParams.get('url'), 'https://cover.invalid/a.jpg');
  assert.equal(session.playbackState, 'playing'); assert.deepEqual({ ...positions.at(-1) }, { duration: 180, position: 30, playbackRate: 1 });
  ctx.audio.currentTime = 999; ctx.audio.playbackRate = 1.5; ctx.audio.emit('ratechange');
  assert.deepEqual({ ...positions.at(-1) }, { duration: 180, position: 180, playbackRate: 1.5 });
  ctx.playQueue[0].customCover = 'data:image/png;base64,AA=='; ctx.syncSystemMediaSession('cover-change');
  assert.equal(session.metadata.artwork[0].src, 'data:image/png;base64,AA==');
  ctx.playQueue[0].customCover = 'mineradio-local://cover/fixture'; ctx.syncSystemMediaSession('local-cover');
  assert.equal(session.metadata.artwork[0].src, 'mineradio-local://cover/fixture');
});
test('system play and pause are idempotent and controls reuse the player entry points', () => {
  const { ctx, actions, calls, session } = setup();
  actions.play(); assert.equal(calls.length, 0);
  actions.pause(); actions.pause(); assert.equal(calls.filter(x => x === 'toggle').length, 1); assert.equal(session.playbackState, 'paused');
  actions.play(); actions.play(); assert.equal(calls.filter(x => x === 'toggle').length, 2);
  actions.nexttrack(); actions.previoustrack();
  assert.deepEqual(calls.slice(-2), [['next', true], ['previous', true]]);
  actions.seekto({ seekTime: 250 }); assert.deepEqual(calls.at(-1), ['seek', 180, true]);
  assert.equal(ctx.progressDragState.media, null);
  actions.seekbackward({ seekOffset: 20 }); assert.deepEqual(calls.at(-1), ['seek', 160, true]);
  ctx.audio.paused = true; actions.seekto({ seekTime: -20 }); assert.deepEqual(calls.at(-1), ['seek', 0, false]);
  ctx.progressDragState.active = true; const count = calls.length; actions.seekforward({}); assert.equal(calls.length, count);
});
test('invalid or unavailable durations clear the timeline and disable seeking', () => {
  const { ctx, session, actions, positions } = setup();
  for (const duration of [NaN, Infinity, 0, -1]) {
    ctx.audio.duration = duration; ctx.audio.emit('durationchange'); assert.equal(positions.at(-1), undefined); assert.equal(actions.seekto, null);
  }
  ctx.audio.duration = 100; ctx.audio.currentTime = Infinity; ctx.audio.playbackRate = NaN; ctx.audio.emit('durationchange');
  assert.deepEqual({ ...positions.at(-1) }, { duration: 100, playbackRate: 1, position: 0 });
  ctx.trackSwitchToken++; ctx.syncSystemMediaSession('switch-start'); assert.equal(session.playbackState, 'none'); assert.equal(positions.at(-1), undefined);
});
test('audio replacement including a playing gapless deck detaches old events', () => {
  const { ctx, session, positions } = setup(); const old = ctx.audio;
  ctx.currentIdx = 1; ctx.trackSwitchToken = 2; const next = media(); next.__mineradioQueueItemKey = 'qq:b'; next.__mineradioTrackSwitchToken = 2; next.currentTime = 2;
  ctx.audio = next; ctx.syncSystemMediaSession('audio-handoff');
  assert.equal(session.metadata.title, 'Song B'); assert.equal(session.playbackState, 'playing'); assert.equal(positions.at(-1).position, 2);
  assert.equal(old.listenerCount('play'), 0); assert.equal(next.listenerCount('play'), 1);
  old.emit('pause'); assert.equal(session.metadata.title, 'Song B');
  ctx.playQueue = []; ctx.currentIdx = -1; ctx.syncSystemMediaSession('queue-cleared');
  assert.equal(session.metadata.title, 'Song B'); assert.equal(actionsOrNull(ctx), false);
  next.src = ''; next.emit('emptied'); assert.equal(session.metadata, null); assert.equal(session.playbackState, 'none');
});
function actionsOrNull(ctx) { return ctx.systemMediaSessionState.actions.nexttrack; }
test('unsupported hosts retain playback without throwing', () => {
  const { ctx } = setup(false); assert.doesNotThrow(() => ctx.syncSystemMediaSession('play')); assert.doesNotThrow(() => ctx.audio.emit('play'));
});
test('explicit pause during a track handoff cannot start the newly selected song', async () => {
  const { ctx } = setup(); const calls = [];
  Object.assign(ctx, { playToggleBusy: false, audioFadeSerial: 0, clearAudioFadeTimers() {}, setAudioOutputGainImmediate() {}, forcePlaybackControlsInteractive() {}, playbackMediaMatchesCurrentQueueItem: () => false,
    playQueueAt: async () => calls.push('start-new-track'), fadeOutAndPauseAudio: async () => { ctx.audio.paused = true; calls.push('pause'); },
    playing: true, setPlayIcon() {}, hideLoading() {}, safePlaybackStep: (label, fn) => fn(), updateListenStatsTick() {}, syncPlaybackStateFromAudioEvent() {}, scheduleControlsHide() {}
  });
  ctx.audio.pause = () => { ctx.audio.paused = true; calls.push('pause'); };
  const controls = fs.readFileSync(path.join(__dirname, '../public/js/modules/05-playback/14-player-controls.js'), 'utf8');
  vm.runInContext(controls.slice(controls.indexOf('async function togglePlay('), controls.indexOf('function setPlayIcon(')), ctx);
  await ctx.togglePlay(false); await ctx.togglePlay(false); assert.deepEqual(calls, ['pause']);
});
test('late startup completion cannot override a deliberate system pause', async () => {
  const { ctx } = setup(); let releaseGraph;
  const graph = new Promise(resolve => { releaseGraph = resolve; }); const calls = [];
  Object.assign(ctx, { playToggleBusy: true, audioFadeSerial: 0, clearAudioFadeTimers() {}, setAudioOutputGainImmediate() {}, forcePlaybackControlsInteractive() {},
    playbackMediaMatchesCurrentQueueItem: () => true, ensurePlaybackAudioGraph: () => graph, setPlayIcon: value => calls.push(value), hideLoading() {},
    safePlaybackStep: (label, fn) => fn(), updateListenStatsTick() {}, syncPlaybackStateFromAudioEvent() {}, scheduleControlsHide() {} });
  ctx.audio.pause = () => { ctx.audio.paused = true; };
  const controls = fs.readFileSync(path.join(__dirname, '../public/js/modules/05-playback/14-player-controls.js'), 'utf8');
  vm.runInContext(controls.slice(controls.indexOf('function playbackAttemptStillCurrent('), controls.indexOf('var AUDIO_PLAY_REQUEST_TIMEOUT_MS')), ctx);
  vm.runInContext(controls.slice(controls.indexOf('async function completeAudioPlayStart('), controls.indexOf('function canResumePausedAudioFast(')), ctx);
  vm.runInContext(controls.slice(controls.indexOf('async function togglePlay('), controls.indexOf('function setPlayIcon(')), ctx);
  const startup = ctx.completeAudioPlayStart({}, 'startup', ctx.audio, 1);
  await ctx.togglePlay(false); releaseGraph(); assert.equal(await startup, false); assert.equal(ctx.audio.paused, true); assert(!calls.includes(true));
  ctx.attemptAudioPlay = async () => false;
  vm.runInContext(controls.slice(controls.indexOf('async function playAudio('), controls.indexOf('async function togglePlay(')), ctx);
  assert.equal(await ctx.playAudio({ expectedMedia: ctx.audio, expectedToken: 1 }), true, 'a user pause must not trigger source fallback');
});
test('cancelling a pause fade settles its waiter and leaves replacement playback alone', async () => {
  const timers = new Map(); let serial = 0, pauses = 0;
  const ctx = vm.createContext({ console, Promise, audioFadeTimer: null, audioPauseFadeResolve: null, audioFadeSerial: 0, AUDIO_FADE_OUT_MS: 50,
    audio: { paused: false, pause() { this.paused = true; pauses++; } },
    setTimeout(fn) { const id = ++serial; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    rampAudioOutputGain() { ctx.clearAudioFadeTimers(); }, cancelAudioElementFadeFrame() {}, clearAudioAudibilityRecoveryTimers() {}, setAudioOutputGainImmediate() {} });
  const graph = fs.readFileSync(path.join(__dirname, '../public/js/modules/05-playback/08-audio-graph-controls.js'), 'utf8');
  vm.runInContext(graph.slice(graph.indexOf('function clearAudioFadeTimers('), graph.indexOf('function cancelAudioElementFadeFrame(')), ctx);
  vm.runInContext(graph.slice(graph.indexOf('function fadeOutAndPauseAudio('), graph.indexOf('function applyVolumeToAudio(')), ctx);
  const cancelled = ctx.fadeOutAndPauseAudio(); ctx.audioFadeSerial++; ctx.clearAudioFadeTimers();
  assert.equal(await cancelled, false); assert.equal(pauses, 0); assert.equal(timers.size, 0);
  const next = ctx.fadeOutAndPauseAudio(); timers.values().next().value(); assert.equal(await next, true); assert.equal(pauses, 1);
});
