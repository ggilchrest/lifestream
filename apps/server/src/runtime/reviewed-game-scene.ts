import {ReviewedFrameDecoder,gameFramePixels,type ReviewedFrameManifest} from '@lifestream/providers-bizhawk';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type {GameObservation} from '@lifestream/contracts/game-activity';

export type ReviewedGameScene={schemaVersion:'reviewed-game-scene/1';qualificationRef:string;annotationOrigin?:'AGENT'|'HUMAN';manifest:ReviewedFrameManifest};
/** Installed nativeVisibleUi evidence, not a model classification or a grant.
 * Each changing frame must match its own independently reviewed source image. */
export function captureReviewedGameScene(raw:unknown){
 const value=boundedGameDataSnapshot(raw,24576) as ReviewedGameScene|null;
 if(!value||!['manifest,qualificationRef,schemaVersion','annotationOrigin,manifest,qualificationRef,schemaVersion'].includes(Object.keys(value).sort().join(','))||value.schemaVersion!=='reviewed-game-scene/1'||typeof value.qualificationRef!=='string'||!value.qualificationRef.trim()||value.qualificationRef.length>500||!Array.isArray(value.manifest?.entries)||value.manifest.entries.length<2||value.manifest.entries.length>16)throw Error('Reviewed changing game scene unavailable');
 if(Object.hasOwn(value,'annotationOrigin')&&!['AGENT','HUMAN'].includes(value.annotationOrigin!))throw Error('Reviewed scene annotation origin unavailable');
 const annotationOrigin=value.annotationOrigin??'UNSPECIFIED';
 if(!['entries,revision','digestMode,entries,revision'].includes(Object.keys(value.manifest).sort().join(',')))throw Error('Closed reviewed scene manifest required');
 const allowed=new Set(['ct.ui.controller-domain','ct.ui.scene','ct.ui.dialogue.text','ct.ui.player.x','ct.ui.player.y']);
 for(const entry of value.manifest.entries){
  if(Object.keys(entry).sort().join(',')!=='fields,height,sha256,width')throw Error('Closed reviewed scene image required');
  if(!Array.isArray(entry.fields)||entry.fields.some((f:{fieldId:string;value:string|number|boolean})=>Object.keys(f).sort().join(',')!=='fieldId,value'||!allowed.has(f.fieldId)))throw Error('Unsupported scene field');
  const fields=new Map(entry.fields.map((f:{fieldId:string;value:string|number|boolean})=>[f.fieldId,f.value]));
  if(fields.get('ct.ui.controller-domain')!=='ordinaryGameplay'||typeof fields.get('ct.ui.scene')!=='string'||!String(fields.get('ct.ui.scene')).trim())throw Error('Positive ordinary scene evidence required');
  const text=fields.get('ct.ui.dialogue.text'),x=fields.get('ct.ui.player.x'),y=fields.get('ct.ui.player.y');
  if(text!==undefined&&typeof text!=='string'||x!==undefined&&(!Number.isSafeInteger(x)||Number(x)<0||Number(x)>=entry.width)||y!==undefined&&(!Number.isSafeInteger(y)||Number(y)<0||Number(y)>=entry.height)||((x===undefined)!==(y===undefined))||text===undefined&&x===undefined)throw Error('Visible scene semantics required');
 }
 const reviewed=new ReviewedFrameDecoder(value.manifest);
 const decoder=Object.freeze({manifestDigest:reviewed.manifestDigest,revision:reviewed.revision,decode:(input:Parameters<ReviewedFrameDecoder['decode']>[0])=>{
  const fields=reviewed.decode(input);if(!fields.length)return fields;
  try{const bytes=Buffer.isBuffer(input.bytes)?input.bytes:Buffer.from(input.bytes);const image=gameFramePixels(bytes);try{return image.rgb.every(v=>v===0)?[]:fields;}finally{image.rgb.fill(0);}}catch{return [];}
 }});
 const current=(observation:Readonly<GameObservation>)=>observation.visibleState.some(f=>f.fieldId==='ct.ui.controller-domain'&&f.value==='ordinaryGameplay'&&f.visibility==='visibleNow'&&f.timelineId===observation.scope.timelineId&&f.lastObservedRef===observation.observationId&&f.manifestDigest===decoder.manifestDigest&&Date.parse(f.freshUntil)>Date.now());
 const descriptor=freeze({qualificationRef:value.qualificationRef,annotationOrigin,manifestDigest:decoder.manifestDigest,...(value.manifest.digestMode===undefined?{}:{digestMode:reviewed.digestMode}),states:value.manifest.entries.map(e=>({sha256:e.sha256,width:e.width,height:e.height,fields:e.fields.map((f:{fieldId:string;value:string|number|boolean})=>({...f}))}))});
 return Object.freeze({decoder,current,descriptor});
}

function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
