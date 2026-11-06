// 天际屏歌词：超宽长条中间是当前句（逐字填充、光点）和下一句，两侧是 3D 词云。
// 主窗口和桌面歌词窗口共用，入口为 window.MineradioSkyline。
(function (root) {
  'use strict';

  var FONT = 'Georgia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", "STZhongsong", "SimSun", serif';
  var MAIN_Y = 0.46;        // 行中心位置，占长条高度的比例
  var NEXT_Y = 0.74;
  var MAIN_SIZE = 0.26;     // 当前句字号 / 长条高度
  var NEXT_SCALE = 0.42;    // 下一句相对当前句的大小
  var MAX_W = 0.36;         // 当前句最大宽度，占长条宽度的比例
  // A 48px taskbar cannot use the same two-line proportions as a tall canvas.
  // Keep the same animation and word timing, but reserve more room for text.
  var DESKTOP_LAYOUT = { mainY: MAIN_Y, nextY: NEXT_Y, mainSize: MAIN_SIZE, nextScale: NEXT_SCALE, maxWidth: MAX_W, exitRise: 0.18 };
  var TASKBAR_LAYOUT = { mainY: 0.36, nextY: 0.76, mainSize: 0.43, nextScale: 0.48, maxWidth: 0.70, exitRise: 0.08 };
  var SWAP = 0.16;          // 下一句上移成为当前句的时长（秒）
  var EXIT = 0.12;          // 旧句上移淡出的时长（秒）
  var GROW = 0.1;           // 当前句在唱的过程中放大 10%
  var UNSUNG_ALPHA = 0.55;  // 当前句未唱部分的不透明度，浅色配色下也能看清唱到哪
  var CLOUD_FOCUS = 0.55;   // 词云景深 z：越小越近（大且虚），1 为最远
  var CLOUD_NEAR = 0.28;
  var CLOUD_SPEED = 0.035;  // 每秒靠近的景深，一个词大约停留 5-20 秒
  var CLOUD_LOOKAHEAD = 14; // 提前多少秒把后面几句的词放进词云
  var CLOUD_MAX = 40;
  var wordSeq = 0;          // 词云里每个词的编号，3D 端用它对应自己的网格

  var CJK = '\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff';
  // 中日韩每个字一个词元，拉丁文每个单词一个词元；词尾空格留在词元里，拼回去就是原句。
  var TOKEN = new RegExp('[' + CJK + ']\\s*|[^\\s' + CJK + ']+\\s*|\\s+', 'g');
  var WORDISH = new RegExp('[0-9A-Za-z\\u00c0-\\u024f\\u0400-\\u04ff' + CJK + ']');
  var EDGE_PUNCT = /^[\s"'“”‘’(（\[【《]+|[\s.,!?;:"'“”‘’…—–\-)）\]】》，。！？；：、]+$/g;

  function clamp01(k) { return k < 0 ? 0 : (k > 1 ? 1 : k); }
  function ease(k) { k = 1 - clamp01(k); return 1 - k * k * k; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function tokenize(text) { return String(text || '').match(TOKEN) || []; }
  // 任意 CSS 颜色（hex / rgb / hsl）换成带透明度的 rgba：先交给画布规范化，再读回来。
  function withAlpha(ctx, color, a) {
    ctx.fillStyle = '#000';
    ctx.fillStyle = color;
    var c = String(ctx.fillStyle), m;
    if ((m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c))) {
      return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a + ')';
    }
    if ((m = /^rgba?\(([^,]+),([^,]+),([^,)]+)(?:,([^)]+))?\)$/.exec(c.replace(/\s+/g, '')))) {
      return 'rgba(' + m[1] + ',' + m[2] + ',' + m[3] + ',' + (m[4] == null ? 1 : Number(m[4])) * a + ')';
    }
    return color;
  }

  // 有逐字时间的行：每个词从自己的字符位置切到下一个词的位置，保证拼回原句。
  function nativeWords(src, raw) {
    var ws = src.words, out = [];
    var ranged = ws.every(function (w) { return isFinite(Number(w.c0)); });
    for (var k = 0; k < ws.length; k++) {
      var t0 = Number(ws[k].t), d = Number(ws[k].d);
      if (!isFinite(t0)) continue;
      var piece = ranged
        ? raw.slice(k === 0 ? 0 : Number(ws[k].c0), k + 1 < ws.length ? Number(ws[k + 1].c0) : raw.length)
        : String(ws[k].text || '');
      if (piece) out.push({ text: piece, t0: t0, t1: t0 + (d > 0 ? d : 0.2) });
    }
    return out;
  }
  // 只有整行时间的行：把时长均分给每个字（中日韩）或每个词。
  function spreadWords(text, start, dur) {
    var toks = tokenize(text), out = [];
    for (var k = 0; k < toks.length; k++) {
      out.push({ text: toks[k], t0: start + dur * k / toks.length, t1: start + dur * (k + 1) / toks.length });
    }
    return out;
  }
  // 播放器的歌词行 { t, duration, text, words:[{ text, t, d, c0, c1 }] } 转成 { start, end, text, words:[{ text, t0, t1 }] }。
  function adaptLines(src) {
    var lines = [];
    (src || []).forEach(function (line, i) {
      var raw = String(line && line.text || '');
      var start = Number(line && line.t);
      if (!raw.trim() || !isFinite(start)) return;
      var next = src[i + 1] && isFinite(Number(src[i + 1].t)) ? Number(src[i + 1].t) : start + 8;
      var words = line.words && line.words.length ? nativeWords(line, raw) : [];
      if (!words.length) {
        // 整行时长常常一直延到下一句，按字数封顶，免得填充拖过间奏。
        var dur = Number(line.duration);
        var cap = 0.6 + 0.42 * tokenize(raw).length;
        if (!(dur > 0)) dur = cap;
        dur = Math.max(0.2, Math.min(dur, cap, Math.max(0.2, next - start - 0.4)));
        words = spreadWords(raw, start, dur);
      }
      while (words.length && !words[0].text.trim()) words.shift();
      while (words.length && !words[words.length - 1].text.trim()) words.pop();
      if (!words.length) return;
      words[0].text = words[0].text.replace(/^\s+/, '');
      words[words.length - 1].text = words[words.length - 1].text.replace(/\s+$/, '');
      lines.push({
        start: start,
        end: words[words.length - 1].t1,
        text: words.map(function (w) { return w.text; }).join(''),
        words: words
      });
    });
    lines.sort(function (a, b) { return a.start - b.start; });
    return lines;
  }
  // 放进词云的词：中日韩拆成单字，去掉首尾标点，丢掉纯标点。
  function cloudWordsOf(line) {
    var out = [];
    line.words.forEach(function (w) {
      tokenize(w.text).forEach(function (tok) {
        var s = tok.replace(EDGE_PUNCT, '');
        if (s && WORDISH.test(s)) out.push(s);
      });
    });
    return out;
  }
  // 两侧 3D 词云：未来 CLOUD_LOOKAHEAD 秒内要唱的句子，词一个个放进来（每个词一次），
  // 往观众方向飘近，经过时消失。所以词常常在唱到之前就出现了。
  function sizeAt(z, h) { return h * 0.2 / z; }
  function blurAt(z, h) { return (z < CLOUD_FOCUS ? (CLOUD_FOCUS - z) * 0.3 : (z - CLOUD_FOCUS) * 0.035) * h; }
  function alphaAt(z) { return Math.min(1, Math.max(0.3, 1.15 - z * 0.75)); }
  function sideX(left, w) { return w * (left ? rand(0.01, 0.4) : rand(0.6, 0.99)); }

  function Cloud() {
    this.lines = [];
    this.items = [];
    this.queue = [];
    this.next = 0;
    this.timer = 0;
  }
  // 在歌曲时间 t 重新开始（换歌、拖动进度、改尺寸），t 附近的词直接放在半路。
  Cloud.prototype.reset = function (lines, t, w, h) {
    this.lines = lines;
    this.items = [];
    this.queue = [];
    this.next = 0;
    for (; this.next < lines.length && lines[this.next].start <= t + CLOUD_LOOKAHEAD; this.next++) {
      if (lines[this.next].start < t - 4) continue;
      var words = cloudWordsOf(lines[this.next]);
      for (var i = 0; i < words.length; i++) {
        // 其余的当作已经飘过去了；留下的从负的 fade 开始，错开约 1.6 秒依次淡入，不会一下子全冒出来
        if (Math.random() < 0.6) this.add(words[i], w, h, rand(0.35, 1), -rand(0, 0.6));
      }
    }
  };
  Cloud.prototype.add = function (text, w, h, z, fade) {
    var left = Math.random() < 0.5;
    this.items.push({
      text: text, x: sideX(left, w), y: h * rand(0.3, 0.72), z: z, fade: fade, alive: true,
      vx: (left ? -1 : 1) * w * rand(0.002, 0.006), ratio: 0, id: ++wordSeq
    });
  };
  // dt：歌曲经过的时间（暂停时为 0），只管飘动和放词；wallDt：画面经过的时间，只管淡入淡出，暂停时也继续。
  Cloud.prototype.update = function (t, dt, wallDt, w, h) {
    for (; this.next < this.lines.length && this.lines[this.next].start <= t + CLOUD_LOOKAHEAD; this.next++) {
      this.queue.push.apply(this.queue, cloudWordsOf(this.lines[this.next]));
    }
    if (dt > 0) {
      this.timer -= dt;
      if (this.timer <= 0 && this.queue.length) {
        this.timer = rand(0.2, 0.45);
        this.add(this.queue.shift(), w, h, rand(0.5, 1), 0);
      }
    }
    var alive = this.items.filter(function (it) { return it.alive; });
    for (var i = 0; i < alive.length - CLOUD_MAX; i++) alive[i].alive = false;
    this.items.forEach(function (it) {
      it.z -= dt * CLOUD_SPEED;
      it.x += it.vx * dt;
      if (it.z < CLOUD_NEAR || it.x < -w * 0.05 || it.x > w * 1.05) it.alive = false;
      it.fade = it.alive ? Math.min(1, it.fade + wallDt / 0.6) : it.fade - wallDt / 0.6;
    });
    this.items = this.items.filter(function (it) { return it.alive || it.fade > 0; });
  };
  // keep(x, r)：半宽为 r 的词放在 x 处会挡住当前句时为 0，离开当前句时为 1。
  Cloud.prototype.draw = function (ctx, h, theme, keep, position, edgeOpacity, fontScale, fitWord) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = theme.cloud;
    var items = this.items.slice().sort(function (a, b) { return b.z - a.z; });
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var size = sizeAt(it.z, h) * (fontScale || 1);
      ctx.font = 'bold ' + size + 'px ' + FONT;
      if (!it.ratio || (edgeOpacity && !it.boundRatio)) {
        var metrics = ctx.measureText(it.text);
        it.ratio = metrics.width / size;
        it.boundRatio = Math.max(metrics.width / 2, Math.abs(metrics.actualBoundingBoxLeft || 0),
          Math.abs(metrics.actualBoundingBoxRight || 0)) / size;
      }
      var blur = blurAt(it.z, h) * (fontScale || 1);
      var halfWidth = edgeOpacity ? it.boundRatio * size + blur * 2 : it.ratio * size / 2;
      var roomOpacity = 1;
      if (fitWord) {
        var room = fitWord(it.x, halfWidth, it.y, size, blur);
        var fit = room.scale;
        roomOpacity = room.opacity;
        if (!(fit > 0) || !(roomOpacity > 0)) continue;
        size *= fit;
        blur *= fit;
        halfWidth *= fit;
        ctx.font = 'bold ' + size + 'px ' + FONT;
      }
      var x = position ? position(it.x, halfWidth) : it.x;
      var alpha = alphaAt(it.z) * Math.max(0, Math.min(1, it.fade)) * keep(x, halfWidth)
        * (edgeOpacity ? edgeOpacity(x, halfWidth) : 1) * roomOpacity;
      if (alpha < 0.01) continue;
      ctx.filter = blur > 0.4 ? 'blur(' + blur + 'px)' : 'none';
      ctx.globalAlpha = alpha;
      ctx.fillText(it.text, x, it.y);
    }
    ctx.restore();
  };

  // 从逐字填充的位置往上冒的光点，叠加绘制。
  function Sparks() {
    this.items = [];
    this.acc = 0;
    this.sprite = null;
    this.spriteColor = '';
  }
  Sparks.prototype.clear = function () { this.items = []; };
  Sparks.prototype.emit = function (x, y, h, dt) {
    this.acc += dt * 38;
    for (; this.acc >= 1; this.acc -= 1) {
      this.items.push({
        x: x + (Math.random() - 0.5) * h * 0.08, y: y - Math.random() * h * 0.04,
        vx: (Math.random() - 0.25) * h * 0.3, vy: -(0.25 + Math.random() * 0.55) * h,
        r: h * (0.006 + Math.random() * 0.01), life: 0, ttl: 0.6 + Math.random() * 0.8, phase: Math.random() * 6.28
      });
    }
  };
  Sparks.prototype.update = function (dt) {
    this.items.forEach(function (p) {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - 1.5 * dt;
      p.vy *= 1 - 1.5 * dt;
    });
    this.items = this.items.filter(function (p) { return p.life < p.ttl; });
  };
  Sparks.prototype.draw = function (ctx, color) {
    if (this.spriteColor !== color) {
      this.sprite = makeDot(color);
      this.spriteColor = color;
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < this.items.length; i++) {
      var p = this.items[i];
      var k = p.life / p.ttl;
      ctx.globalAlpha = Math.min(1, k * 8) * (1 - k) * (0.55 + 0.45 * Math.sin(p.phase + p.life * 20));
      var s = p.r * 4;
      ctx.drawImage(this.sprite, p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.restore();
  };
  function makeDot(color) {
    var c = document.createElement('canvas');
    c.width = c.height = 32;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.3, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    return c;
  }

  function indexAt(lines, t) {
    var i = -1;
    while (i + 1 < lines.length && lines[i + 1].start <= t) i++;
    return i;
  }
  // opts.opaque：true 画黑底（模拟实车），false 透明叠在别的画面上。
  // opts.pad：长条上下各留出的透明边，占歌词带高度的比例，大而虚的近景词不会被画布边缘切掉。
  // opts.size：{ w, h } 固定像素尺寸，画布不在页面上（比如当 3D 贴图）时用。
  function Skyline(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opaque = !!opts.opaque;
    this.pad = opts.pad == null ? 0.25 : Math.max(0, Number(opts.pad) || 0);
    this.size = opts.size || null;
    this.taskbarMode = opts.taskbar === true;
    this.lyricSizeScale = 1;
    this.taskbarCloudSpacing = 0.5;
    this.taskbarGeometry = null;
    this.cloudFrameWidth = 0;
    this.cloudFrameHeight = 0;
    this.cloudSafeHalf = 0;
    // opts.cloud3d：true 时不在画布上画词云，由调用方用 cloudView() 拿到每个词的位置、景深，自己按真实前后关系画（播放器 3D 场景）。
    this.cloud3d = !!opts.cloud3d;
    this.keep = null;
    // opts.now：返回毫秒的时钟，默认 performance.now；测试时传入假时钟逐帧推进。
    this.now = opts.now || function () { return root.performance ? root.performance.now() : Date.now(); };
    this.cloud = new Cloud();
    this.sparks = new Sparks();
    this.lines = [];
    this.idx = -1;
    this.lastT = 0;
    this.bandH = 0;
    this.bandTop = 0;
    this.half = 0;      // 词云避让当前句的半宽，平滑变化，换句时旁边的词不会闪
    this.clock = null;  // 平滑后的歌曲时间，见 render()
    this.wallAt = 0;
    this.fadeIn = 0;    // 换歌、拖动进度后整体淡入
  }
  // 换一组歌词（播放器的原始行）。
  Skyline.prototype.setLines = function (srcLines) {
    this.lines = adaptLines(srcLines);
    this.idx = -1;
    this.sparks.clear();
    this.clock = null;
    this.fadeIn = 0;
    this.relayout();
  };
  Skyline.prototype.relayout = function () {
    this.bandH = this.canvas.height / (1 + 2 * this.pad);
    this.bandTop = this.bandH * this.pad;
    for (var i = 0; i < this.lines.length; i++) this.lines[i].layout = null;
    var cloudWidth = this.taskbarMetrics().referenceWidth;
    this.cloud.reset(this.lines, this.lastT, cloudWidth, this.bandH);
    this.cloudFrameWidth = cloudWidth;
    this.cloudFrameHeight = this.bandH;
  };
  Skyline.prototype.layoutProfile = function () {
    var size = this.lyricSizeScale;
    if (!this.taskbarMode) {
      if (size === 1) return DESKTOP_LAYOUT;
      return Object.assign({}, DESKTOP_LAYOUT, { mainSize: DESKTOP_LAYOUT.mainSize * size });
    }
    if (size === 1) return TASKBAR_LAYOUT;
    // Large taskbar text uses the slot progressively: grow the main line
    // faster than the next line and spread their baselines without overflow.
    var mainScale = size <= 1 ? size : 1 + (size - 1) * 0.4;
    var nextScale = size <= 1 ? size : 1 + (size - 1) * 0.1;
    return Object.assign({}, TASKBAR_LAYOUT, {
      mainSize: TASKBAR_LAYOUT.mainSize * mainScale,
      nextScale: TASKBAR_LAYOUT.nextScale * nextScale / mainScale,
      mainY: TASKBAR_LAYOUT.mainY + Math.max(0, size - 1) * 0.065,
      nextY: TASKBAR_LAYOUT.nextY + Math.max(0, size - 1) * 0.045
    });
  };
  Skyline.prototype.setTaskbarMode = function (enabled) {
    enabled = enabled === true;
    if (this.taskbarMode === enabled) return;
    this.taskbarMode = enabled;
    for (var i = 0; i < this.lines.length; i++) this.lines[i].layout = null;
  };
  Skyline.prototype.setLyricSizeScale = function (value) {
    value = Number(value);
    if (!isFinite(value)) value = 1;
    value = Math.max(0.2, Math.min(1.6, value));
    if (this.lyricSizeScale === value) return;
    this.lyricSizeScale = value;
    for (var i = 0; i < this.lines.length; i++) this.lines[i].layout = null;
  };
  Skyline.prototype.setTaskbarCloudSpacing = function (value) {
    value = Number(value);
    if (!isFinite(value)) value = 0.5;
    this.taskbarCloudSpacing = clamp01(value);
  };
  Skyline.prototype.cloudSizeScale = function () {
    return this.taskbarMode && this.lyricSizeScale > 1
      ? 1 + (this.lyricSizeScale - 1) * 0.4 : this.lyricSizeScale;
  };
  // Geometry is in CSS/DIP units from the native layout, not measured glyphs.
  // It is converted using the actual canvas/viewport ratio at draw time.
  Skyline.prototype.setTaskbarGeometry = function (geometry) {
    var ref = geometry && Number(geometry.referenceWidth);
    var anchor = geometry && Number(geometry.anchorX);
    var viewport = geometry && Number(geometry.viewportWidth);
    this.taskbarGeometry = isFinite(ref) && ref > 0 && isFinite(anchor)
      ? { referenceWidth:ref, anchorX:anchor, viewportWidth:isFinite(viewport) && viewport > 0 ? viewport : 0 } : null;
  };
  Skyline.prototype.taskbarViewportReady = function () {
    if (!this.taskbarMode || !this.taskbarGeometry || !this.taskbarGeometry.viewportWidth) return true;
    return Math.abs(this.canvas.clientWidth - this.taskbarGeometry.viewportWidth) <= 1.5;
  };
  Skyline.prototype.taskbarMetrics = function () {
    var w = this.canvas.width;
    if (!this.taskbarMode || !this.taskbarGeometry) return { referenceWidth:w, anchorX:w / 2 };
    var cssWidth = this.canvas.clientWidth || w;
    var pixelScale = w / cssWidth;
    var referenceWidth = Math.min(w, Math.max(1, this.taskbarGeometry.referenceWidth * pixelScale));
    var anchorX = Math.max(0, Math.min(w, this.taskbarGeometry.anchorX * pixelScale));
    return { referenceWidth:referenceWidth, anchorX:anchorX };
  };
  Skyline.prototype.syncCloudGeometry = function (width, height) {
    if (this.cloudFrameWidth > 0 && this.cloudFrameHeight > 0) {
      var sx = width / this.cloudFrameWidth, sy = height / this.cloudFrameHeight;
      if (sx !== 1 || sy !== 1) this.cloud.items.forEach(function (item) {
        item.x *= sx;
        item.vx *= sx;
        item.y *= sy;
      });
    }
    this.cloudFrameWidth = width;
    this.cloudFrameHeight = height;
  };
  // Map the drawn word, not its animation state. Limits account for the
  // entire word and never reverse the requested direction when space is tight.
  Skyline.prototype.cloudPosition = function (x, halfWidth) {
    if (!this.taskbarMode) return x;
    var w = this.canvas.width, metrics = this.taskbarMetrics();
    var center = metrics.anchorX, referenceCenter = metrics.referenceWidth / 2;
    var side = x < referenceCenter ? -1 : 1;
    var distance = Math.abs(x - referenceCenter);
    halfWidth = Math.max(0, Number(halfWidth) || 0);
    var margin = Math.max(2, this.bandH * 0.08);
    var outer = Math.max(0, (side < 0 ? center : w - center) - halfWidth - margin);
    var inner = Math.min(outer, Math.max(this.half, this.cloudSafeHalf) + halfWidth + margin);
    var ratio = clamp01(distance / Math.max(1, referenceCenter));
    var strength = (this.taskbarCloudSpacing - 0.5) * 2;
    ratio = clamp01(ratio + strength * 0.15 * ratio * (1 - ratio));
    return center + side * (inner + (outer - inner) * ratio);
  };
  Skyline.prototype.cloudWordFit = function (x, halfWidth, y, size, blur) {
    if (!this.taskbarMode || !(halfWidth > 0)) return { scale:1, opacity:1 };
    var metrics = this.taskbarMetrics();
    var sideAvailable = x < metrics.referenceWidth / 2 ? metrics.anchorX : this.canvas.width - metrics.anchorX;
    var margin = Math.max(2, this.bandH * .08);
    var channel = Math.max(0, sideAvailable - Math.max(this.half, this.cloudSafeHalf) - margin * 2);
    // Leave a quarter of the channel for different words' centers to spread.
    var maxHalf = channel * .375;
    var verticalRoom = Math.max(.5, Math.min(y, this.bandH - y) - Math.max(1, this.bandH * .04));
    return {
      scale:Math.max(0, Math.min(1, maxHalf / halfWidth, verticalRoom / Math.max(.5, size * .6 + blur * 2))),
      opacity:clamp01(channel / Math.max(2, this.bandH * .12))
    };
  };
  Skyline.prototype.cloudEdgeOpacity = function (x, halfWidth) {
    var clearance = Math.min(x - halfWidth, this.canvas.width - x - halfWidth);
    return clamp01(clearance / Math.max(2, this.bandH * 0.10));
  };
  // 画布像素尺寸跟随显示尺寸（或 opts.size）；返回 false 表示画布没有显示出来。
  Skyline.prototype.fit = function () {
    var c = this.canvas;
    if (!this.taskbarViewportReady()) return false;
    var dpr = root.devicePixelRatio || 1;
    var w = this.size ? this.size.w : Math.round(c.clientWidth * dpr);
    var h = this.size ? this.size.h : Math.round(c.clientHeight * dpr);
    if (!w || !h) return false;
    if (c.width !== w || c.height !== h || !this.bandH) {
      c.width = w;
      c.height = h;
      if (this.taskbarMode && this.bandH) {
        this.bandH = c.height / (1 + 2 * this.pad);
        this.bandTop = this.bandH * this.pad;
        for (var i = 0; i < this.lines.length; i++) this.lines[i].layout = null;
        this.syncCloudGeometry(this.taskbarMetrics().referenceWidth, this.bandH);
      } else this.relayout();
    }
    return true;
  };
  // 字号和每个词的左边缘（从句首量起，缩放为 1 时）。
  Skyline.prototype.layout = function (line) {
    var w = this.canvas.width, h = this.bandH, L = line.layout;
    var referenceWidth = this.taskbarMetrics().referenceWidth;
    if (L && L.w === w && L.h === h && L.referenceWidth === referenceWidth) return L;
    var ctx = this.ctx;
    var profile = this.layoutProfile();
    var size = h * profile.mainSize;
    ctx.font = 'bold ' + size + 'px ' + FONT;
    var width = ctx.measureText(line.text).width;
    if (width > referenceWidth * profile.maxWidth) {
      size *= referenceWidth * profile.maxWidth / width;
      ctx.font = 'bold ' + size + 'px ' + FONT;
      width = ctx.measureText(line.text).width;
    }
    var edges = [], acc = '';
    for (var k = 0; k < line.words.length; k++) {
      edges.push(ctx.measureText(acc).width);
      acc += line.words[k].text;
    }
    edges.push(width);
    line.layout = { w: w, h: h, referenceWidth:referenceWidth, size: size, width: width, edges: edges };
    return line.layout;
  };
  Skyline.prototype.progressX = function (line, L, t) {
    var ws = line.words;
    for (var k = 0; k < ws.length; k++) {
      if (t < ws[k].t1) {
        var f = clamp01((t - ws[k].t0) / Math.max(0.001, ws[k].t1 - ws[k].t0));
        return L.edges[k] + (L.edges[k + 1] - L.edges[k]) * f;
      }
    }
    return L.width;
  };
  // 当前句的位置：从下一句的位置上移放大到主位置，唱的过程中再慢慢放大。
  Skyline.prototype.pose = function (line, t) {
    var k = ease((t - line.start) / SWAP);
    var grow = 1 + GROW * clamp01((t - line.start) / Math.max(2, line.end - line.start));
    var profile = this.layoutProfile();
    return {
      k: k,
      scale: profile.nextScale + (grow - profile.nextScale) * k,
      y: this.bandH * (profile.nextY + (profile.mainY - profile.nextY) * k),
      alpha: 0.6 + 0.4 * k
    };
  };
  // Main and next lyric bounds in canvas pixels; cloud words remain click-through.
  Skyline.prototype.interactionBounds = function () {
    if (!this.taskbarViewportReady() || !this.bandH || !this.canvas.width || !this.lines.length) return null;
    var t = this.clock && isFinite(this.clock.t) ? this.clock.t : this.lastT;
    var cur = this.lines[this.idx], next = this.lines[this.idx + 1];
    var bounds = null;
    var add = function (line, scale, y) {
      if (!line || !(scale > 0)) return;
      var layout = this.layout(line);
      var halfWidth = layout.width * scale / 2;
      var halfHeight = layout.size * scale * .68;
      var rect = {
        left: this.taskbarMetrics().anchorX - halfWidth,
        right: this.taskbarMetrics().anchorX + halfWidth,
        top: this.bandTop + y - halfHeight,
        bottom: this.bandTop + y + halfHeight
      };
      bounds = bounds ? {
        left: Math.min(bounds.left, rect.left), top: Math.min(bounds.top, rect.top),
        right: Math.max(bounds.right, rect.right), bottom: Math.max(bounds.bottom, rect.bottom)
      } : rect;
    }.bind(this);
    if (cur) {
      var p = this.pose(cur, t);
      add(cur, p.scale, p.y);
    }
    if (next && (!cur || t > cur.start)) {
      var profile = this.layoutProfile();
      add(next, profile.nextScale, this.bandH * profile.nextY);
    }
    return bounds;
  };
  // t 为 null 时整句画成未唱的颜色；glow 为辉光强度（0-1）。
  Skyline.prototype.drawLine = function (line, L, scale, y, alpha, glow, t, theme) {
    var ctx = this.ctx;
    ctx.save();
    ctx.translate(this.taskbarMetrics().anchorX, y);
    ctx.scale(scale, scale);
    ctx.font = 'bold ' + L.size + 'px ' + FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = alpha;
    ctx.shadowColor = theme.glow;
    ctx.shadowBlur = L.size * 0.35 * glow * scale; // shadowBlur 不受 transform 影响
    var x0 = -L.width / 2;
    if (t == null) {
      ctx.fillStyle = theme.unsung;
    } else {
      var px = x0 + this.progressX(line, L, t);
      var g = ctx.createLinearGradient(px - L.size * 0.15, 0, px + L.size * 0.15, 0);
      g.addColorStop(0, theme.sung);
      g.addColorStop(1, withAlpha(ctx, theme.unsung, UNSUNG_ALPHA));
      ctx.fillStyle = g;
    }
    ctx.fillText(line.text, x0, 0);
    ctx.restore();
  };
  Skyline.prototype.clear = function () {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  };
  Skyline.prototype.needsPausedFrame = function () {
    return this.fadeIn < 1 || this.cloud.items.some(function (item) { return item.alive ? item.fade < 1 : item.fade > 0; });
  };
  // t：歌曲时间（秒）；dt：画面经过的时间，暂停时传 0；theme：themeFromColors() 的结果；rate：播放倍速。
  Skyline.prototype.render = function (t, dt, theme, rate) {
    if (!this.fit()) return;
    var ctx = this.ctx, w = this.canvas.width, h = this.bandH;
    var metrics = this.taskbarMetrics();
    var cloudWidth = metrics.referenceWidth;
    this.syncCloudGeometry(cloudWidth, h);
    var nowMs = this.now();
    var wallDt = this.wallAt ? Math.min(0.1, Math.max(0, (nowMs - this.wallAt) / 1000)) : 1 / 60;
    this.wallAt = nowMs;
    // 播放器给的时间常常一顿一顿地更新，换句动画只有 0.16 秒，直接用会卡住或跳帧。
    // 按画面经过的时间往前推，只在拿到新的时间时轻轻校正；差太多（拖动进度）才直接跳过去。
    var playingNow = dt > 0;
    if (this.clock == null || Math.abs(t - this.clock.t) > 0.4) {
      this.clock = { t: t, input: t };
    } else {
      if (playingNow) this.clock.t += wallDt * (rate > 0 ? rate : 1);
      if (t !== this.clock.input) {
        this.clock.input = t;
        this.clock.t += (t - this.clock.t) * 0.3;
      }
    }
    t = this.clock.t;
    // 往回跳一点点（推算误差）不算拖动进度。
    if (t < this.lastT && t > this.lastT - 0.3) t = this.lastT;
    var idx = indexAt(this.lines, t);
    if (t < this.lastT || t > this.lastT + 2) { // 拖动了进度
      this.sparks.clear();
      this.cloud.reset(this.lines, t, cloudWidth, h);
      this.fadeIn = 0;
    }
    this.idx = idx;
    this.lastT = t;
    this.fadeIn = Math.min(1, this.fadeIn + wallDt / 0.8);
    var fade = ease(this.fadeIn);

    if (this.opaque) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, this.canvas.height);
    } else {
      ctx.clearRect(0, 0, w, this.canvas.height);
    }
    ctx.save();
    ctx.translate(0, this.bandTop);
    var cur = this.lines[idx], next = this.lines[idx + 1], prev = this.lines[idx - 1];
    var L = cur && this.layout(cur);
    var p = cur && this.pose(cur, t);
    // 避让半宽按当前句放大后的宽度算，并平滑过渡；换句时句子先缩小再放大，直接跟着会让旁边的词一闪一闪。
    var target = cur ? L.width * Math.max(1, p.scale) / 2 + h * 0.15 : 0;
    this.half += (target - this.half) * Math.min(1, wallDt * (target > this.half ? 10 : 2.5));
    var profile = this.layoutProfile();
    var nextWidth = next ? this.layout(next).width * profile.nextScale / 2 : 0;
    this.cloudSafeHalf = Math.max(target, nextWidth + h * 0.15);
    var half = this.taskbarMode ? Math.max(this.half, this.cloudSafeHalf) : this.half;
    var keep = function (x, r) { return clamp01((Math.abs(x - metrics.anchorX) - r - half) / (h * 0.5)); };
    this.cloud.update(t, dt, wallDt, cloudWidth, h);
    this.keep = keep;
    if (!this.cloud3d) this.cloud.draw(ctx, h, theme, keep, this.cloudPosition.bind(this),
      this.taskbarMode ? this.cloudEdgeOpacity.bind(this) : null, this.cloudSizeScale(),
      this.taskbarMode ? this.cloudWordFit.bind(this) : null);

    if (next) {
      var appear = cur ? clamp01((t - cur.start) / SWAP) : 1;
      this.drawLine(next, this.layout(next), profile.nextScale, h * profile.nextY, 0.6 * appear * fade, 0.3, null, theme);
    }
    if (cur && prev && t - cur.start < EXIT) { // 旧句从主位置上移淡出
      var e = ease((t - cur.start) / EXIT);
      var q = this.pose(prev, cur.start);
      this.drawLine(prev, this.layout(prev), q.scale, q.y - h * profile.exitRise * e, (1 - e) * fade, 1 - e, prev.end, theme);
    }
    if (cur) {
      if (p.k < 1) {
        [0.05, 0.025].forEach(function (lag) { // 上移时的残影
          var r = this.pose(cur, t - lag);
          this.drawLine(cur, L, r.scale, r.y, r.alpha * 0.25 * fade, 0, null, theme);
        }, this);
      }
      this.drawLine(cur, L, p.scale, p.y, p.alpha * fade, 1, t, theme);
      if (t < cur.end) {
        var px = this.progressX(cur, L, t);
        this.sparks.emit(metrics.anchorX + (px - L.width / 2) * p.scale, p.y - L.size * p.scale * 0.55, h, dt);
      }
    }
    this.sparks.update(dt);
    this.sparks.draw(ctx, theme.spark);
    ctx.restore();
    this.mask();
  };
  // 四边渐隐：靠近画布边缘的字慢慢淡出，不会被硬切。
  Skyline.prototype.mask = function () {
    var ctx = this.ctx, w = this.canvas.width, ch = this.canvas.height;
    var top = this.bandTop, h = this.bandH;
    var fx = Math.min(0.08, (h * 0.8) / w);
    var inner = Math.min(0.5, (top + h * 0.12) / ch); // 上下渐隐区：留白加一点歌词带
    var opaque = this.opaque;
    var stop = function (g, at, keep) { g.addColorStop(at, opaque ? 'rgba(0,0,0,' + (1 - keep) + ')' : 'rgba(0,0,0,' + keep + ')'); };
    var gx = ctx.createLinearGradient(0, 0, w, 0);
    stop(gx, 0, 0); stop(gx, fx, 1); stop(gx, 1 - fx, 1); stop(gx, 1, 0);
    var gy = ctx.createLinearGradient(0, 0, 0, ch);
    stop(gy, 0, 0); stop(gy, inner, 1); stop(gy, 1 - inner, 1); stop(gy, 1, 0);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = opaque ? 'source-over' : 'destination-in';
    if (!this.taskbarMode) {
      ctx.fillStyle = gx;
      ctx.fillRect(0, 0, w, ch);
    }
    ctx.fillStyle = gy;
    ctx.fillRect(0, 0, w, ch);
    ctx.restore();
  };
  // 词云当前状态（opts.cloud3d 时用）：x、y 为歌词带内的像素坐标，z 为景深（FOCUS_Z 处和当前句一样清楚），
  // alpha 已含淡入淡出、避让当前句和左右边缘渐隐，blur 为模糊半径与字号之比。
  Skyline.prototype.cloudView = function () {
    var w = this.canvas.width, h = this.bandH, keep = this.keep, fx = Math.min(0.08, (h * 0.8) / w);
    var items = [];
    var cloudScale = this.cloudSizeScale();
    if (!h || !keep) return { w: w, h: h, focusSize: sizeAt(CLOUD_FOCUS, h) * cloudScale, items: items };
    this.cloud.items.forEach(function (it) {
      var size = sizeAt(it.z, h) * cloudScale;
      if (!it.ratio) it.ratio = 0.6 * Math.max(1, String(it.text).length);
      var x = this.cloudPosition(it.x, it.ratio * size / 2);
      var edge = clamp01(Math.min(x, w - x) / (w * fx));
      var alpha = alphaAt(it.z) * Math.max(0, Math.min(1, it.fade)) * keep(x, it.ratio * size / 2) * edge;
      if (alpha < 0.01) return;
      items.push({ id: it.id, text: it.text, x: x, y: it.y, z: it.z, alpha: alpha, blur: blurAt(it.z, h) * cloudScale / size });
    }, this);
    return { w: w, h: h, focusSize: sizeAt(CLOUD_FOCUS, h) * cloudScale, items: items };
  };

  root.MineradioSkyline = {
    FONT: FONT,
    FOCUS_Z: CLOUD_FOCUS,
    create: function (canvas, opts) { return new Skyline(canvas, opts); },
    // 用歌词配色（desktopOverlayColors() 的 primary / secondary / highlight / glow）生成天际屏配色。
    themeFromColors: function (c) {
      c = c || {};
      return { unsung: c.primary, sung: c.highlight, glow: c.glow, cloud: c.secondary, spark: c.highlight };
    },
    // Fingerprint every displayed line and word while keeping the IPC key small.
    signature: function (lines) {
      if (!lines || !lines.length) return '';
      var content = JSON.stringify(lines.map(function (line) {
        return [line.t, line.duration, line.text, (line.words || []).map(function (word) {
          return [word.text, word.t, word.d, word.c0, word.c1];
        })];
      }));
      var forward = 0x811c9dc5;
      var backward = 0x811c9dc5;
      for (var i = 0; i < content.length; i++) {
        forward = Math.imul(forward ^ content.charCodeAt(i), 0x01000193);
        backward = Math.imul(backward ^ content.charCodeAt(content.length - 1 - i), 0x01000193);
      }
      return content.length + '|' + (forward >>> 0).toString(36) + '|' + (backward >>> 0).toString(36);
    }
  };
})(window);
