import {types} from 'node:util';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createContractValidator,type ValidationResult} from './validator.ts';
import {contractFailure,contractSuccess} from './unified-desktop-contracts.ts';
import {validateMobileLocation,mobileLocationPin} from './mobile-context-location.ts';
import {mobileLocationDeliveryPin} from './mobile-context-location-delivery.pin.ts';
import type {LocationDeliveryBinding,LocationDeliveryItem,LocationDeliveryReceipt} from './mobile-context-location-delivery.types.ts';
export type * from './mobile-context-location-delivery.types.ts';
export {mobileLocationDeliveryPin};
export const locationDeliveryLimits=Object.freeze({rawBytes:65536,wireBytes:262144,batchItems:64,depth:32});
export const locationDeliveryDomains=Object.freeze({request:'lifestream/mobile-context-location-delivery-request/1\n',receipt:'lifestream/mobile-context-location-delivery-receipt/1\n'});
export type LocationDeliveryKind='LocationDeliveryBinding'|'LocationDeliveryItem'|'LocationDeliveryBatch'|'LocationDeliveryReceipt'|'LocationEnrollmentDescriptor'|'LocationPolicyDescriptor';
const kinds=new Set<LocationDeliveryKind>(['LocationDeliveryBinding','LocationDeliveryItem','LocationDeliveryBatch','LocationDeliveryReceipt','LocationEnrollmentDescriptor','LocationPolicyDescriptor']);
if(createHash('sha256').update(readFileSync(new URL('./schemas/mobile-context-location-delivery.schema.json',import.meta.url))).digest('hex')!==mobileLocationDeliveryPin.digest)throw Error('location_delivery_pin_mismatch');
const validator=createContractValidator(),sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const typedArrayPrototype=Object.getPrototypeOf(Uint8Array.prototype),byteLengthGetter=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteLength')!.get!,byteOffsetGetter=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteOffset')!.get!,bufferGetter=Object.getOwnPropertyDescriptor(typedArrayPrototype,'buffer')!.get!;
const bindingFields=['humanId','endpointId','enrollmentId','enrollmentRevision','collector','sourceNamespace','sourceEpoch','policyRevision','policyBindingDigest','policyRef','classificationRuleRef','retentionPolicyRef','useScopeRef'] as const;
const scalarFields=['sourceEpoch','policyRef','classificationRuleRef','retentionPolicyRef','useScopeRef'] as const;
function unicode(text:string){for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const low=text.charCodeAt(++i);if(!(low>=0xdc00&&low<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}return true;}
/** Bounded own producer representation ONLY. This cannot measure original ingress.
 * Build JSON from inspected data descriptors; never invoke toJSON/getters/proxies. */
function objectText(input:unknown,maximum:number):string|undefined{
 const chunks:string[]=[],seen=new Set<object>();let used=0,nodes=0;
 const append=(text:string)=>{used+=Buffer.byteLength(text);if(used>maximum)throw Error();chunks.push(text);};
 const string=(text:string)=>{if(text.length>maximum||!unicode(text))throw Error();let bytes=2;for(const c of text){const n=c.codePointAt(0)!;bytes+=n===34||n===92||[8,9,10,12,13].includes(n)?2:n<32?6:Buffer.byteLength(c);if(used+bytes>maximum)throw Error();}append(JSON.stringify(text));};
 const walk=(value:unknown,depth:number)=>{
  if(++nodes>65536)throw Error();if(value===null){append('null');return;}if(typeof value==='string'){string(value);return;}if(typeof value==='boolean'){append(String(value));return;}if(typeof value==='number'&&Number.isFinite(value)){append(JSON.stringify(value));return;}
  if(typeof value!=='object'||types.isProxy(value)||seen.has(value)||depth>=locationDeliveryLimits.depth)throw Error();
  const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)throw Error();
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);if(keys.some(key=>typeof key!=='string')||Object.values(descriptors).some(d=>!('value' in d)))throw Error();seen.add(value);
  if(array){const length=descriptors.length?.value;if(!Number.isSafeInteger(length)||length<0||length>65536||keys.length!==length+1)throw Error();append('[');for(let i=0;i<length;i++){const d=descriptors[String(i)];if(!d?.enumerable)throw Error();if(i)append(',');walk(d.value,depth+1);}append(']');}
  else{append('{');let i=0;for(const key of keys as string[]){const d=descriptors[key]!;if(!d.enumerable)throw Error();if(i++)append(',');string(key);append(':');walk(d.value,depth+1);}append('}');}seen.delete(value);
 };
 try{walk(input,0);return chunks.join('');}catch{return undefined;}
}
/** Exact mathematical JSON-number value for wire metadata, before Number rounding.
 * Decimal/exponent spelling may represent an integer; only its exact value may
 * enter framing. Bound exponent work by the maximum document length. */
