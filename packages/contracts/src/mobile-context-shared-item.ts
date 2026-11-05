import {types} from 'node:util';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createContractValidator,type ValidationResult} from './validator.ts';
import {unifiedDesktopSnapshot,contractFailure,contractSuccess} from './unified-desktop-contracts.ts';
import {validateMobileLocation} from './mobile-context-location.ts';
import {mobileSharedItemPin} from './mobile-context-shared-item.pin.ts';
import type {SharedItem,SharedItemIntegrity} from './mobile-context-shared-item.types.ts';
export type * from './mobile-context-shared-item.types.ts';
export {mobileSharedItemPin};
export const sharedItemLimits=Object.freeze({bytes:65536,attachmentBytes:16777216});
if(createHash('sha256').update(readFileSync(new URL('./schemas/mobile-context-shared-item.schema.json',import.meta.url))).digest('hex')!==mobileSharedItemPin.digest)throw Error('shared_item_producer_pin_mismatch');
const validator=createContractValidator();
type Kind='SharedItem'|'SharedItemIntegrity';
// Inspect descriptors before copying. Proxies/accessors never execute at this boundary.
function snapshot(input:unknown,maxBytes:number=sharedItemLimits.bytes):unknown|undefined {
 let nodes=0;const seen=new Set<object>();
 function safe(v:unknown,depth:number):boolean {
  if(++nodes>65536||depth>32)return false;
  if(typeof v==='string')return wellFormed(v);
  if(v===null||typeof v!=='object')return true;
  if(types.isProxy(v)||seen.has(v))return false;
  seen.add(v);
  for(const [key,d] of Object.entries(Object.getOwnPropertyDescriptors(v))){
   if(!wellFormed(key)||!('value'in d)||!safe(d.value,depth+1))return false;
  }
  seen.delete(v);return true;
 }
 try{return safe(input,0)?unifiedDesktopSnapshot(input,maxBytes):undefined;}catch{return undefined;}
}
function wellFormed(v:string):boolean {
 for(let i=0;i<v.length;i++){const c=v.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const next=v.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}return true;
}

const instant=(v:string)=>validateMobileLocation('LocationAgeContext',{referenceAt:v,maximumAgeMs:0}).valid;
const mime=/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
function declaredUrl(value:string):boolean {
 if(/[\\\x00-\x20\x7f]/u.test(value)||/%(?![0-9a-f]{2})/iu.test(value))return false;
 try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!!url.hostname&&!url.username&&!url.password;}catch{return false;}
}
export function admitSharedItemConsumer(input:unknown):boolean {
 const p=snapshot(input,4096) as Record<string,unknown>|undefined;
 return !!p&&Object.keys(p).sort().join(',')==='digest,schemaId,schemaVersion'&&p.schemaId===mobileSharedItemPin.schemaId&&p.schemaVersion===mobileSharedItemPin.schemaVersion&&p.digest===mobileSharedItemPin.digest;
}
export function validateSharedItem(kind:Kind,input:unknown):ValidationResult {
 const value=snapshot(input);
 if(value===undefined)return contractFailure('bounds','Bounded well-formed JSON required.');
 if(!['SharedItem','SharedItemIntegrity'].includes(kind))return contractFailure('schema','Unknown shared selection record.');
 const result=validator.validate(mobileSharedItemPin.schemaId+'#/$defs/'+kind,value);if(!result.valid)return result;
 if(kind==='SharedItem'){
  const v=value as SharedItem;
  if(!instant(v.sharedAt)||!instant(v.collectedAt))return contractFailure('instant','Exact source-declared Gregorian UTC required.');
  if(v.originUrl!==null&&!declaredUrl(v.originUrl))return contractFailure('url','Declared HTTP(S) URL required; no access authority.');
  const c=v.content;
  if(c.kind==='url'&&!declaredUrl(c.url))return contractFailure('url','Declared HTTP(S) URL required; no access authority.');
  if(c.kind==='attachmentReference'){
   const a=c.artifact;
   if(!Number.isSafeInteger(a.byteLength)||a.byteLength>sharedItemLimits.attachmentBytes||!mime.test(a.mediaType))return contractFailure('attachment','Bounded reported attachment metadata required.');
   if(c.contentKind==='image'&&!a.mediaType.toLowerCase().startsWith('image/'))return contractFailure('attachment','Reported image MIME required; not pixel verification.');
  }
 }
 if(kind==='SharedItemIntegrity'&&!Number.isSafeInteger((value as SharedItemIntegrity).byteLength))return contractFailure('integrity','Bounded byte count required.');
 return contractSuccess();
}
export function sharedItemSnapshot<T extends SharedItem|SharedItemIntegrity>(kind:Kind,input:unknown):T|null {
 const v=snapshot(input);return validateSharedItem(kind,v).valid?v as T:null;
}
const apply=Reflect.apply,typedPrototype=Object.getPrototypeOf(Uint8Array.prototype);
const bufferGetter=Object.getOwnPropertyDescriptor(typedPrototype,'buffer')!.get!;
const lengthGetter=Object.getOwnPropertyDescriptor(typedPrototype,'byteLength')!.get!;
const offsetGetter=Object.getOwnPropertyDescriptor(typedPrototype,'byteOffset')!.get!;
const copySet=Uint8Array.prototype.set,validateView=Uint8Array.prototype.at;
/** Compare an actual supplied in-memory byte snapshot. No dereferencing, copying
 * files, protection, ownership, enrollment, durable save or receipt authority. */
export function verifySharedItemBytes(input:unknown,bytes:unknown):SharedItemIntegrity|null {
 const item=sharedItemSnapshot<SharedItem>('SharedItem',input);
 if(!item||item.content.kind!=='attachmentReference'||types.isProxy(bytes)||!types.isUint8Array(bytes))return null;
 try{
  // Validate the ORIGINAL view, including resizable-buffer OOB state. Getter
  // length zero alone cannot distinguish an invalid view from an empty file.
  apply(validateView,bytes,[0]);
  const buffer=apply(bufferGetter,bytes,[]) as ArrayBuffer;
  if(types.isSharedArrayBuffer(buffer))return null;
  const length=apply(lengthGetter,bytes,[]) as number,offset=apply(offsetGetter,bytes,[]) as number;
  if(length>sharedItemLimits.attachmentBytes||length!==item.content.artifact.byteLength)return null;
  // Creating the view rejects detached buffers. Intrinsic access avoids source
  // getters/iterators, while a separate copy fixes the bytes actually hashed.
  const view=new Uint8Array(buffer,offset,length),copy=new Uint8Array(length);
  apply(copySet,copy,[view]);
  const sha256=createHash('sha256').update(copy).digest('hex');
  if(sha256!==item.content.artifact.sha256)return null;
  return {qualification:'integrityOnly',sha256,byteLength:length};
 }catch{return null;}
}
