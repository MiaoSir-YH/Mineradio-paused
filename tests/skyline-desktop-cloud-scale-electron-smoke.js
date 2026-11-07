'use strict';

// Exercise the actual desktop overlay and its Skyline renderer in one hidden
// Electron instance; all lyric and cloud inputs below are synthetic.
const path = require('node:path');

if (process.versions.electron) {
  const { app, BrowserWindow } = require('electron');
  const assert = require('node:assert/strict');
  app.setPath('userData', process.env.MINERADIO_DESKTOP_CLOUD_QA_PROFILE);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({show:false,focusable:false,frame:false,width:920,height:190,useContentSize:true,
      webPreferences:{offscreen:{useSharedTexture:false},backgroundThrottling:false}});
    try {
      await win.loadFile(path.join(__dirname,'..','public','desktop-lyrics.html'));
      await win.webContents.executeJavaScript('document.fonts.ready');
      const result = await win.webContents.executeJavaScript(`(${function () {
        const text = '追光';
        const lines = [{t:0,duration:3,text,words:[{text,t:0,d:3,c0:0,c1:text.length}]},
          {t:3.2,duration:3,text:'下一句温柔响起'}];
        const payload = {enabled:true,taskbarMode:false,playing:false,text,size:1,opacity:1,skyline:true,
          skylineKey:'fixed-cloud',skylineLines:lines,frameRate:60,progress:.35,progressSpan:6,
          colors:{primary:'#eeeeee',secondary:'#80eeee',highlight:'#ffd000',glow:'#9cffdf'},
          playback:{time:1.5,duration:30,rate:1,lyricOffset:0}};
        const theme=MineradioSkyline.themeFromColors(payload.colors);
        window.__mineradioDesktopLyricsApplyState(payload);
        const s=skyline.inst;
        if(!s)throw new Error('desktop Skyline instance was not created');
        let now=10000;s.now=()=>now;
        s.render(1.5,0,theme,1);
        s.cloud.items=[{id:11,text:'QAL',x:200,y:40,z:.7,fade:1,alive:true,vx:-3,ratio:0},
          {id:12,text:'QAR',x:720,y:80,z:.7,fade:1,alive:true,vx:3,ratio:0}];
        s.cloud.queue=[];s.cloud.next=s.lines.length;s.clock={t:1.5,input:1.5};s.lastT=1.5;s.fadeIn=1;s.wallAt=10000;s.half=0;
        const ctx=s.ctx,original=ctx.fillText;let drawn,lyricDraws;
        ctx.fillText=function(word,x,y,...rest){
          if((word===text||word==='下一句温柔响起')&&lyricDraws){
            const m=this.getTransform(),metrics=this.measureText(word),py=m.b*x+m.d*y+m.f;
            const scale=Math.hypot(m.c,m.d),shadow=this.shadowBlur||0;
            (lyricDraws[word]||(lyricDraws[word]=[])).push({y:py,alpha:this.globalAlpha,shadow,
              top:py-metrics.actualBoundingBoxAscent*scale-shadow*2,
              bottom:py+metrics.actualBoundingBoxDescent*scale+shadow*2});
          }
          if(['QAL','QAR','边甲','边乙','边丙','边丁'].includes(word)){
            const m=this.getTransform(),font=/(\d+(?:\.\d+)?)px/.exec(this.font),blur=/blur\((\d+(?:\.\d+)?)px\)/.exec(this.filter);
            const sx=Math.hypot(m.a,m.b),px=m.a*x+m.c*y+m.e,metrics=this.measureText(word),soft=blur?Number(blur[1]):0;
            drawn[word]={x:px,y:m.b*x+m.d*y+m.f,font:font?Number(font[1])*sx:null,blur:soft,alpha:this.globalAlpha,
              left:px-Math.abs(metrics.actualBoundingBoxLeft*sx)-soft*2,right:px+Math.abs(metrics.actualBoundingBoxRight*sx)+soft*2};
          }
          return original.call(this,word,x,y,...rest);
        };
        const samples=[];
        for(const size of [1,.2,.6,1,1.5,1.55]){
          window.__mineradioDesktopLyricsApplyState({...payload,size,skylineLines:undefined});
          const before={ids:s.cloud.items.map(item=>item.id),clock:s.clock&&s.clock.t};
          drawn={};lyricDraws={};s.render(1.5,0,theme,1);
          const next=s.lines[1],profile=s.layoutProfile(),poseAtStart=s.pose(next,next.start),poseMid=s.pose(next,next.start+.08),poseEnd=s.pose(next,next.start+.16);
          samples.push({size,drawn,lyrics:{draws:lyricDraws,bandH:s.bandH,canvasHeight:s.canvas.height,
              mainY:s.bandTop+s.bandH*profile.mainY,entryY:s.bandTop+poseAtStart.y,
              middleY:s.bandTop+poseMid.y,endY:s.bandTop+poseEnd.y},anchor:{x:s.canvas.width/2,y:s.bandTop+s.bandH*.46},
            items:s.cloud.items.map(item=>({id:item.id,x:item.x,y:item.y,z:item.z,fade:item.fade})),
            before,clock:s.clock&&s.clock.t});
        }
        const motion=[];
        for(const size of [1,.6,.2,.6,1]){
          window.__mineradioDesktopLyricsApplyState({...payload,size,skylineLines:undefined});
          now+=100;drawn={};s.render(1.5+motion.length*.1,.1,theme,1);
          motion.push({size,clock:s.clock&&s.clock.t,items:s.cloud.items.map(item=>({id:item.id,x:item.x,z:item.z}))});
        }
        window.__mineradioDesktopLyricsApplyState({...payload,size:1.55,skylineLines:undefined});
        s.cloud.items=[[21,'边甲',50],[22,'边乙',100],[23,'边丙',820],[24,'边丁',870]]
          .map(([id,text,x])=>({id,text,x,y:50,z:.7,fade:1,alive:true,vx:0,ratio:0}));
        s.cloud.queue=[];s.cloud.next=s.lines.length;s.clock={t:1.5,input:1.5};s.lastT=1.5;s.wallAt=now;s.fadeIn=1;
        drawn={};s.render(1.5,0,theme,1);
        const edge={width:s.canvas.width,drawn,ids:s.cloud.items.map(item=>item.id)};
        ctx.fillText=original;
        return {samples,motion,edge,width:s.canvas.width,height:s.canvas.height};
      }.toString()})()`);
      const base = result.samples[0];
      const failures=[];
      for (const sample of result.samples) {
        assert.deepEqual(sample.before.ids,[11,12],`size ${sample.size}: cloud items were reset`);
        assert.deepEqual(sample.items,base.items,`size ${sample.size}: underlying cloud motion changed`);
        assert.equal(sample.before.clock,base.before.clock,`size ${sample.size}: clock was reset`);
        assert.equal(sample.clock,base.clock,`size ${sample.size}: clock changed`);
        const lyric=sample.lyrics,main=lyric.draws['追光']&&lyric.draws['追光'][0],next=lyric.draws['下一句温柔响起']&&lyric.draws['下一句温柔响起'][0];
        if(!main||!next)failures.push({size:sample.size,scenario:'lyric-not-drawn',draws:lyric.draws});
        else {
          const expected=lyric.bandH*.28*sample.size;
          if(Math.abs(main.y-base.lyrics.mainY)>.25||Math.abs(next.y-main.y-expected)>.25||Math.abs(lyric.entryY-next.y)>.25)
            failures.push({size:sample.size,scenario:'lyric-spacing',main:main.y,next:next.y,expectedGap:expected,entry:lyric.entryY});
          if(!(lyric.middleY<lyric.entryY&&lyric.middleY>lyric.mainY)||Math.abs(lyric.endY-lyric.mainY)>.25)
            failures.push({size:sample.size,scenario:'lyric-transition',entry:lyric.entryY,middle:lyric.middleY,end:lyric.endY,main:lyric.mainY});
          if(sample.size===1.55)for(const [label,draw] of [['main',main],['next',next]])
            if(draw.top<-.5||draw.bottom>lyric.canvasHeight+.5)
              failures.push({size:sample.size,scenario:'lyric-vertical-edge',label,height:lyric.canvasHeight,top:draw.top,bottom:draw.bottom,shadow:draw.shadow});
        }
        for (const key of ['QAL','QAR']) {
          const before=base.drawn[key],actual=sample.drawn[key];
          if(!before||!actual){ failures.push({size:sample.size,word:key,error:'not drawn'});continue; }
          for(const axis of ['x','y']) {
            const want=sample.anchor[axis]+(before[axis]-base.anchor[axis])*sample.size;
            const expandedX=axis==='x'&&sample.size>1,
              outward=expandedX&&Math.sign(actual.x-sample.anchor.x)===Math.sign(before.x-base.anchor.x)
                &&Math.abs(actual.x-sample.anchor.x)>=Math.abs(before.x-base.anchor.x);
            if(!Number.isFinite(actual[axis])||(expandedX?!outward:Math.abs(actual[axis]-want)>0.25))
              failures.push({size:sample.size,word:key,axis,expected:want,actual:actual[axis]});
          }
          for(const field of ['font','blur']) {
            const expected=before[field]*sample.size;
            if(!Number.isFinite(actual[field])||Math.abs(actual[field]-expected)>.5)
              failures.push({size:sample.size,word:key,field,expected,actual:actual[field]});
          }
        }
      }
      for(let i=0;i<result.motion.length;i++) {
        const item=result.motion[i];assert.deepEqual(item.items.map(value=>value.id),[11,12],'playing resize reset cloud IDs');
        if(i>0) {
          assert(item.clock>result.motion[i-1].clock,'playing resize stopped or reset the clock');
          assert(item.items[0].x<result.motion[i-1].items[0].x,'playing resize stopped the cloud trajectory');
        }
      }
      for(const key of ['边甲','边乙','边丙','边丁']){
        const word=result.edge.drawn[key];
        if(!word||!Number.isFinite(word.left)||!Number.isFinite(word.right)||word.left<-.5||word.right>result.edge.width+.5)
          failures.push({scenario:'edge',word:key,width:result.edge.width,actual:word||null});
      }
      for(const [left,right] of [['边甲','边乙'],['边丙','边丁']]){
        const a=result.edge.drawn[left],b=result.edge.drawn[right];
        if(!a||!b||!(b.x-a.x>=8))failures.push({scenario:'distinct-edge',left,right,a:a&&a.x,b:b&&b.x});
      }
      console.log('DESKTOP_CLOUD_SCALE_QA:'+JSON.stringify({failures,result}));
      assert.equal(failures.length,0,`desktop word cloud did not scale its layout: ${JSON.stringify(failures.slice(0,8))}`);
      win.destroy();app.exit(0);
    } catch(error) {console.error(error.stack||error);app.exit(1);}
  });
} else {
  const fs=require('node:fs'),os=require('node:os'),{spawnSync}=require('node:child_process');
  const tempRoot=path.resolve(os.tmpdir()),profile=fs.mkdtempSync(path.join(tempRoot,'mineradio-desktop-cloud-'));
  try{
    const env={...process.env,MINERADIO_DESKTOP_CLOUD_QA_PROFILE:profile};delete env.ELECTRON_RUN_AS_NODE;
    const result=spawnSync(require('electron'),[__filename],{cwd:path.resolve(__dirname,'..'),env,windowsHide:true,encoding:'utf8',timeout:30000});
    process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
    if(result.error||result.status!==0)throw result.error||new Error(`desktop cloud scale smoke exited ${result.status}`);
  }finally{
    if(path.dirname(path.resolve(profile))===tempRoot&&path.basename(profile).startsWith('mineradio-desktop-cloud-'))
      fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:250});
  }
}
