// 天际屏歌词（播放器）：开启后，原来的 3D 舞台歌词换成天际屏。当前句、下一句和光点画在离屏画布上，作为一块平面贴图；
// 两侧词云的每个词是一块单独的小平面，按景深放在当前句前后，近的在前、远的在后，镜头一动远近的词错开，有真实的前后关系。
// 全部挂在 stageLyrics.group 下，和原歌词一样居中，并跟随镜头、位置、角度设置。画面逻辑见 js/skyline-lyrics.js。
var SKYLINE_PAD = 0.25;     // 与 MineradioSkyline 的 pad 一致：歌词带上下各留出的透明边
var SKYLINE_MAIN_Y = 0.46;  // 当前句在歌词带里的高度，与 skyline-lyrics.js 的 MAIN_Y 一致
var SKYLINE_WORD_FONT = 96; // 词云单字贴图的字号（像素）
var skylineLyrics = {
  inst: null, canvas: null, texture: null, mesh: null, root: null, source: null,
  words: {}, hidden: [], wasActive: false, color: null, colorKey: '', cam: null,
  view: null, rasterAt: 0, rasterTime: -1, rasterPlaying: false, themeKey: '', pendingWords: false, canvasUploaded: false
};
var skylineTmp = null, skylinePlaneGeo = null;

