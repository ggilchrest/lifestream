import {unifiedDesktopSnapshot} from '@lifestream/contracts/unified-desktop-contracts';
import {checkContinuity,continuityDigest,CONTINUITY_LIMITS} from './continuity-adapter.ts';
import {parsePromptDocument,PROMPT_DOCUMENT_KEY,type PromptDocument} from './prompt-document.ts';

export type ContinuityDraftSelection={path:string;sectionId:string;kind:'identityAddition'|'personality'};
export type ContinuityDraftDocument={documentId:string;revision:number;current?:PromptDocument};
const digest=(value:unknown)=>continuityDigest(Buffer.from(JSON.stringify(value)));
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** Pure preparation, never authority to import or save. The existing owner must
 * bind preview to authenticated target, selected source permissions, current
 * profile/history/recovery epoch and revision CAS, then recheck at fulfilment.
 * Raw source bytes remain in the checked bundle; this result grants no use.
 */
export function prepareContinuityDraftSelection(rawBundle:unknown,rawSelection:readonly ContinuityDraftSelection[],rawDocument:ContinuityDraftDocument){
 const snapshot=unifiedDesktopSnapshot(rawBundle,Math.ceil(CONTINUITY_LIMITS.totalBytes*4/3)+256*1024);
 if(snapshot===undefined)throw Error('continuity_selected_bundle_invalid');
 const bundle=checkContinuity(snapshot),selection=unifiedDesktopSnapshot(rawSelection,16*1024),host=unifiedDesktopSnapshot(rawDocument,40*1024);
 if(!Array.isArray(selection)||selection.length<1||selection.length>16||!object(host)||Object.keys(host).some(key=>!['documentId','revision','current'].includes(key)))throw Error('continuity_explicit_selection_required');
 const current=host.current===undefined?undefined:parsePromptDocument(host.current);
 if(!current&&host.revision!==1||current&&(host.documentId!==current.documentId||!Number.isSafeInteger(host.revision)||Number(host.revision)<=current.revision))throw Error('continuity_document_lineage_changed');
 const sections=current?structuredClone(current.sections):[],paths=new Set<string>(),ids=new Set<string>();
 const selected:{path:string;sectionId:string;kind:ContinuityDraftSelection['kind'];sha256:string;byteLength:number}[]=[];
 for(const entry of selection){
  if(!object(entry)||Object.keys(entry).sort().join(',')!=='kind,path,sectionId'||typeof entry.path!=='string'||typeof entry.sectionId!=='string'||!['identityAddition','personality'].includes(String(entry.kind))||paths.has(entry.path)||ids.has(entry.sectionId))throw Error('continuity_selected_section_invalid');
  const file=bundle.files.find(file=>file.path===entry.path);
  if(!file||file.classification!=='authoredPersona'||file.mediaType!=='text/plain')throw Error('continuity_selected_format_unsupported');
  // ignoreBOM=true retains an authored U+FEFF rather than stripping it.
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(file.bytesBase64,'base64'));}catch{throw Error('continuity_selected_text_encoding_invalid');}
  const kind=entry.kind as ContinuityDraftSelection['kind'],old=sections.find(section=>section.sectionId===entry.sectionId);
  if(old&&old.kind!==kind)throw Error('continuity_selected_section_kind_changed');
  const section={sectionId:entry.sectionId,kind,provenance:old&&old.text===text?old.provenance:'manual' as const,text};
  if(old)sections[sections.indexOf(old)]=section;else sections.push(section);
  selected.push({path:file.path,sectionId:entry.sectionId,kind,sha256:file.sha256,byteLength:file.byteLength});paths.add(entry.path);ids.add(entry.sectionId);
 }
 const document=parsePromptDocument({schemaVersion:'1.0.0',documentId:host.documentId,revision:host.revision,scope:'assistant',sections});
 const sourceDigest=digest(bundle),selectionDigest=digest(selected),draftDigest=digest(document);
 return {sourceDigest,selectionDigest,draftDigest,extensions:{[PROMPT_DOCUMENT_KEY]:document},selected,
  unselected:bundle.files.filter(file=>!paths.has(file.path)).map(file=>({path:file.path,classification:file.classification,sha256:file.sha256,byteLength:file.byteLength,reason:'notImported' as const})),
  coverage:'partial' as const,executionGrants:'notImported' as const,
  limitations:[...bundle.coverage.limitations,'Only explicitly selected authored text is prepared; every other source remains unimported.','This pure result does not establish source permission, wording approval, complete history, persistence, activation, memory restoration or runtime use.']};
}
