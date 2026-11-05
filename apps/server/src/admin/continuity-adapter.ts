import {createHash} from 'node:crypto';

export const CONTINUITY_LIMITS=Object.freeze({files:64,fileBytes:2*1024*1024,totalBytes:8*1024*1024,nodes:4096,conversations:128});
export type ContinuityClassification='authoredPersona'|'relationshipEvidence'|'rawConversation'|'calibration'|'heldOut'|'ownerSnapshot'|'reference';
export type ContinuityBinding={assistantId:string;userId:string;relationshipId:string;deploymentId:string};
export type ContinuityFile={path:string;mediaType:string;classification:ContinuityClassification;byteLength:number;sha256:string;bytesBase64:string};
export type ContinuityBundle={schemaVersion:'lifestream.continuity/1';binding:ContinuityBinding|null;provenance:{sourceRef:string;capturedAt:string;basis:'selectedOriginals'|'ownerView'};files:ContinuityFile[];coverage:{fullHistory:'notEstablished';originalsPreserved:true;executionGrants:'notImported';limitations:string[]}};
const classes=new Set<ContinuityClassification>(['authoredPersona','relationshipEvidence','rawConversation','calibration','heldOut','ownerSnapshot','reference']);
export const continuityDigest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:object,names:string[])=>Object.keys(v).sort().join(',')===[...names].sort().join(',');
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(v);
const path=(v:unknown):v is string=>typeof v==='string'&&v.length<=240&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(v)&&v.split('/').every(p=>p!==''&&p!=='.'&&p!=='..'&&p!=='.git')&&!v.endsWith('/');
const utc=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)).toISOString()===v;
function binding(v:unknown):v is ContinuityBinding{return object(v)&&keys(v,['assistantId','userId','relationshipId','deploymentId'])&&Object.values(v).every(identifier);}
/** Pure selected-byte interchange. No path dereference, extraction, provider,
 * grant import or adoption. Checksums establish byte identity, not authenticity. */
export function packContinuity(input:{binding:ContinuityBinding|null;sourceRef:string;capturedAt:string;basis:'selectedOriginals'|'ownerView';files:{path:string;mediaType:string;classification:ContinuityClassification;bytes:Uint8Array}[];limitations:string[]}):ContinuityBundle{
 const selected=input.files;if(!Array.isArray(selected)||selected.length<1||selected.length>CONTINUITY_LIMITS.files)throw Error('continuity_file_bound');
 let rawTotal=0;const names=new Set<string>();for(const f of selected){if(!f||!path(f.path)||names.has(f.path)||!(f.bytes instanceof Uint8Array)||!ArrayBuffer.isView(f.bytes)||f.bytes.byteLength>CONTINUITY_LIMITS.fileBytes)throw Error('continuity_file_invalid');rawTotal+=f.bytes.byteLength;if(rawTotal>CONTINUITY_LIMITS.totalBytes)throw Error('continuity_total_bound');names.add(f.path);}
 const bundle={schemaVersion:'lifestream.continuity/1',binding:input.binding,provenance:{sourceRef:input.sourceRef,capturedAt:input.capturedAt,basis:input.basis},files:selected.map(f=>{const bytes=Buffer.from(f.bytes);return{path:f.path,mediaType:f.mediaType,classification:f.classification,byteLength:bytes.byteLength,sha256:continuityDigest(bytes),bytesBase64:bytes.toString('base64')};}),coverage:{fullHistory:'notEstablished',originalsPreserved:true,executionGrants:'notImported',limitations:[...input.limitations]}};
 return checkContinuity(bundle);
}
export function checkContinuity(raw:unknown):ContinuityBundle{
 if(!object(raw)||!keys(raw,['schemaVersion','binding','provenance','files','coverage'])||raw.schemaVersion!=='lifestream.continuity/1'||raw.binding!==null&&!binding(raw.binding))throw Error('continuity_bundle_invalid');
 const p=raw.provenance,c=raw.coverage;if(!object(p)||!keys(p,['sourceRef','capturedAt','basis'])||!identifier(p.sourceRef)||!utc(p.capturedAt)||!['selectedOriginals','ownerView'].includes(String(p.basis))||!object(c)||!keys(c,['fullHistory','originalsPreserved','executionGrants','limitations'])||c.fullHistory!=='notEstablished'||c.originalsPreserved!==true||c.executionGrants!=='notImported'||!Array.isArray(c.limitations)||c.limitations.length>32||c.limitations.some(v=>typeof v!=='string'||v.length>1024))throw Error('continuity_provenance_invalid');
 if(!Array.isArray(raw.files)||raw.files.length<1||raw.files.length>CONTINUITY_LIMITS.files)throw Error('continuity_file_bound');let total=0;const paths=new Set<string>();
 for(const f of raw.files){
  if(!object(f)||!keys(f,['path','mediaType','classification','byteLength','sha256','bytesBase64'])||!path(f.path)||paths.has(f.path)||typeof f.mediaType!=='string'||f.mediaType.length>128||!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(f.mediaType)||!classes.has(f.classification as ContinuityClassification)||!Number.isSafeInteger(f.byteLength)||Number(f.byteLength)<0||Number(f.byteLength)>CONTINUITY_LIMITS.fileBytes||typeof f.bytesBase64!=='string'||f.bytesBase64.length>4*Math.ceil(CONTINUITY_LIMITS.fileBytes/3))throw Error('continuity_file_invalid');
  const b=Buffer.from(f.bytesBase64,'base64');if(b.toString('base64')!==f.bytesBase64||b.byteLength!==f.byteLength||continuityDigest(b)!==f.sha256)throw Error('continuity_integrity_failed');total+=b.byteLength;if(total>CONTINUITY_LIMITS.totalBytes)throw Error('continuity_total_bound');paths.add(f.path);
 }
 return structuredClone(raw) as unknown as ContinuityBundle;
}
export function continuityFile(bundle:ContinuityBundle,name:string):Buffer{const checked=checkContinuity(bundle),file=checked.files.find(f=>f.path===name);if(!file)throw Error('continuity_file_missing');return Buffer.from(file.bytesBase64,'base64');}
export type RepresentativeConversation={sourceFile:string;conversationId:string;currentNode:string|null;nodes:{id:string;parent:string|null;children:string[];role:string|null;createdAt:number|string|null;content:unknown}[]};
/** Representative export mapping, not a claim about an unseen account export.
 * All branches and role labels remain source data; never flatten system/tool
 * messages into live instructions or infer that current_node includes all edits. */
