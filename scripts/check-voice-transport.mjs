// Real adapter/tunnel diagnosis, independent of inference/STT readiness.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {VoxCpmProvider} from '../packages/providers-voxcpm/dist/provider.js';
import {synthesizePreview} from '../apps/server/dist/runtime/preview-speech.js';
import {VoiceEvidence} from './voice-evidence.mjs';
const profileName=process.argv[2]||'ai5090';if(!['ai5090','mac-local'].includes(profileName))throw new Error('Unknown profile');
const profile=JSON.parse(readFileSync(new URL(`../apps/server/src/config/profiles/${profileName}.json`,import.meta.url))).ttsProfile;
const corpus=JSON.parse(readFileSync(new URL('./voice-stabilization-corpus.json',import.meta.url)));
const provider=new VoxCpmProvider({baseUrl:profile.endpoint,runtimeRevision:profile.runtimeVersion,modelRevision:profile.modelRevision,mappingRevision:profile.mappingRevision,voiceBundleKey:profile.voiceBundleKey,voiceBundleRevision:profile.voiceBundleRevision}).withVoiceDesign({description:'A warm clear adult voice',seed:42});
const evidence=new VoiceEvidence(`transport-${profileName}`);console.log(JSON.stringify({artifacts:evidence.directory}));
try{
  for(const mode of ['original','cancel','recovery']){
    const controller=new AbortController(),id=crypto.randomUUID(),text=mode==='cancel'?corpus.long[0]:corpus.original;
    const record=evidence.startCase(mode,{profile,text,design:{description:'A warm clear adult voice',seed:42},deadlineMs:60000});let terminal,frames=0,cancelAt;
    const input={contractVersion:'2.0.0',text,segmentId:id,format:{encoding:'pcm_s16le',sampleRateHz:48000,channels:1},voiceProfile:{voiceRef:'fixture-voice-design',revision:1},decision:{decisionId:id,revision:1},delivery:{interactionId:id,segmentId:id,decisionId:id,decisionRevision:1,deliveryMode:'reassurance',urgency:'normal',pace:.5,energy:.4},deadlineAt:new Date(Date.now()+60000).toISOString()};
    for await(const event of synthesizePreview(provider,input,controller.signal)){
      evidence.event(record,event);if(event.kind==='terminal')terminal=event;
      if(event.kind==='data'&&++frames===2&&mode==='cancel'){cancelAt=performance.now();controller.abort();}
    }
    assert.equal(terminal?.outcome,mode==='cancel'?'cancelled':'succeeded',JSON.stringify(terminal));
    if(cancelAt){record.cancelToTerminalMs=performance.now()-cancelAt;assert.ok(record.cancelToTerminalMs<1000);}
    // Safe-yield cleanup may lag adapter cancellation; bound and measure it.
    const cleanup=performance.now();while(true){const health=await fetch(`${profile.endpoint}/healthz`,{signal:AbortSignal.timeout(2000)}).then(r=>r.json());if(!health.busy)break;if(performance.now()-cleanup>5000)throw new Error('Sidecar compute did not release within 5 seconds');await new Promise(resolve=>setTimeout(resolve,100));}
    record.cleanupMs=performance.now()-cleanup;evidence.finish('inProgress');
  }
  evidence.finish('passed');console.log(JSON.stringify({outcome:'passed',artifacts:evidence.directory,claim:'real adapter original text, cancellation and fresh synthesis; excludes browser, STT and human hearing'}));
}catch(error){evidence.finish('failed',error);console.error(JSON.stringify({error:error.message,artifacts:evidence.directory}));process.exitCode=1;}
