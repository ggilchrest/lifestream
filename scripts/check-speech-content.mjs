// ASR diagnostic over private synthesized PCM; not perceptual acceptance.
import {readFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {VoiceEvidence} from './voice-evidence.mjs';
const path=process.env.VOICE_FIXTURE_PCM;if(!path)throw new Error('Provide private mono 48 kHz s16le PCM');
const sampleRate=Number(process.env.VOICE_SAMPLE_RATE_HZ||48000);assert.ok([16000,48000].includes(sampleRate));
const pcm=readFileSync(path);assert.ok(pcm.length>0&&pcm.length<=sampleRate*2*180);
const eventsPath=path.replace(/\.pcm$/u,'.events.ndjson'),ends=[];
if(existsSync(eventsPath)){
  let offset=0;for(const line of readFileSync(eventsPath,'utf8').trim().split('\n')){const e=JSON.parse(line);if(e.kind==='preAudio'&&offset)ends.push(offset*2);if(e.kind==='data')offset=e.frame.sampleOffset+e.frame.sampleCount;}
}
ends.push(pcm.length);const boundaries=[...new Set(ends)].sort((a,b)=>a-b);
const evidence=new VoiceEvidence('speech-content');const base=process.env.VOICE_TEST_URL||'http://127.0.0.1:3911';
const record=evidence.startCase('content',{source:path,expected:process.env.VOICE_EXPECT_TEXT||null,segmentation:existsSync(eventsPath)?'recorded semantic synthesis boundaries':'whole private fixture',base});record.transcripts=[];
try{
  let start=0;
  for(const end of boundaries){
    const part=pcm.subarray(start,end);start=end;assert.ok(part.length<=sampleRate*2*30,'semantic segment exceeds STT test limit');
    const samples=sampleRate===16000?part:Buffer.alloc(Math.floor(part.length/6)*2);
    if(sampleRate===48000)for(let i=0;i<samples.length/2;i++)samples.writeInt16LE(Math.round((part.readInt16LE(i*6)+part.readInt16LE(i*6+2)+part.readInt16LE(i*6+4))/3),i*2);
    const frames=[],audioInputId=crypto.randomUUID();
    for(let offset=0;offset<samples.length;offset+=9600){const bytes=samples.subarray(offset,offset+9600);frames.push({frameId:crypto.randomUUID(),sequence:frames.length,sampleOffset:offset/2,sampleCount:bytes.length/2,format:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1},dataBase64:bytes.toString('base64')});}
    const response=await fetch(`${base}/api/runtime/v1/stt`,{method:'POST',headers:{'content-type':'application/json','x-lifestream-fixture-session':'content-check','x-lifestream-fixture-principal':'human'},body:JSON.stringify({audioInputId,frames}),signal:AbortSignal.timeout(20000)});
    assert.equal(response.status,200);
    const events=(await response.text()).trim().split('\n').map(JSON.parse);assert.equal(events.at(-1)?.outcome,'succeeded');
    record.transcripts.push(events.find(e=>e.payload?.type==='committed')?.payload.text||'');evidence.finish('inProgress');
  }
  record.transcript=record.transcripts.join(' ');
  if(process.env.VOICE_EXPECT_TEXT){
    const words=text=>text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,'').split(/\s+/u).filter(Boolean),expected=words(process.env.VOICE_EXPECT_TEXT),actual=words(record.transcript);
    let row=Array.from({length:actual.length+1},(_,i)=>i);
    for(let i=0;i<expected.length;i++){const next=[i+1];for(let j=0;j<actual.length;j++)next.push(Math.min(row[j+1]+1,next[j]+1,row[j]+(expected[i]===actual[j]?0:1)));row=next;}
    record.wordErrorRate=row.at(-1)/expected.length;
  }
  evidence.finish('measured');console.log(JSON.stringify({artifacts:evidence.directory,transcript:record.transcript,wordErrorRate:record.wordErrorRate,claim:'real ASR content diagnostic; no automatic fidelity or completeness pass'}));
}catch(error){evidence.finish('failed',error);console.error(JSON.stringify({error:error.message,artifacts:evidence.directory}));process.exitCode=1;}
