import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Database} from '@lifestream/storage-sqlite';
import {fixtureVisualProvider} from '@lifestream/runtime/perception/fixture';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {readSessionEndpoint} from '../src/runtime/session-context.ts';

test('generated browser pixels traverse authenticated frame transport and are disposed after interpretation', {skip:!process.env.PLAYWRIGHT_MODULE,timeout:30_000}, async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ls-browser-visual-'));
  const config=loadProfile('test');
  config.storage={databasePath:join(directory,'state.sqlite'),artifactDirectory:join(directory,'artifacts')};
  config.authority.authentication='local-password';
  const installerToken=randomBytes(32).toString('hex');
  let app:ReturnType<typeof createLifestreamServer>,calls=0,releases=0;
  const retainedBuffers:Uint8Array[]=[];
  const admitted:Array<{frameId:string;mediaType:string;bytes:number;digestMatches:boolean}>=[];
  app=createLifestreamServer({config,localAuth:{stateDirectory:join(directory,'auth'),installerToken},audiencePrivacy:{sourceIds:[]},visualInput:{
    provider:fixtureVisualProvider(request=>{
      calls++;
      assert.equal(request.frames.length,1);
      const frame=request.frames[0]!;
      retainedBuffers.push(frame.bytes);
      admitted.push({frameId:frame.frameId,mediaType:frame.mediaType,bytes:frame.bytes.length,digestMatches:createHash('sha256').update(frame.bytes).digest('hex')===frame.sha256});
      return {requestId:request.requestId,status:'complete',observations:[{observationId:randomUUID(),frameIds:[frame.frameId],appearance:'Scripted observation for generated pixels.',inference:null,confidence:null,limitations:['Synthetic plumbing fixture, not image understanding.']}],reason:null};
    }),
    scopeFor:actor=>{
      const database=(app as unknown as {database:Database}).database;
      const session=readSessionEndpoint(database,actor.sessionId);
      const row=database.connection.prepare("SELECT conversation_id AS conversationId FROM sessions WHERE id=? AND status='active'").get(actor.sessionId) as {conversationId:string}|undefined;
      if(!session.endpoint||!row)return null;
      return {...actor,relationshipId:null,environmentId:'synthetic-browser',conversationId:row.conversationId,endpointId:session.endpoint.endpointId,sessionRevision:session.revision,audienceRevision:1,scopeGeneration:1};
    },
    sourceFor:()=>({bindingRef:'generated-canvas-test-source',connected:true,configurationRevision:1}),
    captureAuthority:()=>({sourceConnected:true,devicePermission:true,hostCaptureLease:true,interpretationAllowed:true,remoteEgressAllowed:false,foregroundVisible:true}),
    releaseCapture:()=>{releases++;}
  }});
  t.after(async()=>{await app.shutdown();await rm(directory,{recursive:true,force:true});});
  await app.start();
  const base=`http://127.0.0.1:${app.address().port}`;
  const setup=await fetch(base+'/api/auth/v1/setup',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:'owner',password:randomBytes(24).toString('hex'),installerToken})});
  assert.equal(setup.status,201);
  const session=(await setup.json()).session as {sessionId:string;csrfToken:string};
  const cookie=setup.headers.get('set-cookie')!.split(';')[0]!,headers={origin:base,'content-type':'application/json',cookie,'x-lifestream-csrf':session.csrfToken};
  const post=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
  const created=await(await post('/api/admin/v1/assistants',{displayName:'Synthetic frame transport Assistant'})).json(),assistantId=created.assistantId as string;
  assert.equal((await post(`/api/admin/v1/assistants/${assistantId}/activate`,{profileId:created.profile.profileId,expectedActiveRevision:null})).status,200);
  assert.equal((await post('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',bindingKey:randomUUID()})).status,200);
  assert.equal((await post('/api/runtime/v1/audience',{mode:'solo',seconds:300})).status,200);
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE!);
  const browser=await chromium.launch({channel:'chrome',headless:true});
  t.after(()=>browser.close());
  const context=await browser.newContext();
  const separator=cookie.indexOf('=');
  await context.addCookies([{name:cookie.slice(0,separator),value:cookie.slice(separator+1),url:base,httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage();
  const errors:string[]=[];
  page.on('pageerror',(error:Error)=>errors.push(error.message));
  // A blank same-origin host avoids unrelated room startup while importing the
  // actual served controller/sender and using the real authenticated routes.
  await page.route(base+'/control/',async(route:any)=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><main>Generated image transport test</main></body></html>'}));
  await page.goto(base+'/control/#conversation');
  await page.evaluate(async({sessionId,assistantId,csrfToken}:any)=>{
    const w=window as any;
    navigator.mediaDevices.getUserMedia=()=>{throw Error('Physical devices are forbidden in this test');};
    const {ConversationCamera}=await import('/control/conversation-camera.js');
    const {createCameraFrameAdapter}=await import('/control/conversation-camera-frames.js');
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=48;
    const graphics=canvas.getContext('2d')!;graphics.fillStyle='#2680c0';graphics.fillRect(0,0,64,48);
    w.sourceStops=0;w.sourceReleases=0;w.frameReleases=0;w.apiFailures=[];
    const api=async(path:string,options:RequestInit={})=>{
      const response=await fetch(path,{...options,headers:{'content-type':'application/json','x-lifestream-csrf':csrfToken,...options.headers}});
      const data=await response.json();
      if(!response.ok){w.apiFailures.push(data.code);throw Error(data.code);}
      return data;
    };
    const capture=createCameraFrameAdapter({sourceLabel:'Generated canvas; no physical camera',prepare:async()=>({
      sourceLabel:'Generated canvas; no physical camera',release:()=>{w.sourceReleases++;},start:async()=>({tracks:[],stop:()=>{w.sourceStops++;},readFrame:async()=>({image:canvas,width:64,height:48,capturedMonotonicMs:performance.now(),release:()=>{w.frameReleases++;}})})
    })});
    w.camera=new ConversationCamera({api,scope:()=>({sessionId,assistantId}),visible:()=>true,capture,onState:(value:any)=>{w.cameraState=value;}});
    await w.camera.enable();
  },{sessionId:session.sessionId,assistantId,csrfToken:session.csrfToken});
  try { await page.waitForFunction(()=>((window as any).cameraState?.currentObservationUsable===true),null,{timeout:8_000}); }
  catch(error) { throw new Error(JSON.stringify({errors,calls,state:await page.evaluate(()=>({state:(window as any).cameraState,failures:(window as any).apiFailures}))}),{cause:error}); }
  assert.ok(calls>=1);
  assert.ok(admitted.every(frame=>frame.bytes>0&&frame.bytes<=1_048_576&&frame.digestMatches&&['image/png','image/jpeg'].includes(frame.mediaType)));
  assert.ok(retainedBuffers.every(buffer=>buffer.every(value=>value===0)),'runtime-owned frame storage is wiped after interpretation');
  const stopped=await page.evaluate(async()=>{const w=window as any;await w.camera.stop();return {state:w.cameraState,sourceStops:w.sourceStops,sourceReleases:w.sourceReleases,frameReleases:w.frameReleases,apiFailures:w.apiFailures};});
  assert.equal(stopped.state.captureActive,false);assert.equal(stopped.state.currentObservationUsable,false);
  assert.equal(stopped.sourceStops,1);assert.equal(stopped.sourceReleases,1);assert.ok(stopped.frameReleases>=1);
  assert.deepEqual(stopped.apiFailures,[]);assert.deepEqual(errors,[]);assert.equal(releases,1);
  const after=await(await post(`/api/runtime/vision/v1/sessions/${session.sessionId}/capabilities`,{schemaVersion:'1.0.0',assistantId,supportedVersions:['1.0.0']})).json();
  assert.equal(after.camera.captureActive,false);
});
