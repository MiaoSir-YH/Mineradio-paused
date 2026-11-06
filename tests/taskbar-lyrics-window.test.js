'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const layout = require('../desktop/taskbar-lyrics-layout');
const { TaskbarLyricsRuntime } = require('../desktop/taskbar-lyrics-runtime');
const source = fs.readFileSync(path.join(__dirname, '../desktop/main.js'), 'utf8');

const primary = { id: 101, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const secondary = { id: 202, scaleFactor: 1, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } };
function bar(display, handle) {
  return { monitorX: display.bounds.x, monitorY: display.bounds.y, monitorWidth: 1920, monitorHeight: 1080,
    x: display.bounds.x, y: 1040, width: 1920, height: 40, handle, pid: 42, visible: true };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

class FakeWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.bounds = { x: 0, y: 0, width: options.width || 920, height: options.height || 190 };
    this.destroyed = false; this.visible = false; this.sent = [];
    this.webContents = new EventEmitter();
    this.webContents.send = (channel, payload) => this.sent.push({ channel, payload: structuredClone(payload) });
    this.webContents.setFrameRate = () => {};
    this.webContents.setZoomFactor = () => {};
    this.webContents.startPainting = () => {};
    this.webContents.invalidate = () => {};
    this.webContents.getURL = () => 'http://127.0.0.1:1234/desktop-lyrics.html';
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  getBounds() { return { ...this.bounds }; }
  setBounds(value) { this.bounds = { ...value }; this.emit('moved'); }
  setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} setOpacity() {} setIgnoreMouseEvents() {}
  loadURL() { return Promise.resolve(); }
  showInactive() { this.visible = true; this.emit('show'); }
  hide() { this.visible = false; this.emit('hide'); }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; this.emit('closed'); }
  close() { this.destroy(); }
}

class FakeHost extends EventEmitter {
  constructor() { super(); this.layouts = []; this.frames = []; this.child = { pid: 700 }; this.stopped = false; }
  start(args) { this.args = args; return true; }
  setLayout(value) { this.layouts.push(structuredClone(value)); return true; }
  sendFrame(value) { this.frames.push(value); return true; }
  stop() { if (this.stopped) return false; this.stopped = true; queueMicrotask(() => this.emit('exit', { intentional: true })); return true; }
}

