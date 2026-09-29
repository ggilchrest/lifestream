import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {CameraFrameTransport,createCameraFrameAdapter,cameraMultipart} from '../conversation-camera-frames.js';

const flush = async() => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve,reject; const promise = new Promise((yes,no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; };
const negotiation = () => ({mediaTypes:['image/jpeg','image/png'],bounds:{maxFrameBytes:1048576,maxLongEdgePixels:1280,maxCaptureFramesPerSecond:3,minAdmissionIntervalMs:1000,deadlineMs:3000,freshnessMs:6000,maxClockUncertaintyMs:250}});
const lease = () => ({leaseId:randomUUID(),clockMappingId:randomUUID(),captureActive:true});
const unpack = body => JSON.parse(new TextDecoder().decode(body).split('\r\n\r\n')[1].split('\r\n--')[0]);
const responseFor = (request,status='complete') => {
  const requestId = randomUUID();
  return {wireProfile:'lifestream.visual-input-http',schemaVersion:'1.0.0',requestId,queued:false,result:{requestId,status,reason:null,
    observations:status === 'complete' ? [{observationId:'synthetic-observation',frameIds:[request.meta.frames[0].frameId],appearance:'Synthetic scene text must never enter conversation.',inference:null,confidence:0.8,limitations:['scripted fixture']}]:[]}};
};
function fixture(t,overrides={}) {
  let now=1000,current=true;
  const calls=[],encoded=[],released=[],observations=[],ended=[],timers=new Map(),scope={assistantId:randomUUID(),sessionId:randomUUID()},signal=new AbortController();
  const source={stop(){},async readFrame() { const frame={image:{},width:32,height:24,capturedMonotonicMs:now,release:()=>released.push(frame)}; return frame; }};
  const runner=new CameraFrameTransport({source,scope,signal:signal.signal,lease:lease(),negotiation:negotiation(),endpointClockId:randomUUID(),localExpiresMonotonicMs:61000,
    api:(path,options)=>{const pending=deferred(),call={path,options,...pending,meta:unpack(options.body)};calls.push(call);return pending.promise;},
    now:()=>now,newId:randomUUID,isCurrent:()=>current,onObservation:value=>observations.push(value),onEnded:message=>ended.push(message),
    encode:async()=>{const bytes=Uint8Array.of(255,216,255,encoded.length+1);encoded.push(bytes);return bytes;},
    digest:async bytes=>createHash('sha256').update(bytes).digest('hex'),
    schedule:(fn,ms)=>{const id=randomUUID();timers.set(id,{fn,ms});return id;},cancel:id=>timers.delete(id),...overrides});
  t.after(()=>runner.stop());
  return {runner,source,calls,encoded,released,observations,ended,timers,signal,scope,setNow:value=>{now=value;},setCurrent:value=>{current=value;},
    async tick(value) {if(value!==undefined)now=value;runner.tick();await flush();}};
}

test('one-frame multipart preserves sha256 and uses no filename, URL or durable media reference', async t=>{
  const f=fixture(t);await f.tick();
  assert.equal(f.calls.length,1);assert.equal(f.released.length,1);
  const call=f.calls[0],meta=call.meta,frame=meta.frames[0],body=new TextDecoder().decode(call.options.body);
  assert.equal(meta.assistantId,f.scope.assistantId);assert.equal(meta.frames.length,1);
  assert.equal(frame.sequence,0);assert.equal(frame.capturedMonotonicMs,1000);
  assert.equal(frame.sha256,createHash('sha256').update(Uint8Array.of(255,216,255,1)).digest('hex'));
  assert.match(call.options.headers['content-type'],/^multipart\/form-data; boundary=lifestream-/);
  assert.doesNotMatch(body,/filename=|data:|"url"|"bytes"/);
  assert.equal(f.encoded[0].every(value=>value===0),true,'copied source bytes wiped immediately');
  const held=call.options.body;call.resolve(responseFor(call));await flush();
  assert.equal(held.every(value=>value===0),true,'owned request envelope wiped after settlement');
  assert.deepEqual(f.observations.at(-1),{currentObservationUsable:true});
  assert.equal(JSON.stringify(f.observations).includes('scene text'),false);
});

test('capture and HTTP admission are <=1Hz with one newest pending frame; replaced bytes are wiped',async t=>{
  const f=fixture(t);await f.tick();await f.tick(1500);
  assert.equal(f.encoded.length,1);assert.equal(f.calls.length,1);
  await f.tick(2000);const pending=f.runner.pending.bytes;
  assert.equal(f.calls.length,1);assert.equal(f.runner.pending.sequence,1);
  await f.tick(3000);assert.equal(pending.every(value=>value===0),true);
  assert.equal(f.runner.pending.sequence,2);assert.equal(f.calls.length,1);
  f.calls[0].resolve(responseFor(f.calls[0]));await flush();
  assert.equal(f.calls.length,1,'settlement starts a full host admission interval');
  await f.tick(3500);assert.equal(f.calls.length,1);
  await f.tick(4000);
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].meta.frames[0].sequence,2);
  assert.equal(f.runner.pending.sequence,3);
  f.calls[1].resolve(responseFor(f.calls[1]));await flush();await f.tick(4500);
  assert.equal(f.calls.length,2);await f.tick(5000);assert.equal(f.calls.length,3);
});

