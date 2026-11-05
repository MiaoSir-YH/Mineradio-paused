// Standard Media Session is backed by Windows SMTC in Electron. No player-
// specific bridge or debugging port is needed by generic media controllers.
var systemMediaSessionState = { media: null, listeners: [], song: null, metadataKey: '', actions: {}, lastTickAt: 0 };

function systemMediaSessionApi() {
  return window.navigator && window.navigator.mediaSession || null;
}
function systemMediaSessionSong() {
  if (currentIdx >= 0 && currentIdx < playQueue.length) return playQueue[currentIdx];
  if (typeof currentLocalSong !== 'undefined' && currentLocalSong) return currentLocalSong;
  // Clearing the upcoming queue does not stop an already playing element.
  if (audio && audio === systemMediaSessionState.media && audio.src && !audio.ended) return systemMediaSessionState.song;
  return null;
}
function systemMediaArtwork(song) {
  var src = typeof getCustomCoverForSong === 'function' ? getCustomCoverForSong(song) : '';
  src = src || song.cover || '';
  if (!src) return [];
  try {
    if (/^https?:/i.test(src) && typeof coverProxySrc === 'function') src = coverProxySrc(src);
    var url = new URL(src, window.location.href);
    if (!/^(https?:|blob:|mineradio-local:)$/.test(url.protocol) && !/^data:image\/(png|jpe?g|webp|gif|avif|bmp);/i.test(src)) return [];
    return [{ src: url.href }];
  } catch (e) { return []; }
}
function systemMediaOwnsAudio(song, media) {
  if (!song || !media || !media.src) return false;
  var key = typeof queueItemKey === 'function' ? queueItemKey(song) : '';
  return !!(key && media.__mineradioQueueItemKey === key && Number(media.__mineradioTrackSwitchToken) === Number(trackSwitchToken));
}
function setSystemMediaPlaying(wanted) {
  var active = !!(audio && audio.src && !audio.paused && !audio.ended);
  if (active === wanted && (audio && audio.src || !wanted)) return;
  if (!wanted && (!audio || !audio.src)) return;
  return togglePlay(wanted);
}
function seekSystemMedia(details, offset) {
  var song = systemMediaSessionSong();
  if (!systemMediaOwnsAudio(song, audio) || !isFinite(audio.duration) || audio.duration <= 0) return;
  var target = offset == null ? Number(details && details.seekTime) : Number(audio.currentTime || 0) + offset;
  if (!isFinite(target)) return;
  if (typeof progressDragState !== 'undefined' && progressDragState.active) return;
  target = Math.max(0, Math.min(audio.duration, target));
  if (typeof resetCuefieldAutoMix === 'function') resetCuefieldAutoMix('manual-seek');
  if (typeof clearAlbumGaplessPreload === 'function') clearAlbumGaplessPreload('manual-seek');
  if (typeof commitProgressSeek === 'function') {
    // A system seek has no pointer-down step to capture the current media.
    if (typeof progressDragState !== 'undefined') {
      progressDragState.media = audio;
      progressDragState.mediaSrc = audio.currentSrc || audio.src || '';
      progressDragState.previewDuration = audio.duration;
    }
    commitProgressSeek(target, !audio.paused && !audio.ended);
    if (typeof progressDragState !== 'undefined') {
      progressDragState.media = null;
      progressDragState.mediaSrc = '';
    }
  }
  else audio.currentTime = target;
  syncSystemMediaSession('seek');
}
function updateSystemMediaActions(canSeek) {
  var session = systemMediaSessionApi();
  if (!session || !session.setActionHandler) return;
  var canSkip = playQueue.length > 1 || !!(typeof queueHydrationState !== 'undefined' && queueHydrationState.active);
  var handlers = {
    play: function () { return setSystemMediaPlaying(true); },
    pause: function () { return setSystemMediaPlaying(false); },
    previoustrack: canSkip ? function () { prevTrack(true); } : null,
    nexttrack: canSkip ? function () { nextTrack(true); } : null,
    seekto: canSeek ? function (details) { seekSystemMedia(details); } : null,
    seekbackward: canSeek ? function (details) { seekSystemMedia(null, -Math.max(0, Number(details && details.seekOffset) || 10)); } : null,
    seekforward: canSeek ? function (details) { seekSystemMedia(null, Math.max(0, Number(details && details.seekOffset) || 10)); } : null
  };
  Object.keys(handlers).forEach(function (action) {
    var enabled = !!handlers[action];
    if (systemMediaSessionState.actions[action] === enabled) return;
    try {
      session.setActionHandler(action, enabled ? function (details) {
        try {
          var result = handlers[action](details);
          if (result && result.catch) result.catch(function (error) { console.warn('[SystemMedia]', action, error); });
        } catch (error) { console.warn('[SystemMedia]', action, error); }
      } : null);
    } catch (e) { /* Some hosts expose only a subset of Media Session actions. */ }
    systemMediaSessionState.actions[action] = enabled;
  });
}
function bindSystemMediaSessionAudio(media) {
  var state = systemMediaSessionState;
  if (!state) return;
  if (state.media === media) return;
  state.listeners.forEach(function (pair) { if (state.media && state.media.removeEventListener) state.media.removeEventListener(pair[0], pair[1]); });
  state.listeners = [];
  state.media = media;
  if (!media || !media.addEventListener) return;
  ['loadedmetadata', 'durationchange', 'ratechange', 'timeupdate', 'play', 'playing', 'pause', 'seeked', 'ended', 'emptied', 'error'].forEach(function (name) {
    var listener = function () {
      if (media !== audio) return;
      syncSystemMediaSession(name);
    };
    state.listeners.push([name, listener]);
    media.addEventListener(name, listener);
  });
}
function syncSystemMediaSession(reason) {
  var session = systemMediaSessionApi();
  if (!session) return;
  var state = systemMediaSessionState;
  if (!state) return;
  var now = Date.now();
  if (reason === 'timeupdate' && now - state.lastTickAt < 1000) return;
  state.lastTickAt = now;
  var song = systemMediaSessionSong();
  bindSystemMediaSessionAudio(audio);
  if (!song) {
    state.song = null;
    state.metadataKey = '';
    try { session.metadata = null; session.playbackState = 'none'; } catch (e) { }
    try { if (session.setPositionState) session.setPositionState(); } catch (e) { }
    updateSystemMediaActions(false);
    return;
  }
  state.song = song;
  var metadata = { title: String(song.name || song.title || ''), artist: String(song.artist || ''), album: String(song.album && song.album.name || song.album || ''), artwork: systemMediaArtwork(song) };
  var key = JSON.stringify(metadata);
  if (key !== state.metadataKey && typeof window.MediaMetadata === 'function') {
    try { session.metadata = new window.MediaMetadata(metadata); state.metadataKey = key; } catch (e) { }
  }
  var owned = systemMediaOwnsAudio(song, audio);
  try { session.playbackState = owned ? (!audio.paused && !audio.ended ? 'playing' : 'paused') : 'none'; } catch (e) { }
  var duration = owned ? Number(audio.duration) : 0;
  var canSeek = isFinite(duration) && duration > 0;
  try {
    if (session.setPositionState) {
      if (canSeek) {
        var rate = Number(audio.playbackRate);
        var position = Number(audio.currentTime);
        session.setPositionState({ duration: duration, playbackRate: isFinite(rate) && rate > 0 ? rate : 1, position: isFinite(position) ? Math.max(0, Math.min(duration, position)) : 0 });
      } else session.setPositionState();
    }
  } catch (e) { }
  updateSystemMediaActions(canSeek);
}
syncSystemMediaSession('init');
