'use strict';

// Isolated renderer check: node tests/taskbar-lyrics-size-electron-smoke.js
// No app, taskbar host, visible window, or physical input is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.versions.electron) {
  const { app, BrowserWindow } = require('electron');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  app.setPath('userData', process.env.MINERADIO_SIZE_QA_PROFILE);
  const output = process.env.MINERADIO_SIZE_QA_OUTPUT;
  const short = '追光';
  const long = '穿过城市的喧嚣和漫长雨夜只为与你相遇在遥远的地方';
  const lines = text => [
    { t:0, duration:3, text, words:[{ text, t:0, d:3, c0:0, c1:text.length }] },
    { t:3.2, duration:3, text:'下一句温柔响起' },
    { t:6.4, duration:3, text:'远方还有晴空' }
  ];
  const base = { enabled:true, taskbarMode:true, playing:false, text:short, size:1,
    taskbarSize:1, taskbarSkylineSpacing:0.5, opacity:1, frameRate:60,
    progress:0.35, progressSpan:6, skyline:false, taskbarTranslation:'温柔的译文',
    cinema:false, motion:{ lyricGlow:false, lyricGlowBeat:false },
    colors:{ primary:'#e6e6e6', secondary:'#94efe4', highlight:'#ffd000', glow:'#9cffdf' },
    playback:{ time:1.5, duration:30, rate:1, lyricOffset:0 } };

  app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive:true });
    const win = new BrowserWindow({ show:false, focusable:false, frame:false, transparent:true,
      backgroundColor:'#00000000', width:600, height:48, useContentSize:true,
      webPreferences:{ offscreen:{useSharedTexture:false}, backgroundThrottling:false } });
    await win.loadFile(path.join(__dirname, '..', 'public', 'desktop-lyrics.html'));
    await win.webContents.executeJavaScript('document.fonts.ready');
    const evaluate = expression => win.webContents.executeJavaScript(expression, true);
    await evaluate(`(() => {
      window.__skylineStageQa=MineradioSkyline.create(document.createElement('canvas'),{size:{w:920,h:190},opaque:false});
      window.__skylineStageQa.setLines(${JSON.stringify(lines(short))});
      window.__skylineStageQa.render(1.5,0,MineradioSkyline.themeFromColors(${JSON.stringify(base.colors)}),1);
    })()`);
    async function apply(payload) {
      await evaluate(`window.__mineradioDesktopLyricsApplyState(${JSON.stringify(payload)})`);
      // Let the real 820ms entrance animation finish before comparing geometry.
      await sleep(950);
    }
    async function screenshot(name, checkVerticalEdges=false) {
      const image = await win.webContents.capturePage();
      assert.ok(!image.isEmpty(), `${name}: empty frame`);
      fs.writeFileSync(path.join(output, name+'.png'), image.toPNG());
      const pixels = image.toBitmap(); let visible = 0;
      for (let i=3; i<pixels.length; i+=4) if (pixels[i]>16) visible++;
      assert.ok(visible>20, `${name}: no visible lyric pixels`);
      if (checkVerticalEdges) {
        const {width,height}=image.getSize();
        for (const y of [0,height-1]) {
          let bright=0;
          for(let x=0;x<width;x++) {
            const i=(y*width+x)*4;
            if(pixels[i+3]>180 && Math.min(pixels[i],pixels[i+1],pixels[i+2])>160)bright++;
          }
          assert.equal(bright,0,`${name}: bright lyric pixels meet the taskbar's vertical edge at row ${y}`);
        }
      }
    }
    async function normalInfo() {
      return evaluate(`(() => {
        const line=document.getElementById('line'), tr=document.getElementById('taskbarTranslation');
        const range=document.createRange();range.selectNodeContents(line);const lr=range.getBoundingClientRect();
        range.selectNodeContents(tr);const trr=range.getBoundingClientRect(), vr=lyricViewport.getBoundingClientRect();
        return { text:line.textContent,translation:tr.textContent,font:parseFloat(getComputedStyle(line).fontSize),
          line:{left:lr.left,right:lr.right,top:lr.top,bottom:lr.bottom,height:lr.height},
          translated:{left:trr.left,right:trr.right,top:trr.top,bottom:trr.bottom,height:trr.height},
          viewport:{left:vr.left,right:vr.right,top:vr.top,bottom:vr.bottom,
            mask:getComputedStyle(lyricViewport).webkitMaskImage},
          scroll:{needed:scrollState.needed,limit:scrollState.limit,offset:scrollState.offset},hot:window.__mineradioTaskbarLyricHotBounds() };
      })()`);
    }
    async function skylineInfo() {
      return evaluate(`(() => {
        const s=skyline.inst,c=s.canvas,rect=c.getBoundingClientRect(), cur=s.lines[s.idx],next=s.lines[s.idx+1];
        if(!cur || !s.clock) throw new Error('Skyline has not rendered a current line');
        const scale=rect.height/c.height,t=s.clock.t,L=s.layout(cur),pose=s.pose(cur,t),profile=s.layoutProfile(),N=next&&s.layout(next);
        function glyph(line,layout,factor,y) {
          if(!line||!layout)return null;
          const ctx=s.ctx;ctx.save();ctx.font='bold '+layout.size+'px '+MineradioSkyline.FONT;ctx.textBaseline='middle';
          const m=ctx.measureText(line.text);ctx.restore();
          return {top:(s.bandTop+y-m.actualBoundingBoxAscent*factor)*scale,
            bottom:(s.bandTop+y+m.actualBoundingBoxDescent*factor)*scale};
        }
        return {text:cur.text,time:t,width:rect.width,height:rect.height,
          mainSize:L.size*pose.scale*scale,mainWidth:L.width*pose.scale*scale,
          nextSize:N&&N.size*profile.nextScale*scale,
          mainGlyph:glyph(cur,L,pose.scale,pose.y),nextGlyph:glyph(next,N,profile.nextScale,s.bandH*profile.nextY),
          hot:window.__mineradioTaskbarLyricHotBounds()};
      })()`);
    }
    async function cloudPositions() {
      return evaluate(`(() => {
        const s=skyline.inst,ctx=s.ctx,original=ctx.fillText,drawn={};
        s.clock={t:1.5,input:1.5};s.lastT=1.5;s.fadeIn=1;s.wallAt=performance.now();
        s.cloud.items=[['A',80],['B',120],['C',160],['D',440],['E',480],['F',520]].map(([text,x])=>
          ({text,x,y:24,z:0.55,fade:1,alive:true,vx:0,ratio:0}));
        s.cloud.queue=[];s.cloud.next=s.lines.length;
        ctx.fillText=function(text,x,y,...rest){
          const m=this.getTransform();
          if(/^[A-F]$/.test(text))drawn[text]={x:m.a*x+m.c*y+m.e,halfWidth:this.measureText(text).width*Math.abs(m.a)/2};
          if(text==='追光')drawn.mainCenter=m.a*(x+this.measureText(text).width/2)+m.c*y+m.e;
          return original.call(this,text,x,y,...rest);
        };
        try{s.render(1.5,0,MineradioSkyline.themeFromColors(state.colors),1);}finally{ctx.fillText=original;}
        return drawn;
      })()`);
    }
    async function cloudMetrics(stage=false) {
      return evaluate(`(() => {
        const s=${stage?'window.__skylineStageQa':'skyline.inst'},ctx=s.ctx,original=ctx.fillText;
        const drawn={};
        s.clock={t:1.5,input:1.5};s.lastT=1.5;s.fadeIn=1;s.wallAt=performance.now()-1000;s.half=0;
        s.cloud.items=[{text:'云',x:s.canvas.width*.12,y:s.bandH*.5,z:.45,fade:1,alive:true,vx:0,ratio:0}];
        s.cloud.queue=[];s.cloud.next=s.lines.length;
        ctx.fillText=function(text,x,y,...rest){
          if(text==='云') {const match=/(\\d+(?:\\.\\d+)?)px/.exec(this.font),blur=/blur\\((\\d+(?:\\.\\d+)?)px\\)/.exec(this.filter);
            drawn.fontPx=match?Number(match[1]):null;drawn.blurPx=blur?Number(blur[1]):0;drawn.width=this.measureText(text).width;}
          return original.call(this,text,x,y,...rest);
        };
        try{s.render(1.5,0,MineradioSkyline.themeFromColors(${JSON.stringify(base.colors)}),1);}finally{ctx.fillText=original;}
        return {fontPx:drawn.fontPx,blurPx:drawn.blurPx,width:drawn.width,avoidHalf:s.half,safeHalf:s.cloudSafeHalf};
      })()`);
    }
    if(process.env.MINERADIO_SIZE_QA_TIGHT_ONLY==='1') {
      win.setContentSize(840,48);
      await apply({...base,text:long,taskbarSize:1,taskbarSkylineSpacing:1,taskbarReferenceWidth:600,taskbarAnchorX:300,
        taskbarViewportWidth:840,skyline:true,skylineKey:'tight-channel',skylineLines:lines(long)});
      const tight=await evaluate(`(() => {
        const s=skyline.inst,ctx=s.ctx,original=ctx.fillText,drawn=[];let anchor=null;
        s.clock={t:1.5,input:1.5};s.lastT=1.5;s.fadeIn=1;
        s.cloud.items=[{id:2001,text:'LEFT-WORD',x:40,y:24,z:.55,fade:1,alive:true,vx:0,ratio:0},
          {id:2002,text:'LEFT-WORD',x:180,y:24,z:.55,fade:1,alive:true,vx:0,ratio:0},
          {id:2003,text:'RIGHT-WORD',x:420,y:24,z:.55,fade:1,alive:true,vx:0,ratio:0},
          {id:2004,text:'RIGHT-WORD',x:560,y:24,z:.55,fade:1,alive:true,vx:0,ratio:0}];
        s.cloud.queue=[];s.cloud.next=s.lines.length;
        ctx.fillText=function(text,x,y,...rest){
          const m=this.getTransform(),v=this.measureText(text),actual=m.a*x+m.c*y+m.e;
          if(text===${JSON.stringify(long)})anchor=m.a*(x+v.width/2)+m.c*y+m.e;
          if(text==='LEFT-WORD'||text==='RIGHT-WORD'){
            const b=/blur\\((\\d+(?:\\.\\d+)?)px\\)/.exec(this.filter),blur=b?Number(b[1])*2:0;
            drawn.push({text,center:actual,left:actual-Math.abs(v.actualBoundingBoxLeft*m.a)-blur,
              right:actual+Math.abs(v.actualBoundingBoxRight*m.a)+blur});
          }
          return original.call(this,text,x,y,...rest);
        };
        try{s.render(1.5,0,MineradioSkyline.themeFromColors(state.colors),1);}finally{ctx.fillText=original;}
        return {anchor,width:s.canvas.width,safeHalf:s.cloudSafeHalf,drawn};
      })()`);
      assert.ok(Math.abs(tight.anchor-300)<1 && tight.drawn.length>0,`invalid narrow-channel fixture: ${JSON.stringify(tight)}`);
      for(const word of tight.drawn){
        assert.ok(word.left>=-0.5 && word.right<=tight.width+0.5,`cloud glyph or blur cut: ${JSON.stringify(tight)}`);
        if(word.center<tight.anchor)assert.ok(word.right<=tight.anchor-tight.safeHalf+1,`left word overlaps lyric: ${JSON.stringify(tight)}`);
        else assert.ok(word.left>=tight.anchor+tight.safeHalf-1,`right word overlaps lyric: ${JSON.stringify(tight)}`);
      }
      const left=tight.drawn.filter(word=>word.text==='LEFT-WORD');
      if(left.length>1)assert.ok(Math.abs(left[0].center-left[1].center)>1,`visible words collapsed together: ${JSON.stringify(tight)}`);
      fs.writeFileSync(path.join(output,'tight-channel-metrics.json'),JSON.stringify(tight,null,2));
      await screenshot('skyline-tight-channel');
      console.log('LYRICS_TIGHT_QA:'+JSON.stringify(tight));win.destroy();app.exit(0);return;
    }
    const results = { normal:{}, skyline:{}, desktop:{}, spacing:{} };
    if (process.env.MINERADIO_SIZE_QA_SKYLINE_ONLY!=='1') {
    for (const size of [0.6,1,1.6]) {
      await apply({...base,taskbarSize:size});
      results.normal[size]=await normalInfo();
    }
    assert.ok(results.normal[0.6].line.height < results.normal[1].line.height &&
      results.normal[1].line.height < results.normal[1.6].line.height,
      `taskbar ordinary size does not increase: ${JSON.stringify(results.normal)}`);
    for (const size of [0.6,1,1.6]) assert.ok(results.normal[size].hot,'visible ordinary lyrics need a hot region');
    assert.ok(results.normal[0.6].hot.right-results.normal[0.6].hot.left <
      results.normal[1.6].hot.right-results.normal[1.6].hot.left, 'hot region did not follow font size');
    await screenshot('ordinary-large',true);
    await apply({...base,size:0.2,taskbarSize:1});
    assert.ok(Math.abs((await normalInfo()).line.height-results.normal[1].line.height)<0.5,
      'desktop size changed ordinary taskbar size');

    const ordinaryText=long.repeat(3), ordinaryTranslation='这是一行完整显示并跟随滚动的长译文'.repeat(2);
    await apply({...base,taskbarSize:1.6,text:ordinaryText,taskbarTranslation:ordinaryTranslation,progress:0});
    const ordinaryLong=await normalInfo();
    results.ordinaryLong=ordinaryLong;
    console.log('LYRICS_SIZE_QA_LONG:'+JSON.stringify({normal:results.normal,ordinaryLong}));
    assert.equal(ordinaryLong.text,ordinaryText);
    assert.ok(ordinaryLong.translation.includes(ordinaryTranslation));
    assert.equal(ordinaryLong.scroll.needed,false,'ordinary taskbar lyrics must fit without horizontal scrolling');
    assert.ok(ordinaryLong.line.left>=ordinaryLong.viewport.left-1 && ordinaryLong.line.right<=ordinaryLong.viewport.right+1 &&
      ordinaryLong.translated.left>=ordinaryLong.viewport.left-1 && ordinaryLong.translated.right<=ordinaryLong.viewport.right+1,
      `full lyric and translation must fit horizontally: ${JSON.stringify(ordinaryLong)}`);
    assert.equal(ordinaryLong.viewport.mask,'none','taskbar lyrics must not have a horizontal fade mask');
    assert.ok(ordinaryLong.line.top>=-1 && ordinaryLong.line.bottom<=49 &&
      ordinaryLong.translated.top>=-1 && ordinaryLong.translated.bottom<=49,
      `long ordinary text exceeds the taskbar height: ${JSON.stringify(ordinaryLong)}`);
    await screenshot('ordinary-long',true);
    await apply({...base,taskbarSize:1.6,text:ordinaryText,taskbarTranslation:ordinaryTranslation,progress:1});
    const ordinaryEnd=await normalInfo();
    assert.ok(Math.abs(ordinaryLong.scroll.offset)<0.1 && Math.abs(ordinaryEnd.scroll.offset)<0.1,
      `long ordinary text must stay wholly visible throughout its progress: ${JSON.stringify({ordinaryLong,ordinaryEnd})}`);
    results.beat={};
    for(const {taskbarSize,text,translation,label} of [
      {taskbarSize:1,text:ordinaryText,translation:ordinaryTranslation,label:'long-1'},
      {taskbarSize:1.6,text:ordinaryText,translation:ordinaryTranslation,label:'long-1.6'},
      {taskbarSize:1.6,text:short,translation:base.taskbarTranslation,label:'short-1.6'},
    ]) {
      await apply({...base,taskbarSize,text,taskbarTranslation:translation,playing:true,cinema:true,
        motion:{lyricGlow:true,lyricGlowBeat:true,lyricGlowStrength:0.85,highBloom:1.45,beatGlow:1.7,beatPulse:1.4,bass:1.2}});
      const beat=await evaluate(`new Promise(resolve=>{
        const samples=[],start=performance.now();
        function frame(){
          const range=document.createRange(),line=document.getElementById('line'),translation=document.getElementById('taskbarTranslation');
          range.selectNodeContents(line);const a=range.getBoundingClientRect();range.selectNodeContents(translation);const b=range.getBoundingClientRect();
          const view=lyricViewport.getBoundingClientRect();
          samples.push({left:a.left,right:b.right,top:Math.min(a.top,b.top),bottom:Math.max(a.bottom,b.bottom),
            viewLeft:view.left,viewRight:view.right,scale:live.scale,transform:stage.style.transform});
          if(performance.now()-start<1100)requestAnimationFrame(frame);else resolve(samples);
        }requestAnimationFrame(frame);
      })`);
      const beatMax=beat.reduce((a,b)=>b.scale>a.scale?b:a);
      const beatOutside=beat.filter(item=>item.left < Math.max(0,item.viewLeft)-1 || item.right > Math.min(600,item.viewRight)+1);
      let edgeFrames=0;
      for(let i=0;i<10;i++) {
        await sleep(75);
        const image=await win.webContents.capturePage(),pixels=image.toBitmap(),{width,height}=image.getSize();
        let bright=0;
        for(const y of [0,height-1])for(let x=0;x<width;x++) {
          const index=(y*width+x)*4;
          if(pixels[index+3]>180 && Math.min(pixels[index],pixels[index+1],pixels[index+2])>160)bright++;
        }
        if(bright){edgeFrames++;if(edgeFrames===1)fs.writeFileSync(path.join(output,`ordinary-beat-edge-${label}.png`),image.toPNG());}
      }
      results.beat[label]={samples:beat.length,max:beatMax,outside:beatOutside.length,
        firstOutside:beatOutside[0]||null,verticalEdgeFrames:edgeFrames};
      await screenshot(`ordinary-beat-${label}`);
      assert.ok(beatMax.scale>(taskbarSize===1?1.1:1.02),'beat fixture did not produce a meaningful animation peak');
      assert.equal(beatOutside.length,0,`beat animation crops the lyric: ${JSON.stringify(results.beat[label])}`);
      assert.equal(edgeFrames,0,`bright lyric pixels touch the vertical edge during beat animation: ${label}`);
    }
    }

    for (const size of [0.6,1,1.6]) {
      await apply({...base,taskbarSize:size,skyline:true,skylineKey:'short',skylineLines:lines(short)});
      results.skyline[size]=await skylineInfo();
      results.skyline[size].cloud=await cloudMetrics();
    }
    assert.ok(results.skyline[0.6].mainSize<results.skyline[1].mainSize &&
      results.skyline[1].mainSize<results.skyline[1.6].mainSize,
      `taskbar Skyline size does not increase: ${JSON.stringify(results.skyline)}`);
    assert.ok(results.skyline[0.6].cloud.fontPx<results.skyline[1].cloud.fontPx &&
      results.skyline[1].cloud.fontPx<results.skyline[1.6].cloud.fontPx,
      `taskbar Skyline cloud font ignores taskbar size: ${JSON.stringify(results.skyline)}`);
    assert.ok(Math.abs(results.skyline[0.6].cloud.fontPx/results.skyline[1].cloud.fontPx-0.6)<0.02 &&
      Math.abs(results.skyline[1.6].cloud.fontPx/results.skyline[1].cloud.fontPx-1.24)<0.02,
      `taskbar cloud must use the same effective size ratio as its main lyric: ${JSON.stringify(results.skyline)}`);
    assert.ok(results.skyline[0.6].cloud.blurPx<results.skyline[1].cloud.blurPx &&
      results.skyline[1].cloud.blurPx<results.skyline[1.6].cloud.blurPx,
      'taskbar cloud blur must scale with the word size');
    await screenshot('skyline-large');
    await apply({...base,size:0.2,taskbarSize:1,skyline:true,skylineKey:'short',skylineLines:lines(short)});
    assert.ok(Math.abs((await skylineInfo()).mainSize-results.skyline[1].mainSize)<0.2,
      'desktop size changed taskbar Skyline size');

    for (const spacing of [0,0.5,1]) {
      const width=spacing===1?840:600,screenLeft=(600-width)/2;
      win.setContentSize(width,48);
      await apply({...base,taskbarSize:1,taskbarSkylineSpacing:spacing,taskbarReferenceWidth:600,
        taskbarAnchorX:width/2,taskbarViewportWidth:width,skyline:true,skylineKey:'short',skylineLines:lines(short)});
      const cloud=await cloudPositions();
      for(const key of ['A','B','C','D','E','F'])if(cloud[key])cloud[key].worldX=cloud[key].x+screenLeft;
      results.spacing[spacing]={width,screenLeft,lyric:await skylineInfo(),cloud};
    }
    const [near,mid,far]=[results.spacing[0],results.spacing[0.5],results.spacing[1]];
    for (const item of [near,mid,far]) {
      for (const key of ['A','B','C','D','E','F']) {
        const word=item.cloud[key];
        assert.ok(word && Number.isFinite(word.x) && word.x>=word.halfWidth && word.x<=item.width-word.halfWidth,
          `cloud word ${key} must remain visible inside the slot: ${JSON.stringify(results.spacing)}`);
      }
      for (const side of [['A','B','C'],['D','E','F']]) {
        assert.ok(item.cloud[side[1]].x-item.cloud[side[0]].x>8 && item.cloud[side[2]].x-item.cloud[side[1]].x>8,
          `cloud words must keep their order without piling up: ${JSON.stringify(results.spacing)}`);
      }
      assert.ok(Math.abs(item.cloud.mainCenter+item.screenLeft-300)<1, 'spacing moved the central lyric anchor');
    }
    for(const key of ['A','B','C']) assert.ok(near.cloud[key].worldX>=mid.cloud[key].worldX && mid.cloud[key].worldX>=far.cloud[key].worldX,
      `left cloud moved the wrong way: ${JSON.stringify(results.spacing)}`);
    for(const key of ['D','E','F']) assert.ok(near.cloud[key].worldX<=mid.cloud[key].worldX && mid.cloud[key].worldX<=far.cloud[key].worldX,
      `right cloud moved the wrong way: ${JSON.stringify(results.spacing)}`);
    for(const side of [['A','B','C'],['D','E','F']]) {
      assert.ok(far.cloud[side[2]].x-far.cloud[side[0]].x >= mid.cloud[side[2]].x-mid.cloud[side[0]].x-1,
        `wide spacing compressed the whole side of the cloud: ${JSON.stringify(results.spacing)}`);
      for(let i=0;i<side.length-1;i++) {
        const a=side[i],b=side[i+1],normalGap=mid.cloud[b].x-mid.cloud[a].x,wideGap=far.cloud[b].x-far.cloud[a].x;
        const edgeRoom=Math.min(far.cloud[a].x,far.width-far.cloud[b].x);
        if(edgeRoom>=40)assert.ok(wideGap>=normalGap-1,
          `words away from the slot edge must not compress: ${JSON.stringify(results.spacing)}`);
      }
    }
    const shifts=['A','B','C'].map(key=>near.cloud[key].worldX-far.cloud[key].worldX);
    assert.ok(Math.max(...shifts)-Math.min(...shifts)>1,
      `same-side cloud words must spread by different distances: ${JSON.stringify(results.spacing)}`);
    assert.ok(Math.abs(near.lyric.mainSize-far.lyric.mainSize)<0.2 &&
      Math.abs(near.lyric.mainWidth-far.lyric.mainWidth)<0.5,'spacing changed the central lyric size');

    win.setContentSize(600,48);await sleep(250);
    await evaluate(`(() => {window.__qaHotReports=[];window.desktopOverlay={setLyricsHotBounds:(bounds,id)=>{window.__qaHotReports.push({bounds,id});return Promise.resolve({ok:true})}};return true})()`);
    await apply({...base,taskbarSize:1,taskbarSkylineSpacing:0.5,taskbarReferenceWidth:600,taskbarAnchorX:300,
      taskbarViewportWidth:600,taskbarLayoutId:100,
      skyline:true,skylineKey:'stable-geometry',skylineLines:lines(short)});
    await evaluate(`(() => {
      const s=skyline.inst;s.clock={t:1.5,input:1.5};s.lastT=1.5;s.fadeIn=1;
      s.cloud.items=[{id:1001,text:'LEFT-WORD',x:100,y:24,z:.55,fade:1,alive:true,vx:0,ratio:0},
        {id:1002,text:'RIGHT-WORD',x:500,y:24,z:.55,fade:1,alive:true,vx:0,ratio:0}];
      s.cloud.queue=[];s.cloud.next=s.lines.length;
    })()`);
    async function geometryState() {
      return evaluate(`(() => {
        const s=skyline.inst,ctx=s.ctx,original=ctx.fillText,drawn=[];let anchor=null;
        const current=s.lines[s.idx],mainText=current&&current.text;
        ctx.fillText=function(text,x,y,...rest){
          const m=this.getTransform(),v=this.measureText(text),actual=m.a*x+m.c*y+m.e;
          if(text===mainText)anchor=m.a*(x+v.width/2)+m.c*y+m.e;
          if(text==='LEFT-WORD'||text==='RIGHT-WORD'){
            const match=/blur\\((\\d+(?:\\.\\d+)?)px\\)/.exec(this.filter),blur=match?Number(match[1])*2:0;
            drawn.push({text,center:actual,left:actual-Math.abs(v.actualBoundingBoxLeft*m.a)-blur,
              right:actual+Math.abs(v.actualBoundingBoxRight*m.a)+blur});
          }
          return original.call(this,text,x,y,...rest);
        };
        try{s.render(1.5,0,MineradioSkyline.themeFromColors(state.colors),1);}finally{ctx.fillText=original;}
        return {anchor,width:s.canvas.width,clock:s.clock&&s.clock.t,safeHalf:s.cloudSafeHalf,drawn,
          items:s.cloud.items.map(item=>({id:item.id,z:item.z,fade:item.fade}))};
      })()`);
    }
    const geometryBefore=await geometryState();
    await apply({...base,taskbarSize:1,taskbarSkylineSpacing:1,taskbarReferenceWidth:600,taskbarAnchorX:420,
      taskbarViewportWidth:840,taskbarLayoutId:101,
      skyline:true,skylineKey:'stable-geometry',skylineLines:lines(short)});
    const pendingState=await evaluate(`({ready:skyline.inst.taskbarViewportReady(),
      reports:window.__qaHotReports.filter(item=>item.id===101)})`);
    assert.equal(pendingState.ready,false,'new geometry must wait until the renderer viewport matches');
    assert.ok(pendingState.reports.every(item=>!item.bounds),'old-width hot bounds must not be sent for the new generation');
    win.setContentSize(840,48);await sleep(500);
    const readyState=await evaluate(`({ready:skyline.inst.taskbarViewportReady(),
      reports:window.__qaHotReports.filter(item=>item.id===101 && item.bounds)})`);
    assert.equal(readyState.ready,true);
    assert.ok(readyState.reports.some(item=>item.bounds.viewportWidth===840),
      'matching viewport must report current-generation hot bounds');
    const geometryAfter=await geometryState();
    assert.equal(geometryAfter.width,840);
    assert.ok(Math.abs(geometryBefore.anchor-300)<1 && Math.abs(geometryAfter.anchor-420)<1,
      `expanded renderer must keep the lyric at the requested physical anchor: ${JSON.stringify({geometryBefore,geometryAfter})}`);
    assert.deepEqual(geometryAfter.items.map(item=>item.id),geometryBefore.items.map(item=>item.id),
      'resizing the slot reset the active word-cloud animation');
    assert.deepEqual(geometryAfter.items.map(item=>item.z),geometryBefore.items.map(item=>item.z));
    assert.equal(geometryAfter.clock,geometryBefore.clock,'resizing reset the playback animation clock');
    for(const word of geometryAfter.drawn)assert.ok(word.left>=-0.5 && word.right<=geometryAfter.width+0.5,
      `word cloud glyph was cut at the expanded slot edge: ${JSON.stringify(word)}`);
    await apply({...base,taskbarSize:1,taskbarSkylineSpacing:1,taskbarReferenceWidth:600,taskbarAnchorX:300,
      taskbarViewportWidth:840,taskbarLayoutId:102,
      skyline:true,skylineKey:'stable-geometry',skylineLines:lines(short)});
    const geometryEdge=await geometryState();
    assert.ok(Math.abs(geometryEdge.anchor-300)<1,'off-centre slot anchor must remain at 300px');
    assert.deepEqual(geometryEdge.items.map(item=>item.id),geometryBefore.items.map(item=>item.id),
      'changing only the anchor reset word-cloud animation');
    await apply({...base,taskbarSize:1,taskbarSkylineSpacing:1,taskbarReferenceWidth:600,taskbarAnchorX:300,
      taskbarViewportWidth:840,taskbarLayoutId:102,
      skyline:true,skylineKey:'tight-channel',skylineLines:lines(long),text:long});
    await evaluate(`(() => {
      const s=skyline.inst;s.clock={t:1.5,input:1.5};s.lastT=1.5;s.fadeIn=1;
      s.cloud.items=[{id:2001,text:'LEFT-WORD',x:40,y:24,z:.55,fade:1,alive:true,vx:0,ratio:0},
        {id:2002,text:'LEFT-WORD',x:180,y:24,z:.55,fade:1,alive:true,vx:0,ratio:0},
        {id:2003,text:'RIGHT-WORD',x:420,y:24,z:.55,fade:1,alive:true,vx:0,ratio:0},
        {id:2004,text:'RIGHT-WORD',x:560,y:24,z:.55,fade:1,alive:true,vx:0,ratio:0}];
      s.cloud.queue=[];s.cloud.next=s.lines.length;
    })()`);
    const tight=await geometryState();
    assert.ok(tight.drawn.length>0,'wide-word boundary fixture must render at least one cloud word');
    for(const word of tight.drawn) {
      assert.ok(word.left>=-0.5 && word.right<=tight.width+0.5,
        `wide cloud word and blur must fit or fade as a whole: ${JSON.stringify({tight,word})}`);
      if(word.center<tight.anchor)assert.ok(word.right<=tight.anchor-tight.safeHalf+1,
        `left cloud word intrudes into the centre lyric channel: ${JSON.stringify({tight,word})}`);
      else assert.ok(word.left>=tight.anchor+tight.safeHalf-1,
        `right cloud word intrudes into the centre lyric channel: ${JSON.stringify({tight,word})}`);
    }
    const tightLeft=tight.drawn.filter(word=>word.text==='LEFT-WORD');
    if(tightLeft.length>1)assert.ok(Math.abs(tightLeft[0].center-tightLeft[1].center)>1,
      `separate visible words must not collapse to the same point in a narrow channel: ${JSON.stringify(tight)}`);
    results.geometry={before:geometryBefore,after:geometryAfter,edge:geometryEdge,tight};
    await screenshot('skyline-expanded');
    win.setContentSize(600,48);await sleep(250);
    assert.equal(await evaluate('skyline.inst.taskbarViewportReady()'),false,'old geometry must pause after a resize-first shrink');
    await apply({...base,taskbarSize:1,taskbarSkylineSpacing:0.5,taskbarReferenceWidth:600,taskbarAnchorX:300,
      taskbarViewportWidth:600,taskbarLayoutId:103,skyline:true,skylineKey:'stable-geometry',skylineLines:lines(short)});
    const shrinkReports=await evaluate('window.__qaHotReports.filter(item=>item.id===103 && item.bounds)');
    assert.ok(shrinkReports.some(item=>item.bounds.viewportWidth===600),
      'resize-first shrink must report the matching generation after state arrives');

    for (const [text,time,name] of [[long,1.5,'skyline-long'],[short,3.28,'skyline-transition']]) {
      await apply({...base,taskbarSize:1.6,taskbarSkylineSpacing:1,skyline:true,skylineKey:name,skylineLines:lines(text),
        playback:{time,duration:30,rate:1,lyricOffset:0}});
      const info=await skylineInfo();
      assert.ok(info.mainWidth<=info.width+1, `${name}: line extends beyond the slot`);
      for (const glyph of [info.mainGlyph,info.nextGlyph].filter(Boolean)) {
        assert.ok(glyph.top>=-1 && glyph.bottom<=info.height+1, `${name}: glyph exceeds the slot: ${JSON.stringify(info)}`);
      }
      results[name]=info;
      await screenshot(name);
    }

    win.setContentSize(920,190);
    const stageBefore=await cloudMetrics(true);
    for (const size of [0.2,0.6,1,1.4]) {
      await apply({...base,taskbarMode:false,size,taskbarSize:0.6,skyline:true,skylineKey:'desktop',skylineLines:lines(short)});
      results.desktop[size]=await skylineInfo();
      results.desktop[size].cloud=await cloudMetrics();
    }
    assert.ok(results.desktop[0.6].mainSize<results.desktop[1].mainSize &&
      results.desktop[1].mainSize<results.desktop[1.4].mainSize,
      `desktop Skyline ignores desktop size: ${JSON.stringify(results.desktop)}`);
    assert.ok(results.desktop[0.2].cloud.fontPx<results.desktop[1].cloud.fontPx &&
      results.desktop[0.2].cloud.avoidHalf<results.desktop[1].cloud.avoidHalf,
      `desktop Skyline cloud size or lyric avoidance ignores desktop size: ${JSON.stringify(results.desktop)}`);
    assert.ok(Math.abs(results.desktop[0.2].cloud.fontPx/results.desktop[1].cloud.fontPx-0.2)<0.02 &&
      Math.abs(results.desktop[0.2].cloud.blurPx/results.desktop[1].cloud.blurPx-0.2)<0.02,
      'desktop cloud font and blur must follow the desktop size');
    await apply({...base,taskbarMode:false,size:1,taskbarSize:1.6,taskbarSkylineSpacing:1,
      skyline:true,skylineKey:'desktop',skylineLines:lines(short)});
    assert.ok(Math.abs((await skylineInfo()).mainSize-results.desktop[1].mainSize)<0.2,
      'taskbar size changed desktop Skyline size');
    const stageAfter=await cloudMetrics(true);
    assert.equal(stageBefore.fontPx,stageAfter.fontPx,'desktop/taskbar controls changed the stage cloud size');
    assert.equal(stageBefore.blurPx,stageAfter.blurPx,'desktop/taskbar controls changed the stage cloud blur');
    assert.ok(Math.abs(stageBefore.avoidHalf-stageAfter.avoidHalf)<0.01,'desktop/taskbar controls changed the stage avoidance');
    results.stage={before:stageBefore,after:stageAfter};
    fs.writeFileSync(path.join(output,'metrics.json'),JSON.stringify(results,null,2));
    console.log('LYRICS_SIZE_QA:'+JSON.stringify(results));
    win.destroy();app.exit(0);
  }).catch(error=>{console.error(error.stack||error);app.exit(1);});
} else {
  const { spawnSync } = require('node:child_process');
  const tempRoot=path.resolve(os.tmpdir());
  const profile=fs.mkdtempSync(path.join(tempRoot,'mineradio-lyrics-size-qa-'));
  const output=process.env.MINERADIO_SIZE_QA_OUTPUT || path.join('D:','OneDrive','AIDoc','Mineradio-paused','qa-lyrics-size');
  try {
    const env={...process.env,MINERADIO_SIZE_QA_PROFILE:profile,MINERADIO_SIZE_QA_OUTPUT:output};
    delete env.ELECTRON_RUN_AS_NODE;
    const result=spawnSync(require('electron'),[__filename],{cwd:path.resolve(__dirname,'..'),env,
      windowsHide:true,encoding:'utf8',timeout:90000});
    process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
    if(result.error || result.status!==0)throw result.error||new Error(`Lyrics size smoke failed: ${result.status}`);
  } finally {
    if(path.dirname(path.resolve(profile))===tempRoot && path.basename(profile).startsWith('mineradio-lyrics-size-qa-')) {
      fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:250});
    }
  }
}
