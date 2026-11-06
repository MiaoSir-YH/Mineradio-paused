'use strict';
// Explicit Windows integration: node tests/taskbar-lyrics-multidisplay-electron-smoke.js
// Starts only its own app/profile and hosts. No physical mouse or keyboard input.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

if(process.versions.electron) {
  const {app,BrowserWindow,globalShortcut,ipcMain}=require('electron');
  const {execFile}=require('node:child_process');
  const {TaskbarLyricsHost}=require('../desktop/taskbar-lyrics-host');
  const {TaskbarLyricsRuntime}=require('../desktop/taskbar-lyrics-runtime');
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const output=process.env.MINERADIO_MULTI_QA_OUTPUT;
  const runs=[],hostEvents=[],ackEvents=[],frames=new WeakMap();
  fs.mkdirSync(output,{recursive:true});
  const trace=(kind,detail)=>fs.appendFileSync(path.join(output,'trace.jsonl'),JSON.stringify({at:Date.now(),kind,detail})+'\n');
  const startRuntime=TaskbarLyricsRuntime.prototype.start;
  TaskbarLyricsRuntime.prototype.start=function(){if(!runs.includes(this))runs.push(this);return startRuntime.call(this);};
  const hostEmit=TaskbarLyricsHost.prototype.emit;
  TaskbarLyricsHost.prototype.emit=function(event,...args){
    if(['ready','click-action','drag-end','host-error','exit'].includes(event))hostEvents.push({event,data:args[0],pid:this.child&&this.child.pid,host:this});
    return hostEmit.call(this,event,...args);
  };
  const sendFrame=TaskbarLyricsHost.prototype.sendFrame;
  TaskbarLyricsHost.prototype.sendFrame=function(frame){frames.set(this,{opacity:frame.opacity,width:frame.width,height:frame.height,hot:frame.hot,generation:frame.generation});return sendFrame.call(this,frame);};
  const register=ipcMain.handle;
  ipcMain.handle=function(channel,listener){
    if(channel!=='mineradio-desktop-lyrics-ack-taskbar-position')return register.call(this,channel,listener);
    return register.call(this,channel,async(event,...args)=>{const result=await listener(event,...args);ackEvents.push({args,result});return result;});
  };
  globalShortcut.register=()=>false;globalShortcut.unregister=()=>{};globalShortcut.isRegistered=()=>false;
  app.commandLine.appendSwitch('mute-audio');
  const watchdog=setTimeout(()=>{console.error('MULTI_QA_TIMEOUT');app.quit();},100000);
  async function waitFor(label,predicate,timeout=15000){
    const until=Date.now()+timeout;let error;
    while(Date.now()<until){try{const result=await predicate();if(result)return result;}catch(e){error=e;}await sleep(75);}
    throw new Error(`${label} timed out${error?': '+error.message:''}`);
  }
  function mainWindow(){return BrowserWindow.getAllWindows().find(win=>!win.isDestroyed() && /^http:\/\/127\.0\.0\.1:\d+\/\?startupAttempt=/.test(win.webContents.getURL()));}
  function runtimeFor(id){return [...runs].reverse().find(r=>!r.closed && r.layout && String(r.layout.displayId)===String(id) && r.host && r.host.ready && r.host.child);}
  function desktopWindow(){return BrowserWindow.getAllWindows().find(win=>!win.isDestroyed() && /\/desktop-lyrics\.html(?:[?#]|$)/.test(win.webContents.getURL()) && !runs.some(r=>r.window===win));}
  function ready(runtime){return [...hostEvents].reverse().find(e=>e.event==='ready' && e.host===runtime.host && e.pid===runtime.host.child.pid);}
  async function evaluate(win,js){return win.webContents.executeJavaScript(js,true);}
  async function info(runtime){return evaluate(runtime.window,`(() => ({taskbar:state.taskbarMode,enabled:state.enabled,
    size:state.taskbarSize,spacing:state.taskbarSkylineSpacing,opacity:state.opacity,skyline:!!skyline.on,
    anchor:state.taskbarAnchorX,referenceWidth:state.taskbarReferenceWidth,viewportWidth:state.taskbarViewportWidth,
    text:document.getElementById('line').textContent,width:innerWidth,height:innerHeight,skylineKey:skyline.key,
    skylineLines:skyline.inst?skyline.inst.lines.length:0,
    skylineAlpha:(()=>{const c=document.getElementById('skyline');if(!c.width||!c.height)return 0;
      const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<p.length;i+=16)if(p[i]>16)n++;return n})(),
    hot:window.__mineradioTaskbarLyricHotBounds()}))()`);}
  async function probe(runtime,point){
    const host=ready(runtime);assert.ok(host && host.data.hwnd && host.data.parent);
    const args=['-NoProfile','-File',path.join(__dirname,'taskbar-native-host-probe.ps1'),'-Action','probe',
      '-HostHwnd',String(host.data.hwnd),'-HostPid',String(host.pid),'-TaskbarHwnd',String(host.data.parent),
      '-PointX',String(Math.round(point.x)),'-PointY',String(Math.round(point.y)),'-DeltaX','0'];
    return new Promise((resolve,reject)=>execFile('powershell.exe',args,{windowsHide:true,timeout:10000},(error,stdout,stderr)=>{
      if(error)return reject(new Error(`native probe failed: ${stderr}`));try{resolve(JSON.parse(String(stdout).trim()));}catch(e){reject(e);}
    }));
  }
  async function checkNative(runtime,render){
    const rect=runtime.layout.physical,hot=render.hot;
    assert.ok(hot,'renderer did not publish hot bounds');
    const point={x:rect.x+(hot.left+hot.right)/2*rect.width/render.width,y:rect.y+(hot.top+hot.bottom)/2*rect.height/render.height};
    const sample=await probe(runtime,point);
    assert.ok(sample.HostExists && sample.HostVisible && sample.TaskbarExists,'native host or its taskbar is missing');
    assert.equal(sample.Before.Left,rect.x);assert.equal(sample.Before.Top,rect.y);
    assert.equal(sample.Before.Right-sample.Before.Left,rect.width);
    assert.equal(sample.Before.Bottom-sample.Before.Top,rect.height);
    return {host:String(sample.Host),parent:String(sample.Parent),pid:sample.HostPid,bounds:sample.Before,hitHost:sample.HitHost};
  }
  async function capture(win,name){
    const image=await win.webContents.capturePage();assert.ok(!image.isEmpty(),`${name} capture empty`);
    const pixels=image.toBitmap();let visible=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]>16)visible++;
    assert.ok(visible>20,`${name} has no rendered pixels`);
    const file=path.join(output,name+'.png');fs.writeFileSync(file,image.toPNG());return {file,visible};
  }
  async function run(){
    const main=await waitFor('isolated app main window',mainWindow,25000);
    await waitFor('main renderer',()=>evaluate(main,"typeof fx==='object' && typeof applyDesktopLyricsState==='function' && !!window.desktopWindow"));
    const displays=await evaluate(main,'desktopWindow.getDesktopLyricsDisplays()');
    trace('displays',displays);
    const primary=displays.displays.find(d=>d.isPrimary && d.taskbarAvailable && d.taskbarVisible);
    const secondary=displays.displays.find(d=>!d.isPrimary && d.taskbarAvailable && d.taskbarVisible);
    assert.ok(primary,'a visible primary taskbar is needed');
    if(process.env.MINERADIO_MULTI_QA_EXPANSION_ONLY==='1') {
      const target={displayId:String(primary.id),selected:true,position:0.15,size:1,skylineSpacing:0.5,opacity:0.9,style:'skyline',label:'QA primary'};
      await evaluate(main,`(() => {
        currentDesktopLyricSnapshot=()=>({text:'任务栏扩展测试',progress:.35,progressSpan:6});
        desktopOverlayColors=()=>({primary:'#e6e6e6',secondary:'#94efe4',highlight:'#ffd000',glow:'#9cffdf'});
        lyricsLines=[{t:0,duration:3,text:'任务栏扩展测试'},{t:3.2,duration:3,text:'下一句温柔响起'}];
        playing=false;fx.desktopLyrics=false;fx.lyricSkyline=false;
        fx.desktopLyricsOutputs={version:1,taskbarEnabled:true,screens:[${JSON.stringify(target)}]};
        saveLyricLayout({user:true,force:true,syncDisk:true,reason:'expansion-qa'});applyDesktopLyricsState(true);
      })()`);
      const runtime=await waitFor('Skyline native host',()=>runtimeFor(primary.id),25000);
      await waitFor('initial Skyline pixels',async()=>{const x=await info(runtime);return x.skyline&&x.hot&&x.skylineAlpha>3&&x;});
      const host=runtime.host,pid=host.child.pid;
      async function observe(expectedSpacing,oldGeneration) {
        return waitFor(`stable ${expectedSpacing} geometry`,async()=>{
          if(runtime.closed || runtime.host!==host || !host.child || host.child.pid!==pid)return false;
          const value=await info(runtime),frame=frames.get(host);
          if(!value.skyline || !value.hot || value.spacing!==expectedSpacing || !frame || frame.generation!==runtime.generation ||
             frame.width!==runtime.layout.physical.width || value.width!==runtime.layout.logical.width ||
             (oldGeneration!=null && runtime.generation<=oldGeneration))return false;
          const native=await checkNative(runtime,value);
          return {render:value,native,frame,generation:runtime.generation,
            worldAnchor:native.bounds.Left+value.anchor*runtime.layout.scaleFactor};
        },15000);
      }
      const base=await observe(0.5),baselineAcks=ackEvents.length;
      const before=await evaluate(main,`(() => ({live:fx.desktopLyricsOutputs.screens[0].position,
        saved:readSavedLyricLayout().desktopLyricsOutputs.screens[0].position}))()`);
      await evaluate(main,`fx.desktopLyricsOutputs.screens[0].skylineSpacing=1;
        saveLyricLayout({user:true,reason:'desktopLyricsOutputs',syncDisk:true});applyDesktopLyricsState(true)`);
      const wide=await observe(1,base.generation);
      assert.ok(wide.native.bounds.Right-wide.native.bounds.Left>base.native.bounds.Right-base.native.bounds.Left,
        'increasing Skyline spacing did not widen the native child');
      assert.equal(wide.native.host,base.native.host);assert.equal(wide.native.pid,pid);
      assert.ok(Math.abs(wide.worldAnchor-base.worldAnchor)<=1,'widening moved the physical lyric anchor');
      await evaluate(main,`fx.desktopLyricsOutputs.screens[0].skylineSpacing=.5;
        saveLyricLayout({user:true,reason:'desktopLyricsOutputs',syncDisk:true});applyDesktopLyricsState(true)`);
      const restored=await observe(0.5,wide.generation);
      const after=await evaluate(main,`(() => ({live:fx.desktopLyricsOutputs.screens[0].position,
        saved:readSavedLyricLayout().desktopLyricsOutputs.screens[0].position}))()`);
      assert.equal(restored.native.host,base.native.host);assert.equal(restored.native.pid,pid);
      assert.equal(restored.native.bounds.Right-restored.native.bounds.Left,base.native.bounds.Right-base.native.bounds.Left);
      assert.ok(Math.abs(restored.worldAnchor-base.worldAnchor)<=1,'shrinking moved the physical lyric anchor');
      assert.deepEqual(after,before,'spacing changes must not rewrite the lyric position');
      assert.equal(ackEvents.length,baselineAcks,'spacing changes must not produce drag acknowledgements');
      await evaluate(main,'fx.desktopLyricsOutputs.taskbarEnabled=false;applyDesktopLyricsState(true)');
      await waitFor('expanded host closed',()=>runtime.closed && !runtime.host,12000);
      const result={ok:true,physicalScreens:1,expansionOnly:true,base,wide,restored,position:after,ownedHostsClosed:true};
      trace('expansion-result',result);return result;
    }
    const targets=[{displayId:String(primary.id),selected:true,position:0,size:0.6,skylineSpacing:0,opacity:0.6,style:'normal',label:'QA primary'}];
    if(secondary)targets.push({displayId:String(secondary.id),selected:true,position:1,size:1.4,skylineSpacing:1,opacity:0.9,style:'skyline',label:'QA secondary'});
    await evaluate(main,`(() => {
      currentDesktopLyricSnapshot=()=>({text:'多屏测试歌词',progress:.35,progressSpan:6});
      desktopOverlayColors=()=>({primary:'#e6e6e6',secondary:'#94efe4',highlight:'#ffd000',glow:'#9cffdf'});
      lyricsLines=[{t:0,duration:3,text:'多屏测试歌词',words:[{text:'多屏测试歌词',t:0,d:3,c0:0,c1:6}]},
        {t:3.2,duration:3,text:'下一句温柔响起'}];
      playing=false;fx.desktopLyrics=true;fx.desktopLyricsSize=.8;fx.lyricSkyline=false;
      fx.desktopLyricsOutputs={version:1,taskbarEnabled:true,screens:${JSON.stringify(targets)}};
      saveLyricLayout({user:true,force:true,syncDisk:true,reason:'multi-qa'});applyDesktopLyricsState(true);
    })()`);
    const desktop=await waitFor('desktop lyrics visible',()=>{const win=desktopWindow();return win&&win.isVisible()&&win;});
    let first=await waitFor('primary native host',()=>runtimeFor(primary.id),25000);
    let second=secondary?await waitFor('secondary native host',()=>runtimeFor(secondary.id),25000):null;
    await waitFor('primary lyric rendered',async()=>{const x=await info(first);return x.enabled && x.taskbar && x.hot && !x.skyline && x;});
    if(second)await waitFor('secondary Skyline rendered',async()=>{const x=await info(second);return x.enabled && x.taskbar && x.hot && x.skyline && x;});
    await sleep(950);
    const firstInfo=await info(first),secondInfo=second?await info(second):null;
    assert.equal(firstInfo.size,0.6);assert.equal(firstInfo.spacing,0);assert.equal(firstInfo.opacity,0.6);
    assert.equal(frames.get(first.host).opacity,153);
    const a=await checkNative(first,firstInfo);
    assert.equal(first.layout.physical.x,first.layout.minX,'position 0 must use the left boundary');
    const initial={primary:{render:firstInfo,native:a,frame:frames.get(first.host),capture:await capture(first.window,'primary-normal')},
      secondary:null,
      desktop:{visible:desktop.isVisible(),bounds:desktop.getBounds()}};
    if(second){
      assert.equal(secondInfo.size,1.4);assert.equal(secondInfo.spacing,1);assert.equal(secondInfo.opacity,0.9);
      assert.equal(frames.get(second.host).opacity,230);
      const b=await checkNative(second,secondInfo);assert.notEqual(a.host,b.host);assert.notEqual(a.parent,b.parent);
      assert.equal(second.layout.physical.x,second.layout.maxX,'position 1 must use the right boundary');
      initial.secondary={render:secondInfo,native:b,frame:frames.get(second.host),capture:await capture(second.window,'secondary-skyline')};
    }
    trace('initial',initial);

    const moveX=Math.min(first.layout.maxX,first.layout.physical.x+60),otherX=second&&second.layout.physical.x;
    assert.ok(moveX>first.layout.physical.x,'primary taskbar has no movement range');
    const expected=(moveX-first.layout.minX)/(first.layout.maxX-first.layout.minX);
    first.host.emit('drag-end',{x:moveX,generation:first.generation});
    const saved=await waitFor('simulated drag saved and acknowledged',async()=>{
      const value=await evaluate(main,`(() => {const s=fx.desktopLyricsOutputs.screens.find(x=>x.displayId===${JSON.stringify(String(primary.id))});
        const d=readSavedLyricLayout().desktopLyricsOutputs.screens.find(x=>x.displayId===${JSON.stringify(String(primary.id))});
        return {position:s&&s.position,saved:d&&d.position};})()`);
      return Math.abs(value.position-expected)<.00001 && Math.abs(value.saved-expected)<.00001 &&
        ackEvents.some(event=>String(event.args[1])===String(primary.id) && event.result.ok) && value;
    });
    await waitFor('native child moves after simulated drag',()=>first.host.layout && first.host.layout.x===moveX);
    const moved=await waitFor('native bounds after simulated drag',async()=>{const v=await checkNative(first,await info(first));return v.bounds.Left===moveX&&v;});
    if(second)assert.equal(second.layout.physical.x,otherX,'one screen drag changed the other screen');
    trace('simulated-drag',{expected,saved,moved,acks:ackEvents});

    if(second){
      await evaluate(main,`fx.desktopLyricsOutputs.screens.find(s=>s.displayId===${JSON.stringify(String(secondary.id))}).selected=false;applyDesktopLyricsState(true)`);
      await waitFor('secondary closed',()=>second.closed && !second.host);
      assert.ok(!first.closed && desktop.isVisible(),'removing one screen stopped another output');
      await evaluate(main,`fx.desktopLyricsOutputs.screens.find(s=>s.displayId===${JSON.stringify(String(secondary.id))}).selected=true;applyDesktopLyricsState(true)`);
      const oldSecond=second;
      second=await waitFor('secondary restored',()=>{const value=runtimeFor(secondary.id);return value && value!==oldSecond && value;},20000);
      await waitFor('restored Skyline',async()=>{const value=await info(second);return value.skyline&&value.hot&&value;});
      assert.equal((await info(second)).size,1.4);assert.equal((await info(second)).opacity,0.9);
    } else {
      await evaluate(main,`(() => {const s=fx.desktopLyricsOutputs.screens[0];s.style='skyline';s.size=1.4;s.skylineSpacing=1;s.opacity=.9;applyDesktopLyricsState(true)})()`);
      await waitFor('single-screen Skyline',async()=>{const value=await info(first);return value.skyline&&value.hot&&value.size===1.4&&value.opacity===0.9&&value;});
      try {
        await waitFor('Skyline visible pixels',async()=>{const value=await info(first);return value.skylineAlpha>3&&value;},8000);
        await sleep(300);
        initial.singleScreenSkyline={render:await info(first),capture:await capture(first.window,'primary-skyline')};
      } catch(error) {
        trace('skyline-capture-failure',{render:await info(first),state:first.state,frame:frames.get(first.host)});
        throw error;
      }
      await evaluate(main,'fx.desktopLyricsOutputs.taskbarEnabled=false;applyDesktopLyricsState(true)');
      const oldFirst=first;await waitFor('taskbar closed while desktop remains',()=>oldFirst.closed && !oldFirst.host);
      assert.ok(desktop.isVisible(),'disabling taskbar closed desktop lyrics');
      await evaluate(main,'fx.desktopLyricsOutputs.taskbarEnabled=true;applyDesktopLyricsState(true)');
      first=await waitFor('taskbar restored',()=>{const value=runtimeFor(primary.id);return value && value!==oldFirst && value;},20000);
      await waitFor('restored single-screen Skyline',async()=>{const value=await info(first);return value.skyline&&value.hot&&value;});
    }
    await evaluate(main,'fx.desktopLyrics=false;applyDesktopLyricsState(true)');
    await waitFor('desktop closed independently',()=>desktop.isDestroyed() || !desktop.isVisible());
    assert.ok(!first.closed && (!second || !second.closed),'disabling desktop closed taskbar outputs');
    trace('independent-close',{desktopClosed:true,removedAndRestored:secondary?String(secondary.id):null});

    await evaluate(main,'fx.desktopLyricsOutputs.taskbarEnabled=false;applyDesktopLyricsState(true)');
    await waitFor('all owned native hosts exit',()=>runs.every(r=>r.closed && !r.host),20000);
    const result={ok:true,physicalScreens:secondary?2:1,initial,simulatedDrag:{expected,saved,moved},secondaryRestored:!!secondary,desktopClosed:true,
      ownedHostsClosed:true,ackEvents};
    trace('result',result);return result;
  }
  app.whenReady().then(run).then(result=>{clearTimeout(watchdog);console.log('MULTI_LYRICS_QA:'+JSON.stringify(result));app.quit();})
    .catch(error=>{clearTimeout(watchdog);trace('error',{message:error.stack||String(error),hostEvents:hostEvents.map(({event,data,pid})=>({event,data,pid}))});
      console.error('MULTI_LYRICS_QA_ERROR:'+(error.stack||error));process.exitCode=1;app.quit();});
  require('../desktop/main');
} else {
  if(process.platform!=='win32')throw new Error('Windows required');
  const {spawnSync}=require('node:child_process');
  const tempRoot=path.resolve(os.tmpdir()),profile=fs.mkdtempSync(path.join(tempRoot,'mineradio-multi-lyrics-qa-'));
  const suffix=`${process.pid}-${Date.now()}`;
  const output=process.env.MINERADIO_MULTI_QA_OUTPUT||path.join('D:','OneDrive','AIDoc','Mineradio-paused','qa-multiscreen-lyrics',suffix);
  const env={...process.env,MINERADIO_RUNTIME_NAME:`Mineradio-MultiLyrics-${suffix}`,
    MINERADIO_APP_USER_MODEL_ID:`com.mineradio.multilyrics.${suffix}`,MINERADIO_STARTUP_QA_HIDDEN:'1',
    MINERADIO_STARTUP_QA_USER_DATA:profile,MINERADIO_NO_DESKTOP_SHORTCUT:'1',MINERADIO_MULTI_QA_OUTPUT:output};
  delete env.ELECTRON_RUN_AS_NODE;
  try{
    const result=spawnSync(require('electron'),[__filename],{cwd:path.resolve(__dirname,'..'),env,windowsHide:true,encoding:'utf8',timeout:110000});
    process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
    const line=String(result.stdout||'').split(/\r?\n/).find(value=>value.startsWith('MULTI_LYRICS_QA:'));
    if(result.error||result.status!==0||!line)throw result.error||new Error(`Multi lyrics smoke failed: ${result.status}`);
    assert.equal(JSON.parse(line.slice(line.indexOf(':')+1)).ok,true);
  }finally{
    if(path.dirname(path.resolve(profile))===tempRoot && path.basename(profile).startsWith('mineradio-multi-lyrics-qa-'))
      fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:250});
  }
}
