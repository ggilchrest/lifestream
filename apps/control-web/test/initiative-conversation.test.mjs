import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLifestreamServer} from '../../server/src/index.ts';
import {loadProfile} from '../../server/src/config/loader.ts';
import {extensionSettings} from '../../../tests/fixtures/extension-settings.ts';
import {ConversationOutput} from '../conversation-output.js';

const frame=()=>({sequence:0,sampleOffset:0,sampleCount:10,format:{encoding:'pcm_s16le',sampleRateHz:48000,channels:1},dataBase64:Buffer.alloc(20).toString('base64')});
test('output matcher accepts either connection order and rejects stopped, foreign or malformed playback',async t=>{
 const originals={WebSocket:globalThis.WebSocket,AudioContext:globalThis.AudioContext,location:globalThis.location};t.after(()=>Object.assign(globalThis,originals));
 const sources=[];class Socket extends EventTarget{static OPEN=1;readyState=1;constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}send(){}close(){this.readyState=3;this.dispatchEvent(new Event('close'));}}
 class Audio extends EventTarget{state='running';currentTime=0;destination={};async resume(){}async close(){this.state='closed';}createBuffer(_channels,length){return {duration:length/48000,getChannelData:()=>new Float32Array(length)};}createBufferSource(){const source=new EventTarget();source.connect=()=>{};source.disconnect=()=>{};source.start=()=>{sources.push(source);};source.stop=()=>source.dispatchEvent(new Event('ended'));return source;}}
 Object.assign(globalThis,{WebSocket:Socket,AudioContext:Audio,location:{protocol:'http:',host:'localhost'}});
 for(const metadataFirst of [true,false]){
  let completed=0;const output=new ConversationOutput({onStopped:()=>{},onState:()=>{},onComplete:()=>{completed++;}});await output.connect();output.expect();const delivery={interactionId:randomUUID(),text:'Synthetic opening.',expiresAt:new Date(Date.now()+10000).toISOString()};
  let acceptance;if(metadataFirst)acceptance=output.accept(delivery);
  output.receive({type:'response',event:{interactionTraceId:delivery.interactionId,payload:{type:'textDelta',text:delivery.text}}});output.receive({type:'audio',interactionTraceId:delivery.interactionId,chunk:{frame:frame()}});
  if(!metadataFirst)acceptance=output.accept(delivery);await acceptance;output.receive({type:'response',event:{interactionTraceId:delivery.interactionId,payload:{type:'terminal',state:'completed'}}});assert.equal(completed,0);sources.at(-1).dispatchEvent(new Event('ended'));assert.equal(completed,1);output.close();
 }
 const output=new ConversationOutput({onStopped:()=>{},onState:()=>{},onComplete:()=>assert.fail('Stop must not complete playback')});await output.connect();output.expect();const trace=randomUUID(),delivery={interactionId:trace,text:'Stop me.',expiresAt:new Date(Date.now()+10000).toISOString()};output.receive({type:'response',event:{interactionTraceId:trace,payload:{type:'textDelta',text:delivery.text}}});await assert.rejects(output.accept({...delivery,interactionId:randomUUID()}));
 output.expect();const accepted=output.accept(delivery);output.receive({type:'response',event:{interactionTraceId:trace,payload:{type:'textDelta',text:delivery.text}}});await accepted;output.receive({type:'audio',interactionTraceId:trace,chunk:{frame:frame()}});output.receive({type:'response',event:{interactionTraceId:trace,payload:{type:'terminal',state:'completed'}}});output.stop();output.close();
});

