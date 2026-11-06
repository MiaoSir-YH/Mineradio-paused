'use strict';

// Disposable, non-player window for real foreground-preservation checks.
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const child = spawn(require('electron'), [__filename], { windowsHide:true, stdio:['pipe','pipe','pipe'] });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); process.stdin.pipe(child.stdin);
  child.on('close', code => { process.exitCode = code || 0; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const root = path.resolve(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(root, 'mineradio-focus-qa-'));
  app.setName('Mineradio Focus QA');
  app.setPath('userData', profile);
  app.setAppUserModelId(`com.mineradio.focus.qa.${process.pid}`);
  let win;
  app.whenReady().then(() => {
    win = new BrowserWindow({ x:100, y:100, width:280, height:140, show:false, alwaysOnTop:true, title:'Mineradio Focus QA',
      webPreferences:{ contextIsolation:true, nodeIntegration:false } });
    win.once('ready-to-show', () => {
      win.showInactive();
      const handle=win.getNativeWindowHandle();
      const hwnd=handle.length>=8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
      console.log('FOCUS_QA_READY:'+JSON.stringify({pid:process.pid,hwnd,bounds:win.getBounds()}));
    });
    return win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><title>Mineradio Focus QA</title><body style="font:16px sans-serif;background:#1a3036;color:white;padding:20px">Mineradio Focus QA</body>'));
  }).catch(error=>{console.error(error);app.quit();});
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', text=>{if(String(text).includes('stop'))app.quit();});
  app.on('window-all-closed',()=>app.quit());
  process.on('exit',()=>{
    if(path.dirname(path.resolve(profile))===root && path.basename(profile).startsWith('mineradio-focus-qa-')) {
      try {fs.rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});}catch(_){}
    }
  });
}
