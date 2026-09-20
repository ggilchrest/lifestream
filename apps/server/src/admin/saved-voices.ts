import {createHash,randomUUID} from 'node:crypto';
import {AssistantProfileRepository,SavedVoiceRepository,type Database,type SavedVoice,type AssistantProfile} from '@lifestream/storage-sqlite';
import {defaultVoiceSettings,parseVoiceSettings,type VoiceSettings} from '../runtime/voice-settings.ts';
import type {RuntimeConfig} from '../config/schema.ts';
export const savedVoiceConfiguration=(config:RuntimeConfig)=>createHash('sha256').update(JSON.stringify({provider:config.providers.tts,profile:config.ttsProfile??null})).digest('hex');
export type VoiceBinding={settings:VoiceSettings;voiceProfile:{voiceRef:string;revision:number};language:string;current:()=>boolean};
export class SavedVoiceError extends Error {readonly status:number;constructor(message:string,status=422){super(message);this.status=status;}}
export function voiceSummary(value:SavedVoice) {
  const settings=parseVoiceSettings(value.settings),{reference,...controls}=settings;
  return {...value,settings:{...controls,reference:reference?{sha256:createHash('sha256').update(Buffer.from(reference.dataBase64,'base64')).digest('hex'),sampleRateHz:reference.sampleRateHz,durationMs:Buffer.from(reference.dataBase64,'base64').length/32,consent:true}:null}};
}
export class SavedVoiceAdministration {
  readonly repository:SavedVoiceRepository;
  private readonly database:Database;
  constructor(database:Database){this.database=database;this.repository=new SavedVoiceRepository(database);}
  activeProfile(assistantId:string):AssistantProfile|undefined {const row=this.database.connection.prepare("SELECT profile_json AS json FROM assistant_profiles WHERE assistant_id=? AND status='active'").get(assistantId) as {json:string}|undefined;return row?JSON.parse(row.json):undefined;}
  inspect(assistantId:string,providerBinding:string){const profile=this.activeProfile(assistantId);return {voices:this.repository.list(assistantId).map(v=>({...voiceSummary(v),compatible:v.providerBinding===providerBinding})),activeVoiceRef:profile?.voiceProfile??null,activeProfileRevision:profile?.revision??null,providerBinding,scope:'saved-assistant-voice',limit:16};}
  create(assistantId:string,input:Record<string,unknown>,providerBinding:string,controls:{description:boolean;reference:boolean}):SavedVoice {
    if(Object.keys(input).some(k=>!['label','language','settings'].includes(k))||typeof input.label!=='string'||!input.label.trim()||input.label.length>80||typeof input.language!=='string'||!/^en(?:-[A-Z]{2})?$/.test(input.language))throw new SavedVoiceError('Use a bounded label and an English language tag supported by this selected voice profile.');
    const settings=parseVoiceSettings(input.settings);
    if((settings.description||settings.seed!==0)&&!controls.description||settings.reference&&!controls.reference)throw new SavedVoiceError('The selected provider does not support these conditioning controls.');
    return this.repository.create({assistantId,label:input.label.trim(),language:input.language,settings:{...settings},providerBinding,createdAt:new Date().toISOString()});
  }
  definition(assistantId:string,voiceRef:string,providerBinding:string):SavedVoice {
    const voice=this.repository.get(assistantId,voiceRef);if(!voice)throw new SavedVoiceError('Voice definition is unavailable in this Assistant.',404);
    if(voice.providerBinding!==providerBinding)throw new SavedVoiceError('Voice definition belongs to a different provider configuration; create and compare a new candidate.',409);return voice;
  }
  resolve(assistantId:string|undefined,providerBinding:string):VoiceBinding {
    const profile=assistantId?this.activeProfile(assistantId):undefined,ref=profile?.voiceProfile;
    if(!assistantId||ref===null||ref===undefined)return {settings:{...defaultVoiceSettings},voiceProfile:{voiceRef:'configured-default',revision:1},language:'en',current:()=>!assistantId||this.activeProfile(assistantId)?.voiceProfile===ref};
    if(typeof ref!=='string'||!ref.startsWith('saved-voice:'))throw new SavedVoiceError('The active voice reference is not a locally available saved voice.',409);
    const voice=this.definition(assistantId,ref,providerBinding);
    return {settings:parseVoiceSettings(voice.settings),voiceProfile:{voiceRef:voice.voiceRef,revision:voice.revision},language:voice.language,current:()=>this.activeProfile(assistantId)?.voiceProfile===voice.voiceRef};
  }
  activate(assistantId:string,principalId:string,sessionId:string,input:Record<string,unknown>,providerBinding:string) {
    if(Object.keys(input).some(k=>!['voiceRef','previewId','reviewed','expectedActiveRevision'].includes(k))||input.reviewed!==true||typeof input.voiceRef!=='string'||typeof input.previewId!=='string')throw new SavedVoiceError('Preview this saved candidate and explicitly confirm review before activation.');
    const voice=this.definition(assistantId,input.voiceRef,providerBinding);
    if(!this.repository.reviewed({previewId:input.previewId,voiceRef:voice.voiceRef,principalId,sessionId,providerBinding}))throw new SavedVoiceError('A successful current-session preview is required; preview again.',409);
    const profiles=new AssistantProfileRepository(this.database),all=profiles.list(assistantId),active=all.find(p=>p.status==='active');
    if(!active||active.revision!==input.expectedActiveRevision)throw new SavedVoiceError('Active Assistant revision changed; refresh and compare before activation.',409);
    // Draft creation may survive a process interruption. Only the existing atomic
    // profile activation operation changes the canonical active voice pointer.
    const draft=profiles.create({...active,profileId:randomUUID(),revision:Math.max(...all.map(p=>p.revision))+1,status:'draft',voiceProfile:voice.voiceRef,createdBy:principalId,createdAt:new Date().toISOString()});
    return profiles.activate(draft.profileId,active.revision,principalId,'Explicitly reviewed saved voice activation',new Date().toISOString());
  }
}
