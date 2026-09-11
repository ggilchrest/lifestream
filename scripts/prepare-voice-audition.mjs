// Opt-in, private synthetic-reference comparison. No training or human recording.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash,randomInt} from 'node:crypto';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {VoxCpmProvider} from '../packages/providers-voxcpm/dist/provider.js';
import {VoiceEvidence} from './voice-evidence.mjs';
const profileName=process.argv[2];assert.ok(['mac-local','ai5090'].includes(profileName));
const source=readFileSync(process.env.VOICE_FIXTURE_PCM);assert.ok(source.length>=48000*2*2&&source.length<=48000*2*20);
const reference=Buffer.alloc(Math.floor(source.length/6)*2);
for(let i=0;i<reference.length/2;i++)reference.writeInt16LE(Math.round((source.readInt16LE(i*6)+source.readInt16LE(i*6+2)+source.readInt16LE(i*6+4))/3),i*2);
const p=JSON.parse(readFileSync(new URL(`../apps/server/src/config/profiles/${profileName}.json`,import.meta.url))).ttsProfile;
const provider=new VoxCpmProvider({baseUrl:p.endpoint,runtimeRevision:p.runtimeVersion,modelRevision:p.modelRevision,mappingRevision:p.mappingRevision,voiceBundleKey:p.voiceBundleKey,voiceBundleRevision:p.voiceBundleRevision}).withVoiceDesign({description:'',seed:0,reference:{sampleRateHz:16000,dataBase64:reference.toString('base64'),transcript:''}});
const text='The package will arrive tomorrow. Please leave it beside the front door. The garden is quiet this evening.';
const words=text.split(' '),variants=[{mode:'whole',units:[text]},{mode:'sentences',units:text.match(/[^.!?]+[.!?]/gu).map(x=>x.trim())},{mode:'twelve-word-fragments',units:[words.slice(0,12).join(' '),words.slice(12).join(' ')]}];
for(let i=variants.length-1;i>0;i--){const j=randomInt(i+1);[variants[i],variants[j]]=[variants[j],variants[i]];}
const evidence=new VoiceEvidence(`audition-${profileName}`);const key=[],controller=new AbortController(),timer=setTimeout(()=>controller.abort(),240000);
console.log(JSON.stringify({artifacts:evidence.directory,hypothesis:'fixed synthetic reference across segmentation changes; human comparison, not automated speaker acceptance',maximumSeconds:240}));
try{
  for(let i=0;i<variants.length;i++){
    const variant=variants[i],label=String.fromCharCode(65+i),record=evidence.startCase(label,{profile:p,text,mode:variant.mode,referenceSha256:createHash('sha256').update(reference).digest('hex'),seed:0,conditioning:'reference',humanAcceptance:false});
    const chunks=[];let offset=0;
    for(const unit of variant.units){
      const id=crypto.randomUUID();let terminal;
      for await(const event of provider.synthesize({contractVersion:'2.0.0',text:unit,segmentId:id,format:{encoding:'pcm_s16le',sampleRateHz:48000,channels:1},voiceProfile:{voiceRef:'fixture-voice-design',revision:1},decision:{decisionId:id,revision:1},delivery:{interactionId:id,segmentId:id,decisionId:id,decisionRevision:1,deliveryMode:'neutral',urgency:'normal',pace:.5,energy:.4},deadlineAt:new Date(Date.now()+45000).toISOString()},controller.signal)){
        if(event.kind==='data'){chunks.push(Buffer.from(event.frame.dataBase64,'base64'));evidence.event(record,{...event,frame:{...event.frame,sampleOffset:offset}});offset+=event.frame.sampleCount;}
        else if(event.kind==='terminal'){terminal=event;if(event.outcome!=='succeeded')evidence.event(record,event);}
        else evidence.event(record,event);
      }
      assert.equal(terminal?.outcome,'succeeded');
    }
    const pcm=Buffer.concat(chunks),header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(48000,24);header.writeUInt32LE(96000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
    writeFileSync(join(evidence.directory,`${label}.wav`),Buffer.concat([header,pcm]),{mode:0o600});record.outcome='generated';record.completedMs=performance.now()-record.started;key.push({label,mode:variant.mode,audioSeconds:pcm.length/96000});evidence.finish('inProgress');
  }
  writeFileSync(join(evidence.directory,'audition.html'),`<!doctype html><meta charset="utf-8"><title>Private voice comparison</title><main style="max-width:45rem;margin:3rem auto;font:18px system-ui"><h1>Private voice comparison</h1><p>${profileName} · same synthetic reference, text and settings; shuffled segmentation labels.</p><p>${text}</p><p>Compare word completeness, speaker identity, pace and naturalness. These files are joined without timing padding and do not measure live playback continuity.</p>${key.map(({label})=>`<h2>Sample ${label}</h2><audio controls preload="none" src="${label}.wav"></audio>`).join('')}<details><summary>Reveal segmentation key after listening</summary><pre>${JSON.stringify(key,null,2)}</pre></details></main>`,{mode:0o600});
  evidence.finish('generated');console.log(JSON.stringify({outcome:'generated',artifacts:evidence.directory,key,claim:'private blinded segmentation audition; no human judgment or physical playback claim'}));
}catch(error){evidence.finish('failed',error);console.error(JSON.stringify({error:error.message,artifacts:evidence.directory}));process.exitCode=1;}finally{clearTimeout(timer);}
