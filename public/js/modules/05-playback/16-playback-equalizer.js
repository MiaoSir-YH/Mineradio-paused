var PLAYBACK_EQ_STORAGE_KEY = 'mineradio.playbackEqualizer.v1';
var PLAYBACK_EQ_FREQUENCIES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
var PLAYBACK_EQ_PRESETS = {
  flat: { label: '平直', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass: { label: '低音增强', gains: [5, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  vocal: { label: '人声', gains: [-3, -2, -1, 0, 2, 3, 4, 2, 0, -1] },
  rock: { label: '摇滚', gains: [4, 3, 2, 0, -1, -1, 1, 3, 3, 2] },
  pop: { label: '流行', gains: [-1, 1, 2, 2, 1, 0, 1, 2, 1, 0] },
  electronic: { label: '电子', gains: [4, 4, 2, 0, -1, 0, 1, 2, 3, 3] },
  jazz: { label: '爵士', gains: [2, 2, 1, 0, 1, 1, 0, 1, 2, 2] }
};
var playbackEqualizerSettings = readPlaybackEqualizer();
var playbackEqualizerGraph = null;

function normalizePlaybackEqualizerGain(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(-12, Math.min(12, Math.round(value)))
    : 0;
}

function readPlaybackEqualizer() {
  var stored;
  try { stored = JSON.parse(localStorage.getItem(PLAYBACK_EQ_STORAGE_KEY)); } catch (_) { }
  var preset = stored && typeof stored.preset === 'string' ? stored.preset : 'flat';
  var custom = stored && Array.isArray(stored.custom) ? stored.custom : [];
  return {
    enabled: !!(stored && stored.enabled === true),
    preset: preset === 'custom' || Object.hasOwn(PLAYBACK_EQ_PRESETS, preset) ? preset : 'flat',
    custom: PLAYBACK_EQ_FREQUENCIES.map(function (_, index) { return normalizePlaybackEqualizerGain(custom[index]); })
  };
}

function playbackEqualizerGains() {
  var preset = playbackEqualizerSettings.preset;
  return preset === 'custom' ? playbackEqualizerSettings.custom : PLAYBACK_EQ_PRESETS[preset].gains;
}

function applyPlaybackEqualizer(immediate) {
  var graph = playbackEqualizerGraph;
  if (!graph || graph.context.state === 'closed') return;
  var gains = playbackEqualizerSettings.enabled ? playbackEqualizerGains() : PLAYBACK_EQ_PRESETS.flat.gains;
  var now = graph.context.currentTime;
  function write(param, value) {
    if (immediate) {
      param.value = value;
    } else {
      param.cancelScheduledValues(now);
      param.setTargetAtTime(value, now, 0.025);
    }
  }
  // Leave room for boosted bands before they reach the audio output.
  write(graph.input.gain, Math.pow(10, -Math.max(0, ...gains) / 20));
  graph.filters.forEach(function (filter, index) { write(filter.gain, gains[index]); });
}

function playbackEqualizerInput(context) {
  if (playbackEqualizerGraph && playbackEqualizerGraph.context === context) return playbackEqualizerGraph.input;
  if (playbackEqualizerGraph) {
    playbackEqualizerGraph.input.disconnect();
    playbackEqualizerGraph.filters.forEach(function (filter) { filter.disconnect(); });
    playbackEqualizerGraph = null;
  }
  if (typeof context.createBiquadFilter !== 'function') return context.destination;
  var input = context.createGain();
  var previous = input;
  var filters = PLAYBACK_EQ_FREQUENCIES.map(function (frequency) {
    var filter = context.createBiquadFilter();
    filter.type = 'peaking';
    filter.frequency.value = Math.min(frequency, context.sampleRate * 0.49);
    filter.Q.value = 1.4;
    previous.connect(filter);
    previous = filter;
    return filter;
  });
  previous.connect(context.destination);
  playbackEqualizerGraph = { context: context, input: input, filters: filters };
  applyPlaybackEqualizer(true);
  return input;
}

function playbackEqualizerFrequencyLabel(frequency) {
  return frequency >= 1000 ? (frequency / 1000) + ' kHz' : frequency + ' Hz';
}

function renderPlaybackEqualizer() {
  var button = document.getElementById('playback-equalizer-btn');
  var panel = document.getElementById('playback-equalizer');
  button.classList.toggle('active', playbackEqualizerSettings.enabled);
  var toggle = panel.querySelector('#playback-equalizer-enabled');
  toggle.classList.toggle('on', playbackEqualizerSettings.enabled);
  toggle.setAttribute('aria-checked', playbackEqualizerSettings.enabled);
  panel.querySelectorAll('[data-eq-preset]').forEach(function (control) {
    var selected = control.dataset.eqPreset === playbackEqualizerSettings.preset;
    control.classList.toggle('active', selected);
    control.setAttribute('aria-pressed', selected);
  });
  var gains = playbackEqualizerGains();
  panel.querySelectorAll('input[type="range"]').forEach(function (slider, index) {
    var value = gains[index];
    var label = (value > 0 ? '+' : '') + value + ' dB';
    slider.value = value;
    slider.setAttribute('aria-valuetext', label);
    slider.parentElement.classList.toggle('adjusted', value !== 0);
    slider.parentElement.querySelector('output').textContent = label;
  });
}

function savePlaybackEqualizer() {
  try { localStorage.setItem(PLAYBACK_EQ_STORAGE_KEY, JSON.stringify(playbackEqualizerSettings)); } catch (_) { }
  applyPlaybackEqualizer(false);
  renderPlaybackEqualizer();
}

function layoutPlaybackEqualizer(panel) {
  var bar = panel.parentElement;
  var bottom = parseFloat(getComputedStyle(bar).bottom) || 0;
  // Leave room for the title bar and the gap above the playback controls.
  var height = window.innerHeight - bar.offsetHeight - bottom - 58;
  panel.style.setProperty('--playback-eq-space', Math.max(0, height) + 'px');
}

function setPlaybackEqualizerOpen(open, restoreFocus) {
  var panel = document.getElementById('playback-equalizer');
  var button = document.getElementById('playback-equalizer-btn');
  if (!panel || !button || panel.classList.contains('show') === open) return;
  panel.classList.toggle('show', open);
  panel.inert = !open;
  panel.parentElement.classList.toggle('equalizer-open', open);
  button.setAttribute('aria-expanded', open);
  if (open) {
    closeMiniQueue();
    revealBottomControls();
    layoutPlaybackEqualizer(panel);
    panel.querySelector('[data-eq-preset].active').focus({ preventScroll: true });
  } else {
    if (restoreFocus) button.focus({ preventScroll: true });
    scheduleControlsHide();
  }
}

function bindPlaybackEqualizer() {
  var panel = document.getElementById('playback-equalizer');
  var button = document.getElementById('playback-equalizer-btn');
  if (!panel || !button) return;
  var presetList = panel.querySelector('.playback-eq-presets');
  var bands = panel.querySelector('.playback-eq-bands');
  Object.entries(PLAYBACK_EQ_PRESETS).concat([['custom', { label: '自定义' }]]).forEach(function (entry) {
    var preset = document.createElement('button');
    preset.type = 'button';
    preset.className = 'fx-mini-btn ghost';
    preset.dataset.eqPreset = entry[0];
    preset.textContent = entry[1].label;
    preset.addEventListener('click', function () {
      playbackEqualizerSettings.preset = entry[0];
      playbackEqualizerSettings.enabled = true;
      savePlaybackEqualizer();
    });
    presetList.appendChild(preset);
  });
  PLAYBACK_EQ_FREQUENCIES.forEach(function (frequency, index) {
    var label = playbackEqualizerFrequencyLabel(frequency);
    var band = document.createElement('div');
    var id = 'playback-eq-band-' + index;
    band.className = 'playback-eq-band';
    band.innerHTML = '<output for="' + id + '"></output>'
      + '<input id="' + id + '" type="range" min="-12" max="12" step="1" aria-orientation="vertical">'
      + '<label for="' + id + '">' + label + '</label>';
    band.querySelector('input').addEventListener('input', function (event) {
      var gains = playbackEqualizerGains().slice();
      gains[index] = normalizePlaybackEqualizerGain(Number(event.target.value));
      playbackEqualizerSettings.custom = gains;
      playbackEqualizerSettings.preset = 'custom';
      playbackEqualizerSettings.enabled = true;
      savePlaybackEqualizer();
    });
    bands.appendChild(band);
  });
  panel.querySelector('#playback-equalizer-enabled').addEventListener('click', function () {
    playbackEqualizerSettings.enabled = !playbackEqualizerSettings.enabled;
    savePlaybackEqualizer();
  });
  button.addEventListener('click', function () {
    setPlaybackEqualizerOpen(!panel.classList.contains('show'), true);
  });
  panel.querySelector('#playback-equalizer-close').addEventListener('click', function () {
    setPlaybackEqualizerOpen(false, true);
  });
  window.addEventListener('resize', function () {
    if (!panel.inert) layoutPlaybackEqualizer(panel);
  });
  document.addEventListener('click', function (event) {
    if (!panel.contains(event.target) && !button.contains(event.target)) setPlaybackEqualizerOpen(false);
  }, true);
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || panel.inert) return;
    event.preventDefault();
    event.stopPropagation();
    setPlaybackEqualizerOpen(false, true);
  }, true);
  panel.addEventListener('focusout', function (event) {
    if (event.relatedTarget && !panel.contains(event.relatedTarget) && event.relatedTarget !== button) {
      setPlaybackEqualizerOpen(false);
    }
  });
  // Keep playback shortcuts away from the equalizer controls.
  panel.addEventListener('keydown', function (event) { event.stopPropagation(); });
  renderPlaybackEqualizer();
}