test('one encoding operation remains bounded across capture ticks and times out without a retry loop',async t=>{
  const encoding=deferred();const f=fixture(t,{encode:()=>encoding.promise});
  await f.tick();const raw=f.runner.encoding.frame;await f.tick(2000);await f.tick(3000);
  assert.equal(f.calls.length,0);assert.equal(f.runner.encoding.frame,raw);
  await f.tick(4000);assert.equal(f.runner.stopped,true);assert.equal(f.released.length,1);assert.match(f.ended[0],/encoding timed out/);
  const late=Uint8Array.of(255,216,255,1);encoding.resolve(late);await flush();
  assert.equal(late.every(value=>value===0),true);assert.equal(f.released.length,1);
  await f.tick(5000);assert.equal(f.calls.length,0);
});

test('late source frame after stop is released without encoding or upload',async t=>{
  const read=deferred(),f=fixture(t);f.source.readFrame=()=>read.promise;await f.tick();
  f.runner.stop();let released=0;read.resolve({image:{},width:1,height:1,capturedMonotonicMs:1000,release:()=>released++});await flush();
  assert.equal(released,1);assert.equal(f.encoded.length,0);assert.equal(f.calls.length,0);
});

test('stop/scope/expiry abort delivery and wipe every owned pending and request buffer immediately',async t=>{
  for(const cause of ['stop','scope','expiry','signal','clock']) {
    const f=fixture(t);await f.tick();await f.tick(2000);
    const body=f.calls[0].options.body,pending=f.runner.pending.bytes;
    if(cause==='stop')f.runner.stop();if(cause==='signal')f.signal.abort();
    if(cause==='scope'){f.setCurrent(false);await f.tick();}
    if(cause==='expiry')await f.tick(61000);if(cause==='clock')await f.tick(500);
    assert.equal(f.runner.stopped,true,cause);assert.equal(f.calls[0].options.signal.aborted,true,cause);
    assert.equal(body.every(value=>value===0),true,cause);assert.equal(pending.every(value=>value===0),true,cause);
    f.calls[0].resolve(responseFor(f.calls[0]));await flush();
    assert.equal(f.observations.at(-1).currentObservationUsable,false,cause);
  }
});

test('stop wipes encoder-owned bytes while digest is pending',async t=>{
  const digest=deferred(),f=fixture(t,{digest:()=>digest.promise});await f.tick();
  assert.equal(f.encoded[0][0],255);f.runner.stop();assert.equal(f.encoded[0].every(value=>value===0),true);
  digest.resolve('a'.repeat(64));await flush();assert.equal(f.calls.length,0);
});

test('renewal discards old pending/results, retains old HTTP until settlement and binds new frames to new clock mapping',async t=>{
  const f=fixture(t);await f.tick();await f.tick(2000);const old=f.calls[0],pending=f.runner.pending.bytes,oldClock=old.meta.frames[0].clockMappingId;
  f.runner.suspend();assert.equal(pending.every(value=>value===0),true);assert.equal(old.options.signal.aborted,false);
  assert.equal(f.observations.at(-1).currentObservationUsable,false);
  f.runner.renew({lease:{...f.runner.lease,clockMappingId:randomUUID()},negotiation:negotiation(),localExpiresMonotonicMs:62000});
  await f.tick(3000);assert.equal(f.calls.length,1,'no second upload while old one is settling');
  old.resolve(responseFor(old));await flush();
  assert.equal(old.options.signal.aborted,false,'renewal must not disconnect same lease UUID');
  assert.equal(f.observations.at(-1).currentObservationUsable,false,'old complete result cannot relight indicator');
  await f.tick(4000);
  assert.equal(f.calls.length,2);assert.notEqual(f.calls[1].meta.frames[0].clockMappingId,oldClock);
  f.calls[1].resolve(responseFor(f.calls[1]));await flush();assert.equal(f.observations.at(-1).currentObservationUsable,true);
});

