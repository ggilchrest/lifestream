import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {inspectGamePng} from './frame-custody.ts';
import type {ActivityScope,GameObservation,PlayerVisibleStateValue} from '@lifestream/contracts/game-activity';

export type ReviewedFrameManifest={revision:string;entries:ReadonlyArray<{sha256:string;width:number;height:number;fields:ReadonlyArray<{fieldId:string;value:string|number|boolean}>}>};
/** Exact reviewed player-visible images only. An unknown image produces no
 * fields. This decoder has no RAM, OCR/model assertion or authority input and
 * cannot grant controller, load/save, protected-menu or memory permission. */
export class ReviewedFrameDecoder{
 readonly manifestDigest:string;
 readonly revision:string;
 private readonly entries:ReadonlyArray<ReviewedFrameManifest['entries'][number]>;
 constructor(manifest:ReviewedFrameManifest){
  if(!manifest||!/^\d+\.\d+\.\d+$/.test(manifest.revision)||!Array.isArray(manifest.entries)||manifest.entries.length<1||manifest.entries.length>128)throw Error('reviewed_frame_manifest_unavailable');
  const seen=new Set<string>();
  for(const entry of manifest.entries){
   if(!/^[a-f0-9]{64}$/.test(entry.sha256)||seen.has(entry.sha256)||!Number.isSafeInteger(entry.width)||!Number.isSafeInteger(entry.height)||entry.width<1||entry.width>1024||entry.height<1||entry.height>1024||!Array.isArray(entry.fields)||entry.fields.length<1||entry.fields.length>32)throw Error('reviewed_frame_manifest_unavailable');
   seen.add(entry.sha256);const fields=new Set<string>();
   for(const field of entry.fields){if(typeof field.fieldId!=='string'||field.fieldId.length<1||field.fieldId.length>500||fields.has(field.fieldId)||!['string','boolean','number'].includes(typeof field.value)||typeof field.value==='number'&&!Number.isFinite(field.value)||typeof field.value==='string'&&field.value.length>500)throw Error('reviewed_frame_manifest_unavailable');fields.add(field.fieldId);}
  }
  // Snapshot manifest bytes so a caller cannot revise meaning after review.
  const snapshot=JSON.stringify(manifest);this.manifestDigest=createHash('sha256').update(snapshot).digest('hex');this.revision=manifest.revision;this.entries=JSON.parse(snapshot).entries;for(const entry of this.entries){for(const field of entry.fields)Object.freeze(field);Object.freeze(entry.fields);Object.freeze(entry);}Object.freeze(this.entries);Object.freeze(this);
 }
 decode({scope,observation,bytes,now}:{scope:ActivityScope;observation:GameObservation;bytes:Uint8Array;now:number}):PlayerVisibleStateValue[]{
  if(!Number.isFinite(now)||!isDeepStrictEqual(scope,observation.scope)||observation.untrusted!==true||observation.screenshots.length!==1||bytes.byteLength<57||bytes.byteLength>2097152)return [];
  const shot=observation.screenshots[0];if(!shot)return [];const hash=createHash('sha256').update(bytes).digest('hex');
  const b=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||b.subarray(12,16).toString('ascii')!=='IHDR'||b.readUInt32BE(8)!==13||shot.sha256!==hash||shot.byteLength!==bytes.byteLength||shot.mediaType!=='image/png'||shot.frameNumber!==observation.frameNumber||shot.capturedAt!==observation.capturedAt||Date.parse(shot.capturedAt)>now||Date.parse(shot.expiresAt)<=now||!Number.isFinite(Date.parse(shot.expiresAt))||!Number.isFinite(Date.parse(shot.capturedAt)))return [];
  try{inspectGamePng(b,1024);}catch{return [];}
  if(Date.parse(shot.expiresAt)-Date.parse(shot.capturedAt)>30000)return [];
  const entry=this.entries.find(e=>e.sha256===hash&&e.width===shot.width&&e.height===shot.height&&e.width===b.readUInt32BE(16)&&e.height===b.readUInt32BE(20));if(!entry)return [];
  return entry.fields.map(field=>({...field,visibility:'visibleNow',firstObservedRef:observation.observationId,lastObservedRef:observation.observationId,timelineId:scope.timelineId,observedAt:shot.capturedAt,freshUntil:shot.expiresAt,decoderRevision:this.revision,manifestDigest:this.manifestDigest,limitations:['Exact reviewed player-visible screenshot only; unknown or changed frames have no decoded fields.','Image classification supplies no controller, protected-menu, save/load or memory authority.']}));
 }
}
