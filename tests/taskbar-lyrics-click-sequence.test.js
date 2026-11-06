'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('native click sequence resolves double, triple, drag, close and generation with a simulated clock',
  {skip:process.platform!=='win32'},()=>{
    const windows=process.env.SystemRoot||process.env.WINDIR||'C:\\Windows';
    const compiler=['Framework64','Framework'].map(name=>path.join(windows,'Microsoft.NET',name,'v4.0.30319','csc.exe'))
      .find(file=>fs.existsSync(file));
    assert.ok(compiler,'the .NET Framework C# compiler is required');
    const tempRoot=path.resolve(os.tmpdir());
    const dir=fs.mkdtempSync(path.join(tempRoot,'mineradio-click-test-'));
    try {
      const exe=path.join(dir,'click-sequence-test.exe');
      const sources=[path.join(__dirname,'../desktop/native/taskbar-lyrics-click-sequence.cs'),
        path.join(__dirname,'taskbar-lyrics-click-sequence-harness.cs')];
      const build=spawnSync(compiler,['/nologo','/target:exe','/platform:x64',`/out:${exe}`,...sources],
        {windowsHide:true,encoding:'utf8',timeout:30000});
      assert.equal(build.status,0,`C# click-sequence test did not compile: ${build.error||build.stdout||build.stderr}`);
      const result=spawnSync(exe,[],{windowsHide:true,encoding:'utf8',timeout:10000});
      assert.equal(result.status,0,`C# click-sequence test failed: ${result.error||result.stdout||result.stderr}`);
      assert.match(result.stdout,/CLICK_SEQUENCE_QA:\d+/);
    } finally {
      if(path.dirname(path.resolve(dir))===tempRoot && path.basename(dir).startsWith('mineradio-click-test-'))
        fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:250});
    }
  });