export function inspectRepresentativeExport(bytes:Uint8Array,sourceFile:string):{format:'representative-chat-mapping/1'|'unsupported';conversations:RepresentativeConversation[];warnings:string[];rawSha256:string}{
 if(bytes.byteLength>CONTINUITY_LIMITS.fileBytes||!path(sourceFile))throw Error('continuity_export_bound');const rawSha256=continuityDigest(bytes);let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return{format:'unsupported',conversations:[],warnings:['Input is not supported UTF-8 JSON; original bytes retained.'],rawSha256};}
 const rows=Array.isArray(raw)?raw:object(raw)&&Array.isArray(raw.conversations)?raw.conversations:undefined;
 if(!rows||rows.length>CONTINUITY_LIMITS.conversations)return{format:'unsupported',conversations:[],warnings:['Unknown export envelope or excessive conversations; no silent normalization.'],rawSha256};
 const conversations:RepresentativeConversation[]=[],warnings:string[]=[];let count=0;
 for(const row of rows){
  if(!object(row)||typeof row.id!=='string'||!object(row.mapping)){warnings.push('Unsupported conversation entry retained only in the original file.');continue;}
  const ids=Object.keys(row.mapping);count+=ids.length;if(count>CONTINUITY_LIMITS.nodes)throw Error('continuity_node_bound');const nodes:RepresentativeConversation['nodes']=[];
  for(const id of ids){const n=row.mapping[id];if(!object(n)||n.id!==id||n.parent!==null&&typeof n.parent!=='string'||!Array.isArray(n.children)||n.children.some(c=>typeof c!=='string'))throw Error('continuity_mapping_invalid');
   const m=n.message;if(m!==null&&!object(m))throw Error('continuity_message_invalid');const author=object(m)&&object(m.author)?m.author:undefined;
   nodes.push({id,parent:n.parent as string|null,children:[...n.children] as string[],role:author&&typeof author.role==='string'?author.role:null,createdAt:object(m)&&(typeof m.create_time==='number'||typeof m.create_time==='string')?m.create_time:null,content:object(m)?structuredClone(m.content):null});
  }
  const byId=new Map(nodes.map(n=>[n.id,n]));for(const n of nodes){if(n.parent!==null&&(!byId.has(n.parent)||!byId.get(n.parent)!.children.includes(n.id))||n.children.some(c=>!byId.has(c)||byId.get(c)!.parent!==n.id))throw Error('continuity_branch_reference_invalid');const seen=new Set<string>();let at:typeof n|undefined=n;while(at){if(seen.has(at.id))throw Error('continuity_branch_cycle');seen.add(at.id);at=at.parent===null?undefined:byId.get(at.parent);}}
  if(row.current_node!==null&&typeof row.current_node!=='string'||typeof row.current_node==='string'&&!byId.has(row.current_node))throw Error('continuity_current_node_invalid');
  conversations.push({sourceFile,conversationId:row.id,currentNode:row.current_node as string|null,nodes});
 }
 return{format:conversations.length?'representative-chat-mapping/1':'unsupported',conversations,warnings,rawSha256};
}