async function fixture(t,browser){
 const root=await mkdtemp(join(tmpdir(),'ls-initiative-conversation-'));t.after(()=>rm(root,{recursive:true,force:true}));const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};const installerToken=randomUUID(),events=new Map();
 const app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'safety'),installerToken},initiativeSimulation:{resolve:(_scope,_session,id)=>events.get(id)}});await app.start();t.after(()=>app.shutdown());
 let sttCalls=0,inferenceCalls=0;const requests=[];
 app.providers.stt={async *transcribe(){sttCalls++;throw new Error('Output view must not invoke recognition');}};
 app.providers.inference={async *generate(request){inferenceCalls++;requests.push(request);yield {kind:'text',text:request.sections.find(s=>s.kind==='userInput')?.content?'Synthetic ordinary reply.':'A synthetic invitation.'};yield {kind:'done'};}};
 app.providers.tts={withoutAdmissionRetries(){return this;},async *synthesize(request){for(let sequence=0;sequence<20;sequence++)yield {kind:'data',segmentId:request.segmentId,frame:{frameId:randomUUID(),sequence,format:request.format,sampleOffset:sequence*4800,sampleCount:4800,dataBase64:Buffer.alloc(9600).toString('base64')},mappingRevision:'synthetic-playback:1'};yield {kind:'terminal',outcome:'succeeded',outputSamples:96000,frameCount:20,mappingRevision:'synthetic-playback:1',degradedDimensions:[]};}};
 const ctx=await browser.newContext({viewport:{width:1360,height:960}});t.after(()=>ctx.close());const page=await ctx.newPage(),errors=[],captureRequests=[],acks=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{try{const body=request.postDataJSON();if(body?.operation==='acknowledge')acks.push(body);}catch{}});
 await page.addInitScript(()=>{window.captureRequests=0;const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=(...args)=>{window.captureRequests++;return original(...args);};});
 await page.goto(`http://127.0.0.1:${app.address().port}/control/`);await page.waitForFunction(()=>!!window.lifestreamUI);await page.locator('#auth-username').fill('owner');await page.locator('#auth-password').fill(randomUUID()+randomUUID());await page.locator('#auth-installer-token').fill(installerToken);await page.locator('#auth-setup').click();await page.waitForFunction(()=>!!window.lifestreamAuth.session);
 const seed=await page.evaluate(async settings=>{
  const req=(path,body)=>window.lifestreamAuth.request(path,body,body!==undefined),assistant=await req('/api/admin/v1/assistants',{displayName:'Synthetic Conversation'});await req(`/api/admin/v1/assistants/${assistant.assistantId}/activate`,{profileId:assistant.profile.profileId,expectedActiveRevision:null});const rel=(await req(`/api/admin/v1/assistants/${assistant.assistantId}/relationships`,{})).relationship;
  const endpoint=(await req('/api/runtime/v1/session-context',{expectedRevision:0,mode:'audio',audienceScope:'authenticatedSession'})).endpoint,path=`/api/admin/v1/assistants/${assistant.assistantId}/relationships/${rel.relationshipId}`;
  const candidate=(await req(path+'/candidates',{content:'Permit a synthetic opening for this review session.',category:'declaration',contextUse:'baseline',source:'authored',sourceFamily:'synthetic-ui',uncertainty:'low',expectedRevision:rel.revision,idempotencyKey:crypto.randomUUID()})).candidate;
  await req(path+`/candidates/${candidate.candidateId}/decision`,{decision:'approved',expectedRevision:(await req(path)).relationship.revision,idempotencyKey:crypto.randomUUID()});
  settings={...settings,preset:'custom',proactiveness:5,dimensions:{initiative:5,warmth:5,curiosity:3,followThrough:3,persistence:0},allowedContexts:['privateAvailable'],endpointIds:[endpoint.endpointId],allowedModalities:['text','speech'],allowedKinds:['availableCheckIn'],consentRefs:[candidate.candidateId],tuning:{...settings.tuning,openingsPerHour:2,openingsPerDay:8,minimumGapSeconds:120,checkInIntervalSeconds:300}};
  const route=path+'/initiative/v1',draft=await req(route,{schemaVersion:'1.0.0',operation:'draft',idempotencyKey:crypto.randomUUID(),expectedActiveConfigurationId:null,settings}),configuration=draft.records[0];await req(route,{schemaVersion:'1.0.0',operation:'activate',idempotencyKey:crypto.randomUUID(),configurationId:configuration.configurationId,expectedRevision:configuration.revision,confirmed:true});
  return {assistantId:assistant.assistantId,relationshipId:rel.relationshipId,sessionId:window.lifestreamAuth.session.sessionId,userId:window.lifestreamAuth.session.principalId};
 },structuredClone(extensionSettings.initiative));
 await page.reload();await page.waitForFunction(()=>!!window.lifestreamUI&&document.querySelector('#room-scope')?.textContent.includes('Relationship '));
 const nav=async id=>{const link=page.locator(`[data-destination="${id}"]`);if(!await link.isVisible())await page.locator('.nav-toggle').click();await link.click();};await nav('conversation');await page.locator('#room-refresh').click();
 const sourceEventId=randomUUID();events.set(sourceEventId,{...seed,sourceEventId,kind:'availableCheckIn',topicRef:null,observedAt:Date.now()-10000,expiresAt:Date.now()+60000,context:'privateAvailable',modality:'speech'});
 const start=async()=>{await page.locator('#room-modality').selectOption('speech');await page.locator('#room-enable').click();await page.locator('#room-output-state').filter({hasText:'Speech ready'}).waitFor();await page.locator('.room-simulation summary').click();await page.locator('#room-source').fill(sourceEventId);await page.locator('#room-run').click();};
 return {page,nav,app,seed,events,sourceEventId,errors,acks,start,requests,counts:()=>({sttCalls,inferenceCalls,captureRequests})};
}