test('an old encoding completion cannot enter a renewed queue',async t=>{
  const encoding=deferred(),f=fixture(t,{encode:()=>encoding.promise});await f.tick();
  f.runner.suspend();f.runner.renew({lease:{...f.runner.lease,clockMappingId:randomUUID()},negotiation:negotiation(),localExpiresMonotonicMs:62000});
  const bytes=Uint8Array.of(255,216,255,1);encoding.resolve(bytes);await flush();
  assert.equal(bytes.every(value=>value===0),true);assert.equal(f.calls.length,0);assert.equal(f.runner.pending,null);
});

test('a delivery that never settles times out even across same-lease renewal',async t=>{
  const f=fixture(t);await f.tick();f.runner.renew({lease:{...f.runner.lease,clockMappingId:randomUUID()},negotiation:negotiation(),localExpiresMonotonicMs:90000});
  await f.tick(6000);assert.equal(f.runner.stopped,true);assert.match(f.ended[0],/delivery timed out/);assert.equal(f.calls[0].options.signal.aborted,true);
});

test('a response arriving after its deadline fails closed before the watchdog next ticks',async t=>{
  const f=fixture(t);await f.tick();f.setNow(6000);f.calls[0].resolve(responseFor(f.calls[0]));await flush();
  assert.equal(f.runner.stopped,true);assert.equal(f.observations.at(-1).currentObservationUsable,false);assert.match(f.ended[0],/delivery timed out/);
});

test('usable state expires from original capture time minus clock uncertainty, never from response time',async t=>{
  const f=fixture(t);await f.tick();f.setNow(5000);f.calls[0].resolve(responseFor(f.calls[0]));await flush();
  assert.equal(f.observations.at(-1).currentObservationUsable,true);assert.equal(f.runner.usableUntil,6750);
  f.runner.lastCapture=10000;await f.tick(6749);assert.equal(f.observations.at(-1).currentObservationUsable,true);
  await f.tick(6750);assert.equal(f.observations.at(-1).currentObservationUsable,false);
});

test('failed or empty results clear usable state; unrelated frame provenance fails closed',async t=>{
  for(const status of ['empty','rejected','cancelled','timedOut','failed','foreignFrame','wrongRequest','wrongVersion']) {
    const f=fixture(t);await f.tick();const value=responseFor(f.calls[0],status==='foreignFrame'||status==='wrongRequest'||status==='wrongVersion'?'complete':status);
    if(status==='foreignFrame')value.result.observations[0].frameIds=[randomUUID()];
    if(status==='wrongRequest')value.result.requestId=randomUUID();if(status==='wrongVersion')value.schemaVersion='9.0.0';
    f.calls[0].resolve(value);await flush();assert.equal(f.observations.at(-1).currentObservationUsable,false,status);
    assert.equal(f.runner.stopped,['foreignFrame','wrongRequest','wrongVersion'].includes(status),status);
  }
});

test('oversize dimensions/bytes, future/stale frames and digest failure never reach HTTP',async t=>{
  for(const cause of ['dimensions','bytes','future','stale','digest']) {
    const f=fixture(t);const read=f.source.readFrame;f.source.readFrame=async()=>{const frame=await read();if(cause==='dimensions')frame.width=1281;if(cause==='future')frame.capturedMonotonicMs=1001;if(cause==='stale')frame.capturedMonotonicMs=0;return frame;};
    if(cause==='stale')f.setNow(7000);if(cause==='bytes')f.runner.encode=async()=>new Uint8Array(1048577);if(cause==='digest')f.runner.digest=async()=>'';
    await f.tick();assert.equal(f.calls.length,0,cause);assert.equal(f.runner.stopped,true,cause);assert.equal(f.released.length,1,cause);
  }
});

test('trusted broker adapter prepares without capture, releases late starts and rejects missing frame sources',async()=>{
  const start=deferred(),signal=new AbortController();let prepareCount=0,startCount=0,releaseCount=0,stopCount=0;
  const adapter=createCameraFrameAdapter({sourceLabel:'Generated synthetic source',async prepare(){prepareCount++;return {release:()=>releaseCount++,start:()=>{startCount++;return start.promise;}};}});
  assert.equal(prepareCount,0);const prepared=await adapter.prepare({signal:signal.signal});assert.equal(prepareCount,1);assert.equal(startCount,0);
  const running=prepared.start({signal:signal.signal});prepared.release();start.resolve({stop:()=>stopCount++,readFrame:async()=>null});
  await assert.rejects(running,/withdrawn/);assert.equal(stopCount,1);assert.equal(releaseCount,1);
  assert.throws(()=>createCameraFrameAdapter(null),/trusted camera/);
});

