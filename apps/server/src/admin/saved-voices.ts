import {createHash,randomUUID} from 'node:crypto';
import {AssistantProfileRepository,SavedVoiceRepository,type Database,type SavedVoice,type AssistantProfile} from '@lifestream/storage-sqlite';
import {defaultVoiceSettings,parseVoiceSettings,type VoiceSettings} from '../runtime/voice-settings.ts';
import type {RuntimeConfig} from '../config/schema.ts';
// Map-3 changes expressive conditioning, not the saved speaker identity. Preserve
// exact map-2 identity bindings without mutating existing voices/profiles. All
// other provider/model/profile differences still invalidate compatibility.
export const savedVoiceConfiguration=(config:RuntimeConfig)=>{
 const profile=config.providers.tts==='voxcpm'&&config.ttsProfile?.mappingRevision==='voxcpm2-map-3'?{...config.ttsProfile,mappingRevision:'voxcpm2-map-2'}:config.ttsProfile??null;
 return createHash('sha256').update(JSON.stringify({provider:config.providers.tts,profile})).digest('hex');
};
// Audition receipts must use the actual mapping: an old preview cannot review
// newly changed synthesis behavior even when its speaker remains compatible.
export const savedVoicePreviewConfiguration=(config:RuntimeConfig)=>createHash('sha256').update(JSON.stringify({provider:config.providers.tts,profile:config.ttsProfile??null})).digest('hex');
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
    // Record the effective legacy choice only for a newly created voice, never migrate existing records.
    if(settings.reference && settings.conditioningMode===undefined)settings.conditioningMode=settings.reference.transcript?'continuation':'reference';
    if((settings.description||settings.seed!==0)&&!controls.description||settings.reference&&!controls.reference)throw new SavedVoiceError('The selected provider does not support these conditioning controls.');
    return this.repository.create({assistantId,label:input.label.trim(),language:input.language,settings:{...settings},providerBinding,createdAt:new Date().toISOString()});
  }
  definition(assistantId:string,voiceRef:string,providerBinding:string):SavedVoice {
    const voice=this.repository.get(assistantId,voiceRef);if(!voice)throw new SavedVoiceError('Voice definition is unavailable in this Assistant.',404);
    if(voice.providerBinding!==providerBinding)throw new SavedVoiceError('Voice definition belongs to a different provider configuration; create and compare a new candidate.',409);return voice;
  }
  /** Resolve a private active source on the host. The public draft contains
   * delivery hints only; reference bytes and transcript never cross the API. */
  deriveSettings(assistantId:string,input:Record<string,unknown>,providerBinding:string,selection?:{reference:NonNullable<VoiceSettings['reference']>;current:()=>boolean}):{source:SavedVoice;settings:VoiceSettings;current:()=>boolean} {
    if(Object.keys(input).some(k=>!['deliveryMode','energy','expectedActiveRevision','expectedSourceRevision','pace','referenceId','sourceVoiceRef','seed','conditioningMode'].includes(k))||!['deliveryMode','energy','expectedActiveRevision','expectedSourceRevision','pace','sourceVoiceRef'].every(k=>Object.hasOwn(input,k))||!(typeof input.sourceVoiceRef==='string'||input.sourceVoiceRef===null)||!Number.isSafeInteger(input.expectedSourceRevision)||!Number.isSafeInteger(input.expectedActiveRevision)||(input.referenceId!==undefined && (!selection||typeof input.referenceId!=='string')))throw new SavedVoiceError('Invalid reference-preserving voice draft.');
    const profile=this.activeProfile(assistantId);if(!profile||profile.revision!==input.expectedActiveRevision||(profile.voiceProfile??null)!==input.sourceVoiceRef)throw new SavedVoiceError('Active voice changed; reload settings.',409);
    const source:SavedVoice=input.sourceVoiceRef===null?{assistantId,voiceRef:'configured-default',revision:1,label:'Configured default',language:'en',settings:{...defaultVoiceSettings},providerBinding,createdAt:profile.createdAt}:this.definition(assistantId,input.sourceVoiceRef as string,providerBinding);if(source.revision!==input.expectedSourceRevision)throw new SavedVoiceError('Source voice changed; reload settings.',409);
    const base=parseVoiceSettings(source.settings);if(selection){if(!selection.current())throw new SavedVoiceError('Selected reference is unavailable.',409);base.reference=selection.reference;}if(!base.reference)throw new SavedVoiceError('This source has no retained reference.',409);
    const settings=parseVoiceSettings({...base,deliveryMode:input.deliveryMode,pace:input.pace,energy:input.energy,...(input.seed===undefined?{}:{seed:input.seed}),...(input.conditioningMode===undefined?{}:{conditioningMode:input.conditioningMode})});
    const current=()=>{const active=this.activeProfile(assistantId),latest=input.sourceVoiceRef===null?source:this.repository.get(assistantId,source.voiceRef);return !!active&&active.profileId===profile.profileId&&active.revision===profile.revision&&(active.voiceProfile??null)===input.sourceVoiceRef&&!!latest&&latest.revision===source.revision&&latest.providerBinding===providerBinding&&(!selection||selection.current());};
    return {source,settings,current};
  }
  derive(assistantId:string,input:Record<string,unknown>,providerBinding:string,controls:{description:boolean;reference:boolean},selection?:{reference:NonNullable<VoiceSettings['reference']>;current:()=>boolean}):SavedVoice {
    if(typeof input.label!=='string'||!input.label.trim()||input.label.length>80)throw new SavedVoiceError('Use a bounded candidate label.');
    const {label,...draft}=input,selected=this.deriveSettings(assistantId,draft,providerBinding,selection);if(!selected.current())throw new SavedVoiceError('Source voice changed; reload settings.',409);
    return this.create(assistantId,{label,language:selected.source.language,settings:selected.settings},providerBinding,controls);
  }
  resolve(assistantId:string|undefined,providerBinding:string):VoiceBinding {
    const profile=assistantId?this.activeProfile(assistantId):undefined,ref=profile?.voiceProfile;
    if(!assistantId||ref===null||ref===undefined)return {settings:{...defaultVoiceSettings},voiceProfile:{voiceRef:'configured-default',revision:1},language:'en',current:()=>!assistantId||this.activeProfile(assistantId)?.voiceProfile===ref};
    if(typeof ref!=='string'||!ref.startsWith('saved-voice:'))throw new SavedVoiceError('The active voice reference is not a locally available saved voice.',409);
    const voice=this.definition(assistantId,ref,providerBinding);
    return {settings:parseVoiceSettings(voice.settings),voiceProfile:{voiceRef:voice.voiceRef,revision:voice.revision},language:voice.language,current:()=>this.activeProfile(assistantId)?.voiceProfile===voice.voiceRef};
  }
  activate(assistantId:string,principalId:string,sessionId:string,input:Record<string,unknown>,providerBinding:string,previewBinding=providerBinding) {
    const keys=Object.keys(input).sort().join(','),modern=keys==='expectedActiveRevision,expectedReferenceSha256,expectedVoiceRevision,voiceRef',legacy=keys==='expectedActiveRevision,previewId,reviewed,voiceRef';
    if((!modern&&!legacy)||typeof input.voiceRef!=='string'||!Number.isSafeInteger(input.expectedActiveRevision)||legacy&&(input.reviewed!==true||typeof input.previewId!=='string'))throw new SavedVoiceError('Choose a saved voice and current Assistant revision.');
    const voice=this.definition(assistantId,input.voiceRef,providerBinding);
    if(modern&&(!Number.isSafeInteger(input.expectedVoiceRevision)||input.expectedVoiceRevision!==voice.revision||input.expectedReferenceSha256!==voiceSummary(voice).settings.reference?.sha256&&!(input.expectedReferenceSha256===null&&voiceSummary(voice).settings.reference===null)))throw new SavedVoiceError('Saved voice changed; reload settings.',409);
    const profiles=new AssistantProfileRepository(this.database),all=profiles.list(assistantId),active=all.find(p=>p.status==='active');
    if(!active||active.revision!==input.expectedActiveRevision)throw new SavedVoiceError('Active Assistant revision changed; refresh and compare before activation.',409);
    // Draft creation may survive a process interruption. Only the existing atomic
    // profile activation operation changes the canonical active voice pointer.
    const draft=profiles.create({...active,profileId:randomUUID(),revision:Math.max(...all.map(p=>p.revision))+1,status:'draft',voiceProfile:voice.voiceRef,createdBy:principalId,createdAt:new Date().toISOString()});
    return profiles.activate(draft.profileId,active.revision,principalId,'Explicit saved voice activation',new Date().toISOString());
  }
}
