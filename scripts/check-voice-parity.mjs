// Opt-in real-provider verification; synthetic speech only, no microphone/files.
import assert from 'node:assert/strict';
const base=process.env.LIFESTREAM_URL||'http://127.0.0.1:3910';
const headers={'content-type':'application/json','x-lifestream-fixture-session':'voice-parity-check','x-lifestream-fixture-principal':'human'};
const health=await(await fetch(base+'/health')).json();
const text='The package will arrive tomorrow. Please leave it beside the front door. The garden is quiet this evening. We can take a short walk after dinner. Bring a jacket if the air feels cool. I will meet you outside.';
const start=Date.now(),r=await fetch(base+'/api/runtime/v1/tts',{method:'POST',headers,body:JSON.stringify({text,voiceSettings:{deliveryMode:'reassurance',description:'A warm clear adult voice',seed:42,pace:.5,energy:.4}}),signal:AbortSignal.timeout(70000)});
assert.equal(r.status,200);const events=(await r.text()).trim().split('\n').map(JSON.parse);assert.equal(events.at(-1).outcome,'succeeded',JSON.stringify(events.at(-1)));
const pcm=Buffer.concat(events.filter(e=>e.kind==='data').map(e=>Buffer.from(e.frame.dataBase64,'base64'))),samples=Math.floor(pcm.length/6),data=Buffer.alloc(samples*2);
assert.ok(samples>16000&&samples<=480000,'test must fit the 30-second STT input bound');
for(let i=0;i<samples;i++)data.writeInt16LE(Math.round((pcm.readInt16LE(i*6)+pcm.readInt16LE(i*6+2)+pcm.readInt16LE(i*6+4))/3),i*2);
const frames=[];for(let o=0;o<data.length;o+=9600){const c=data.subarray(o,o+9600);frames.push({frameId:crypto.randomUUID(),sequence:frames.length,format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1},sampleOffset:o/2,sampleCount:c.length/2,dataBase64:c.toString('base64')});}
const stt=await fetch(base+'/api/runtime/v1/stt',{method:'POST',headers,body:JSON.stringify({audioInputId:crypto.randomUUID(),frames}),signal:AbortSignal.timeout(20000)});
assert.equal(stt.status,200);const se=(await stt.text()).trim().split('\n').map(JSON.parse),transcript=se.find(e=>e.payload?.type==='committed')?.payload.text||'';
assert.equal(se.at(-1).outcome,'succeeded');assert.doesNotMatch(transcript,/haha|warm|calm|delivery|reassuring|short sample|voice is ready/i);
for(const word of ['package','tomorrow','garden','dinner','jacket','outside'])assert.ok(transcript.toLowerCase().includes(word),transcript);
console.log(JSON.stringify({profile:health.profile,mappingRevision:events.at(-1).mappingRevision,sentences:6,samples:pcm.length/2,elapsedMs:Date.now()-start,transcript,result:'pass',claim:'real synthesis and ASR content check, not human perception'}));
