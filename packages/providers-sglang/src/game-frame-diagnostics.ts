import {types} from 'node:util';

/** Closed metadata about a refused attempt, never an accepted usage receipt.
 * Keep this standalone contract shared by the archive and retained reader. */
export const gameFrameRefusalReasons = Object.freeze(['caller_cancelled','provider_busy','provider_unavailable','frame_bounds','input_validation','source_current','request_bounds','transport_unavailable','response_status','response_body','response_read','response_bounds','response_encoding','response_json','response_envelope','response_model','response_choices','response_usage','response_finish','response_message_role','response_content_type','response_content_bounds','response_tool_calls','response_function_call','response_refusal','response_reasoning_content','content_json','content_shape','observation_record','observation_appearance','observation_visible_text','observation_uncertainty','observation_limitations','source_changed','exception'] as const);
export const gameFrameFinishReasons = Object.freeze(['stop','length','content_filter','tool_calls','function_call','missing','other'] as const);
export const gameFrameInterpreterRefusalReasons = Object.freeze(['qualification','accounting_required','observation_validation','observation_expired','frame_read','frame_integrity','frame_dimensions','scheduler_not_published','decoder_output','output_provenance','native_field_collision','duplicate_fact','interpreted_schema','usage_settlement','exception','clock_changed','cancelled','deadline','configuration_changed','accounting_changed','source_current','runtime_current','observation_current','decoder_current'] as const);
export const gameFrameSchedulerStates = Object.freeze(['published','suppressed','cancelled','failed','unavailable'] as const);
export type GameFrameRefusal = Readonly<{reason:typeof gameFrameRefusalReasons[number];httpStatus?:number;finishReason?:typeof gameFrameFinishReasons[number];inputTokens?:number;outputTokens?:number;requestSha256?:string;responseSha256?:string}>;
export type GameFrameInterpreterRefusal = Readonly<{reason:typeof gameFrameInterpreterRefusalReasons[number];schedulerState?:typeof gameFrameSchedulerStates[number]}>;
export type GameFrameVisionWitness = Readonly<{observationId:string;screenshotSha256:string}> & (Readonly<{kind:'provider'}>&GameFrameRefusal | Readonly<{kind:'interpreter'}>&GameFrameInterpreterRefusal);
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=(v:unknown,min:number,max:number)=>Number.isSafeInteger(v)&&typeof v==='number'&&v>=min&&v<=max;
const member=(v:unknown,values:readonly string[])=>typeof v==='string'&&values.includes(v);
/** No getters, proxies, inherited fields, custom prototypes or open strings. */
export function isGameFrameVisionWitness(value:unknown):value is GameFrameVisionWitness {
 try{
  if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value))return false;
  const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null)return false;
  const descriptors=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(descriptors);
  if(names.some(key=>typeof key!=='string'||!descriptors[key]?.enumerable||!Object.hasOwn(descriptors[key]!,'value')))return false;
  const v=Object.create(null) as Record<string,unknown>;for(const key of names as string[])v[key]=descriptors[key]!.value;
  if(!['kind','reason','observationId','screenshotSha256'].every(key=>Object.hasOwn(v,key))||typeof v.observationId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v.observationId)||!hash(v.screenshotSha256))return false;
  const provider=['kind','reason','observationId','screenshotSha256','httpStatus','finishReason','inputTokens','outputTokens','requestSha256','responseSha256'],interpreter=['kind','reason','observationId','screenshotSha256','schedulerState'];
  if(v.kind==='provider')return names.every(key=>provider.includes(key as string))&&member(v.reason,gameFrameRefusalReasons)&&
   (!Object.hasOwn(v,'httpStatus')||integer(v.httpStatus,100,599))&&(!Object.hasOwn(v,'finishReason')||member(v.finishReason,gameFrameFinishReasons))&&
   (!Object.hasOwn(v,'inputTokens')||integer(v.inputTokens,0,1000000000))&&(!Object.hasOwn(v,'outputTokens')||integer(v.outputTokens,0,1000000000))&&
   (!Object.hasOwn(v,'requestSha256')||hash(v.requestSha256))&&(!Object.hasOwn(v,'responseSha256')||hash(v.responseSha256));
  return v.kind==='interpreter'&&names.every(key=>interpreter.includes(key as string))&&member(v.reason,gameFrameInterpreterRefusalReasons)&&
   (!Object.hasOwn(v,'schedulerState')||v.reason==='scheduler_not_published'&&member(v.schedulerState,gameFrameSchedulerStates));
 }catch{return false;}
}