test('authenticated Conversation renders synthetic speech, waits for scheduled PCM, and resumes an ordinary typed reply',{skip:!process.env.PLAYWRIGHT_MODULE,timeout:60000},async t=>{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const f=await fixture(t,browser);await f.start();
 await f.page.locator('.room-turn-state').filter({hasText:'Endpoint accepted · playback pending'}).waitFor();assert.ok(f.acks.some(a=>a.kind==='endpointAccepted'));assert.equal(f.acks.some(a=>a.kind==='playbackCompleted'),false);
 await f.page.evaluate(()=>window.scrollTo(0,0));await f.page.screenshot({path:'/private/tmp/lifestream-conversation-desktop.png',fullPage:true});
 await f.page.locator('.room-turn-state').filter({hasText:'Playback finished · receipt confirmed'}).waitFor();assert.equal(f.acks.filter(a=>a.kind==='playbackCompleted').length,1);assert.equal(await f.page.evaluate(()=>window.captureRequests),0);assert.equal(f.counts().sttCalls,0);assert.equal(f.counts().inferenceCalls,1);
 assert.equal(await f.page.locator('.room-turn.assistant').count(),1);assert.equal(await f.page.locator('.room-turn.user').count(),0);assert.match(await f.page.locator('.room-turn').textContent(),/Simulated opening/);
 await f.page.locator('#room-message').fill('Hello, this is a typed reply.');await f.page.locator('#room-send').click();await f.page.locator('#room-status').filter({hasText:'Reply completed'}).waitFor();assert.equal(f.counts().inferenceCalls,2);assert.match(f.requests[1].sections.find(s=>s.kind==='conversation').content,/A synthetic invitation/);assert.equal(await f.page.locator('.room-turn.user').count(),1);
 await f.page.locator('#room-refresh').click();await f.page.waitForFunction(()=>document.querySelector('#room-outcome').textContent.includes('Replied'));assert.match(await f.page.locator('#room-outcome').textContent(),/Playback Completed|Playback completed/);assert.match(await f.page.locator('#room-outcome').textContent(),/Replied/);
 await f.page.setViewportSize({width:390,height:844});await f.page.locator('.room-simulation summary').click();await f.page.evaluate(()=>window.scrollTo(0,0));await f.page.screenshot({path:'/private/tmp/lifestream-conversation-mobile.png',fullPage:true});assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await f.nav('account');await f.page.locator('#auth-sign-out').click();await f.page.waitForFunction(()=>!window.lifestreamAuth.session);assert.equal(await f.page.locator('.room-turn').count(),0);assert.equal(await f.page.locator('#room-outcome').textContent(),'');assert.deepEqual(f.errors,[]);
});

test('Stop cancels scheduled Initiative speech without a playback claim or microphone request',{skip:!process.env.PLAYWRIGHT_MODULE,timeout:45000},async t=>{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const f=await fixture(t,browser);await f.start();await f.page.locator('.room-turn-state').filter({hasText:'Endpoint accepted · playback pending'}).waitFor();await f.page.locator('#room-stop').click();await f.page.locator('#room-status').filter({hasText:'Stopped.'}).waitFor();await f.page.waitForTimeout(2600);
 assert.equal(f.acks.some(a=>a.kind==='playbackCompleted'),false);assert.equal(await f.page.evaluate(()=>window.captureRequests),0);assert.equal(f.counts().sttCalls,0);await f.page.locator('#room-refresh').click();await f.page.waitForFunction(()=>document.querySelector('#room-outcome').textContent.includes('Cancelled'));assert.match(await f.page.locator('#room-outcome').textContent(),/Cancelled/);assert.deepEqual(f.errors,[]);
});


