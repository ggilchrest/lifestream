// Opt-in real speech checks independent of inference readiness. No user audio.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {VoxCpmProvider} from '../packages/providers-voxcpm/dist/provider.js';
import {NemoSpeechProvider} from '../packages/providers-nemo-speech/dist/provider.js';
import {synthesizePreview} from '../apps/server/dist/runtime/preview-speech.js';
import {VoiceEvidence} from './voice-evidence.mjs';
const evidence=new VoiceEvidence('ai5090-original');
console.log(JSON.stringify({artifacts:evidence.directory,deadlineDefinition:'60000 ms total synthesis wall-time; segmented mode additionally has a 45000 ms per-segment ceiling; not 60 seconds of decoded audio'}));
try {
const profile=JSON.parse(readFileSync(new URL('../apps/server/src/config/profiles/ai5090.json',import.meta.url)));
const p=profile.ttsProfile;
const vox=new VoxCpmProvider({baseUrl:p.endpoint,runtimeRevision:p.runtimeVersion,modelRevision:p.modelRevision,mappingRevision:p.mappingRevision,voiceBundleKey:p.voiceBundleKey,voiceBundleRevision:p.voiceBundleRevision});
assert.deepEqual(await vox.voiceControls(),{description:true,reference:true});
const voice={description:'A warm clear adult voice',seed:42};
const longOnly=process.argv.includes('--long-only');
async function synthesize(text,design,mode){
  const id=crypto.randomUUID(),start=Date.now(),events=[];
  const record=evidence.startCase(mode,{text,design:{...design,reference:design.reference?{...design.reference,dataBase64:'private-in-request'}:undefined},profile:p,totalDeadlineMs:60000,segmentDeadlineMs:mode==='six-sentences'?45000:null});
  const generate=input=>mode==='six-sentences'?synthesizePreview(vox.withVoiceDesign(design),input):vox.withVoiceDesign(design).synthesize(input);
  for await(const event of generate({contractVersion:'2.0.0',text,segmentId:id,format:{encoding:'pcm_s16le',sampleRateHz:48000,channels:1},voiceProfile:{voiceRef:'fixture-voice-design',revision:1},decision:{decisionId:id,revision:1},delivery:{interactionId:id,segmentId:id,decisionId:id,decisionRevision:1,deliveryMode:'reassurance',urgency:'normal',pace:.5,energy:.4},deadlineAt:new Date(Date.now()+60000).toISOString()})){evidence.event(record,event);events.push(event);}
  assert.equal(events.at(-1)?.outcome,'succeeded',JSON.stringify(events.at(-1)));
  const pcm=Buffer.concat(events.filter(e=>e.kind==='data').map(e=>Buffer.from(e.frame.dataBase64,'base64')));
  let energy=0;for(let i=0;i<pcm.length;i+=2)energy+=(pcm.readInt16LE(i)/32768)**2;
  const rms=Math.sqrt(energy/(pcm.length/2));assert.ok(rms>.001);
  console.log(JSON.stringify({profile:'ai5090',mode,samples:pcm.length/2,rms,elapsedMs:Date.now()-start,mappingRevision:p.mappingRevision,outcome:'succeeded'}));return pcm;
}
function resample(pcm){const out=Buffer.alloc(Math.floor(pcm.length/6)*2);for(let i=0;i<out.length/2;i++)out.writeInt16LE(Math.round((pcm.readInt16LE(i*6)+pcm.readInt16LE(i*6+2)+pcm.readInt16LE(i*6+4))/3),i*2);return out;}
const phrase='This is a live Assistant text to speech test.';
if(!longOnly){
const source=resample(await synthesize(phrase,voice,'description'));
assert.ok(source.length>=64000&&source.length<=640000,'reference must fit 2-20 seconds');
const reference={dataBase64:source.toString('base64'),sampleRateHz:16000,transcript:''};
await synthesize('The reference voice is ready.',{...voice,description:'',reference},'reference');
await synthesize('This is another sentence.',{...voice,reference:{...reference,transcript:phrase}},'continuation');
}
const text='The package will arrive tomorrow. Please leave it beside the front door. The garden is quiet this evening. We can take a short walk after dinner. Bring a jacket if the air feels cool. I will meet you outside.';
const pcm=resample(await synthesize(text,voice,'six-sentences'));
assert.ok(pcm.length<=960000,'STT test input remains at most 30 seconds');
const signal=AbortSignal.timeout(30000),events=[];
const nemo=new NemoSpeechProvider({baseUrl:profile.sttProfile.endpoint,model:profile.sttProfile.model,webSocketFactory:url=>{const socket=new WebSocket(url);signal.addEventListener('abort',()=>socket.close(),{once:true});return socket;}});
async function* frames(){let sequence=0;const audioInputId=crypto.randomUUID();for(let offset=0;offset<pcm.length;offset+=9600){const chunk=pcm.subarray(offset,offset+9600);yield {type:'frame',audioInputId,frame:{frameId:crypto.randomUUID(),sequence:sequence++,format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1},sampleOffset:offset/2,sampleCount:chunk.length/2,dataBase64:chunk.toString('base64')}};}yield {type:'end',audioInputId,nextSequence:sequence,sampleCount:pcm.length/2};}
for await(const event of nemo.transcribe({deadlineAt:new Date(Date.now()+30000).toISOString(),now:()=>new Date().toISOString()},frames(),signal))events.push(event);
assert.equal(events.at(-1)?.outcome,'succeeded');
const transcript=events.find(e=>e.payload?.type==='committed')?.payload.text||'';
assert.doesNotMatch(transcript,/haha|warm|calm|delivery|reassuring|short sample|voice is ready/i);
for(const word of ['package','tomorrow','garden','dinner','jacket','outside'])assert.ok(transcript.toLowerCase().includes(word),transcript);
console.log(JSON.stringify({result:'pass',profile:'ai5090',checks:longOnly?['segmented-six-sentence','real-NeMo-content']:['description','reference','continuation','segmented-six-sentence','real-NeMo-content'],transcript,claim:'only listed real speech checks; excludes inference, browser playback and human perception'}));
evidence.finish('passed');
} catch(error) {
  evidence.finish('failed',error);
  console.error(JSON.stringify({result:'failed',artifacts:evidence.directory,error:error.message}));
  process.exitCode=1;
}
