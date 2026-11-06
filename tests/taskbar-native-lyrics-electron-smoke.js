'use strict';

// Isolated Windows E2E: real native child, offscreen renderer, Win32 input.
// The Start step is staged so its position comes from a fresh desktop screenshot.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

if (process.versions.electron) {
  const { app, BrowserWindow, globalShortcut, ipcMain, screen, session } = require('electron');
  const { execFile, spawn } = require('node:child_process');
  const { TaskbarLyricsHost } = require('../desktop/taskbar-lyrics-host');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const sync = process.env.MINERADIO_NATIVE_LYRICS_QA_SYNC;
  const phase = process.env.MINERADIO_NATIVE_LYRICS_QA_PHASE || 'exercise';
  const hostEvents = [], ipcEvents = [];
  const startHost = TaskbarLyricsHost.prototype.start;
  TaskbarLyricsHost.prototype.start = function(options) {
    if(process.env.MINERADIO_NATIVE_LYRICS_QA_HOST_EXE) this.executable=process.env.MINERADIO_NATIVE_LYRICS_QA_HOST_EXE;
    const started=startHost.call(this,options);
    if(started && this.child && this.child.stderr) {
      const pid=this.child.pid;
      this.child.stderr.on('data',chunk=>trace('host-stderr',{pid,text:String(chunk)}));
    }
    return started;
  };
  const frameMetadata = new WeakMap(), lastFrames = new WeakMap();
  const sendFrame = TaskbarLyricsHost.prototype.sendFrame;
  TaskbarLyricsHost.prototype.sendFrame = function(frame) {
    frameMetadata.set(this,{width:frame.width,height:frame.height,generation:frame.generation,
      hot:frame.hot,opacity:frame.opacity,bytes:frame.pixels && frame.pixels.byteLength,at:Date.now()});
    lastFrames.set(this,frame);
    return sendFrame.call(this,frame);
  };
  const emit = TaskbarLyricsHost.prototype.emit;
  TaskbarLyricsHost.prototype.emit = function(event, ...args) {
    if (['ready','drag-end','host-error','exit'].includes(event)) {
      hostEvents.push({ event, data:args[0] || null, pid:this.child && this.child.pid, host:this, at:Date.now() });
    }
    return emit.call(this,event,...args);
  };
  const handle = ipcMain.handle;
  ipcMain.handle = function(channel, listener) {
    if (!/^mineradio-desktop-lyrics-(.*position.*|set-enabled)$/.test(channel)) return handle.call(this,channel,listener);
    return handle.call(this,channel,async(event,...args)=>{
      const result=await listener(event,...args);
      ipcEvents.push({channel,args,result,at:Date.now()});
      return result;
    });
  };
  globalShortcut.register=()=>false;
  globalShortcut.unregister=()=>{};
  globalShortcut.isRegistered=()=>false;
  app.commandLine.appendSwitch('mute-audio');
  const timer=setTimeout(()=>{console.error('NATIVE_LYRICS_QA_TIMEOUT');app.quit();},360000);

  function trace(kind, detail) {
    fs.appendFileSync(sync+'.trace.jsonl',JSON.stringify({at:Date.now(),kind,detail})+'\n');
  }
  async function waitFor(label,predicate,timeout=15000) {
    const end=Date.now()+timeout;let last;
    while(Date.now()<end) {
      try {const value=await predicate();if(value)return value;}catch(error){last=error;}
      await sleep(75);
    }
    throw new Error(`${label} timed out${last?': '+last.message:''}`);
  }
  function mainWindow() {
    return BrowserWindow.getAllWindows().find(win=>!win.isDestroyed() && /^http:\/\/127\.0\.0\.1:\d+\/\?startupAttempt=/.test(win.webContents.getURL()));
  }
  function lyricsRenderer() {
    return BrowserWindow.getAllWindows().find(win=>!win.isDestroyed() && /\/desktop-lyrics\.html(?:[?#]|$)/.test(win.webContents.getURL()));
  }
  function latestHostFor(display) {
    return [...hostEvents].reverse().find(item=>{
      const layout=item.host.layout;
      if(item.event!=='ready' || !item.data || !item.host.child || !item.host.ready || item.host.child.pid!==item.pid || !layout)return false;
      const point=screen.screenToDipPoint({x:Math.round(layout.x+layout.width/2),y:Math.round(layout.y+layout.height/2)});
      const bounds=display.bounds;
      return point.x>=bounds.x && point.x<bounds.x+bounds.width && point.y>=bounds.y && point.y<bounds.y+bounds.height;
    });
  }
  async function evaluate(win,expression) {return win.webContents.executeJavaScript(expression,true);}
  async function runFile(file,args,timeout=10000) {
    return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-File',file,...args],
      {windowsHide:true,timeout},(error,stdout,stderr)=>{
        if(error)return reject(new Error(`${path.basename(file)} failed (${error.code}): ${stderr}`));
        try{resolve(JSON.parse(String(stdout).trim()));}catch(e){reject(new Error(`Invalid probe output: ${stdout} ${stderr}`));}
      }));
  }
  async function probe(action,host,point,dx=0) {
    let result;
    for(let attempt=1;attempt<=(action==='drag'?3:1);attempt++) {
      result=await runFile(path.join(__dirname,'taskbar-native-host-probe.ps1'),[
        '-Action',action,'-HostHwnd',String(host.data.hwnd),'-HostPid',String(host.pid),'-TaskbarHwnd',String(host.data.parent),
        '-PointX',String(Math.round(point.x)),'-PointY',String(Math.round(point.y)),'-DeltaX',String(dx)]);
      trace('native-'+action,{host:{hwnd:host.data.hwnd,pid:host.pid,parent:host.data.parent},point,dx,attempt,result});
      if(result.Reason!=='BUTTON_ACTIVE' || result.DownCount!==0 || attempt===3)break;
      await sleep(350);
    }
    return result;
  }
  async function rendererInfo(win) {
    return evaluate(win,`(() => ({taskbar:state.taskbarMode,enabled:state.enabled,skyline:!!skyline.on,devicePixelRatio,
      hot:typeof window.__mineradioTaskbarLyricHotBounds==='function'?window.__mineradioTaskbarLyricHotBounds():null,
      width:innerWidth,height:innerHeight,text:document.getElementById('line').textContent,
      line:(()=>{const r=document.getElementById('line').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})(),
      canvas:(()=>{const c=document.getElementById('skyline'),r=c.getBoundingClientRect();return {width:c.width,height:c.height,x:r.x,y:r.y,cssWidth:r.width,cssHeight:r.height}})(),
      font:getComputedStyle(document.getElementById('line')).fontSize}))()`);
  }
  async function skylineGeometry(win) {
    return evaluate(win,`(() => {
      const s=skyline.inst,c=document.getElementById('skyline');
      if(!s || !s.lines || s.idx<0 || typeof s.layoutProfile!=='function' || !c.width || !c.height)return null;
      const current=s.lines[s.idx],next=s.lines[s.idx+1],time=s.clock && Number.isFinite(s.clock.t)?s.clock.t:s.lastT;
      if(!current)return null;
      const r=c.getBoundingClientRect(),profile=s.layoutProfile(),main=s.layout(current),pose=s.pose(current,time);
      const following=next?s.layout(next):null,sy=r.height/c.height,sx=r.width/c.width;
      return {index:s.idx,time,profile,currentText:current.text,nextText:next && next.text,
        mainPx:main.size*pose.scale*sy,nextPx:following?following.size*profile.nextScale*sy:null,
        mainWidthPx:main.width*pose.scale*sx,canvasWidthPx:r.width,canvasHeightPx:r.height,
        canvasWidth:c.width,canvasHeight:c.height,devicePixelRatio};
    })()`);
  }
  async function setSkylineFixture(main,text,time,playing=false,longDuration=false) {
    const duration=longDuration?20:3, nextAt=longDuration?20:3.2, thirdAt=longDuration?23.2:6.4;
    const lines=[{t:0,duration,text,words:[{text,t:0,d:duration,c0:0,c1:text.length}]},
      {t:nextAt,duration:3,text:'下一句温柔响起'},{t:thirdAt,duration:3,text:'远方还有晴空'}];
    await evaluate(main,`window.__nativeQaPlayStart=performance.now();window.__nativeQaBaseTime=${Number(time)};
      desktopLyricsPlaybackPayload=()=>({time:window.__nativeQaBaseTime+(${playing?'(performance.now()-window.__nativeQaPlayStart)/1000':'0'}),duration:60,rate:1,lyricOffset:0});
      lyricsLines=${JSON.stringify(lines)};playing=${playing?'true':'false'};fx.lyricSkyline=true;applyDesktopLyricsState(true)`);
  }
  async function skylineSample(label,renderer,host,expectedText,index) {
    const geometry=await waitFor(`${label} Skyline geometry`,async()=>{const value=await skylineGeometry(renderer);
      return value && value.index===index && value.currentText===expectedText && value;},8000);
    const rect=await currentGeometry(host);
    const screenImage=await capture(label+'-screen',rect.Left,rect.Top,rect.Right-rect.Left,rect.Bottom-rect.Top);
    const image=await renderer.webContents.capturePage();assert.ok(!image.isEmpty(),`${label}: offscreen capture is empty`);
    const offscreen=sync+'.'+label+'-offscreen.png';fs.writeFileSync(offscreen,image.toPNG());
    const result={geometry,screen:screenImage,offscreen,zoomFactor:renderer.webContents.getZoomFactor(),frame:frameMetadata.get(host.host)};
    trace('skyline-sample',{label,...result});return result;
  }
  async function mainInfo(win) {
    return evaluate(win,`(() => ({enabled:fx.desktopLyrics,taskbar:fx.desktopLyricsTaskbar,
      displayId:String(fx.desktopLyricsTaskbarDisplayId||''),position:Number(fx.desktopLyricsTaskbarX),
      payload:Number(desktopLyricsPayload(false,false).taskbarPosition),saved:readSavedLyricLayout().desktopLyricsTaskbarX}))()`);
  }
  async function positionAfter(main,host,rect) {
    const layout=host.host.layout;
    assert.ok(layout && Number.isFinite(layout.minX) && layout.maxX>layout.minX,'native layout missing movement range');
    const expected=(rect.Left-layout.minX)/(layout.maxX-layout.minX);
    return waitFor('drag persisted and acknowledged',async()=>{
      const settings=await mainInfo(main);
      return Math.abs(settings.position-expected)<0.004 && Math.abs(settings.payload-settings.position)<0.001
        && Math.abs(Number(settings.saved)-settings.position)<0.001 && settings;
    },6000);
  }
  async function currentGeometry(host) {
    return waitFor('native child geometry',async()=>{
      const layout=host.host.layout;
      if(!layout)return false;
      const sample=await probe('probe',host,{x:layout.x+layout.width/2,y:layout.y+layout.height/2});
      return sample.HostExists && sample.HostVisible && sample.Parent===Number(host.data.parent)
        && sample.Before.Right-sample.Before.Left===layout.width && sample.Before.Bottom-sample.Before.Top===layout.height && sample.Before;
    },10000);
  }
  async function drag(main,renderer,host,dx,label,forcedPoint) {
    const info=await waitFor(`${label} hot region`,async()=>{const value=await rendererInfo(renderer);return value.hot && value.hot.right>value.hot.left && value;});
    const rect=await currentGeometry(host);
    const point=forcedPoint || {x:rect.Left+(info.hot.left+info.hot.right)/2*(rect.Right-rect.Left)/info.width,
      y:rect.Top+(info.hot.top+info.hot.bottom)/2*(rect.Bottom-rect.Top)/info.height};
    await waitFor(`${label} native hot hit`,async()=>{const hit=await probe('probe',host,point);return hit.HitHost;},8000);
    const ackBefore=ipcEvents.filter(item=>item.channel.endsWith('ack-taskbar-position') && item.result && item.result.ok).length;
    const native=await probe('drag',host,point,dx);
    assert.equal(native.Ok,true,`${label}: ${native.Reason}`);
    assert.equal(native.HitHost,true,`${label}: hit missed child`);
    assert.equal(native.CaptureHwnd,Number(host.data.hwnd),`${label}: capture left child`);
    assert.equal(native.After.Top,native.Before.Top,`${label}: y changed`);
    assert.ok(Math.abs(native.After.Left-native.Before.Left)>30,`${label}: child did not move`);
    assert.notEqual(native.ForegroundPidAfter,host.pid,`${label}: host took foreground`);
    const settings=await positionAfter(main,host,native.After);
    await waitFor(`${label} ack`,()=>ipcEvents.filter(item=>item.channel.endsWith('ack-taskbar-position') && item.result && item.result.ok).length>ackBefore,6000);
    trace('drag-result',{label,native,settings,renderer:info});
    return {native,settings};
  }
  async function lowOpacityGap(main,renderer,host) {
    const requestedAt=Date.now();
    await evaluate(main,'fx.desktopLyricsOpacity=0.3;applyDesktopLyricsState(true)');
    const frame=await waitFor('low-opacity native frame',()=>{
      const meta=frameMetadata.get(host.host),value=lastFrames.get(host.host);
      return meta && value && meta.at>=requestedAt && Math.abs(meta.opacity-77)<=1 && value;
    },8000);
    const info=await rendererInfo(renderer),rect=await currentGeometry(host),line=info.line,hot=info.hot;
    assert.ok(hot && line.width>0 && line.height>0,'low-opacity lyric bounds missing');
    const left=Math.max(hot.left,line.x+2),right=Math.min(hot.right,line.x+line.width-2);
    const top=Math.max(hot.top,line.y+2),bottom=Math.min(hot.bottom,line.y+line.height-2);
    let candidate=null;
    for(let y=Math.ceil(top*frame.height/info.height);y<Math.floor(bottom*frame.height/info.height);y++) {
      for(let x=Math.ceil(left*frame.width/info.width);x<Math.floor(right*frame.width/info.width);x++) {
        if(frame.pixels[(y*frame.width+x)*4+3]<=1) {candidate={x:rect.Left+x,y:rect.Top+y,sourceAlpha:frame.pixels[(y*frame.width+x)*4+3]};break;}
      }
      if(candidate)break;
    }
    assert.ok(candidate,'no transparent pixel inside the lyric bounds');
    const hit=await waitFor('transparent lyric gap hits child',async()=>{const value=await probe('probe',host,candidate);return value.HitHost && value;},8000);
    const moved=await drag(main,renderer,host,-90,'low-opacity transparent lyric gap',candidate);
    trace('low-opacity-gap',{candidate,hit,moved,frame:frameMetadata.get(host.host)});
    await evaluate(main,'fx.desktopLyricsOpacity=0.92;applyDesktopLyricsState(true)');
    await drag(main,renderer,host,90,'restore after low-opacity gap');
    return {candidate,hit,moved};
  }
  async function threshold(main,renderer,host,dx,label) {
    const info=await rendererInfo(renderer),rect=await currentGeometry(host);
    assert.ok(info.hot,`${label}: lyric hot region missing`);
    const point={x:rect.Left+(info.hot.left+info.hot.right)/2*(rect.Right-rect.Left)/info.width,
      y:rect.Top+(info.hot.top+info.hot.bottom)/2*(rect.Bottom-rect.Top)/info.height};
    const before=await mainInfo(main),ackBefore=ipcEvents.filter(item=>item.channel.endsWith('ack-taskbar-position') && item.result && item.result.ok).length;
    const native=await probe('drag',host,point,dx);
    assert.equal(native.Ok,true,`${label}: ${native.Reason}`);
    assert.equal(native.After.Left,native.Before.Left,`${label}: child moved`);
    assert.equal(native.After.Top,native.Before.Top,`${label}: child changed height`);
    await sleep(350);
    const after=await mainInfo(main);
    assert.ok(Math.abs(after.position-before.position)<1e-8 && Math.abs(Number(after.saved)-Number(before.saved))<1e-8,`${label}: position changed`);
    assert.equal(ipcEvents.filter(item=>item.channel.endsWith('ack-taskbar-position') && item.result && item.result.ok).length,ackBefore,`${label}: unexpected save acknowledgement`);
    trace('threshold-result',{label,native,before,after});
    return {native,before,after};
  }
  async function focusAndDrag(main,renderer,host,dx) {
    const child=spawn(process.execPath,[path.join(__dirname,'taskbar-focus-dummy.js')],
      {windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',dummy;
    child.stdout.on('data',chunk=>{stdout+=chunk.toString();for(const line of stdout.split(/\r?\n/))if(line.startsWith('FOCUS_QA_READY:')){try{dummy=JSON.parse(line.slice(line.indexOf(':')+1));}catch(_){}}});
    child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
    try {
      await waitFor('focus dummy ready',()=>dummy || (child.exitCode!==null && (()=>{throw new Error(`focus dummy exited: ${stderr}`);})()),10000);
      const info=await rendererInfo(renderer),rect=await currentGeometry(host);
      assert.ok(info.hot,'focus drag has no lyric hot region');
      const point={x:rect.Left+(info.hot.left+info.hot.right)/2*(rect.Right-rect.Left)/info.width,
        y:rect.Top+(info.hot.top+info.hot.bottom)/2*(rect.Bottom-rect.Top)/info.height};
      const ackBefore=ipcEvents.filter(item=>item.channel.endsWith('ack-taskbar-position') && item.result && item.result.ok).length;
      const result=await runFile(path.join(__dirname,'taskbar-native-host-probe.ps1'),[
        '-Action','focus-drag','-HostHwnd',String(host.data.hwnd),'-HostPid',String(host.pid),'-TaskbarHwnd',String(host.data.parent),
        '-PointX',String(Math.round(point.x)),'-PointY',String(Math.round(point.y)),'-DeltaX',String(dx),
        '-FocusHwnd',String(dummy.hwnd),'-FocusPid',String(dummy.pid),'-FocusX','240','-FocusY','170']);
      trace('focus-drag',{dummy,point,result});
      assert.ok(result.focus && result.focus.Ok,'focus dummy did not become foreground');
      assert.ok(result.drag && result.drag.Ok,`focus drag failed: ${result.drag && result.drag.Reason}`);
      assert.equal(result.dummyAliveAfter,true,'focus dummy exited during observation');
      assert.equal(result.drag.ForegroundBefore,Number(dummy.hwnd),'dummy lost foreground before drag');
      assert.equal(result.drag.ForegroundAfter,Number(dummy.hwnd),'dummy lost foreground during drag');
      for(const key of ['ForegroundAfterDown','ForegroundBeforeUp','ForegroundAfterUp','ForegroundAfter500','ForegroundAfter2000']) {
        assert.equal(result.drag[key],Number(dummy.hwnd),`dummy lost foreground at ${key}`);
      }
      let settings;
      if(dx===0) {
        assert.equal(result.drag.After.Left,result.drag.Before.Left,'focus click moved the child');
        settings=await mainInfo(main);
        assert.equal(ipcEvents.filter(item=>item.channel.endsWith('ack-taskbar-position') && item.result && item.result.ok).length,ackBefore,'focus click unexpectedly saved');
      } else {
        settings=await positionAfter(main,host,result.drag.After);
        await waitFor('focus drag ack',()=>ipcEvents.filter(item=>item.channel.endsWith('ack-taskbar-position') && item.result && item.result.ok).length>ackBefore,6000);
      }
      return {dummy,result,settings};
    } finally {
      try{child.stdin.end('stop\n');}catch(_){}
      await sleep(1000);
      if(child.exitCode===null)child.kill();
    }
  }
  async function capture(label,x,y,width,height) {
    const filename=sync+'.'+label+'.png';
    const script=`Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;public static class QaNativeLyricsCapture { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c); }
'@
[QaNativeLyricsCapture]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
Add-Type -AssemblyName System.Drawing
$bmp=[System.Drawing.Bitmap]::new(${width},${height});$g=[System.Drawing.Graphics]::FromImage($bmp)
try{$g.CopyFromScreen(${x},${y},0,0,$bmp.Size);$bmp.Save($env:MINERADIO_NATIVE_LYRICS_QA_SYNC+'.${label}.png',[System.Drawing.Imaging.ImageFormat]::Png)}finally{$g.Dispose();$bmp.Dispose()}`;
    await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
      {windowsHide:true,timeout:10000},(error,_stdout,stderr)=>error?reject(new Error(`screen capture failed: ${stderr}`)):resolve()));
    const result={filename,x,y,width,height,capturedAt:Date.now()};trace('screenshot',result);return result;
  }
  async function fixture(main,displayId,skyline=false,preservePosition=false) {
    await evaluate(main,`(() => {
      currentDesktopLyricSnapshot=()=>({text:'Native taskbar QA lyric',progress:0.35,progressSpan:6});
      desktopOverlayColors=()=>({primary:'#e6e6e6',secondary:'#94efe4',highlight:'#ffd000',glow:'#9cffdf'});
      lyricsLines=[{t:0,duration:4,text:'Native taskbar QA lyric',words:[{text:'Native ',t:0,d:1,c0:0,c1:7},{text:'taskbar ',t:1,d:1,c0:7,c1:15},{text:'QA lyric',t:2,d:2,c0:15,c1:23}]},{t:4,duration:4,text:'Next lyric'}];
      fx.desktopLyrics=true;fx.desktopLyricsTaskbar=true;fx.desktopLyricsTaskbarDisplayId=${JSON.stringify(String(displayId))};
      ${preservePosition?'':'fx.desktopLyricsTaskbarX=0.6;'}fx.desktopLyricsSize=1;fx.desktopLyricsClickThrough=false;fx.lyricSkyline=${skyline?'true':'false'};
      playing=false;applyDesktopLyricsState(true);${preservePosition?'':"saveLyricLayout({user:true,force:true,syncDisk:true,reason:'native-lyrics-qa'});"}
    })()`);
  }
  async function run() {
    assert.ok(sync,'MINERADIO_NATIVE_LYRICS_QA_SYNC is required');
    const main=await waitFor('main window',mainWindow,25000);
    await waitFor('main renderer',()=>evaluate(main,"typeof fx==='object' && typeof desktopLyricsPayload==='function' && typeof desktopWindow.getDesktopLyricsDisplays==='function'"));
    const entries=await evaluate(main,'desktopWindow.getDesktopLyricsDisplays()');
    const primary=entries.displays.find(item=>item.isPrimary && item.taskbarAvailable && item.taskbarVisible);
    const secondary=entries.displays.find(item=>!item.isPrimary && item.taskbarAvailable && item.taskbarVisible);
    assert.ok(primary && secondary,'visible primary and secondary taskbars are required');
    const displays=screen.getAllDisplays();
    const primaryDisplay=displays.find(item=>String(item.id)===String(primary.id));
    const selected=displays.find(item=>String(item.id)===String(secondary.id));
    assert.ok(primaryDisplay && selected,'Electron displays missing');
    if(phase==='seed') {
      const expected=0.5540816326530612;
      await fixture(main,secondary.id);
      await evaluate(main,`fx.desktopLyricsTaskbarX=${expected};saveLyricLayout({user:true,force:true,syncDisk:true,reason:'native-lyrics-restart-qa'})`);
      const saved=await waitFor('seeded saved position',async()=>{
        const info=await mainInfo(main);
        return Math.abs(info.position-expected)<0.000001 && Math.abs(Number(info.saved)-expected)<0.000001 && info;
      },12000);
      return {ok:true,phase,saved};
    }
    if(phase==='focus-only') {
      await fixture(main,secondary.id);
      const host=await waitFor('focus-test native host',()=>latestHostFor(selected),20000);
      const renderer=await waitFor('focus-test offscreen renderer',lyricsRenderer);
      await waitFor('focus-test renderer state',async()=>{const value=await rendererInfo(renderer);return value.taskbar && value.hot && value;});
      const failures=[];let click=null,drag=null;
      try{click=await focusAndDrag(main,renderer,host,0);}catch(error){failures.push({label:'click',error:error.message});}
      try{drag=await focusAndDrag(main,renderer,host,-90);}catch(error){failures.push({label:'drag',error:error.message});}
      const saved=await mainInfo(main);
      await evaluate(main,'fx.desktopLyrics=false;applyDesktopLyricsState(true)');
      await waitFor('focus-test native host exits',()=>!host.host.child || host.host.child.exitCode!==null,12000);
      if(failures.length){trace('focus-failures',failures);throw new Error(`Focus-only checks failed: ${JSON.stringify(failures)}`);}
      return {ok:true,phase,click,drag,saved,closedStats:host.host.closedMessage};
    }
    if(phase==='restart') {
      const expected=Number(process.env.MINERADIO_NATIVE_LYRICS_QA_EXPECTED);
      assert.ok(Number.isFinite(expected),'restart position missing');
      const restored=await waitFor('saved position after restart',async()=>{
        const info=await mainInfo(main);
        return Math.abs(info.position-expected)<0.003 && Math.abs(Number(info.saved)-expected)<0.003
          && String(info.displayId)===String(secondary.id) && info;
      },12000);
      await fixture(main,secondary.id,false,true);
      const host=await waitFor('restarted secondary native host',()=>latestHostFor(selected),20000);
      const renderer=await waitFor('restarted offscreen lyric renderer',lyricsRenderer);
      await waitFor('restarted renderer state',async()=>{const value=await rendererInfo(renderer);return value.taskbar && value.hot && value;});
      const bounds=await currentGeometry(host),layout=host.host.layout;
      const restoredPhysical=(bounds.Left-layout.minX)/(layout.maxX-layout.minX);
      assert.ok(Math.abs(restoredPhysical-expected)<0.004,'restarted native position differs from saved position');
      const moved=process.env.MINERADIO_NATIVE_LYRICS_QA_PERSIST_ONLY==='1'?null:await drag(main,renderer,host,-90,'drag after restart');
      await evaluate(main,'fx.desktopLyrics=false;applyDesktopLyricsState(true)');
      await waitFor('restarted native host exits',()=>!host.host.child || host.host.child.exitCode!==null,12000);
      const gone=await probe('probe',host,{x:bounds.Left+2,y:bounds.Top+2});
      assert.equal(gone.HostExists,false,'native child survived disable');
      assert.equal(gone.TaskbarExists,true,'taskbar missing after native child exit');
      return {ok:true,phase,expected,restored,bounds,restoredPhysical,moved,gone,closedStats:host.host.closedMessage};
    }
    await fixture(main,primary.id);
    let host=await waitFor('primary native host',()=>latestHostFor(primaryDisplay));
    let renderer=await waitFor('offscreen lyric renderer',lyricsRenderer);
    await waitFor('primary renderer state',async()=>{const value=await rendererInfo(renderer);return value.taskbar && value.hot && value;});
    const primaryStart=await currentGeometry(host);
    const primaryDrag=await drag(main,renderer,host,-90,'primary ordinary');
    await fixture(main,secondary.id);
    host=await waitFor('secondary native host',()=>latestHostFor(selected),20000);
    renderer=await waitFor('offscreen lyric renderer',lyricsRenderer);
    const secondaryStart=await currentGeometry(host);
    const click=await threshold(main,renderer,host,0,'secondary click');
    const smallMove=await threshold(main,renderer,host,Math.round(4*(Number(selected.scaleFactor)||1)),'secondary 4 DIP');
    const first=await drag(main,renderer,host,-90,'secondary ordinary');
    const second=await drag(main,renderer,host,90,'secondary ordinary second');
    const lowOpacity=await lowOpacityGap(main,renderer,host);
    const normalRect=await currentGeometry(host);
    await capture('normal-screen',normalRect.Left,normalRect.Top,normalRect.Right-normalRect.Left,normalRect.Bottom-normalRect.Top);
    const screenshot=await capture('before-start',3500,1360,900,80);
    const ready={pid:process.pid,host:{hwnd:host.data.hwnd,pid:host.pid,parent:host.data.parent},
      primaryStart,primaryDrag,secondaryStart,click,smallMove,first,second,lowOpacity,screenshot};
    fs.writeFileSync(sync+'.start-ready.json',JSON.stringify(ready));trace('start-ready',ready);
    await waitFor('fresh visual Start target',()=>fs.existsSync(sync+'.start-target.json'),90000);
    const point=JSON.parse(fs.readFileSync(sync+'.start-target.json','utf8'));
    assert.equal(point.capturedAt,screenshot.capturedAt,'Start point does not match this capture');
    assert.ok(Date.now()-screenshot.capturedAt<30000,'Start capture is stale');
    const start=await runFile(path.join(__dirname,'taskbar-native-start-probe.ps1'),[
      '-TaskbarHwnd',String(host.data.parent),'-PointX',String(point.x),'-PointY',String(point.y),
      '-BeforeImage',screenshot.filename,'-OutputImage',sync+'.start-open.png'],12000);
    trace('start',start);assert.ok(start.input.Ok && start.escapeSent,'Start input or closing failed');
    host=await waitFor('native child after Start',()=>latestHostFor(selected),12000);
    await sleep(600);
    await capture('after-start',3500,1360,900,80);
    const afterStart=await drag(main,renderer,host,-90,'secondary ordinary after Start');
    let paintCount=0;
    renderer.webContents.on('paint',()=>{paintCount++;});
    await setSkylineFixture(main,'追光',1.5);
    await waitFor('Skyline renderer',async()=>(await rendererInfo(renderer)).skyline);
    const skyline=await drag(main,renderer,host,90,'secondary Skyline after Start');
    const rect=await currentGeometry(host);
    const shortSkyline=await skylineSample('skyline-short',renderer,host,'追光',0);
    assert.ok(shortSkyline.geometry.mainPx>=20 && shortSkyline.geometry.mainPx<=24,'short Skyline main font is outside 20–24px');
    assert.ok(shortSkyline.geometry.nextPx>=9 && shortSkyline.geometry.nextPx<=11,'short Skyline next font is outside 9–11px');
    const longText='穿过城市的喧嚣和漫长雨夜只为与你相遇在遥远的地方';
    await setSkylineFixture(main,longText,1.5);
    const longSkyline=await skylineSample('skyline-long',renderer,host,longText,0);
    assert.ok(longSkyline.geometry.mainWidthPx<=longSkyline.geometry.canvasWidthPx+0.5,'long Skyline line is clipped horizontally');
    await setSkylineFixture(main,'追光',3.28);
    const transitionSkyline=await skylineSample('skyline-transition',renderer,host,'下一句温柔响起',1);
    await setSkylineFixture(main,'追光',1.5,true,true);
    const paintStart=paintCount,paintStartTime=Date.now();
    await sleep(10000);
    const paintObservation={elapsedMs:Date.now()-paintStartTime,paintCount:paintCount-paintStart};
    trace('skyline-paint-observation',paintObservation);
    const oldHost=host;
    assert.ok(oldHost.host.child && oldHost.host.child.pid===oldHost.pid,'native host process identity changed before crash test');
    oldHost.host.child.kill();
    trace('host-killed',{pid:oldHost.pid,hwnd:oldHost.data.hwnd});
    host=await waitFor('native host automatically recovers',()=>{const next=latestHostFor(selected);return next && next.pid!==oldHost.pid && next;},30000);
    const recovered=await drag(main,renderer,host,-90,'Skyline after host recovery');
    const focus=await focusAndDrag(main,renderer,host,90);
    const finalRect=await currentGeometry(host);
    const blank=await probe('probe',host,{x:finalRect.Left+2,y:finalRect.Top+2});
    assert.equal(blank.HitHost,false,'transparent corner did not pass through');
    const saved=await mainInfo(main);
    await evaluate(main,'fx.desktopLyrics=false;applyDesktopLyricsState(true)');
    await waitFor('native host process exits',()=>!host.host.child || host.host.child.exitCode!==null,12000);
    const closedStats=host.host.closedMessage;
    trace('native-closed-stats',closedStats);
    const gone=await probe('probe',host,{x:finalRect.Left+2,y:finalRect.Top+2});
    assert.equal(gone.HostExists,false,'native child survived disable');
    const review={screenshot:start.screenshot};
    fs.writeFileSync(sync+'.start-review.json',JSON.stringify(review));trace('start-review',review);
    await waitFor('Start screenshot review',()=>fs.existsSync(sync+'.start-review-result.json'),90000);
    const verdict=JSON.parse(fs.readFileSync(sync+'.start-review-result.json','utf8'));
    assert.equal(verdict.menuVisible,true,'Start menu is not visually confirmed in the screenshot');
    return {ok:true,phase,ready,start,afterStart,skyline,shortSkyline,longSkyline,transitionSkyline,paintObservation,closedStats,recovered,focus,blank,saved,gone,ipcEvents};
  }
  app.whenReady().then(()=>{
    session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url) && !/^http:\/\/127\.0\.0\.1:/.test(details.url)}));
    return run();
  }).then(result=>{clearTimeout(timer);trace('result',result);console.log('NATIVE_LYRICS_QA:'+JSON.stringify(result));app.quit();})
    .catch(error=>{clearTimeout(timer);trace('error',{message:error.stack || String(error),hostEvents:hostEvents.map(item=>({event:item.event,data:item.data,pid:item.pid,at:item.at})),ipcEvents});console.error('NATIVE_LYRICS_QA_ERROR:'+(error.stack||error));process.exitCode=1;app.quit();});
  require('../desktop/main');
} else {
  if(process.platform!=='win32')throw new Error('Windows is required');
  const { spawnSync }=require('node:child_process');
  const tempRoot=path.resolve(os.tmpdir()), profile=fs.mkdtempSync(path.join(tempRoot,'mineradio-native-lyrics-qa-'));
  const suffix=`${process.pid}-${Date.now()}`;
  const sync=process.env.MINERADIO_NATIVE_LYRICS_QA_SYNC || path.join('D:','OneDrive','AIDoc','Mineradio-paused','qa-native-lyrics',suffix);
  fs.mkdirSync(path.dirname(sync),{recursive:true});
  const env={...process.env,MINERADIO_RUNTIME_NAME:`Mineradio-NativeLyrics-${suffix}`,
    MINERADIO_APP_USER_MODEL_ID:`com.mineradio.native.lyrics.${suffix}`,MINERADIO_STARTUP_QA_HIDDEN:'1',
    MINERADIO_STARTUP_QA_USER_DATA:profile,MINERADIO_NO_DESKTOP_SHORTCUT:'1',MINERADIO_NATIVE_LYRICS_QA_SYNC:sync};
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    let expected;
    for(const phase of (process.env.MINERADIO_NATIVE_LYRICS_QA_FOCUS_ONLY==='1'?['focus-only']:process.env.MINERADIO_NATIVE_LYRICS_QA_PERSIST_ONLY==='1'?['seed','restart']:['exercise','restart'])) {
      const result=spawnSync(require('electron'),[__filename],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',windowsHide:true,timeout:370000,
        env:{...env,MINERADIO_NATIVE_LYRICS_QA_PHASE:phase,MINERADIO_NATIVE_LYRICS_QA_EXPECTED:String(expected ?? '')}});
      process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
      const line=String(result.stdout||'').split(/\r?\n/).find(value=>value.startsWith('NATIVE_LYRICS_QA:'));
      if(result.error || result.status!==0 || !line)throw result.error||new Error(`Native lyrics E2E ${phase} failed`);
      const payload=JSON.parse(line.slice(line.indexOf(':')+1));assert.equal(payload.ok,true);
      if(phase==='exercise'||phase==='seed')expected=payload.saved.position;
    }
  } finally {
    if(path.dirname(path.resolve(profile))===tempRoot && path.basename(profile).startsWith('mineradio-native-lyrics-qa-')) {
      fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:250});
    }
  }
}