function exactRevision(token:string):boolean{
 const match=/^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?)([0-9]+))?$/.exec(token);if(!match)return false;
 const fraction=match[2]??'',digits=(match[1]!+fraction).replace(/^0+/,'');if(!digits)return false;
 const exponentDigits=(match[4]??'0').replace(/^0+/,'');if(exponentDigits.length>6)return false;
 const exponent=(match[3]==='-'?-1:1)*Number(exponentDigits||'0'),shift=exponent-fraction.length;
 let integer:string;
 if(shift>=0){if(digits.length+shift>16)return false;integer=digits+'0'.repeat(shift);}
 else{const cut=digits.length+shift;if(cut<1||cut>16)return false;for(let i=cut;i<digits.length;i++)if(digits.charCodeAt(i)!==48)return false;integer=digits.slice(0,cut);}
 return integer.length<16||integer<='9007199254740991';
}
/** Strict lexical JSON scan. Root container depth=1; decoded keys compare exact
 * scalar sequences, without Unicode normalization. JSON.parse runs only afterward. */
function strictJson(bytes:Uint8Array,maximum:number,metadataIntegers=false):unknown{
 if(!types.isUint8Array(bytes)||types.isProxy(bytes))throw Error('bounds');
 const length=byteLengthGetter.call(bytes) as number,buffer=bufferGetter.call(bytes) as ArrayBuffer,offset=byteOffsetGetter.call(bytes) as number;
 if(length<1||length>maximum||types.isSharedArrayBuffer(buffer)||!([Uint8Array.prototype,Buffer.prototype] as unknown[]).includes(Object.getPrototypeOf(bytes))||['buffer','byteLength','byteOffset','length'].some(key=>Object.hasOwn(bytes,key)))throw Error('bounds');
 const original=Buffer.from(new Uint8Array(buffer,offset,length));if(original[0]===0xef&&original[1]===0xbb&&original[2]===0xbf)throw Error('bom');
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(original);let at=0,nodes=0;
 const space=()=>{while(at<text.length&&[9,10,13,32].includes(text.charCodeAt(at)))at++;};
 const string=()=>{const start=at;if(text[at++]!=='"')throw Error('json');while(at<text.length){const c=text[at++];if(c==='"'){const decoded=JSON.parse(text.slice(start,at)) as string;if(!unicode(decoded))throw Error('surrogate');return decoded;}if(c==='\\'){const escaped=text[at++];if(escaped==='u'){if(!/^[0-9a-fA-F]{4}$/.test(text.slice(at,at+4)))throw Error('json');at+=4;}else if(!escaped||!'"\\/bfnrt'.includes(escaped))throw Error('json');}else if(c!.charCodeAt(0)<32)throw Error('json');}throw Error('json');};
 const number=/-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
 const value=(depth:number):void=>{
  if(++nodes>65536)throw Error('nodes');space();const c=text[at];
  if(c==='{'||c==='['){if(depth>=locationDeliveryLimits.depth)throw Error('depth');at++;space();const end=c==='{'?'}':']';if(text[at]===end){at++;return;}const keys=new Set<string>();for(;;){if(c==='{'){const key=string();if(keys.has(key))throw Error('duplicate');keys.add(key);space();if(text[at++]!==':')throw Error('json');}value(depth+1);space();if(text[at]===end){at++;return;}if(text[at++]!==',')throw Error('json');space();}}
  if(c==='"'){string();return;}for(const literal of ['null','true','false'])if(text.startsWith(literal,at)){at+=literal.length;return;}number.lastIndex=at;const match=number.exec(text);if(!match)throw Error('json');if(metadataIntegers&&!exactRevision(match[0]))throw Error('revision');at=number.lastIndex;
 };
 value(0);space();if(at!==text.length)throw Error('json');return JSON.parse(text);
}
function frame(domain:string,fields:readonly string[]):Buffer{const parts=[Buffer.from(domain,'utf8')];for(const field of fields){const bytes=Buffer.from(field,'utf8'),length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);parts.push(length,bytes);}return Buffer.concat(parts);}
function requestParts(value:{binding:LocationDeliveryBinding;eventId:string;attemptId:string;observationSha256:string}){return [mobileLocationPin.digest,...bindingFields.map(key=>String(value.binding[key])),value.eventId,value.attemptId,value.observationSha256];}
function requestHash(value:Parameters<typeof requestParts>[0]){return sha(frame(locationDeliveryDomains.request,requestParts(value)));}
function receiptHash(value:LocationDeliveryReceipt){return sha(frame(locationDeliveryDomains.receipt,[value.requestDigest,value.outcome,value.code,value.durability??'']));}
function binding(value:LocationDeliveryBinding){return scalarFields.every(key=>typeof value[key]==='string'&&unicode(value[key])&&Buffer.byteLength(value[key])>=1&&Buffer.byteLength(value[key])<=256);}
function raw(value:LocationDeliveryItem){
 if(value.observationUtf8Base64.length>4*Math.ceil(locationDeliveryLimits.rawBytes/3))return false;
 const bytes=Buffer.from(value.observationUtf8Base64,'base64');if(bytes.length<1||bytes.length>locationDeliveryLimits.rawBytes||bytes.toString('base64')!==value.observationUtf8Base64||sha(bytes)!==value.observationSha256)return false;
 const observation=strictJson(bytes,locationDeliveryLimits.rawBytes) as {source?:{collector?:unknown;namespace?:unknown}};
 return validateMobileLocation('LocationObservation',observation).valid&&observation.source?.collector===value.binding.collector&&observation.source.namespace===value.binding.sourceNamespace;
}
function shape(kind:LocationDeliveryKind,value:any){
 if(!kinds.has(kind)||!validator.validate(mobileLocationDeliveryPin.schemaId+'#/$defs/'+kind,value).valid)return false;
 if(kind==='LocationDeliveryBinding')return binding(value);
 if(kind==='LocationDeliveryItem')return binding(value.binding)&&raw(value);
 if(kind==='LocationDeliveryReceipt')return binding(value.binding)&&value.requestDigest===requestHash(value)&&(value.outcome==='accepted'?value.code==='stored'&&value.durability==='sqlCommit':value.outcome==='duplicate'?value.code==='sameOriginal'&&value.durability==='sqlCommit':value.outcome==='unknown'?value.code==='unavailable'&&value.durability===null:!['stored','sameOriginal'].includes(value.code)&&value.durability===null);
 if(kind==='LocationPolicyDescriptor')return binding(value.binding);
 if(kind==='LocationEnrollmentDescriptor')return (value.state==='unbound')===(value.sourceNamespace===null);
 return true;
}
function valid(kind:LocationDeliveryKind,value:any):boolean{
 if(!shape(kind,value))return false;
 if(kind==='LocationDeliveryItem')return value.requestDigest===requestHash(value);
 if(kind==='LocationDeliveryReceipt')return value.receiptDigest===receiptHash(value);
 if(kind==='LocationDeliveryBatch'){
  const identities=new Set<string>();for(const item of value.items as LocationDeliveryItem[]){if(!valid('LocationDeliveryItem',item))return false;const b=item.binding,key=JSON.stringify([b.humanId,b.endpointId,b.enrollmentId,b.collector,b.sourceNamespace,item.eventId,item.attemptId]);if(identities.has(key))return false;identities.add(key);}return true;
 }
 return true;
}
export function admitMobileLocationDeliveryConsumer(input:unknown){try{const text=objectText(input,4096);if(!text)return false;const v=JSON.parse(text);return Object.keys(v).sort().join(',')==='digest,schemaId,schemaVersion'&&v.schemaId===mobileLocationDeliveryPin.schemaId&&v.schemaVersion===mobileLocationDeliveryPin.schemaVersion&&v.digest===mobileLocationDeliveryPin.digest;}catch{return false;}}
/** Local object budget, not original transport-byte qualification. */
export function mobileLocationDeliverySnapshot<T=unknown>(kind:LocationDeliveryKind,input:unknown):T|undefined{try{const text=objectText(input,locationDeliveryLimits.wireBytes);if(!text)return undefined;const value=JSON.parse(text);return valid(kind,value)?value:undefined;}catch{return undefined;}}
/** Actual complete UTF8 document cap before parsing or Base64 decode. Outer HTTP
 * framing needs its own complete-body cap in the future existing host. */