function harness() {
  const watchers = [], hosts = [], runtimes = [], sessions = [], handlers = new Map(), events = [];
  let displays = [primary, secondary], pendingRead;
  class Runtime extends TaskbarLyricsRuntime {
    constructor(options) { super({ ...options, hostFactory: () => { const host = new FakeHost(); hosts.push(host); return host; } }); runtimes.push(this); }
  }
  const ctx = vm.createContext({
    process: { platform: 'win32', pid: 123 }, console, BrowserWindow: FakeWindow, TaskbarLyricsRuntime: Runtime,
    app: { isPackaged: true }, path, crypto, __dirname: path.join(__dirname, '../desktop'),
    session: { fromPartition: () => { const isolated={protocol:{handle(){}},fetch(){}};sessions.push(isolated);return isolated; } },
    createLocalProtocolHandler: () => () => {}, localServer: null, mainServerPort: 1234,
    screen: {
      getAllDisplays: () => displays, getPrimaryDisplay: () => primary,
      getDisplayMatching: rect => displays.find(d => rect.x >= d.bounds.x && rect.x < d.bounds.x + d.bounds.width) || primary,
      screenToDipRect: (_win, rect) => rect,
    },
    ...layout,
    readWindowsTaskbars: () => new Promise(resolve => { pendingRead = resolve; }),
    watchWindowsTaskbars(callback, options = {}) {
      const watcher = new EventEmitter(); watcher.callback = callback; watcher.options = options;
      watcher.stdin = { destroyed: false, end() { watcher.stopped = true; queueMicrotask(() => watcher.emit('close', 0)); } };
      watcher.kill = () => { watcher.stopped = true; queueMicrotask(() => watcher.emit('close', null)); };
      watchers.push(watcher); return watcher;
    },
    desktopLyricsWindow: null, taskbarLyricsRuntime: null, taskbarLyricsRendererSession: null, taskbarLyricsRuntimeClosing: null,
    taskbarLyricsMultiProtocol:false, taskbarLyricsMultiEnabled:false, taskbarLyricsMultiSuspended:false, taskbarLyricsTargets:[],
    taskbarLyricsRuntimes:new Map(), taskbarLyricsMultiClosings:new Map(), taskbarLyricsMultiSessions:new Map(),
    desktopLyricsPendingTaskbarPositions:new Map(), taskbarLyricsDisplayRefreshTimer:null,
    taskbarLyricsRecreateAfterClose: false, desktopLyricsState: {}, desktopLyricsRequestedEnabled: true,
    desktopLyricsSkylineCache: null, desktopLyricsCustomFontCache: null, desktopLyricsUserBounds: null, desktopLyricsProgrammaticMove: false,
    desktopLyricsPointerCapture: false, desktopLyricsMouseIgnored: null, desktopLyricsTaskbarDrag: null, desktopLyricsTaskbarDragSession: 0,
    desktopLyricsLastTaskbarLayout: null, desktopLyricsTaskbarPointerPoller: null, desktopLyricsPendingTaskbarPosition: null,
    desktopLyricsTaskbarPositionRevision: 0, desktopLyricsMousePoller: null, desktopLyricsMousePollerBuffer: '', desktopLyricsHotBounds: null,
    desktopLyricsLastMiddleAt: 0, taskbarLyricsPhysicalRects: [], taskbarLyricsSnapshotReady: false, taskbarLyricsSnapshotVersion: 0,
    taskbarLyricsWatcher: null, taskbarLyricsWatcherClosing: null, taskbarLyricsRetryTimer: null, taskbarLyricsGuardState: null,
    taskbarLyricsGuardStatus: null, appQuitting: false, mainRendererOrigin: 'http://127.0.0.1:1234',
    mainWindow: { isDestroyed: () => false, webContents: { send: (channel, value) => events.push({ channel, value: structuredClone(value) }) } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    isTrustedMainWindowIpc: event => event === 'main', ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  });
  const start = source.indexOf('function overlayUrl('), end = source.indexOf('function nativeWindowHandleDecimal(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), ctx);
  ctx.isTrustedDesktopLyricsIpc = event => event === 'main' || event === 'overlay' || !!(event &&
    runtimes.some(runtime => runtime.window && event.sender === runtime.window.webContents));
  ctx.startDesktopLyricsMousePoller = () => {}; ctx.stopDesktopLyricsMousePoller = () => {};
  const ipcStart = source.indexOf("ipcMain.handle('mineradio-desktop-lyrics-set-dragging'");
  const ipcEnabled = source.indexOf("ipcMain.handle('mineradio-desktop-lyrics-set-enabled'");
  const ipcEnd = source.indexOf("ipcMain.handle('mineradio-wallpaper-set-enabled'", ipcStart);
  assert.ok(ipcEnabled >= 0 && ipcStart > ipcEnabled && ipcEnd > ipcStart);
  vm.runInContext(source.slice(ipcEnabled, ipcStart),ctx);
  vm.runInContext(source.slice(ipcStart, ipcEnd), ctx);
  return { ctx, watchers, hosts, runtimes, sessions, handlers, events, setDisplays: value => { displays = value; }, finishRead: value => pendingRead(value) };
}

function independentOutputs() {
  return {enabled:true,skyline:false,skylineKey:'multi-song',text:'Lyric',
    taskbarLyrics:{enabled:true,targets:[
      {displayId:'101',position:0.25,size:0.6,skylineSpacing:0,opacity:0.7,style:'normal'},
      {displayId:'202',position:0.75,size:1.6,skylineSpacing:1,opacity:0.9,style:'skyline'},
    ]}};
}

test('desktop and two taskbar lyric outputs coexist and close independently', async () => {
  const h=harness(), payload=independentOutputs();
  try {
    h.ctx.createDesktopLyricsWindow(payload);
    const desktop=h.ctx.desktopLyricsWindow;
    assert.ok(desktop,'desktop output was not created');
    assert.equal(h.watchers.length,1,'all screens must share one taskbar watcher');
    h.watchers[0].callback([bar(primary,'555'),bar(secondary,'777')]);
    await tick();await tick();
    assert.equal(h.ctx.taskbarLyricsRuntimes.size,2);
    const first=h.ctx.taskbarLyricsRuntimes.get('101').runtime,second=h.ctx.taskbarLyricsRuntimes.get('202').runtime;
    assert.notEqual(first,second);assert.notEqual(first.session,second.session);
    assert.notEqual(first.window,desktop);assert.notEqual(second.window,desktop);
    assert.equal(first.layout.displayId,'101');assert.equal(second.layout.displayId,'202');
    assert.equal(first.state.taskbarSize,0.6);assert.equal(first.state.taskbarSkylineSpacing,0);
    assert.equal(first.state.opacity,0.7);assert.equal(first.state.skyline,false);
    assert.equal(second.state.taskbarSize,1.6);assert.equal(second.state.taskbarSkylineSpacing,1);
    assert.equal(second.state.opacity,0.9);assert.equal(second.state.skyline,true);
    h.ctx.createDesktopLyricsWindow({...payload,enabled:false});
    await tick();assert.equal(desktop.destroyed,true);
    assert.equal(first.closed,false);assert.equal(second.closed,false);
    h.ctx.createDesktopLyricsWindow({...payload,enabled:true,taskbarLyrics:{...payload.taskbarLyrics,enabled:false}});
    await tick();await tick();
    assert.ok(h.ctx.desktopLyricsWindow && !h.ctx.desktopLyricsWindow.destroyed);
    assert.equal(first.closed,true);assert.equal(second.closed,true);
  } finally {h.ctx.closeDesktopLyricsWindow();await tick();}
});

test('per-screen drag persistence and acknowledgements cannot affect another screen', async () => {
  const h=harness(),payload=independentOutputs();
  try {
    h.ctx.createDesktopLyricsWindow(payload);
    h.watchers[0].callback([bar(primary,'555'),bar(secondary,'777')]);await tick();await tick();
    const first=h.ctx.taskbarLyricsRuntimes.get('101').runtime,second=h.ctx.taskbarLyricsRuntimes.get('202').runtime;
    first.host.emit('ready',{hwnd:'123',parent:'555'});second.host.emit('ready',{hwnd:'124',parent:'777'});
    const movedFirstX=first.layout.physical.x+100;
    first.host.emit('drag-end',{x:movedFirstX,generation:first.generation});
    second.host.emit('drag-end',{x:second.layout.physical.x-100,generation:second.generation});
    const changes=h.events.filter(value=>value.channel==='mineradio-desktop-lyrics-taskbar-position-changed').map(value=>value.value);
    assert.equal(changes.length,2);
    assert.deepEqual(changes.map(value=>value.displayId),['101','202']);
    assert.deepEqual(changes.map(value=>value.physicalDisplayId),['101','202']);
    assert.notEqual(changes[0].revision,changes[1].revision);
    const pending=h.ctx.desktopLyricsPendingTaskbarPositions;
    assert.equal(pending.get('101').position,changes[0].position);
    assert.equal(pending.get('202').position,changes[1].position);
    h.ctx.createDesktopLyricsWindow(payload);
    assert.equal(pending.get('101').position,changes[0].position,'old payload overwrote screen 101 drag');
    assert.equal(pending.get('202').position,changes[1].position,'old payload overwrote screen 202 drag');
    const ack=h.handlers.get('mineradio-desktop-lyrics-ack-taskbar-position');
    assert.equal((await ack('main',changes[0].revision,'202')).ok,false);
    assert.equal((await ack('main',changes[0].revision,'101')).ok,true);
    assert.equal(pending.has('101'),false);assert.equal(pending.has('202'),true);
    h.watchers[0].callback([bar(primary,'555'),bar(secondary,'777')]);await tick();
    assert.equal(first.layout.physical.x,movedFirstX,'a taskbar snapshot after ACK must not restore the old position');
    assert.equal((await ack('main',changes[1].revision,'202')).ok,true);
    assert.equal(pending.size,0);
  } finally {h.ctx.closeDesktopLyricsWindow();await tick();}
});

test('taskbar-only output opens independently and late updates cannot reopen disabled outputs', async () => {
  const h=harness(),payload={...independentOutputs(),enabled:false};
  try {
    const set=h.handlers.get('mineradio-desktop-lyrics-set-enabled');
    const update=h.handlers.get('mineradio-desktop-lyrics-update');
    assert.equal((await set('main',false,payload)).ok,true);
    assert.equal(h.ctx.desktopLyricsWindow,null,'taskbar-only state must not open a desktop window');
    const watcher=h.watchers[0];watcher.callback([bar(primary,'555'),bar(secondary,'777')]);await tick();await tick();
    assert.equal(h.ctx.taskbarLyricsRuntimes.size,2);
    assert.equal((await set('main',false,{...payload,taskbarLyrics:{...payload.taskbarLyrics,enabled:false}})).ok,true);
    await tick();await tick();
    assert.equal(h.ctx.taskbarLyricsRuntimes.size,0);
    assert.equal((await update('main',{...payload,enabled:true})).ok,true);
    watcher.callback([bar(primary,'555'),bar(secondary,'777')]);await tick();await tick();
    assert.equal(h.ctx.desktopLyricsWindow,null);
    assert.equal(h.ctx.taskbarLyricsRuntimes.size,0,'late payload or taskbar snapshot reopened disabled outputs');
  } finally {h.ctx.closeDesktopLyricsWindow();await tick();}
});

test('removing one screen keeps the other taskbar and desktop outputs running', async () => {
  const h=harness(),payload=independentOutputs();
  try {
    h.ctx.createDesktopLyricsWindow(payload);
    h.watchers[0].callback([bar(primary,'555'),bar(secondary,'777')]);await tick();await tick();
    const desktop=h.ctx.desktopLyricsWindow;
    const first=h.ctx.taskbarLyricsRuntimes.get('101').runtime,second=h.ctx.taskbarLyricsRuntimes.get('202').runtime;
    const removedHost=second.host, before=h.events.length;
    h.ctx.createDesktopLyricsWindow({...payload,taskbarLyrics:{enabled:true,targets:[payload.taskbarLyrics.targets[0]]}});
    await tick();await tick();
    assert.equal(h.ctx.desktopLyricsWindow,desktop);assert.equal(desktop.destroyed,false);
    assert.equal(h.ctx.taskbarLyricsRuntimes.get('101').runtime,first);assert.equal(first.closed,false);
    assert.equal(h.ctx.taskbarLyricsRuntimes.has('202'),false);assert.equal(second.closed,true);
    removedHost.emit('drag-end',{x:second.layout?second.layout.physical.x+20:2000,generation:second.generation});
    assert.equal(h.events.length,before,'removed screen sent a late event');
    const update=h.handlers.get('mineradio-desktop-lyrics-update');
    assert.equal((await update('main',payload)).ok,true);
    h.watchers[0].callback([bar(primary,'555'),bar(secondary,'777')]);await tick();await tick();
    assert.equal(h.ctx.taskbarLyricsRuntimes.has('202'),false,'late targets must not re-enable a removed screen');
    assert.equal(h.ctx.taskbarLyricsRuntimes.get('101').runtime,first);
  } finally {h.ctx.closeDesktopLyricsWindow();await tick();}
});

test('hot bounds are routed only to the taskbar renderer that sent them', async () => {
  const h=harness(),payload=independentOutputs();
  try {
    h.ctx.createDesktopLyricsWindow(payload);
    h.watchers[0].callback([bar(primary,'555'),bar(secondary,'777')]);await tick();await tick();
    const first=h.ctx.taskbarLyricsRuntimes.get('101').runtime,second=h.ctx.taskbarLyricsRuntimes.get('202').runtime;
    const set=h.handlers.get('mineradio-desktop-lyrics-set-hot-bounds');
    const bounds={left:4,top:5,right:100,bottom:30,viewportWidth:600,viewportHeight:40};
    const secondBounds={...bounds,viewportWidth:second.layout.logical.width,viewportHeight:second.layout.logical.height};
    assert.equal((await set({sender:first.window.webContents},bounds,first.generation)).ok,true);
    assert.ok(first.hot);assert.equal(second.hot,null);
    assert.equal((await set({sender:second.window.webContents},secondBounds,second.generation-1)).ok,false);
    assert.equal(second.hot,null);
    assert.equal((await set({sender:second.window.webContents},secondBounds,second.generation)).ok,true);
    assert.ok(second.hot);
  } finally {h.ctx.closeDesktopLyricsWindow();await tick();}
});

test('disconnecting one selected display keeps its preference and does not move it to the other', async () => {
  const h=harness(),payload=independentOutputs();
  try {
    h.ctx.createDesktopLyricsWindow(payload);
    const watcher=h.watchers[0];watcher.callback([bar(primary,'555'),bar(secondary,'777')]);await tick();await tick();
    const first=h.ctx.taskbarLyricsRuntimes.get('101').runtime,second=h.ctx.taskbarLyricsRuntimes.get('202').runtime;
    const oldHost=second.host,oldX=second.layout.physical.x;
    oldHost.emit('ready',{hwnd:'124',parent:'777'});
    oldHost.emit('drag-end',{x:oldX+50,generation:second.generation});
    const eventCount=h.events.filter(value=>value.channel==='mineradio-desktop-lyrics-taskbar-position-changed').length;
    assert.equal(eventCount,1);
    const pending=h.ctx.desktopLyricsPendingTaskbarPositions.get('202');
    assert.ok(pending,'unacknowledged screen position is missing');
    h.setDisplays([primary]);watcher.callback([bar(primary,'555')]);await tick();await tick();
    assert.ok(!first.closed && first.layout.displayId==='101');
    assert.ok(second.closed || !second.layout,'disconnected display must stop its host rather than move to primary');
    oldHost.emit('drag-end',{x:oldX+100,generation:second.generation});
    assert.equal(h.events.filter(value=>value.channel==='mineradio-desktop-lyrics-taskbar-position-changed').length,eventCount);
    assert.equal(h.ctx.desktopLyricsPendingTaskbarPositions.get('202').revision,pending.revision);
    h.setDisplays([primary,secondary]);watcher.callback([bar(primary,'555'),bar(secondary,'777')]);await tick();await tick();
    const restored=h.ctx.taskbarLyricsRuntimes.get('202').runtime;
    assert.equal(restored.layout.displayId,'202');assert.equal(restored.layout.physical.x,oldX+50);
    assert.ok(!first.closed && first.layout.displayId==='101');
  } finally {h.ctx.closeDesktopLyricsWindow();await tick();}
});

test('a taskbar-only forced Skyline output retains complete lines for renderer reload', async () => {
  const h=harness(),payload=independentOutputs();
  const lines=[{t:0,text:'Words',duration:2,words:[{text:'Words',t:0,d:2,c0:0,c1:5}]}];
  payload.enabled=false;payload.skylineLines=lines;
  payload.taskbarLyrics.targets=[payload.taskbarLyrics.targets[1]];
  try {
    h.ctx.createDesktopLyricsWindow(payload);
    h.watchers[0].callback([bar(primary,'555'),bar(secondary,'777')]);await tick();await tick();
    const runtime=h.ctx.taskbarLyricsRuntimes.get('202').runtime;
    assert.equal(runtime.state.skyline,true,'screen explicitly requests Skyline even when desktop does not');
    runtime.window.webContents.emit('did-finish-load');
    h.ctx.createDesktopLyricsWindow({...payload,skylineLines:null});
    runtime.window.webContents.emit('did-finish-load');
    const frame=runtime.window.sent.filter(value=>value.channel==='mineradio-desktop-lyrics-state').at(-1).payload;
    assert.deepEqual(frame.skylineLines,lines,'full lyrics must replay after a compact frame and renderer reload');
  } finally {h.ctx.closeDesktopLyricsWindow();await tick();}
});

test('automatic primary selection and its explicit display ID do not create duplicate taskbar hosts', async () => {
  const h=harness(),payload=independentOutputs(),explicit=payload.taskbarLyrics.targets[0];
  payload.taskbarLyrics.targets=[{...explicit,displayId:'',position:0.1},explicit];
  try {
    h.ctx.createDesktopLyricsWindow(payload);
    h.watchers[0].callback([bar(primary,'555'),bar(secondary,'777')]);await tick();await tick();
    assert.equal(h.ctx.taskbarLyricsRuntimes.size,1);
    const entry=h.ctx.taskbarLyricsRuntimes.get('101');
    assert.ok(entry);assert.equal(entry.displayId,'101','explicit selection wins the duplicate');
    assert.equal(entry.runtime.layout.displayId,'101');
    assert.equal(entry.runtime.layout.physical.x,Math.round(entry.runtime.layout.minX+
      (entry.runtime.layout.maxX-entry.runtime.layout.minX)*explicit.position));
  } finally {h.ctx.closeDesktopLyricsWindow();await tick();}
});

test('changing an automatic primary target to an explicit ID rejects messages from the old generation', async () => {
  const h=harness(),payload=independentOutputs(),actions=[];
  h.ctx.sendGlobalHotkeyAction=action=>actions.push(action);
  const auto={...payload.taskbarLyrics.targets[0],displayId:''};
  payload.taskbarLyrics.targets=[auto];
  try {
    h.ctx.createDesktopLyricsWindow(payload);
    h.watchers[0].callback([bar(primary,'555'),bar(secondary,'777')]);await tick();await tick();
    const entry=h.ctx.taskbarLyricsRuntimes.get('101'),runtime=entry.runtime,host=runtime.host;
    assert.equal(entry.displayId,'');host.emit('ready',{hwnd:'123',parent:'555'});
    const oldGeneration=runtime.generation,oldX=runtime.layout.physical.x;
    h.ctx.createDesktopLyricsWindow({...payload,taskbarLyrics:{enabled:true,targets:[{...auto,displayId:'101'}]}});
    await tick();
    const current=h.ctx.taskbarLyricsRuntimes.get('101');
    assert.equal(current.runtime,runtime,'rekey must keep the physical screen runtime');
    assert.equal(runtime.host,host,'rekey must keep the physical child host');
    assert.equal(current.displayId,'101');
    assert.ok(runtime.generation>oldGeneration,'logical target change must invalidate queued old messages');
    host.emit('click-action',{action:'next',generation:oldGeneration});
    host.emit('drag-end',{x:oldX+100,generation:oldGeneration});
    assert.deepEqual(actions,[]);
    assert.equal(h.ctx.desktopLyricsPendingTaskbarPositions.size,0);
    host.emit('click-action',{action:'previous',generation:runtime.generation});
    assert.deepEqual(actions,['prevTrack']);
  } finally {h.ctx.closeDesktopLyricsWindow();await tick();}
});

test('Skyline gap resizes only its own runtime, preserves the lyric anchor, and invalidates old frames', async () => {
  const h=harness(),payload=independentOutputs();
  payload.taskbarLyrics.targets[1].skylineSpacing=0.5;
  try {
    h.ctx.createDesktopLyricsWindow(payload);
    h.watchers[0].callback([bar(primary,'555'),bar(secondary,'777')]);await tick();await tick();
    const first=h.ctx.taskbarLyricsRuntimes.get('101').runtime,second=h.ctx.taskbarLyricsRuntimes.get('202').runtime;
    first.host.emit('ready',{hwnd:'123',parent:'555'});second.host.emit('ready',{hwnd:'124',parent:'777'});
    second.window.webContents.emit('did-finish-load');
    const before={x:second.layout.physical.x,width:second.layout.physical.width,
      anchor:second.state.taskbarAnchorX,referenceWidth:second.state.taskbarReferenceWidth,generation:second.generation};
    const firstWidth=first.layout.physical.width,firstX=first.layout.physical.x,host=second.host;
    assert.ok(Number.isFinite(before.anchor) && Number.isFinite(before.referenceWidth));
    const wider={...payload,taskbarLyrics:{...payload.taskbarLyrics,targets:payload.taskbarLyrics.targets.map(target=>
      target.displayId==='202'?{...target,skylineSpacing:1}:target)}};
    h.ctx.createDesktopLyricsWindow(wider);await tick();
    assert.equal(h.ctx.taskbarLyricsRuntimes.get('202').runtime,second);
    assert.equal(second.host,host,'resizing must not replace the native host');
    assert.ok(second.layout.physical.width>before.width);
    assert.ok(Math.abs(second.layout.physical.x+second.state.taskbarAnchorX-(before.x+before.anchor))<=1);
    assert.equal(second.state.taskbarReferenceWidth,before.referenceWidth);
    assert.ok(second.generation>before.generation,'resizing requires a new layout generation');
    assert.equal(second.setHotBounds({left:1,top:1,right:20,bottom:20,viewportWidth:600,viewportHeight:40},before.generation),false);
    assert.equal(first.layout.physical.width,firstWidth);assert.equal(first.layout.physical.x,firstX);
    assert.equal(h.events.filter(value=>value.channel==='mineradio-desktop-lyrics-taskbar-position-changed').length,0,
      'changing gap must not create a drag or persist a new position');
    h.ctx.createDesktopLyricsWindow(payload);await tick();
    assert.equal(second.layout.physical.width,before.width);
    assert.ok(Math.abs(second.layout.physical.x+second.state.taskbarAnchorX-(before.x+before.anchor))<=1);
  } finally {h.ctx.closeDesktopLyricsWindow();await tick();}
});

test('dragging a widened slot at either edge persists the old reference position on a scaled screen', async () => {
  for(const position of [0,1]) {
    const h=harness(),payload=independentOutputs();
    payload.taskbarLyrics.targets[1]={...payload.taskbarLyrics.targets[1],position,style:'skyline',skylineSpacing:1};
    const scaled={...secondary,scaleFactor:1.5,bounds:{x:1920,y:0,width:1280,height:720},
      workArea:{x:1920,y:0,width:1280,height:693}};
    h.setDisplays([primary,scaled]);
    h.ctx.screen.screenToDipRect=(_window,rect)=>rect.x>=1920
      ? {x:1920+(rect.x-1920)/1.5,y:rect.y/1.5,width:rect.width/1.5,height:rect.height/1.5}
      : rect;
    try {
      h.ctx.createDesktopLyricsWindow(payload);
      h.watchers[0].callback([bar(primary,'555'),bar(secondary,'777')]);await tick();await tick();
      const first=h.ctx.taskbarLyricsRuntimes.get('101').runtime,second=h.ctx.taskbarLyricsRuntimes.get('202').runtime;
      second.host.emit('ready',{hwnd:'124',parent:'777'});
      const before=second.layout,otherX=first.layout.physical.x,delta=position===0?90:-90;
      const expected=position+delta/before.referenceTravel;
      second.host.emit('drag-end',{x:before.physical.x+delta,generation:second.generation});
      const changes=h.events.filter(value=>value.channel==='mineradio-desktop-lyrics-taskbar-position-changed').map(value=>value.value);
      assert.equal(changes.length,1);assert.equal(changes[0].displayId,'202');
      assert.ok(Math.abs(changes[0].position-expected)<0.002,
        `position must be measured against the unexpanded centre range: ${JSON.stringify({position,expected,actual:changes[0].position,before})}`);
      assert.equal(first.layout.physical.x,otherX,'dragging one scaled screen moved the other');
      const ack=h.handlers.get('mineradio-desktop-lyrics-ack-taskbar-position');
      assert.equal((await ack('main',changes[0].revision,'202')).ok,true);
      h.watchers[0].callback([bar(primary,'555'),bar(secondary,'777')]);await tick();
      assert.ok(Math.abs((second.layout.physical.x+second.layout.anchorOffset)-
        (before.physical.x+before.anchorOffset+delta))<=1,'snapshot after ACK moved the lyric anchor');
    } finally {h.ctx.closeDesktopLyricsWindow();await tick();}
  }
});

test('follow style expands only while Skyline is active; normal style never expands', async () => {
  const h=harness(),payload=independentOutputs();
  payload.taskbarLyrics.targets=[{...payload.taskbarLyrics.targets[0],skylineSpacing:1,style:'normal'}];
  payload.skyline=true;
  try {
    h.ctx.createDesktopLyricsWindow(payload);
    h.watchers[0].callback([bar(primary,'555')]);await tick();await tick();
    const runtime=h.ctx.taskbarLyricsRuntimes.get('101').runtime;
    const normalWidth=runtime.layout.physical.width;
    const follow={...payload,taskbarLyrics:{enabled:true,targets:[{...payload.taskbarLyrics.targets[0],style:'follow'}]}};
    h.ctx.createDesktopLyricsWindow(follow);await tick();
    assert.ok(runtime.layout.physical.width>normalWidth,'follow Skyline should expand');
    h.ctx.createDesktopLyricsWindow({...follow,skyline:false});await tick();
    assert.equal(runtime.layout.physical.width,normalWidth,'follow non-Skyline should use the original slot');
  } finally {h.ctx.closeDesktopLyricsWindow();await tick();}
});

test('switching modes preserves desktop position and starts only the native taskbar host', async () => {
  const h = harness(), desktop = h.ctx.createDesktopLyricsWindow({ taskbarMode: false, clickThrough: false });
  desktop.emit('ready-to-show'); h.ctx.desktopLyricsProgrammaticMove = false;
  desktop.setBounds({ x: 100, y: 200, width: 920, height: 340 });
  const overlay = h.ctx.createDesktopLyricsWindow({ taskbarMode: true, taskbarDisplayId: '101', taskbarPosition: 0.5 });
  assert.equal(desktop.destroyed, true); assert.equal(overlay, h.runtimes[0].window);
  assert.deepEqual(h.watchers[0].options, {}, 'snapshot watcher never installs the obsolete popup guard');
  h.watchers[0].callback([bar(primary, '555')]);
  assert.equal(h.hosts.length, 1); assert.equal(h.hosts[0].args.handle, '555');
  assert.equal(h.runtimes[0].layout.physical.x, 660);
  h.ctx.createDesktopLyricsWindow({ taskbarMode: false }); await tick(); await tick();
  assert.equal(h.hosts[0].stopped, true); assert.equal(h.runtimes[0].closed, true);
  const restored = h.ctx.desktopLyricsWindow;
  assert.ok(restored && restored !== desktop); assert.deepEqual(restored.getBounds(), { x: 100, y: 200, width: 920, height: 340 });
  h.ctx.closeDesktopLyricsWindow();
});

test('same-screen snapshot loss preserves the host; switching to a missing taskbar stops the old host', async () => {
  const h = harness(); h.ctx.createDesktopLyricsWindow({ taskbarMode: true, taskbarDisplayId: '202', taskbarPosition: 0.5 });
  h.watchers[0].callback([bar(primary, '555'), bar(secondary, '777')]);
  const runtime = h.runtimes[0], first = h.hosts[0], original = runtime.layout.physical.x;
  assert.equal(runtime.layout.displayId, '202');
  h.watchers[0].callback([bar(primary, '555')]);
  assert.equal(runtime.layout.physical.x, original); assert.equal(first.stopped, false);
  h.ctx.createDesktopLyricsWindow({ taskbarDisplayId: '101' }); await tick(); await tick();
  assert.equal(first.stopped, true); assert.equal(runtime.layout.displayId, '101');
  h.watchers[0].callback([bar(primary, '555')]);
  h.ctx.createDesktopLyricsWindow({ taskbarDisplayId: '202' });
  assert.equal(runtime.layout, null, 'a missing newly selected taskbar must not leave lyrics on the previous screen');
  await tick(); h.watchers[0].callback([bar(primary, '555'), bar(secondary, '777')]); await tick();
  assert.equal(runtime.layout.displayId, '202');
  h.setDisplays([primary]); h.watchers[0].callback([bar(primary, '555')]);
  assert.equal(runtime.layout.displayId, '101', 'unplugging a display falls back to the primary');
  h.ctx.closeDesktopLyricsWindow();
});

test('native drag position is persisted and protected from stale frames until acknowledgement', async () => {
  const h = harness(); h.ctx.createDesktopLyricsWindow({ taskbarMode: true, taskbarDisplayId: '101', taskbarPosition: 0.5 });
  h.watchers[0].callback([bar(primary, '555')]);
  const runtime = h.runtimes[0], host = h.hosts[0]; host.emit('ready', { hwnd: '123', parent: '555' });
  host.emit('drag-end', { x: 880, generation: runtime.generation });
  const change = h.events.find(item => item.channel === 'mineradio-desktop-lyrics-taskbar-position-changed').value;
  assert.equal(change.position, 2 / 3); assert.equal(change.displayId, '101');
  h.ctx.createDesktopLyricsWindow({ taskbarPosition: 0.5 });
  assert.equal(h.ctx.desktopLyricsState.taskbarPosition, 2 / 3);
  assert.equal((await h.handlers.get('mineradio-desktop-lyrics-ack-taskbar-position')('main', change.revision)).ok, true);
  h.ctx.createDesktopLyricsWindow({ taskbarPosition: 0.8 }); assert.equal(h.ctx.desktopLyricsState.taskbarPosition, 0.8);
  h.ctx.closeDesktopLyricsWindow();
});

test('native click actions use the player hotkeys only while current taskbar lyrics are enabled', async () => {
  const h=harness(), actions=[];
  h.ctx.sendGlobalHotkeyAction=action=>actions.push(action);
  h.ctx.createDesktopLyricsWindow({taskbarMode:true,taskbarDisplayId:'101'});
  h.watchers[0].callback([bar(primary,'555')]);
  const runtime=h.runtimes[0], host=h.hosts[0];
  host.emit('ready',{hwnd:'123',parent:'555'});
  host.emit('click-action',{action:'next',generation:runtime.generation});
  host.emit('click-action',{action:'previous',generation:runtime.generation});
  host.emit('click-action',{action:'next',generation:runtime.generation-1});
  h.ctx.desktopLyricsRequestedEnabled=false;
  host.emit('click-action',{action:'next',generation:runtime.generation});
  h.ctx.desktopLyricsRequestedEnabled=true;
  h.ctx.desktopLyricsState.taskbarMode=false;
  host.emit('click-action',{action:'previous',generation:runtime.generation});
  h.ctx.closeDesktopLyricsWindow();
  host.emit('click-action',{action:'next',generation:runtime.generation});
  await tick();
  assert.deepEqual(actions,['nextTrack','prevTrack']);
});

test('late snapshots and intentional close cannot resurrect the taskbar host', async () => {
  const h = harness(); h.ctx.createDesktopLyricsWindow({ taskbarMode: true, taskbarDisplayId: '101' });
  const watcher = h.watchers[0]; watcher.callback([bar(primary, '555')]);
  const pending = h.ctx.refreshTaskbarLyricsSnapshot();
  h.ctx.closeDesktopLyricsWindow(); watcher.callback([bar(primary, '555')]); h.finishRead([bar(primary, '555')]);
  await pending; await tick(); await tick();
  assert.equal(h.ctx.desktopLyricsRequestedEnabled, false); assert.equal(h.ctx.taskbarLyricsRuntime, null);
  assert.equal(h.hosts.length, 1); assert.equal(h.hosts[0].stopped, true);
});

test('an offscreen renderer crash rebuilds one runtime without disabling the user preference', async () => {
  const h = harness(); h.ctx.createDesktopLyricsWindow({ taskbarMode: true, taskbarDisplayId: '101' });
  h.watchers[0].callback([bar(primary, '555')]);
  const original = h.runtimes[0];
  original.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await tick(); await tick();
  assert.equal(original.closed, true); assert.equal(h.hosts[0].stopped, true);
  assert.equal(h.ctx.desktopLyricsRequestedEnabled, true);
  assert.equal(h.runtimes.length, 2); assert.equal(h.ctx.taskbarLyricsRuntime, h.runtimes[1]);
  assert.equal(h.events.some(item => item.channel === 'mineradio-desktop-lyrics-enabled-state' && item.value.enabled === false), false);
  h.ctx.closeDesktopLyricsWindow(); await tick();
  assert.equal(h.runtimes.length, 2);
});

test('offscreen renderer reload receives cached Skyline and custom font assets', () => {
  const h = harness(); const lines = [{ t: 0, text: 'Line', words: [{ text: 'Line', t: 0, d: 1 }] }];
  h.ctx.createDesktopLyricsWindow({ taskbarMode: true, skyline: true, skylineKey: 'A', skylineLines: lines,
    customFont: { id: 'font-A', dataUrl: 'data:font/woff2;base64,AA==' } });
  h.ctx.createDesktopLyricsWindow({ skylineLines: null, customFont: { id: 'font-A' } });
  const runtime = h.runtimes[0]; runtime.window.webContents.emit('did-finish-load');
  let frame = runtime.window.sent.filter(item => item.channel === 'mineradio-desktop-lyrics-state').at(-1).payload;
  assert.deepEqual(frame.skylineLines, lines); assert.equal(frame.customFont.dataUrl, 'data:font/woff2;base64,AA==');
  h.ctx.createDesktopLyricsWindow({ skylineKey: 'B', skylineLines: null, customFont: { id: 'font-B' } });
  h.ctx.sendDesktopLyricsState(true);
  frame = runtime.window.sent.filter(item => item.channel === 'mineradio-desktop-lyrics-state').at(-1).payload;
  assert.equal(frame.skylineLines, null); assert.equal(frame.customFont.dataUrl, undefined);
  h.ctx.closeDesktopLyricsWindow();
});

test('hot regions use the current renderer generation and accept null through IPC', async () => {
  const h = harness(); h.ctx.createDesktopLyricsWindow({ taskbarMode: true, taskbarDisplayId: '101' });
  h.watchers[0].callback([bar(primary, '555')]);
  const runtime = h.runtimes[0], set = h.handlers.get('mineradio-desktop-lyrics-set-hot-bounds');
  const bounds = { left: 4, top: 5, right: 100, bottom: 30, viewportWidth: 600, viewportHeight: 40 };
  assert.equal((await set('overlay', bounds, runtime.generation - 1)).ok, false);
  assert.equal((await set('overlay', bounds, runtime.generation)).ok, true);
  assert.equal((await set('overlay', null, runtime.generation)).ok, true); assert.equal(runtime.hot, null);
  h.ctx.closeDesktopLyricsWindow();
});

test('asar builds launch the explicitly unpacked taskbar helper', () => {
  const h = harness();
  h.ctx.process.resourcesPath = 'C:\\Mineradio\\resources';
  h.ctx.fs = { existsSync: file => file.endsWith(path.join('app.asar.unpacked', 'build', 'taskbar-lyrics-host.exe')) };
  h.ctx.createDesktopLyricsWindow({ taskbarMode: true, taskbarDisplayId: '101' });
  assert.equal(h.runtimes[0].executable, path.join('C:\\Mineradio\\resources', 'app.asar.unpacked', 'build', 'taskbar-lyrics-host.exe'));
  h.ctx.closeDesktopLyricsWindow();
});

test('native physical rectangles convert to DIP on a negative-coordinate scaled display', () => {
  const h = harness();
  const display = { id: 202, scaleFactor: 1.5, bounds: { x: -1280, y: -100, width: 1280, height: 1024 } };
  h.ctx.screen.screenToDipRect = () => display.bounds; h.ctx.screen.getDisplayMatching = () => display;
  h.ctx.taskbarLyricsPhysicalRects = [{ monitorX: -1920, monitorY: -150, monitorWidth: 1920, monitorHeight: 1536,
    x: -1920, y: 1326, width: 1920, height: 60, handle: '777', pid: 42 }];
  const result = h.ctx.taskbarLyricsDipRects(); assert.equal(result.length, 1); assert.equal(result[0].displayId, '202');
  assert.deepEqual(JSON.parse(JSON.stringify(result[0].bounds)), { x: -1280, y: 884, width: 1280, height: 40 });
  h.ctx.screen.getDisplayMatching = () => primary; assert.equal(h.ctx.taskbarLyricsDipRects().length, 0);
});

test('production and beta packages include the native taskbar host and its build hook', async () => {
  const { getConfig } = require('app-builder-lib/out/util/config/config');
  const minimatch = require('minimatch'), matches = minimatch.minimatch || minimatch;
  const root = path.resolve(__dirname, '..');
  for (const filename of ['package.json', 'electron-builder.internal-beta.json']) {
    const config = await getConfig(root, filename === 'package.json' ? null : path.join(root, filename), null);
    const patterns = config.files.flatMap(entry => typeof entry === 'string' ? [entry] : entry.filter || []);
    for (const file of ['desktop/taskbar-lyrics-layout.js', 'desktop/taskbar-lyrics-windows.js', 'desktop/taskbar-lyrics-runtime.js', 'desktop/taskbar-lyrics-host.js', 'build/taskbar-lyrics-host.exe']) {
      assert.ok(patterns.some(pattern => !pattern.startsWith('!') && matches(file, pattern)), `${filename} does not include ${file}`);
      assert.ok(!patterns.some(pattern => pattern.startsWith('!') && matches(file, pattern.slice(1))), `${filename} excludes ${file}`);
    }
    assert.equal(config.beforePack, 'scripts/build-taskbar-lyrics-host.js');
    if (config.asar) assert.ok(config.asarUnpack.includes('build/taskbar-lyrics-host.exe'), `${filename} must unpack the native host`);
  }
});
