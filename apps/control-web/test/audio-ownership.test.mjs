import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createLifestreamServer} from '../../server/src/index.ts';
import {loadProfile} from '../../server/src/config/loader.ts';

test('real WebSocket and WebAudio retain ordinary ownership through queued playback and explicit stop',{skip:!process.env.PLAYWRIGHT_MODULE,timeout:30000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'ls-playback-owner-'));t.after(()=>rm(root,{recursive:true,force:true}));const config=loadProfile('test');config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};
 const app=createLifestreamServer({config});await app.start();t.after(()=>app.shutdown());const base=`http://127.0.0.1:${app.address().port}`;
 app.providers.stt={async *transcribe(){yield {kind:'data',payload:{type:'committed',text:'Synthetic voice input.'}};yield {kind:'terminal',outcome:'succeeded'};}};
 app.providers.tts={async *synthesize(request){for(let i=0;i<15;i++)yield {kind:'data',segmentId:request.segmentId,frame:{frameId:randomUUID(),sequence:i,format:request.format,sampleOffset:i*4800,sampleCount:4800,dataBase64:Buffer.alloc(9600).toString('base64')},mappingRevision:'synthetic-1'};yield {kind:'terminal',outcome:'succeeded',outputSamples:72000,frameCount:15,mappingRevision:'synthetic-1',degradedDimensions:[],disposition:'fullyApplied'};}};
 const {chromium,_electron}=await import(process.env.PLAYWRIGHT_MODULE),browser=process.env.PLAYBACK_ELECTRON?null:await chromium.launch({channel:'chrome',headless:true});if(browser)t.after(()=>browser.close());
 const preview=async sessionId=>{const response=await fetch(base+'/api/runtime/v1/tts',{method:'POST',headers:{origin:base,'content-type':'application/json','x-lifestream-fixture-session':sessionId,'x-lifestream-fixture-principal':'human'},body:JSON.stringify({text:'Synthetic preview.'})});await response.text();return response.status;};
 for(const legacy of [false,true]){
  const desktop=process.env.PLAYBACK_ELECTRON?await _electron.launch({executablePath:process.env.PLAYBACK_ELECTRON,args:['--user-data-dir='+join(root,legacy?'native-legacy':'native-room'),'--url',base+'/control/']}):null;if(desktop)t.after(()=>desktop.close().catch(()=>{}));
  const page=desktop?await desktop.firstWindow():await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(8000);
  if(legacy)await page.route('**/control/conversation.js',async route=>route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../conversation.js',import.meta.url),'utf8')+`\nwindow.playbackProbe={async connect(){audioContext=new AudioContext();await audioContext.resume();await openVoiceSocket();return voiceSessionId;},turn(){voiceSpeaking=true;sendVoiceFrame(new Float32Array(512));commitVoiceTurn();},stop:()=>stopPlayback(),snapshot:()=>({sources:playingSources.size,pending:voiceTurnInFlight,playing:!!voicePlayback}),close:()=>stopCapture()};`}));
  await page.goto(base+'/control/'+(legacy?'conversation.html':''));
  const sessionId=legacy?await page.evaluate(()=>window.playbackProbe.connect()):await page.evaluate(async()=>{
   const sessionId=crypto.randomUUID(),NativeWebSocket=WebSocket;window.WebSocket=class extends NativeWebSocket{constructor(url){const next=new URL(url);next.searchParams.set('fixtureSession',sessionId);next.searchParams.set('fixturePrincipal','human');super(next);}};
   const {ConversationOutput}=await import('/control/conversation-output.js');let accepted=false,terminal=false;const records=[];
   const output=new ConversationOutput({onStopped(){},onComplete(){},onState(){},onError:error=>{throw error;},onMessage:message=>{if(message.type==='accepted'){accepted=true;return true;}if(message.type==='turnStarted'){terminal=false;output.beginReply(message.interactionTraceId);return true;}if(message.event?.payload.type==='terminal')terminal=true;return false;}});
   await output.connect();const send=output.socket.send.bind(output.socket);output.socket.send=raw=>{const value=JSON.parse(raw);if(value.type==='playbackSettled')records.push({...value,sources:output.sources.size});send(raw);};const inputId=crypto.randomUUID();send(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:crypto.randomUUID(),correlationId:crypto.randomUUID(),sessionId,expectedSessionRevision:1,endpointId:crypto.randomUUID(),audioInputId:inputId,format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1}}}));
   const end=performance.now()+5000;while(!accepted){if(performance.now()>end)throw Error('Audio start not acknowledged');await new Promise(r=>setTimeout(r,10));}
   window.playbackProbe={turn(){send(JSON.stringify({type:'frame',audioInputId:inputId,frame:{frameId:crypto.randomUUID(),sequence:0,format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1},sampleOffset:0,sampleCount:512,dataBase64:btoa('\0'.repeat(1024))}}));send(JSON.stringify({type:'commitTurn',audioInputId:inputId,nextSequence:1,sampleCount:512}));},stop:()=>output.stop(),snapshot:()=>({sources:output.sources.size,pending:!terminal,playing:!!output.turn,records}),close:()=>output.close()};return sessionId;
  });
  for(const stopped of [false,true]){
   await page.evaluate(()=>window.playbackProbe.turn());await page.waitForFunction(()=>{const s=window.playbackProbe.snapshot();return !s.pending&&s.sources>0;});assert.equal(await preview(sessionId),409,`${legacy?'legacy':'room'} playback must retain ownership after synthesis`);
   if(stopped)await page.evaluate(()=>window.playbackProbe.stop());
   await page.waitForFunction(()=>!window.playbackProbe.snapshot().playing);
   // The endpoint report crosses the real socket before a later HTTP admission.
   let status;const until=Date.now()+2000;do{status=await preview(sessionId);if(status===200)break;await new Promise(r=>setTimeout(r,10));}while(Date.now()<until);assert.equal(status,200);
  }
  if(!legacy){const state=await page.evaluate(()=>window.playbackProbe.snapshot());assert.deepEqual(state.records.map(r=>r.outcome),['completed','stopped']);assert.ok(state.records.every(r=>r.sources===0&&r.receivedSamples===72000));}
  await page.evaluate(()=>window.playbackProbe.close());assert.deepEqual(errors,[]);if(desktop)await desktop.close();else await page.close();
 }
});