/** Checked adapter for the documented starter interchange. A source manifest's
 * coverage is reported as a claim, never promoted to inspected full history. */
export function adaptStarterContinuity(selected:ReadonlyMap<string,Uint8Array>,input:{sourceRef:string;capturedAt:string}):{bundle:ContinuityBundle;report:{format:'escape-hatch.bundle/0.1';missingFiles:string[];unrecognizedFiles:string[];sourceCoverageClaims:unknown;inspectedFiles:number}}{
 if(!(selected instanceof Map)||selected.size<1||selected.size>CONTINUITY_LIMITS.files)throw Error('continuity_file_bound');let selectedTotal=0;for(const [name,bytes]of selected){if(!path(name)||!(bytes instanceof Uint8Array)||!ArrayBuffer.isView(bytes)||bytes.byteLength>CONTINUITY_LIMITS.fileBytes)throw Error('continuity_file_invalid');selectedTotal+=bytes.byteLength;if(selectedTotal>CONTINUITY_LIMITS.totalBytes)throw Error('continuity_total_bound');}
 const manifestBytes=selected.get('manifest.json');if(!manifestBytes||manifestBytes.byteLength>CONTINUITY_LIMITS.fileBytes)throw Error('continuity_starter_manifest_missing');let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestBytes));}catch{throw Error('continuity_starter_manifest_invalid');}
 if(!object(raw)||raw.schema!=='escape-hatch.bundle/0.1'||!object(raw.identity_binding)||raw.identity_binding.assistant_id!==null||raw.identity_binding.relationship_id!==null||raw.identity_binding.user_id!==null||raw.identity_binding.requires_deliberate_target_selection!==true||!Array.isArray(raw.files)||raw.files.length>CONTINUITY_LIMITS.files-1)throw Error('continuity_starter_format_unsupported');
 const declared=new Map<string,{sha256:string;size:number}>(),missingFiles:string[]=[];
 for(const entry of raw.files){if(!object(entry)||!path(entry.path)||declared.has(entry.path)||typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(entry.sha256)||!Number.isSafeInteger(entry.size_bytes)||Number(entry.size_bytes)<0||Number(entry.size_bytes)>CONTINUITY_LIMITS.fileBytes)throw Error('continuity_starter_inventory_invalid');declared.set(entry.path,{sha256:entry.sha256,size:Number(entry.size_bytes)});const bytes=selected.get(entry.path);if(!bytes)missingFiles.push(entry.path);else if(bytes.byteLength!==entry.size_bytes||continuityDigest(bytes)!==entry.sha256)throw Error('continuity_starter_integrity_failed');}
 const unrecognizedFiles:string[]=[],files:Parameters<typeof packContinuity>[0]['files']=[];
 for(const [name,bytes]of selected){if(!path(name))throw Error('continuity_starter_path_invalid');if(name!=='manifest.json'&&name!=='CHECKSUMS.sha256'&&!declared.has(name))unrecognizedFiles.push(name);
  const classification:ContinuityClassification=name==='persona/core.txt'||name==='QUICKSTART-PROMPT.txt'?'authoredPersona':name.startsWith('evaluation/')?'heldOut':name.startsWith('examples/')?'calibration':name.startsWith('memory/')||name.startsWith('evidence/')||name==='persona/relationship.json'?'relationshipEvidence':'reference';
  files.push({path:name,mediaType:name.endsWith('.json')?'application/json':name.endsWith('.jsonl')?'application/x-ndjson':'text/plain',classification,bytes});
 }
 const bundle=packContinuity({binding:null,...input,basis:'selectedOriginals',files,limitations:['Starter manifest coverage statements are source claims, not runtime or full-history evidence.','No selected target, persona wording approval, execution grants, training consent, model/voice assets or restoration acceptance is inferred.',...(missingFiles.length?['Declared selected source files are missing; consult the coverage report.']:[]),...(unrecognizedFiles.length?['Unrecognized selected files preserved as reference bytes; no native parser compatibility claimed.']:[])]});
 return{bundle,report:{format:'escape-hatch.bundle/0.1',missingFiles,unrecognizedFiles,sourceCoverageClaims:structuredClone(raw.coverage??null),inspectedFiles:files.length}};
}
