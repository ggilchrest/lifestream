import {createContractValidator} from '@lifestream/contracts';
import type {AssistantProfile} from '@lifestream/storage-sqlite';
import {checkContinuity,continuityDigest,type ContinuityBinding} from './continuity-adapter.ts';
import {completeHistoricalPersona,PERSONA_RESTORE_COMPONENTS} from './persona-restore.ts';
import {promptDocument,parsePromptDocument,validatePromptTransition,PROMPT_DOCUMENT_KEY,type PromptDocument} from './prompt-document.ts';
const validator=createContractValidator();
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>object(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export const PERSONA_BACKUP_PATH='persona/assistant-persona.json',PERSONA_BACKUP_REF='selected-active-persona-component:v1';
export type PersonaComponent={schemaVersion:'lifestream.persona-component/1';source:{assistantId:string;profileId:string;revision:number};persona:{corePersona:AssistantProfile['corePersona'];adaptivePersonaPolicy:AssistantProfile['adaptivePersonaPolicy'];promptDocument:PromptDocument|null}};
export function checkedPersonaComponent(raw:unknown):PersonaComponent{
 if(!exact(raw,['schemaVersion','source','persona'])||raw.schemaVersion!=='lifestream.persona-component/1'||!exact(raw.source,['assistantId','profileId','revision'])||!uuid(raw.source.assistantId)||!uuid(raw.source.profileId)||!Number.isSafeInteger(raw.source.revision)||Number(raw.source.revision)<1||!exact(raw.persona,['corePersona','adaptivePersonaPolicy','promptDocument']))throw Error('persona_backup_component_invalid');
 completeHistoricalPersona(raw.persona.corePersona);
 const source=raw.source,persona=raw.persona;
 if(!validator.validate('https://lifestream.dev/contracts/assistant-profile/2.0.0',{schemaVersion:'2.0.0',assistantId:source.assistantId,profileId:source.profileId,revision:source.revision,status:'draft',createdAt:'2026-01-01T00:00:00.000Z',createdBy:'component-validation',corePersona:persona.corePersona,adaptivePersonaPolicy:persona.adaptivePersonaPolicy}).valid)throw Error('persona_backup_component_invalid');
 if(persona.promptDocument!==null)parsePromptDocument(persona.promptDocument);
 return structuredClone(raw) as PersonaComponent;
}
export function personaComponent(profile:AssistantProfile):PersonaComponent{return checkedPersonaComponent({schemaVersion:'lifestream.persona-component/1',source:{assistantId:profile.assistantId,profileId:profile.profileId,revision:profile.revision},persona:{corePersona:profile.corePersona,adaptivePersonaPolicy:profile.adaptivePersonaPolicy,promptDocument:promptDocument(profile)??null}});}
/** JSON.parse first validates syntax; tokens then reject duplicate DECODED keys.
 * No imported object gets getters, prototype assignment or filesystem access. */
function originalJSON(bytes:Buffer){
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);const value:unknown=JSON.parse(text);
 const stack:(Set<string>|null)[]=[];let nodes=0;
 const tokens=text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)??[];
 for(let i=0;i<tokens.length;i++){const t=tokens[i]!;if(++nodes>16384||stack.length>64)throw Error('persona_backup_component_bound');if(t==='{')stack.push(new Set());else if(t==='[')stack.push(null);else if(t==='}'||t===']')stack.pop();else if(t.startsWith('"')&&tokens[i+1]===':'){const keys=stack.at(-1),key=JSON.parse(t) as string;if(!keys||keys.has(key))throw Error('persona_backup_duplicate_key');keys.add(key);}}
 return value;
}
export function readPersonaBackup(raw:unknown,target:ContinuityBinding){
 const bundle=checkContinuity(raw),f=bundle.files[0];
 if(!bundle.binding||['assistantId','userId','relationshipId','deploymentId'].some(k=>bundle.binding![k as keyof ContinuityBinding]!==target[k as keyof ContinuityBinding])||bundle.files.length!==1||bundle.provenance.basis!=='ownerView'||bundle.provenance.sourceRef!==PERSONA_BACKUP_REF||!f||f.path!==PERSONA_BACKUP_PATH||f.classification!=='ownerSnapshot'||f.mediaType!=='application/json')throw Error('persona_backup_selection_invalid');
 const bytes=Buffer.from(f.bytesBase64,'base64'),component=checkedPersonaComponent(originalJSON(bytes));if(component.source.assistantId!==target.assistantId)throw Error('persona_backup_selection_invalid');
 return {bundle,component,originalText:bytes.toString('utf8'),originalDigest:continuityDigest(bytes)};
}
export function preparePersonaBackup(latest:AssistantProfile,history:AssistantProfile[],component:PersonaComponent){
 const source=checkedPersonaComponent(component);if(source.source.assistantId!==latest.assistantId||history.some(p=>p.assistantId!==latest.assistantId)||JSON.stringify(history.at(-1))!==JSON.stringify(latest)||!['active','draft'].includes(latest.status)||!Number.isSafeInteger(latest.revision)||latest.revision>=Number.MAX_SAFE_INTEGER)throw Error('persona_backup_target_invalid');
 const supported=new Set(['schemaVersion','assistantId','profileId','revision','status','createdAt','createdBy','rollbackOf','displayName','corePersona','adaptivePersonaPolicy','voiceProfile','embodimentProfile','presentationProfile','providerProfile','extensions']);
 if(Object.keys(latest).some(k=>!supported.has(k))||!['adaptivePersonaPolicy','voiceProfile','embodimentProfile','presentationProfile','providerProfile'].every(k=>Object.hasOwn(latest,k))||latest.extensions!==undefined&&!object(latest.extensions))throw Error('persona_backup_preservation_unsupported');
 const docs=history.map(promptDocument).filter((d):d is PromptDocument=>!!d),ids=new Set(docs.map(d=>d.documentId)),old=source.persona.promptDocument;
 if(ids.size>1||old&&(!ids.size||!ids.has(old.documentId)))throw Error('persona_backup_lineage_changed');
 let document:PromptDocument|undefined;
 if(ids.size){const maximum=Math.max(...docs.map(d=>d.revision));if(maximum>=Number.MAX_SAFE_INTEGER)throw Error('persona_backup_lineage_changed');document=parsePromptDocument({schemaVersion:'1.0.0',documentId:docs[0]!.documentId,revision:maximum+1,scope:'assistant',sections:(old?.sections??[]).map(s=>({...s,provenance:'manual'}))});validatePromptTransition(latest,{[PROMPT_DOCUMENT_KEY]:document},history);}
 const definition={corePersona:source.persona.corePersona,adaptivePersonaPolicy:source.persona.adaptivePersonaPolicy,...(document?{extensions:{[PROMPT_DOCUMENT_KEY]:document}}:{})};
 return {definition,sourceClaim:source.source,restoredComponents:[...PERSONA_RESTORE_COMPONENTS],authoredEffect:old?'replace':document?'clear':'none',documentId:document?.documentId??null,documentRevision:document?.revision??null};
}