export function mobileLocationDeliveryBytesSnapshot<T=unknown>(kind:LocationDeliveryKind,bytes:Uint8Array):T|undefined{try{const value=strictJson(bytes,locationDeliveryLimits.wireBytes,true);return valid(kind,value)?value as T:undefined;}catch{return undefined;}}
export function validateMobileLocationDelivery(kind:LocationDeliveryKind,input:unknown):ValidationResult{return mobileLocationDeliverySnapshot(kind,input)===undefined?contractFailure('location_delivery','Bounded strict Location delivery data required; this is not authority.'):contractSuccess();}
/** Producer-owned serialized output; size says nothing about another wire input. */
export function encodeMobileLocationDelivery(kind:LocationDeliveryKind,input:unknown):Uint8Array|undefined{try{const text=objectText(input,locationDeliveryLimits.wireBytes);if(!text||!valid(kind,JSON.parse(text)))return undefined;return Buffer.from(text,'utf8');}catch{return undefined;}}
/** Compute data digest excluding its own requestDigest field. No authority. */
export function locationDeliveryRequestDigest(input:unknown):string|undefined{try{const text=objectText(input,locationDeliveryLimits.wireBytes);if(!text)return undefined;const value=JSON.parse(text);return shape('LocationDeliveryItem',value)?requestHash(value):undefined;}catch{return undefined;}}
/** Compute receipt integrity excluding receiptDigest; sqlCommit is a report. */
export function locationDeliveryReceiptDigest(input:unknown):string|undefined{try{const text=objectText(input,locationDeliveryLimits.wireBytes);if(!text)return undefined;const value=JSON.parse(text);return shape('LocationDeliveryReceipt',value)?receiptHash(value):undefined;}catch{return undefined;}}
/** Pure data matching ONLY. No acknowledgement, issuer, SQL or currentness proof. */
export function matchLocationDeliveryReceipt(item:unknown,receipt:unknown):'mismatch'|'matchingAcceptedData'|'matchingDuplicateData'|'matchingRejectedData'|'matchingUnknownData'{
 const original=mobileLocationDeliverySnapshot<LocationDeliveryItem>('LocationDeliveryItem',item),result=mobileLocationDeliverySnapshot<LocationDeliveryReceipt>('LocationDeliveryReceipt',receipt);if(!original||!result||!bindingFields.every(key=>original.binding[key]===result.binding[key])||original.eventId!==result.eventId||original.attemptId!==result.attemptId||original.observationSha256!==result.observationSha256||original.requestDigest!==result.requestDigest)return 'mismatch';
 return result.outcome==='accepted'?'matchingAcceptedData':result.outcome==='duplicate'?'matchingDuplicateData':result.outcome==='rejected'?'matchingRejectedData':'matchingUnknownData';
}
/** Lexical-only byte parser for conformance tests/native producer preparation.
 * Wire mode additionally rejects inexact/nonpositive revision numbers; observation
 * mode retains raw float semantics. Parsed JSON is NOT contract admission or authority. */
export function strictLocationDeliveryJson(bytes:Uint8Array,bound:'wire'|'observation'='wire'):unknown|undefined{try{if(bound!=='wire'&&bound!=='observation')return undefined;return strictJson(bytes,bound==='wire'?locationDeliveryLimits.wireBytes:locationDeliveryLimits.rawBytes,bound==='wire');}catch{return undefined;}}
