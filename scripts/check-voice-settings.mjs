// Real-provider test; generates its own neutral reference in memory. No human recording.
import assert from 'node:assert/strict';
const base=process.env.LIFESTREAM_URL||'http://127.0.0.1:3910';
const headers={'content-type':'application/json','x-lifestream-fixture-session':'voice-settings-check','x-lifestream-fixture-principal':'human'};
const voice={description:'A calm, clear adult woman with a steady conversational voice',seed:42,deliveryMode:'neutral',pace:.5,energy:.4,reference:null};
const synthesize=async(text,voiceSettings)=>{
  const response=await fetch(`${base}/api/runtime/v1/tts`,{method:'POST',headers,body:JSON.stringify({text,voiceSettings}),signal:AbortSignal.timeout(70000)});
  assert.equal(response.status,200,await (!response.ok?response.text():Promise.resolve('')));
  const events=(await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1)?.outcome,'succeeded',JSON.stringify(events.at(-1)));
  const pcm=Buffer.concat(events.filter(e=>e.kind==='data').map(e=>Buffer.from(e.frame.dataBase64,'base64')));
  let energy=0;for(let i=0;i<pcm.length;i+=2)energy+=(pcm.readInt16LE(i)/32768)**2;
  const rms=Math.sqrt(energy/(pcm.length/2));assert.ok(rms>.001);
  console.log(JSON.stringify({mode:voiceSettings?.reference?(voiceSettings.reference.transcript?'continuation':'reference'):voiceSettings?.description?'description':'default',samples:pcm.length/2,rms,terminal:events.at(-1).outcome}));
  return pcm;
};
const options=await(await fetch(`${base}/api/runtime/v1/voice-options`)).json();
assert.equal(options.descriptionSupported,true);assert.equal(options.referenceSupported,true);
const phrase='This is a live Assistant text to speech test.';
const source=await synthesize(phrase,voice);
const sampleCount=Math.floor(source.length/6), pcm16=Buffer.alloc(sampleCount*2);
assert.ok(sampleCount>=32000&&sampleCount<=320000,'generated reference must satisfy 2–20 second bound');
for(let i=0;i<sampleCount;i++)pcm16.writeInt16LE(Math.round((source.readInt16LE(i*6)+source.readInt16LE(i*6+2)+source.readInt16LE(i*6+4))/3),i*2);
const reference={dataBase64:pcm16.toString('base64'),sampleRateHz:16000,transcript:'',consent:true};
await synthesize('The reference voice is ready.',{...voice,description:'',reference});
await synthesize('This is another sentence.',{...voice,reference:{...reference,transcript:phrase}});
console.log(JSON.stringify({result:'pass',profile:options.profile,exclusions:['human speaker similarity','perceptual quality','training','saved Assistant voice'],referenceStorage:'memory only in test; temporary sidecar file removed on completion'}));
