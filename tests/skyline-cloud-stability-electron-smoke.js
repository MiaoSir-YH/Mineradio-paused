'use strict';

// Targeted rendering regression: no app instance, taskbar window, or input.
// Run: node tests/skyline-cloud-stability-electron-smoke.js
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

if(process.versions.electron){
  const {app,BrowserWindow}=require('electron');
  app.setPath('userData',process.env.MINERADIO_CLOUD_QA_PROFILE);
  app.whenReady().then(async()=>{
    const win=new BrowserWindow({show:false,focusable:false,frame:false,width:920,height:190,useContentSize:true,
      webPreferences:{offscreen:{useSharedTexture:false},backgroundThrottling:false}});
    await win.loadFile(path.join(__dirname,'..','public','desktop-lyrics.html'));
    await win.webContents.executeJavaScript('document.fonts.ready');
    const result=await win.webContents.executeJavaScript(`(() => {
      const short='追光',long='穿过城市的喧嚣和漫长雨夜只为与你相遇在遥远的地方';
      const theme=MineradioSkyline.themeFromColors({primary:'#eeeeee',secondary:'#80eeee',highlight:'#ffd000',glow:'#9cffdf'});
      const configs=[
        {name:'taskbar-600',width:600,height:48,anchor:300,spacing:.5,taskbar:true,size:1},
        {name:'taskbar-840-edge',width:840,height:48,anchor:300,spacing:1,taskbar:true,size:1},
        {name:'desktop',width:920,height:190,anchor:460,spacing:.5,taskbar:false,size:.2},
        {name:'stage',width:920,height:190,anchor:460,spacing:.5,taskbar:false,size:1}
      ];
      function makeLines(current,next,duration) {
        return [{t:0,duration:duration,text:current,words:[{text:current,t:0,d:duration,c0:0,c1:current.length}]},
          {t:3.2,duration:3,text:next},{t:7,duration:3,text:'远方还有晴空'}];
      }
      function sample(config,current,next,duration,start=1.5) {
        let seed=113,now=10000;Math.random=()=>{seed=seed*16807%2147483647;return (seed-1)/2147483646;};
        const c=document.createElement('canvas');c.style.width=config.width+'px';c.style.height=config.height+'px';document.body.appendChild(c);
        const s=MineradioSkyline.create(c,{opaque:false,taskbar:config.taskbar,pad:config.taskbar?0:.25,
          size:{w:config.width,h:config.height},now:()=>now});
        s.setLyricSizeScale(config.size);s.setTaskbarCloudSpacing(config.spacing);
        if(config.taskbar)s.setTaskbarGeometry({referenceWidth:600,anchorX:config.anchor});
        s.setLines(makeLines(current,next,duration));s.render(start,0,theme,1);
        s.cloud.items=[{id:11,text:'QAL',x:45,y:s.bandH/2,z:.55,fade:1,alive:true,vx:-3,ratio:0},
          {id:12,text:'QAR',x:555,y:s.bandH/2,z:.55,fade:1,alive:true,vx:3,ratio:0}];
        if(!config.taskbar){s.cloud.items[0].x=100;s.cloud.items[1].x=820;}
        s.cloud.queue=[];s.cloud.next=s.lines.length;s.clock={t:start,input:start};s.lastT=start;s.fadeIn=1;s.wallAt=now-100;s.half=0;
        const ctx=s.ctx,original=ctx.fillText,position=s.cloudPosition,fit=s.cloudWordFit,trace=[];let drawn,planned;
        s.cloudWordFit=function(x,half,y,size,blur){
          const value=fit.call(this,x,half,y,size,blur),key=x<300?'QAL':'QAR';
          const fittedBlur=blur*value.scale;
          planned[key]={y:this.bandTop+y,font:size*value.scale,blur:fittedBlur>0.4?fittedBlur:0};
          return value;
        };
        s.cloudPosition=function(x,half){
          const value=position.call(this,x,half),key=x<300?'QAL':'QAR';
          if(planned[key])planned[key].x=value;
          return value;
        };
        ctx.fillText=function(text,x,y,...rest){
          if(text==='QAL'||text==='QAR'){
            const matrix=this.getTransform(),font=/(\\d+(?:\\.\\d+)?)px/.exec(this.font),blur=/blur\\((\\d+(?:\\.\\d+)?)px\\)/.exec(this.filter);
            const metrics=this.measureText(text),scale=Math.hypot(matrix.a,matrix.b),px=matrix.a*x+matrix.c*y+matrix.e,py=matrix.b*x+matrix.d*y+matrix.f;
            drawn[text]={x:px,y:py,font:font?Number(font[1])*scale:null,blur:blur?Number(blur[1]):0,alpha:this.globalAlpha,
              left:px-Math.abs(metrics.actualBoundingBoxLeft*scale)-(blur?Number(blur[1])*2:0),
              right:px+Math.abs(metrics.actualBoundingBoxRight*scale)+(blur?Number(blur[1])*2:0)};
          }
          return original.call(this,text,x,y,...rest);
        };
        for(let i=0;i<3;i++){
          now+=100;drawn={};planned={};s.render(start+i*.1,.1,theme,1);
          trace.push({drawn,planned,items:s.cloud.items.map(it=>({id:it.id,x:it.x,y:it.y,z:it.z,fade:it.fade}))});
        }
        ctx.fillText=original;c.remove();return trace;
      }
      return configs.map(config=>({config,
        baseline:sample(config,short,'下一句',3),currentLong:sample(config,long,'下一句',3),
        nextLong:sample(config,short,long,3),growthFast:sample(config,short,'下一句',1),
        growthSlow:sample(config,short,'下一句',20),transitionShort:sample(config,short,'下一句',3,3),
        transitionLong:sample(config,short,long,3,3)}));
    })()`);
    const errors=[];
    for(const entry of result){
      for(const [label,other] of [['currentLong',entry.currentLong],['nextLong',entry.nextLong],
        ['growth',entry.growthSlow],['transition',entry.transitionLong]]){
        const baseline=label==='growth'?entry.growthFast:label==='transition'?entry.transitionShort:entry.baseline;
        for(let i=0;i<baseline.length;i++){
          assert.deepEqual(other[i].items,baseline[i].items,`${entry.config.name}/${label}: underlying cloud motion changed`);
          let matched=0;
          for(const key of ['QAL','QAR']){
            const a=baseline[i].drawn[key]||baseline[i].planned[key],b=other[i].drawn[key]||other[i].planned[key];if(!a||!b)continue;
            matched++;
            for(const property of ['x','y','font','blur'])if(Math.abs(a[property]-b[property])>0.01)
              errors.push({config:entry.config.name,scenario:label,frame:i,word:key,property,before:a[property],after:b[property]});
            for(const v of [baseline[i].drawn[key],other[i].drawn[key]].filter(Boolean))if(v.left<-.5 || v.right>entry.config.width+.5)
              errors.push({config:entry.config.name,scenario:label,frame:i,word:key,property:'edge',left:v.left,right:v.right});
          }
          if(!matched)errors.push({config:entry.config.name,scenario:label,frame:i,property:'no-common-visible-word'});
        }
      }
    }
    console.log('CLOUD_STABILITY_QA:'+JSON.stringify({errors,result}));
    assert.equal(errors.length,0,`lyric text changed cloud position or scale: ${JSON.stringify(errors.slice(0,12))}`);
    win.destroy();app.exit(0);
  }).catch(error=>{console.error(error.stack||error);app.exit(1);});
} else {
  const {spawnSync}=require('node:child_process');
  const tempRoot=path.resolve(os.tmpdir()),profile=fs.mkdtempSync(path.join(tempRoot,'mineradio-cloud-stability-'));
  try{
    const env={...process.env,MINERADIO_CLOUD_QA_PROFILE:profile};delete env.ELECTRON_RUN_AS_NODE;
    const result=spawnSync(require('electron'),[__filename],{cwd:path.resolve(__dirname,'..'),env,windowsHide:true,encoding:'utf8',timeout:30000});
    process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
    if(result.error||result.status!==0)throw result.error||new Error(`Cloud stability smoke failed: ${result.status}`);
  }finally{
    if(path.dirname(path.resolve(profile))===tempRoot && path.basename(profile).startsWith('mineradio-cloud-stability-'))
      fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:250});
  }
}
