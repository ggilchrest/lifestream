import type {AssistantProfile} from '@lifestream/storage-sqlite';
import {unifiedDesktopSnapshot} from '@lifestream/contracts/unified-desktop-contracts';
import {PROMPT_DOCUMENT_KEY,promptDocument,parsePromptDocument,validatePromptTransition} from './prompt-document.ts';

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fields=new Set(['schemaVersion','assistantId','profileId','revision','status','createdAt','createdBy','rollbackOf','displayName','corePersona','adaptivePersonaPolicy','voiceProfile','embodimentProfile','presentationProfile','providerProfile','extensions']);
export const PERSONA_RESTORE_COMPONENTS=['corePersona','adaptivePersonaPolicy',`extensions.${PROMPT_DOCUMENT_KEY}`] as const;
export function completeHistoricalPersona(value:unknown){
 const names=['canonicalName','identityStatement'],lists=['values','prohibitions','relationshipBoundaries','styleBoundaries'];
 if(!object(value)||Object.keys(value).some(key=>![...names,...lists].includes(key)))throw Error('persona_restore_source_incomplete');
 for(const key of names){const text=value[key];if(typeof text!=='string'||!text.trim()||text.length>(key==='canonicalName'?120:4000))throw Error('persona_restore_source_incomplete');}
 for(const key of lists){const items=value[key];if(!Array.isArray(items)||!items.length||items.some(item=>typeof item!=='string'||!item.trim()||item.length>1000))throw Error('persona_restore_source_incomplete');}
}

/** Original stored values only. This projection is also checked as the source;
 * rebasing a document must never erase its original suppression dependency. */
export function historicalPersonaPayload(profile:AssistantProfile){
 if(!object(profile.corePersona)||!object(profile.adaptivePersonaPolicy))throw Error('persona_restore_source_invalid');
 const document=promptDocument(profile);
 return structuredClone({corePersona:profile.corePersona,adaptivePersonaPolicy:profile.adaptivePersonaPolicy,...(document?{document}:{})});
}

/** Pure component selection. Authentication, suppression, repository currency,
 * Save and activation remain with the existing owners. */
export function prepareHistoricalPersonaRestore(latest:AssistantProfile,source:AssistantProfile,history:AssistantProfile[]){
 const copied=unifiedDesktopSnapshot({latest,source,history},2*1024*1024) as {latest:AssistantProfile;source:AssistantProfile;history:AssistantProfile[]}|undefined;
 if(!copied)throw Error('persona_restore_bound');
 ({latest,source,history}=copied);
 if(source.assistantId!==latest.assistantId||source.status!=='superseded'||source.revision>=latest.revision||!['active','draft'].includes(latest.status)||!Number.isSafeInteger(latest.revision)||latest.revision>=Number.MAX_SAFE_INTEGER||history.some(p=>p.assistantId!==latest.assistantId)||!history.some(p=>JSON.stringify(p)===JSON.stringify(source))||JSON.stringify(history.at(-1))!==JSON.stringify(latest))throw Error('persona_restore_source_invalid');
 if(Object.keys(latest).some(key=>!fields.has(key))||!['adaptivePersonaPolicy','voiceProfile','embodimentProfile','presentationProfile','providerProfile'].every(key=>Object.hasOwn(latest,key))||latest.extensions!==undefined&&!object(latest.extensions))throw Error('persona_restore_preservation_unsupported');
 // Ordinary edit validation intentionally permits omitted fields. Restoration
 // replaces the entire object, so every supported authored field must exist.
 completeHistoricalPersona(source.corePersona);
 const original=historicalPersonaPayload(source),retained=history.map(p=>promptDocument(p)).filter(p=>!!p),current=promptDocument(latest);
 const ids=new Set(retained.map(d=>d.documentId));
 if(ids.size>1)throw Error('persona_restore_lineage_ambiguous');
 const lineage=current??retained.at(-1),old=original.document;
 let document:ReturnType<typeof parsePromptDocument>|undefined;
 if(lineage){
  const maximum=Math.max(...retained.map(d=>d.revision));
  if(!Number.isSafeInteger(maximum)||maximum>=Number.MAX_SAFE_INTEGER)throw Error('persona_restore_lineage_bound');
  const sections=(old?.sections??[]).map(section=>{
   const prior=current?.sections.find(s=>s.sectionId===section.sectionId);
   if(retained.some(d=>d.sections.some(s=>s.sectionId===section.sectionId&&s.kind!==section.kind)))throw Error('persona_restore_section_kind_changed');
   return {...section,provenance:prior&&prior.text===section.text&&prior.provenance===section.provenance?section.provenance:'manual' as const};
  });
  document=parsePromptDocument({schemaVersion:'1.0.0',documentId:lineage.documentId,revision:maximum+1,scope:'assistant',sections});
  validatePromptTransition(latest,{[PROMPT_DOCUMENT_KEY]:document},history);
 }
 const definition={corePersona:original.corePersona,adaptivePersonaPolicy:original.adaptivePersonaPolicy,...(document?{extensions:{[PROMPT_DOCUMENT_KEY]:document}}:{})};
 return {definition,original,restoredComponents:[...PERSONA_RESTORE_COMPONENTS],sourceProfileId:source.profileId,sourceRevision:source.revision,documentId:document?.documentId??null,documentRevision:document?.revision??null};
}
