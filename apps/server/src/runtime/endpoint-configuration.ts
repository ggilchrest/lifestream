import {createHash} from 'node:crypto';
import type {Database} from '@lifestream/storage-sqlite';
import type {SessionHandoffService} from '@lifestream/runtime/endpoints/handoff';
import type {RuntimeConfig} from '../config/schema.ts';
import {PresentationPackages,PresentationSelection} from '../admin/presentation-packages.ts';
import {SavedVoiceAdministration,savedVoiceConfiguration} from '../admin/saved-voices.ts';
import {readSessionEndpoint} from './session-context.ts';

/** Read-only projection. Canonical settings and activation remain with their existing owners. */
export function inspectEndpointConfiguration(input:{database:Database;config:RuntimeConfig;principalId:string;sessionId:string;assistantId?:string;personaRevision?:string;catalog:PresentationPackages;selection:PresentationSelection;voices:SavedVoiceAdministration;ownership:SessionHandoffService;audience:unknown;privateContextAllowed:boolean;providers:Record<string,{status:string;fixture?:boolean}|undefined>}) {
 const session=readSessionEndpoint(input.database,input.sessionId),endpoint=session.endpoint;
 const profile=input.assistantId?input.voices.activeProfile(input.assistantId):undefined;
 const selection=endpoint?input.selection.read(input.principalId,endpoint.endpointId,input.sessionId):null;
 const chosen=selection?.override??selection?.default??{id:'neutral',digest:'neutral-v1',revision:0};
 const pack=chosen.id==='neutral'?undefined:input.catalog.list(input.principalId).find(p=>p.id===chosen.id&&p.digest===chosen.digest);
 const available=chosen.id==='neutral'&&chosen.digest==='neutral-v1'||!!pack;
 let voice:{source:string;voiceRef:string|null;revision:number|null;compatible:boolean;reason:string|null};
 try {const bound=input.voices.resolve(input.assistantId,savedVoiceConfiguration(input.config));voice={source:profile?.voiceProfile?'activeAssistantVoice':'configuredVoiceDefault',voiceRef:bound.voiceProfile.voiceRef,revision:bound.voiceProfile.revision,compatible:true,reason:null};}
 catch {voice={source:'activeAssistantVoice',voiceRef:typeof profile?.voiceProfile==='string'?profile.voiceProfile:null,revision:null,compatible:false,reason:'The active voice reference is unavailable for this provider configuration. Review Saved voice; no replacement is selected.'};}
 const lease=input.ownership.currentLease(input.sessionId),owned=!!lease&&input.ownership.owns(lease);
 const value={
  schemaVersion:'1.0.0',readOnly:true,
  session:{revision:session.revision,endpointId:endpoint?.endpointId??null,endpointRevision:endpoint?.configurationRevision??null,endpointClass:endpoint?.endpointClass??null},
  assistant:{assistantId:input.assistantId??null,profileId:profile?.profileId??null,profileRevision:profile?.revision??null,personaRevision:input.personaRevision??null,source:profile?'activeAssistantProfile':'noActiveProfile',endpointPersonaOverride:'notConfigured'},
  disclosure:{selectedScope:endpoint?.privacyClass==='personal'?'authenticatedSession':'unknown',effectiveScope:input.privateContextAllowed?'authenticatedSession':'unknown',source:'currentSessionChoiceAndAudience',audience:input.audience,speakerIdentity:endpoint?.speakerIdentity??'unavailable'},
  modalities:{negotiatedInput:endpoint?.inputModalities??[],negotiatedOutput:endpoint?.outputModalities??[],source:'currentSessionNegotiation',inference:input.providers.inference?.status??'unavailable',speechRecognition:input.providers.stt?.status??'unavailable',speechGeneration:input.providers.tts?.status??'unavailable',physicalCapture:'notObserved',physicalAudibility:'notObserved'},
  voice,
  presentation:{source:selection?.override?'sessionOverride':selection?.default?'endpointDefault':'neutralFallback',selected:{id:chosen.id,digest:chosen.digest,revision:chosen.revision},available,label:pack?.label??(chosen.id==='neutral'?'Neutral reference':'Unavailable pinned appearance'),defaultRevision:selection?.default?.revision??0,overrideRevision:selection?.overrideRevision??0,renderer:pack?.manifest.renderer??(chosen.id==='neutral'?'neutral':'unavailable'),reason:available?null:'Saved appearance bytes are unavailable. Explicit reselection is required; changed bytes are not adopted.',playback:'endpointLocalNotObserved'},
  audioOwnership:{active:owned,endpointId:owned?lease!.ownerEndpointId:null,revision:owned?lease!.revision:null,expiresAt:owned?lease!.expiresAt:null,scope:'currentSessionOnly'},
  handoff:{declaredSupport:endpoint?.handoffSupport??'none',administrationAvailable:false,reason:'The current browser/native administration has no endpoint handoff operation. Runtime lease tests do not establish physical handoff.'},
  precedence:['Current session disclosure and current audience must both permit private context.','Session appearance override takes precedence over the saved endpoint default, then the neutral fallback.','Assistant identity/persona and saved voice come from the active profile. Appearance does not replace them.','Per-turn voice overrides, reduced motion, output enablement and browser capture are endpoint-local; inspect Conversation for their current state.'],
  limitations:['This snapshot does not change settings, activate an Assistant, start playback or grant authority.','Provider availability is separate from negotiated modalities and physical device permission.','No renderer is required to inspect text/audio configuration.','Refresh after edits in another tab; active interactions retain their own revision fences.']
 };
 return {...value,sourceRevision:createHash('sha256').update(JSON.stringify(value)).digest('hex')};
}