test('multipart rejects uncontrolled header interpolation',()=>{
  assert.throws(()=>cameraMultipart({}, {frameId:randomUUID(),bytes:new Uint8Array(1),mediaType:'image/jpeg'},'bad\r\nheader'),/Invalid/);
});

test('real Chrome encodes generated canvas to bounded JPEG and PNG without any device API', {skip:!process.env.PLAYWRIGHT_MODULE},async t=>{
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://127.0.0.1:9/**',async route=>{
    const name=new URL(route.request().url()).pathname.slice(1);
    await route.fulfill({contentType:name?'text/javascript':'text/html',body:name?await readFile(new URL('../'+name,import.meta.url)):'<!doctype html><html lang="en"><title>Synthetic camera encoder</title></html>'});
  });
  await page.goto('http://127.0.0.1:9/');
  const result=await page.evaluate(async()=>{
    let deviceCalls=0;for(const key of ['getUserMedia','getDisplayMedia','enumerateDevices'])navigator.mediaDevices[key]=()=>{deviceCalls++;throw Error('Physical IO forbidden');};
    const {encodeCameraFrame,cameraMultipart,CameraFrameTransport}=await import('/conversation-camera-frames.js');
    const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const context=canvas.getContext('2d');context.fillStyle='#123456';context.fillRect(0,0,1280,720);
    const receipts=[];
    for(const mediaType of ['image/jpeg','image/png']) {
      const bytes=await encodeCameraFrame({image:canvas,width:1280,height:720},{maxFrameBytes:1048576,maxLongEdgePixels:1280,mediaType,signal:new AbortController().signal});
      const bitmap=await createImageBitmap(new Blob([bytes],{type:mediaType}));const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
      const part=cameraMultipart({frames:[{frameId:'00000000-0000-4000-8000-000000000001'}]}, {frameId:'00000000-0000-4000-8000-000000000001',mediaType,bytes},'lifestream-00000000-0000-4000-8000-000000000002');
      receipts.push({mediaType,size:bytes.length,width:bitmap.width,height:bitmap.height,hash,filename:new TextDecoder().decode(part.body).includes('filename=')});
      bitmap.close();bytes.fill(0);part.body.fill(0);
    }
    // Exercise the real default browser timers too: browser globals cannot be
    // saved as unbound methods and then invoked with the transport as receiver.
    let accept,deliveryCount=0,sourceStops=0;
    const accepted=new Promise(resolve=>{accept=resolve;});
    const transport=new CameraFrameTransport({
      source:{readFrame:async()=>({image:canvas,width:1280,height:720,capturedMonotonicMs:performance.now(),release(){}}),stop(){sourceStops++;}},
      scope:{assistantId:crypto.randomUUID(),sessionId:crypto.randomUUID()},endpointClockId:crypto.randomUUID(),localExpiresMonotonicMs:performance.now()+10000,
      lease:{leaseId:crypto.randomUUID(),clockMappingId:crypto.randomUUID(),captureActive:true},
      negotiation:{mediaTypes:['image/jpeg'],bounds:{maxFrameBytes:1048576,maxLongEdgePixels:1280,maxCaptureFramesPerSecond:3,minAdmissionIntervalMs:1000,deadlineMs:3000,freshnessMs:6000,maxClockUncertaintyMs:250}},
      api:async(path,options)=>{
        deliveryCount++;const metadata=JSON.parse(new TextDecoder().decode(options.body).split('\r\n\r\n')[1].split('\r\n--')[0]),requestId=crypto.randomUUID();
        return {wireProfile:'lifestream.visual-input-http',schemaVersion:'1.0.0',requestId,queued:false,result:{requestId,status:'complete',reason:null,
          observations:[{observationId:'generated-canvas',frameIds:[metadata.frames[0].frameId],appearance:'Synthetic frame',inference:null,confidence:1,limitations:[]}]}};
      },onObservation:value=>{if(value.currentObservationUsable)accept();}});
    let timeout;
    try {await Promise.race([accepted,new Promise((resolve,reject)=>{timeout=setTimeout(()=>reject(Error('Default browser frame transport timed out')),5000);})]);}
    finally {clearTimeout(timeout);transport.stop();}
    canvas.width=0;canvas.height=0;return {deviceCalls,receipts,deliveryCount,sourceStops};
  });
  assert.equal(result.deviceCalls,0);assert.equal(result.receipts.length,2);
  assert.equal(result.deliveryCount,1);assert.equal(result.sourceStops,1);
  for(const receipt of result.receipts){assert.ok(receipt.size>0&&receipt.size<1048576);assert.equal(receipt.width,1280);assert.equal(receipt.height,720);assert.match(receipt.hash,/^[0-9a-f]{64}$/);assert.equal(receipt.filename,false);}
  assert.deepEqual(errors,[]);
});