function skylineLyricsActive() {
  if (!fx || !fx.lyricSkyline || !fx.particleLyrics || !lyricsLines || !lyricsLines.length || !window.MineradioSkyline || !audio || audio.ended) return false;
  if (typeof progressDragState !== 'undefined' && progressDragState.active) return true;
  return !audio.paused || fx.lyricPauseHold !== false;
}
function updateSkylineLyricsControls() {
  var toggle = document.getElementById('t-lyricSkyline');
  if (toggle) toggle.classList.toggle('on', !!(fx && fx.lyricSkyline));
}
function skylineGeometry() {
  if (!skylinePlaneGeo) skylinePlaneGeo = new THREE.PlaneGeometry(1, 1);
  return skylinePlaneGeo;
}
// 词云单字：贴图上画清楚的字，模糊在着色器里做（多点采样 + 取更低的 mip 层），景深变化时不用重画贴图。
var SKYLINE_WORD_VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
var SKYLINE_WORD_FRAG = [
  'uniform sampler2D map; uniform vec3 color; uniform float opacity; uniform vec2 blurUv; uniform float lod;',
  'varying vec2 vUv;',
  'float tap(vec2 o) { return texture2D(map, vUv + o * blurUv, lod).a; }',
  'void main() {',
  '  float a = tap(vec2(0.0)) * 0.2;',
  '  a += (tap(vec2(1.0, 0.0)) + tap(vec2(-1.0, 0.0)) + tap(vec2(0.0, 1.0)) + tap(vec2(0.0, -1.0))) * 0.12;',
  '  a += (tap(vec2(0.7, 0.7)) + tap(vec2(-0.7, 0.7)) + tap(vec2(0.7, -0.7)) + tap(vec2(-0.7, -0.7))) * 0.08;',
  '  a *= opacity;',
  '  gl_FragColor = vec4(color * a, a);',
  '}'
].join('\n');
function skylinePow2(n) { var p = 64; while (p < n) p *= 2; return p; }
function createSkylineWord(text) {
  var c = document.createElement('canvas');
  var g = c.getContext('2d');
  var font = 'bold ' + SKYLINE_WORD_FONT + 'px ' + window.MineradioSkyline.FONT;
  g.font = font;
  var pad = SKYLINE_WORD_FONT * 0.4;
  c.width = Math.min(2048, skylinePow2(g.measureText(text).width + pad * 2));
  c.height = skylinePow2(SKYLINE_WORD_FONT * 1.3 + pad * 2);
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#fff';
  g.fillText(text, c.width / 2, c.height / 2);
  var tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  var mat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: tex }, color: { value: skylineLyrics.color },
      opacity: { value: 0 }, blurUv: { value: new THREE.Vector2(0, 0) }, lod: { value: 0 }
    },
    vertexShader: SKYLINE_WORD_VERT, fragmentShader: SKYLINE_WORD_FRAG,
    transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide
  });
  var mesh = new THREE.Mesh(skylineGeometry(), mat);
  mesh.name = 'skyline-word';
  return { mesh: mesh, tex: tex, w: c.width, h: c.height, seen: 0 };
}
function disposeSkylineWord(word) {
  if (word.mesh.parent) word.mesh.parent.remove(word.mesh);
  word.tex.dispose();
  word.mesh.material.dispose();
}
// 词按景深放在“镜头 → 平面上原位置”的连线上：z 等于 FOCUS_Z 时就在当前句所在的平面上，z 更小就更靠近镜头（更大、更虚），
// z 更大就在平面后面。镜头位置做了平滑，所以平时布局不变；镜头晃动（鼓点、拖动）时远近的词错开，看得出前后关系。
function syncSkylineWords(view, unit, mainRow, wallDt, allowWordUpload) {
  var root = skylineLyrics.root, focus = window.MineradioSkyline.FOCUS_Z, frame = (skylineLyrics.frame = (skylineLyrics.frame || 0) + 1);
  var cam = root.worldToLocal(skylineTmp.cam.copy(camera.position));
  if (!skylineLyrics.cam) skylineLyrics.cam = cam.clone();
  else skylineLyrics.cam.lerp(cam, 1 - Math.exp(-wallDt / 0.6));
  var C = skylineLyrics.cam;
  var pending = false;
  view.items.forEach(function (it) {
    var word = skylineLyrics.words[it.id];
    if (!word) {
      if (!allowWordUpload) { pending = true; return; }
      allowWordUpload = false;
      word = skylineLyrics.words[it.id] = createSkylineWord(it.text);
      root.add(word.mesh);
    }
    word.seen = frame;
    var f = it.z / focus; // 到镜头的距离与平面距离之比
    var px = (it.x - view.w / 2) * unit, py = (mainRow - it.y) * unit;
    word.mesh.position.set(C.x + (px - C.x) * f, C.y + (py - C.y) * f, C.z * (1 - f));
    var worldPerTexPx = view.focusSize * unit / SKYLINE_WORD_FONT; // 平面上与当前句同样清楚时的大小
    word.mesh.scale.set(word.w * worldPerTexPx * f, word.h * worldPerTexPx * f, 1);
    word.mesh.renderOrder = Math.round(1000 - it.z * 600);
    var u = word.mesh.material.uniforms;
    var blurPx = it.blur * SKYLINE_WORD_FONT * 2; // 模糊半径（贴图像素）
    u.blurUv.value.set(blurPx / word.w, blurPx / word.h);
    u.lod.value = Math.max(0, Math.log(Math.max(1, blurPx / 3)) / Math.LN2);
    u.opacity.value = it.alpha;
  });
  Object.keys(skylineLyrics.words).forEach(function (id) {
    if (skylineLyrics.words[id].seen === frame) return;
    disposeSkylineWord(skylineLyrics.words[id]);
    delete skylineLyrics.words[id];
  });
  skylineLyrics.mesh.renderOrder = Math.round(1000 - focus * 600);
  return pending;
}
// 平面铺满歌词所在距离上的整个画面宽度；当前句那一行正好落在原 3D 歌词的位置（group 原点）。
// 返回贴图 1 像素对应的局部长度，以及当前句那一行在贴图里的像素高度。
function placeSkylinePlane(texW, texH) {
  var group = stageLyrics.group, mesh = skylineLyrics.mesh;
  group.updateMatrixWorld(true);
  group.getWorldPosition(skylineTmp.pos);
  group.getWorldScale(skylineTmp.scale);
  var dist = Math.max(0.5, camera.position.distanceTo(skylineTmp.pos));
  var worldW = 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect;
  var unit = worldW / texW / Math.max(1e-4, skylineTmp.scale.x);
  var bandH = texH / (1 + 2 * SKYLINE_PAD);
  var mainRow = (SKYLINE_PAD + SKYLINE_MAIN_Y) * bandH;
  mesh.scale.set(texW * unit, texH * unit, 1);
  mesh.position.set(0, (texH / 2 - mainRow) * unit, 0);
  return { unit: unit, mainRow: SKYLINE_MAIN_Y * bandH };
}
function ensureSkylineRoot() {
  if (skylineLyrics.root) return skylineLyrics.root;
  skylineTmp = { pos: new THREE.Vector3(), scale: new THREE.Vector3(), cam: new THREE.Vector3() };
  skylineLyrics.color = new THREE.Color('#ffffff');
  skylineLyrics.root = new THREE.Group();
  skylineLyrics.root.name = 'skyline-lyrics';
  skylineLyrics.canvas = document.createElement('canvas');
  skylineLyrics.texture = new THREE.CanvasTexture(skylineLyrics.canvas);
  skylineLyrics.texture.minFilter = THREE.LinearFilter;
  skylineLyrics.texture.generateMipmaps = false;
  skylineLyrics.texture.premultiplyAlpha = true;
  skylineLyrics.mesh = new THREE.Mesh(skylineGeometry(), new THREE.MeshBasicMaterial({
    map: skylineLyrics.texture, transparent: true, premultipliedAlpha: true,
    depthTest: false, depthWrite: false, side: THREE.DoubleSide
  }));
  skylineLyrics.root.add(skylineLyrics.mesh);
  skylineLyrics.inst = window.MineradioSkyline.create(skylineLyrics.canvas, {
    opaque: false, pad: SKYLINE_PAD, size: { w: 0, h: 0 }, cloud3d: true
  });
  return skylineLyrics.root;
}
function hideStageLyricsChildren() {
  stageLyrics.group.children.forEach(function (child) {
    if (child === skylineLyrics.root || !child.visible) return;
    child.visible = false;
    if (skylineLyrics.hidden.indexOf(child) < 0) skylineLyrics.hidden.push(child);
  });
}
function restoreStageLyricsChildren() {
  skylineLyrics.hidden.forEach(function (child) { child.visible = true; });
  skylineLyrics.hidden = [];
}
function clearSkylineWords() {
  Object.keys(skylineLyrics.words).forEach(function (id) { disposeSkylineWord(skylineLyrics.words[id]); });
  skylineLyrics.words = {};
  skylineLyrics.cam = null;
  skylineLyrics.view = null;
  skylineLyrics.pendingWords = false;
}
function updateSkylineLyrics(dt, allowRaster) {
  var on = skylineLyricsActive() && !!stageLyrics.group && typeof camera !== 'undefined';
  if (on !== skylineLyrics.wasActive) {
    skylineLyrics.wasActive = on;
    updateSkylineLyricsControls();
    if (!on) {
      restoreStageLyricsChildren();
      clearSkylineWords();
      if (skylineLyrics.root && skylineLyrics.root.parent) skylineLyrics.root.parent.remove(skylineLyrics.root);
      stageLyrics.currentIdx = -1; // 天际屏开着时 3D 歌词没有跟着换句，关掉后让它重建当前句
    }
  }
  if (!on) return;
  var root = ensureSkylineRoot();
  if (root.parent !== stageLyrics.group) stageLyrics.group.add(root);
  hideStageLyricsChildren();
  var sourceChanged = skylineLyrics.source !== lyricsLines;
  var dpr = Math.min(2, (typeof renderer !== 'undefined' && renderer.getPixelRatio && renderer.getPixelRatio()) || window.devicePixelRatio || 1);
  var texW = Math.round(Math.max(960, Math.min(2560, innerWidth * dpr)));
  var texH = Math.round(texW / 9 * (1 + 2 * SKYLINE_PAD));
  var raw = typeof stageLyricPlaybackSeconds === 'function' ? stageLyricPlaybackSeconds() : (Number(audio && audio.currentTime) || 0);
  var time = typeof getAdjustedLyricPlaybackTime === 'function' ? getAdjustedLyricPlaybackTime(raw) : raw;
  var rate = audio && audio.playbackRate > 0 ? audio.playbackRate : 1;
  var theme = window.MineradioSkyline.themeFromColors(desktopOverlayColors());
  var themeKey = [theme.unsung, theme.sung, theme.glow, theme.cloud, theme.spark].join('|');
  var moving = !!(playing && !audio.paused);
  var needsRaster = sourceChanged || !skylineLyrics.view || skylineLyrics.canvas.width !== texW || skylineLyrics.canvas.height !== texH || skylineLyrics.themeKey !== themeKey;
  // The main canvas and incoming cloud words share one texture upload per frame.
  var deferToWord = !needsRaster && skylineLyrics.pendingWords && skylineLyrics.canvasUploaded;
  var drewCanvas = !deferToWord && (needsRaster || (allowRaster && (
    moving || moving !== skylineLyrics.rasterPlaying || time !== skylineLyrics.rasterTime || skylineLyrics.inst.needsPausedFrame()
  )));
  if (drewCanvas) {
    skylineLyrics.inst.size = { w: texW, h: texH };
    if (sourceChanged) {
      clearSkylineWords();
      skylineLyrics.source = lyricsLines;
      skylineLyrics.inst.setLines(lyricsLines);
    }
    var now = performance.now();
    var rasterDt = skylineLyrics.rasterAt ? Math.min(0.1, (now - skylineLyrics.rasterAt) / 1000) : dt;
    skylineLyrics.inst.render(time, moving ? rasterDt : 0, theme, rate);
    skylineLyrics.texture.needsUpdate = true;
    skylineLyrics.view = skylineLyrics.inst.cloudView();
    skylineLyrics.rasterAt = now;
    skylineLyrics.rasterTime = time;
    skylineLyrics.rasterPlaying = moving;
    skylineLyrics.themeKey = themeKey;
  }
  if (skylineLyrics.colorKey !== theme.cloud) {
    skylineLyrics.colorKey = theme.cloud;
    skylineLyrics.color.setStyle(theme.cloud || '#ffffff');
  }
  var plane = placeSkylinePlane(texW, texH);
  skylineLyrics.pendingWords = syncSkylineWords(skylineLyrics.view, plane.unit, plane.mainRow, dt, allowRaster && !drewCanvas);
  if (allowRaster || drewCanvas) skylineLyrics.canvasUploaded = drewCanvas;
}
function toggleLyricSkyline() {
  fx.lyricSkyline = !fx.lyricSkyline;
  updateSkylineLyricsControls();
  pushDesktopLyricsState(true);
  saveLyricLayout({ user: true, reason: 'lyricSkyline' });
  showToast(fx.lyricSkyline ? '已开启天际屏歌词' : '已关闭天际屏歌词');
}
