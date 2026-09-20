import {createHash,randomUUID} from 'node:crypto';
import {buildCanonicalPrompt} from '@lifestream/runtime/inference/prompt';
import type {InferenceProvider} from '@lifestream/runtime/inference';
import type {VoxCpmProvider} from '@lifestream/providers-voxcpm';
import type {AcknowledgmentVoice} from '../runtime/acknowledgments.ts';
import type {SavedVoiceAdministration} from './saved-voices.ts';

export function acknowledgmentVoice(admin:SavedVoiceAdministration,assistantId:string,providerBinding:string):AcknowledgmentVoice {
 const profile=admin.activeProfile(assistantId);if(!profile)throw new Error('An active Assistant is required.');
 const voice=admin.resolve(assistantId,providerBinding),binding=createHash('sha256').update(JSON.stringify({assistantId,providerBinding,profileRevision:profile.revision,voice:voice.voiceProfile,language:voice.language,settings:voice.settings})).digest('hex');
 return {...voice,binding,current:()=>voice.current()&&admin.activeProfile(assistantId)?.revision===profile.revision};
}
export async function proposeAcknowledgments(provider:InferenceProvider,voice:AcknowledgmentVoice,signal:AbortSignal):Promise<string[]> {
 const request=buildCanonicalPrompt({assistantId:'acknowledgment-catalog',sessionId:randomUUID(),interactionId:randomUUID(),endpointId:null,deadlineAt:new Date(Date.now()+45000).toISOString(),maximumOutputTokens:300,executionMode:'live',userInput:`Return only a JSON array of ten distinct short spoken acknowledgments. Language: ${voice.language}. Style: ${voice.settings.deliveryMode}. Each must be context-independent, no more than eight words, end in punctuation, and say only that the speaker is listening or considering. No facts, names, history, promises, questions, action results, or claims of memory. Use these acknowledgment intents with natural brief variants: "I am listening.", "Let me think.", "One moment.", "I hear you.", "Let me consider that.", "Hmm.", "I see.", "All right.", "Let me take a look.", "Okay.", "Understood.", "Thanks for sharing."`});
 let text='',done=false;for await(const event of provider.generate(request,{signal})){if(signal.aborted)throw Error('Acknowledgment proposal cancelled.');if(event.kind==='error'||event.kind==='capabilityRequest')throw Error('Acknowledgment proposal rejected.');if(event.kind==='text'){text+=event.text??'';if(text.length>3000)throw Error('Acknowledgment proposal exceeded its bound.');}if(event.kind==='done')done=true;}
 if(!done)throw Error('Acknowledgment proposal incomplete.');return JSON.parse(text);
}
export async function synthesizeAcknowledgment(provider:VoxCpmProvider,text:string,voice:AcknowledgmentVoice,signal:AbortSignal):Promise<Uint8Array>{
 let tts=provider.withoutAdmissionRetries();const s=voice.settings;if(s.description||s.seed!==0||s.reference)tts=tts.withVoiceDesign({description:s.description,seed:s.seed,reference:s.reference});
 const segmentId=randomUUID(),decisionId=randomUUID(),frames:Buffer[]=[];let samples=0,complete=false;
 for await(const event of tts.synthesize({contractVersion:'2.0.0',text,segmentId,format:{encoding:'pcm_s16le',sampleRateHz:48000,channels:1},voiceProfile:voice.voiceProfile,decision:{decisionId,revision:1},delivery:{interactionId:randomUUID(),segmentId,decisionId,decisionRevision:1,deliveryMode:s.deliveryMode,urgency:'low',pace:s.pace,energy:s.energy},deadlineAt:new Date(Date.now()+45000).toISOString()},signal)){
  if(signal.aborted||complete)throw Error('Acknowledgment synthesis is no longer current.');
  if(event.kind==='data'){const f=event.frame,bytes=Buffer.from(f.dataBase64,'base64');if(f.sequence!==frames.length||f.sampleOffset!==samples||bytes.length!==f.sampleCount*2||f.format.encoding!=='pcm_s16le'||f.format.sampleRateHz!==48000||f.format.channels!==1||samples+f.sampleCount>144000)throw Error('Acknowledgment audio must be complete and at most three seconds.');frames.push(bytes);samples+=f.sampleCount;}
  if(event.kind==='terminal'){if(event.outcome!=='succeeded'||event.frameCount!==frames.length||event.outputSamples!==samples||!samples)throw Error('Acknowledgment audio did not complete.');complete=true;}
 }
 if(!complete)throw Error('Acknowledgment audio has no successful terminal.');return Buffer.concat(frames);
}
