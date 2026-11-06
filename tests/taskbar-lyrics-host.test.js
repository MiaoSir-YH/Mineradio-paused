'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {PassThrough,Writable} = require('node:stream');
const {TaskbarLyricsHost} = require('../desktop/taskbar-lyrics-host');

class ControlledInput extends Writable {
  constructor(){super({highWaterMark:1});this.messages=[];this.waiting=[];}
  _write(chunk,_encoding,callback){this.messages.push(Buffer.from(chunk));this.waiting.push(callback);}
  release(){const done=this.waiting.shift();assert.ok(done,'no in-flight write');done();}
}
class FakeChild extends EventEmitter {
  constructor(){super();this.stdin=new ControlledInput();this.stdout=new PassThrough();this.stderr=new PassThrough();this.killed=false;}
  kill(){this.killed=true;}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const layout=(generation,width=2,height=2,x=4)=>({x,y:10,width,height,minX:0,maxX:10,generation});
const frame=(generation,width=2,height=2,fill=0)=>({
  pixels:Buffer.alloc(width*height*4,fill),width,height,
  hot:{left:0,top:0,right:width,bottom:height},opacity:233,generation
});
function fixture(){
  const child=new FakeChild(), calls=[];
  const bridge=new TaskbarLyricsHost({executable:'fake-host.exe',spawnImpl:(...args)=>{calls.push(args);return child;}});
  return {bridge,child,calls};
}

test('serializes latest layout before latest frame across backpressure and drops stale generation',async()=>{
  const {bridge,child,calls}=fixture();
  assert.equal(bridge.start({handle:'184467',pid:37}),true);
  assert.deepEqual(calls[0],['fake-host.exe',['184467','37'],{windowsHide:true,stdio:['pipe','pipe','pipe']}]);
  assert.equal(bridge.start({handle:'184467',pid:37}),false);
  assert.equal(bridge.setLayout(layout(1)),true);
  assert.equal(bridge.sendFrame(frame(1,2,2,1)),true);
  assert.equal(child.stdin.messages.length,0,'nothing should be written before ready');
  let ready=0;bridge.on('ready',()=>ready++);
  child.stdout.write('{"kind":"rea');
  child.stdout.write('dy","hwnd":"99"}\n');
  assert.equal(ready,1);
  assert.equal(child.stdin.messages.length,1);
  const first=child.stdin.messages[0];
  assert.equal(first.readUInt32LE(0),0x31524c4d);
  assert.equal(first.readUInt32LE(4),2);
  assert.equal(first.readInt32LE(12),0);
  assert.equal(first.readInt32LE(16+6*4),1);
  assert.equal(first.readInt32LE(16+7*4),4);
  assert.equal(bridge.sendFrame(frame(1,2,2,2)),true);
  assert.equal(bridge.setLayout({...layout(2,3,2),threshold:8}),true);
  assert.equal(bridge.sendFrame(frame(1,2,2,3)),false);
  assert.equal(bridge.sendFrame(frame(2,3,2,4)),true);
  assert.equal(bridge.sendFrame(frame(2,3,2,5)),true);
  assert.equal(child.stdin.messages.length,1,'one write remains in flight');
  child.stdin.release();await tick();
  assert.equal(child.stdin.messages.length,2);
  const second=child.stdin.messages[1];
  assert.equal(second.readUInt32LE(4),2);
  assert.equal(second.readInt32LE(16+2*4),3);
  assert.equal(second.readInt32LE(16+6*4),2);
  assert.equal(second.readInt32LE(16+7*4),8);
  child.stdin.release();await tick();
  assert.equal(child.stdin.messages.length,3);
  const third=child.stdin.messages[2];
  assert.equal(third.readUInt32LE(4),1);
  assert.equal(third.readInt32LE(12),24);
  assert.equal(third.readInt32LE(16+7*4),2);
  assert.deepEqual(third.subarray(48),Buffer.alloc(24,5));
  assert.equal(bridge.setLayout(layout(1)),false);
  assert.equal(bridge.setLayout(layout(2,4,2)),false,'size changes require a new generation');
  assert.equal(bridge.setLayout(layout(2,3,2,6)),true,'same-generation position changes are allowed');
  bridge.stop();child.stdin.release();await tick();child.emit('close',0,null);
});

test('validates frame dimensions, bounds, opacity, input types and reports drag events',()=>{
  const {bridge,child}=fixture();
  const drags=[];bridge.on('drag-end',event=>drags.push(event));
  assert.equal(bridge.start({handle:'184467',pid:'37'}),true);
  assert.equal(bridge.setLayout(layout(7)),true);
  assert.equal(bridge.sendFrame({...frame(7),pixels:Buffer.alloc(15)}),false);
  assert.equal(bridge.sendFrame({...frame(7),opacity:256}),false);
  assert.equal(bridge.sendFrame({...frame(7),hot:{left:2,top:0,right:1,bottom:1}}),false);
  assert.equal(bridge.sendFrame({...frame(7),pixels:'not a buffer'}),false);
  assert.equal(bridge.sendFrame({...frame(7),hot:null}),true);
  assert.equal(bridge.setLayout(layout(8,10000,10000)),false);
  assert.equal(bridge.setLayout({...layout(8),threshold:0}),false);
  assert.equal(bridge.setLayout({...layout(8),threshold:65}),false);
  child.stdout.write('{"kind":"drag-end","x":-22,"generation":7}\n');
  child.stdout.write('{"kind":"drag-end","x":"bad","generation":7}\n');
  assert.deepEqual(drags,[{x:-22,generation:7}]);
  bridge.stop();child.emit('close',0,null);
});

test('stop closes input, preserves closed event and marks the eventual exit intentional',()=>{
  const {bridge,child}=fixture();let result;
  bridge.on('exit',value=>{result=value;});
  assert.equal(bridge.start({handle:123,pid:37}),true);
  assert.equal(bridge.stop(),true);
  assert.equal(bridge.stop(),false);
  child.stdout.write('{"kind":"closed","reason":"input-closed","received":2,"drawn":1}\n');
  child.emit('close',0,null);
  assert.equal(result.intentional,true);
  assert.equal(result.host.reason,'input-closed');
  assert.equal(result.host.received,2);
  assert.equal(bridge.child,null);
});

test('kills an unresponsive helper after the bounded EOF wait',async()=>{
  const {bridge,child}=fixture();
  assert.equal(bridge.start({handle:123,pid:37}),true);
  assert.equal(bridge.stop(),true);
  await new Promise(resolve=>setTimeout(resolve,1650));
  assert.equal(child.killed,true);
  child.emit('close',null,'SIGTERM');
});

test('oversized or malformed host output fails closed and unexpected exit is not intentional',()=>{
  for(const text of ['x'.repeat(16385),'{bad json}\n']){
    const {bridge,child}=fixture();const errors=[];let result;
    bridge.on('host-error',error=>errors.push(error.error));
    bridge.on('exit',value=>{result=value;});
    assert.equal(bridge.start({handle:123,pid:37}),true);
    child.stdout.write(text);
    assert.equal(bridge.stopping,true);
    assert.ok(errors.includes(text[0]==='x'?'OUTPUT_LINE_TOO_LONG':'INVALID_HOST_OUTPUT'));
    child.emit('close',1,null);
    assert.equal(result.intentional,false);
  }
});

test('rejects invalid parent handles, reports spawn failure and bounds stderr',()=>{
  const {bridge,child,calls}=fixture();const errors=[];
  bridge.on('host-error',error=>errors.push(error.error));
  assert.equal(bridge.start({handle:'0x123',pid:37}),false);
  assert.equal(bridge.start({handle:123,pid:'4294967296'}),false);
  assert.equal(calls.length,0);
  assert.equal(bridge.start({handle:'9223372036854775807',pid:37}),true);
  child.stderr.write('a'.repeat(20000));
  assert.ok(bridge.stderr.length<=8192);
  bridge.stop();child.emit('close',0,null);
  const broken=new TaskbarLyricsHost({executable:'none',spawnImpl:()=>{throw new Error('failed');}});
  broken.on('host-error',error=>errors.push(error.error));
  assert.equal(broken.start({handle:1,pid:1}),false);
  assert.ok(errors.includes('INVALID_TASKBAR_ARGUMENTS'));
  assert.ok(errors.includes('SPAWN_FAILED'));
});