test('quiet suppresses synthetic text without a call; clearing it permits a new explicitly requested text opening',{skip:!process.env.PLAYWRIGHT_MODULE,timeout:45000},async t=>{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const f=await fixture(t,browser);f.events.get(f.sourceEventId).modality='text';
 await f.page.locator('.room-setup details summary').click();await f.page.locator('#room-quiet').click();await f.page.locator('#room-status').filter({hasText:'Quiet applies'}).waitFor();await f.page.locator('#room-enable').click();await f.page.locator('#room-output-state').filter({hasText:'Text openings ready'}).waitFor();await f.page.locator('.room-simulation summary').click();await f.page.locator('#room-source').fill(f.sourceEventId);await f.page.locator('#room-run').click();await f.page.waitForFunction(()=>document.querySelector('#room-outcome').textContent.includes('Suppressed'));assert.equal(f.counts().inferenceCalls,0);assert.equal(await f.page.locator('.room-turn').count(),0);
 await f.page.locator('#room-clear-mode').click();await f.page.locator('#room-status').filter({hasText:'Temporary mode cleared'}).waitFor();await f.page.locator('#room-enable').click();await f.page.locator('#room-output-state').filter({hasText:'Text openings ready'}).waitFor();
 const next=randomUUID();f.events.set(next,{...f.events.get(f.sourceEventId),sourceEventId:next,observedAt:Date.now()-9000});await f.page.locator('#room-source').fill(next);await f.page.locator('#room-run').click();await f.page.locator('.room-turn-state').filter({hasText:'Endpoint accepted'}).waitFor();assert.equal(await f.page.locator('.room-turn.assistant').count(),1);assert.equal(await f.page.locator('.room-turn.user').count(),0);assert.equal(f.counts().inferenceCalls,1);assert.equal(f.acks.some(a=>a.kind==='playbackCompleted'),false);assert.equal(await f.page.evaluate(()=>window.captureRequests),0);assert.deepEqual(f.errors,[]);
});

test('Stop releases the browser composer while social generation is still settling',{skip:!process.env.PLAYWRIGHT_MODULE,timeout:45000},async t=>{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const f=await fixture(t,browser);let release,entered,first=true;const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;}),original=f.app.providers.inference;
 f.app.providers.inference={async *generate(request){if(first){first=false;entered();await gate;}yield* original.generate(request);}};
 try{await f.start();await started;assert.equal(await f.page.locator('#room-send').isDisabled(),true);await f.page.locator('#room-stop').click();await f.page.waitForFunction(()=>!document.querySelector('#room-send').disabled);assert.equal(await f.page.locator('.room-turn').count(),0);}finally{release();}
 await f.page.locator('#room-message').fill('A new ordinary message.');await f.page.locator('#room-send').click();await f.page.locator('#room-status').filter({hasText:'Reply completed'}).waitFor();assert.equal(await f.page.locator('.room-turn.user').count(),1);assert.equal(await f.page.locator('.room-turn.assistant').count(),1);assert.equal(f.acks.length,0);assert.deepEqual(f.errors,[]);
});

test('Stop fences a typed submission still waiting for output readiness to close',{skip:!process.env.PLAYWRIGHT_MODULE,timeout:45000},async t=>{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const f=await fixture(t,browser);
 await f.page.locator('#room-enable').click();await f.page.locator('#room-output-state').filter({hasText:'Text openings ready'}).waitFor();
 let release,entered;const gate=new Promise(r=>{release=r;}),pending=new Promise(r=>{entered=r;});
 await f.page.route('**/initiative/v1',async route=>{const body=route.request().postDataJSON();if(body?.operation==='outputReadiness'&&body.ready===false){entered();await gate;}await route.continue();});
 try{await f.page.locator('#room-message').fill('Do not transmit this cancelled message.');await f.page.locator('#room-send').click();await pending;assert.equal(await f.page.locator('#room-send').isDisabled(),true);await f.page.locator('#room-stop').click();await f.page.locator('#room-status').filter({hasText:'Stopped.'}).waitFor();assert.equal(await f.page.locator('#room-send').isDisabled(),false);}finally{release();}
 await f.page.unrouteAll({behavior:'wait'});assert.equal(f.counts().inferenceCalls,0);assert.equal(await f.page.locator('.room-turn').count(),0);
 await f.page.locator('#room-message').fill('An explicitly submitted new message.');await f.page.locator('#room-send').click();await f.page.locator('#room-status').filter({hasText:'Reply completed'}).waitFor();assert.equal(f.counts().inferenceCalls,1);assert.equal(await f.page.locator('.room-turn.user').count(),1);assert.deepEqual(f.errors,[]);
});
